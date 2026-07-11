// lib/jobData.js
//
// Pure, dependency-free helpers shared by the background service worker and
// the test suite. Loaded into the service worker via importScripts(), which
// runs the script in the SAME global scope as background.js -- so everything
// is wrapped in an IIFE and only `self.JobDataLib` is exposed, to avoid
// colliding with names background.js declares for itself. Also exported via
// CommonJS so Jest can require() it directly -- no build step needed either way.

(function () {
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
   * Extracts the numeric job id embedded in a LinkedIn entity URN, e.g.
   * "...variables=(jobPostingUrn:urn%3Ali%3Afsd_jobPosting%3A1234567)..." or
   * the unencoded "urn:li:fsd_jobPosting:1234567". LinkedIn's newer GraphQL
   * endpoints (voyager/api/graphql?queryId=...) reference the job posting
   * this way instead of putting the id directly in the path.
   */
  function extractJobIdFromJobPostingUrn(urlString) {
    if (!urlString) return null;
    const match = /fsd_jobPosting(?:%3A|:)(\d+)/i.exec(urlString);
    return match ? match[1] : null;
  }

  /**
   * True for a voyager GraphQL call that appears to be requesting job
   * posting data (LinkedIn uses one shared /voyager/api/graphql endpoint for
   * almost everything, so this must be checked before treating a GraphQL
   * request as job-related).
   */
  function isJobPostingGraphqlUrl(urlString) {
    if (!urlString) return false;
    return /\/voyager\/api\/graphql/i.test(urlString) && /jobposting/i.test(urlString);
  }

  /**
   * Given a previously-observed request URL that was fetching data for
   * `oldJobId`, produces the equivalent URL for `newJobId` by substituting
   * the id (matched on a digit boundary, so it can't clip a larger number
   * that merely contains oldJobId as a substring). Returns null if oldJobId
   * doesn't actually appear in the template as a standalone number.
   */
  function buildProactiveUrlFromTemplate(templateUrl, oldJobId, newJobId) {
    if (!templateUrl || !oldJobId || !newJobId) return null;
    const pattern = new RegExp(`(^|\\D)${oldJobId}(?!\\d)`, 'g');
    if (!pattern.test(templateUrl)) return null;
    pattern.lastIndex = 0;
    return templateUrl.replace(pattern, (_match, prefix) => `${prefix}${newJobId}`);
  }

  /**
   * Extracts the numeric job id embedded in a linkedin.com/jobs page URL. Handles both
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

  function readCounts(entity) {
    const applies = firstNumeric(entity, ['applies', 'numApplies', 'numApplicants']);
    const views = firstNumeric(entity, ['views', 'numViews']);
    const listedAt = firstNumeric(entity, ['listedAt', 'originalListedAt']);
    return { applies, views, listedAt };
  }

  /**
   * LinkedIn's voyager "included" response shape (used by both REST.li dash
   * decorations and GraphQL responses) normalizes entities into a flat array
   * rather than nesting them under the primary object, and bundles many
   * unrelated entity types together (company, poster profile, etc. can all
   * ride along in the same response). Entities whose $type mentions
   * "jobPosting" are checked first to avoid matching an unrelated entity that
   * happens to also have a `views` field; only if none are tagged does this
   * fall back to a generic scan.
   */
  function searchIncludedForCounts(included) {
    if (!Array.isArray(included)) return {};

    for (const entity of included) {
      if (typeof entity?.$type === 'string' && /jobposting/i.test(entity.$type)) {
        const counts = readCounts(entity);
        if (counts.applies !== undefined || counts.views !== undefined) {
          return counts;
        }
      }
    }

    for (const entity of included) {
      const counts = readCounts(entity);
      if (counts.applies !== undefined || counts.views !== undefined) {
        return counts;
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
    extractJobIdFromJobPostingUrn,
    extractJobIdFromPageUrl,
    isJobPostingGraphqlUrl,
    buildProactiveUrlFromTemplate,
    formatJobAge,
    parseJobPostingResponse,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = JobDataLib;
  }
  if (typeof self !== 'undefined') {
    self.JobDataLib = JobDataLib;
  }
})();
