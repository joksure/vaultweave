/**
 * `vaultweave watch` — daemon mode: a sync on an interval, forever.
 *
 * Options:
 *   --interval <d>    e.g. 30m, 6h, 1d (minimum 1m; or `interval:` in the config)
 *   --out <dir>       output directory (default: config `out` or ./vaultweave-backup)
 *   --git             auto-commit each run to Git
 *   --notify <t>      alert target for failures (repeatable), e.g. slack:https://hooks.slack.com/…
 *   --token, --config, --root, --no-row-bodies, --quiet   as for `sync`
 *
 * Behaviour:
 *   - runs immediately, then waits `interval` after each run finishes (runs never overlap);
 *   - after a failed run retries sooner (5m, 10m, 20m… capped at the interval);
 *   - failures alert on the 1st, 2nd, 4th, 8th… consecutive failure; success after failures
 *     sends one "recovered" notice;
 *   - SIGINT/SIGTERM: stop scheduling and let the current run finish; a second signal exits now
 *     (an interrupted run is safe: state is only advanced at the end of a successful run).
 *
 * Exit codes: 0 after a graceful stop; 1 for invalid configuration (nothing is started).
 */

import type { Command } from "commander";
import { ConfigError } from "../config.js";
import { formatDuration } from "../core/duration.js";
import { EXIT } from "../core/exit-codes.js";
import type { NotifierContext } from "../core/notify/index.js";
import { type OperateDeps, runOperatedSync } from "../core/operations.js";
import type { RunReport } from "../core/state/report.js";
import { runWatchLoop, type WatchOptions } from "../core/watch.js";
import { type ResolvedSettings, type RunOptions, resolveSettings } from "./settings.js";
import { notificationProblems, syncOptionsFrom } from "./sync.js";

export interface WatchHooks {
  /** Abort to stop the daemon. When omitted, SIGINT/SIGTERM are wired to a fresh controller. */
  signal?: AbortSignal;
  sleep?: WatchOptions["sleep"];
  retryBaseMs?: number;
  deps?: OperateDeps;
  /** Injectable for tests (fake fetch / instant sleeps for the notifiers). */
  notifierContext?: NotifierContext;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

const MAX_LISTED = 5;

function summaryLine(r: RunReport): string {
  const c = r.counts;
  return (
    `${c.pagesLive} pages (${c.pagesWritten} written, ${c.pagesDeleted} deleted), ` +
    `${c.apiRequests} API requests, ${formatDuration(r.durationMs)}`
  );
}

export async function runWatchCommand(
  opts: RunOptions,
  env: Record<string, string | undefined> = process.env,
  hooks: WatchHooks = {},
): Promise<number> {
  const out = hooks.stdout ?? ((s: string) => process.stdout.write(s));
  const err = hooks.stderr ?? ((s: string) => process.stderr.write(s));
  const stamp = () => new Date().toISOString();
  const info = (msg: string) => {
    if (!opts.quiet) out(`[${stamp()}] ${msg}\n`);
  };
  const warn = (msg: string) => err(`[${stamp()}] ${msg}\n`);

  let settings: ResolvedSettings;
  try {
    settings = await resolveSettings(opts, env, {
      requireInterval: true,
      notifierContext: hooks.notifierContext,
    });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    err(`${e.message}\n`);
    return EXIT.FAILED;
  }
  const intervalMs = settings.intervalMs as number; // guaranteed by requireInterval

  // Signals.
  const controller = new AbortController();
  const signal = hooks.signal ?? controller.signal;
  const onSignal = (name: string) => {
    if (signal.aborted) {
      err(`\n${name} again — exiting immediately.\n`);
      process.exit(130);
    }
    info(`${name} received — stopping after the current run (send it again to force quit)`);
    controller.abort();
  };
  const sigint = () => onSignal("SIGINT");
  const sigterm = () => onSignal("SIGTERM");
  if (!hooks.signal) {
    process.on("SIGINT", sigint);
    process.on("SIGTERM", sigterm);
  }

  const alerts = settings.onError.map((n) => n.label).join(", ") || "none";
  info(
    `watching: every ${formatDuration(intervalMs)} → ${settings.outDir}` +
      `${settings.useGit ? " (git)" : ""}; alerts: ${alerts}`,
  );
  if (settings.onError.length === 0) {
    warn("⚠ no alert target configured — failed runs will only be visible in this log");
  }

  try {
    const runs = await runWatchLoop({
      intervalMs,
      signal,
      sleep: hooks.sleep,
      retryBaseMs: hooks.retryBaseMs,
      runOnce: async () => {
        const result = await runOperatedSync(
          {
            sync: syncOptionsFrom(settings),
            onError: settings.onError,
            onSuccess: settings.onSuccess,
          },
          hooks.deps,
        );
        for (const line of notificationProblems(result.notifications)) warn(line);

        if (result.status === "skipped_locked") {
          const h = result.lockHolder;
          warn(
            `skipped: another vaultweave run holds the lock${h ? ` (pid ${h.pid} on ${h.host})` : ""}`,
          );
          return { ok: false, skipped: true };
        }
        const report = result.report as RunReport;
        if (report.ok) {
          info(`✓ ok — ${summaryLine(report)}`);
        } else {
          warn(`✖ FAILED — ${report.aborted ?? `${report.errors.length} error(s)`}`);
          for (const i of report.errors.slice(0, MAX_LISTED)) {
            warn(`    [${i.code}] ${i.id}: ${i.message}`);
          }
          if (report.errors.length > MAX_LISTED) {
            warn(
              `    … and ${report.errors.length - MAX_LISTED} more (see .vaultweave-run-report.json)`,
            );
          }
        }
        return { ok: report.ok };
      },
      onRunStart: (n) => info(`run #${n} started`),
      onRunEnd: (n, tick) => {
        if ("crashed" in tick) warn(`run #${n} crashed unexpectedly: ${String(tick.crashed)}`);
      },
      onScheduled: (delayMs, reason) => {
        const at = new Date(Date.now() + delayMs).toISOString();
        const why =
          reason === "retry"
            ? " (retrying early after a failure)"
            : reason === "locked"
              ? " (lock busy)"
              : "";
        info(`next run in ${formatDuration(delayMs)} at ${at}${why}`);
      },
    });
    info(`stopped after ${runs} run(s)`);
    return EXIT.OK;
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  }
}

export function registerWatch(program: Command): void {
  program
    .command("watch")
    .description(
      "Daemon mode: run a sync on an interval, retry early after failures, alert on failures",
    )
    .option("--interval <duration>", "time between runs, e.g. 30m, 6h, 1d (minimum 1m)")
    .option("--token <token>", "Notion integration token (prefer the VAULTWEAVE_TOKEN env var)")
    .option("--out <dir>", "output directory (default: config `out` or ./vaultweave-backup)")
    .option("--git", "auto-commit the output directory to Git after each run")
    .option(
      "--notify <target>",
      "alert target for failures, e.g. slack:https://… (repeatable; overrides config notify.on_error)",
      (v: string, prev: string[] = []) => [...prev, v],
    )
    .option("--config <path>", "path to .vaultweave.yaml")
    .option("--no-row-bodies", "skip the page bodies of database rows (faster)")
    .option("--quiet", "only log problems")
    .option(
      "--root <id>",
      "restrict to this page/database ID (repeatable)",
      (v: string, prev: string[] = []) => [...prev, v],
    )
    .action(async (opts: RunOptions) => {
      process.exitCode = await runWatchCommand(opts);
    });
}
