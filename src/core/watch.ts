/**
 * Watch scheduler (M4): runs a job forever on an interval and survives failures.
 *
 * Timing model — fixed delay *after* each run finishes:
 *   - runs can never overlap, however long one takes;
 *   - after a failure we retry sooner than the full interval (exponential, capped at the
 *     interval), so a network blip at 02:00 does not cost a whole 6 h window;
 *   - a run skipped because another process holds the lock is retried after at most a minute.
 *
 * The scheduler knows nothing about Notion: `runOnce` is injected (see cli/watch.ts), which
 * keeps this loop trivially testable with fake sleeps.
 */

export interface WatchTick {
  /** The run finished and nothing failed. */
  ok: boolean;
  /** The run did not happen because another process holds the lock. */
  skipped?: boolean;
}

export interface WatchOptions {
  intervalMs: number;
  runOnce: () => Promise<WatchTick>;
  /** Aborting stops scheduling; a run already in progress is allowed to finish. */
  signal: AbortSignal;
  /** First retry delay after a failure (default 5 min); doubles per consecutive failure. */
  retryBaseMs?: number;
  /** Abortable sleep; injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onRunStart?: (run: number) => void;
  onRunEnd?: (run: number, tick: WatchTick | { crashed: unknown }) => void;
  onScheduled?: (delayMs: number, reason: "interval" | "retry" | "locked") => void;
}

export const LOCKED_RETRY_MS = 60_000;

/** Delay before the next attempt. Pure, so the policy is unit-testable. */
export function nextDelayMs(
  intervalMs: number,
  failureStreak: number,
  retryBaseMs = 5 * 60_000,
): { delayMs: number; reason: "interval" | "retry" } {
  if (failureStreak <= 0) return { delayMs: intervalMs, reason: "interval" };
  const backoff = retryBaseMs * 2 ** Math.min(failureStreak - 1, 20);
  return backoff >= intervalMs
    ? { delayMs: intervalMs, reason: "interval" }
    : { delayMs: backoff, reason: "retry" };
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Returns the number of runs performed once `signal` is aborted. */
export async function runWatchLoop(opts: WatchOptions): Promise<number> {
  const sleep = opts.sleep ?? abortableSleep;
  let runs = 0;
  let streak = 0;

  while (!opts.signal.aborted) {
    runs++;
    opts.onRunStart?.(runs);

    let tick: WatchTick;
    try {
      tick = await opts.runOnce();
      opts.onRunEnd?.(runs, tick);
    } catch (err) {
      // runOperatedSync should never throw; if something still does, the daemon survives it.
      tick = { ok: false };
      opts.onRunEnd?.(runs, { crashed: err });
    }

    if (opts.signal.aborted) break;

    let delayMs: number;
    let reason: "interval" | "retry" | "locked";
    if (tick.skipped) {
      delayMs = Math.min(opts.intervalMs, LOCKED_RETRY_MS);
      reason = "locked";
    } else {
      streak = tick.ok ? 0 : streak + 1;
      ({ delayMs, reason } = nextDelayMs(opts.intervalMs, streak, opts.retryBaseMs));
    }
    opts.onScheduled?.(delayMs, reason);
    await sleep(delayMs, opts.signal);
  }
  return runs;
}
