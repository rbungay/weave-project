import "server-only"; // Server-only: uses secrets, Node fetch, and SQLite persistence.

import { getDbConnection, initDatabase, insertRawResponse } from "@/lib/db/sqlite";
import { GithubHttpError, githubFetchJson } from "@/lib/github/client";

type SyncParams = {
  owner: string;
  repo: string;
  days?: number;
  maxPrDetails?: number;
  maxListPages?: number;
};

type RateLimitInfo = {
  remaining: string | null;
  reset: string | null;
};

type SyncPreviewRepo = {
  name?: string;
  stars?: number;
  forks?: number;
  defaultBranch?: string;
  openIssues?: number;
};

type SyncPreviewPr = {
  number: number;
  title?: string;
  author?: string;
  mergedAt?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  url?: string;
};

type SyncResult = {
  owner: string;
  repo: string;
  days: number;
  sinceIso: string;
  defaultBranch: string;
  listPagesFetched: number;
  prsDiscoveredFromList: number;
  prDetailsAlreadyPresent: number;
  prDetailsFetched: number;
  prDetailsStored: number;
  mergedPrsWithinWindowCount: number;
  rateLimit: RateLimitInfo | null;
  oldestMergedAtFetched: string | null;
  newestMergedAtFetched: string | null;
  preview: {
    repo: SyncPreviewRepo;
    prs: SyncPreviewPr[];
  };
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 90;
const DEFAULT_MAX_PR_DETAILS = 5000;
const MAX_PR_DETAILS_CAP = 10000;
const LIST_PER_PAGE = 100;
const DEFAULT_MAX_LIST_PAGES = 200;
const DETAIL_CONCURRENCY = 4;

class RateLimitExceededError extends Error {
  rateLimit: RateLimitInfo | null;
  status: number;
  summary?: SyncResult;

  constructor(message: string, status: number, rateLimit: RateLimitInfo | null, summary?: SyncResult) {
    super(message);
    this.status = status;
    this.rateLimit = rateLimit;
    this.summary = summary;
  }
}

function rethrowIfRateLimit(error: unknown): never {
  if (error instanceof GithubHttpError && error.status === 403) {
    const rateLimit = extractRateLimit(error.headers);
    throw new RateLimitExceededError(
      "GitHub rate limit reached; retry after reset.",
      error.status,
      rateLimit
    );
  }
  throw error instanceof Error ? error : new Error("Unknown error");
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function extractRateLimit(headers: Headers): RateLimitInfo | null {
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining === null && reset === null) {
    return null;
  }
  return { remaining, reset };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  let abortErr: unknown = null;

  const worker = async () => {
    while (true) {
      if (abortErr) return;
      const current = index++;
      if (current >= items.length) return;
      try {
        results[current] = await fn(items[current], current);
      } catch (err) {
        abortErr = err;
        return;
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);

  if (abortErr) {
    throw abortErr;
  }

  return results;
}

export async function syncMergedPullRequestsRaw(params: SyncParams): Promise<SyncResult> {
  const owner = params.owner?.trim();
  const repo = params.repo?.trim();
  if (!owner || !repo) {
    throw new Error("Both owner and repo are required.");
  }

  const days = Number.isFinite(params.days) && params.days ? params.days : DEFAULT_DAYS;
  const maxPrDetailsInput =
    Number.isFinite(params.maxPrDetails) && params.maxPrDetails
      ? params.maxPrDetails
      : DEFAULT_MAX_PR_DETAILS;
  const maxPrDetails = clampNumber(maxPrDetailsInput, 1, MAX_PR_DETAILS_CAP);
  const maxListPagesInput =
    Number.isFinite(params.maxListPages) && params.maxListPages
      ? params.maxListPages
      : DEFAULT_MAX_LIST_PAGES;
  const maxListPages = clampNumber(maxListPagesInput, 1, DEFAULT_MAX_LIST_PAGES);
  const sinceIso = new Date(Date.now() - days * MS_PER_DAY).toISOString();

  initDatabase();

  let listPagesFetched = 0;
  let prDetailsAlreadyPresent = 0;
  let prDetailsFetched = 0;
  let prDetailsStored = 0;
  let mergedPrsWithinWindowCount = 0;
  let lastRateLimit: RateLimitInfo | null = null;
  let oldestMergedAtFetched: string | null = null;
  let newestMergedAtFetched: string | null = null;

  // 1) Repo metadata (raw)
  const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;
  const repoResp = await githubFetchJson<Record<string, unknown>>(repoUrl).catch((error) =>
    rethrowIfRateLimit(error)
  );
  lastRateLimit = extractRateLimit(repoResp.headers) ?? lastRateLimit;
  const repoInsert = insertRawResponse({
    source: "github",
    endpoint: `/repos/${owner}/${repo}`,
    statusCode: repoResp.status,
    payload: repoResp.data,
  });
  if (repoInsert.inserted) {
    // stored
  }
  const repoPreview: SyncPreviewRepo = {
    name: typeof repoResp.data["name"] === "string" ? (repoResp.data["name"] as string) : undefined,
    stars:
      typeof repoResp.data["stargazers_count"] === "number"
        ? (repoResp.data["stargazers_count"] as number)
        : undefined,
    forks:
      typeof repoResp.data["forks_count"] === "number"
        ? (repoResp.data["forks_count"] as number)
        : undefined,
    defaultBranch:
      typeof repoResp.data["default_branch"] === "string"
        ? (repoResp.data["default_branch"] as string)
        : undefined,
    openIssues:
      typeof repoResp.data["open_issues_count"] === "number"
        ? (repoResp.data["open_issues_count"] as number)
        : undefined,
  };
  const defaultBranch = repoPreview.defaultBranch ?? "";

  // 2) Discover PRs via list API (closed, base default branch)
  const prNumbers: number[] = [];
  const seenNumbers = new Set<number>();

  const updateMergedAtBounds = (mergedAt: string | null | undefined) => {
    if (!mergedAt) return;
    const ts = Date.parse(mergedAt);
    if (Number.isNaN(ts)) return;
    if (!oldestMergedAtFetched || ts < Date.parse(oldestMergedAtFetched)) {
      oldestMergedAtFetched = new Date(ts).toISOString();
    }
    if (!newestMergedAtFetched || ts > Date.parse(newestMergedAtFetched)) {
      newestMergedAtFetched = new Date(ts).toISOString();
    }
  };

  const createSummary = (previewPrs: SyncPreviewPr[], rateLimit: RateLimitInfo | null): SyncResult => ({
    owner,
    repo,
    days,
    sinceIso,
    defaultBranch,
    listPagesFetched,
    prsDiscoveredFromList: Math.min(prNumbers.length, maxPrDetails),
    prDetailsAlreadyPresent,
    prDetailsFetched,
    prDetailsStored,
    mergedPrsWithinWindowCount,
    rateLimit,
    oldestMergedAtFetched,
    newestMergedAtFetched,
    preview: {
      repo: repoPreview,
      prs: previewPrs,
    },
  });

  if (!repoPreview.defaultBranch) {
    throw new Error("Repository default_branch is required to filter merged PRs.");
  }

  for (let page = 1; page <= maxListPages; page += 1) {
    const listUrl = `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&base=${repoPreview.defaultBranch}&sort=updated&direction=desc&per_page=${LIST_PER_PAGE}&page=${page}`;
    let listResp: Awaited<ReturnType<typeof githubFetchJson<unknown[]>>>;
    try {
      listResp = await githubFetchJson<unknown[]>(listUrl);
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        throw new RateLimitExceededError(
          "GitHub rate limit reached; retry after reset.",
          error.status,
          error.rateLimit,
          createSummary([], error.rateLimit ?? null)
        );
      }
      rethrowIfRateLimit(error);
    }
    const { status, data, headers } = listResp;
    lastRateLimit = extractRateLimit(headers) ?? lastRateLimit;
    listPagesFetched += 1;

    const listEndpoint = `/repos/${owner}/${repo}/pulls?state=closed&base=${repoPreview.defaultBranch}&sort=updated&direction=desc&per_page=${LIST_PER_PAGE}&page=${page}&since=${sinceIso}`;
    insertRawResponse({
      source: "github",
      endpoint: listEndpoint,
      statusCode: status,
      payload: data,
    });
    // Even if duplicate, we keep going; dedupe handled on insertRawResponse return.

    const items = Array.isArray(data) ? (data as unknown[]) : [];
    for (const item of items) {
      const num = (item as { number?: unknown }).number;
      if (typeof num === "number" && !seenNumbers.has(num)) {
        seenNumbers.add(num);
        prNumbers.push(num);
      }
    }

    const lastItem = items.length > 0 ? (items[items.length - 1] as { updated_at?: string }) : null;
    const lastUpdatedMs = lastItem?.updated_at ? Date.parse(lastItem.updated_at as string) : NaN;

    if (items.length === 0 || prNumbers.length >= maxPrDetails) {
      break;
    }
    if (Number.isFinite(lastUpdatedMs) && lastUpdatedMs < Date.parse(sinceIso)) {
      break;
    }
  }

  const limitedPrNumbers = prNumbers.slice(0, maxPrDetails);

  // 3) Fetch PR details (raw, concurrency-limited)
  const fetchDetail = async (pullNumber: number): Promise<SyncPreviewPr> => {
    const detailUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`;
    try {
      const { status, data, headers } = await githubFetchJson<Record<string, unknown>>(detailUrl);
      lastRateLimit = extractRateLimit(headers) ?? lastRateLimit;
      prDetailsFetched += 1;

      const detailInsert = insertRawResponse({
        source: "github",
        endpoint: `/repos/${owner}/${repo}/pulls/${pullNumber}`,
        statusCode: status,
        payload: data,
      });
      if (detailInsert.inserted) {
        prDetailsStored += 1;
      }

      const preview: SyncPreviewPr = {
        number: pullNumber,
        title: typeof data["title"] === "string" ? (data["title"] as string) : undefined,
        author:
          data["user"] && typeof (data["user"] as { login?: unknown }).login === "string"
            ? ((data["user"] as { login?: unknown }).login as string)
            : undefined,
        mergedAt:
          typeof data["merged_at"] === "string" ? (data["merged_at"] as string) : undefined,
        additions:
          typeof data["additions"] === "number" ? (data["additions"] as number) : undefined,
        deletions:
          typeof data["deletions"] === "number" ? (data["deletions"] as number) : undefined,
        changedFiles:
          typeof data["changed_files"] === "number" ? (data["changed_files"] as number) : undefined,
        url: typeof data["html_url"] === "string" ? (data["html_url"] as string) : undefined,
      };
      if (preview.mergedAt) {
        updateMergedAtBounds(preview.mergedAt);
        const mergedTs = Date.parse(preview.mergedAt);
        if (Number.isFinite(mergedTs) && mergedTs >= Date.parse(sinceIso)) {
          mergedPrsWithinWindowCount += 1;
        }
      }
      return preview;
    } catch (error) {
      rethrowIfRateLimit(error);
    }
  };

  // Skip already stored detail rows.
  const toFetch: number[] = [];
  for (const prNumber of limitedPrNumbers) {
    const endpoint = `/repos/${owner}/${repo}/pulls/${prNumber}`;
    const existing = getDbConnection()
      .prepare(
        `SELECT json_extract(payload, '$.merged_at') as merged_at
         FROM api_raw_responses
         WHERE source = 'github' AND endpoint = ? AND status_code = 200
         ORDER BY id DESC
         LIMIT 1`
      )
      .get(endpoint) as { merged_at?: string } | undefined;
    if (existing && existing.merged_at) {
      prDetailsAlreadyPresent += 1;
      continue;
    }
    toFetch.push(prNumber);
  }

  let detailPreviews: SyncPreviewPr[] = [];
  try {
    detailPreviews =
      toFetch.length > 0
        ? await mapWithConcurrency(toFetch, DETAIL_CONCURRENCY, fetchDetail)
        : [];
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      const partialSummary = createSummary(
        detailPreviews.filter((p): p is SyncPreviewPr => Boolean(p)).slice(0, 5),
        error.rateLimit
      );
      throw new RateLimitExceededError(
        "GitHub rate limit reached; retry after reset.",
        error.status,
        error.rateLimit,
        partialSummary
      );
    }
    throw error;
  }
  const previewPrs = detailPreviews.filter((p): p is SyncPreviewPr => Boolean(p)).slice(0, 5);

  return createSummary(previewPrs, lastRateLimit);
}

export { RateLimitExceededError };
