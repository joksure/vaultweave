import type { Command } from "commander";
import { ConfigError, loadConfig } from "../config.js";
import {
  createOfficialExtractor,
  type ExtractionResult,
  type ProgressEvent,
  writeExtraction,
} from "../core/extractor/index.js";

export interface ExtractOptions {
  token?: string;
  out?: string;
  config?: string;
  root?: string[];
  rowBodies?: boolean;
}

export interface ExtractorLike {
  extract(opts: { roots?: string[] }): Promise<ExtractionResult>;
}

export interface ExtractDeps {
  createExtractor?: (o: {
    token: string;
    outDir: string;
    rowBodies?: boolean;
    onProgress?: (e: ProgressEvent) => void;
  }) => ExtractorLike;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  env?: Record<string, string | undefined>;
}

const MAX_LISTED = 20;

/** Returns the process exit code: 0 only if the extraction was complete. */
export async function runExtract(opts: ExtractOptions, deps: ExtractDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((s) => process.stdout.write(s));
  const err = deps.stderr ?? ((s) => process.stderr.write(s));
  const env = deps.env ?? process.env;

  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(opts.config, env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    err(`${e.message}\n`);
    return 1;
  }

  const token = opts.token ?? config.token ?? env.SHEAF_TOKEN;
  if (!token) {
    err("No Notion token found. Set SHEAF_TOKEN (preferred) or pass --token.\n");
    return 1;
  }
  const outDir = opts.out ?? config.out;

  err("sheaf extract is EXPERIMENTAL (M1): it writes the raw extraction as JSON.\n");
  err("Markdown/CSV output arrives in M2; see CAPABILITIES.md.\n");

  let seen = 0;
  const onProgress = (e: ProgressEvent) => {
    seen++;
    if (process.stderr.isTTY && !deps.stderr)
      process.stderr.write(`\r  extracting… ${seen} (${e.kind})   `);
  };
  const make =
    deps.createExtractor ??
    ((o: Parameters<NonNullable<ExtractDeps["createExtractor"]>>[0]) => createOfficialExtractor(o));
  const extractor = make({ token, outDir, rowBodies: opts.rowBodies, onProgress });

  const result = await extractor.extract({ roots: opts.root?.length ? opts.root : undefined });
  if (process.stderr.isTTY && !deps.stderr) process.stderr.write("\r\x1b[K");
  const file = await writeExtraction(result, outDir);

  const c = result.stats.counts;
  const lines = [
    `Extracted ${c.pages} pages, ${c.databases} databases (${c.rows} rows, ${c.views} views), ${c.blocks} blocks, ${c.assets} files`,
    `API requests: ${result.stats.requests} (retries: ${result.stats.retries}, rate-limited: ${result.stats.rateLimited})`,
  ];
  const list = (title: string, items: ExtractionResult["errors"], mark: string) => {
    lines.push(`${title}: ${items.length}`);
    for (const i of items.slice(0, MAX_LISTED))
      lines.push(`  ${mark} ${i.code} ${i.id}: ${i.message}`);
    if (items.length > MAX_LISTED)
      lines.push(`  … and ${items.length - MAX_LISTED} more (see extraction.json)`);
  };
  if (result.warnings.length > 0) list("Warnings", result.warnings, "⚠");
  if (result.errors.length > 0) list("Errors", result.errors, "✖");
  if (result.aborted) lines.push(`✖ ABORTED: ${result.aborted}`);
  lines.push(`Wrote ${file}`);
  if (!result.ok) lines.push("The backup is INCOMPLETE — see the errors above.");
  out(`${lines.join("\n")}\n`);

  return result.ok ? 0 : 1;
}

export function registerExtract(program: Command): void {
  program
    .command("extract")
    .description(
      "[experimental] Extract the workspace to raw JSON + downloaded files (renderers land in M2)",
    )
    .option("--token <token>", "Notion integration token (prefer the SHEAF_TOKEN env var)")
    .option("--out <dir>", "output directory (default: config `out` or ./sheaf-backup)")
    .option("--config <path>", "path to .sheaf.yaml")
    .option(
      "--root <id>",
      "extract only this page/database ID (repeatable)",
      (v, prev: string[] = []) => [...prev, v],
    )
    .option("--no-row-bodies", "skip the page content of database rows")
    .action(async (opts: ExtractOptions) => {
      process.exitCode = await runExtract(opts);
    });
}
