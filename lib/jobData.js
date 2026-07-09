// lib/jobData.js
//
// Pure, dependency-free helpers shared by the background service worker and
// the test suite. Loaded into the service worker via importScripts()
// (classic script -> functions land on the global scope) and required
// directly by Jest (CommonJS export) -- no build step needed either way.

/**
 * Extracts the numeric job id from a voyager jobPostings API URL, e.g.
 * "https://www.linkedin.com/voyager/api/jobs/jobPostings/1234567?decorationId=..."
 * -> "1234567".
 */
function extractJobIdFromApiUrl(urlString) {
  if (!urlString) return null;
  const match = /\/jobPostings\/(\d+)/.exec(urlString);
  return match ? match[1] : null;
}

/**
 * Extracts the numeric job id from a linkedin.com/jobs page URL. Handles both
 * the "currentJobId=" query param form (used by the jobs search/collections
 * view) and the "/jobs/view/<id>" path form. Anchoring on \d+ (rather than
 * splitting on "/") avoids picking up a trailing query string as part of the id.
 */
function extractJobIdFromPageUrl(urlString) {
  if (!urlString) return null;
  try {
    const url = new URL(urlString);
    const fromQuery = url.searchParams.get('currentJobId');
    if (fromQuery && /^\d+$/.test(fromQuery)) {
      return fromQuery;
    }
  } catch (e) {
    // Not a fully-qualified URL; fall through to the regex below.
  }
  const match = /\/jobs\/view\/(\d+)/.exec(urlString);
  return match ? match[1] : null;
}

/**
 * Formats a listedAt epoch-ms timestamp as a human-readable relative age.
 * `now` is injectable so tests are deterministic.
 */
function formatJobAge(listedAtMs, now = Date.now()) {
  if (!listedAtMs || Number.isNaN(new Date(listedAtMs).getTime())) {
    return 'N/A';
  }
  const diffMs = now - listedAtMs;
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

  if (diffHours < 1) {
    return 'Just now';
  }
  if (diffHours < 24) {
    return diffHours === 1 ? '1 hour ago' : `${diffHours} hours ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`;
}

function firstNumeric(obj, keys) {
  if (!obj) return undefined;
  for (const key of keys) {
    if (typeof obj[key] === 'number') {
      return obj[key];
    }
  }
  return undefined;
}

/**
 * LinkedIn's voyager "included" response shape normalizes entities into a
 * flat array rather than nesting them under the primary object. Scan it for
 * the first entity that looks like a job posting stats object.
 */
function searchIncludedForCounts(included) {
  if (!Array.isArray(included)) return {};
  for (const entity of included) {
    const applies = firstNumeric(entity, ['applies', 'numApplies', 'numApplicants']);
    const views = firstNumeric(entity, ['views', 'numViews']);
    const listedAt = firstNumeric(entity, ['listedAt', 'originalListedAt']);
    if (applies !== undefined || views !== undefined) {
      return { applies, views, listedAt };
    }
  }
  return {};
}

/**
 * Extracts { applicantCount, viewCount, jobAge, hasData } from a voyager
 * jobPostings response. LinkedIn has shipped at least three response shapes
 * for this endpoint over time:
 *   1. flat entity: { applies, views, listedAt, ... }
 *   2. REST.li wrapped: { data: { applies, views, listedAt, ... } }
 *   3. normalized dash response: { data: {...}, included: [ {...}, ... ] }
 * Every known shape is tried before giving up, so a shape change on
 * LinkedIn's side degrades gracefully instead of failing outright.
 */
function parseJobPostingResponse(json, now = Date.now()) {
  const flat = json || {};
  const dataWrapped = json?.data || {};
  const legacyWrapped = json?.jobPosting || {};
  const included = searchIncludedForCounts(json?.included);

  const applicantCount =
    firstNumeric(flat, ['applies']) ??
    firstNumeric(dataWrapped, ['applies']) ??
    firstNumeric(legacyWrapped, ['numApplicants']) ??
    included.applies ??
    'N/A';

  const viewCount =
    firstNumeric(flat, ['views']) ??
    firstNumeric(dataWrapped, ['views']) ??
    firstNumeric(legacyWrapped, ['numViews']) ??
    included.views ??
    'N/A';

  const listedAt =
    firstNumeric(flat, ['listedAt', 'originalListedAt']) ??
    firstNumeric(dataWrapped, ['listedAt', 'originalListedAt']) ??
    included.listedAt ??
    null;

  return {
    applicantCount,
    viewCount,
    jobAge: formatJobAge(listedAt, now),
    hasData: applicantCount !== 'N/A' || viewCount !== 'N/A',
  };
}

const JobDataLib = {
  extractJobIdFromApiUrl,
  extractJobIdFromPageUrl,
  formatJobAge,
  parseJobPostingResponse,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = JobDataLib;
}
if (typeof self !== 'undefined') {
  self.JobDataLib = JobDataLib;
}
