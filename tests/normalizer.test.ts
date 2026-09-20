/**
 * Normalizer golden tests.
 *
 * Loads the three golden extraction JSON files produced by M1 and verifies that
 * `normalize()` produces the expected IR shape. We don't snapshot the full IR
 * (it would be very large) — instead we assert precise structural invariants
 * that should never regress.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtractionResult } from "../src/core/extractor/types.js";
import { normalize } from "../src/core/normalizer/normalize.js";

async function loadGolden(name: string): Promise<ExtractionResult> {
  const path = resolve(__dirname, `golden/${name}.extraction.json`);
  return JSON.parse(await readFile(path, "utf8")) as ExtractionResult;
}

// ------------------------------------------------------------------ docs-heavy

describe("normalize(docs-heavy)", () => {
  it("produces one IrPage with the correct title", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook");
    expect(handbook).toBeDefined();
    expect(handbook?.isRow).toBe(false);
  });

  it("maps heading blocks to IrHeading with correct level", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const h1 = handbook.blocks.find((b) => b.type === "heading");
    expect(h1).toBeDefined();
    if (h1?.type !== "heading") throw new Error("type guard");
    expect(h1.level).toBe(1);
    expect(h1.text.map((s) => s.text).join("")).toBe("Welcome");
  });

  it("normalizes a paragraph with mixed rich-text annotations", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const para = handbook.blocks.find((b) => b.type === "paragraph");
    expect(para).toBeDefined();
    if (para?.type !== "paragraph") throw new Error("type guard");
    const boldSpan = para.text.find((s) => s.annotations.bold);
    expect(boldSpan?.text).toBe("this first");
  });

  it("normalizes a to_do block with checked=true", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const todos = handbook.blocks.filter((b) => b.type === "to_do");
    expect(todos.length).toBeGreaterThanOrEqual(2);
    const checkedTodo = todos.find((b) => b.type === "to_do" && b.checked);
    expect(checkedTodo).toBeDefined();
    const uncheckedTodo = todos.find((b) => b.type === "to_do" && !b.checked);
    expect(uncheckedTodo).toBeDefined();
  });

  it("normalizes a code block preserving language and content", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const code = handbook.blocks.find((b) => b.type === "code");
    expect(code).toBeDefined();
    if (code?.type !== "code") throw new Error("type guard");
    expect(code.language).toBe("typescript");
    expect(code.text).toContain("answer = 42");
  });

  it("normalizes a table block with table_row children", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const table = handbook.blocks.find((b) => b.type === "table");
    expect(table).toBeDefined();
    if (table?.type !== "table") throw new Error("type guard");
    expect(table.hasColumnHeader).toBe(true);
    const rows = table.children.filter((c) => c.type === "table_row");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    if (rows[0]?.type !== "table_row") throw new Error("type guard");
    const headerText = rows[0].cells.map((c) => c.map((s) => s.text).join("")).join("|");
    expect(headerText).toContain("Environment");
  });

  it("normalizes a callout block with emoji icon", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const callout = handbook.blocks.find((b) => b.type === "callout");
    expect(callout).toBeDefined();
    if (callout?.type !== "callout") throw new Error("type guard");
    expect(callout.icon?.kind).toBe("emoji");
    if (callout.icon?.kind !== "emoji") throw new Error("type guard");
    expect(callout.icon.emoji).toBe("💡");
  });

  it("normalizes a synced_block (original has syncedFromId=null)", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const synced = handbook.blocks.find((b) => b.type === "synced_block");
    expect(synced).toBeDefined();
    if (synced?.type !== "synced_block") throw new Error("type guard");
    expect(synced.syncedFromId).toBeNull();
  });

  it("normalizes an unsupported block", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const allBlocks = ws.pages.flatMap((p) => p.blocks);
    const unsupported = allBlocks.find((b) => b.type === "unsupported");
    expect(unsupported).toBeDefined();
  });

  it("preserves path hierarchy (child pages have non-trivial paths)", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const onboarding = ws.pages.find((p) => p.title === "Onboarding");
    expect(onboarding).toBeDefined();
    expect(onboarding?.path.length).toBeGreaterThan(1);
    expect(onboarding?.path[0]).toBe("Engineering Handbook");
  });
});

// ------------------------------------------------------------------ database-heavy

describe("normalize(database-heavy)", () => {
  it("produces the correct number of databases", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    expect(ws.databases.length).toBe(3);
  });

  it("each database has at least one data source", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    for (const db of ws.databases) {
      expect(db.dataSources.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("data source schema is sorted alphabetically", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const projects = ws.databases.find((db) => db.name === "Projects");
    expect(projects).toBeDefined();
    const ds = projects?.dataSources[0];
    if (!ds) throw new Error("Projects data source missing");
    const names = ds.schema.map((s) => s.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("has 101 rows in the Projects data source", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const projects = ws.databases.find((db) => db.name === "Projects");
    const ds = projects?.dataSources[0];
    if (!ds) throw new Error("Projects data source missing");
    expect(ds.rows.length).toBe(101);
  });

  it("normalizes select property correctly", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const projects = ws.databases.find((db) => db.name === "Projects")!;
    const ds = projects.dataSources[0]!;
    const row = ds.rows[0]!;
    const status = row.properties.Status;
    expect(status?.type).toBe("select");
    if (status?.type !== "select") throw new Error("type guard");
    expect(["Planned", "Active", "Done"]).toContain(status.name);
  });

  it("normalizes multi_select property correctly", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const projects = ws.databases.find((db) => db.name === "Projects")!;
    const ds = projects.dataSources[0]!;
    const row = ds.rows[0]!;
    const tags = row.properties.Tags;
    expect(tags?.type).toBe("multi_select");
    if (tags?.type !== "multi_select") throw new Error("type guard");
    expect(Array.isArray(tags.names)).toBe(true);
  });

  it("normalizes number property correctly", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const projects = ws.databases.find((db) => db.name === "Projects")!;
    const ds = projects.dataSources[0]!;
    const row = ds.rows[0]!;
    const budget = row.properties.Budget;
    expect(budget?.type).toBe("number");
    if (budget?.type !== "number") throw new Error("type guard");
    expect(typeof budget.value).toBe("number");
  });

  it("normalizes formula property to string result", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const projects = ws.databases.find((db) => db.name === "Projects")!;
    const ds = projects.dataSources[0]!;
    const row = ds.rows[0]!;
    const health = row.properties.Health;
    expect(health?.type).toBe("formula");
    if (health?.type !== "formula") throw new Error("type guard");
    expect(typeof health.result).toBe("string");
  });

  it("normalizes view stubs for views that cannot be layout-exported", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    // All databases have views extracted; they should appear as viewStubs.
    const hasViews = ws.databases.some((db) => db.viewStubs.length > 0);
    expect(hasViews).toBe(true);
  });
});

// ------------------------------------------------------------------ media-heavy

describe("normalize(media-heavy)", () => {
  it("normalizes an image block with an asset path", async () => {
    const result = await loadGolden("media-heavy");
    const ws = normalize(result);
    const gallery = ws.pages.find((p) => p.title === "Gallery")!;
    const images = gallery.blocks.filter((b) => b.type === "image");
    expect(images.length).toBeGreaterThanOrEqual(1);
    const withAsset = images.find((b) => b.type === "image" && b.assetPath !== null);
    expect(withAsset).toBeDefined();
  });

  it("normalizes an external image with externalUrl", async () => {
    const result = await loadGolden("media-heavy");
    const ws = normalize(result);
    const gallery = ws.pages.find((p) => p.title === "Gallery")!;
    const external = gallery.blocks.find((b) => b.type === "image" && b.externalUrl !== null);
    expect(external).toBeDefined();
    if (external?.type !== "image") throw new Error("type guard");
    expect(external.externalUrl).toContain("example.com");
  });

  it("normalizes a files property in a database row", async () => {
    const result = await loadGolden("media-heavy");
    const ws = normalize(result);
    const assetsDb = ws.databases.find((db) => db.name === "Assets")!;
    const ds = assetsDb.dataSources[0]!;
    const brandKit = ds.rows.find((r) => r.title === "Brand kit");
    expect(brandKit).toBeDefined();
    const files = brandKit?.properties.Files;
    expect(files?.type).toBe("files");
    if (files?.type !== "files") throw new Error("type guard");
    expect(files.names.length).toBeGreaterThan(0);
  });

  it("normalizes a page icon of type file", async () => {
    const result = await loadGolden("media-heavy");
    const ws = normalize(result);
    const gallery = ws.pages.find((p) => p.title === "Gallery");
    expect(gallery).toBeDefined();
    expect(gallery?.icon).toBeDefined();
    expect(gallery?.icon?.kind).toBe("file");
  });
});
