/**
 * Verification:
 * curl "http://localhost:3000/api/github/merged-prs?owner=PostHog&repo=posthog&days=90&limit=20"
 * curl "http://localhost:3000/api/db/github/stats?owner=PostHog&repo=posthog"
 */

import { NextResponse } from "next/server";
import { getMergedPrsView } from "@/lib/github/readFromSqlite";

export const runtime = "nodejs"; // Uses better-sqlite3; requires Node runtime (not Edge).

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const owner = searchParams.get("owner") ?? "";
    const repo = searchParams.get("repo") ?? "";
    if (!owner.trim() || !repo.trim()) {
      return NextResponse.json({ ok: false, error: "owner and repo are required" }, { status: 400 });
    }

    const daysParam = searchParams.get("days");
    const limitParam = searchParams.get("limit");
    const excludeBotsParam = searchParams.get("excludeBots");

    const days = daysParam ? Number(daysParam) : undefined;
    const limit = limitParam ? Number(limitParam) : undefined;
    const excludeBots =
      excludeBotsParam !== null
        ? excludeBotsParam.toLowerCase() === "true" || excludeBotsParam === "1"
        : undefined;

    const view = await getMergedPrsView({ owner, repo, days, limit, excludeBots });

    return NextResponse.json({ ok: true, view });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
