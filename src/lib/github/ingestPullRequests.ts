import "server-only"; // Server-only: uses secrets, Node fetch, and SQLite.

import { initDatabase, insertRawResponse } from "@/lib/db/sqlite";
import { githubFetchJson } from "@/lib/github/client";

type IngestParams = {
  owner: string;
  repo: string;
  days?: number;
  perPage?: number;
};

type IngestSummary = {
  owner: string;
  repo: string;
  days: number;
  sinceIso: string;
  pagesFetched: number;
  prsFetchedTotal: number;
  storedCount: number;
  skippedDuplicatesCount: number;
  stoppedEarly: boolean;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 90;
const DEFAULT_PER_PAGE = 100;
const MAX_PER_PAGE = 100;

export async function ingestPullRequests(params: IngestParams): Promise<IngestSummary> {
  const owner = params.owner?.trim();
  const repo = params.repo?.trim();
  if (!owner || !repo) {
    throw new Error("Both owner and repo are required.");
  }

  const days = Number.isFinite(params.days) && params.days ? params.days : DEFAULT_DAYS;
  const perPageInput = Number.isFinite(params.perPage) && params.perPage ? params.perPage : DEFAULT_PER_PAGE;
  const perPage = Math.min(Math.max(perPageInput, 1), MAX_PER_PAGE);

  const sinceMs = Date.now() - days * MS_PER_DAY;
  const sinceIso = new Date(sinceMs).toISOString();

  initDatabase();

  let page = 1;
  let pagesFetched = 0;
  let prsFetchedTotal = 0;
  let storedCount = 0;
  let skippedDuplicatesCount = 0;
  let stoppedEarly = false;

  // Pagination loop: stop on empty array or when the last item is older than the window.
  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${perPage}&page=${page}`;
    const { status, data } = await githubFetchJson<unknown[]>(url);

    if (!Array.isArray(data)) {
      throw new Error(`Unexpected GitHub response shape for pulls page ${page}.`);
    }

    const endpointForStorage = `/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${perPage}&page=${page}&since=${sinceIso}`;
    const insertResult = insertRawResponse({
      source: "github",
      endpoint: endpointForStorage,
      statusCode: status,
      payload: data,
    });

    if (insertResult.inserted) {
      storedCount += 1;
    } else {
      skippedDuplicatesCount += 1;
    }

    pagesFetched += 1;
    prsFetchedTotal += data.length;

    // Stop if this page is empty.
    if (data.length === 0) {
      break;
    }

    const lastItem = data[data.length - 1] as { updated_at?: string };
    const lastUpdatedMs = lastItem?.updated_at ? Date.parse(lastItem.updated_at) : Number.NaN;
    if (Number.isFinite(lastUpdatedMs) && lastUpdatedMs < sinceMs) {
      stoppedEarly = true;
      break;
    }

    console.info(
      `[github] fetched pulls page ${page} (${data.length} items, status ${status}), total so far ${prsFetchedTotal}`
    );

    page += 1;
  }

  return {
    owner,
    repo,
    days,
    sinceIso,
    pagesFetched,
    prsFetchedTotal,
    storedCount,
    skippedDuplicatesCount,
    stoppedEarly,
  };
}
