import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

const env = { SHEAF_TOKEN: "secret_test", ERROR_WEBHOOK: "https://hooks.example/x" };

describe("shipped example configs", () => {
  for (const name of ["minimal", "with-git-sync"]) {
    it(`examples/${name} is a valid config`, async () => {
      const text = await readFile(
        new URL(`../examples/${name}/.sheaf.yaml`, import.meta.url),
        "utf8",
      );
      expect(() => parseConfig(text, env)).not.toThrow();
    });
  }
});
