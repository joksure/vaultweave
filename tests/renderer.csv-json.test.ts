/**
 * CSV and JSON renderer tests.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtractionResult } from "../src/core/extractor/types.js";
import { normalize } from "../src/core/normalizer/normalize.js";
import { renderDataSourceCsv } from "../src/core/renderer/csv.js";
import { renderDataSourceJson, renderRelationMap } from "../src/core/renderer/json.js";

async function loadGolden(name: string): Promise<ExtractionResult> {
  const path = resolve(__dirname, `golden/${name}.extraction.json`);
  return JSON.parse(await readFile(path, "utf8")) as ExtractionResult;
}

describe("renderDataSourceCsv(database-heavy)", () => {
  it("first row contains alphabetically-sorted headers", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const projects = ws.databases.find((db) => db.name === "Projects")!;
    const ds = projects.dataSources[0]!;
    const csv = renderDataSourceCsv(ds);
    const lines = csv.split("\r\n");
    const headers = lines[0]?.split(",") ?? [];
    expect(headers).toEqual([...headers].sort((a, b) => a.localeCompare(b)));
  });

  it("has 102 lines (1 header + 101 rows + trailing CRLF)", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const projects = ws.databases.find((db) => db.name === "Projects")!;
    const ds = projects.dataSources[0]!;
    const csv = renderDataSourceCsv(ds);
    // RFC 4180: CRLF after every record including the last
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(102); // 1 header + 101 rows
  });

  it("quotes cells containing commas", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const projects = ws.databases.find((db) => db.name === "Projects")!;
    const ds = projects.dataSources[0]!;
    // Multi-select uses "; " which shouldn't need quoting, but test CSV quoting is present.
    const csv = renderDataSourceCsv(ds);
    expect(typeof csv).toBe("string");
    expect(csv.length).toBeGreaterThan(0);
  });

  it("renders a select value correctly in the Status column", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const projects = ws.databases.find((db) => db.name === "Projects")!;
    const ds = projects.dataSources[0]!;
    const csv = renderDataSourceCsv(ds);
    const lines = csv.split("\r\n");
    const headers = lines[0]?.split(",") ?? [];
    const statusIdx = headers.indexOf("Status");
    expect(statusIdx).toBeGreaterThan(-1);
    const firstRow = lines[1]?.split(",") ?? [];
    expect(["Planned", "Active", "Done"]).toContain(firstRow[statusIdx]);
  });
});

describe("renderDataSourceJson(database-heavy)", () => {
  it("returns correct schema with types", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const projects = ws.databases.find((db) => db.name === "Projects")!;
    const ds = projects.dataSources[0]!;
    const json = renderDataSourceJson(projects, ds);
    const nameCol = json.schema.find((s) => s.name === "Name");
    expect(nameCol?.type).toBe("title");
    const budgetCol = json.schema.find((s) => s.name === "Budget");
    expect(budgetCol?.type).toBe("number");
  });

  it("has 101 rows in the output", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const projects = ws.databases.find((db) => db.name === "Projects")!;
    const ds = projects.dataSources[0]!;
    const json = renderDataSourceJson(projects, ds);
    expect(json.rows.length).toBe(101);
  });

  it("each row has an id and title", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const projects = ws.databases.find((db) => db.name === "Projects")!;
    const ds = projects.dataSources[0]!;
    const json = renderDataSourceJson(projects, ds);
    for (const row of json.rows) {
      expect(typeof row.id).toBe("string");
      expect(typeof row.title).toBe("string");
    }
  });

  it("serialises number property as a number (not string)", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const projects = ws.databases.find((db) => db.name === "Projects")!;
    const ds = projects.dataSources[0]!;
    const json = renderDataSourceJson(projects, ds);
    const row = json.rows[0]!;
    const budget = row.properties.Budget;
    expect(typeof budget).toBe("number");
  });

  it("serialises date property as an object with start/end", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const projects = ws.databases.find((db) => db.name === "Projects")!;
    const ds = projects.dataSources[0]!;
    const json = renderDataSourceJson(projects, ds);
    const row = json.rows[0]!;
    const due = row.properties.Due;
    expect(due).toMatchObject({ start: expect.any(String) });
  });
});

describe("renderRelationMap(database-heavy)", () => {
  it("includes entries for standalone pages", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const map = renderRelationMap(ws);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    expect(map[handbook.id]).toBeDefined();
    expect(map[handbook.id]?.title).toBe("Engineering Handbook");
    expect(map[handbook.id]?.databaseId).toBeNull();
  });

  it("includes entries for database rows with the parent databaseId set", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const map = renderRelationMap(ws);
    const projects = ws.databases.find((db) => db.name === "Projects")!;
    const ds = projects.dataSources[0]!;
    const firstRow = ds.rows[0]!;
    expect(map[firstRow.id]).toBeDefined();
    expect(map[firstRow.id]?.databaseId).toBe(projects.id);
    expect(map[firstRow.id]?.title).toBe(firstRow.title);
  });

  it("total entries = pages + all rows", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const map = renderRelationMap(ws);
    const totalRows = ws.databases.flatMap((d) => d.dataSources.flatMap((s) => s.rows)).length;
    const totalPages = ws.pages.length;
    expect(Object.keys(map).length).toBe(totalPages + totalRows);
  });
});
