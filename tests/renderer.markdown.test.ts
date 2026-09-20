/**
 * Markdown renderer tests.
 *
 * Uses the golden extraction fixtures → normalize() → renderPageMarkdown()
 * and asserts structural invariants without full snapshot pinning (avoids
 * brittle byte-for-byte comparisons that break on cosmetic changes).
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtractionResult } from "../src/core/extractor/types.js";
import { normalize } from "../src/core/normalizer/normalize.js";
import { renderPageMarkdown } from "../src/core/renderer/markdown.js";

async function loadGolden(name: string): Promise<ExtractionResult> {
  const path = resolve(__dirname, `golden/${name}.extraction.json`);
  return JSON.parse(await readFile(path, "utf8")) as ExtractionResult;
}

describe("renderPageMarkdown(docs-heavy)", () => {
  it("produces YAML frontmatter with id, title, last_edited_time", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const md = renderPageMarkdown(handbook);
    expect(md).toMatch(/^---\n/);
    expect(md).toContain("id:");
    expect(md).toContain('title: "Engineering Handbook"');
    expect(md).toContain("last_edited_time:");
  });

  it("renders heading_1 as # …", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const md = renderPageMarkdown(handbook);
    expect(md).toContain("# Welcome");
  });

  it("renders bold text with **…**", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const md = renderPageMarkdown(handbook);
    expect(md).toContain("**this first**");
  });

  it("renders a blockquote for a quote block", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const md = renderPageMarkdown(handbook);
    expect(md).toContain("> ");
    expect(md).toContain("Make it work");
  });

  it("renders a code block with fenced triple-backticks", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const md = renderPageMarkdown(handbook);
    expect(md).toContain("```typescript");
    expect(md).toContain("answer = 42");
    expect(md).toContain("```");
  });

  it("renders an equation block as $$…$$", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const md = renderPageMarkdown(handbook);
    expect(md).toContain("$$");
    expect(md).toContain("E = mc^2");
  });

  it("renders a GFM table from a table block", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const md = renderPageMarkdown(handbook);
    expect(md).toContain("| Environment |");
    expect(md).toContain("| staging |");
    expect(md).toMatch(/\|[-| ]+\|/); // separator row
  });

  it("renders a to_do block as GFM task list item", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const md = renderPageMarkdown(handbook);
    expect(md).toContain("- [x] ");
    expect(md).toContain("- [ ] ");
  });

  it("renders a divider as ---", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const md = renderPageMarkdown(handbook);
    expect(md).toContain("---");
  });

  it("renders an unsupported block as an HTML comment stub", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const allPages = ws.pages;
    const pageWithUnsupported = allPages.find((p) =>
      p.blocks.some((b) => b.type === "unsupported"),
    );
    expect(pageWithUnsupported).toBeDefined();
    const md = renderPageMarkdown(pageWithUnsupported!);
    expect(md).toContain("<!-- NOT BACKED UP:");
  });

  it("does not produce YAML frontmatter when frontmatter=false", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const md = renderPageMarkdown(handbook, { frontmatter: false });
    expect(md).not.toMatch(/^---\n/);
  });

  it("renders a bookmark as a Markdown link", async () => {
    const result = await loadGolden("docs-heavy");
    const ws = normalize(result);
    const handbook = ws.pages.find((p) => p.title === "Engineering Handbook")!;
    const md = renderPageMarkdown(handbook);
    expect(md).toMatch(/\[.*\]\(https:\/\/example\.com\/docs\)/);
  });
});

describe("renderPageMarkdown(media-heavy)", () => {
  it("renders an image block as ![caption](path)", async () => {
    const result = await loadGolden("media-heavy");
    const ws = normalize(result);
    const gallery = ws.pages.find((p) => p.title === "Gallery")!;
    const md = renderPageMarkdown(gallery);
    expect(md).toMatch(/!\[.*\]\(assets\//);
  });

  it("renders an external image by its URL", async () => {
    const result = await loadGolden("media-heavy");
    const ws = normalize(result);
    const gallery = ws.pages.find((p) => p.title === "Gallery")!;
    const md = renderPageMarkdown(gallery);
    expect(md).toContain("example.com/remote.png");
  });

  it("renders a file block as a named link", async () => {
    const result = await loadGolden("media-heavy");
    const ws = normalize(result);
    const gallery = ws.pages.find((p) => p.title === "Gallery")!;
    const md = renderPageMarkdown(gallery);
    expect(md).toMatch(/\[.*\]\(assets\//);
  });
});
