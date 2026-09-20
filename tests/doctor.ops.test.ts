import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDoctorReport, type NotionLike, runDoctor } from "../src/core/doctor.js";
import { openStateDb } from "../src/core/state/index.js";
import { makeReport } from "./support/report.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vaultweave-doctor-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const base = { hasToken: true, nodeVersion: "22.1.0", now: () => NOW };

function client(over: Partial<NotionLike> = {}): NotionLike {
  return {
    users: { me: async () => ({ name: "Bot", bot: { workspace_name: "Acme" } }) },
    search: async () => ({ results: [{ id: "p1" }], has_more: false }),
    ...over,
  };
}

function seed(
  reports: Array<Parameters<typeof makeReport>[0]>,
  pages: Array<[string, string]> = [],
) {
  const db = openStateDb(dir);
  for (const r of reports) db.saveReport(makeReport(r));
  for (const [id, path] of pages) db.setHash(id, `hash-${id}`, path);
  db.close();
}

const find = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) =>
  r.checks.find((c) => c.id === id);

describe("doctor: last_run", () => {
  it("warns (does not fail) when nothing has run yet, and creates no state", async () => {
    const r = await runDoctor({ ...base, client: client(), outDir: dir });
    expect(find(r, "last_run")).toMatchObject({ ok: true, severity: "warn" });
    expect(r.ok).toBe(true);
    await expect(stat(join(dir, "vaultweave.db"))).rejects.toThrow(); // inspecting must not create files
  });

  it("passes on a fresh successful run", async () => {
    seed([{ startedAt: "2026-09-20T11:00:00.000Z", endedAt: "2026-09-20T11:00:10.000Z" }]);
    const r = await runDoctor({ ...base, client: client(), outDir: dir });
    expect(find(r, "last_run")).toMatchObject({ ok: true });
    expect(find(r, "last_run")?.message).toContain("Last successful sync");
  });

  it("fails on a failed last run and shows why", async () => {
    seed([{ ok: false, errors: [{ code: "e", id: "i", message: "token revoked" }] }]);
    const r = await runDoctor({ ...base, client: client(), outDir: dir });
    expect(find(r, "last_run")?.ok).toBe(false);
    expect(find(r, "last_run")?.message).toContain("token revoked");
    expect(r.ok).toBe(false);
  });

  it("flags a stale backup relative to the configured interval (dead-man's switch)", async () => {
    seed([{ startedAt: "2026-09-19T00:00:00.000Z", endedAt: "2026-09-19T00:00:10.000Z" }]);
    const stale = await runDoctor({
      ...base,
      client: client(),
      outDir: dir,
      intervalMs: 6 * 3_600_000,
    });
    expect(find(stale, "last_run")?.ok).toBe(false);
    expect(find(stale, "last_run")?.message).toContain("STALE");
    // Same age is fine when the interval is daily (2.5 × 1d > 36h).
    const fine = await runDoctor({
      ...base,
      client: client(),
      outDir: dir,
      intervalMs: 24 * 3_600_000,
    });
    expect(find(fine, "last_run")?.ok).toBe(true);
  });

  it("offline checks still run when the token is missing", async () => {
    seed([{ ok: false }]);
    const r = await runDoctor({
      hasToken: false,
      nodeVersion: "22.0.0",
      outDir: dir,
      now: () => NOW,
    });
    expect(r.checks.map((c) => c.id)).toEqual(["node", "token", "last_run"]);
  });
});

describe("doctor: scope", () => {
  const blocks = (fn: () => Promise<unknown>) => ({ children: { list: fn } });

  it("passes when page content is readable", async () => {
    const r = await runDoctor({ ...base, client: client({ blocks: blocks(async () => ({})) }) });
    expect(find(r, "scope")).toMatchObject({ ok: true });
    expect(find(r, "auth")?.message).toContain('in workspace "Acme"');
  });

  it("fails with an actionable message when 'Read content' is missing", async () => {
    const r = await runDoctor({
      ...base,
      client: client({
        blocks: blocks(async () => {
          throw Object.assign(new Error("restricted"), { code: "restricted_resource" });
        }),
      }),
    });
    expect(find(r, "scope")?.ok).toBe(false);
    expect(find(r, "scope")?.message).toContain("Read content");
  });

  it("is skipped when there is no sample page or no blocks API", async () => {
    const r = await runDoctor({
      ...base,
      client: client({
        search: async () => ({ results: [], has_more: false }),
        blocks: blocks(async () => ({})),
      }),
    });
    expect(find(r, "scope")).toBeUndefined();
  });
});

describe("doctor: git", () => {
  const ok = async (args: string[]) =>
    args[0] === "--version" ? "git version 2.45.0\n" : args[0] === "config" ? "x\n" : "";

  it("passes with git and identity", async () => {
    const r = await runDoctor({ ...base, client: client(), outDir: dir, useGit: true, runGit: ok });
    expect(find(r, "git")).toMatchObject({ ok: true });
    expect(find(r, "git")?.severity).toBeUndefined();
  });

  it("fails when git is missing", async () => {
    const r = await runDoctor({
      ...base,
      client: client(),
      outDir: dir,
      useGit: true,
      runGit: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(find(r, "git")?.ok).toBe(false);
  });

  it("only warns about a missing identity (vaultweave has a fallback)", async () => {
    const r = await runDoctor({
      ...base,
      client: client(),
      outDir: dir,
      useGit: true,
      runGit: async (args) => (args[0] === "--version" ? "git version 2\n" : ""),
    });
    expect(find(r, "git")).toMatchObject({ ok: true, severity: "warn" });
  });

  it("is not run unless git is enabled", async () => {
    const r = await runDoctor({ ...base, client: client(), outDir: dir, runGit: ok });
    expect(find(r, "git")).toBeUndefined();
  });
});

describe("doctor: assets", () => {
  it("flags downloads stuck for more than 24h", async () => {
    const partial = join(dir, "assets", ".partial");
    await mkdir(partial, { recursive: true });
    const f = join(partial, "abc");
    await writeFile(f, "x");
    const old = new Date(NOW - 48 * 3_600_000);
    await utimes(f, old, old);
    const r = await runDoctor({ ...base, client: client(), outDir: dir });
    expect(find(r, "assets")?.ok).toBe(false);
    expect(find(r, "assets")?.message).toContain("stuck");
  });

  it("does not flag a recent, resumable partial", async () => {
    const partial = join(dir, "assets", ".partial");
    await mkdir(partial, { recursive: true });
    const f = join(partial, "abc");
    await writeFile(f, "x");
    await utimes(f, new Date(NOW - 1000), new Date(NOW - 1000));
    const r = await runDoctor({ ...base, client: client(), outDir: dir });
    expect(find(r, "assets")?.ok).toBe(true);
  });

  it("--deep finds references to assets that are missing on disk, and accepts present ones", async () => {
    await mkdir(join(dir, "assets"), { recursive: true });
    await mkdir(join(dir, "Docs"), { recursive: true });
    await writeFile(join(dir, "assets", "here.png"), "x");
    await writeFile(
      join(dir, "Docs", "Page.md"),
      "![a](../assets/here.png)\n![b](../assets/gone.png)\n[web](https://example.com/assets/x.png)\n",
    );
    const r = await runDoctor({ ...base, client: client(), outDir: dir, deep: true });
    const a = find(r, "assets");
    expect(a?.ok).toBe(false);
    expect(a?.message).toContain("1 referenced asset(s) missing");
    expect(a?.message).toContain("gone.png");
    expect(a?.message).not.toContain("here.png");
  });
});

describe("doctor: coverage (--deep)", () => {
  const pages: Array<[string, string]> = [
    ["aaaaaaaa-0000-4000-8000-000000000001", "A.md"],
    ["aaaaaaaa-0000-4000-8000-000000000002", "B.md"],
    ["aaaaaaaa-0000-4000-8000-000000000003", "C.md"],
    ["aaaaaaaa-0000-4000-8000-000000000004", "D.md"],
    ["aaaaaaaa-0000-4000-8000-000000000005", "E.md"],
    ["aaaaaaaa-0000-4000-8000-000000000006", "F.md"],
  ];
  const visible = (ids: string[]) =>
    client({ search: async () => ({ results: ids.map((id) => ({ id })), has_more: false }) });

  it("is silent without --deep", async () => {
    seed([{}], pages);
    const r = await runDoctor({ ...base, client: visible([]), outDir: dir });
    expect(find(r, "coverage")).toBeUndefined();
  });

  it("passes when everything is still reachable (ids compared without dashes/case)", async () => {
    seed([{}], pages);
    const ids = pages.map(([id]) => id.replaceAll("-", "").toUpperCase());
    const r = await runDoctor({ ...base, client: visible(ids), outDir: dir, deep: true });
    expect(find(r, "coverage")).toMatchObject({ ok: true });
    expect(find(r, "coverage")?.severity).toBeUndefined();
  });

  it("warns about a few missing pages but does not fail", async () => {
    seed([{}], pages);
    const r = await runDoctor({
      ...base,
      client: visible(pages.slice(1).map(([id]) => id)),
      outDir: dir,
      deep: true,
    });
    const c = find(r, "coverage");
    expect(c).toMatchObject({ ok: true, severity: "warn" });
    expect(c?.message).toContain("1 of 6");
    expect(c?.message).toContain("A.md");
    expect(r.ok).toBe(true);
  });

  it("fails loudly when most of the backup vanished (lost access)", async () => {
    seed([{}], pages);
    const r = await runDoctor({
      ...base,
      client: visible([pages[0]?.[0] as string]),
      outDir: dir,
      deep: true,
    });
    const c = find(r, "coverage");
    expect(c?.ok).toBe(false);
    expect(c?.message).toContain("lost access");
    expect(c?.message).toContain("BEFORE the next sync");
  });

  it("follows search pagination", async () => {
    seed([{}], pages);
    const cursors: Array<string | undefined> = [];
    const paged = client({
      search: async ({ start_cursor }) => {
        cursors.push(start_cursor);
        return start_cursor
          ? { results: pages.slice(3).map(([id]) => ({ id })), has_more: false }
          : {
              results: pages.slice(0, 3).map(([id]) => ({ id })),
              has_more: true,
              next_cursor: "c2",
            };
      },
    });
    const r = await runDoctor({ ...base, client: paged, outDir: dir, deep: true });
    expect(cursors).toEqual([undefined, undefined, "c2"]); // 1st = reachable check, then 2 pages
    expect(find(r, "coverage")).toMatchObject({ ok: true });
  });

  it("degrades to a warning on huge workspaces instead of hammering the API", async () => {
    seed([{}], pages);
    const endless = client({
      search: async () => ({ results: [{ id: "zzz" }], has_more: true, next_cursor: "more" }),
    });
    const r = await runDoctor({
      ...base,
      client: endless,
      outDir: dir,
      deep: true,
      maxSearchPages: 3,
    });
    expect(find(r, "coverage")).toMatchObject({ ok: true, severity: "warn" });
  });
});

describe("formatDoctorReport", () => {
  it("marks warnings distinctly and counts them", async () => {
    const r = await runDoctor({ ...base, client: client(), outDir: dir });
    const text = formatDoctorReport(r);
    expect(text).toContain("⚠ No run recorded");
    expect(text).toContain("All checks passed (1 warning(s)).");
  });
});
