import { execFile as execFileCb } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { formatDuration } from "./duration.js";
import { TokenBucket } from "./ratelimit.js";
import { openStateDbReadonly } from "./state/index.js";

const execFile = promisify(execFileCb);

/** The tiny slice of the Notion client that `doctor` needs (keeps it testable offline). */
export interface NotionLike {
  users: { me(args: Record<string, never>): Promise<unknown> };
  search(args: {
    page_size?: number;
    start_cursor?: string;
  }): Promise<{ results: unknown[]; has_more: boolean; next_cursor?: string | null }>;
  /** Optional: enables the "can this token actually read page content?" probe. */
  blocks?: { children: { list(args: { block_id: string; page_size?: number }): Promise<unknown> } };
}

export type DoctorCheckId =
  | "node"
  | "token"
  | "auth"
  | "reachable"
  | "scope"
  | "rate_limit"
  | "last_run"
  | "git"
  | "assets"
  | "coverage";

export interface DoctorCheck {
  id: DoctorCheckId;
  /** `false` fails the doctor run (exit code 1). */
  ok: boolean;
  /** With `ok: true`: something worth a look, but not a failure. */
  severity?: "warn";
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  hasToken: boolean;
  client?: NotionLike;
  /** Fire a short burst of requests at our pacing rate and look for 429s. */
  probeRateLimit?: boolean;
  nodeVersion?: string;
  limiter?: TokenBucket;
  probeRequests?: number;
  /** Backup directory: enables the offline checks (last run, git, assets). */
  outDir?: string;
  /** Also validate git (`--git` / `git: true`). */
  useGit?: boolean;
  /** The configured watch interval; a backup older than 2.5× it counts as stale. */
  intervalMs?: number;
  /** Costly checks: walk the whole workspace via search and scan output files. */
  deep?: boolean;
  maxSearchPages?: number;
  now?: () => number;
  /** Injectable for tests: runs `git <args>` in `cwd` and returns stdout. */
  runGit?: (args: string[], cwd: string) => Promise<string>;
}

const MIN_NODE_MAJOR = 22;

function isRateLimited(err: unknown): boolean {
  const e = err as { code?: string; status?: number } | undefined;
  return e?.code === "rate_limited" || e?.status === 429;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const normId = (id: string) => id.replaceAll("-", "").toLowerCase();

function errorCode(err: unknown): string | undefined {
  return (err as { code?: string } | undefined)?.code;
}

function idOf(result: unknown): string | undefined {
  const id = (result as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : undefined;
}

async function defaultRunGit(args: string[], cwd: string): Promise<string> {
  return (await execFile("git", args, { cwd })).stdout;
}

// ── individual checks ─────────────────────────────────────────────────────────

/**
 * Token scope. The Notion API does not expose an integration's capability list, so we PROBE:
 * reading a page's blocks fails with `restricted_resource` when "Read content" is missing.
 * (Seeing pages in search is not enough — search works without content access.)
 */
async function checkScope(
  client: NotionLike,
  sample: string | undefined,
): Promise<DoctorCheck | undefined> {
  if (!client.blocks || !sample) return undefined;
  try {
    await client.blocks.children.list({ block_id: sample, page_size: 1 });
    return { id: "scope", ok: true, message: "Token can read page content" };
  } catch (err) {
    if (errorCode(err) === "restricted_resource") {
      return {
        id: "scope",
        ok: false,
        message:
          'The integration cannot read page content. In notion.so/profile/integrations enable the "Read content" capability.',
      };
    }
    return { id: "scope", ok: false, message: `Content probe failed: ${describe(err)}` };
  }
}

function checkLastRun(opts: DoctorOptions): DoctorCheck {
  const outDir = opts.outDir as string;
  const now = (opts.now ?? Date.now)();
  const db = openStateDbReadonly(outDir);
  if (!db) {
    return {
      id: "last_run",
      ok: true,
      severity: "warn",
      message: `No run recorded in ${outDir} yet — run \`vaultweave sync\` first`,
    };
  }
  try {
    const last = db.getRecentReports(1)[0];
    const lastOk = db.getLastSuccess();
    if (!last) {
      return {
        id: "last_run",
        ok: true,
        severity: "warn",
        message: "State DB exists but no run is recorded",
      };
    }
    if (!last.ok) {
      const why = last.aborted ?? last.errors[0]?.message ?? "see .vaultweave-run-report.json";
      return {
        id: "last_run",
        ok: false,
        message: `The last run FAILED (${last.startedAt}): ${why.slice(0, 200)}`,
      };
    }
    const staleAfter = opts.intervalMs ? opts.intervalMs * 2.5 : 48 * 3_600_000;
    const age = now - Date.parse(lastOk?.endedAt ?? last.endedAt);
    if (age > staleAfter) {
      return {
        id: "last_run",
        ok: false,
        message:
          `Backup is STALE: last successful sync ended ${formatDuration(age)} ago ` +
          `(expected within ${formatDuration(staleAfter)}). Is the scheduler still running?`,
      };
    }
    return { id: "last_run", ok: true, message: `Last successful sync ${formatDuration(age)} ago` };
  } finally {
    db.close();
  }
}

async function checkGit(opts: DoctorOptions): Promise<DoctorCheck> {
  const outDir = opts.outDir as string;
  const runGit = opts.runGit ?? defaultRunGit;
  const cwd = (await exists(outDir)) ? outDir : process.cwd();
  let version: string;
  try {
    version = (await runGit(["--version"], cwd)).trim();
  } catch {
    return {
      id: "git",
      ok: false,
      message: "`git` is not on PATH — every `--git` run would fail.",
    };
  }
  const repo = await exists(join(outDir, ".git"));
  let identity = true;
  for (const key of ["user.name", "user.email"]) {
    try {
      if ((await runGit(["config", "--get", key], cwd)).trim() === "") identity = false;
    } catch {
      identity = false;
    }
  }
  const parts = [
    version,
    repo ? "repository initialised" : "repository will be created on the first sync",
    identity
      ? "identity configured"
      : 'no git identity configured (commits will be authored as "vaultweave")',
  ];
  return {
    id: "git",
    ok: true,
    severity: identity ? undefined : "warn",
    message: parts.join("; "),
  };
}

const STALE_PARTIAL_MS = 24 * 3_600_000;
const MAX_MD_FILES = 50_000;
const LINK = /\]\(([^)\s]+)\)/g;

async function* walkMarkdown(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkMarkdown(full);
    else if (e.name.endsWith(".md")) yield full;
  }
}

async function checkAssets(opts: DoctorOptions): Promise<DoctorCheck | undefined> {
  const outDir = opts.outDir as string;
  if (!(await exists(outDir))) return undefined;
  const now = (opts.now ?? Date.now)();
  const problems: string[] = [];

  // Downloads that started but never finished (resumable partials are normal for hours, not days).
  const partialDir = join(outDir, "assets", ".partial");
  const partials = await readdir(partialDir).catch(() => [] as string[]);
  let stale = 0;
  for (const f of partials) {
    const st = await stat(join(partialDir, f)).catch(() => undefined);
    if (st && now - st.mtimeMs > STALE_PARTIAL_MS) stale++;
  }
  if (stale > 0) problems.push(`${stale} asset download(s) stuck for over 24h (assets/.partial)`);

  // Deep: pages that reference an asset file that is not on disk.
  let scanned = 0;
  if (opts.deep) {
    const missing: string[] = [];
    for await (const file of walkMarkdown(outDir)) {
      if (++scanned > MAX_MD_FILES) break;
      const text = await readFile(file, "utf8").catch(() => "");
      for (const m of text.matchAll(LINK)) {
        const target = decodeURI(m[1] ?? "");
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || !target.includes("assets/")) continue;
        const abs = resolve(dirname(file), target.split("#")[0] ?? target);
        if (!(await exists(abs))) missing.push(target);
      }
    }
    if (missing.length > 0) {
      problems.push(
        `${missing.length} referenced asset(s) missing on disk (e.g. ${missing.slice(0, 3).join(", ")}) — re-run \`vaultweave sync --full\``,
      );
    }
  }

  if (problems.length > 0) return { id: "assets", ok: false, message: problems.join("; ") };
  if (!opts.deep && partials.length === 0) return undefined; // nothing to say
  return {
    id: "assets",
    ok: true,
    message: opts.deep
      ? `Assets consistent (${scanned} Markdown files scanned)`
      : "No stuck asset downloads",
  };
}

/**
 * "Missing pages": pages we backed up earlier that search no longer returns. That is either a
 * genuine deletion OR the integration losing access. The sync now preserves the previous file for
 * `restricted_resource` failures and marks it with `vaultweave_access_lost`, while true absence still
 * becomes a tombstone. This check warns about both possibilities before the next sync.
 */
async function checkCoverage(
  client: NotionLike,
  opts: DoctorOptions,
): Promise<DoctorCheck | undefined> {
  const db = openStateDbReadonly(opts.outDir as string);
  if (!db) return undefined;
  let tracked: Map<string, string>;
  try {
    tracked = new Map([...db.getAllHashes()].map(([id, rec]) => [normId(id), rec.path]));
  } finally {
    db.close();
  }
  if (tracked.size === 0) return undefined;

  const seen = new Set<string>();
  const maxPages = opts.maxSearchPages ?? 50;
  let cursor: string | undefined;
  let truncated = false;
  try {
    for (let n = 0; ; n++) {
      if (n >= maxPages) {
        truncated = true;
        break;
      }
      const res = await client.search({ page_size: 100, start_cursor: cursor });
      for (const r of res.results) {
        const id = idOf(r);
        if (id) seen.add(normId(id));
      }
      if (!res.has_more || !res.next_cursor) break;
      cursor = res.next_cursor;
    }
  } catch (err) {
    return { id: "coverage", ok: false, message: `Coverage check failed: ${describe(err)}` };
  }
  if (truncated) {
    return {
      id: "coverage",
      ok: true,
      severity: "warn",
      message: `Workspace too large for a full coverage check (stopped after ${maxPages} search pages)`,
    };
  }

  const missing = [...tracked].filter(([id]) => !seen.has(id));
  if (missing.length === 0) {
    return {
      id: "coverage",
      ok: true,
      message: `All ${tracked.size} backed-up page(s) are still reachable`,
    };
  }
  const sample = missing
    .slice(0, 5)
    .map(([, path]) => path)
    .join(", ");
  const share = missing.length / tracked.size;
  // Most of the workspace vanishing at once is not "some deletions" — it is lost access.
  const lostAccess = tracked.size >= 5 && share >= 0.5;
  return {
    id: "coverage",
    ok: !lostAccess,
    severity: lostAccess ? undefined : "warn",
    message:
      `${missing.length} of ${tracked.size} backed-up page(s) are no longer reachable (${sample}). ` +
      (lostAccess
        ? "Fix this BEFORE the next sync: likely lost access. It will preserve content when Notion returns `restricted_resource`, " +
          "but a page that simply disappears from search is treated as deleted and tombstoned."
        : "Deleted in Notion, or no longer shared with the integration — the next sync distinguishes " +
          "`restricted_resource` access loss (preserves content) from true absence (tombstone)."),
  };
}

// ── main ──────────────────────────────────────────────────────────────────────

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const push = (c?: DoctorCheck) => {
    if (c) checks.push(c);
  };

  /** Offline checks run even when the network checks bail out early — they need no token. */
  const finish = async (client?: NotionLike, apiUsable = false): Promise<DoctorReport> => {
    if (opts.outDir) {
      push(checkLastRun(opts));
      if (opts.useGit) push(await checkGit(opts));
      push(await checkAssets(opts));
      if (opts.deep && client && apiUsable) push(await checkCoverage(client, opts));
    }
    return { ok: checks.every((c) => c.ok), checks };
  };

  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  const major = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  push({
    id: "node",
    ok: major >= MIN_NODE_MAJOR,
    message:
      major >= MIN_NODE_MAJOR
        ? `Node.js ${nodeVersion}`
        : `Node.js ${nodeVersion} is too old (need >= ${MIN_NODE_MAJOR})`,
  });

  if (!opts.hasToken || !opts.client) {
    push({
      id: "token",
      ok: false,
      message: "No Notion token found. Set VAULTWEAVE_TOKEN (preferred) or pass --token.",
    });
    return finish();
  }
  push({ id: "token", ok: true, message: "Token provided" });

  const client = opts.client;

  try {
    const me = (await client.users.me({})) as {
      name?: string | null;
      bot?: { workspace_name?: string | null };
    } | null;
    const ws = me?.bot?.workspace_name ? ` in workspace "${me.bot.workspace_name}"` : "";
    push({
      id: "auth",
      ok: true,
      message: me?.name ? `Authenticated as "${me.name}"${ws}` : `Authenticated${ws}`,
    });
  } catch (err) {
    push({ id: "auth", ok: false, message: `Token rejected by Notion: ${describe(err)}` });
    return finish();
  }

  let sample: string | undefined;
  let apiUsable = true;
  try {
    const res = await client.search({ page_size: 100 });
    const n = res.results.length;
    sample = res.results.map(idOf).find((id) => id !== undefined);
    if (n === 0) {
      push({
        id: "reachable",
        ok: false,
        message:
          "The integration can see 0 pages. In Notion, open a page → ••• → Connections and add this integration.",
      });
    } else {
      push({
        id: "reachable",
        ok: true,
        message: `${res.has_more ? `${n}+` : n} page(s)/database(s) reachable`,
      });
    }
  } catch (err) {
    apiUsable = false;
    push({ id: "reachable", ok: false, message: `Search failed: ${describe(err)}` });
  }

  push(await checkScope(client, sample));

  if (opts.probeRateLimit) {
    const total = opts.probeRequests ?? 10;
    const limiter = opts.limiter ?? new TokenBucket({ ratePerSecond: 2.5, jitterMs: 50 });
    let limited = 0;
    for (let i = 0; i < total; i++) {
      await limiter.acquire();
      try {
        await client.search({ page_size: 1 });
      } catch (err) {
        if (isRateLimited(err)) limited++;
        else {
          push({ id: "rate_limit", ok: false, message: `Probe failed: ${describe(err)}` });
          return finish(client, false);
        }
      }
    }
    push({
      id: "rate_limit",
      ok: limited === 0,
      message:
        limited === 0
          ? `${total} requests at 2.5 req/s: no 429s`
          : `${limited}/${total} requests were rate limited — lower the pacing rate`,
    });
  }

  return finish(client, apiUsable);
}

export function formatDoctorReport(report: DoctorReport): string {
  const mark = (c: DoctorCheck) => (!c.ok ? "✖" : c.severity === "warn" ? "⚠" : "✔");
  const lines = report.checks.map((c) => `${mark(c)} ${c.message}`);
  const warnings = report.checks.filter((c) => c.ok && c.severity === "warn").length;
  lines.push(
    "",
    report.ok
      ? warnings > 0
        ? `All checks passed (${warnings} warning(s)).`
        : "All checks passed."
      : "Some checks failed.",
  );
  return lines.join("\n");
}
