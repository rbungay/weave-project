/**
 * Verification:
 * curl -X POST http://localhost:3000/api/github/sync-merged-prs \
 *   -H "Content-Type: application/json" \
 *   -d '{"owner":"PostHog","repo":"posthog","days":90,"maxPrDetails":5000,"maxListPages":200}'
 * curl http://localhost:3000/api/db/github/recent
 */

import { NextResponse } from "next/server";
import {
  RateLimitExceededError,
  syncMergedPullRequestsRaw,
} from "@/lib/github/ingestMergedPullRequests";

export const runtime = "nodejs"; // better-sqlite3 and native fetch require the Node runtime (not Edge).

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const owner = typeof body?.owner === "string" ? body.owner : "";
    const repo = typeof body?.repo === "string" ? body.repo : "";

    if (!owner.trim() || !repo.trim()) {
      return NextResponse.json(
        { ok: false, error: "owner and repo are required" },
        { status: 400 }
      );
    }

    const days = typeof body?.days === "number" ? body.days : undefined;
    const maxPrDetails =
      typeof body?.maxPrDetails === "number" ? body.maxPrDetails : undefined;
    const maxListPages =
      typeof body?.maxListPages === "number" ? body.maxListPages : undefined;

    const summary = await syncMergedPullRequestsRaw({
      owner,
      repo,
      days,
      maxPrDetails,
      maxListPages,
    });

    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          rateLimit: error.rateLimit,
          summary: error.summary,
        },
        { status: 429 }
      );
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
