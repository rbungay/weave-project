import { NextResponse } from "next/server";
import {
  databasePath,
  getRecentResponses,
  initDatabase,
  insertRawResponse,
} from "@/lib/db/sqlite";

export const runtime = "nodejs"; // better-sqlite3 relies on Node APIs; Edge runtime is unsupported.

export async function GET() {
  initDatabase();

  const insertResult = insertRawResponse({
    source: "bootstrap",
    endpoint: "/api/db/health",
    statusCode: 200,
    payload: { ok: true, ts: Date.now() },
  });

  const recent = getRecentResponses({ source: "bootstrap", limit: 5 });

  return NextResponse.json({
    ok: true,
    dbPath: databasePath,
    insertResult,
    recent,
  });
}
