import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtractionResult } from "../src/core/extractor/index.js";
import { runSync, type SyncDeps } from "../src/core/pipeline.js";
import { openStateDb } from "../src/core/state/index.js";

let outDir: string;
beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), "vaultweave-pipe-ops-"));
});
afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

async function golden(): Promise<ExtractionResult> {
  const path = resolve(import.meta.dirname, "golden/docs-heavy.extraction.json");
  return JSON.parse(await readFile(path, "utf8")) as ExtractionResult;
}

const with_ = (e: ExtractionResult): SyncDeps => ({
  runExtract: () => ({ extract: async () => e }),
});
const TOMBSTONE = "vaultweave_tombstone: true";

async function without(e: ExtractionResult, title: string): Promise<ExtractionResult> {
  return { ...e, pages: e.pages.filter((p) => p.title !== title) };
}

describe("pipeline against real extraction data", () => {
  it("tracks every page and skips unchanged ones on the next run (regression: 0 were tracked)", async () => {
    const e = await golden();
    const r1 = await runSync({ token: "t", outDir, incremental: false }, with_(e));
    expect(r1.ok).toBe(true);
    expect(r1.counts).toMatchObject({ pagesLive: 8, pagesWritten: 8, pagesSkipped: 0 });
    const r2 = await runSync({ token: "t", outDir, incremental: true }, with_(e));
    expect(r2.counts).toMatchObject({ pagesWritten: 0, pagesSkipped: 8, pagesDeleted: 0 });
  });

  it("tombstones a page that really disappeared from a complete run", async () => {
    const e = await golden();
    await runSync({ token: "t", outDir }, with_(e));
    const r = await runSync({ token: "t", outDir }, with_(await without(e, "Shared orphan")));
    expect(r.counts.pagesDeleted).toBe(1);
    expect(await readFile(join(outDir, "Shared orphan.md"), "utf8")).toContain(TOMBSTONE);
  });

  it("preserves content and marks access lost for restricted_resource", async () => {
    const e = await golden();
    await runSync({ token: "t", outDir }, with_(e));
    const page = e.pages.find((p) => p.title === "Shared orphan");
    expect(page).toBeDefined();
    const restricted = {
      ...e,
      pages: e.pages.filter((p) => p.title !== "Shared orphan"),
      ok: false,
      errors: [
        {
          code: "page_failed",
          id: page?.id ?? "missing",
          message: "[restricted_resource] integration cannot access page",
        },
      ],
    };

    const r = await runSync({ token: "t", outDir }, with_(restricted));
    const after = await readFile(join(outDir, "Shared orphan.md"), "utf8");
    expect(r.ok).toBe(false);
    expect(after).toContain("vaultweave_access_lost: true");
    expect(after).toContain("vaultweave_access_lost_at:");
    expect(after).toContain("I am shared, but my parent is not\\.");
    expect(after).not.toContain(TOMBSTONE);

    const db = openStateDb(outDir);
    expect(db.getHash(page?.id ?? "missing")?.access_status).toBe("access_lost");
    db.close();
  });

  it("does NOT tombstone when the run failed (missing pages are not deletions)", async () => {
    const e = await golden();
    await runSync({ token: "t", outDir }, with_(e));
    const partial = {
      ...(await without(e, "Shared orphan")),
      ok: false,
      errors: [{ code: "page_failed", id: "x", message: "503" }],
    };
    const r = await runSync({ token: "t", outDir }, with_(partial));
    expect(r.ok).toBe(false);
    expect(r.counts.pagesDeleted).toBe(0);
    expect(await readFile(join(outDir, "Shared orphan.md"), "utf8")).not.toContain(TOMBSTONE);
    // …and the page stays tracked, so a later complete run can still detect a real deletion.
    const trackedDb = openStateDb(outDir);
    expect(trackedDb.getAllHashes().size).toBe(8);
    trackedDb.close();
  });

  it("does NOT tombstone when the run aborted", async () => {
    const e = await golden();
    await runSync({ token: "t", outDir }, with_(e));
    const aborted = {
      ...(await without(e, "Shared orphan")),
      ok: false,
      aborted: "Notion unreachable",
    };
    const r = await runSync({ token: "t", outDir }, with_(aborted));
    expect(r.counts.pagesDeleted).toBe(0);
    expect(await readFile(join(outDir, "Shared orphan.md"), "utf8")).not.toContain(TOMBSTONE);
  });

  it("does NOT tombstone when restricted to --root (the live set is deliberately partial)", async () => {
    const e = await golden();
    await runSync({ token: "t", outDir }, with_(e));
    const r = await runSync(
      { token: "t", outDir, roots: ["some-root-id"] },
      with_(await without(e, "Shared orphan")),
    );
    expect(r.counts.pagesDeleted).toBe(0);
    expect(await readFile(join(outDir, "Shared orphan.md"), "utf8")).not.toContain(TOMBSTONE);
  });

  it("advances the cursor only after a successful run", async () => {
    const e = await golden();
    const bad = { ...e, ok: false, errors: [{ code: "x", id: "y", message: "z" }] };
    const r1 = await runSync({ token: "t", outDir }, with_(bad));
    expect(r1.ok).toBe(false);
    let db = openStateDb(outDir);
    expect(db.getCursor("last_sync")).toBeUndefined();
    db.close();
    const r2 = await runSync({ token: "t", outDir }, with_(e));
    db = openStateDb(outDir);
    expect(db.getCursor("last_sync")).toBe(r2.startedAt);
    db.close();
  });

  it("a failed git commit fails the run (was: silently swallowed)", async () => {
    const e = await golden();
    const r = await runSync(
      { token: "t", outDir, git: true },
      {
        ...with_(e),
        runGitSync: async () => {
          throw new Error("git commit failed: pre-commit hook rejected");
        },
      },
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toContainEqual(expect.objectContaining({ code: "git_failed" }));
    expect(r.errors.find((i) => i.code === "git_failed")?.message).toContain("hook rejected");
    const db = openStateDb(outDir);
    expect(db.getCursor("last_sync")).toBeUndefined();
    db.close();
  });

  it("commits for real with git enabled and leaves state files out of history", async () => {
    const e = await golden();
    const r = await runSync({ token: "t", outDir, git: true }, with_(e));
    expect(r.ok).toBe(true);
    expect(r.gitCommit?.sha).toMatch(/^[0-9a-f]{40}$/);
    const { execFile } = await import("node:child_process");
    const tracked = await new Promise<string>((res, rej) =>
      execFile("git", ["ls-files"], { cwd: outDir }, (err, out) => (err ? rej(err) : res(out))),
    );
    expect(tracked).toContain("Engineering Handbook.md");
    expect(tracked).not.toContain("vaultweave.db");
    expect(tracked).not.toContain(".vaultweave-run-report.json");
    // Second identical run: no new commit.
    const r2 = await runSync({ token: "t", outDir, git: true }, with_(e));
    expect(r2.gitCommit).toBeUndefined();
    expect(r2.ok).toBe(true);
  });

  it("writes a versioned report atomically (no leftover .partial)", async () => {
    await runSync({ token: "t", outDir }, with_(await golden()));
    const report = JSON.parse(await readFile(join(outDir, ".vaultweave-run-report.json"), "utf8"));
    expect(report.schemaVersion).toBe(1);
    expect((await readdir(outDir)).filter((f) => f.endsWith(".partial"))).toEqual([]);
  });

  it("unexpected exceptions after extraction still yield a failed report and release the DB", async () => {
    const e = await golden();
    const r = await runSync(
      { token: "t", outDir },
      {
        ...with_(e),
        runWriteWorkspace: async () => {
          throw new Error("ENOSPC: no space left on device");
        },
      },
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: "pipeline_failed" });
    expect(r.errors[0]?.message).toContain("ENOSPC");
    const db = openStateDb(outDir); // would throw/lock if the previous handle leaked
    expect(db.getRecentOutcomes()[0]?.ok).toBe(false);
    db.close();
  });
});
