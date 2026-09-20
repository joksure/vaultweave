/**
 * Structured run report emitted after every vaultweave sync run (P4: no silent failures).
 *
 * Saved to `<outDir>/vaultweave.db` (run_reports table) and written as
 * `<outDir>/.vaultweave-run-report.json` for CI/monitoring consumers.
 *
 * Exit-code contract:
 *   0 — ok: true  (no errors, no aborted)
 *   1 — ok: false (errors or aborted; run_report.json explains why)
 */

export interface RunCounts {
  /** Pages seen in the live workspace. */
  pagesLive: number;
  /**
   * Pages written (new or changed content). A page the extractor reused without fetching it —
   * unchanged since the cursor — is not counted here: it was not walked, so its body was not
   * re-rendered.
   */
  pagesWritten: number;
  /** Pages skipped (content hash unchanged). */
  pagesSkipped: number;
  /**
   * Pages that an incremental run did not re-fetch at all because nothing below them changed.
   * This is what makes an idle second run approach zero API calls.
   */
  pagesUnchangedSkipped: number;
  /** Pages tombstoned (no longer in workspace). */
  pagesDeleted: number;
  /** Database data-source CSV/JSON files written. */
  databaseFilesWritten: number;
  /** Asset files downloaded. */
  assetsDownloaded: number;
  /** Number of pages intentionally excluded from output. */
  ignoredPages?: number;
  /** Number of redaction replacements made in textual outputs. */
  redactions?: number;
  /** API requests made. */
  apiRequests: number;
  /** API requests that were retried. */
  apiRetries: number;
  /** Requests that hit rate-limit (429). */
  apiRateLimited: number;
}

export interface RunIssue {
  code: string;
  id: string;
  message: string;
}

export interface GitCommitResult {
  sha: string;
  message: string;
  filesChanged: number;
}

export interface RunReport {
  /** Bump when the shape changes incompatibly; monitors can branch on it. */
  schemaVersion: 1;
  /** ISO timestamp when the run started. */
  startedAt: string;
  /** ISO timestamp when the run ended. */
  endedAt: string;
  /** Duration in milliseconds. */
  durationMs: number;
  /** true only when errors === [] && aborted === undefined. */
  ok: boolean;
  /** Incremental mode: was this run able to use the last-sync cursor? */
  incremental: boolean;
  /**
   * Whether the *extractor* actually received a time filter (i.e. it crawled only changed
   * objects). false when the run was incremental in intent but the cursor could not be trusted
   * (see `sinceTimestamp`), in which case it fell back to a full crawl.
   */
  incrementalExtraction: boolean;
  /** The last-sync cursor used (ISO timestamp), if any. */
  sinceTimestamp?: string;
  /** The cursor stored for the next run (ISO timestamp of run start). */
  nextCursor: string;
  counts: RunCounts;
  warnings: RunIssue[];
  errors: RunIssue[];
  /** Set when a fatal API failure aborted the run early. */
  aborted?: string;
  /** Present when --git was used and a commit was made. */
  gitCommit?: GitCommitResult;
  /** Output directory (absolute path). */
  outDir: string;
}

/** Builds a RunReport from the accumulated run state. */
export function buildReport(
  partial: Omit<RunReport, "endedAt" | "durationMs" | "schemaVersion">,
): RunReport {
  const endedAt = new Date().toISOString();
  const durationMs = Date.parse(endedAt) - Date.parse(partial.startedAt);
  return { schemaVersion: 1, ...partial, endedAt, durationMs };
}
