import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TokenBucket } from "../ratelimit.js";
import { createClient, createNotionApi } from "./api.js";
import { AssetDownloader } from "./assets.js";
import { RequestExecutor } from "./executor.js";
import { stableStringify } from "./json.js";
import { OfficialExtractor, type ProgressEvent } from "./official.js";
import type { ExtractionResult } from "./types.js";

export * from "./api.js";
export * from "./assets.js";
export * from "./executor.js";
export { stableStringify } from "./json.js";
export * from "./official.js";
export * from "./types.js";

export interface CreateExtractorOptions {
  token: string;
  /** Output directory; downloaded files go to `<outDir>/assets`. */
  outDir: string;
  /** Requests per second (Notion averages 3; default 2.5). */
  ratePerSecond?: number;
  rowBodies?: boolean;
  onProgress?: (e: ProgressEvent) => void;
}

/** Wires the official SDK client, pacing/retry executor and asset store into an extractor. */
export function createOfficialExtractor(opts: CreateExtractorOptions): OfficialExtractor {
  const api = createNotionApi(createClient(opts.token));
  const executor = new RequestExecutor({
    limiter: new TokenBucket({ ratePerSecond: opts.ratePerSecond ?? 2.5, jitterMs: 100 }),
  });
  const assets = new AssetDownloader({ dir: join(opts.outDir, "assets") });
  return new OfficialExtractor({
    api,
    assets,
    executor,
    rowBodies: opts.rowBodies,
    onProgress: opts.onProgress,
  });
}

/** Writes the extraction as byte-stable JSON (sorted keys) to `<outDir>/extraction.json`. */
export async function writeExtraction(result: ExtractionResult, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, "extraction.json");
  await writeFile(file, stableStringify(result), "utf8");
  return file;
}
