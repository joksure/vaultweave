/**
 * Git sync target for vaultweave.
 *
 * Shells out to the user's real `git` binary so their credentials, GPG signing,
 * commit hooks, and `.gitconfig` all apply — no re-implementation of git logic.
 * Arguments are passed as an argv array (never through a shell), so commit messages
 * cannot be interpreted as shell syntax and quoting behaves the same on Windows.
 *
 * Behaviour:
 *   1. If `<outDir>` is not itself a git repo (no `.git` entry), `git init` it.
 *      A repo *containing* outDir is deliberately NOT adopted: `--git` must never
 *      silently commit into an unrelated parent repository.
 *   2. Make sure `.gitignore` excludes vaultweave's runtime files (state DB, lock, run
 *      report). This runs on every sync, including for pre-existing repos — otherwise
 *      the binary state DB would be committed into a repository the user cloned.
 *   3. Stage all changes (`git add -A`).
 *   4. If nothing is staged, skip the commit and return null.
 *   5. Commit with a conventional-commit message: `sync: <summary>`.
 *
 * Failures THROW (GitError). The pipeline turns them into a `git_failed` error in the
 * run report — a backup whose history was not recorded must not look successful (P4).
 */

import { execFile as execFileCb } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitCommitResult } from "../core/state/report.js";
import { FilesystemTarget } from "./filesystem.js";
import type { SyncTarget } from "./target.js";

const execFile = promisify(execFileCb);

/** Filesystem-backed Git target contract. Commit orchestration remains in `gitSync`. */
export class GitTarget implements SyncTarget {
  private readonly files: FilesystemTarget;

  constructor(root: string) {
    this.files = new FilesystemTarget(root);
  }

  write(path: string, content: Buffer | string): Promise<void> {
    return this.files.write(path, content);
  }

  delete(path: string): Promise<void> {
    return this.files.delete(path);
  }

  list(prefix?: string): Promise<string[]> {
    return this.files.list(prefix);
  }
}

export class GitError extends Error {
  override name = "GitError";
}

/** Runtime files that must never be committed into the backup history. */
export const GITIGNORE_ENTRIES = [
  "vaultweave.db",
  "vaultweave.db-shm",
  "vaultweave.db-wal",
  ".vaultweave.lock",
  ".vaultweave-run-report.json",
  ".vaultweave-extraction-cache.json",
  "*.partial",
  "assets/.partial/",
] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function git(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      throw new GitError("`git` was not found on PATH — install git or run without --git.");
    }
    const detail = (e.stderr ?? e.message).toString().trim();
    throw new GitError(`git ${args[0]} failed: ${detail}`);
  }
}

/** Appends any missing vaultweave entries to `.gitignore` (creating it if needed). */
export async function ensureGitignore(outDir: string): Promise<void> {
  const path = join(outDir, ".gitignore");
  const existing = (await exists(path)) ? await readFile(path, "utf8") : "";
  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_ENTRIES.filter((e) => !present.has(e));
  if (missing.length === 0) return;
  const prefix =
    existing === ""
      ? "# vaultweave runtime state — do not commit\n"
      : existing.endsWith("\n")
        ? "\n# vaultweave runtime state — do not commit\n"
        : "\n\n# vaultweave runtime state — do not commit\n";
  await writeFile(path, `${existing}${prefix}${missing.join("\n")}\n`, "utf8");
}

/**
 * Headless machines (containers, fresh CI runners) often have no git identity, which makes
 * `git commit` fail. Only when NONE is configured do we fall back to a neutral identity for
 * this single commit; a user's own configuration always wins.
 */
async function identityFallback(cwd: string): Promise<Record<string, string>> {
  const has = async (key: string) => {
    try {
      return (await git(["config", "--get", key], cwd)).stdout.trim() !== "";
    } catch {
      return false;
    }
  };
  const env: Record<string, string> = {};
  if (!(await has("user.name"))) {
    env.GIT_AUTHOR_NAME = "vaultweave";
    env.GIT_COMMITTER_NAME = "vaultweave";
  }
  if (!(await has("user.email"))) {
    env.GIT_AUTHOR_EMAIL = "vaultweave@users.noreply.github.com";
    env.GIT_COMMITTER_EMAIL = "vaultweave@users.noreply.github.com";
  }
  return env;
}

export interface GitSyncOptions {
  outDir: string;
  /** Conventional-commit summary, e.g. "42 pages, 3 changed, 1 deleted". */
  summary: string;
  /** ISO timestamp of the run (used in the commit message body). */
  runTimestamp: string;
}

/**
 * Stages all changes in `outDir` and commits them.
 * Returns the commit result, or null if there was nothing to commit.
 * Throws GitError on any git failure.
 */
export async function gitSync(opts: GitSyncOptions): Promise<GitCommitResult | null> {
  const { outDir, summary, runTimestamp } = opts;

  if (!(await exists(join(outDir, ".git")))) {
    await git(["init"], outDir);
  }
  await ensureGitignore(outDir);

  await git(["add", "-A"], outDir);

  const { stdout: statusOut } = await git(["status", "--porcelain"], outDir);
  const changed = statusOut.split("\n").filter((l) => l.trim() !== "");
  if (changed.length === 0) return null;

  const subject = `sync: ${summary}`;
  const body = `run: ${runTimestamp}\nfiles changed: ${changed.length}`;
  const env = await identityFallback(outDir);
  await git(["commit", "-m", subject, "-m", body], outDir, env);

  const { stdout: shaOut } = await git(["rev-parse", "HEAD"], outDir);
  return { sha: shaOut.trim(), message: subject, filesChanged: changed.length };
}

export interface GitLogEntry {
  sha: string;
  subject: string;
  date: string;
}

/**
 * Returns the N most recent commits in `outDir`, newest first.
 * Returns [] if the directory is not a git repo (or has no commits yet).
 */
export async function gitLog(outDir: string, limit = 10): Promise<GitLogEntry[]> {
  try {
    const { stdout } = await git(["log", "--pretty=format:%H|||%s|||%aI", `-${limit}`], outDir);
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, subject, date] = line.split("|||");
        return { sha: sha ?? "", subject: subject ?? "", date: date ?? "" };
      });
  } catch {
    return [];
  }
}
