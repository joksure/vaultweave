import { exec as execCb } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitLog, gitSync } from "../src/targets/git.js";

const exec = promisify(execCb);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vaultweave-git-test-"));
  // Configure git identity for the test environment.
  await exec("git config user.email test@vaultweave.local", { cwd: dir }).catch(() => undefined);
  await exec("git config user.name vaultweave-test", { cwd: dir }).catch(() => undefined);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("gitSync", () => {
  it("initialises a repo and makes the first commit", async () => {
    await writeFile(join(dir, "page.md"), "# Hello\n");
    const result = await gitSync({
      outDir: dir,
      summary: "1 page",
      runTimestamp: "2026-09-20T10:00:00.000Z",
    });
    expect(result).not.toBeNull();
    expect(result?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result?.message).toContain("sync:");
    expect(result?.filesChanged).toBeGreaterThan(0);
  });

  it("returns null when there is nothing to commit", async () => {
    // First commit.
    await writeFile(join(dir, "page.md"), "# Hello\n");
    await gitSync({ outDir: dir, summary: "1 page", runTimestamp: "2026-09-20T10:00:00.000Z" });

    // Second sync — same content.
    const result = await gitSync({
      outDir: dir,
      summary: "1 page",
      runTimestamp: "2026-09-20T11:00:00.000Z",
    });
    expect(result).toBeNull();
  });

  it("commits changed files on a second run", async () => {
    await writeFile(join(dir, "page.md"), "# Hello\n");
    await gitSync({ outDir: dir, summary: "1 page", runTimestamp: "2026-09-20T10:00:00.000Z" });

    await writeFile(join(dir, "page.md"), "# Hello updated\n");
    const result = await gitSync({
      outDir: dir,
      summary: "1 page, 1 changed",
      runTimestamp: "2026-09-20T11:00:00.000Z",
    });
    expect(result).not.toBeNull();
    expect(result?.filesChanged).toBe(1);
  });

  it("writes a .gitignore that excludes vaultweave.db", async () => {
    await writeFile(join(dir, "page.md"), "# Hello\n");
    await gitSync({ outDir: dir, summary: "1 page", runTimestamp: "2026-09-20T10:00:00.000Z" });
    const gi = await readFile(join(dir, ".gitignore"), "utf8");
    expect(gi).toContain("vaultweave.db");
  });
});

describe("gitLog", () => {
  it("returns empty array for a non-repo directory", async () => {
    const nonRepo = await mkdtemp(join(tmpdir(), "vaultweave-git-log-"));
    try {
      const log = await gitLog(nonRepo, 5);
      expect(log).toEqual([]);
    } finally {
      await rm(nonRepo, { recursive: true, force: true });
    }
  });

  it("returns commit history newest-first", async () => {
    await writeFile(join(dir, "page.md"), "# v1\n");
    await gitSync({ outDir: dir, summary: "v1", runTimestamp: "2026-09-20T10:00:00.000Z" });
    await writeFile(join(dir, "page.md"), "# v2\n");
    await gitSync({ outDir: dir, summary: "v2", runTimestamp: "2026-09-20T11:00:00.000Z" });

    const log = await gitLog(dir, 10);
    expect(log.length).toBe(2);
    expect(log[0]?.subject).toContain("v2");
    expect(log[1]?.subject).toContain("v1");
  });
});
