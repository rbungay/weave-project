"use client";

import { useEffect, useMemo, useState } from "react";

type LeaderboardEntry = {
  author: string;
  authorUrl: string;
  totalScore: number;
  totalPrs: number;
  featCount: number;
  fixCount: number;
  choreCount: number;
  revertCount: number;
  otherCount: number;
  computedAt?: string;
};

type LeaderboardResponse = {
  ok: boolean;
  window?: { days: number; since: string; until: string };
  topAuthors?: LeaderboardEntry[];
  error?: string;
};

const OWNER = "PostHog";
const REPO = "posthog";
const DAYS_OPTIONS = [30, 60, 90] as const;

const leaderboards: Array<{
  key: string;
  title: string;
  subtitle: string;
  rankBy: "overall" | "feat" | "fix" | "chore";
  metricLabel: string;
  renderValue: (row: LeaderboardEntry) => string;
}> = [
  {
    key: "overall",
    title: "Top 5 Impact",
    subtitle: "Ranked by total points from merged PR titles (feat/fix/chore).",
    rankBy: "overall",
    metricLabel: "Points",
    renderValue: (r) => r.totalScore.toFixed(1).replace(/\\.0$/, ""),
  },
  {
    key: "feat",
    title: "What’s New?",
    subtitle: "Top 5 authors by count of merged features.",
    rankBy: "feat",
    metricLabel: "Count",
    renderValue: (r) => `${r.featCount}`,
  },
  {
    key: "fix",
    title: "Fix Masters",
    subtitle: "Top 5 authors by count of merged fixes.",
    rankBy: "fix",
    metricLabel: "Count",
    renderValue: (r) => `${r.fixCount}`,
  },
  {
    key: "chore",
    title: "Daily Chores",
    subtitle: "Top 5 authors by count of merged chores.",
    rankBy: "chore",
    metricLabel: "Count",
    renderValue: (r) => `${r.choreCount}`,
  },
];

export function ImpactDashboard() {
  const [days, setDays] = useState<number>(90);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Record<string, { window?: { since: string; until: string }; rows: LeaderboardEntry[] }>>({});

  const windowLabel = useMemo(() => {
    const any = Object.values(data)[0];
    return any?.window
      ? `${new Date(any.window.since).toISOString().slice(0, 10)} → ${new Date(any.window.until).toISOString().slice(0, 10)}`
      : "";
  }, [data]);

  useEffect(() => {
    let cancelled = false;
    const fetchAll = async () => {
      setLoading(true);
      setError(null);
      try {
        const results = await Promise.all(
          leaderboards.map(async (lb) => {
            const url = `/api/github/impact-authors?owner=${encodeURIComponent(
              OWNER
            )}&repo=${encodeURIComponent(REPO)}&days=${days}&rankBy=${lb.rankBy}`;
            const res = await fetch(url);
            const json = (await res.json()) as LeaderboardResponse;
            if (!json.ok || !json.topAuthors) {
              throw new Error(json.error || `Failed to load ${lb.title}`);
            }
            return {
              key: lb.key,
              window: json.window,
              rows: json.topAuthors ?? [],
            };
          })
        );
        if (cancelled) return;
        const next: Record<string, { window?: { since: string; until: string }; rows: LeaderboardEntry[] }> = {};
        for (const r of results) {
          next[r.key] = { window: r.window, rows: r.rows };
        }
        setData(next);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load data");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchAll();
    return () => {
      cancelled = true;
    };
  }, [days]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-gray-900">Impact Dashboard</h1>
          <p className="text-sm text-gray-600">
            Repo: <span className="font-medium">{OWNER}/{REPO}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {DAYS_OPTIONS.map((option) => (
            <button
              key={option}
              onClick={() => setDays(option)}
              className={`rounded-full px-4 py-2 text-sm font-medium border ${
                days === option ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-800 border-gray-300"
              }`}
            >
              {option}d
            </button>
          ))}
        </div>
      </header>

      <p className="text-sm text-gray-700">
        Track who’s shipping what — fast, transparent, and comparable across 30/60/90-day windows.
      </p>

      <div className="rounded-md border border-gray-200 bg-white p-4 text-sm text-gray-700 shadow-sm">
        <p>
          This dashboard shows contribution impact based on merged PRs to the default branch for a selected time window (30/60/90 days).
          Overall Impact scoring:
        </p>
        <ul className="ml-4 list-disc">
          <li>feat = 3 points</li>
          <li>fix = 2 points</li>
          <li>chore = 1 point</li>
          <li>other = 0.5 points</li>
        </ul>
        <p className="mt-1">Authors ending with “[bot]” are excluded from rankings.</p>
      </div>

      {windowLabel && (
        <div className="text-sm text-gray-600">
          Window: <span className="font-mono">{windowLabel}</span>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {leaderboards.map((lb) => {
          const rows = data[lb.key]?.rows ?? [];
          const win = data[lb.key]?.window;
          return (
            <div key={lb.key} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <div className="mb-2 flex items-baseline justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">{lb.title}</h2>
                  <p className="text-xs text-gray-500">{lb.subtitle}</p>
                </div>
                {win ? (
                  <span className="text-xs text-gray-500">
                    {new Date(win.since).toISOString().slice(0, 10)} → {new Date(win.until).toISOString().slice(0, 10)}
                  </span>
                ) : null}
              </div>
              {loading ? (
                <div className="py-6 text-sm text-gray-500">Loading...</div>
              ) : rows.length === 0 ? (
                <div className="py-6 text-sm text-gray-500">No data</div>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {rows.map((row, idx) => (
                    <li key={`${lb.key}-${idx}`} className="flex items-center justify-between py-2 text-sm">
                      <a
                        href={row.authorUrl}
                        className="text-blue-600 hover:underline"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {row.author}
                      </a>
                      <div className="flex flex-col items-end">
                        <span className="text-[11px] uppercase tracking-wide text-gray-500">{lb.metricLabel}</span>
                        <span className="font-semibold text-gray-900">
                          {lb.renderValue(row)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
