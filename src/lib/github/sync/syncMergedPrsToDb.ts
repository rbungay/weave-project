import "server-only";

import { getDbConnection, initDatabase } from "@/lib/db/sqlite";
import { syncMergedPullRequestsRaw } from "@/lib/github/ingestMergedPullRequests";
import { refreshPrFactsForRepo } from "@/lib/github/impact/refreshFacts";

type SyncParams = {
  owner: string;
  repo: string;
  days?: number;
  maxPrs?: number;
  maxListPages?: number;
};

type SyncSummary = {
  discoveredMergedPrs: number;
  fetchedPrDetails: number;
  storedRaw: number;
  insertedPrFacts: number;
  skippedDuplicates: number;
  rateLimit: { remaining: string | null; reset: string | null } | null;
  repoDefaultBranch: string;
};

export async function syncMergedPrsToDb(params: SyncParams): Promise<SyncSummary> {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN missing");
  }

  const owner = params.owner?.trim();
  const repo = params.repo?.trim();
  if (!owner || !repo) {
    throw new Error("owner and repo are required");
  }

  const days = params.days;
  const maxPrDetails = params.maxPrs ?? 2000;
  const maxListPages = params.maxListPages ?? 10;

  await initDatabase();
  const db = getDbConnection();

  const prFactsBefore = db
    .prepare("SELECT COUNT(*) as count FROM pr_facts WHERE owner = ? AND repo = ?")
    .get(owner, repo) as { count: number };

  console.info("impact:sync start owner=%s repo=%s days=%s", owner, repo, days ?? "default");

  const syncResult = await syncMergedPullRequestsRaw({
    owner,
    repo,
    days,
    maxPrDetails,
    maxListPages,
  });

  console.info(
    "impact:sync fetched listPages=%s prDetailsFetched=%s storedDetails=%s discovered=%s defaultBranch=%s",
    syncResult.listPagesFetched,
    syncResult.prDetailsFetched,
    syncResult.prDetailsStored,
    syncResult.prsDiscoveredFromList,
    syncResult.defaultBranch
  );

  await refreshPrFactsForRepo({ owner, repo, days });

  const prFactsAfter = db
    .prepare("SELECT COUNT(*) as count FROM pr_facts WHERE owner = ? AND repo = ?")
    .get(owner, repo) as { count: number };

  const insertedPrFacts = Math.max(prFactsAfter.count - prFactsBefore.count, 0);

  return {
    discoveredMergedPrs: syncResult.prsDiscoveredFromList,
    fetchedPrDetails: syncResult.prDetailsFetched,
    storedRaw: syncResult.prDetailsStored + syncResult.listPagesFetched,
    insertedPrFacts,
    skippedDuplicates: syncResult.prDetailsAlreadyPresent,
    rateLimit: syncResult.rateLimit,
    repoDefaultBranch: syncResult.defaultBranch,
  };
}
