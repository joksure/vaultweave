import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, createNotionApi } from "../../src/core/extractor/api.js";
import { AssetDownloader } from "../../src/core/extractor/assets.js";
import { RequestExecutor } from "../../src/core/extractor/executor.js";
import {
  OfficialExtractor,
  type OfficialExtractorOptions,
} from "../../src/core/extractor/official.js";
import { TokenBucket } from "../../src/core/ratelimit.js";
import { FIXTURE_TOKEN } from "./world.js";

export interface HarnessOptions {
  token?: string;
  maxRetries?: number;
  maxConsecutiveFailures?: number;
  extractor?: Partial<OfficialExtractorOptions>;
}

/** An extractor wired to the real SDK, with pacing/sleeping made instant so tests run fast. */
export async function makeHarness(opts: HarnessOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "np-extract-"));
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  const executor = new RequestExecutor({
    limiter: new TokenBucket({ ratePerSecond: 1_000_000, burst: 1_000_000 }),
    maxRetries: opts.maxRetries,
    maxConsecutiveFailures: opts.maxConsecutiveFailures,
    sleep,
  });
  const assets = new AssetDownloader({ dir: join(dir, "assets"), sleep });
  const api = createNotionApi(createClient(opts.token ?? FIXTURE_TOKEN));
  const extractor = new OfficialExtractor({ api, assets, executor, ...opts.extractor });
  return { dir, extractor, executor, assets, sleeps };
}
