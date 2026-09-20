import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentHash, StateDb } from "../src/core/state/db.js";

let dir: string;
let db: StateDb;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vaultweave-state-test-"));
  db = new StateDb(join(dir, "vaultweave.db"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

// ── cursors ───────────────────────────────────────────────────────────────────

describe("cursors", () => {
  it("returns undefined for a missing key", () => {
    expect(db.getCursor("last_sync")).toBeUndefined();
  });

  it("round-trips a cursor value", () => {
    const ts = "2026-09-01T12:00:00.000Z";
    db.setCursor("last_sync", ts);
    expect(db.getCursor("last_sync")).toBe(ts);
  });

  it("overwrites an existing cursor", () => {
    db.setCursor("last_sync", "2026-01-01T00:00:00.000Z");
    db.setCursor("last_sync", "2026-09-20T00:00:00.000Z");
    expect(db.getCursor("last_sync")).toBe("2026-09-20T00:00:00.000Z");
  });
});

// ── page hashes ───────────────────────────────────────────────────────────────

describe("page hashes", () => {
  it("returns empty map when no hashes stored", () => {
    expect(db.getAllHashes().size).toBe(0);
  });

  it("setHash returns true on first write", () => {
    const changed = db.setHash("page-1", contentHash("hello"), "foo/bar.md");
    expect(changed).toBe(true);
  });

  it("setHash returns false when hash unchanged", () => {
    const hash = contentHash("hello");
    db.setHash("page-1", hash, "foo/bar.md");
    expect(db.setHash("page-1", hash, "foo/bar.md")).toBe(false);
  });

  it("setHash returns true when hash changes", () => {
    db.setHash("page-1", contentHash("hello"), "foo/bar.md");
    expect(db.setHash("page-1", contentHash("world"), "foo/bar.md")).toBe(true);
  });

  it("getAllHashes returns all stored records", () => {
    db.setHash("page-1", contentHash("a"), "a.md");
    db.setHash("page-2", contentHash("b"), "b.md");
    expect(db.getAllHashes().size).toBe(2);
  });

  it("findDeleted returns IDs not in the live set", () => {
    db.setHash("page-1", contentHash("a"), "a.md");
    db.setHash("page-2", contentHash("b"), "b.md");
    db.setHash("page-3", contentHash("c"), "c.md");

    const deleted = db.findDeleted(new Set(["page-1", "page-3"]));
    expect(deleted).toEqual(["page-2"]);
  });

  it("deleteHashes removes specified IDs", () => {
    db.setHash("page-1", contentHash("a"), "a.md");
    db.setHash("page-2", contentHash("b"), "b.md");
    db.deleteHashes(["page-1"]);
    expect(db.getAllHashes().has("page-1")).toBe(false);
    expect(db.getAllHashes().has("page-2")).toBe(true);
  });
});

// ── run reports ───────────────────────────────────────────────────────────────

describe("run reports", () => {
  it("saves and retrieves reports", () => {
    const report = {
      schemaVersion: 1 as const,
      startedAt: "2026-09-20T10:00:00.000Z",
      endedAt: "2026-09-20T10:00:05.000Z",
      durationMs: 5000,
      ok: true,
      incremental: false,
      incrementalExtraction: false,
      nextCursor: "2026-09-20T10:00:00.000Z",
      counts: {
        pagesLive: 10,
        pagesWritten: 8,
        pagesSkipped: 2,
        pagesUnchangedSkipped: 0,
        pagesDeleted: 0,
        databaseFilesWritten: 2,
        assetsDownloaded: 3,
        apiRequests: 50,
        apiRetries: 0,
        apiRateLimited: 0,
      },
      warnings: [],
      errors: [],
      outDir: "/tmp/vaultweave-test",
    };
    db.saveReport(report);
    const reports = db.getRecentReports(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.ok).toBe(true);
    expect(reports[0]?.counts.pagesLive).toBe(10);
  });

  it("returns reports newest-first", () => {
    for (let i = 0; i < 3; i++) {
      db.saveReport({
        schemaVersion: 1,
        startedAt: `2026-09-0${i + 1}T00:00:00.000Z`,
        endedAt: `2026-09-0${i + 1}T00:00:01.000Z`,
        durationMs: 1000,
        ok: true,
        incremental: false,
        incrementalExtraction: false,
        nextCursor: `2026-09-0${i + 1}T00:00:00.000Z`,
        counts: {
          pagesLive: i,
          pagesWritten: i,
          pagesSkipped: 0,
          pagesUnchangedSkipped: 0,
          pagesDeleted: 0,
          databaseFilesWritten: 0,
          assetsDownloaded: 0,
          apiRequests: 0,
          apiRetries: 0,
          apiRateLimited: 0,
        },
        warnings: [],
        errors: [],
        outDir: "/tmp",
      });
    }
    const reports = db.getRecentReports(3);
    expect(reports[0]?.startedAt).toBe("2026-09-03T00:00:00.000Z");
    expect(reports[2]?.startedAt).toBe("2026-09-01T00:00:00.000Z");
  });
});

// ── contentHash ───────────────────────────────────────────────────────────────

describe("contentHash", () => {
  it("produces a 64-char hex string", () => {
    expect(contentHash("hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
  });

  it("differs for different inputs", () => {
    expect(contentHash("hello")).not.toBe(contentHash("world"));
  });
});
