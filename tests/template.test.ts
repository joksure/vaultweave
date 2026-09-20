import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { registerSync } from "../src/cli/sync.js";

interface Step {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, string>;
  "working-directory"?: string;
}

async function load() {
  const text = await readFile(
    resolve(import.meta.dirname, "../templates/github-workflow.yml"),
    "utf8",
  );
  const doc = parse(text) as {
    jobs: { backup: { steps: Step[] } };
    permissions: Record<string, string>;
  };
  return { text, steps: doc.jobs.backup.steps, doc };
}

describe("templates/github-workflow.yml", () => {
  it("is valid YAML with the expected minimal permissions", async () => {
    const { doc } = await load();
    expect(doc.permissions).toEqual({ contents: "write" });
  });

  it("checks the repo out into the directory vaultweave syncs to (no nested repo)", async () => {
    const { steps } = await load();
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout"));
    const sync = steps.find((s) => s.run?.includes("vaultweave@"));
    expect(checkout?.with?.path).toBe("backup");
    expect(sync?.run).toContain("--out ./backup");
    expect(sync?.run).toContain("--git");
  });

  it("only passes --notify when the alert secret is set (an empty target would be a config error)", async () => {
    const { steps } = await load();
    const sync = steps.find((s) => s.run?.includes("vaultweave@"));
    expect(sync?.run).toMatch(/if \[ -n "\$VAULTWEAVE_ALERT" \]/);
  });

  it("saves state even when the sync fails, and pushes unless cancelled", async () => {
    const { steps } = await load();
    expect(steps.find((s) => s.uses?.startsWith("actions/cache/save"))?.if).toBe("always()");
    const push = steps.find((s) => s.run === "git push");
    expect(push?.if).toBe("${{ !cancelled() }}");
    expect(push?.["working-directory"]).toBe("backup");
  });

  it("caches the real state DB path (not the old .vaultweave directory)", async () => {
    const { text } = await load();
    expect(text).toContain("backup/vaultweave.db");
    expect(text).not.toMatch(/path: \.vaultweave\b/);
  });

  it("only uses CLI flags that actually exist", async () => {
    const { text } = await load();
    const program = new Command();
    registerSync(program);
    const flags =
      program.commands.find((c) => c.name() === "sync")?.options.map((o) => o.long) ?? [];
    for (const flag of ["--out", "--git", "--quiet", "--notify"]) {
      expect(text).toContain(flag);
      expect(flags).toContain(flag);
    }
  });
});
