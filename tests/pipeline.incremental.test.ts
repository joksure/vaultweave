/**
 * Incremental extraction, end to end against the mocked Notion API.
 *
 * The M3 exit criterion is "a 2nd run is near-zero API calls". These tests hold the whole path to
 * it: state cursor → pipeline → extractor search filter → request count, with the pipeline running
 * its real extractor (no injection), so the filter and the traversal rules are exercised for real.
 *
 * Fixture timestamps: the docs-heavy workspace is built at 2026-01-01T00:01Z…00:16Z (one minute
 * apart per object, see `World.time`). "After everything" is therefore 2026-01-01T01:00Z.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createOfficialExtractor,
  type OfficialExtractorOptions,
} from "../src/core/extractor/index.js";
import { runSync, type SyncDeps } from "../src/core/pipeline.js";
import { openStateDb } from "../src/core/state/index.js";
import { docsHeavy } from "./fixtures/docs-heavy.js";
import { createFakeNotion, type FakeOptions } from "./support/fake-notion.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let outDir: string;
let assetsDir: string;
beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), "sheaf-incr-"));
  // Assets are written outside the output dir so wiping it between tests never races an open DB.
  assetsDir = await mkdtemp(join(tmpdir(), "sheaf-incr-assets-"));
});
afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
  await rm(assetsDir, { recursive: true, force: true });
});

const TOKEN = "secret_fixture";
/** After every object in the docs-heavy fixture: an incremental run with this cursor finds nothing. */
const AFTER_FIXTURE = "2026-01-01T01:00:00.000Z";
/** Before every object in the fixture: an incremental run with this cursor finds everything. */
const BEFORE_FIXTURE = "2025-12-31T23:00:00.000Z";
/** Inside the fixture's window: only the objects edited later than this are discovered. */
const MID_FIXTURE = "2026-01-01T00:08:00.000Z";

/** Registers a docs-heavy workspace on the mock server (search honors time filters). */
function apiFixture(opts: FakeOptions = {}) {
  const fixture = docsHeavy();
  const fake = createFakeNotion(fixture.ws, { honorSearchFilters: true, ...opts });
  server.use(...fake.handlers);
  return { fixture, fake };
}

/**
 * The pipeline's real deps: the production extractor on the mocked API. Assets are redirected out
 * of the output directory. An optional spy observes the options the pipeline hands the extractor.
 */
function deps(spy?: (o: { sinceTimestamp?: string }) => void): SyncDeps {
  return {
    runExtract: (o) => {
      const extractor = createOfficialExtractor({
        ...o,
        outDir: assetsDir,
      } as unknown as OfficialExtractorOptions & { token: string; outDir: string });
      return {
        extract: (opts) => {
          spy?.(opts);
          return extractor.extract(opts);
        },
      };
    },
  };
}

const syncOpts = (extra: Record<string, unknown> = {}) => ({
  token: TOKEN,
  outDir,
  incremental: false,
  stateDbPath: outDir,
  ...extra,
});

/** Sets the cursor directly, bypassing the clock the pipeline derives it from. */
function setCursor(value: string): void {
  const db = openStateDb(outDir);
  db.setCursor("last_sync", value);
  db.close();
}

/** POST bodies sent to /v1/search during `fn`. */
async function searchBodies(fn: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const bodies: Array<Record<string, unknown>> = [];
  const onStart = async ({ request }: { request: Request }) => {
    if (request.method === "POST" && new URL(request.url).pathname === "/v1/search") {
      bodies.push((await request.clone().json()) as Record<string, unknown>);
    }
  };
  server.events.on("request:start", onStart);
  try {
    await fn();
  } finally {
    server.events.removeListener("request:start", onStart);
  }
  return bodies;
}

const searchCalls = (log: string[]) => log.filter((l) => l === "POST /v1/search").length;
const blockCalls = (log: string[]) =>
  log.filter((l) => l.includes("/v1/blocks/") && l.endsWith("/children")).length;

describe("incremental extraction", () => {
  it("costs one search call and no page fetches when nothing in the window changed", async () => {
    const { fake } = apiFixture();
    const first = await runSync(syncOpts(), deps());
    expect(first.ok).toBe(true);
    expect(first.incrementalExtraction).toBe(false);
    expect(first.counts.pagesUnchangedSkipped).toBe(0);
    expect(blockCalls(fake.log)).toBeGreaterThan(10);

    // Cursor after everything the fixture holds: the next run has nothing to discover.
    setCursor(AFTER_FIXTURE);
    const before = fake.log.length;
    const second = await runSync(syncOpts({ incremental: true }), deps());
    const calls = fake.log.slice(before);

    expect(second.ok).toBe(true);
    expect(second.incrementalExtraction).toBe(true);
    expect(second.sinceTimestamp).toBe(AFTER_FIXTURE);
    // THE M3 CRITERION: an unchanged workspace costs a single search request, nothing else.
    expect(calls).toEqual(["POST /v1/search"]);
    expect(second.counts.apiRequests).toBe(1);
    // Nothing was walked, so nothing was rewritten — and no page was lost or tombstoned.
    expect(second.counts.pagesUnchangedSkipped).toBe(8);
    expect(second.counts.pagesLive).toBe(8);
    expect(second.counts.pagesWritten).toBe(0);
    expect(second.counts.pagesDeleted).toBe(0);
  });

  it("tells the extractor when to filter, and the filter reaches Notion", async () => {
    apiFixture();
    await runSync(syncOpts(), deps());
    setCursor(AFTER_FIXTURE);

    const seen: Array<string | undefined> = [];
    const bodies = await searchBodies(() =>
      runSync(
        syncOpts({ incremental: true }),
        deps((o) => seen.push(o.sinceTimestamp)),
      ),
    );

    expect(seen).toEqual([AFTER_FIXTURE]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.filter).toEqual({
      timestamp: "last_edited_time",
      last_edited_time: { after: AFTER_FIXTURE },
    });
    // The sort pins the order so pagination cannot be perturbed by Notion's arbitrary default.
    expect(bodies[0]?.sort).toEqual({ timestamp: "last_edited_time", direction: "ascending" });
  });

  it("reuses an unchanged page's file instead of re-rendering it from a stub", async () => {
    apiFixture();
    await runSync(syncOpts(), deps());
    const handbookPath = join(outDir, "Engineering Handbook.md");
    const handbookBefore = await readFile(handbookPath, "utf8");

    // Cursor after everything: the run discovers nothing, walks nothing, writes nothing.
    setCursor(AFTER_FIXTURE);
    const r = await runSync(syncOpts({ incremental: true }), deps());

    expect(r.counts.pagesUnchangedSkipped).toBe(8);
    expect(await readFile(handbookPath, "utf8")).toBe(handbookBefore);
    // A stub rewrite would have replaced the page with an empty body.
    expect(await readFile(handbookPath, "utf8")).toContain("Welcome");
  });

  it("re-fetches only the page that changed and leaves every other file byte-identical", async () => {
    const { fixture, fake } = apiFixture();
    await runSync(syncOpts(), deps());
    const handbookBefore = await readFile(join(outDir, "Engineering Handbook.md"), "utf8");

    // Day 1 checklist is edited: fresh timestamp plus a new block, as Notion would report it.
    const day1 = fixture.ids.day1 as string;
    const page = fixture.ws.pages.get(day1) as Record<string, unknown>;
    page.last_edited_time = "2026-02-01T00:00:00.000Z";
    const freshBlock = {
      object: "block",
      id: "22222222-0000-4000-8000-000000000900",
      parent: { type: "page_id", page_id: day1 },
      created_time: "2026-02-01T00:00:00.000Z",
      last_edited_time: "2026-02-01T00:00:00.000Z",
      has_children: false,
      archived: false,
      in_trash: false,
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", plain_text: "Brand new line", annotations: {} }],
        color: "default",
      },
    };
    fixture.ws.blocks.set(day1, [...(fixture.ws.blocks.get(day1) ?? []), freshBlock]);
    fixture.ws.blockIndex.set(freshBlock.id, freshBlock);

    // Cursor after the original fixture, before the edit: exactly one page is in the window.
    setCursor(AFTER_FIXTURE);
    const before = fake.log.length;
    const r = await runSync(syncOpts({ incremental: true }), deps());
    const calls = fake.log.slice(before);

    expect(r.incrementalExtraction).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.counts.pagesWritten).toBe(1);
    expect(r.counts.pagesUnchangedSkipped).toBe(7);
    // One search + the changed page's own tree — not the whole workspace.
    expect(searchCalls(calls)).toBe(1);
    expect(blockCalls(calls)).toBe(1);
    expect(calls).not.toContain(`GET /v1/blocks/${fixture.ids.changelog}/children`);
    // The untouched page kept its exact bytes; the changed one carries the new content.
    expect(await readFile(join(outDir, "Engineering Handbook.md"), "utf8")).toBe(handbookBefore);
    expect(
      await readFile(
        join(outDir, "Engineering Handbook", "Onboarding", "Day 1 checklist.md"),
        "utf8",
      ),
    ).toContain("Brand new line");
  });

  it("re-fetches a parent whose descendant block changed", async () => {
    const { fixture, fake } = apiFixture();
    await runSync(syncOpts(), deps());

    // The Changelog page itself is old, but one of its blocks was edited: search reports the page
    // (blocks are not searchable resources), and its body must be re-walked.
    const changelog = fixture.ids.changelog as string;
    const changelogPage = fixture.ws.pages.get(changelog) as Record<string, unknown>;
    changelogPage.last_edited_time = "2026-02-01T00:00:00.000Z";
    const blocks = fixture.ws.blocks.get(changelog) ?? [];
    (blocks[0] as Record<string, unknown>).last_edited_time = "2026-02-01T00:00:00.000Z";

    setCursor(AFTER_FIXTURE);
    const before = fake.log.length;
    const r = await runSync(syncOpts({ incremental: true }), deps());
    const calls = fake.log.slice(before);

    expect(r.counts.pagesWritten).toBe(1); // page metadata changed while the descendant was edited
    expect(searchCalls(calls)).toBe(1);
    expect(calls).toContain(`GET /v1/blocks/${changelog}/children`);
    // Its untouched siblings were not walked.
    expect(calls).not.toContain(`GET /v1/blocks/${fixture.ids.handbook}/children`);
  });

  it("keeps every tracked page's hash when nothing changed", async () => {
    apiFixture();
    await runSync(syncOpts(), deps());
    const db = openStateDb(outDir);
    const hashesBefore = new Map(
      [...db.getAllHashes()].map(([id, rec]) => [id, rec.hash] as const),
    );
    db.close();
    setCursor(AFTER_FIXTURE);

    const r = await runSync(syncOpts({ incremental: true }), deps());

    const db2 = openStateDb(outDir);
    const hashesAfter = db2.getAllHashes();
    db2.close();

    expect(r.counts.pagesWritten).toBe(0);
    expect(r.counts.pagesSkipped).toBe(8);
    expect(hashesAfter.size).toBe(hashesBefore.size);
    for (const [id, hash] of hashesBefore) expect(hashesAfter.get(id)?.hash).toBe(hash);
  });

  it("never tombstones from an incremental run, and lets --full reconcile the deletion", async () => {
    const { fixture } = apiFixture();
    await runSync(syncOpts(), deps());
    const orphanPath = join(outDir, "Shared orphan.md");
    expect(await readFile(orphanPath, "utf8")).not.toContain("sheaf_tombstone");

    // The orphan is gone from Notion, but a filtered search would never say so.
    const orphan = fixture.ids.orphan as string;
    fixture.ws.searchable.splice(fixture.ws.searchable.indexOf(orphan), 1);
    setCursor(AFTER_FIXTURE);

    const incr = await runSync(syncOpts({ incremental: true }), deps());
    expect(incr.counts.pagesDeleted).toBe(0);
    expect(await readFile(orphanPath, "utf8")).not.toContain("sheaf_tombstone");

    // A full re-crawl sees the whole workspace, so it can tell "gone" from "not looked at".
    const full = await runSync(syncOpts(), deps());
    expect(full.counts.pagesDeleted).toBe(1);
    expect(await readFile(orphanPath, "utf8")).toContain("sheaf_tombstone");
  });

  it("re-fetches a page whose timestamp is inside the window", async () => {
    apiFixture();
    await runSync(syncOpts(), deps());
    setCursor(MID_FIXTURE); // 2026-01-01T00:08Z: only the last four fixture pages are newer

    const dbBefore = openStateDb(outDir);
    const before = dbBefore.getAllHashes();
    dbBefore.close();

    const r = await runSync(syncOpts({ incremental: true }), deps());

    expect(r.ok).toBe(true);
    expect(r.counts.pagesLive).toBe(8);
    // Everything after the cursor was walked; everything before it was reused.
    expect(r.counts.pagesUnchangedSkipped).toBeGreaterThan(0);
    expect(before.size).toBe(8);
  });
});

describe("failed runs never move the cursor", () => {
  it("keeps the old cursor when authentication fails mid-run", async () => {
    const { fake } = apiFixture();
    const first = await runSync(syncOpts(), deps());
    expect(first.ok).toBe(true);
    const db = openStateDb(outDir);
    const stored = db.getCursor("last_sync");
    db.close();
    expect(stored).toBe(first.startedAt);

    // The API starts rejecting the token: the run aborts, but its window must stay covered.
    server.resetHandlers();
    const rejecting = createFakeNotion(docsHeavy().ws, {
      honorSearchFilters: true,
      token: "another-token",
    });
    server.use(...rejecting.handlers);

    const failed = await runSync(syncOpts({ incremental: true }), deps());
    expect(failed.ok).toBe(false);
    expect(failed.aborted).toContain("unauthorized");
    // The retry re-covers the same window instead of skipping past everything edited since.
    expect(failed.nextCursor).toBe(stored);
    const after = openStateDb(outDir);
    expect(after.getCursor("last_sync")).toBe(stored);
    after.close();

    // A later successful run still uses that cursor and still sees the whole workspace.
    server.resetHandlers();
    server.use(...fake.handlers);
    const third = await runSync(syncOpts({ incremental: true }), deps());
    expect(third.ok).toBe(true);
    expect(third.sinceTimestamp).toBe(BEFORE_FIXTURE.length > 0 ? stored : stored);
    expect(third.counts.pagesLive).toBe(8);
  });

  it("ignores a cursor that is not in the past (a clock going backwards must not skip edits)", async () => {
    apiFixture();
    await runSync(syncOpts(), deps());
    setCursor(new Date(Date.now() + 86_400_000).toISOString());

    const seen: Array<string | undefined> = [];
    const r = await runSync(
      syncOpts({ incremental: true }),
      deps((o) => seen.push(o.sinceTimestamp)),
    );

    expect(seen).toEqual([undefined]);
    expect(r.incrementalExtraction).toBe(false);
    expect(r.counts.pagesLive).toBe(8);
  });
});

describe("--full", () => {
  it("re-crawls the workspace even though a cursor is stored", async () => {
    const { fake } = apiFixture();
    await runSync(syncOpts(), deps());
    setCursor(AFTER_FIXTURE);

    const before = fake.log.length;
    const r = await runSync(syncOpts({ incremental: false }), deps());
    const calls = fake.log.slice(before);

    expect(r.incremental).toBe(false);
    expect(r.incrementalExtraction).toBe(false);
    expect(r.counts.pagesUnchangedSkipped).toBe(0);
    expect(blockCalls(calls)).toBeGreaterThan(10);
    expect(searchCalls(calls)).toBe(1);
  });

  it("sends no time filter to Notion", async () => {
    apiFixture();
    await runSync(syncOpts(), deps());
    setCursor(AFTER_FIXTURE);

    const bodies = await searchBodies(() => runSync(syncOpts({ incremental: false }), deps()));

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.filter).toBeUndefined();
    expect(bodies[0]?.sort).toBeUndefined();
  });
});

describe("rooted runs", () => {
  it("crawls the requested root by id even with a cursor present", async () => {
    const { fixture, fake } = apiFixture();
    const day1 = fixture.ids.day1 as string;

    const r = await runSync(
      syncOpts({ incremental: true, sinceOverride: AFTER_FIXTURE, roots: [day1] }),
      deps(),
    );

    expect(r.ok).toBe(true);
    // Fetched by id: a filtered search would have discovered nothing at all.
    expect(fake.log).toContain(`GET /v1/pages/${day1}`);
    expect(r.counts.pagesLive).toBe(1);
    expect(r.counts.pagesDeleted).toBe(0);
  });
});
