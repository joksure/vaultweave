import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { stableStringify } from "../src/core/extractor/json.js";
import type { ExtractedBlock, ExtractionResult } from "../src/core/extractor/types.js";
import { FIXTURES } from "./fixtures/index.js";
import { createFakeNotion } from "./support/fake-notion.js";
import { makeHarness } from "./support/run.js";
import type { Fixture } from "./support/world.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function walkBlocks(blocks: ExtractedBlock[], visit: (b: ExtractedBlock) => void): void {
  for (const b of blocks) {
    visit(b);
    walkBlocks(b.children, visit);
  }
}

/** Every page, including database rows. */
function allPages(result: ExtractionResult) {
  const rows = result.databases.flatMap((d) => d.data_sources.flatMap((s) => s.rows));
  return [...result.pages, ...rows];
}

/** Every `asset` reference found anywhere in the extraction. */
function assetRefs(node: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) for (const x of node) assetRefs(x, out);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "asset") out.push(v);
      else assetRefs(v, out);
    }
  }
  return out;
}

async function extractFixture(fixture: Fixture, searchOrder: "asc" | "desc" = "asc") {
  const fake = createFakeNotion(fixture.ws, { searchOrder });
  server.use(...fake.handlers);
  const h = await makeHarness();
  const result = await h.extractor.extract();
  return { result, fake, ...h };
}

for (const { name, build } of FIXTURES) {
  describe(`golden: ${name}`, () => {
    it("matches the golden extraction", async () => {
      const { result } = await extractFixture(build());
      expect(result.errors).toEqual([]);
      expect(result.aborted).toBeUndefined();
      expect(result.ok).toBe(true);
      await expect(stableStringify(result)).toMatchFileSnapshot(`./golden/${name}.extraction.json`);
    });

    it("upholds the invariants that do not depend on the golden file", async () => {
      const fixture = build();
      const { result, fake, dir } = await extractFixture(fixture);

      // Completeness: every page and every block of the workspace is present exactly once by id.
      const pageIds = allPages(result).map((p) => p.id);
      expect(new Set(pageIds).size).toBe(pageIds.length);
      expect(new Set(pageIds)).toEqual(new Set(fixture.ws.pages.keys()));

      const blockIds = new Set<string>();
      for (const p of allPages(result)) walkBlocks(p.blocks, (b) => blockIds.add(b.id));
      expect(blockIds).toEqual(new Set(fixture.ws.blockIndex.keys()));

      // Signed URLs must never be persisted.
      const json = stableStringify(result);
      expect(json).not.toMatch(/X-Sig|X-Expires|expiry_time/);

      // Assets: present on disk, hash/size verified, confined to the assets directory, none missing.
      const known = new Map(result.assets.map((a) => [a.path, a]));
      for (const asset of result.assets) {
        const abs = resolve(dir, asset.path);
        expect(abs.startsWith(resolve(dir, "assets") + sep)).toBe(true);
        expect(asset.path).toMatch(/^assets\/[0-9a-f]{16}-[^/\\]+$/);
        const data = await readFile(abs);
        expect(createHash("sha256").update(data).digest("hex")).toBe(asset.sha256);
        expect(data.byteLength).toBe(asset.bytes);
      }
      for (const ref of assetRefs(result)) {
        expect(ref).not.toBeNull();
        expect(known.has((ref as { path: string }).path)).toBe(true);
      }

      // Accounting: what the client counted is what the server saw; nothing needed a retry.
      expect(result.stats.requests).toBe(fake.log.length);
      expect(result.stats.retries).toBe(0);
    });

    it("does not depend on the order Notion returns search results in", async () => {
      const a = await extractFixture(build(), "asc");
      const b = await extractFixture(build(), "desc");
      expect(stableStringify(b.result)).toBe(stableStringify(a.result));
    });
  });
}

describe("docs-heavy specifics", () => {
  it("handles nesting, synced blocks, pagination and orphans", async () => {
    const fixture = FIXTURES[0]?.build() as Fixture;
    const { result, fake } = await extractFixture(fixture);
    const { ids } = fixture;
    const byId = new Map(result.pages.map((p) => [p.id, p]));

    // Long page: 105 blocks in original order, fetched with two list calls (100 + 5).
    const changelog = byId.get(ids.changelog as string);
    expect(changelog?.blocks).toHaveLength(105);
    expect(
      changelog?.blocks.map(
        (b) =>
          (b.paragraph as { rich_text: Array<{ plain_text: string }> }).rich_text[0]?.plain_text,
      ),
    ).toEqual(Array.from({ length: 105 }, (_, i) => `Entry ${String(i + 1).padStart(3, "0")}`));
    expect(fake.log.filter((l) => l === `GET /v1/blocks/${ids.changelog}/children`)).toHaveLength(
      2,
    );

    // child_page blocks are separate resources: their id is listed once (as the page body), never as block children.
    for (const key of ["onboarding", "runbooks", "hidden", "day1"]) {
      expect(
        fake.log.filter((l) => l === `GET /v1/blocks/${ids[key]}/children`),
        key,
      ).toHaveLength(1);
    }

    // A duplicate synced block carries the original's content.
    const copy = byId.get(ids.onboarding as string)?.blocks.find((b) => b.type === "synced_block");
    const original = byId.get(ids.handbook as string)?.blocks.find((b) => b.id === ids.synced);
    expect(copy?.children.length).toBeGreaterThan(0);
    expect(copy?.children.map((c) => c.id)).toEqual(original?.children.map((c) => c.id));

    // Page nested inside a toggle is found through the block tree.
    expect(byId.has(ids.hidden as string)).toBe(true);

    expect(result.warnings.map((w) => w.code)).toEqual(["orphan_page", "unsupported_block"]);
    expect(result.warnings.find((w) => w.code === "orphan_page")?.id).toBe(ids.orphan);
  });
});

describe("database-heavy specifics", () => {
  it("paginates rows, completes truncated relations, and exports views", async () => {
    const fixture = FIXTURES[1]?.build() as Fixture;
    const { result, fake } = await extractFixture(fixture);
    const { ids } = fixture;
    const dbs = new Map(result.databases.map((d) => [d.id, d]));

    const projects = dbs.get(ids.projectsDb as string)?.data_sources[0];
    expect(projects?.rows).toHaveLength(101);
    expect(projects?.rows.map((r) => r.title).slice(0, 2)).toEqual(["Project 001", "Project 002"]);
    expect(projects?.rows.at(-1)?.title).toBe("Project 101");
    expect(
      fake.log.filter((l) => l === `POST /v1/data_sources/${ids.projectsDs}/query`),
    ).toHaveLength(2);

    const big = projects?.rows.find((r) => r.id === ids.bigRow);
    const props = (big?.properties ?? {}) as Record<
      string,
      { relation: unknown[]; has_more: boolean }
    >;
    const rel = props.Tasks;
    expect(rel?.relation).toHaveLength(30);
    expect(rel?.has_more).toBe(false);
    expect(fake.log.filter((l) => l.includes("/properties/"))).toHaveLength(1);

    // Each database is fetched once even though it is reachable from search AND a child_database block.
    for (const key of ["projectsDb", "tasksDb", "multiDb"]) {
      expect(
        fake.log.filter((l) => l === `GET /v1/databases/${ids[key]}`),
        key,
      ).toHaveLength(1);
    }
    expect(dbs.get(ids.multiDb as string)?.data_sources.map((d) => d.name)).toEqual([
      "Alpha",
      "Beta",
    ]);

    const viewTypes = (id: string) => dbs.get(id)?.views.map((v) => v.type);
    expect(viewTypes(ids.projectsDb as string)).toEqual(["table", "board", "calendar"]);
    expect(result.stats.counts.views).toBe(5);

    // A row's body is extracted, including the page nested in it.
    const withBody = projects?.rows.find((r) => r.id === ids.rowWithBody);
    expect(withBody?.blocks.map((b) => b.type)).toEqual(["paragraph", "child_page"]);
    expect(result.pages.some((p) => p.id === ids.kickoff)).toBe(true);
  });
});

describe("media-heavy specifics", () => {
  it("stores content once, sanitises names, and leaves external links alone", async () => {
    const fixture = FIXTURES[2]?.build() as Fixture;
    const { result, fake } = await extractFixture(fixture);

    // 15 signed URLs were fetched. Two pairs carry identical bytes under different names:
    // they stay separate files but share a sha256 (13 distinct contents).
    expect(fake.fileLog).toHaveLength(15);
    expect(result.assets).toHaveLength(15);
    expect(new Set(result.assets.map((a) => a.sha256)).size).toBe(13);
    expect(result.stats.assetsDownloaded).toBe(15);

    const paths = result.assets.map((a) => a.path);
    expect(paths.some((p) => p.endsWith("-passwd"))).toBe(true); // "../../etc/passwd" -> "passwd"
    expect(paths.some((p) => p.endsWith("-Résumé 日本語.pdf"))).toBe(true);
    expect(paths.every((p) => !p.includes(".."))).toBe(true);

    const json = stableStringify(result);
    expect(json).toContain("https://example.com/remote.png"); // external image untouched
    expect(json).toContain("https://files.fixture.test/f/photo-a.png"); // `source` keeps the unsigned URL
  });
});
