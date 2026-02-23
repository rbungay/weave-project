/**
 * Verification:
 * curl -X POST http://localhost:3000/api/github/sync-prs \
 *   -H "Content-Type: application/json" \
 *   -d '{"owner":"<OWNER>","repo":"<REPO>","days":90}'
 * curl http://localhost:3000/api/db/github/recent
 */

import { NextResponse } from "next/server";
import { ingestPullRequests } from "@/lib/github/ingestPullRequests";

export const runtime = "nodejs"; // better-sqlite3 requires the Node runtime (not Edge).

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const owner = typeof body?.owner === "string" ? body.owner : "";
    const repo = typeof body?.repo === "string" ? body.repo : "";

    if (!owner.trim() || !repo.trim()) {
      return NextResponse.json(
        { ok: false, error: "owner and repo are required" },
        { status: 400 }
      );
    }

    const days = typeof body?.days === "number" ? body.days : undefined;
    const perPage = typeof body?.perPage === "number" ? body.perPage : undefined;

    const summary = await ingestPullRequests({ owner, repo, days, perPage });

    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
