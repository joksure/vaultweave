/**
 * Filesystem target: writes an `IrWorkspace` to a directory as:
 *   - One `.md` per page (path mirrors workspace hierarchy).
 *   - One `.csv` per data source (under `<database-name>/`).
 *   - One `.rows.json` per data source (alongside the CSV).
 *   - One `relations.json` at the root (workspace-wide relation map).
 *   - Stub comments inside files for non-exportable content (views).
 *
 * Sanitisation:
 * - Path segments are sanitised (control chars, reserved names, length cap).
 * - Duplicate names at the same level get a `.<id-suffix>` disambiguator.
 * - No path segment can escape the root dir.
 *
 * Atomicity:
 * - Each file is written to a `.partial` temp file then renamed so the output
 *   dir is never in a half-written state from the reader's perspective.
 */

import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IrDatabase, IrPage, IrWorkspace } from "../core/normalizer/ir.js";
import { renderDataSourceCsv } from "../core/renderer/csv.js";
import { renderDataSourceJson, renderRelationMap } from "../core/renderer/json.js";
import { renderPageMarkdown } from "../core/renderer/markdown.js";

import type { SyncTarget } from "./target.js";

export class FilesystemTarget implements SyncTarget {
  constructor(private readonly root: string) {}

  async write(path: string, content: Buffer | string): Promise<void> {
    const absolute = join(this.root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }

  async delete(path: string): Promise<void> {
    await rm(join(this.root, path), { force: true });
  }

  async list(prefix = ""): Promise<string[]> {
    const output: string[] = [];
    const walk = async (dir: string, relative: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const child = join(dir, entry.name);
        if (entry.isDirectory()) await walk(child, childRelative);
        else if (childRelative.startsWith(prefix))
          output.push(childRelative.replaceAll("\\\\", "/"));
      }
    };
    try {
      await walk(this.root, "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return output.sort();
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..+)?$/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const UNSAFE_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

export function sanitizeSegment(raw: string): string {
  let s = raw.normalize("NFC").trim();
  s = s.replace(UNSAFE_CHARS, "_");
  s = s
    .replace(/^\.*/, "")
    .replace(/[. ]+$/, "")
    .trim();
  if (!s || WINDOWS_RESERVED.test(s)) s = `_${s || "untitled"}`;
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s || "untitled";
}

/** Deduplicate segments in a name-set by appending an id suffix. */
function dedup(base: string, id: string, seen: Set<string>): string {
  if (!seen.has(base)) {
    seen.add(base);
    return base;
  }
  const suffix = id.replace(/-/g, "").slice(0, 8);
  const candidate = `${base}.${suffix}`;
  seen.add(candidate);
  return candidate;
}

// ------------------------------------------------------------------ file writing

async function atomicWrite(path: string, content: string): Promise<void> {
  const partial = `${path}.partial`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(partial, content, "utf8");
  await rename(partial, path);
}

async function cleanPartial(path: string): Promise<void> {
  try {
    await rm(`${path}.partial`, { force: true });
  } catch {
    // ignore
  }
}

// ------------------------------------------------------------------ page path building

/**
 * Resolves the output file path for a page, deriving it from the page's `path` array
 * (which the normalizer built from the workspace hierarchy).
 *
 * Example: ["Engineering Handbook", "Onboarding"] → "Engineering Handbook/Onboarding.md"
 */
export function pageFilePath(page: IrPage, seenPaths: Set<string>): string {
  const segments = page.path.map((seg) => sanitizeSegment(seg));
  if (segments.length === 0) segments.push(sanitizeSegment(page.title));
  const dir = segments.slice(0, -1).join("/");
  const base = segments.at(-1) ?? "untitled";
  const candidate = dir ? `${dir}/${base}.md` : `${base}.md`;
  const deduped = dedup(candidate, page.id, seenPaths);
  return deduped;
}

/** Derives the output directory for a database's files. */
function databaseDir(db: IrDatabase, seenDirs: Set<string>): string {
  const seg = sanitizeSegment(db.name || "database");
  return dedup(seg, db.id, seenDirs);
}

// ------------------------------------------------------------------ write report

export interface WriteResult {
  /** Number of replacements made while writing text files. */
  redactions?: number;
  pagePaths: Record<string, string>;
  filesWritten: string[];
  errors: Array<{ path: string; error: string }>;
}

// ------------------------------------------------------------------ main export

export interface FilesystemTargetOptions {
  /** Absolute output directory root. */
  outDir: string;
  /** Regexes used for textual redaction. */
  redact?: string[];
}

/**
 * Writes an `IrWorkspace` to `outDir`.
 *
 * Returns a `WriteResult` listing every file written (relative to `outDir`) and
 * any per-file errors. A partial write is not considered a failure of the whole
 * run — errors are collected and returned for the run report.
 */
export async function writeWorkspace(
  workspace: IrWorkspace,
  opts: FilesystemTargetOptions,
): Promise<WriteResult> {
  const { outDir } = opts;
  const filesWritten: string[] = [];
  const pagePaths: Record<string, string> = {};
  const errors: Array<{ path: string; error: string }> = [];

  const patterns = (opts.redact ?? []).map((src) => new RegExp(src, "g"));
  let redactions = 0;
  const redactText = (content: string): string => {
    let out = content;
    for (const pattern of patterns) {
      out = out.replace(pattern, () => {
        redactions++;
        return "[REDACTED]";
      });
    }
    return out;
  };
  const write = async (relPath: string, content: string): Promise<void> => {
    const absPath = join(outDir, relPath);
    try {
      await atomicWrite(absPath, redactText(content));
      filesWritten.push(relPath);
    } catch (err) {
      errors.push({ path: relPath, error: (err as Error).message });
      await cleanPartial(absPath).catch(() => undefined);
    }
  };

  // ── Pages ──────────────────────────────────────────────────────────────────
  const seenPagePaths = new Set<string>();
  for (const page of workspace.pages) {
    const relPath = pageFilePath(page, seenPagePaths);
    const md = renderPageMarkdown(page);
    await write(relPath, md);
    if (filesWritten.at(-1) === relPath) pagePaths[page.id] = relPath;
  }

  // ── Databases ──────────────────────────────────────────────────────────────
  const seenDirs = new Set<string>();
  for (const db of workspace.databases) {
    const dir = databaseDir(db, seenDirs);

    // View stubs: write a markdown file listing what can't be exported.
    if (db.viewStubs.length > 0) {
      const stubLines = db.viewStubs.map(
        (v) => `<!-- NOT BACKED UP: database view "${v.name}" (${v.viewType}) -->`,
      );
      const stubContent = `# ${db.name} — view stubs\n\n${stubLines.join("\n")}\n`;
      await write(`${dir}/_views.md`, stubContent);
    }

    // Data sources: CSV + JSON
    const seenDs = new Set<string>();
    for (const ds of db.dataSources) {
      const dsBase = dedup(sanitizeSegment(ds.name || "data"), ds.id, seenDs);
      const csvPath = `${dir}/${dsBase}.csv`;
      const jsonPath = `${dir}/${dsBase}.rows.json`;

      await write(csvPath, renderDataSourceCsv(ds));
      await write(jsonPath, `${JSON.stringify(renderDataSourceJson(db, ds), null, 2)}\n`);
    }
  }

  // ── Relation map ───────────────────────────────────────────────────────────
  const relMap = renderRelationMap(workspace);
  await write("relations.json", `${JSON.stringify(relMap, null, 2)}\n`);

  return { redactions, pagePaths, filesWritten, errors };
}
