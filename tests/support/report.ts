import type { RunReport } from "../../src/core/state/report.js";

export function makeReport(over: Partial<RunReport> = {}): RunReport {
  return {
    schemaVersion: 1,
    startedAt: "2026-09-20T10:00:00.000Z",
    endedAt: "2026-09-20T10:00:12.000Z",
    durationMs: 12_000,
    ok: true,
    incremental: false,
    incrementalExtraction: false,
    nextCursor: "2026-09-20T10:00:00.000Z",
    counts: {
      pagesLive: 42,
      pagesWritten: 3,
      pagesSkipped: 39,
      pagesUnchangedSkipped: 0,
      pagesDeleted: 0,
      databaseFilesWritten: 2,
      assetsDownloaded: 1,
      ignoredPages: 0,
      redactions: 0,
      apiRequests: 130,
      apiRetries: 0,
      apiRateLimited: 0,
    },
    warnings: [],
    errors: [],
    outDir: "/tmp/backup",
    ...over,
  };
}
