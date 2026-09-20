/**
 * Operations layer (M4): one *operated* sync run.
 *
 *   lock → sync → (never throws) → history/streak → notify → result
 *
 * Both `vaultweave sync` and every tick of `vaultweave watch` go through `runOperatedSync`, so a cron job
 * and a daemon behave identically: same lock, same alert policy, same exit-code contract.
 *
 * Design rules:
 *   - P4: a failed run ALWAYS produces a report and an alert attempt before the caller exits.
 *   - A notifier problem never changes the backup outcome (and never throws).
 *   - The lock is released BEFORE notifying, so slow webhooks never block the next run.
 */

import { hostname } from "node:os";
import { EXIT } from "./exit-codes.js";
import { acquireLock, type Lock, LockHeldError, type LockInfo } from "./lock.js";
import {
  analyzeHistory,
  dispatch,
  type Notifier,
  type NotifyEvent,
  type NotifyResult,
  shouldAlertOnFailure,
} from "./notify/index.js";
import { runSync, type SyncDeps, type SyncOptions } from "./pipeline.js";
import { scrubSecrets } from "./scrub.js";
import { openStateDb, type StateDb } from "./state/index.js";
import { buildReport, type RunReport } from "./state/report.js";

export interface OperateOptions {
  sync: SyncOptions;
  /** Alert channel: failures, plus the "recovered" notice. */
  onError?: readonly Notifier[];
  /** Optional per-run success channel. */
  onSuccess?: readonly Notifier[];
  /** Use the single-writer lock (default true). */
  lock?: boolean;
}

export interface OperateDeps {
  runSync?: typeof runSync;
  syncDeps?: SyncDeps;
  acquireLock?: (outDir: string) => Promise<Lock>;
  /** Newest-first outcomes from the state DB (default: read `<outDir>/vaultweave.db`). */
  readHistory?: (outDir: string) => Array<{ startedAt: string; ok: boolean }>;
  host?: string;
}

export interface OperateResult {
  status: "completed" | "skipped_locked";
  /** Absent only when skipped. */
  report?: RunReport;
  exitCode: number;
  notifications: NotifyResult[];
  lockHolder?: LockInfo;
  failureStreak: number;
}

function defaultReadHistory(outDir: string): Array<{ startedAt: string; ok: boolean }> {
  let db: StateDb | undefined;
  try {
    db = openStateDb(outDir);
    return db.getRecentOutcomes();
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/** A run that blew up before/after the pipeline could report on itself. */
function crashReport(
  startedAt: string,
  opts: SyncOptions,
  err: unknown,
  secrets: string[],
): RunReport {
  const message = scrubSecrets(err instanceof Error ? err.message : String(err), secrets);
  return buildReport({
    startedAt,
    ok: false,
    incremental: false,
    incrementalExtraction: false,
    nextCursor: startedAt,
    counts: {
      pagesLive: 0,
      pagesWritten: 0,
      pagesSkipped: 0,
      pagesUnchangedSkipped: 0,
      pagesDeleted: 0,
      databaseFilesWritten: 0,
      assetsDownloaded: 0,
      ignoredPages: 0,
      redactions: 0,
      apiRequests: 0,
      apiRetries: 0,
      apiRateLimited: 0,
    },
    warnings: [],
    errors: [{ code: "run_crashed", id: "pipeline", message }],
    aborted: message,
    outDir: opts.outDir,
  });
}

export async function runOperatedSync(
  opts: OperateOptions,
  deps: OperateDeps = {},
): Promise<OperateResult> {
  const onError = opts.onError ?? [];
  const onSuccess = opts.onSuccess ?? [];
  const host = deps.host ?? hostname();
  const secrets = [opts.sync.token, ...[...onError, ...onSuccess].flatMap((n) => n.secrets)];

  // 1. Lock. "Held" means skip quietly; any other failure (e.g. unwritable directory) is a
  //    failed run like any other — an unattended daemon must survive it and raise the alarm.
  const startedAt = new Date().toISOString();
  let lock: Lock | undefined;
  let report: RunReport | undefined;
  if (opts.lock !== false) {
    try {
      lock = await (deps.acquireLock ?? acquireLock)(opts.sync.outDir);
    } catch (err) {
      if (err instanceof LockHeldError) {
        return {
          status: "skipped_locked",
          exitCode: EXIT.LOCKED,
          notifications: [],
          lockHolder: err.holder,
          failureStreak: 0,
        };
      }
      report = crashReport(startedAt, opts.sync, err, secrets);
    }
  }

  // 2. Sync — must never throw out of here.
  if (!report) {
    try {
      report = await (deps.runSync ?? runSync)(opts.sync, deps.syncDeps);
    } catch (err) {
      report = crashReport(startedAt, opts.sync, err, secrets);
      // Best effort: keep the crash in the history so streak logic and doctor see it.
      try {
        const db = openStateDb(opts.sync.outDir);
        try {
          db.saveReport(report);
        } finally {
          db.close();
        }
      } catch {
        // The DB itself may be the problem.
      }
    } finally {
      await lock?.release();
    }
  }

  // 3. Streak from persisted history (survives restarts; works for one-shot cron too).
  const history = (deps.readHistory ?? defaultReadHistory)(opts.sync.outDir);
  const { failureStreak, previousFailures } = analyzeHistory(
    { startedAt: report.startedAt, ok: report.ok },
    history,
  );

  // 4. Notify.
  const base = { report, failureStreak, previousFailures, host };
  const notifications: NotifyResult[] = [];
  const send = async (targets: readonly Notifier[], event: NotifyEvent) => {
    if (targets.length > 0) notifications.push(...(await dispatch(targets, event, secrets)));
  };

  if (!report.ok) {
    if (shouldAlertOnFailure(failureStreak)) await send(onError, { ...base, kind: "failed" });
  } else {
    await send(onSuccess, { ...base, kind: "succeeded" });
    if (previousFailures > 0) {
      // Close the loop on the alert channel — unless it already got the success message.
      const key = (n: Notifier) => `${n.kind}|${n.secrets.join("|")}`;
      const already = new Set(onSuccess.map(key));
      await send(
        onError.filter((n) => !already.has(key(n))),
        { ...base, kind: "recovered" },
      );
    }
  }

  return {
    status: "completed",
    report,
    exitCode: report.ok ? EXIT.OK : EXIT.FAILED,
    notifications,
    failureStreak,
  };
}
