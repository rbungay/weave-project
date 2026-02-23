import "server-only"; // Server-only: reads secrets-protected SQLite and uses Node APIs.

import { getDbConnection, initDatabase } from "@/lib/db/sqlite";

type ViewParams = {
  owner: string;
  repo: string;
  days?: number;
  limit?: number;
  excludeBots?: boolean;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 90;
const DEFAULT_LIMIT = 200;
// Safety cap. PostHog 90d can be thousands; raise if needed.
const MAX_LIMIT = 5000;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function parseJsonSafely<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    console.warn("Failed to parse JSON payload from SQLite row", error);
    return null;
  }
}

export async function getMergedPrsView(params: ViewParams): Promise<unknown> {
  const owner = params.owner?.trim();
  const repo = params.repo?.trim();
  if (!owner || !repo) {
    throw new Error("owner and repo are required");
  }

  const days = Number.isFinite(params.days) && params.days ? params.days : DEFAULT_DAYS;
  const limitInput = Number.isFinite(params.limit) && params.limit ? params.limit : DEFAULT_LIMIT;
  const limit = clamp(limitInput, 1, MAX_LIMIT);
  const excludeBots = params.excludeBots ?? false;

  const now = new Date();
  const untilIso = now.toISOString();
  const sinceIso = new Date(now.getTime() - days * MS_PER_DAY).toISOString();

  initDatabase();
  const db = getDbConnection();

  // Repo metadata (latest) — case-insensitive endpoint match
  const repoEndpoint = `/repos/${owner}/${repo}`;
  const repoRow = db
    .prepare(
      `SELECT payload
       FROM api_raw_responses
       WHERE source = 'github' AND lower(endpoint) = lower(?)
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(repoEndpoint) as { payload?: string } | undefined;

  const repoPayload = repoRow?.payload ? parseJsonSafely<Record<string, unknown>>(repoRow.payload) : null;

  const repoView = {
    name: repoPayload && typeof repoPayload["name"] === "string" ? (repoPayload["name"] as string) : null,
    stars:
      repoPayload && typeof repoPayload["stargazers_count"] === "number"
        ? (repoPayload["stargazers_count"] as number)
        : null,
    forks:
      repoPayload && typeof repoPayload["forks_count"] === "number"
        ? (repoPayload["forks_count"] as number)
        : null,
    defaultBranch:
      repoPayload && typeof repoPayload["default_branch"] === "string"
        ? (repoPayload["default_branch"] as string)
        : null,
    openIssues:
      repoPayload && typeof repoPayload["open_issues_count"] === "number"
        ? (repoPayload["open_issues_count"] as number)
        : null,
  };

  const defaultBranch = repoView.defaultBranch;
  if (!defaultBranch) {
    return {
      window: { days, since: sinceIso, until: untilIso },
      repo: repoView,
      prs: [],
    };
  }

  // PR detail rows filtered + de-duplicated at SQL level with JSON1:
  // - Case-insensitive endpoint match
  // - One row per PR number (latest stored row wins via max(id))
  const ownerNorm = owner.toLowerCase();
  const repoNorm = repo.toLowerCase();
  const endpointLikeLower = `/repos/${ownerNorm}/${repoNorm}/pulls/%`;

  const paramsClause = {
    endpointLikeLower,
    since: sinceIso,
    branch: defaultBranch,
    limit,
  };

  const botFilter = excludeBots
    ? `AND lower(json_extract(payload, '$.user.type')) != 'bot'
       AND lower(json_extract(payload, '$.user.login')) NOT LIKE '%bot%'`
    : "";

  const prRows = db
    .prepare(
      `WITH latest AS (
         SELECT max(id) AS id
         FROM api_raw_responses
         WHERE source = 'github'
           AND lower(endpoint) LIKE @endpointLikeLower
           AND status_code = 200
           AND json_extract(payload, '$.merged_at') IS NOT NULL
           AND json_extract(payload, '$.merged_at') >= @since
           AND json_extract(payload, '$.base.ref') = @branch
           ${botFilter}
         GROUP BY json_extract(payload, '$.number')
       )
       SELECT payload
       FROM api_raw_responses
       WHERE id IN (SELECT id FROM latest)
       ORDER BY json_extract(payload, '$.merged_at') DESC
       LIMIT @limit`
    )
    .all(paramsClause) as Array<{ payload?: string }>;

  const prs = prRows
    .map((row) => (row.payload ? parseJsonSafely<Record<string, unknown>>(row.payload) : null))
    .filter((payload): payload is Record<string, unknown> => payload !== null)
    .map((payload) => ({
      number: typeof payload["number"] === "number" ? (payload["number"] as number) : null,
      title: typeof payload["title"] === "string" ? (payload["title"] as string) : null,
      author:
        payload["user"] && typeof (payload["user"] as { login?: unknown }).login === "string"
          ? ((payload["user"] as { login?: unknown }).login as string)
          : null,
      mergedAt: typeof payload["merged_at"] === "string" ? (payload["merged_at"] as string) : null,
      additions: typeof payload["additions"] === "number" ? (payload["additions"] as number) : null,
      deletions: typeof payload["deletions"] === "number" ? (payload["deletions"] as number) : null,
      changedFiles: typeof payload["changed_files"] === "number" ? (payload["changed_files"] as number) : null,
      url: typeof payload["html_url"] === "string" ? (payload["html_url"] as string) : null,
    }));

  // Optional lightweight sanity stats (handy while building UI; remove if you want)
  const uniquePrs = new Set<number>();
  for (const pr of prs) {
    if (typeof pr.number === "number") uniquePrs.add(pr.number);
  }

  return {
    window: { days, since: sinceIso, until: untilIso },
    repo: repoView,
    prs,
    counts: { rowsReturned: prs.length, uniquePrs: uniquePrs.size },
  };
}