/** `sheaf verify` — read-only verification of rendered Markdown against live Notion. */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { ConfigError } from "../config.js";
import { EXIT } from "../core/exit-codes.js";
import type { ExtractionResult } from "../core/extractor/index.js";
import {
  createOfficialExtractor,
  type ExtractionOptions,
  type ProgressEvent,
} from "../core/extractor/index.js";
import { normalize } from "../core/normalizer/index.js";
import { renderPageMarkdown } from "../core/renderer/markdown.js";
import { contentHash } from "../core/state/index.js";
import { buildReport, type RunIssue, type RunReport } from "../core/state/report.js";
import { pageFilePath } from "../targets/filesystem.js";
import { type ResolvedSettings, type RunOptions, resolveSettings } from "./settings.js";

export interface VerifyCommandOptions extends RunOptions {
  json?: boolean;
}

export interface VerifyDeps {
  runExtract?: (opts: {
    token: string;
    outDir: string;
    rowBodies?: boolean;
    onProgress?: (e: ProgressEvent) => void;
  }) => { extract(o: ExtractionOptions): Promise<ExtractionResult> };
}

async function markdownFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) result.push(path);
    }
  }
  await visit(root);
  return result.sort();
}

function frontmatter(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return undefined;
  const value = parseYaml(text.slice(4, end));
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function ignored(page: { id: string; title: string; path: string[] }, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return (
        new RegExp(pattern).test(page.id) ||
        new RegExp(pattern).test(page.title) ||
        new RegExp(pattern).test(page.path.join("/"))
      );
    } catch {
      return false;
    }
  });
}

function report(
  startedAt: string,
  outDir: string,
  errors: RunIssue[],
  pagesLive: number,
  pagesSkipped: number,
  apiRequests: number,
): RunReport {
  return buildReport({
    ok: errors.length === 0,
    startedAt,
    incremental: false,
    incrementalExtraction: false,
    nextCursor: startedAt,
    counts: {
      pagesLive,
      pagesWritten: 0,
      pagesSkipped,
      pagesUnchangedSkipped: 0,
      pagesDeleted: 0,
      databaseFilesWritten: 0,
      assetsDownloaded: 0,
      ignoredPages: 0,
      redactions: 0,
      apiRequests,
      apiRetries: 0,
      apiRateLimited: 0,
    },
    warnings: [],
    errors,
    outDir,
  });
}

export async function runVerifyCommand(
  opts: VerifyCommandOptions,
  env: Record<string, string | undefined> = process.env,
  deps: VerifyDeps = {},
): Promise<number> {
  const write = (s: string) => process.stdout.write(s);
  const error = (s: string) => process.stderr.write(s);
  let settings: ResolvedSettings;
  try {
    settings = await resolveSettings(opts, env);
  } catch (e) {
    if (e instanceof ConfigError) {
      error(`${e.message}\n`);
      return EXIT.FAILED;
    }
    throw e;
  }

  const startedAt = new Date().toISOString();
  const issues: RunIssue[] = [];
  let apiRequests = 0;
  let pagesLive = 0;
  let pagesSkipped = 0;
  const temp = await mkdtemp(join(tmpdir(), "sheaf-verify-"));
  try {
    const makeExtractor = deps.runExtract ?? ((o) => createOfficialExtractor(o));
    const extractor = makeExtractor({
      token: settings.token,
      outDir: temp,
      rowBodies: settings.rowBodies,
    });
    const extraction = await extractor.extract({});
    apiRequests = extraction.stats.requests;
    if (!extraction.ok || extraction.aborted) {
      for (const issue of extraction.errors)
        issues.push({ code: "notion_error", id: issue.id, message: issue.message });
      if (extraction.aborted)
        issues.push({ code: "notion_aborted", id: "workspace", message: extraction.aborted });
    }
    const workspace = normalize(extraction);
    pagesLive = workspace.pages.length;
    const seen = new Set<string>();
    const expected = new Map<string, { id: string; hash: string }>();
    for (const page of workspace.pages) {
      if (ignored(page, settings.ignore)) {
        pagesSkipped++;
        continue;
      }
      const rel = pageFilePath(page, seen);
      expected.set(rel, { id: page.id, hash: contentHash(renderPageMarkdown(page)) });
    }
    const files = await markdownFiles(settings.outDir);
    for (const file of files) {
      const rel = relative(settings.outDir, file).split(sep).join("/");
      if (rel.startsWith("_deleted/")) continue;
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (e) {
        issues.push({ code: "file_unreadable", id: rel, message: String(e) });
        continue;
      }
      const meta = frontmatter(text);
      if (!meta || typeof meta.id !== "string") {
        issues.push({
          code: "file_corrupt",
          id: rel,
          message: "missing or invalid YAML frontmatter",
        });
        continue;
      }
      const wanted = expected.get(rel);
      if (!wanted) continue;
      if (contentHash(text) !== wanted.hash)
        issues.push({
          code: "page_drift",
          id: wanted.id,
          message: `${rel} differs from live Notion content`,
        });
      else pagesSkipped++;
      expected.delete(rel);
    }
    for (const [rel, page] of expected)
      issues.push({ code: "file_missing", id: page.id, message: `missing output file ${rel}` });
  } catch (e) {
    issues.push({ code: "verify_failed", id: "verify", message: String(e) });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }

  const result = report(startedAt, settings.outDir, issues, pagesLive, pagesSkipped, apiRequests);
  if (opts.json) write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    write(
      `Verify ${result.ok ? "OK" : "FAILED"} — ${pagesSkipped} page(s) match, ${issues.length} issue(s)\n`,
    );
    for (const issue of issues) write(`  ✖ [${issue.code}] ${issue.id}: ${issue.message}\n`);
  }
  return result.ok ? EXIT.OK : EXIT.FAILED;
}

export function registerVerify(program: Command): void {
  program
    .command("verify")
    .description("Verify output files against the live Notion workspace (read-only)")
    .option("--token <token>", "Notion integration token (prefer SHEAF_TOKEN env var)")
    .option("--out <dir>", "output directory")
    .option("--config <path>", "path to .sheaf.yaml")
    .option("--json", "print the verification report as JSON")
    .action(async (opts: VerifyCommandOptions) => {
      process.exitCode = await runVerifyCommand(opts);
    });
}
