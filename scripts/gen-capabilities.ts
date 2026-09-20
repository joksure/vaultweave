/**
 * Regenerates CAPABILITIES.md from src/core/capabilities.ts.
 *   npm run capabilities         → write the file
 *   npm run capabilities:check   → exit 1 if the committed file is stale (used in CI)
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderCapabilitiesMarkdown } from "../src/core/capabilities.js";

const target = fileURLToPath(new URL("../CAPABILITIES.md", import.meta.url));
const expected = renderCapabilitiesMarkdown();

if (process.argv.includes("--check")) {
  const actual = await readFile(target, "utf8").catch(() => "");
  if (actual.replaceAll("\r\n", "\n") !== expected) {
    console.error(
      "CAPABILITIES.md is out of date. Run `npm run capabilities` and commit the result.",
    );
    process.exit(1);
  }
  console.log("CAPABILITIES.md is up to date.");
} else {
  await writeFile(target, expected, "utf8");
  console.log("Wrote CAPABILITIES.md");
}
