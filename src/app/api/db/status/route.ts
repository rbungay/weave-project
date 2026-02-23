import { NextResponse } from "next/server";
import { databasePath, getDbConnection, initDatabase } from "@/lib/db/sqlite";

export const runtime = "nodejs";

export async function GET() {
  await initDatabase();
  const db = getDbConnection();

  const counts = {
    api_raw_responses: (db.prepare("SELECT COUNT(*) as c FROM api_raw_responses").get() as { c: number }).c,
    pr_facts: (db.prepare("SELECT COUNT(*) as c FROM pr_facts").get() as { c: number }).c,
    author_stats: (db.prepare("SELECT COUNT(*) as c FROM author_stats").get() as { c: number }).c,
    search_pages: (
      db
        .prepare("SELECT COUNT(*) as c FROM api_raw_responses WHERE endpoint LIKE '/search/issues%'")
        .get() as { c: number }
    ).c,
    pull_details: (
      db
        .prepare("SELECT COUNT(*) as c FROM api_raw_responses WHERE endpoint LIKE '/repos/%/%/pulls/%'")
        .get() as { c: number }
    ).c,
  };

  return NextResponse.json({
    ok: true,
    dbPath: databasePath,
    counts,
  });
}
