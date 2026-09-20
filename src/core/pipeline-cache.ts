import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableStringify } from "./extractor/json.js";
import type { ExtractionResult } from "./extractor/types.js";

const CACHE = ".vaultweave-extraction-cache.json";

export async function readExtractionCache(outDir: string): Promise<ExtractionResult | undefined> {
  try {
    return JSON.parse(await readFile(join(outDir, CACHE), "utf8")) as ExtractionResult;
  } catch {
    return undefined;
  }
}

export async function writeExtractionCache(
  outDir: string,
  result: ExtractionResult,
): Promise<void> {
  const path = join(outDir, CACHE);
  const tmp = `${path}.partial`;
  await writeFile(tmp, stableStringify(result), "utf8");
  await rename(tmp, path);
}

export function mergeExtractionCache(
  cached: ExtractionResult | undefined,
  fetched: ExtractionResult,
): ExtractionResult {
  if (!cached) return fetched;
  const fetchedPageIds = new Set(fetched.pages.map((p) => p.id));
  const pages = [...cached.pages.filter((p) => !fetchedPageIds.has(p.id)), ...fetched.pages];
  const fetchedDbIds = new Set(fetched.databases.map((d) => d.id));
  const databases = [
    ...cached.databases.filter((d) => !fetchedDbIds.has(d.id)),
    ...fetched.databases,
  ];
  const assets = [
    ...new Map([...cached.assets, ...fetched.assets].map((a) => [a.path, a])).values(),
  ];
  return {
    ...fetched,
    pages: pages.sort((a, b) => a.id.localeCompare(b.id)),
    databases: databases.sort((a, b) => a.id.localeCompare(b.id)),
    assets: assets.sort((a, b) => a.path.localeCompare(b.path)),
  };
}
