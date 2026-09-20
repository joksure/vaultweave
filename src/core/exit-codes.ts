/**
 * Process exit codes — a stable contract for cron, CI and supervisors.
 *
 *   0  OK          the run finished and nothing failed
 *   1  FAILED      the run was incomplete or failed (see .vaultweave-run-report.json), or bad configuration
 *   2  NOT_IMPLEMENTED  the command exists in the CLI surface but is not built yet
 *   3  LOCKED      another vaultweave run holds the lock for this output directory; nothing was done
 */
export const EXIT = {
  OK: 0,
  FAILED: 1,
  NOT_IMPLEMENTED: 2,
  LOCKED: 3,
} as const;
