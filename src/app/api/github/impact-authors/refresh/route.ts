/**
 * Heavy recompute endpoint.
 * Verification:
 * curl -X POST http://localhost:3000/api/github/impact-authors/refresh \
 *   -H "Content-Type: application/json" \
 *   -d '{"owner":"PostHog","repo":"posthog","days":90}'
 */

import { NextResponse } from "next/server";
import { computeTopAuthors } from "@/lib/github/impact/computeAuthorStats";

export const runtime = "nodejs"; // Uses better-sqlite3; requires Node runtime.

const ALLOWED_DAYS = new Set([30, 60, 90]);

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const owner = typeof body?.owner === "string" ? body.owner : "";
    const repo = typeof body?.repo === "string" ? body.repo : "";
    if (!owner.trim() || !repo.trim()) {
      return NextResponse.json({ ok: false, error: "owner and repo are required" }, { status: 400 });
    }
    const daysVal = typeof body?.days === "number" ? body.days : 90;
    const days = ALLOWED_DAYS.has(daysVal) ? daysVal : 90;

    const { window, topAuthors, computedAt, rowsWritten } = computeTopAuthors({ owner, repo, days });

    return NextResponse.json({
      ok: true,
      window,
      rowsWritten,
      computedAt,
      topAuthors,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
