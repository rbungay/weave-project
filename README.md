# Impact Dashboard

A lightweight analytics dashboard that measures GitHub contribution impact based on merged Pull Requests over rolling 30 / 60 / 90 day windows. It ingests raw GitHub PR data once, stores it locally in SQLite, derives structured contribution facts, and serves fast, read-only leaderboards without hitting the GitHub API on every request.

## Project Intent
Track who’s shipping what — fast, transparent, and comparable across 30/60/90-day windows.

## What This Project Does
The Impact Dashboard answers a simple question: **who is shipping what, and how much impact does it create?** It ranks contributors based on merged PR activity into a repository’s default branch using a transparent scoring model derived from PR title prefixes.

## How Impact Is Calculated
Impact is computed from merged Pull Requests using the first token of the PR title.

### Scoring Rubric

| PR Type Prefix | Points |
| --- | --- |
| feat | 3 |
| fix | 2 |
| chore | 1 |
| revert | 0.5 |
| other | 0.5 |

### Examples
- `feat(auth): add OAuth support` → 3 points  
- `fix(api): handle null case` → 2 points  
- `chore: bump dependency` → 1 point  

Authors ending with `[bot]` are excluded from rankings.

## Leaderboards (UI)
- **Top 5 Impact** (ranked by total points)
- **Fix Masters** (count of merged fixes)
- **What’s New?** (count of merged features)
- **Daily Chores** (count of merged chores)

## Architecture Overview
1. **Raw ingestion layer**  
   - Fetches merged PR data from GitHub API  
   - Stores raw JSON responses in SQLite  
   - Table: `api_raw_responses`
2. **Derived facts layer**  
   - Extracts PR fields, parses title prefixes, assigns points  
   - Table: `pr_facts`
3. **Aggregation layer**  
   - Computes per-author statistics by window  
   - Table: `author_stats`
4. **Read-only API layer**  
   - Serves leaderboard data instantly from SQLite (no GitHub calls)

## Installation
```bash
git clone https://github.com/YOUR_USERNAME/impact-dashboard.git
cd impact-dashboard
npm install
npm run dev
```
Open http://localhost:3000 in your browser.

## GitHub Token Setup
1. Create a Personal Access Token at https://github.com/settings/tokens (classic).  
2. Scopes: `public_repo` (or `repo` if private), optionally `read:org`.  
3. Create `.env.local` in the repo root:
```env
GITHUB_TOKEN=ghp_your_token_here
```
**Do not commit this file.**

## Syncing GitHub Data (manual refresh)
Before stats appear, run a refresh:
```bash
curl -X POST http://localhost:3000/api/github/impact-authors/refresh \
  -H "Content-Type: application/json" \
  -d '{"owner":"PostHog","repo":"posthog","days":90}'
```
This fetches merged PRs, stores raw data, derives facts, and computes author stats. Afterward, the dashboard is read-only and fast.

## Database
- File: `data/raw_api_data.db`
- Tables: `api_raw_responses`, `pr_facts`, `author_stats`

## Example Endpoints
- Read leaderboard (fast, read-only):  
  `GET /api/github/impact-authors?owner=PostHog&repo=posthog&days=90&rankBy=overall|feat|fix|chore`
- Recompute stats (heavy path):  
  `POST /api/github/impact-authors/refresh`

## Performance Model
- GitHub API is used only during manual refresh  
- Dashboard toggles (30/60/90) are read-only against SQLite  
- Bot accounts are excluded from rankings  

## Tech Stack
- Next.js (App Router)
- TypeScript
- SQLite (better-sqlite3)
- Server-only DB access
- REST-style internal API routes

## License
MIT
