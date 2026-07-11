// background.js

importScripts('lib/jobData.js');
const {
  extractJobIdFromApiUrl,
  extractJobIdFromJobPostingUrn,
  extractJobIdFromPageUrl,
  isJobPostingGraphqlUrl,
  buildProactiveUrlFromTemplate,
  parseJobPostingResponse,
} = self.JobDataLib;

/**
 * Job id for a request we recognize as job-posting data, whichever URL shape
 * it turns out to be (classic REST path or a GraphQL call referencing a
 * jobPostingUrn). Returns null for anything else (including LinkedIn's many
 * unrelated GraphQL calls on the same shared endpoint).
 */
function extractJobIdFromRelevantRequestUrl(urlString) {
  return extractJobIdFromApiUrl(urlString) || extractJobIdFromJobPostingUrn(urlString);
}

function isRelevantJobRequestUrl(urlString) {
  return extractJobIdFromApiUrl(urlString) !== null || isJobPostingGraphqlUrl(urlString);
}

// --- Settings (read from storage so the popup can change them at runtime) ---

let debugMode = false;
let widgetEnabled = true;

chrome.storage.local.get(['debugMode'], (result) => {
  debugMode = Boolean(result.debugMode);
});
chrome.storage.sync.get(['widgetEnabled'], (result) => {
  widgetEnabled = result.widgetEnabled !== false; // default true
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.debugMode) {
    debugMode = Boolean(changes.debugMode.newValue);
  }
  if (areaName === 'sync' && changes.widgetEnabled) {
    widgetEnabled = changes.widgetEnabled.newValue !== false;
  }
});

function log(...args) {
  if (debugMode) console.log(...args);
}

// --- In-memory, per-request header capture (short-lived; a single request's
// onBeforeSendHeaders and onCompleted always fire within the same event, so
// this doesn't need to survive a service worker restart). ---
const requestHeadersStore = {};

// Cap so a long browsing session can't grow this unboundedly if a request
// never completes (tab closed mid-flight, etc).
const MAX_PENDING_REQUESTS = 50;
function capPendingRequests() {
  const keys = Object.keys(requestHeadersStore);
  if (keys.length > MAX_PENDING_REQUESTS) {
    delete requestHeadersStore[keys[0]];
  }
}

// Jobs currently being fetched, so the passive (webRequest-triggered) path and
// the proactive (cache-miss-triggered) path can't both fire a fetch for the
// same job at the same time.
const pendingJobFetches = new Set();

const LINKEDIN_JOBS_BASE_URL = 'linkedin.com/jobs/';

// --- Persistent "last known good headers" cache -----------------------------
// MV3 service workers are torn down after ~30s of inactivity. A plain module
// variable resets to {} on every restart, which used to make proactive
// fetches fail intermittently right after the browser reclaimed the worker --
// exactly when a user re-opens a job tab after a break. chrome.storage.session
// survives worker restarts (it's only cleared when the browser session ends),
// so it's used here instead.
const HEADERS_STORAGE_KEY = 'lastKnownHeaders';

async function getLastKnownHeaders() {
  const result = await chrome.storage.session.get(HEADERS_STORAGE_KEY);
  return result[HEADERS_STORAGE_KEY] || {};
}

async function setLastKnownHeaders(headers) {
  await chrome.storage.session.set({ [HEADERS_STORAGE_KEY]: headers });
}

// --- Learned request template -----------------------------------------------
// LinkedIn's job-detail endpoint has moved around (classic REST vs. GraphQL)
// and the exact shape isn't publicly documented or stable, so rather than
// hardcode one guess, we remember the most recent real request LinkedIn's own
// page made for a job posting and reuse its exact shape (with the job id
// swapped in) for proactive fetches. This self-adapts to whichever endpoint
// shape is actually in use for a given account/rollout instead of going stale
// the next time LinkedIn changes it.
const REQUEST_TEMPLATE_KEY = 'lastObservedJobRequest';

async function rememberRequestTemplate(url, jobId) {
  if (!jobId) return;
  await chrome.storage.session.set({ [REQUEST_TEMPLATE_KEY]: { url, jobId } });
}

async function buildProactiveUrl(newJobId) {
  const result = await chrome.storage.session.get(REQUEST_TEMPLATE_KEY);
  const template = result[REQUEST_TEMPLATE_KEY];
  const fromTemplate = template && buildProactiveUrlFromTemplate(template.url, template.jobId, newJobId);
  if (fromTemplate) {
    return fromTemplate;
  }
  // No request observed yet this session (e.g. the very first job viewed) --
  // fall back to the historically-known classic REST shape as a best effort.
  return `https://www.linkedin.com/voyager/api/jobs/jobPostings/${newJobId}?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65`;
}

// --- Job data cache, capped so a long session doesn't grow storage forever --
const CACHE_ORDER_KEY = '__jobCacheOrder';
const MAX_CACHED_JOBS = 200;

async function cacheJobData(jobId, data) {
  await chrome.storage.session.set({ [jobId]: data });

  const orderResult = await chrome.storage.session.get(CACHE_ORDER_KEY);
  const order = (orderResult[CACHE_ORDER_KEY] || []).filter((id) => id !== jobId);
  order.push(jobId);

  const toEvict = order.length > MAX_CACHED_JOBS ? order.splice(0, order.length - MAX_CACHED_JOBS) : [];
  if (toEvict.length > 0) {
    await chrome.storage.session.remove(toEvict);
  }
  await chrome.storage.session.set({ [CACHE_ORDER_KEY]: order });
}

async function getCachedJobData(jobId) {
  const result = await chrome.storage.session.get(jobId);
  return result[jobId] || null;
}

/**
 * Injects the content script and CSS into the specified tab.
 * Idempotent (content.js guards against double-init) and safe to call
 * repeatedly. Returns a Promise so callers can actually await completion --
 * the previous version returned undefined, so its `await` calls were no-ops
 * and callers proceeded before injection had actually finished.
 */
async function injectScripts(tabId) {
  log(`Attempting to inject scripts into tab ${tabId}`);
  await Promise.all([
    chrome.scripting.insertCSS({ target: { tabId }, files: ['styles.css'] }).catch((err) => {
      console.error('Failed to inject CSS:', err);
    }),
    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch((err) => {
      console.error('Failed to inject JS:', err);
    }),
  ]);
}

function sendMessageSafe(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message).catch(() => {
    // Tab navigated away or closed before the message could be delivered.
  });
}

// 1. Inject script on initial page load to a jobs URL. This also acts as a
// safety net alongside the declarative content_scripts entry in manifest.json
// for the (rare) case where the service worker was still waking up when
// onCommitted fired for the very first navigation.
chrome.webNavigation.onCommitted.addListener(
  (details) => {
    if (!widgetEnabled) return;
    if (details.frameId === 0 && details.url.includes(LINKEDIN_JOBS_BASE_URL)) {
      log('[DEBUG] onCommitted: Initial load to jobs page. Injecting scripts.');
      injectScripts(details.tabId);
    }
  },
  { url: [{ hostContains: 'linkedin.com' }] }
);

// 2. Handle SPA (Single-Page Application) navigations.
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (!widgetEnabled) return;
  if (details.frameId !== 0 || !details.url.includes(LINKEDIN_JOBS_BASE_URL)) return;

  const jobId = extractJobIdFromPageUrl(details.url);
  const isJobViewPage = details.url.includes('linkedin.com/jobs/view/') || details.url.includes('currentJobId=');
  if (!isJobViewPage || !jobId) return;

  log('[DEBUG] History Update: Job view page detected.', jobId);

  // Immediately reset the widget to "Loading..." for a responsive feel.
  sendMessageSafe(details.tabId, { type: 'RESET_WIDGET' });

  const cachedData = await getCachedJobData(jobId);
  if (cachedData) {
    log(`[DEBUG] Found cached data for job ${jobId}. Sending to content script.`);
    await sendMessageSafe(details.tabId, { type: 'UPDATE_METRICS', data: cachedData });
    return;
  }

  if (pendingJobFetches.has(jobId)) {
    log(`[DEBUG] Job ${jobId} is already being fetched (passively). Skipping duplicate proactive fetch.`);
    return;
  }

  log(`[DEBUG] No cache for job ${jobId}. Proactively fetching.`);
  const apiUrl = await buildProactiveUrl(jobId);
  fetchAndRelayJobData({ url: apiUrl, tabId: details.tabId, requestId: `manual-${jobId}-${Date.now()}` }, jobId);
});

// Watched broadly (classic REST path + LinkedIn's shared GraphQL endpoint)
// since the exact endpoint LinkedIn uses for job posting detail data isn't
// stable or documented; isRelevantJobRequestUrl() filters out the many
// unrelated GraphQL calls LinkedIn's SPA makes on the same shared endpoint.
const WATCHED_URL_PATTERNS = ['*://*.linkedin.com/voyager/api/jobs/jobPostings/*', '*://*.linkedin.com/voyager/api/graphql*'];

// Listen for the request headers of the API call to capture the csrf-token.
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // If the request is from our own extension, ignore it to prevent loops.
    if (details.requestHeaders.some((h) => h.name.toLowerCase() === 'x-exact-metrics-request')) {
      return {};
    }
    if (!isRelevantJobRequestUrl(details.url)) {
      return;
    }

    const { tabId, requestHeaders } = details;
    if (tabId > 0) {
      const headersToCapture = ['csrf-token', 'x-li-lang', 'x-li-page-instance', 'x-li-track', 'x-restli-protocol-version'];

      const capturedHeaders = {};
      for (const header of requestHeaders) {
        if (headersToCapture.includes(header.name.toLowerCase())) {
          capturedHeaders[header.name] = header.value;
        }
      }
      requestHeadersStore[details.requestId] = capturedHeaders;
      capPendingRequests();
      setLastKnownHeaders(capturedHeaders);

      const observedJobId = extractJobIdFromRelevantRequestUrl(details.url);
      if (observedJobId) {
        rememberRequestTemplate(details.url, observedJobId);
      }
    }
  },
  { urls: WATCHED_URL_PATTERNS },
  ['requestHeaders']
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    // Check the initiator to ensure we're not catching our own fetch requests.
    if (details.initiator && details.initiator.startsWith('chrome-extension://')) {
      return;
    }
    if (!widgetEnabled) return;
    if (!isRelevantJobRequestUrl(details.url)) return;

    const jobId = extractJobIdFromRelevantRequestUrl(details.url);
    fetchAndRelayJobData(details, jobId);
  },
  { urls: WATCHED_URL_PATTERNS }
);

/**
 * Fetches job data from the given URL (retrying once on a transient failure)
 * and sends it to the content script.
 * @param {object} details The details object from the webRequest listener (or
 *   a synthetic equivalent for a proactive fetch).
 * @param {string|null} jobId The job id, when already known, used to dedupe
 *   in-flight fetches and to key the cache.
 */
async function fetchAndRelayJobData(details, jobId) {
  if (jobId) {
    if (pendingJobFetches.has(jobId)) {
      log(`[DEBUG] Fetch for job ${jobId} already in flight, skipping duplicate.`);
      return;
    }
    pendingJobFetches.add(jobId);
  }

  try {
    // Ensure the content script is injected and ready before we try to
    // message it -- this now actually awaits completion (see injectScripts).
    await injectScripts(details.tabId);

    const { url, tabId, requestId } = details;

    let headers = requestHeadersStore[requestId];
    // For proactive fetches (manual-...), the requestId won't be in the
    // per-request store. Fall back to the last known good headers.
    if (!headers && requestId.startsWith('manual-')) {
      headers = await getLastKnownHeaders();
    }

    if (!headers || Object.keys(headers).length === 0) {
      console.error(`[LinkedIn Exact Metrics] No captured auth headers for request ${requestId}; cannot fetch.`);
      return;
    }

    const fetchHeaders = { ...headers, 'X-Exact-Metrics-Request': 'true' };
    const data = await fetchWithRetry(url, fetchHeaders);
    if (!data) return;

    const parsed = parseJobPostingResponse(data);
    log('[DEBUG] Extracted Metrics:', parsed);

    if (parsed.hasData) {
      const dataToSend = { viewCount: parsed.viewCount, applicantCount: parsed.applicantCount, jobAge: parsed.jobAge };
      const resolvedJobId = jobId || extractJobIdFromRelevantRequestUrl(url);
      if (resolvedJobId) {
        await cacheJobData(resolvedJobId, dataToSend);
      }
      await sendMessageSafe(tabId, { type: 'UPDATE_METRICS', data: dataToSend });
    }
  } catch (error) {
    console.error('[LinkedIn Exact Metrics] fetch error:', error);
    sendMessageSafe(details.tabId, {
      type: 'UPDATE_METRICS',
      data: { viewCount: 'Error', applicantCount: 'Fetch failed', jobAge: 'N/A' },
    });
  } finally {
    delete requestHeadersStore[details.requestId];
    if (jobId) pendingJobFetches.delete(jobId);
  }
}

/**
 * Fetches a URL, retrying once after a short delay on a transient
 * (429/5xx/network) failure. Returns the parsed JSON body, or throws if the
 * request ultimately failed.
 */
async function fetchWithRetry(url, headers, attempt = 1) {
  try {
    const response = await fetch(url, { headers, credentials: 'include' });
    if (!response.ok) {
      const isTransient = response.status === 429 || response.status >= 500;
      if (isTransient && attempt === 1) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return fetchWithRetry(url, headers, attempt + 1);
      }
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (attempt === 1) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return fetchWithRetry(url, headers, attempt + 1);
    }
    throw error;
  }
}
