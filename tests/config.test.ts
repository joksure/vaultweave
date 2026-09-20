import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ConfigError, expandEnv, parseConfig } from "../src/config.js";

describe("expandEnv", () => {
  it("substitutes variables and defaults", () => {
    expect(expandEnv("a-${X}-b", { X: "1" })).toBe("a-1-b");
    expect(expandEnv("${X:-fallback}", {})).toBe("fallback");
  });

  it("fails loudly on a missing variable", () => {
    expect(() => expandEnv("${NOPE}", {})).toThrow(/NOPE/);
  });

  it("treats an empty variable as missing", () => {
    expect(() => expandEnv("${X}", { X: "" })).toThrow(ConfigError);
  });
});

describe("parseConfig", () => {
  it("applies defaults to an empty file", () => {
    const cfg = parseConfig("", {});
    expect(cfg).toMatchObject({ out: "./sheaf-backup", git: false, ignore: [], redact: [] });
    expect(cfg.notify.on_success).toBe("silent");
  });

  it("accepts the example from the README", async () => {
    const text = await readFile(new URL("./fixtures/config.readme.yaml", import.meta.url), "utf8");
    const cfg = parseConfig(text, {
      SHEAF_TOKEN: "secret_x",
      ERROR_WEBHOOK: "https://h.example/x",
    });
    expect(cfg.token).toBe("secret_x");
    expect(cfg.git).toBe(true);
    expect(cfg.notify.on_error).toBe("webhook:https://h.example/x");
    expect(new RegExp(cfg.redact[0] as string, "i").test("mail me: a.b@example.com")).toBe(true);
  });

  it("rejects unknown keys (likely typos)", () => {
    expect(() => parseConfig("tokn: x", {})).toThrow(/Invalid configuration/);
  });

  it("rejects an invalid redact regex", () => {
    expect(() => parseConfig('redact: ["("]', {})).toThrow(/regular expression/);
  });

  it("rejects a malformed interval", () => {
    expect(() => parseConfig("interval: soon", {})).toThrow(/duration/);
  });

  it("reports invalid YAML as a ConfigError", () => {
    expect(() => parseConfig("a: [", {})).toThrow(ConfigError);
  });
});
