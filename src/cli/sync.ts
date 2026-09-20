/**
 * `sheaf sync` — incremental sync of a Notion workspace into the output directory.
 *
 * Options:
 *   --token <token>   Notion integration token (prefer SHEAF_TOKEN env var)
 *   --out <dir>       output directory (default: config `out` or ./sheaf-backup)
 *   --git             auto-commit each run to Git
 *   --since <date>    only pages edited since this ISO date (overrides stored cursor)
 *   --full            force a full re-extraction (ignores stored cursor)
 *   --config <path>   path to .sheaf.yaml
 *   --no-row-bodies   skip page bodies of database rows (faster)
 *   --quiet           suppress progress output
 *
 *   --json            print the run report as JSON on stdout
 *   --notify <t>      alert target for failures (repeatable), e.g. slack:https://hooks.slack.com/…
 *
 * Exit codes (see src/core/exit-codes.ts):
 *   0  — ok: true (complete sync, no errors)
 *   1  — ok: false (errors / aborted — see .sheaf-run-report.json) or invalid configuration
 *   3  — skipped: another sheaf run holds the lock for this output directory
 */

import type { Command } from "commander";
import { ConfigError } from "../config.js";
import { EXIT } from "../core/exit-codes.js";
import type { ProgressEvent } from "../core/extractor/index.js";
import type { NotifyResult } from "../core/notify/index.js";
import { type OperateDeps, runOperatedSync } from "../core/operations.js";
import type { RunReport } from "../core/state/report.js";
import { type ResolvedSettings, type RunOptions, resolveSettings } from "./settings.js";

export interface SyncCommandOptions extends RunOptions {
  since?: string;
  full?: boolean;
  /** Print the run report as JSON on stdout instead of the human summary. */
  json?: boolean;
}

const MAX_LISTED = 20;

/**
 * `--full` clears the *stored cursor*; it does not override an explicit `--since <date>`, which is
 * a deliberate user instruction. Blanket `incremental: false` here used to make `--full --since`
 * silently mean "full crawl".
 */
export function syncOptionsFrom(
  s: ResolvedSettings,
  extra: { since?: string; full?: boolean } = {},
) {
  const skipCursor = !!extra.full;
  const since = extra.since;
  return {
    token: s.token,
    outDir: s.outDir,
    roots: s.roots,
    incremental: since !== undefined ? true : !skipCursor,
    sinceOverride: since,
    git: s.useGit,
    rowBodies: s.rowBodies,
    ignore: s.ignore,
    redact: s.redact,
    s3Targets: s.s3Targets,
  };
}

export async function runSyncCommand(
  opts: SyncCommandOptions,
  env: Record<string, string | undefined> = process.env,
  deps: OperateDeps = {},
): Promise<number> {
  const write = (s: string) => process.stdout.write(s);
  const error = (s: string) => process.stderr.write(s);

  let settings: ResolvedSettings;
  try {
    settings = await resolveSettings(opts, env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    error(`${e.message}\n`);
    return EXIT.FAILED;
  }

  // Progress output.
  let seen = 0;
  const onProgress = (e: ProgressEvent) => {
    if (settings.quiet || opts.json) return;
    seen++;
    if (process.stderr.isTTY) process.stderr.write(`\r  syncing… ${seen} (${e.kind})   `);
  };

  const result = await runOperatedSync(
    {
      sync: { ...syncOptionsFrom(settings, opts), onProgress },
      onError: settings.onError,
      onSuccess: settings.onSuccess,
    },
    deps,
  );

  if (!settings.quiet && process.stderr.isTTY) process.stderr.write("\r\x1b[K");

  if (result.status === "skipped_locked") {
    const h = result.lockHolder;
    error(
      `Skipped: another sheaf run is using ${settings.outDir}` +
        (h ? ` (pid ${h.pid} on ${h.host}, since ${h.startedAt}).\n` : ".\n"),
    );
    return result.exitCode;
  }

  const report = result.report as RunReport;
  if (opts.json) write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report, write);
  for (const line of notificationProblems(result.notifications)) error(`${line}\n`);
  return result.exitCode;
}

/** Human lines for every notification that could not be delivered (empty when all is well). */
export function notificationProblems(results: readonly NotifyResult[]): string[] {
  return results
    .filter((r) => !r.ok)
    .map((r) => `⚠ ${r.event} notification to ${r.label} was NOT delivered: ${r.error}`);
}

function printReport(r: RunReport, write: (s: string) => void): void {
  const c = r.counts;
  const lines: string[] = [];

  // Mode line.
  const mode = r.incremental
    ? `incremental (since ${r.sinceTimestamp ?? "cursor"})`
    : "full extraction";
  lines.push(`Sync ${r.ok ? "complete" : "FAILED"} — ${mode}`);

  // Counts.
  lines.push(
    `Pages: ${c.pagesLive} live, ${c.pagesWritten} written, ` +
      `${c.pagesSkipped} skipped (unchanged), ${c.pagesDeleted} tombstoned`,
  );
  if (c.databaseFilesWritten > 0)
    lines.push(`Database files: ${c.databaseFilesWritten} CSV/JSON written`);
  if (c.assetsDownloaded > 0) lines.push(`Assets: ${c.assetsDownloaded} downloaded`);
  lines.push(
    `API: ${c.apiRequests} requests` +
      (c.apiRetries > 0 ? `, ${c.apiRetries} retried` : "") +
      (c.apiRateLimited > 0 ? `, ${c.apiRateLimited} rate-limited` : ""),
  );
  lines.push(`Duration: ${(r.durationMs / 1000).toFixed(1)}s`);
  lines.push(`Output: ${r.outDir}`);

  // Git.
  if (r.gitCommit) {
    lines.push(
      `Git: committed ${r.gitCommit.filesChanged} file(s) → ${r.gitCommit.sha.slice(0, 8)}`,
    );
  }

  // Issues.
  const listIssues = (title: string, items: RunReport["warnings"], mark: string) => {
    if (items.length === 0) return;
    lines.push(`${title}: ${items.length}`);
    for (const i of items.slice(0, MAX_LISTED))
      lines.push(`  ${mark} [${i.code}] ${i.id}: ${i.message}`);
    if (items.length > MAX_LISTED)
      lines.push(`  … and ${items.length - MAX_LISTED} more (see .sheaf-run-report.json)`);
  };
  listIssues("Warnings", r.warnings, "⚠");
  listIssues("Errors", r.errors, "✖");
  if (r.aborted) lines.push(`✖ ABORTED: ${r.aborted}`);

  // Status line.
  lines.push(r.ok ? "✓ OK" : "✖ INCOMPLETE — see .sheaf-run-report.json");

  write(`${lines.join("\n")}\n`);
}

export function registerSync(program: Command): void {
  program
    .command("sync")
    .description(
      "Sync a Notion workspace to Markdown/CSV/JSON (only changed files are rewritten) + optional Git commit",
    )
    .option("--token <token>", "Notion integration token (prefer SHEAF_TOKEN env var)")
    .option("--out <dir>", "output directory (default: config `out` or ./sheaf-backup)")
    .option("--git", "auto-commit the output directory to Git after each sync")
    .option("--since <date>", "only extract pages edited since this ISO date (overrides cursor)")
    .option("--full", "force a full re-extraction (ignore the stored last-sync cursor)")
    .option("--config <path>", "path to .sheaf.yaml")
    .option("--no-row-bodies", "skip the page bodies of database rows (faster)")
    .option("--quiet", "suppress progress output (errors still go to stderr)")
    .option("--json", "print the run report as JSON on stdout (for CI and monitors)")
    .option("--s3-bucket <bucket>", "also upload rendered files to an S3-compatible bucket")
    .option("--s3-prefix <prefix>", "S3 object key prefix")
    .option("--s3-region <region>", "AWS region for S3")
    .option("--s3-endpoint <url>", "custom S3-compatible endpoint (R2, MinIO, etc.)")
    .option("--s3-force-path-style", "use path-style S3 addressing")
    .option(
      "--notify <target>",
      "alert target for failures, e.g. slack:https://… (repeatable; overrides config notify.on_error)",
      (v: string, prev: string[] = []) => [...prev, v],
    )
    .option(
      "--root <id>",
      "restrict to this page/database ID (repeatable)",
      (v: string, prev: string[] = []) => [...prev, v],
    )
    .action(async (opts: SyncCommandOptions) => {
      process.exitCode = await runSyncCommand(opts);
    });
}
