/**
 * SQLite state store for sheaf incremental sync.
 *
 * Persists:
 *   - `sync_state`  — last_sync cursor (ISO timestamp) per run target
 *   - `page_hashes` — SHA-256 of each page's last-rendered content (dedup writes)
 *   - `run_reports` — structured JSON reports for every completed run
 *
 * The file lives at `<outDir>/sheaf.db` (excluded from Git via .gitignore).
 * All writes are transactional; the file is never left half-written.
 *
 * We use `better-sqlite3` (sync API) rather than `bun:sqlite` so the same
 * code works under Node ≥22 and Bun without conditional imports.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { RunReport } from "./report.js";

// ── schema ────────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS page_hashes (
  page_id    TEXT PRIMARY KEY,
  hash       TEXT NOT NULL,
  path       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pages (
  page_id      TEXT PRIMARY KEY,
  hash         TEXT NOT NULL,
  path         TEXT NOT NULL,
  access_status TEXT NOT NULL DEFAULT 'ok' CHECK (access_status IN ('ok', 'deleted', 'access_lost')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS run_reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  ended_at   TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  report     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS run_reports_started_idx ON run_reports (started_at);
`;

/** How many run reports to keep in the state DB. */
const REPORT_RETENTION = 1000;

// ── types ─────────────────────────────────────────────────────────────────────

export type AccessStatus = "ok" | "deleted" | "access_lost";

export interface PageHashRecord {
  page_id: string;
  hash: string;
  path: string;
  access_status: AccessStatus;
  updated_at: string;
}

export interface SyncStateRecord {
  key: string;
  value: string;
  updated_at: string;
}

// ── helpers ───────────────────────────────────────────────────────────────────

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ── StateDb ───────────────────────────────────────────────────────────────────

export class StateDb {
  private readonly db: Database.Database;

  /**
   * `readonly` opens an existing DB without touching it (no schema creation, no WAL switch) —
   * used by `doctor`, which must never create state in a directory it is merely inspecting.
   */
  constructor(path: string, opts: { readonly?: boolean } = {}) {
    if (opts.readonly) {
      this.db = new Database(path, { readonly: true, fileMustExist: true });
      return;
    }
    this.db = new Database(path);
    // WAL mode: readers don't block writers during sync runs.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
    this.db.exec(
      "INSERT OR IGNORE INTO pages (page_id, hash, path) SELECT page_id, hash, path FROM page_hashes",
    );
  }

  // ── sync_state ─────────────────────────────────────────────────────────────

  /** Returns the stored cursor (ISO timestamp) for this target key, or undefined. */
  getCursor(key: string): string | undefined {
    const row = this.db
      .prepare<[string], SyncStateRecord>("SELECT * FROM sync_state WHERE key = ?")
      .get(key);
    return row?.value;
  }

  /** Upserts the cursor for this target key. */
  setCursor(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(key, value);
  }

  // ── page_hashes ────────────────────────────────────────────────────────────

  /** Returns all stored hashes, keyed by page_id. */
  getAllHashes(): Map<string, PageHashRecord> {
    const rows = this.db
      .prepare<[], PageHashRecord>(
        "SELECT h.page_id, h.hash, h.path, COALESCE(p.access_status, 'ok') AS access_status, h.updated_at " +
          "FROM page_hashes h LEFT JOIN pages p ON p.page_id = h.page_id",
      )
      .all();
    return new Map(rows.map((r) => [r.page_id, r]));
  }

  /** Returns the stored hash record for a single page. */
  getHash(pageId: string): PageHashRecord | undefined {
    return this.db
      .prepare<[string], PageHashRecord>(
        "SELECT h.page_id, h.hash, h.path, COALESCE(p.access_status, 'ok') AS access_status, h.updated_at " +
          "FROM page_hashes h LEFT JOIN pages p ON p.page_id = h.page_id WHERE h.page_id = ?",
      )
      .get(pageId);
  }

  /**
   * Upserts a page hash record.
   * Returns true if the hash changed (content is new/modified), false if unchanged.
   */
  /** Upserts a page hash record and access state. */
  setHash(pageId: string, hash: string, path: string, accessStatus: AccessStatus = "ok"): boolean {
    const existing = this.getHash(pageId);
    if (existing?.hash === hash && existing.access_status === accessStatus) return false;
    this.db
      .prepare(
        "INSERT INTO page_hashes (page_id, hash, path, updated_at) VALUES (?, ?, ?, datetime('now')) " +
          "ON CONFLICT(page_id) DO UPDATE SET hash = excluded.hash, path = excluded.path, updated_at = excluded.updated_at",
      )
      .run(pageId, hash, path);
    this.db
      .prepare(
        "INSERT INTO pages (page_id, hash, path, access_status, updated_at) VALUES (?, ?, ?, ?, datetime('now')) " +
          "ON CONFLICT(page_id) DO UPDATE SET hash = excluded.hash, path = excluded.path, access_status = excluded.access_status, updated_at = excluded.updated_at",
      )
      .run(pageId, hash, path, accessStatus);
    return true;
  }

  /** Updates access state without changing the stored content hash. */
  setAccessStatus(pageId: string, status: AccessStatus): void {
    this.db
      .prepare("UPDATE pages SET access_status = ?, updated_at = datetime('now') WHERE page_id = ?")
      .run(status, pageId);
  }

  /** Removes hash records for page IDs that no longer exist (tombstoning). */
  deleteHashes(pageIds: string[]): void {
    if (pageIds.length === 0) return;
    const placeholders = pageIds.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM page_hashes WHERE page_id IN (${placeholders})`).run(...pageIds);
  }

  /** Returns page IDs that are in the hash store but not in the live set (deleted pages). */
  findDeleted(livePageIds: Set<string>): string[] {
    const stored = this.db
      .prepare<[], { page_id: string }>("SELECT page_id FROM page_hashes")
      .all();
    return stored.map((r) => r.page_id).filter((id) => !livePageIds.has(id));
  }

  // ── run_reports ────────────────────────────────────────────────────────────

  saveReport(report: RunReport): void {
    this.db
      .prepare("INSERT INTO run_reports (started_at, ended_at, ok, report) VALUES (?, ?, ?, ?)")
      .run(report.startedAt, report.endedAt, report.ok ? 1 : 0, JSON.stringify(report));
    // An unattended daemon runs for years: keep the history bounded.
    this.db
      .prepare("DELETE FROM run_reports WHERE id <= (SELECT MAX(id) FROM run_reports) - ?")
      .run(REPORT_RETENTION);
  }

  /** Outcomes only (no JSON parsing), newest first — enough to compute failure streaks cheaply. */
  getRecentOutcomes(limit = 500): Array<{ startedAt: string; ok: boolean }> {
    return this.db
      .prepare<[number], { started_at: string; ok: number }>(
        "SELECT started_at, ok FROM run_reports ORDER BY id DESC LIMIT ?",
      )
      .all(limit)
      .map((r) => ({ startedAt: r.started_at, ok: r.ok === 1 }));
  }

  /** Start/end of the most recent fully successful run, if any. */
  getLastSuccess(): { startedAt: string; endedAt: string } | undefined {
    const row = this.db
      .prepare<[], { started_at: string; ended_at: string }>(
        "SELECT started_at, ended_at FROM run_reports WHERE ok = 1 ORDER BY id DESC LIMIT 1",
      )
      .get();
    return row ? { startedAt: row.started_at, endedAt: row.ended_at } : undefined;
  }

  /** Returns the N most recent run reports, newest first. */
  getRecentReports(limit = 10): RunReport[] {
    const rows = this.db
      .prepare<[number], { report: string }>(
        "SELECT report FROM run_reports ORDER BY id DESC LIMIT ?",
      )
      .all(limit);
    return rows.map((r) => JSON.parse(r.report) as RunReport);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}

/** Opens (creating if needed) the state DB at `<outDir>/sheaf.db`. */
export function openStateDb(outDir: string): StateDb {
  const path = `${outDir}/sheaf.db`;
  return new StateDb(path);
}

/** Opens an existing state DB read-only; `undefined` if there is none (or it is unreadable). */
export function openStateDbReadonly(outDir: string): StateDb | undefined {
  try {
    return new StateDb(join(outDir, "sheaf.db"), { readonly: true });
  } catch {
    return undefined;
  }
}
