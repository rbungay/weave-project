import "server-only";

import { getDbConnection, initDatabase } from "@/lib/db/sqlite";
import { refreshPrFactsForRepo } from "@/lib/github/impact/refreshFacts";

type ComputeParams = {
  owner: string;
  repo: string;
  days?: number;
};

type AuthorStat = {
  author: string;
  authorUrl: string;
  totalScore: number;
  totalPrs: number;
  featCount: number;
  fixCount: number;
  choreCount: number;
  revertCount: number;
  otherCount: number;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 90;

const debugEnabled = () => process.env.DEBUG_IMPACT === "1";
const debugTime = async (label: string, fn: () => Promise<void> | void) => {
  if (!debugEnabled()) {
    await fn();
    return;
  }
  console.time(label);
  await fn();
  console.timeEnd(label);
};

export async function computeTopAuthors(params: ComputeParams): Promise<{
  window: { days: number; since: string; until: string };
  topAuthors: AuthorStat[];
  computedAt: string;
  rowsWritten: number;
}> {
  const owner = params.owner?.trim();
  const repo = params.repo?.trim();
  if (!owner || !repo) {
    throw new Error("owner and repo are required");
  }
  const days = Number.isFinite(params.days) && params.days ? params.days : DEFAULT_DAYS;

  const untilIso = new Date().toISOString();
  const sinceIso = new Date(Date.now() - days * MS_PER_DAY).toISOString();

  if (debugEnabled()) console.log("PATH=RECOMPUTE");

  await debugTime("impact:initDatabase", () => initDatabase());
  const db = getDbConnection();

  await debugTime("impact:refreshFacts", async () => {
    await refreshPrFactsForRepo({ owner, repo, days });
  });

  let agg: AuthorStat[] = [];
  await debugTime("impact:computeStats", () => {
    agg = db
      .prepare(
        `
        SELECT
          author,
          author_url as authorUrl,
          SUM(points) AS totalScore,
          COUNT(*) AS totalPrs,
          SUM(CASE WHEN kind = 'feat' THEN 1 ELSE 0 END) AS featCount,
          SUM(CASE WHEN kind = 'fix' THEN 1 ELSE 0 END) AS fixCount,
          SUM(CASE WHEN kind = 'chore' THEN 1 ELSE 0 END) AS choreCount,
          SUM(CASE WHEN kind = 'revert' THEN 1 ELSE 0 END) AS revertCount,
          SUM(CASE WHEN kind = 'other' THEN 1 ELSE 0 END) AS otherCount
        FROM pr_facts
        WHERE owner = @owner
          AND repo = @repo
          AND merged_at >= @since
          AND merged_at <= @until
          AND lower(author) NOT LIKE '%[bot]'
        GROUP BY author, author_url
        ORDER BY totalScore DESC, totalPrs DESC
        LIMIT 5
        `
      )
      .all({ owner, repo, since: sinceIso, until: untilIso }) as AuthorStat[];
  });

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

  debugTime("impact:persistAuthorStats", () => {
    for (const row of agg) {
      upsert.run({
        owner,
        repo,
        days,
        since_iso: sinceIso,
        until_iso: untilIso,
        author: row.author,
        author_url: row.authorUrl,
        total_score: row.totalScore,
        total_prs: row.totalPrs,
        feat_count: row.featCount,
        fix_count: row.fixCount,
        chore_count: row.choreCount,
        revert_count: row.revertCount,
        other_count: row.otherCount,
        computed_at: computedAt,
      });
    }
  });

  return {
    window: { days, since: sinceIso, until: untilIso },
    topAuthors: agg,
    computedAt,
    rowsWritten: agg.length,
  };
}
