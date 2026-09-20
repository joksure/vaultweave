/**
 * Markdown renderer: IrPage → Markdown string with YAML frontmatter.
 *
 * Design decisions:
 * - GFM-compatible output (tables, task lists, strikethrough).
 * - Frontmatter carries id, title, last_edited_time and all Notion properties
 *   so the file is self-contained and parseable by static-site generators.
 * - Non-exportable content emits <!-- NOT BACKED UP: … --> HTML comments
 *   (honesty matrix §7) rather than silently disappearing.
 * - Asset references use relative paths from the page file so the output repo
 *   is portable: moving the directory keeps all links valid.
 * - Inline Notion colours are dropped (no equivalent in Markdown).
 */

import type {
  IrBlock,
  IrCallout,
  IrCode,
  IrIcon,
  IrMedia,
  IrPage,
  IrPropertyValue,
  IrRichText,
  IrRichTextSpan,
} from "../normalizer/ir.js";

// ------------------------------------------------------------------ rich text

const ESCAPE_MD = /([\\`*_{}[\]()#+\-.!|])/g;

function escapeMd(text: string): string {
  return text.replace(ESCAPE_MD, "\\$1");
}

function renderSpan(span: IrRichTextSpan): string {
  if (span.kind === "equation") {
    return `$${span.text}$`;
  }
  let text = span.kind === "mention" ? escapeMd(span.text) : escapeMd(span.text);
  const { annotations } = span;
  // Apply annotations from inner to outer to get consistent nesting.
  if (annotations.code) text = `\`${span.text}\``;
  else {
    if (annotations.bold && annotations.italic) text = `***${text}***`;
    else if (annotations.bold) text = `**${text}**`;
    else if (annotations.italic) text = `*${text}*`;
    if (annotations.strikethrough) text = `~~${text}~~`;
    if (annotations.underline) text = `<u>${text}</u>`;
  }
  if (span.href) text = `[${text}](${span.href})`;
  return text;
}

function renderRichText(rt: IrRichText): string {
  return rt.map(renderSpan).join("");
}

function plainText(rt: IrRichText): string {
  return rt.map((s) => s.text).join("");
}

// ------------------------------------------------------------------ media

function renderMediaRef(m: Omit<IrMedia, "type">, _altText = ""): string {
  if (m.externalUrl) return m.externalUrl;
  if (m.assetPath) return m.assetPath;
  if (m.source) return `${m.source} <!-- download failed -->`;
  return "";
}

// ------------------------------------------------------------------ property → frontmatter scalar

function propToFrontmatter(v: IrPropertyValue): unknown {
  switch (v.type) {
    case "title":
    case "rich_text":
      return v.text || null;
    case "number":
      return v.value;
    case "select":
    case "status":
      return v.name;
    case "multi_select":
      return v.names.length > 0 ? v.names : null;
    case "date":
      if (!v.start) return null;
      return v.end ? `${v.start} → ${v.end}` : v.start;
    case "checkbox":
      return v.checked;
    case "url":
      return v.url;
    case "email":
      return v.email;
    case "phone_number":
      return v.phone;
    case "people":
      return v.ids.length > 0 ? v.ids : null;
    case "relation":
      return v.ids.length > 0 ? v.ids : null;
    case "formula":
    case "rollup":
      return v.result || null;
    case "created_time":
    case "last_edited_time":
      return v.iso || null;
    case "created_by":
    case "last_edited_by":
      return v.id || null;
    case "files":
      return v.names.length > 0 ? v.names : null;
    case "unique_id":
      if (v.prefix && v.number !== null) return `${v.prefix}-${v.number}`;
      if (v.number !== null) return v.number;
      return null;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ YAML frontmatter

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const s = String(v);
  // Always quote strings to avoid ambiguity with YAML reserved tokens and ensure consistency.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlValue(v: unknown, indent = ""): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return `\n${v.map((item) => `${indent}  - ${yamlScalar(item)}`).join("\n")}`;
  }
  return yamlScalar(v);
}

function buildFrontmatter(page: IrPage): string {
  const lines: string[] = ["---"];
  lines.push(`id: ${yamlScalar(page.id)}`);
  lines.push(`title: ${yamlScalar(page.title)}`);
  lines.push(`last_edited_time: ${yamlScalar(page.lastEditedTime)}`);
  if (page.icon) {
    lines.push(`icon: ${yamlScalar(iconText(page.icon))}`);
  }

  // Sort properties for deterministic output; skip "Name"/title (already in title field).
  const propEntries = Object.entries(page.properties)
    .filter(([, v]) => v.type !== "title")
    .sort(([a], [b]) => a.localeCompare(b));

  if (propEntries.length > 0) {
    lines.push("properties:");
    for (const [name, val] of propEntries) {
      const scalar = propToFrontmatter(val);
      if (scalar === null || scalar === undefined) continue;
      lines.push(`  ${yamlScalar(name)}: ${yamlValue(scalar, "  ")}`);
    }
  }

  lines.push("---");
  return `${lines.join("\n")}\n`;
}

function iconText(icon: IrIcon): string {
  if (icon.kind === "emoji") return icon.emoji;
  if (icon.kind === "external") return icon.url;
  return icon.assetPath ?? icon.source ?? "";
}

// ------------------------------------------------------------------ block rendering

interface RenderContext {
  /** Indent prefix for nested list items (each level adds two spaces). */
  indent: string;
  /** 1-based counter for ordered lists per nesting level. */
  listCounters: number[];
  /** Whether we're directly inside a numbered list (affects child counter). */
  inOrderedList: boolean;
}

const ROOT_CTX: RenderContext = { indent: "", listCounters: [0], inOrderedList: false };

function renderBlocks(blocks: IrBlock[], ctx = ROOT_CTX): string {
  const parts: string[] = [];
  for (const block of blocks) {
    parts.push(renderBlock(block, ctx));
  }
  // Trim empty trailing lines but keep one blank line between blocks.
  return parts.filter((p) => p !== "").join("\n\n");
}

function renderBlock(block: IrBlock, ctx: RenderContext): string {
  switch (block.type) {
    case "paragraph": {
      const text = renderRichText(block.text);
      const inner =
        block.children.length > 0
          ? `\n\n${renderBlocks(block.children, { ...ctx, indent: `${ctx.indent}  ` })}`
          : "";
      return ctx.indent + (text || "\u00a0") + inner;
    }

    case "heading": {
      const prefix = "#".repeat(block.level);
      const text = renderRichText(block.text);
      return `${prefix} ${text}`;
    }

    case "bulleted_list_item": {
      const text = renderRichText(block.text);
      const childCtx = { ...ctx, indent: `${ctx.indent}  `, inOrderedList: false };
      const inner = block.children.length > 0 ? `\n${renderBlocks(block.children, childCtx)}` : "";
      return `${ctx.indent}- ${text}${inner}`;
    }

    case "numbered_list_item": {
      const text = renderRichText(block.text);
      const childCtx = { ...ctx, indent: `${ctx.indent}  `, inOrderedList: true };
      const inner = block.children.length > 0 ? `\n${renderBlocks(block.children, childCtx)}` : "";
      return `${ctx.indent}1. ${text}${inner}`;
    }

    case "to_do": {
      const check = block.checked ? "[x]" : "[ ]";
      const text = renderRichText(block.text);
      const childCtx = { ...ctx, indent: `${ctx.indent}  ` };
      const inner = block.children.length > 0 ? `\n${renderBlocks(block.children, childCtx)}` : "";
      return `${ctx.indent}- ${check} ${text}${inner}`;
    }

    case "toggle": {
      const text = renderRichText(block.text);
      const inner = renderBlocks(block.children, { ...ctx, indent: `${ctx.indent}  ` });
      if (!inner) return `${ctx.indent}<details><summary>${text}</summary></details>`;
      return `${ctx.indent}<details>\n${ctx.indent}<summary>${text}</summary>\n\n${inner}\n\n${ctx.indent}</details>`;
    }

    case "quote": {
      const text = renderRichText(block.text);
      const childLines = block.children.length > 0 ? renderBlocks(block.children) : "";
      const quoted = [text, ...(childLines ? [childLines] : [])]
        .join("\n\n")
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      return quoted;
    }

    case "callout": {
      const icon = (block as IrCallout).icon;
      const iconStr = icon?.kind === "emoji" ? `${icon.emoji} ` : "";
      const text = renderRichText((block as IrCallout).text);
      const childLines = block.children.length > 0 ? renderBlocks(block.children) : "";
      const _body = [iconStr + text, ...(childLines ? [childLines] : [])].join("\n\n");
      return `> **${iconStr}Note:** ${text}${childLines ? `\n>\n> ${childLines.split("\n").join("\n> ")}` : ""}`;
    }

    case "code": {
      const b = block as IrCode;
      const lang = b.language === "plain text" ? "" : b.language;
      const caption = b.caption.length > 0 ? `\n*${plainText(b.caption)}*` : "";
      return `\`\`\`${lang}\n${b.text}\n\`\`\`${caption}`;
    }

    case "equation":
      return `$$\n${block.expression}\n$$`;

    case "divider":
      return "---";

    case "table_of_contents":
      return `<!-- Table of contents (auto-generated by Notion) -->`;

    case "table": {
      // Table cells are in the children (table_row blocks).
      const rows = block.children.filter((c) => c.type === "table_row");
      if (rows.length === 0) return "";
      const rowLines = rows.map((row) => {
        if (row.type !== "table_row") return "";
        const cells = row.cells.map((c) => renderRichText(c).replace(/\|/g, "\\|"));
        return `| ${cells.join(" | ")} |`;
      });
      if (rowLines.length === 0) return "";
      const header = rowLines[0] ?? "";
      const sep = header.replace(/[^|]/g, (c) => (c === "|" ? "|" : "-"));
      return block.hasColumnHeader && rowLines.length > 1
        ? [header, sep, ...rowLines.slice(1)].join("\n")
        : [header, sep, ...rowLines.slice(1)].join("\n");
    }

    case "table_row":
      // Handled inside `table`; a bare table_row is a no-op.
      return "";

    case "image": {
      const m = block as unknown as IrMedia & { type: string };
      const caption =
        "caption" in m && Array.isArray((m as { caption: IrRichText }).caption)
          ? plainText((m as { caption: IrRichText }).caption)
          : "";
      const src = renderMediaRef(m as unknown as IrMedia, caption);
      return src ? `![${escapeMd(caption)}](${src})` : `<!-- image not available -->`;
    }

    case "video":
    case "audio":
    case "pdf": {
      const m = block as unknown as IrMedia & { type: string; caption?: IrRichText };
      const captionRt = m.caption ?? [];
      const caption = plainText(captionRt as IrRichText);
      const src = renderMediaRef(m as unknown as IrMedia);
      if (!src) return `<!-- ${block.type} not available -->`;
      return `[${escapeMd(caption || block.type)}](${src})`;
    }

    case "file": {
      const m = block as unknown as IrMedia & { type: string; name: string; caption?: IrRichText };
      const captionRt = m.caption ?? [];
      const label = m.name || plainText(captionRt as IrRichText) || "file";
      const src = renderMediaRef(m as unknown as IrMedia);
      if (!src) return `<!-- file not available: ${escapeMd(label)} -->`;
      return `[${escapeMd(label)}](${src})`;
    }

    case "bookmark": {
      const caption = plainText(block.caption);
      return `[${escapeMd(caption || block.url)}](${block.url})`;
    }

    case "embed":
      return `<!-- embed: ${block.url} -->`;

    case "link_to_page":
      return `<!-- link to ${block.targetKind}: ${block.targetId} -->`;

    case "child_page_ref":
      return `<!-- child page: ${block.title} (${block.pageId}) -->`;

    case "child_database_ref":
      return `<!-- child database: ${block.title} (${block.databaseId}) -->`;

    case "synced_block": {
      if (block.syncedFromId) {
        // Duplicate: content is in the original, which is its own page block.
        return `<!-- synced block copy (source: ${block.syncedFromId}) -->\n\n${renderBlocks(block.children, ctx)}`;
      }
      // Original synced block: render children normally.
      return renderBlocks(block.children, ctx);
    }

    case "column_list":
      // Render columns as consecutive sections — Markdown has no column layout.
      return renderBlocks(block.children, ctx);

    case "column":
      return renderBlocks(block.children, ctx);

    case "unsupported":
      return `<!-- NOT BACKED UP: unsupported block (${block.id}) -->`;

    case "stub":
      return `<!-- NOT BACKED UP: ${block.description} -->`;

    default:
      return "";
  }
}

// ------------------------------------------------------------------ main export

export interface MarkdownRenderOptions {
  /** Include YAML frontmatter (default: true). */
  frontmatter?: boolean;
}

/**
 * Renders an `IrPage` to a Markdown string.
 * @param page  The normalised page.
 * @param opts  Render options.
 * @returns     Complete Markdown document (frontmatter + body).
 */
export function renderPageMarkdown(page: IrPage, opts: MarkdownRenderOptions = {}): string {
  const { frontmatter = true } = opts;
  const fm = frontmatter ? buildFrontmatter(page) : "";
  const body = renderBlocks(page.blocks);
  return fm + (body ? `\n${body}\n` : "");
}
