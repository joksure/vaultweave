import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, renderCapabilitiesMarkdown, renderStub } from "../src/core/capabilities.js";

describe("capabilities matrix", () => {
  it("has unique ids", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never claims implementation of something the API cannot export", () => {
    for (const c of CAPABILITIES) {
      if (c.official === "unsupported" && c.internal === "unsupported") {
        expect(c.implemented, c.id).toBe(false);
        expect(c.plannedIn, c.id).toBeNull();
      }
    }
  });

  it("only claims extraction/implementation for things the API can export", () => {
    for (const c of CAPABILITIES) {
      if (c.implemented) expect(c.extracted, `${c.id}: implemented implies extracted`).toBe(true);
      if (c.extracted)
        expect(c.official, `${c.id}: extracted needs official API support`).not.toBe("unsupported");
    }
  });

  it("no longer lists database views as an API limit (the Views API exists)", () => {
    const views = CAPABILITIES.find((c) => c.id === "views");
    expect(views?.official).toBe("supported");
  });

  it("matches the committed CAPABILITIES.md (drift check)", async () => {
    const file = await readFile(new URL("../CAPABILITIES.md", import.meta.url), "utf8");
    expect(file.replaceAll("\r\n", "\n")).toBe(renderCapabilitiesMarkdown());
  });
});

describe("renderStub", () => {
  it("produces the visible stub comment from the honesty rule", () => {
    expect(renderStub("automation", "Weekly digest")).toBe(
      '<!-- NOT BACKED UP: automation "Weekly digest" -->',
    );
    expect(renderStub("button", "Notify team", "configuration not exposed")).toBe(
      '<!-- NOT BACKED UP: button "Notify team" (configuration not exposed) -->',
    );
  });

  it("cannot be broken out of the HTML comment by hostile titles", () => {
    const out = renderStub("database view", 'x --> <script>alert(1)</script> "');
    expect(out.match(/-->/g)).toHaveLength(1);
    expect(out.endsWith("-->")).toBe(true);
  });
});
