/**
 * Alert-fatigue policy.
 *
 * A backup that fails every 6 hours for a weekend must not post 8 identical alerts.
 * We alert on the 1st consecutive failure, then again at 2, 4, 8, 16… — often enough
 * that a long outage stays visible, rarely enough that the channel stays readable.
 * A success after failures sends a single "recovered" notice to the alert channel.
 *
 * The streak is derived from the persisted run history, so it works for one-shot
 * cron runs as well as for the watch daemon. If the history is lost (e.g. a CI runner
 * without cache) the streak restarts at 1 and every failure alerts — the safe direction.
 */
export function shouldAlertOnFailure(streak: number): boolean {
  return streak >= 1 && (streak & (streak - 1)) === 0;
}

export interface RunOutcome {
  startedAt: string;
  ok: boolean;
}

/**
 * `history` is newest-first and may or may not already contain the current run.
 * Returns the failure streak *including* the current run, and — when the current run
 * succeeded — the streak of failures that came right before it.
 */
export function analyzeHistory(
  current: RunOutcome,
  history: readonly RunOutcome[],
): { failureStreak: number; previousFailures: number } {
  const prior = history[0]?.startedAt === current.startedAt ? history.slice(1) : history;
  let run = 0;
  for (const o of prior) {
    if (o.ok) break;
    run++;
  }
  return current.ok
    ? { failureStreak: 0, previousFailures: run }
    : { failureStreak: run + 1, previousFailures: 0 };
}
