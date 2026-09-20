import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedSettings } from "../src/cli/settings.js";
import { syncOptionsFrom } from "../src/cli/sync.js";
import type { ExtractionResult } from "../src/core/extractor/index.js";
import { runSync, type SyncDeps } from "../src/core/pipeline.js";
import { StateDb } from "../src/core/state/db.js";

// ── test helpers ──────────────────────────────────────────────────────────────

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), "sheaf-pipeline-test-"));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

function makeMinimalExtraction(): ExtractionResult {
  return {
    pages: [],
    databases: [],
    assets: [],
    warnings: [],
    errors: [],
    ok: true,
    stats: {
      requests: 5,
      retries: 0,
      rateLimited: 0,
      failures: 0,
      counts: {
        pages: 0,
        databases: 0,
        dataSources: 0,
        rows: 0,
        blocks: 0,
        views: 0,
        assets: 0,
      },
      assetsDownloaded: 0,
      assetBytes: 0,
      assetUrlRefreshes: 0,
    },
  };
}

function makeDeps(overrides: Partial<SyncDeps> = {}): SyncDeps {
  return {
    runExtract: () => ({
      extract: async () => makeMinimalExtraction(),
    }),
    runWriteWorkspace: async (_ws, _opts) => ({
      pagePaths: {},
      filesWritten: [],
      errors: [],
    }),
    runGitSync: async () => null,
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("runSync", () => {
  it("produces an ok report for a clean empty extraction", async () => {
    const report = await runSync({ token: "test-token", outDir, incremental: false }, makeDeps());
    expect(report.ok).toBe(true);
    expect(report.counts.pagesLive).toBe(0);
  });

  it("stores a cursor in the state DB after the first run", async () => {
    await runSync({ token: "test-token", outDir, incremental: false }, makeDeps());
    const db = new StateDb(join(outDir, "sheaf.db"));
    const cursor = db.getCursor("last_sync");
    db.close();
    expect(cursor).toBeDefined();
    expect(cursor).toMatch(/^\d{4}-/); // ISO timestamp
  });

  it("uses the stored cursor on the second run", async () => {
    let _capturedRoots: readonly string[] | undefined;
    const deps = makeDeps({
      runExtract: () => ({
        extract: async (opts) => {
          _capturedRoots = opts.roots;
          return makeMinimalExtraction();
        },
      }),
    });

    // First run stores cursor.
    await runSync({ token: "test-token", outDir, incremental: true }, deps);
    // Second run — incremental flag is on.
    await runSync({ token: "test-token", outDir, incremental: true }, deps);

    // The second report should be marked incremental.
    const db = new StateDb(join(outDir, "sheaf.db"));
    const reports = db.getRecentReports(2);
    db.close();
    // Most recent (index 0) should be incremental.
    expect(reports[0]?.incremental).toBe(true);
  });

  it("writes .sheaf-run-report.json to outDir", async () => {
    await runSync({ token: "test-token", outDir, incremental: false }, makeDeps());
    const raw = await readFile(join(outDir, ".sheaf-run-report.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty("ok", true);
    expect(parsed).toHaveProperty("startedAt");
    expect(parsed).toHaveProperty("counts");
  });

  it("records git commit result when git is enabled and commit succeeds", async () => {
    const deps = makeDeps({
      runGitSync: async () => ({
        sha: `abc123def456${"0".repeat(28)}`,
        message: "sync: 0 pages",
        filesChanged: 1,
      }),
    });
    const report = await runSync(
      { token: "test-token", outDir, incremental: false, git: true },
      deps,
    );
    expect(report.gitCommit).toBeDefined();
    expect(report.gitCommit?.filesChanged).toBe(1);
  });

  it("marks report as failed if extraction returns ok=false", async () => {
    const deps = makeDeps({
      runExtract: () => ({
        extract: async () => ({
          ...makeMinimalExtraction(),
          ok: false,
          errors: [{ code: "page_failed", id: "abc", message: "not found" }],
        }),
      }),
    });
    const report = await runSync({ token: "test-token", outDir, incremental: false }, deps);
    expect(report.ok).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it("handles extraction fatal throw gracefully", async () => {
    const deps = makeDeps({
      runExtract: () => ({
        extract: async () => {
          throw new Error("unauthorized");
        },
      }),
    });
    const report = await runSync({ token: "bad-token", outDir, incremental: false }, deps);
    expect(report.ok).toBe(false);
    expect(report.aborted).toContain("unauthorized");
  });

  it("passes sinceTimestamp to the extractor", async () => {
    const seen: Array<string | undefined> = [];
    const deps = makeDeps({
      runExtract: () => ({
        extract: async (opts) => {
          seen.push(opts.sinceTimestamp);
          return makeMinimalExtraction();
        },
      }),
    });

    await runSync(
      { token: "t", outDir, incremental: true, sinceOverride: "2020-01-01T00:00:00.000Z" },
      deps,
    );
    await runSync({ token: "t", outDir, incremental: false }, deps);

    // The extractor must be told *when* to filter, not just that the run is incremental.
    expect(seen).toEqual(["2020-01-01T00:00:00.000Z", undefined]);
  });

  it("does not let --full suppress an explicit --since", async () => {
    const seen: Array<string | undefined> = [];
    const deps = makeDeps({
      runExtract: () => ({
        extract: async (opts) => {
          seen.push(opts.sinceTimestamp);
          return makeMinimalExtraction();
        },
      }),
    });
    const settings = {
      token: "test-token",
      outDir,
      useGit: false,
      rowBodies: true,
      quiet: true,
    } as unknown as ResolvedSettings;

    await runSync(
      syncOptionsFrom(settings, { since: "2026-09-01T00:00:00.000Z", full: true }),
      deps,
    );
    await runSync(syncOptionsFrom(settings, { full: true }), deps);
    expect(seen).toEqual(["2026-09-01T00:00:00.000Z", undefined]);
  });
});
