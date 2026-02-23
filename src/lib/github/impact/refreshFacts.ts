import "server-only";

import { getDbConnection, initDatabase } from "@/lib/db/sqlite";

type RefreshParams = {
  owner: string;
  repo: string;
  days?: number;
};

type FactRowInput = {
  source_row_id: number;
  fetched_at: string;
  payload: string;
};

type FactRow = {
  owner: string;
  repo: string;
  pr_url: string;
  merged_at: string;
  title: string;
  author: string;
  author_url: string;
  kind: string;
  points: number;
  source_row_id: number;
  fetched_at: string;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 90;

function deriveKind(title: string): { kind: string; points: number } {
  const lower = title.toLowerCase();
  const prefix = lower.split(":")[0]?.trim() ?? "";
  const starts = (p: string) => prefix.startsWith(p);
  if (starts("feat")) return { kind: "feat", points: 3 };
  if (starts("fix")) return { kind: "fix", points: 2 };
  if (starts("chore")) return { kind: "chore", points: 1 };
  if (starts("revert")) return { kind: "revert", points: 0.5 };
  return { kind: "other", points: 0.5 };
}

export function refreshPrFactsForRepo(params: RefreshParams): { sinceIso: string; untilIso: string } {
  const owner = params.owner?.trim();
  const repo = params.repo?.trim();
  if (!owner || !repo) {
    throw new Error("owner and repo are required");
  }
  const days = Number.isFinite(params.days) && params.days ? params.days : DEFAULT_DAYS;
  const untilIso = new Date().toISOString();
  const sinceIso = new Date(Date.now() - days * MS_PER_DAY).toISOString();

  initDatabase();
  const db = getDbConnection();

  // Fetch latest repo payload to get default branch
  const repoEndpoint = `/repos/${owner}/${repo}`;
  const repoRow = db
    .prepare(
      `SELECT payload
       FROM api_raw_responses
       WHERE source = 'github' AND lower(endpoint) = lower(@endpoint)
       ORDER BY id DESC
       LIMIT 1`
    )
    .get({ endpoint: repoEndpoint }) as { payload?: string } | undefined;

  const repoPayload = repoRow?.payload ? JSON.parse(repoRow.payload) : null;
  const defaultBranch =
    repoPayload && typeof repoPayload["default_branch"] === "string"
      ? (repoPayload["default_branch"] as string)
      : null;

  if (!defaultBranch) {
    throw new Error("default_branch not found in stored repo metadata");
  }

  // Latest PR detail rows per PR number within window and merged into default branch
  const rows = db
    .prepare(
      `
      WITH pr_rows AS (
        SELECT
          id as source_row_id,
          fetched_at,
          payload,
          json_extract(payload, '$.number') AS pr_number,
          json_extract(payload, '$.merged_at') AS merged_at,
          json_extract(payload, '$.base.ref') AS base_ref
        FROM api_raw_responses
        WHERE source = 'github'
          AND lower(endpoint) LIKE lower(@endpointLike)
          AND status_code = 200
          AND json_extract(payload, '$.merged_at') IS NOT NULL
          AND json_extract(payload, '$.merged_at') >= @since
      ),
      latest AS (
        SELECT pr_number, MAX(source_row_id) AS source_row_id
        FROM pr_rows
        GROUP BY pr_number
      ),
      picked AS (
        SELECT r.*
        FROM pr_rows r
        JOIN latest l ON r.source_row_id = l.source_row_id
        WHERE r.base_ref = @defaultBranch
      )
      SELECT source_row_id, fetched_at, payload
      FROM picked
      `
    )
    .all({
      endpointLike: `/repos/${owner}/${repo}/pulls/%`,
      since: sinceIso,
      defaultBranch,
    }) as FactRowInput[];

  const upsert = db.prepare(`
    INSERT INTO pr_facts (
      owner, repo, pr_url, merged_at, title, author, author_url, kind, points, source_row_id, fetched_at
    ) VALUES (
      @owner, @repo, @pr_url, @merged_at, @title, @author, @author_url, @kind, @points, @source_row_id, @fetched_at
    )
    ON CONFLICT(owner, repo, pr_url) DO UPDATE SET
      merged_at=excluded.merged_at,
      title=excluded.title,
      author=excluded.author,
      author_url=excluded.author_url,
      kind=excluded.kind,
      points=excluded.points,
      source_row_id=excluded.source_row_id,
      fetched_at=excluded.fetched_at
  `);

  const facts: FactRow[] = [];

  for (const row of rows) {
    const payload = row.payload ? JSON.parse(row.payload) : null;
    if (!payload) continue;
    const prUrl = typeof payload["html_url"] === "string" ? (payload["html_url"] as string) : null;
    const mergedAt = typeof payload["merged_at"] === "string" ? (payload["merged_at"] as string) : null;
    const title = typeof payload["title"] === "string" ? (payload["title"] as string) : null;
    const author =
      payload["user"] && typeof (payload["user"] as { login?: unknown }).login === "string"
        ? ((payload["user"] as { login?: unknown }).login as string)
        : null;

    if (!prUrl || !mergedAt || !title || !author) continue;

    const { kind, points } = deriveKind(title);
    const fact: FactRow = {
      owner,
      repo,
      pr_url: prUrl,
      merged_at: mergedAt,
      title,
      author,
      author_url: `https://github.com/${author}`,
      kind,
      points,
      source_row_id: row.source_row_id,
      fetched_at: row.fetched_at,
    };
    upsert.run(fact);
    facts.push(fact);
  }

  return { sinceIso, untilIso };
}
