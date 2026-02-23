import { NextResponse } from "next/server";
import { getRecentResponses } from "@/lib/db/sqlite";

export const runtime = "nodejs"; // better-sqlite3 requires the Node runtime (not Edge).

export async function GET() {
  try {
    const recent = getRecentResponses({ source: "github", limit: 20 });
    return NextResponse.json({ ok: true, recent });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
