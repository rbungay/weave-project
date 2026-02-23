/**
 * Verification:
 * curl "http://localhost:3000/api/github/impact-authors?owner=PostHog&repo=posthog&days=90"
 */

import { NextResponse } from "next/server";
import { getDbConnection, initDatabase } from "@/lib/db/sqlite";

const debugEnabled = () => process.env.DEBUG_IMPACT === "1";
const debugTime = (label: string, fn: () => unknown) => {
  if (!debugEnabled()) return fn();
  console.time(label);
  const result = fn();
  console.timeEnd(label);
  return result;
};

export const runtime = "nodejs"; // Uses better-sqlite3; requires Node runtime.

const ALLOWED_DAYS = new Set([30, 60, 90]);
const ORDER_BY_MAP: Record<string, string> = {
  overall: "total_score DESC, total_prs DESC",
  feat: "feat_count DESC, total_score DESC",
  fix: "fix_count DESC, total_score DESC",
  chore: "chore_count DESC, total_score DESC",
  revert: "revert_count DESC, total_score DESC",
  other: "other_count DESC, total_score DESC",
};

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const owner = searchParams.get("owner") ?? "";
    const repo = searchParams.get("repo") ?? "";
    if (!owner.trim() || !repo.trim()) {
      return NextResponse.json({ ok: false, error: "owner and repo are required" }, { status: 400 });
    }
    const daysParam = searchParams.get("days");
    const daysNum = daysParam ? Number(daysParam) : 90;
    const days = ALLOWED_DAYS.has(daysNum) ? daysNum : 90;
    const rankByParam = (searchParams.get("rankBy") ?? "overall").toLowerCase();
    const orderBy = ORDER_BY_MAP[rankByParam] ?? ORDER_BY_MAP.overall;
  const untilIso = new Date().toISOString();
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    if (debugEnabled()) console.log("PATH=READ_AUTHOR_STATS");

  debugTime("impact:initDatabase", () => initDatabase());
  const db = getDbConnection();

  const beforeComputedAt = db
    .prepare(
      `SELECT MAX(computed_at) as computed_at FROM author_stats WHERE owner = ? AND repo = ? AND days = ?`
    )
    .get(owner, repo, days) as { computed_at?: string } | undefined;
  if (debugEnabled()) console.log("impact:before_computed_at", beforeComputedAt?.computed_at ?? null);

  type Row = {
    author: string;
    author_url: string;
    total_score: number;
    total_prs: number;
    feat_count: number;
    fix_count: number;
    chore_count: number;
    revert_count: number;
    other_count: number;
    since_iso?: string;
    until_iso?: string;
    computed_at?: string;
  };

  let rows: Row[] = [];

  debugTime("impact:read_author_stats", () => {
    rows = db
      .prepare(
        `
          SELECT author, author_url, total_score, total_prs,
                 feat_count, fix_count, chore_count, revert_count, other_count,
                 since_iso, until_iso, computed_at
          FROM author_stats
          WHERE owner = @owner AND repo = @repo AND days = @days
          ORDER BY ${orderBy}
          LIMIT 5
        `
      )
      .all({ owner, repo, days }) as Row[];
  });

  const window = { days, since: sinceIso, until: untilIso };

  // If stats exist, return immediately (window uses requested window).
  if (rows && rows.length > 0) {
    const afterComputedAt = db
      .prepare(
        `SELECT MAX(computed_at) as computed_at FROM author_stats WHERE owner = ? AND repo = ? AND days = ?`
      )
      .get(owner, repo, days) as { computed_at?: string } | undefined;
    if (debugEnabled()) console.log("impact:after_computed_at", afterComputedAt?.computed_at ?? null);

    const topAuthors = rows.map((r) => ({
      author: r.author,
      authorUrl: r.author_url,
      totalScore: r.total_score,
      totalPrs: r.total_prs,
      featCount: r.feat_count,
      fixCount: r.fix_count,
      choreCount: r.chore_count,
      revertCount: r.revert_count,
      otherCount: r.other_count,
      computedAt: r.computed_at,
    }));

    return NextResponse.json({ ok: true, window, topAuthors });
  }

  if (debugEnabled()) console.log("PATH=READ_PR_FACTS_AGG");

  // Aggregate directly from pr_facts for the requested window (no GitHub calls).
  debugTime("impact:agg_from_pr_facts", () => {
    rows = db
      .prepare(
        `
        SELECT
          author,
          author_url,
          SUM(points) AS total_score,
          COUNT(*) AS total_prs,
          SUM(CASE WHEN kind = 'feat' THEN 1 ELSE 0 END) AS feat_count,
          SUM(CASE WHEN kind = 'fix' THEN 1 ELSE 0 END) AS fix_count,
          SUM(CASE WHEN kind = 'chore' THEN 1 ELSE 0 END) AS chore_count,
          SUM(CASE WHEN kind = 'revert' THEN 1 ELSE 0 END) AS revert_count,
          SUM(CASE WHEN kind = 'other' THEN 1 ELSE 0 END) AS other_count
        FROM pr_facts
        WHERE owner = @owner
          AND repo = @repo
          AND merged_at >= @since
          AND merged_at <= @until
          AND lower(author) NOT LIKE '%[bot]'
        GROUP BY author, author_url
        ORDER BY ${orderBy}
        LIMIT 5
      `
      )
      .all({ owner, repo, since: sinceIso, until: untilIso }) as Row[];
  });

  // Persist the result for reuse (optional but helpful).
  if (rows.length > 0) {
    const computedAt = new Date().toISOString();
    const upsert = db.prepare(`
      INSERT INTO author_stats (
        owner, repo, days, since_iso, until_iso, author, author_url,
        total_score, total_prs, feat_count, fix_count, chore_count, revert_count, other_count, computed_at
      ) VALUES (
        @owner, @repo, @days, @since_iso, @until_iso, @author, @author_url,
        @total_score, @total_prs, @feat_count, @fix_count, @chore_count, @revert_count, @other_count, @computed_at
      )
      ON CONFLICT(owner, repo, days, author) DO UPDATE SET
        since_iso=excluded.since_iso,
        until_iso=excluded.until_iso,
        total_score=excluded.total_score,
        total_prs=excluded.total_prs,
        feat_count=excluded.feat_count,
        fix_count=excluded.fix_count,
        chore_count=excluded.chore_count,
        revert_count=excluded.revert_count,
        other_count=excluded.other_count,
        computed_at=excluded.computed_at
    `);

    debugTime("impact:persist_author_stats_on_read", () => {
      for (const r of rows) {
        upsert.run({
          owner,
          repo,
          days,
          since_iso: sinceIso,
          until_iso: untilIso,
          author: r.author,
          author_url: r.author_url,
          total_score: r.total_score,
          total_prs: r.total_prs,
          feat_count: r.feat_count,
          fix_count: r.fix_count,
          chore_count: r.chore_count,
          revert_count: r.revert_count,
          other_count: r.other_count,
          computed_at: computedAt,
        });
      }
    });
  }

  const topAuthors = rows.map((r) => ({
    author: r.author,
    authorUrl: r.author_url,
    totalScore: r.total_score,
    totalPrs: r.total_prs,
    featCount: r.feat_count,
    fixCount: r.fix_count,
    choreCount: r.chore_count,
    revertCount: r.revert_count,
    otherCount: r.other_count,
    computedAt: r.computed_at ?? null,
  }));

  return NextResponse.json({ ok: true, window, topAuthors });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
