/**
 * Filesystem target tests.
 *
 * Exercises `writeWorkspace()` against the golden extraction fixtures to verify
 * that files are created in the expected locations with the expected content.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtractionResult } from "../src/core/extractor/types.js";
import { normalize } from "../src/core/normalizer/normalize.js";
import { writeWorkspace } from "../src/targets/filesystem.js";

async function loadGolden(name: string): Promise<ExtractionResult> {
  const path = resolve(__dirname, `golden/${name}.extraction.json`);
  return JSON.parse(await readFile(path, "utf8")) as ExtractionResult;
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "np-fs-"));
}

async function read(dir: string, rel: string): Promise<string> {
  return readFile(join(dir, rel), "utf8");
}

// ------------------------------------------------------------------ docs-heavy

describe("writeWorkspace(docs-heavy)", () => {
  it("writes Engineering Handbook.md at the root", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const dir = await tempDir();
    const { filesWritten, errors } = await writeWorkspace(ws, { outDir: dir });
    expect(errors).toEqual([]);
    const handbook = filesWritten.find(
      (f) => f.includes("Engineering Handbook") && f.endsWith(".md"),
    );
    expect(handbook).toBeDefined();
  });

  it("writes a nested child page inside a subdirectory", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const dir = await tempDir();
    const { filesWritten, errors } = await writeWorkspace(ws, { outDir: dir });
    expect(errors).toEqual([]);
    const onboarding = filesWritten.find((f) => f.includes("Onboarding") && f.endsWith(".md"));
    expect(onboarding).toBeDefined();
    // Should be nested under Engineering Handbook
    expect(onboarding).toContain("Engineering Handbook");
  });

  it("writes relations.json at root", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const dir = await tempDir();
    const { filesWritten, errors } = await writeWorkspace(ws, { outDir: dir });
    expect(errors).toEqual([]);
    expect(filesWritten).toContain("relations.json");
    const rel = JSON.parse(await read(dir, "relations.json"));
    expect(typeof rel).toBe("object");
    expect(Object.keys(rel).length).toBeGreaterThan(0);
  });

  it("handbook MD file contains frontmatter and headings", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const dir = await tempDir();
    const { filesWritten, errors } = await writeWorkspace(ws, { outDir: dir });
    expect(errors).toEqual([]);
    const rel = filesWritten.find(
      (f) => f.includes("Engineering Handbook") && !f.includes("/") && f.endsWith(".md"),
    )!;
    const content = await read(dir, rel);
    expect(content).toContain("---");
    expect(content).toContain("# Welcome");
  });
});

// ------------------------------------------------------------------ database-heavy

describe("writeWorkspace(database-heavy)", () => {
  it("writes CSV and JSON files for each data source", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const dir = await tempDir();
    const { filesWritten, errors } = await writeWorkspace(ws, { outDir: dir });
    expect(errors).toEqual([]);
    const csvFiles = filesWritten.filter((f) => f.endsWith(".csv"));
    const jsonFiles = filesWritten.filter((f) => f.endsWith(".rows.json"));
    expect(csvFiles.length).toBeGreaterThanOrEqual(1);
    expect(jsonFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("CSV files are placed under a database-named subdirectory", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const dir = await tempDir();
    const { filesWritten, errors } = await writeWorkspace(ws, { outDir: dir });
    expect(errors).toEqual([]);
    const projectsCsv = filesWritten.find((f) => f.includes("Projects") && f.endsWith(".csv"));
    expect(projectsCsv).toBeDefined();
    // Should be nested: "Projects/Projects.csv" or similar
    expect(projectsCsv?.split("/").length).toBeGreaterThanOrEqual(2);
  });

  it("writes a view stub file for each database with views", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const dir = await tempDir();
    const { filesWritten, errors } = await writeWorkspace(ws, { outDir: dir });
    expect(errors).toEqual([]);
    const viewFiles = filesWritten.filter((f) => f.endsWith("_views.md"));
    expect(viewFiles.length).toBeGreaterThan(0);
    // View stub file should contain NOT BACKED UP comment
    const content = await read(dir, viewFiles[0]!);
    expect(content).toContain("NOT BACKED UP");
  });

  it("Projects CSV has 101 data rows + 1 header", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const dir = await tempDir();
    const { filesWritten, errors } = await writeWorkspace(ws, { outDir: dir });
    expect(errors).toEqual([]);
    const projectsCsv = filesWritten.find((f) => f.includes("Projects") && f.endsWith(".csv"))!;
    const content = await read(dir, projectsCsv);
    const lines = content.split("\r\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(102); // header + 101 rows
  });

  it("rows JSON is valid JSON with the expected structure", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const dir = await tempDir();
    const { filesWritten, errors } = await writeWorkspace(ws, { outDir: dir });
    expect(errors).toEqual([]);
    const jsonFile = filesWritten.find((f) => f.includes("Projects") && f.endsWith(".rows.json"))!;
    const json = JSON.parse(await read(dir, jsonFile));
    expect(json).toHaveProperty("schema");
    expect(json).toHaveProperty("rows");
    expect(Array.isArray(json.rows)).toBe(true);
  });

  it("relations.json maps row IDs to titles and databaseIds", async () => {
    const result = await loadGolden("database-heavy");
    const ws = normalize(result);
    const dir = await tempDir();
    const { filesWritten, errors } = await writeWorkspace(ws, { outDir: dir });
    expect(errors).toEqual([]);
    expect(filesWritten).toContain("relations.json");
    const rel = JSON.parse(await read(dir, "relations.json"));
    const entries = Object.values(rel) as Array<{ title: string; databaseId: string | null }>;
    const rowEntries = entries.filter((e) => e.databaseId !== null);
    expect(rowEntries.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ path sanitisation

describe("sanitizeSegment", () => {
  it("handles the reserved names test in isolation", async () => {
    const { sanitizeSegment } = await import("../src/targets/filesystem.js");
    expect(sanitizeSegment("con")).toBe("_con");
    expect(sanitizeSegment("NUL")).toBe("_NUL");
    expect(sanitizeSegment("prn.txt")).toBe("_prn.txt");
  });

  it("strips leading dots", async () => {
    const { sanitizeSegment } = await import("../src/targets/filesystem.js");
    expect(sanitizeSegment("...hidden")).toBe("hidden");
  });

  it("caps segment length at 80 chars", async () => {
    const { sanitizeSegment } = await import("../src/targets/filesystem.js");
    const long = "a".repeat(120);
    expect(sanitizeSegment(long).length).toBeLessThanOrEqual(80);
  });

  it("removes path separator characters", async () => {
    const { sanitizeSegment } = await import("../src/targets/filesystem.js");
    expect(sanitizeSegment("foo/bar")).not.toContain("/");
    expect(sanitizeSegment("foo\\bar")).not.toContain("\\");
  });
});
