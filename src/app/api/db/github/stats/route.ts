/**
 * Debugging:
 * curl "http://localhost:3000/api/db/github/stats?owner=PostHog&repo=posthog"
 */

import { NextResponse } from "next/server";
import { getDbConnection, initDatabase } from "@/lib/db/sqlite";

export const runtime = "nodejs"; // Uses better-sqlite3; requires Node runtime (not Edge).

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner") ?? "";
  const repo = searchParams.get("repo") ?? "";

  if (!owner.trim() || !repo.trim()) {
    return NextResponse.json({ ok: false, error: "owner and repo are required" }, { status: 400 });
  }

  initDatabase();
  const db = getDbConnection();

  const totalGithubRows = db
    .prepare("SELECT COUNT(*) as count FROM api_raw_responses WHERE source = 'github'")
    .get() as { count: number };

  const endpointLike = `/repos/${owner}/${repo}/pulls/%`;
  const repoPullDetailRows = db
    .prepare(
      "SELECT COUNT(*) as count FROM api_raw_responses WHERE source = 'github' AND endpoint LIKE ?"
    )
    .get(endpointLike) as { count: number };

  const repoMergedPullDetailRows = db
    .prepare(
      "SELECT COUNT(*) as count FROM api_raw_responses WHERE source = 'github' AND endpoint LIKE ? AND json_extract(payload, '$.merged_at') IS NOT NULL"
    )
    .get(endpointLike) as { count: number };

  const latestRepoMetadataFetchedAt = db
    .prepare(
      `SELECT fetched_at as fetchedAt
       FROM api_raw_responses
       WHERE source = 'github' AND endpoint = ?
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(`/repos/${owner}/${repo}`) as { fetchedAt?: string } | undefined;

  return NextResponse.json({
    ok: true,
    totalGithubRows: totalGithubRows.count,
    repoPullDetailRows: repoPullDetailRows.count,
    repoMergedPullDetailRows: repoMergedPullDetailRows.count,
    latestRepoMetadataFetchedAt: latestRepoMetadataFetchedAt?.fetchedAt ?? null,
  });
}
