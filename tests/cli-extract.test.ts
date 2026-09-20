import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ExtractDeps, runExtract } from "../src/cli/extract.js";
import type { ExtractionResult } from "../src/core/extractor/index.js";

const stats = {
  requests: 5,
  retries: 1,
  rateLimited: 1,
  failures: 0,
  assetsDownloaded: 0,
  assetBytes: 0,
  assetUrlRefreshes: 0,
};
const counts = { pages: 2, databases: 1, dataSources: 1, rows: 3, blocks: 10, views: 2, assets: 0 };

function result(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    pages: [],
    databases: [],
    assets: [],
    warnings: [],
    errors: [],
    ok: true,
    stats: { ...stats, counts },
    ...over,
  };
}

async function run(
  extractResult: ExtractionResult,
  opts: Parameters<typeof runExtract>[0] = {},
  env: Record<string, string> = { VAULTWEAVE_TOKEN: "secret_env" },
) {
  const outDir = await mkdtemp(join(tmpdir(), "np-cli-"));
  const seen: { token?: string; outDir?: string; roots?: string[]; rowBodies?: boolean } = {};
  let stdout = "";
  let stderr = "";
  const deps: ExtractDeps = {
    env,
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    createExtractor: (o) => {
      Object.assign(seen, { token: o.token, outDir: o.outDir, rowBodies: o.rowBodies });
      return {
        extract: async (e) => {
          seen.roots = e.roots;
          return extractResult;
        },
      };
    },
  };
  const code = await runExtract({ out: outDir, ...opts }, deps);
  return { code, stdout, stderr, outDir, seen };
}

describe("vaultweave extract", () => {
  it("exits 0, writes extraction.json, and prints a summary on a complete run", async () => {
    const { code, stdout, outDir } = await run(result());
    expect(code).toBe(0);
    expect(stdout).toContain(
      "Extracted 2 pages, 1 databases (3 rows, 2 views), 10 blocks, 0 files",
    );
    expect(stdout).toContain("API requests: 5 (retries: 1, rate-limited: 1)");
    expect(stdout).not.toContain("INCOMPLETE");
    const written = JSON.parse(await readFile(join(outDir, "extraction.json"), "utf8"));
    expect(written.ok).toBe(true);
  });

  it("exits 1 and says the backup is incomplete when anything failed", async () => {
    const { code, stdout } = await run(
      result({
        ok: false,
        errors: [{ code: "asset_download_failed", id: "abc", message: "HTTP 404" }],
      }),
    );
    expect(code).toBe(1);
    expect(stdout).toContain("✖ asset_download_failed abc: HTTP 404");
    expect(stdout).toContain("INCOMPLETE");
  });

  it("exits 1 on an aborted run and still writes what it gathered", async () => {
    const { code, stdout, outDir } = await run(
      result({ ok: false, aborted: "Notion unreachable" }),
    );
    expect(code).toBe(1);
    expect(stdout).toContain("ABORTED: Notion unreachable");
    expect(JSON.parse(await readFile(join(outDir, "extraction.json"), "utf8")).aborted).toBe(
      "Notion unreachable",
    );
  });

  it("shows warnings without failing", async () => {
    const { code, stdout } = await run(
      result({ warnings: [{ code: "orphan_page", id: "p1", message: "standalone" }] }),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Warnings: 1");
    expect(stdout).toContain("⚠ orphan_page p1");
  });

  it("caps long issue lists", async () => {
    const errors = Array.from({ length: 30 }, (_, i) => ({
      code: "x",
      id: `id${i}`,
      message: "m",
    }));
    const { stdout } = await run(result({ ok: false, errors }));
    expect(stdout).toContain("… and 10 more");
    expect(stdout).not.toContain("id25");
  });

  it("refuses to run without a token", async () => {
    const { code, stderr } = await run(result(), {}, {});
    expect(code).toBe(1);
    expect(stderr).toContain("No Notion token");
  });

  it("prefers --token over the environment, and forwards roots and row-body choice", async () => {
    const { seen } = await run(result(), {
      token: "secret_flag",
      root: ["a", "b"],
      rowBodies: false,
    });
    expect(seen).toMatchObject({ token: "secret_flag", roots: ["a", "b"], rowBodies: false });
  });

  it("does not pass an empty root list (that would mean 'nothing')", async () => {
    const { seen } = await run(result(), { root: [] });
    expect(seen.roots).toBeUndefined();
  });

  it("warns that the command is experimental", async () => {
    const { stderr } = await run(result());
    expect(stderr).toMatch(/EXPERIMENTAL/);
  });
});
