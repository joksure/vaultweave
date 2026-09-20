import { execFile as execFileCb } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureGitignore, GITIGNORE_ENTRIES, GitError, gitSync } from "../src/targets/git.js";

const execFile = promisify(execFileCb);
const git = (args: string[], cwd: string) =>
  execFile("git", args, { cwd }).then((r) => r.stdout.trim());

let dir: string;
const saved = { ...process.env };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vaultweave-git-ops-"));
});
afterEach(async () => {
  process.env = { ...saved };
  await rm(dir, { recursive: true, force: true });
});

const opts = () => ({ outDir: dir, summary: "1 page", runTimestamp: "2026-09-20T10:00:00.000Z" });

/** A git that knows nobody: no global/system config, so no identity. */
function isolateGitConfig() {
  process.env.GIT_CONFIG_GLOBAL = join(dir, "..", "nonexistent-gitconfig");
  process.env.GIT_CONFIG_SYSTEM = join(dir, "..", "nonexistent-gitconfig");
  process.env.HOME = dir;
  process.env.XDG_CONFIG_HOME = dir;
  for (const k of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ]) {
    delete process.env[k];
  }
}

describe("gitSync (M4 hardening)", () => {
  it("adds vaultweave's ignore entries even to a repository that already existed", async () => {
    await git(["init"], dir);
    await git(["config", "user.email", "a@b.c"], dir);
    await git(["config", "user.name", "a"], dir);
    await writeFile(join(dir, ".gitignore"), "node_modules/");
    await writeFile(join(dir, "page.md"), "# hi\n");
    await writeFile(join(dir, "vaultweave.db"), "binary");
    await writeFile(join(dir, ".vaultweave.lock"), "{}");
    await writeFile(join(dir, ".vaultweave-run-report.json"), "{}");
    await gitSync(opts());
    const tracked = (await git(["ls-files"], dir)).split("\n");
    expect(tracked).toContain("page.md");
    expect(tracked).not.toContain("vaultweave.db");
    expect(tracked).not.toContain(".vaultweave.lock");
    expect(tracked).not.toContain(".vaultweave-run-report.json");
    const gi = await readFile(join(dir, ".gitignore"), "utf8");
    expect(gi).toContain("node_modules/"); // the user's own entries are preserved
  });

  it("ensureGitignore is idempotent", async () => {
    await ensureGitignore(dir);
    const once = await readFile(join(dir, ".gitignore"), "utf8");
    await ensureGitignore(dir);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(once);
    for (const e of GITIGNORE_ENTRIES) expect(once).toContain(e);
  });

  it("treats shell metacharacters in the summary literally", async () => {
    await writeFile(join(dir, "page.md"), "x");
    const nasty = "$(touch pwned) `touch pwned2` \"quoted\" 'single' ; echo hi";
    await gitSync({ ...opts(), summary: nasty });
    expect(await git(["log", "-1", "--format=%s"], dir)).toBe(`sync: ${nasty}`);
    await expect(readFile(join(dir, "pwned"))).rejects.toThrow();
    await expect(readFile(join(dir, "pwned2"))).rejects.toThrow();
  });

  it("falls back to a neutral identity when none is configured", async () => {
    isolateGitConfig();
    await writeFile(join(dir, "page.md"), "x");
    const r = await gitSync(opts());
    expect(r?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(["log", "-1", "--format=%an <%ae>"], dir)).toBe(
      "vaultweave <vaultweave@users.noreply.github.com>",
    );
  });

  it("never overrides a configured identity", async () => {
    isolateGitConfig();
    await git(["init"], dir);
    await git(["config", "user.name", "Real Person"], dir);
    await git(["config", "user.email", "real@example.com"], dir);
    await writeFile(join(dir, "page.md"), "x");
    await gitSync(opts());
    expect(await git(["log", "-1", "--format=%an <%ae>"], dir)).toBe(
      "Real Person <real@example.com>",
    );
  });

  it("does not adopt a parent repository", async () => {
    await git(["init"], dir);
    const sub = join(dir, "backup");
    await mkdir(sub);
    await writeFile(join(sub, "page.md"), "x");
    isolateGitConfig();
    await gitSync({ ...opts(), outDir: sub });
    expect((await git(["rev-parse", "--show-toplevel"], sub)).endsWith("backup")).toBe(true);
    expect(await git(["status", "--porcelain"], dir)).toContain("backup"); // parent saw nothing committed
  });

  it("throws GitError (instead of silently succeeding) when a commit hook rejects", async () => {
    if (process.platform === "win32") return;
    await git(["init"], dir);
    await git(["config", "user.email", "a@b.c"], dir);
    await git(["config", "user.name", "a"], dir);
    const hook = join(dir, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\necho 'policy says no' >&2\nexit 1\n");
    await chmod(hook, 0o755);
    await writeFile(join(dir, "page.md"), "x");
    const err = await gitSync(opts()).catch((e) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(err.message).toContain("policy says no");
  });
});
