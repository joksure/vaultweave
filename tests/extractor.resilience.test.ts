import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { stableStringify } from "../src/core/extractor/json.js";
import type { ExtractionResult } from "../src/core/extractor/types.js";
import { databaseHeavy } from "./fixtures/database-heavy.js";
import { docsHeavy } from "./fixtures/docs-heavy.js";
import { mediaHeavy } from "./fixtures/media-heavy.js";
import { createFakeNotion, type FakeOptions } from "./support/fake-notion.js";
import { type HarnessOptions, makeHarness } from "./support/run.js";
import {
  bulleted,
  type Fixture,
  paragraph,
  syncedCopy,
  syncedOriginal,
  toggle,
  WORKSPACE_PARENT,
  World,
} from "./support/world.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function run(
  fixture: Fixture,
  fake: FakeOptions = {},
  harness: HarnessOptions = {},
  roots?: string[],
) {
  const notion = createFakeNotion(fixture.ws, fake);
  server.use(...notion.handlers);
  const h = await makeHarness(harness);
  const result = await h.extractor.extract(roots ? { roots } : {});
  return { result, notion, ...h };
}

/** Everything except run-specific bookkeeping. */
const content = (r: ExtractionResult) => {
  const { stats: _stats, ...rest } = r;
  return stableStringify(rest);
};

describe("rate limits and transient failures", () => {
  it("recovers from 429s, honours Retry-After, and produces the same result", async () => {
    const clean = await run(docsHeavy());
    const limited = await run(docsHeavy(), { rateLimitEvery: 4, retryAfterSeconds: 2 });

    expect(limited.result.ok).toBe(true);
    expect(limited.result.stats.rateLimited).toBeGreaterThan(0);
    expect(limited.result.stats.retries).toBe(limited.result.stats.rateLimited);
    expect(limited.sleeps).toContain(2000);
    expect(content(limited.result)).toBe(content(clean.result));
  });

  it("retries 5xx responses with backoff", async () => {
    const clean = await run(docsHeavy());
    const flaky = await run(docsHeavy(), {
      failures: [{ match: /children$/, status: 502, times: 3 }],
    });

    expect(flaky.result.ok).toBe(true);
    expect(flaky.result.stats.retries).toBe(3);
    expect(flaky.sleeps.slice(0, 3)).toEqual([500, 1000, 2000]);
    expect(content(flaky.result)).toBe(content(clean.result));
  });
});

describe("failing loudly", () => {
  it("aborts immediately on a bad token, without retrying", async () => {
    const { result, notion } = await run(docsHeavy(), {}, { token: "secret_wrong" });
    expect(result.ok).toBe(false);
    expect(result.aborted).toMatch(/unauthorized/);
    expect(result.pages).toEqual([]);
    expect(notion.log).toHaveLength(1);
  });

  it("reports a failed search as an abort, not an exception", async () => {
    const { result } = await run(
      docsHeavy(),
      { failures: [{ match: /search/, status: 503, times: 999 }] },
      { maxRetries: 1 },
    );
    expect(result.ok).toBe(false);
    expect(result.aborted).toMatch(/^Search failed/);
  });

  it("opens the circuit breaker when Notion is clearly down, instead of hammering it", async () => {
    const fixture = docsHeavy();
    const ids = [1, 2, 3, 4, 5].map((n) => `77777777-0000-4000-8000-00000000000${n}`);
    const { result, notion } = await run(
      fixture,
      { failures: [{ match: /./, status: 503, times: 1_000_000 }] },
      { maxRetries: 1, maxConsecutiveFailures: 3 },
      ids,
    );
    expect(result.ok).toBe(false);
    expect(result.aborted).toMatch(/consecutive/);
    expect(result.errors).toHaveLength(3); // roots 4 and 5 were never attempted
    expect(result.stats.failures).toBe(3);
    expect(notion.log).toHaveLength(3 * (1 + 1)); // 3 roots x (first try + 1 retry)
  });

  it("records an unknown root as an error and carries on", async () => {
    const { result } = await run(docsHeavy(), {}, {}, ["88888888-0000-4000-8000-000000000001"]);
    expect(result.ok).toBe(false);
    expect(result.aborted).toBeUndefined();
    expect(result.errors.map((e) => e.code)).toEqual(["database_failed"]);
  });

  it("keeps a page when one nested block's children cannot be fetched, and says so", async () => {
    const w = new World("partial");
    const toggleId = w.id("block");
    const page = w.page({ title: "Root", parent: WORKSPACE_PARENT });
    w.body(page, [
      paragraph("before"),
      toggle("Broken", [paragraph("hidden")], toggleId),
      paragraph("after"),
    ]);
    const { result } = await run(
      { name: "partial", ws: w.ws, ids: { page } },
      { failures: [{ match: new RegExp(`blocks/${toggleId}/children`), status: 404, times: 99 }] },
    );

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(["block_children_failed"]);
    const blocks = result.pages[0]?.blocks ?? [];
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "toggle", "paragraph"]);
    expect(blocks[1]?.extraction_error).toMatch(/object_not_found/);
    expect(blocks[1]?.children).toEqual([]);
  });

  it("flags a truncated relation instead of pretending it is complete", async () => {
    const fixture = databaseHeavy();
    const { result } = await run(fixture, {
      failures: [{ match: /\/properties\//, status: 404, times: 99 }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(["property_incomplete"]);
    expect(result.errors[0]?.id).toBe(fixture.ids.bigRow);
  });

  it("reports missing views as an error", async () => {
    const { result } = await run(databaseHeavy(), {
      failures: [{ match: /^GET \/v1\/views$/, status: 404, times: 99 }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.filter((e) => e.code === "views_failed")).toHaveLength(3);
  });
});

describe("files", () => {
  it("fetches a fresh URL when a signed one has expired, and the result is unchanged", async () => {
    const clean = await run(mediaHeavy());
    const expired = await run(mediaHeavy(), { expireFirstFetch: true });

    expect(expired.result.ok).toBe(true);
    expect(expired.result.stats.assetUrlRefreshes).toBe(15); // every file's first URL was rejected
    expect(expired.notion.fileLog).toHaveLength(30);
    expect(content(expired.result)).toBe(content(clean.result));
  });

  it("does not silently drop a file that has disappeared", async () => {
    const fixture = mediaHeavy();
    const { result } = await run(fixture, { missingFiles: ["clip.mp4"] });

    expect(result.aborted).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(["asset_download_failed"]);
    expect(result.errors[0]?.message).toMatch(/404/);
    expect(result.assets).toHaveLength(14);

    const video = result.pages[0]?.blocks.find((b) => b.type === "video");
    const payload = (video?.video ?? {}) as { file?: { source: string; asset: unknown } };
    expect(payload.file?.asset).toBeNull();
    expect(payload.file?.source).toBe("https://files.fixture.test/f/clip.mp4");
  });
});

describe("structure guards", () => {
  it("does not loop forever on a synced block that contains a copy of itself", async () => {
    const w = new World("cycle");
    const original = w.id("block");
    const page = w.page({ title: "Root", parent: WORKSPACE_PARENT });
    w.body(page, [syncedOriginal([paragraph("x"), syncedCopy(original)], original)]);
    const { result } = await run({ name: "cycle", ws: w.ws, ids: { page } });

    expect(result.ok).toBe(true);
    expect(result.warnings.map((x) => x.code)).toEqual(["block_cycle"]);
  });

  it("stops at the configured nesting depth and warns", async () => {
    const w = new World("deep");
    const page = w.page({ title: "Root", parent: WORKSPACE_PARENT });
    w.body(page, [
      bulleted("l0", [bulleted("l1", [bulleted("l2", [bulleted("l3", [bulleted("l4")])])])]),
    ]);
    const { result } = await run(
      { name: "deep", ws: w.ws, ids: { page } },
      {},
      { extractor: { maxDepth: 2 } },
    );

    expect(result.ok).toBe(true);
    expect(result.warnings.map((x) => x.code)).toEqual(["max_depth"]);
  });
});

describe("options", () => {
  it("can skip row bodies", async () => {
    const fixture = databaseHeavy();
    const { result, notion } = await run(fixture, {}, { extractor: { rowBodies: false } });
    expect(notion.log).not.toContain(`GET /v1/blocks/${fixture.ids.rowWithBody}/children`);
    const rows = result.databases.flatMap((d) => d.data_sources.flatMap((s) => s.rows));
    expect(rows.every((r) => r.blocks.length === 0)).toBe(true);
  });

  it("can be limited to given roots, skipping discovery", async () => {
    const fixture = docsHeavy();
    const { result, notion } = await run(fixture, {}, {}, [fixture.ids.day1 as string]);
    expect(result.pages.map((p) => p.title)).toEqual(["Day 1 checklist"]);
    expect(notion.log.some((l) => l.includes("/search"))).toBe(false);
  });

  it("reports progress for every page and database", async () => {
    const events: string[] = [];
    const { result } = await run(
      databaseHeavy(),
      {},
      { extractor: { onProgress: (e) => events.push(e.kind) } },
    );
    const { pages, databases } = result.stats.counts;
    expect(events.filter((k) => k === "page")).toHaveLength(pages);
    expect(events.filter((k) => k === "database")).toHaveLength(databases);
  });
});
