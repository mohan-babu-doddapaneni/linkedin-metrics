const {
  extractJobIdFromApiUrl,
  extractJobIdFromPageUrl,
  formatJobAge,
  parseJobPostingResponse,
} = require('../jobData');

describe('extractJobIdFromApiUrl', () => {
  test('extracts id from a plain voyager API URL', () => {
    expect(
      extractJobIdFromApiUrl('https://www.linkedin.com/voyager/api/jobs/jobPostings/3812345678')
    ).toBe('3812345678');
  });

  test('extracts id when a decorationId query string follows', () => {
    expect(
      extractJobIdFromApiUrl(
        'https://www.linkedin.com/voyager/api/jobs/jobPostings/3812345678?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65'
      )
    ).toBe('3812345678');
  });

  test('regression: previously the code took pathname.split("/")[4], which is' +
    ' the literal string "jobPostings", not the id', () => {
    const url = 'https://www.linkedin.com/voyager/api/jobs/jobPostings/42?decorationId=x';
    const pathname = new URL(url).pathname;
    expect(pathname.split('/')[4]).toBe('jobPostings'); // the old (broken) behavior
    expect(extractJobIdFromApiUrl(url)).toBe('42'); // the fixed behavior
  });

  test('returns null for a non-matching URL', () => {
    expect(extractJobIdFromApiUrl('https://www.linkedin.com/voyager/api/jobs/search')).toBeNull();
  });

  test('returns null for empty/undefined input', () => {
    expect(extractJobIdFromApiUrl('')).toBeNull();
    expect(extractJobIdFromApiUrl(undefined)).toBeNull();
  });
});

describe('extractJobIdFromPageUrl', () => {
  test('extracts id from currentJobId query param', () => {
    expect(
      extractJobIdFromPageUrl('https://www.linkedin.com/jobs/search/?currentJobId=987654321&keywords=engineer')
    ).toBe('987654321');
  });

  test('extracts id from /jobs/view/<id> path with no query string', () => {
    expect(extractJobIdFromPageUrl('https://www.linkedin.com/jobs/view/123456')).toBe('123456');
  });

  test('regression: query string must not leak into the id from /jobs/view/<id>?...', () => {
    const url = 'https://www.linkedin.com/jobs/view/123456?refId=abc&trackingId=xyz';
    // Old behavior: url.split('/view/')[1].split('/')[0] === '123456?refId=abc&trackingId=xyz'
    expect(url.split('/view/')[1].split('/')[0]).not.toBe('123456');
    expect(extractJobIdFromPageUrl(url)).toBe('123456');
  });

  test('extracts id from /jobs/view/<id>/ with a trailing slash', () => {
    expect(extractJobIdFromPageUrl('https://www.linkedin.com/jobs/view/123456/')).toBe('123456');
  });

  test('prefers currentJobId over a /view/ path id when both are present', () => {
    expect(
      extractJobIdFromPageUrl('https://www.linkedin.com/jobs/view/111?currentJobId=222')
    ).toBe('222');
  });

  test('returns null when neither pattern matches', () => {
    expect(extractJobIdFromPageUrl('https://www.linkedin.com/jobs/')).toBeNull();
  });

  test('returns null for empty/undefined input', () => {
    expect(extractJobIdFromPageUrl('')).toBeNull();
    expect(extractJobIdFromPageUrl(undefined)).toBeNull();
  });
});

describe('formatJobAge', () => {
  const now = new Date('2026-07-09T12:00:00Z').getTime();

  test('returns "Just now" for timestamps under an hour old', () => {
    expect(formatJobAge(now - 5 * 60 * 1000, now)).toBe('Just now');
  });

  test('returns "Just now" at exactly 0ms old', () => {
    expect(formatJobAge(now, now)).toBe('Just now');
  });

  test('singular hour', () => {
    expect(formatJobAge(now - 60 * 60 * 1000, now)).toBe('1 hour ago');
  });

  test('plural hours', () => {
    expect(formatJobAge(now - 5 * 60 * 60 * 1000, now)).toBe('5 hours ago');
  });

  test('singular day', () => {
    expect(formatJobAge(now - 24 * 60 * 60 * 1000, now)).toBe('1 day ago');
  });

  test('plural days', () => {
    expect(formatJobAge(now - 10 * 24 * 60 * 60 * 1000, now)).toBe('10 days ago');
  });

  test('handles a future timestamp (clock skew) without throwing', () => {
    expect(formatJobAge(now + 60 * 60 * 1000, now)).toBe('Just now');
  });

  test('returns N/A for null/undefined/invalid input', () => {
    expect(formatJobAge(null, now)).toBe('N/A');
    expect(formatJobAge(undefined, now)).toBe('N/A');
    expect(formatJobAge(NaN, now)).toBe('N/A');
  });
});

describe('parseJobPostingResponse', () => {
  const now = Date.now();

  test('parses the flat entity shape', () => {
    const result = parseJobPostingResponse({ applies: 42, views: 500, listedAt: now - 1000 }, now);
    expect(result).toMatchObject({ applicantCount: 42, viewCount: 500, hasData: true });
    expect(result.jobAge).toBe('Just now');
  });

  test('parses the REST.li data-wrapped shape', () => {
    const result = parseJobPostingResponse({ data: { applies: 7, views: 99, listedAt: now } }, now);
    expect(result).toMatchObject({ applicantCount: 7, viewCount: 99, hasData: true });
  });

  test('parses the legacy jobPosting.numApplicants/numViews shape', () => {
    const result = parseJobPostingResponse({ jobPosting: { numApplicants: 3, numViews: 12 } }, now);
    expect(result).toMatchObject({ applicantCount: 3, viewCount: 12, hasData: true });
  });

  test('parses counts nested inside an "included" normalized entity array', () => {
    const result = parseJobPostingResponse(
      {
        data: { $type: 'com.linkedin.voyager.dash.jobs.JobPosting' },
        included: [
          { $type: 'com.linkedin.voyager.dash.jobs.JobPostingCard' },
          { applies: 15, views: 250, listedAt: now },
        ],
      },
      now
    );
    expect(result).toMatchObject({ applicantCount: 15, viewCount: 250, hasData: true });
  });

  test('treats a genuine 0 applicant/view count as real data, not missing data', () => {
    const result = parseJobPostingResponse({ applies: 0, views: 0, listedAt: now }, now);
    expect(result).toMatchObject({ applicantCount: 0, viewCount: 0, hasData: true });
  });

  test('falls back to N/A and hasData=false when nothing matches any known shape', () => {
    const result = parseJobPostingResponse({ someUnrelatedField: true }, now);
    expect(result).toMatchObject({ applicantCount: 'N/A', viewCount: 'N/A', hasData: false, jobAge: 'N/A' });
  });

  test('does not throw on null/undefined input', () => {
    expect(() => parseJobPostingResponse(null, now)).not.toThrow();
    expect(() => parseJobPostingResponse(undefined, now)).not.toThrow();
    expect(parseJobPostingResponse(null, now).hasData).toBe(false);
  });
});
