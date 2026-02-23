import "server-only"; // Guard against client bundling; this module relies on Node APIs.

import Database, { type Database as BetterSqlite3Database } from "better-sqlite3";
import crypto from "crypto";
import { mkdirSync } from "fs";
import { dirname, join } from "path";

export const databasePath = join(process.cwd(), "data", "raw_api_data.db");

let db: BetterSqlite3Database | null = null;
let initialized = false;

export function getDbConnection(): BetterSqlite3Database {
  if (!db) {
    mkdirSync(dirname(databasePath), { recursive: true });
    db = new Database(databasePath);
  }
  return db;
}

function applyPragmas(connection: BetterSqlite3Database) {
  connection.pragma("journal_mode = WAL");
  connection.pragma("foreign_keys = ON");
  connection.pragma("synchronous = NORMAL");
}

function ensureSchema(connection: BetterSqlite3Database) {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS api_raw_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status_code INTEGER,
      payload TEXT NOT NULL,
      checksum TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_raw_responses_source ON api_raw_responses (source);
    CREATE INDEX IF NOT EXISTS idx_api_raw_responses_fetched_at ON api_raw_responses (fetched_at);

    CREATE TABLE IF NOT EXISTS pr_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      pr_url TEXT NOT NULL,
      merged_at TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      author_url TEXT NOT NULL,
      kind TEXT NOT NULL,
      points REAL NOT NULL,
      source_row_id INTEGER NOT NULL,
      fetched_at TEXT NOT NULL,
      UNIQUE(owner, repo, pr_url)
    );
    CREATE INDEX IF NOT EXISTS idx_pr_facts_owner_repo ON pr_facts (owner, repo);
    CREATE INDEX IF NOT EXISTS idx_pr_facts_merged_at ON pr_facts (merged_at);
    CREATE INDEX IF NOT EXISTS idx_pr_facts_owner_repo_merged_at ON pr_facts (owner, repo, merged_at);
    CREATE INDEX IF NOT EXISTS idx_pr_facts_owner_repo_author ON pr_facts (owner, repo, author);

    CREATE TABLE IF NOT EXISTS author_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      days INTEGER NOT NULL,
      since_iso TEXT NOT NULL,
      until_iso TEXT NOT NULL,
      author TEXT NOT NULL,
      author_url TEXT NOT NULL,
      total_score INTEGER NOT NULL,
      total_prs INTEGER NOT NULL,
      feat_count INTEGER NOT NULL,
      fix_count INTEGER NOT NULL,
      chore_count INTEGER NOT NULL,
      revert_count INTEGER NOT NULL,
      other_count INTEGER NOT NULL,
      computed_at TEXT NOT NULL,
      UNIQUE(owner, repo, days, author)
    );
    CREATE INDEX IF NOT EXISTS idx_author_stats_owner_repo_days ON author_stats (owner, repo, days);
  `);

  migratePrFactsPointsToReal(connection);
}

function migratePrFactsPointsToReal(connection: BetterSqlite3Database) {
  const tableExists = connection
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pr_facts'")
    .get() as { name?: string } | undefined;
  if (!tableExists?.name) return;

  const columns = connection.prepare("PRAGMA table_info(pr_facts)").all() as Array<{
    name: string;
    type: string;
  }>;
  const pointsCol = columns.find((c) => c.name === "points");
  if (!pointsCol || pointsCol.type.toUpperCase() === "REAL") {
    return; // already correct
  }

  connection.exec("BEGIN");
  try {
    connection.exec(`
      CREATE TABLE pr_facts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_url TEXT NOT NULL,
        merged_at TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        author_url TEXT NOT NULL,
        kind TEXT NOT NULL,
        points REAL NOT NULL,
        source_row_id INTEGER NOT NULL,
        fetched_at TEXT NOT NULL,
        UNIQUE(owner, repo, pr_url)
      );
    `);

    connection.exec(`
      INSERT INTO pr_facts_new (
        id, owner, repo, pr_url, merged_at, title, author, author_url, kind, points, source_row_id, fetched_at
      )
      SELECT
        id, owner, repo, pr_url, merged_at, title, author, author_url, kind,
        CAST(points AS REAL) AS points, source_row_id, fetched_at
      FROM pr_facts;
    `);

    connection.exec(`DROP TABLE pr_facts;`);
    connection.exec(`ALTER TABLE pr_facts_new RENAME TO pr_facts;`);
    connection.exec(`
      CREATE INDEX IF NOT EXISTS idx_pr_facts_owner_repo ON pr_facts (owner, repo);
      CREATE INDEX IF NOT EXISTS idx_pr_facts_merged_at ON pr_facts (merged_at);
    `);
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}

export function initDatabase(): void {
  if (initialized && db) {
    return;
  }
  const connection = getDbConnection();
  applyPragmas(connection);
  ensureSchema(connection);
  initialized = true;
}

type InsertParams = {
  source: string;
  endpoint: string;
  statusCode?: number | null;
  payload: unknown | string;
};

type InsertResult =
  | { inserted: true; id: number }
  | { inserted: false; skippedReason: string };

export function insertRawResponse(params: InsertParams): InsertResult {
  const { source, endpoint, statusCode = null, payload } = params;
  initDatabase();
  const connection = getDbConnection();

  const payloadString = typeof payload === "string" ? payload : JSON.stringify(payload);
  const checksum = crypto.createHash("sha256").update(payloadString).digest("hex");

  const dedupeStmt = connection.prepare(
    `SELECT id FROM api_raw_responses
     WHERE source = ? AND endpoint = ? AND checksum = ?
       AND fetched_at >= datetime('now', '-60 minutes')
     LIMIT 1`
  );
  const existing = dedupeStmt.get(source, endpoint, checksum);
  if (existing) {
    return { inserted: false, skippedReason: "duplicate within last 60 minutes" };
  }

  const insertStmt = connection.prepare(
    `INSERT INTO api_raw_responses (source, endpoint, status_code, payload, checksum)
     VALUES (?, ?, ?, ?, ?)`
  );
  const info = insertStmt.run(source, endpoint, statusCode, payloadString, checksum);

  return { inserted: true, id: Number(info.lastInsertRowid) };
}

type GetRecentParams = {
  source?: string;
  limit?: number;
};

export function getRecentResponses(params: GetRecentParams = {}) {
  const { source, limit = 10 } = params;
  initDatabase();
  const connection = getDbConnection();

  if (source) {
    const stmt = connection.prepare(
      `SELECT id, source, endpoint, fetched_at, status_code, checksum
       FROM api_raw_responses
       WHERE source = ?
       ORDER BY fetched_at DESC
       LIMIT ?`
    );
    return stmt.all(source, limit);
  }

  const stmt = connection.prepare(
    `SELECT id, source, endpoint, fetched_at, status_code, checksum
     FROM api_raw_responses
     ORDER BY fetched_at DESC
     LIMIT ?`
  );
  return stmt.all(limit);
}
