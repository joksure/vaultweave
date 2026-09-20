import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSettings } from "../src/cli/settings.js";
import { runSyncCommand } from "../src/cli/sync.js";
import { runVerifyCommand } from "../src/cli/verify.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { makeReport } from "./support/report.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sheaf-cli-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const env = { SHEAF_TOKEN: "token" };

async function cfg(yaml: string): Promise<string> {
  const p = join(dir, ".sheaf.yaml");
  await writeFile(p, yaml);
  return p;
}

describe("config and settings", () => {
  it("accepts notify targets and resolves flags over config", async () => {
    expect(
      parseConfig("notify:\n  on_error: slack:https://x.example/a\n", {}).notify.on_error,
    ).toBe("slack:https://x.example/a");
    const path = await cfg("token: config-token\nout: ./from-config\n");
    expect(
      await resolveSettings({ config: path, out: "./flag", token: "flag-token" }, env),
    ).toMatchObject({ token: "flag-token", outDir: "./flag" });
  });
  it("rejects malformed config and missing token", async () => {
    expect(() => parseConfig("notify:\n  on_error: [nonsense]\n", {})).toThrow(ConfigError);
    await expect(resolveSettings({}, {})).rejects.toThrow(/No Notion token/);
  });
});

describe("runSyncCommand", () => {
  it("prints JSON and returns success", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((s: string) => {
      chunks.push(String(s));
      return true;
    }) as never;
    try {
      expect(
        await runSyncCommand({ out: dir, json: true, quiet: true }, env, {
          runSync: async () => makeReport(),
          readHistory: () => [],
        }),
      ).toBe(0);
      expect(JSON.parse(chunks.join("")).schemaVersion).toBe(1);
    } finally {
      process.stdout.write = original;
    }
  });
  it("returns failure for a failed run", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((s: string) => {
      chunks.push(String(s));
      return true;
    }) as never;
    try {
      expect(
        await runSyncCommand({ out: dir, quiet: true }, env, {
          runSync: async () =>
            makeReport({ ok: false, errors: [{ code: "e", id: "i", message: "m" }] }),
          readHistory: () => [],
        }),
      ).toBe(1);
      expect(chunks.join("")).toContain("INCOMPLETE");
    } finally {
      process.stdout.write = original;
    }
  });
});

describe("runVerifyCommand", () => {
  it("detects drift and does not modify output", async () => {
    const path = join(dir, "Page.md");
    const original = "---\nid: p1\ntitle: Page\n---\n\nold\n";
    await writeFile(path, original);
    const live = {
      id: "p1",
      title: "Page",
      parent: {},
      last_edited_time: "2026-01-01T00:00:00.000Z",
      path: ["Page"],
      lastEditedTime: "2026-01-01T00:00:00.000Z",
      icon: null,
      isRow: false,
      properties: {},
      blocks: [],
    };
    const extraction = {
      pages: [live],
      databases: [],
      assets: [],
      warnings: [],
      errors: [],
      ok: true,
      stats: {
        requests: 1,
        retries: 0,
        rateLimited: 0,
        failures: 0,
        counts: { pages: 1, databases: 0, dataSources: 0, rows: 0, blocks: 0, views: 0, assets: 0 },
        assetsDownloaded: 0,
        assetBytes: 0,
        assetUrlRefreshes: 0,
      },
    };
    expect(
      await runVerifyCommand(
        { token: "t", out: dir, quiet: true },
        {},
        {
          runExtract: () => ({ extract: async () => extraction }),
        },
      ),
    ).toBe(1);
    expect(await readFile(path, "utf8")).toBe(original);
  });
});
