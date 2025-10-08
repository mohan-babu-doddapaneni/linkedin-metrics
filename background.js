// background.js

// A temporary in-memory store for request headers, keyed by requestId.
const requestHeadersStore = {};
// A cache for the last known good set of headers for proactive fetching.
let lastKnownHeaders = {};

const LINKEDIN_JOBS_BASE_URL = "linkedin.com/jobs/";
const LINKEDIN_JOB_VIEW_URL = "linkedin.com/jobs/view/";

/**
 * Injects the content script and CSS into the specified tab.
 * This function is designed to be idempotent and handles errors gracefully.
 * @param {number} tabId The ID of the tab to inject scripts into.
 */
function injectScripts(tabId) {
  console.log(`Attempting to inject scripts into tab ${tabId}`);
  chrome.scripting.insertCSS({
    target: { tabId: tabId },
    files: ["styles.css"],
  }).catch(err => console.error("Failed to inject CSS:", err));

  chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: ["content.js"],
  }).catch(err => console.error("Failed to inject JS:", err));
}

// 1. Inject script on initial page load to a jobs URL.
// This runs only once per full page load and ensures the content script is ready.
chrome.webNavigation.onCommitted.addListener((details) => {
  // We only care about the main frame, not iframes.
  if (details.frameId === 0 && details.url.includes(LINKEDIN_JOBS_BASE_URL)) {
    console.log(`[DEBUG] onCommitted: Initial load to jobs page. Injecting scripts.`);
    injectScripts(details.tabId);
  }
}, { url: [{ hostContains: 'linkedin.com' }] });

// 2. Handle SPA (Single-Page Application) navigations.
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  // We only care about URL changes on the main page.
  if (details.frameId === 0 && details.url.includes(LINKEDIN_JOBS_BASE_URL)) {
    const isJobViewPage = details.url.includes(LINKEDIN_JOB_VIEW_URL) || details.url.includes("currentJobId=");

    if (isJobViewPage) {
      console.log(`[DEBUG] History Update: Job view page detected.`);

      // Immediately reset the widget to "Loading..." for a responsive feel.
      chrome.tabs.sendMessage(details.tabId, { type: "RESET_WIDGET" }).catch(e => {});

      // Extract job ID from URL to check our cache.
      const url = new URL(details.url);
      const jobId = url.searchParams.get("currentJobId") || details.url.split('/view/')[1]?.split('/')[0];

      if (jobId) {
        // Check if we have data for this job in our session cache.
        const cachedData = await chrome.storage.session.get(jobId);
        if (cachedData && cachedData[jobId]) {
          console.log(`[DEBUG] Found cached data for job ${jobId}. Sending to content script.`);
          // If we have cached data, send it immediately to prevent getting stuck on "Loading..."
          await chrome.tabs.sendMessage(details.tabId, {
            type: "UPDATE_METRICS",
            data: cachedData[jobId]
          });
        } else {
          // If data is not in cache, proactively trigger a fetch.
          // This solves the "stuck on loading" issue when LinkedIn uses its own cache.
          console.log(`[DEBUG] No cache for job ${jobId}. Proactively fetching.`);
          // We need to construct the API URL to fetch the data.
          const apiUrl = `https://www.linkedin.com/voyager/api/jobs/jobPostings/${jobId}?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65`;
          fetchAndRelayJobData({ url: apiUrl, tabId: details.tabId, requestId: `manual-${jobId}-${Date.now()}` });
        }
      }
    }
  }
});

// Listen for the request headers of the API call to capture the csrf-token.
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {    
    console.log(`[DEBUG] onBeforeSendHeaders fired for URL: ${details.url}`);
    // If the request is from our own extension, ignore it to prevent loops.
    if (details.requestHeaders.some(h => h.name.toLowerCase() === 'x-exact-metrics-request')) {
      console.log("[DEBUG] Ignoring request from our own extension.");
      return {};
    }

    const { tabId, requestHeaders } = details;
    if (tabId > 0) {
      // Whitelist of headers to capture from the original request.
      const headersToCapture = [
        'csrf-token',
        'x-li-lang',
        'x-li-page-instance',
        'x-li-track',
        'x-restli-protocol-version'
      ];

      const capturedHeaders = {};
      for (const header of requestHeaders) {
        const lowerCaseHeaderName = header.name.toLowerCase();
        if (headersToCapture.includes(lowerCaseHeaderName)) {
          capturedHeaders[header.name] = header.value;
        }
      }
      console.log(`[DEBUG] Captured headers for tab ${tabId}:`, capturedHeaders);
      // Store the captured headers using the unique requestId.
      requestHeadersStore[details.requestId] = capturedHeaders;
      // Also update our last known good headers cache for proactive fetches.
      lastKnownHeaders = capturedHeaders;
    }
  },
  { urls: ["*://*.linkedin.com/voyager/api/jobs/jobPostings/*"] },
  ["requestHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    console.log(`[DEBUG] onCompleted fired for URL: ${details.url}`);
    // Check the initiator to ensure we're not catching our own fetch requests.
    if (details.initiator && details.initiator.startsWith('chrome-extension://')) {
      return;
    }

    fetchAndRelayJobData(details);
  },
  // Filter for the specific API endpoint.
  { urls: ["*://*.linkedin.com/voyager/api/jobs/jobPostings/*"] },
);

/**
 * Fetches job data from the given URL and sends it to the content script.
 * @param {object} details The details object from the webRequest listener.
 */
async function fetchAndRelayJobData(details) {
  // First, ensure the content script is injected and ready.
  // This is the most robust way to prevent "Receiving end does not exist" errors.
  // The content script itself ensures it only runs its setup logic once.
  await injectScripts(details.tabId);

  const { url, tabId, requestId } = details;
  console.log(`[DEBUG] fetchAndRelayJobData called for tab ${tabId}`);

  // Retrieve the stored headers using the unique requestId.
  let headers = requestHeadersStore[requestId];

  // For proactive fetches (manual-...), the requestId won't be in the store.
  // In that case, we fall back to the last known good headers we captured.
  if (!headers && requestId.startsWith('manual-')) {
    console.log("[DEBUG] Using last known headers for proactive fetch.");
    headers = lastKnownHeaders;
  }

  if (!headers || Object.keys(headers).length === 0) {
    console.error(`[DEBUG] CRITICAL: Could not find any headers for requestId ${requestId}. The request will fail.`);
    return; // We cannot proceed without headers.
  }
  console.log("[DEBUG] Retrieved headers for fetch:", headers);

  try {
    // Add a custom header to our fetch request to prevent an infinite loop.
    const fetchHeaders = { ...headers, 'X-Exact-Metrics-Request': 'true' };

    console.log("[DEBUG] Making fetch request to:", url);
    const response = await fetch(url, { headers: fetchHeaders, credentials: 'include' });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    console.log("[DEBUG] Fetch successful. Response data:", data);

    // The API can return data in multiple formats. We'll check for all known structures.
    // The user found `data.applies` and `data.views`. We'll prioritize that.
    const applicantCount = data?.applies ?? data?.data?.applies ?? data?.jobPosting?.numApplicants ?? 'N/A';
    const viewCount = data?.views ?? data?.data?.views ?? data?.jobPosting?.numViews ?? 'N/A';
    const listedAt = data?.listedAt ?? data?.originalListedAt ?? null;

    let jobAge = 'N/A';
    if (listedAt) {
      const postDate = new Date(listedAt);
      const diffTime = new Date() - postDate; // Difference in milliseconds
      const diffHours = Math.floor(diffTime / (1000 * 60 * 60));

      if (diffHours < 1) {
        jobAge = "Just now";
      } else if (diffHours < 24) {
        jobAge = diffHours === 1 ? `${diffHours} hour ago` : `${diffHours} hours ago`;
      } else {
        const diffDays = Math.floor(diffHours / 24);
        jobAge = diffDays === 1 ? `${diffDays} day ago` : `${diffDays} days ago`;
      }
    }

    console.log(`[DEBUG] Extracted Metrics: Applicants - ${applicantCount}, Views - ${viewCount}, Age - ${jobAge}`);

    // Only send a message if we have valid data to show.
    if (applicantCount !== 'N/A' || viewCount !== 'N/A') {
      const dataToSend = { viewCount, applicantCount, jobAge };

      // Store the newly fetched data in session storage using the job ID as the key.
      const url = new URL(details.url);
      const jobId = url.pathname.split('/')[4];
      if (jobId) {
        console.log(`[DEBUG] Caching data for job ${jobId}.`);
        await chrome.storage.session.set({ [jobId]: dataToSend });
      }

      // Send the processed data to the content script in the target tab.
      console.log("[DEBUG] Sending metrics to content script.");
      await chrome.tabs.sendMessage(tabId, { type: "UPDATE_METRICS", data: dataToSend });
    }
  } catch (error) {
    console.error("Background script fetch error:", error);
    // Send an error message to the content script. The injectScripts call at the
    // top of this function ensures the content script is ready to receive this.
    chrome.tabs.sendMessage(tabId, {
      type: "UPDATE_METRICS",
      data: { viewCount: 'Error', applicantCount: `Fetch failed`, jobAge: 'N/A' }
    }).catch(e => console.error("Failed to send error message to content script:", e));
  } finally {
    // Clean up the stored headers for this request after it's done.
    delete requestHeadersStore[requestId];
  }
}
