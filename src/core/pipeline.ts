/**
 * Vaultweave sync pipeline (M3).
 *
 * Orchestrates the full incremental sync cycle:
 *   1. Load state DB → get last-sync cursor.
 *   2. Extract workspace (full or incremental using last_edited_time filter).
 *   3. Normalize extraction result → IrWorkspace.
 *   4. Render & write to filesystem, skipping unchanged pages (hash check).
 *   5. Tombstone deleted pages (visible stubs, not silent rm).
 *   6. Update state DB (hashes, cursor).
 *   7. Optionally commit to Git.
 *   8. Save run report → DB + .vaultweave-run-report.json.
 *
 * Design:
 *   - Never throws for per-page errors; they accumulate in the RunReport.
 *   - Throws only for fatal config / auth errors.
 *   - Injectable deps for testability (extractor factory, git, state db, fs).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type WriteResult, writeWorkspace } from "../targets/filesystem.js";
import { type GitSyncOptions, gitSync } from "../targets/git.js";
import { type S3SyncResult, syncDirectoryToS3 } from "../targets/s3.js";
import type { ExtractionResult } from "./extractor/index.js";
import {
  createOfficialExtractor,
  type ExtractionOptions,
  type ProgressEvent,
} from "./extractor/index.js";
import { normalize } from "./normalizer/index.js";
import type { IrWorkspace } from "./normalizer/ir.js";
import {
  mergeExtractionCache,
  readExtractionCache,
  writeExtractionCache,
} from "./pipeline-cache.js";
import { contentHash, openStateDb, type StateDb } from "./state/index.js";
import { buildReport, type RunCounts, type RunIssue, type RunReport } from "./state/report.js";

// ── options ───────────────────────────────────────────────────────────────────

export interface SyncOptions {
  token: string;
  outDir: string;
  /** Restrict to specific page/database IDs (omit for full workspace). */
  roots?: string[];
  /** Enable incremental mode: use last-sync cursor from state DB. */
  incremental?: boolean;
  /** Override: treat pages edited before this ISO timestamp as unchanged. */
  sinceOverride?: string;
  /** Auto-commit the output directory to Git after writing. */
  git?: boolean;
  /** Skip DB row page bodies (faster, less complete). */
  rowBodies?: boolean;
  /** Patterns or page-ID prefixes to omit from the rendered backup. */
  ignore?: string[];
  /** Regular expressions replaced with [REDACTED] in textual output. */
  redact?: string[];
  /** Optional S3 targets; filesystem remains the canonical local target. */
  s3Targets?: Array<{
    bucket: string;
    prefix?: string;
    region?: string;
    endpoint?: string;
    forcePathStyle?: boolean;
  }>;
  /** Progress callback. */
  onProgress?: (e: ProgressEvent) => void;
  /** Override state DB path (default: `<outDir>/vaultweave.db`). */
  stateDbPath?: string;
}

// ── injectable deps (for tests) ───────────────────────────────────────────────

export interface SyncDeps {
  openDb?: (outDir: string) => StateDb;
  runExtract?: (opts: {
    token: string;
    outDir: string;
    rowBodies?: boolean;
    onProgress?: (e: ProgressEvent) => void;
  }) => { extract(o: ExtractionOptions): Promise<ExtractionResult> };
  runGitSync?: (
    opts: GitSyncOptions,
  ) => Promise<import("./state/report.js").GitCommitResult | null>;
  runWriteWorkspace?: (
    ws: IrWorkspace,
    opts: { outDir: string; redact?: string[] },
  ) => Promise<WriteResult>;
  runS3Sync?: (
    outDir: string,
    files: readonly string[],
    options: NonNullable<SyncOptions["s3Targets"]>[number],
  ) => Promise<S3SyncResult>;
}

// ── TOMBSTONE_MARKER ──────────────────────────────────────────────────────────

const TOMBSTONE_MARKER = (id: string) =>
  `---\nvaultweave_tombstone: true\nnotion_id: ${id}\n---\n\n` +
  `<!-- This page was deleted from Notion and is no longer backed up. -->\n`;

// ── main ──────────────────────────────────────────────────────────────────────

export async function runSync(opts: SyncOptions, deps: SyncDeps = {}): Promise<RunReport> {
  const startedAt = new Date().toISOString();
  const {
    token,
    outDir,
    roots,
    incremental = true,
    sinceOverride,
    git: useGit = false,
    rowBodies = true,
    redact = [],
    onProgress,
  } = opts;

  // Ensure output directory exists.
  await mkdir(outDir, { recursive: true });

  // State DB.
  const openDb = deps.openDb ?? openStateDb;
  const db = openDb(opts.stateDbPath ?? outDir);

  // Cursor for incremental extraction.
  // A run that starts at or before the last cursor would make the "edited after since" filter
  // drop everything edited since that cursor — so in that case the cursor is not used at all and
  // the run falls back to a full crawl. This is also what keeps a failed run safe: its report
  // keeps the old `sinceTimestamp` (see below), so the retry still covers the same window.
  const STATE_KEY = "last_sync";
  const storedCursor = db.getCursor(STATE_KEY);
  const requestedSince = sinceOverride ?? (incremental ? storedCursor : undefined);
  const sinceTimestamp =
    requestedSince !== undefined && Date.parse(requestedSince) >= Date.parse(startedAt)
      ? undefined
      : requestedSince;
  const isIncremental = !!sinceTimestamp;

  // Extract.
  const makeExtractor = deps.runExtract ?? ((o) => createOfficialExtractor(o));
  const extractor = makeExtractor({ token, outDir, rowBodies, onProgress });

  let extraction: ExtractionResult;
  let fetchedExtraction: ExtractionResult;
  try {
    // The cursor computed above is what makes this run incremental: without it the extractor
    // re-crawls the whole workspace (and `--full` is what clears it).
    fetchedExtraction = await extractor.extract({ roots, sinceTimestamp });
    extraction = fetchedExtraction.incremental
      ? mergeExtractionCache(await readExtractionCache(outDir), fetchedExtraction)
      : fetchedExtraction;
  } catch (err) {
    // Fatal: auth failure, network error, etc. Save a minimal failed report.
    const report = buildReport({
      startedAt,
      ok: false,
      incremental: isIncremental,
      incrementalExtraction: isIncremental,
      sinceTimestamp,
      nextCursor: startedAt,
      counts: emptyCounts(),
      warnings: [],
      errors: [{ code: "extraction_fatal", id: "pipeline", message: String(err) }],
      aborted: String(err),
      outDir,
    });
    try {
      db.saveReport(report);
      await writeRunReport(outDir, report);
    } finally {
      db.close();
    }
    return report;
  }

  // Everything below must still produce a report and release the DB if it throws.
  try {
    return await finishRun();
  } catch (err) {
    const report = buildReport({
      startedAt,
      ok: false,
      incremental: isIncremental,
      incrementalExtraction: isIncremental,
      sinceTimestamp,
      nextCursor: startedAt,
      counts: emptyCounts(),
      warnings: extraction.warnings,
      errors: [{ code: "pipeline_failed", id: "pipeline", message: String(err) }],
      aborted: String(err),
      outDir,
    });
    try {
      db.saveReport(report);
      await writeRunReport(outDir, report);
    } catch {
      // Best effort: the caller still gets the report object and will notify.
    }
    return report;
  } finally {
    db.close();
  }

  async function finishRun(): Promise<RunReport> {
    // Normalize.
    const workspace = normalize(extraction);

    // The pages this run actually fetched and walked. Everything else in `workspace` is a reuse
    // of last run's extraction (see `pagesUnchangedSkipped`).
    const incrementalPages = new Set(fetchedExtraction.pages.map((p) => p.id));
    // Page rows keep the full list of rows of their data source, so a database row that is not in
    // `extraction.pages` may still have been refreshed from its data source's row list.
    const databaseRowIds = new Set(
      extraction.databases.flatMap((d) => d.data_sources.flatMap((s) => s.rows.map((r) => r.id))),
    );
    const fetchedIds = new Set([...incrementalPages, ...databaseRowIds]);
    const incrementalPagesPartial = workspace.pages.some((p) => !fetchedIds.has(p.id));

    // Write to filesystem.
    const doWrite = deps.runWriteWorkspace ?? writeWorkspace;
    const writeResult = await doWrite(workspace, { outDir, redact });

    const s3Errors: RunIssue[] = [];
    for (const s3 of opts.s3Targets ?? []) {
      const syncS3 = deps.runS3Sync ?? syncDirectoryToS3;
      const result = await syncS3(outDir, writeResult.filesWritten, s3);
      s3Errors.push(
        ...result.errors.map((e) => ({ code: "s3_upload_failed", id: e.path, message: e.error })),
      );
    }

    // Hash-dedup: track which pages changed vs were skipped.
    const storedHashes = db.getAllHashes();
    let pagesWritten = 0;
    let pagesSkipped = 0;

    for (const page of workspace.pages) {
      // A page whose file failed to write has no path; that failure is already in `errors`.
      const relPath = writeResult.pagePaths[page.id];
      if (!relPath) continue;
      // An incremental run that did not fetch a page cannot rewrite it: the content on disk is
      // the last one we extracted, and rewriting it from a reused stub would erase it.
      const content = incrementalPages.has(page.id)
        ? await readFile(join(outDir, relPath), "utf8")
        : undefined;
      if (content === undefined) {
        pagesSkipped++;
        continue;
      }
      const changed = db.setHash(page.id, contentHash(content), relPath);
      if (changed) pagesWritten++;
      else pagesSkipped++;
    }

    // Tombstone deleted pages — but ONLY when this run saw the whole workspace.
    // A run that failed, aborted, was restricted to `--root`, or used a time filter has a partial
    // "live" set; treating "not seen this time" as "deleted" would overwrite good backups.
    // The extractor cannot tell "the backup on disk is stale" from "the page was deleted", so with
    // a cursor the safe direction is to leave the file alone (`--full` reconciles deletions).
    const sawWholeWorkspace =
      extraction.ok &&
      !extraction.aborted &&
      !incrementalPagesPartial &&
      !(roots && roots.length > 0);
    const liveIds = new Set(workspace.pages.map((p) => p.id));
    const accessLostIds = new Set(
      extraction.errors
        .filter((e) => e.code === "page_failed" && /restricted_resource/.test(e.message))
        .map((e) => e.id),
    );
    const deletedIds = sawWholeWorkspace
      ? db.findDeleted(liveIds).filter((id) => !accessLostIds.has(id))
      : [];
    for (const id of deletedIds) {
      const rec = storedHashes.get(id);
      if (!rec) continue;
      try {
        await writeFile(join(outDir, rec.path), TOMBSTONE_MARKER(id), "utf8");
      } catch {
        // If the original path no longer exists, write to a dedicated tombstone dir.
        const fallback = join(outDir, "_deleted", `${id}.md`);
        await mkdir(join(outDir, "_deleted"), { recursive: true });
        await writeFile(fallback, TOMBSTONE_MARKER(id), "utf8");
      }
    }
    if (deletedIds.length > 0) {
      for (const id of deletedIds) db.setAccessStatus(id, "deleted");
      db.deleteHashes(deletedIds);
    }

    for (const id of accessLostIds) {
      const rec = storedHashes.get(id);
      if (!rec) continue;
      try {
        const path = join(outDir, rec.path);
        const content = await readFile(path, "utf8");
        await writeFile(path, addAccessLostMetadata(content, startedAt), "utf8");
        db.setAccessStatus(id, "access_lost");
      } catch {
        // Preserve the original file if it cannot be read or updated.
      }
    }

    const pagesUnchangedSkipped = workspace.pages.filter((p) => !fetchedIds.has(p.id)).length;

    const counts: RunCounts = {
      pagesLive: workspace.pages.length,
      pagesWritten,
      pagesSkipped,
      pagesUnchangedSkipped,
      pagesDeleted: deletedIds.length,
      databaseFilesWritten: writeResult.filesWritten.filter((f) => f.endsWith(".csv")).length,
      assetsDownloaded: extraction.stats.assetsDownloaded,
      ignoredPages: 0,
      redactions: writeResult.redactions ?? 0,
      apiRequests: extraction.stats.requests,
      apiRetries: extraction.stats.retries,
      apiRateLimited: extraction.stats.rateLimited,
    };

    const errors: RunIssue[] = [
      ...extraction.errors,
      ...writeResult.errors.map((e) => ({ code: "write_failed", id: e.path, message: e.error })),
      ...s3Errors,
    ];

    // Git sync. A failed commit is a failed run: the history the user relies on is missing.
    let gitCommit: RunReport["gitCommit"];
    if (useGit) {
      const doGit = deps.runGitSync ?? gitSync;
      try {
        const gc = await doGit({
          outDir,
          summary: summarize(counts),
          runTimestamp: startedAt,
        });
        gitCommit = gc ?? undefined;
      } catch (err) {
        errors.push({ code: "git_failed", id: "git", message: String(err) });
      }
    }

    const ok = extraction.ok && !extraction.aborted && errors.length === 0;

    // Cache the complete extraction only after the pipeline succeeds. It is an internal recovery
    // artifact and is intentionally not part of the rendered workspace.
    if (ok) await writeExtractionCache(outDir, extraction);

    // Advance the cursor only after all sync artifacts have been produced successfully, so a
    // failed cache write cannot make the next run skip an uncovered window.
    if (ok) db.setCursor(STATE_KEY, startedAt);

    const report = buildReport({
      startedAt,
      ok,
      incremental: isIncremental,
      incrementalExtraction: isIncremental,
      sinceTimestamp,
      nextCursor: ok ? startedAt : (sinceTimestamp ?? startedAt),
      counts,
      warnings: extraction.warnings,
      errors,
      aborted: extraction.aborted,
      gitCommit,
      outDir,
    });

    db.saveReport(report);
    await writeRunReport(outDir, report);
    return report;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function addAccessLostMetadata(content: string, at: string): string {
  const metadata = `vaultweave_access_lost: true\nvaultweave_access_lost_at: ${at}`;
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end >= 0) return `${content.slice(0, end)}\n${metadata}${content.slice(end)}`;
  }
  return `---\n${metadata}\n---\n\n${content}`;
}

function emptyCounts(): RunCounts {
  return {
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
  };
}

function summarize(c: RunCounts): string {
  const parts: string[] = [`${c.pagesLive} pages`];
  if (c.pagesWritten > 0) parts.push(`${c.pagesWritten} changed`);
  if (c.pagesUnchangedSkipped > 0) parts.push(`${c.pagesUnchangedSkipped} unchanged`);
  if (c.pagesDeleted > 0) parts.push(`${c.pagesDeleted} deleted`);
  if (c.databaseFilesWritten > 0) parts.push(`${c.databaseFilesWritten} db files`);
  return parts.join(", ");
}

/** Atomic (tmp + rename) so a monitor polling the file never reads half a report. */
async function writeRunReport(outDir: string, report: RunReport): Promise<void> {
  const path = join(outDir, ".vaultweave-run-report.json");
  const tmp = `${path}.partial`;
  await writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
