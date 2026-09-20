/**
 * Normalizer: ExtractionResult → IR
 *
 * Strips Notion API noise (request_id, internal IDs not needed downstream,
 * redundant fields) and converts raw API shapes into clean typed IR nodes.
 * This is the only place that knows about Notion's rich-text / block / property schemas.
 */

import type { AssetRef } from "../extractor/assets.js";
import type {
  ExtractedBlock,
  ExtractedDatabase,
  ExtractedDataSource,
  ExtractedPage,
  ExtractionResult,
} from "../extractor/types.js";
import type {
  IrAnnotations,
  IrBlock,
  IrCallout,
  IrDatabase,
  IrDataSource,
  IrEmojiIcon,
  IrExternalIcon,
  IrFileIcon,
  IrIcon,
  IrImage,
  IrMedia,
  IrPage,
  IrPropertyValue,
  IrRichText,
  IrRichTextSpan,
  IrRow,
  IrWorkspace,
} from "./ir.js";

// ------------------------------------------------------------------ helpers

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

// ------------------------------------------------------------------ rich text

function normalizeAnnotations(raw: unknown): IrAnnotations {
  if (!isObj(raw))
    return {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
    };
  return {
    bold: raw.bold === true,
    italic: raw.italic === true,
    strikethrough: raw.strikethrough === true,
    underline: raw.underline === true,
    code: raw.code === true,
    color: str(raw.color) || "default",
  };
}

function normalizeRichTextSpan(raw: unknown): IrRichTextSpan | null {
  if (!isObj(raw)) return null;
  const annotations = normalizeAnnotations(raw.annotations);
  const href = typeof raw.href === "string" ? raw.href : null;

  if (raw.type === "equation" && isObj(raw.equation)) {
    return { kind: "equation", text: str(raw.equation.expression), href, annotations };
  }
  if (raw.type === "mention") {
    return { kind: "mention", text: str(raw.plain_text), href, annotations };
  }
  // Default: text
  const content = isObj(raw.text) ? str(raw.text.content) : str(raw.plain_text);
  const link = isObj(raw.text) && isObj(raw.text.link) ? str(raw.text.link.url) : null;
  return { kind: "text", text: content, href: link ?? href, annotations };
}

function normalizeRichText(raw: unknown): IrRichText {
  return arr<unknown>(raw)
    .map(normalizeRichTextSpan)
    .filter((s): s is IrRichTextSpan => s !== null);
}

function plainTextFrom(rt: IrRichText): string {
  return rt.map((s) => s.text).join("");
}

// ------------------------------------------------------------------ icons

function normalizeIcon(raw: unknown, _assetMap: Map<string, AssetRef>): IrIcon | null {
  if (!isObj(raw)) return null;
  if (raw.type === "emoji") return { kind: "emoji", emoji: str(raw.emoji) } as IrEmojiIcon;
  if (raw.type === "external" && isObj(raw.external)) {
    return { kind: "external", url: str(raw.external.url) } as IrExternalIcon;
  }
  if (raw.type === "file" && isObj(raw.file)) {
    const source = str(raw.file.source);
    const assetRef = isObj(raw.file.asset) ? (raw.file.asset as unknown as AssetRef) : null;
    return {
      kind: "file",
      assetPath: assetRef?.path ?? null,
      source: source || null,
    } as IrFileIcon;
  }
  return null;
}

// ------------------------------------------------------------------ media blocks

function normalizeMedia(
  block: ExtractedBlock,
  _assetMap: Map<string, AssetRef>,
): Omit<IrMedia, "type"> {
  const payload = block[block.type];
  if (!isObj(payload)) {
    return {
      id: block.id,
      children: [],
      caption: [],
      assetPath: null,
      source: null,
      externalUrl: null,
    };
  }
  const caption = normalizeRichText(payload.caption);
  if (isObj(payload.file)) {
    const source = str(payload.file.source) || null;
    const asset = isObj(payload.file.asset) ? (payload.file.asset as unknown as AssetRef) : null;
    return {
      id: block.id,
      children: [],
      caption,
      assetPath: asset?.path ?? null,
      source,
      externalUrl: null,
    };
  }
  if (isObj(payload.external)) {
    return {
      id: block.id,
      children: [],
      caption,
      assetPath: null,
      source: null,
      externalUrl: str(payload.external.url),
    };
  }
  return { id: block.id, children: [], caption, assetPath: null, source: null, externalUrl: null };
}

// ------------------------------------------------------------------ property values

function normalizePropertyValue(prop: unknown): IrPropertyValue {
  if (!isObj(prop)) return { type: "unknown", raw: String(prop) };
  const type = str(prop.type);
  const val = prop[type];

  switch (type) {
    case "title":
      return { type: "title", text: plainTextFrom(normalizeRichText(val)) };
    case "rich_text":
      return { type: "rich_text", text: plainTextFrom(normalizeRichText(val)) };
    case "number":
      return { type: "number", value: typeof val === "number" ? val : null };
    case "select":
      return { type: "select", name: isObj(val) ? str(val.name) || null : null };
    case "multi_select":
      return {
        type: "multi_select",
        names: arr<unknown>(val)
          .filter(isObj)
          .map((o) => str(o.name))
          .filter(Boolean),
      };
    case "date":
      if (!isObj(val)) return { type: "date", start: null, end: null, timeZone: null };
      return {
        type: "date",
        start: str(val.start) || null,
        end: str(val.end) || null,
        timeZone: str(val.time_zone) || null,
      };
    case "checkbox":
      return { type: "checkbox", checked: val === true };
    case "url":
      return { type: "url", url: typeof val === "string" ? val : null };
    case "email":
      return { type: "email", email: typeof val === "string" ? val : null };
    case "phone_number":
      return { type: "phone_number", phone: typeof val === "string" ? val : null };
    case "people":
      return {
        type: "people",
        ids: arr<unknown>(val)
          .filter(isObj)
          .map((u) => str(u.id))
          .filter(Boolean),
      };
    case "relation":
      return {
        type: "relation",
        ids: arr<unknown>(val)
          .filter(isObj)
          .map((r) => str(r.id))
          .filter(Boolean),
      };
    case "formula": {
      if (!isObj(val)) return { type: "formula", result: "" };
      const ftype = str(val.type);
      const fval = val[ftype];
      return { type: "formula", result: fval === null ? "" : String(fval) };
    }
    case "rollup": {
      if (!isObj(val)) return { type: "rollup", result: "" };
      const rtype = str(val.type);
      const rval = val[rtype];
      if (rtype === "array")
        return { type: "rollup", result: `[${arr<unknown>(rval).length} items]` };
      return { type: "rollup", result: rval === null ? "" : String(rval) };
    }
    case "created_time":
      return { type: "created_time", iso: str(val) };
    case "last_edited_time":
      return { type: "last_edited_time", iso: str(val) };
    case "created_by":
      return { type: "created_by", id: isObj(val) ? str(val.id) : "" };
    case "last_edited_by":
      return { type: "last_edited_by", id: isObj(val) ? str(val.id) : "" };
    case "files": {
      const files = arr<unknown>(val).filter(isObj);
      const names = files.map((f) => str(f.name));
      const assetPaths = files.map((f) => {
        if (f.type === "file" && isObj(f.file)) {
          const asset = isObj(f.file.asset) ? (f.file.asset as unknown as AssetRef) : null;
          return asset?.path ?? null;
        }
        return null;
      });
      return { type: "files", names, assetPaths };
    }
    case "status":
      return { type: "status", name: isObj(val) ? str(val.name) || null : null };
    case "unique_id":
      if (!isObj(val)) return { type: "unique_id", prefix: null, number: null };
      return {
        type: "unique_id",
        prefix: typeof val.prefix === "string" ? val.prefix : null,
        number: typeof val.number === "number" ? val.number : null,
      };
    default:
      return { type: "unknown", raw: type };
  }
}

// ------------------------------------------------------------------ blocks

function normalizeBlock(raw: ExtractedBlock, assetMap: Map<string, AssetRef>): IrBlock {
  const { id, type, children: rawChildren } = raw;
  const children = rawChildren.map((c) => normalizeBlock(c, assetMap));
  const base = { id, children };

  const rt = (key: string): IrRichText => {
    const payload = raw[type];
    return isObj(payload) ? normalizeRichText(payload[key]) : [];
  };

  switch (type) {
    case "paragraph":
      return { ...base, type: "paragraph", text: rt("rich_text") };

    case "heading_1":
    case "heading_2":
    case "heading_3": {
      const level = Number(type.slice(-1)) as 1 | 2 | 3;
      const p = raw[type];
      return {
        ...base,
        type: "heading",
        level,
        text: rt("rich_text"),
        isToggleable: isObj(p) && p.is_toggleable === true,
      };
    }

    case "bulleted_list_item":
      return { ...base, type: "bulleted_list_item", text: rt("rich_text") };

    case "numbered_list_item":
      return { ...base, type: "numbered_list_item", text: rt("rich_text") };

    case "to_do": {
      const p = raw[type];
      return {
        ...base,
        type: "to_do",
        text: rt("rich_text"),
        checked: isObj(p) && p.checked === true,
      };
    }

    case "toggle":
      return { ...base, type: "toggle", text: rt("rich_text") };

    case "quote":
      return { ...base, type: "quote", text: rt("rich_text") };

    case "callout": {
      const p = raw[type];
      const icon = isObj(p) ? normalizeIcon(p.icon, assetMap) : null;
      return { ...base, type: "callout", text: rt("rich_text"), icon } as IrCallout;
    }

    case "code": {
      const p = raw[type];
      const textRt = isObj(p) ? normalizeRichText(p.rich_text) : [];
      return {
        ...base,
        type: "code",
        text: plainTextFrom(textRt),
        language: isObj(p) ? str(p.language) : "plain text",
        caption: isObj(p) ? normalizeRichText(p.caption) : [],
      };
    }

    case "equation": {
      const p = raw[type];
      return { ...base, type: "equation", expression: isObj(p) ? str(p.expression) : "" };
    }

    case "divider":
      return { ...base, type: "divider" };

    case "table_of_contents":
      return { ...base, type: "table_of_contents" };

    case "table": {
      const p = raw[type];
      return {
        ...base,
        type: "table",
        hasColumnHeader: isObj(p) && p.has_column_header === true,
        hasRowHeader: isObj(p) && p.has_row_header === true,
      };
    }

    case "table_row": {
      const p = raw[type];
      const cells = isObj(p) ? arr<unknown>(p.cells).map(normalizeRichText) : [];
      return { ...base, type: "table_row", cells };
    }

    case "image":
      return { ...normalizeMedia(raw, assetMap), type: "image" } as IrImage;

    case "video":
      return { ...normalizeMedia(raw, assetMap), type: "video" };

    case "audio":
      return { ...normalizeMedia(raw, assetMap), type: "audio" };

    case "file": {
      const p = raw[type];
      const name = isObj(p) ? str(p.name) : "";
      return { ...normalizeMedia(raw, assetMap), type: "file", name };
    }

    case "pdf":
      return { ...normalizeMedia(raw, assetMap), type: "pdf" };

    case "bookmark": {
      const p = raw[type];
      return {
        ...base,
        type: "bookmark",
        url: isObj(p) ? str(p.url) : "",
        caption: isObj(p) ? normalizeRichText(p.caption) : [],
      };
    }

    case "embed": {
      const p = raw[type];
      return {
        ...base,
        type: "embed",
        url: isObj(p) ? str(p.url) : "",
        caption: isObj(p) ? normalizeRichText(p.caption) : [],
      };
    }

    case "link_to_page": {
      const p = raw[type];
      if (!isObj(p)) return { ...base, type: "unsupported" };
      const targetKind = p.type === "database_id" ? "database" : "page";
      const targetId = targetKind === "database" ? str(p.database_id) : str(p.page_id);
      return { ...base, type: "link_to_page", targetId, targetKind };
    }

    case "child_page": {
      const p = raw[type];
      return { ...base, type: "child_page_ref", pageId: id, title: isObj(p) ? str(p.title) : "" };
    }

    case "child_database": {
      const p = raw[type];
      return {
        ...base,
        type: "child_database_ref",
        databaseId: id,
        title: isObj(p) ? str(p.title) : "",
      };
    }

    case "synced_block": {
      const p = raw[type];
      const syncedFrom =
        isObj(p) && isObj(p.synced_from) ? str(p.synced_from.block_id) || null : null;
      return { ...base, type: "synced_block", syncedFromId: syncedFrom };
    }

    case "column_list":
      return { ...base, type: "column_list" };

    case "column":
      return { ...base, type: "column" };

    case "unsupported":
      return { ...base, type: "unsupported" };

    default:
      // Unknown block type: emit as unsupported rather than dropping silently.
      return { ...base, type: "unsupported" };
  }
}

// ------------------------------------------------------------------ pages

function normalizePage(
  raw: ExtractedPage,
  path: string[],
  assetMap: Map<string, AssetRef>,
  isRow = false,
): IrPage {
  const properties: Record<string, IrPropertyValue> = {};
  if (isObj(raw.properties)) {
    for (const [name, val] of Object.entries(raw.properties)) {
      properties[name] = normalizePropertyValue(val);
    }
  }
  const icon = normalizeIcon(raw.icon, assetMap);
  return {
    id: raw.id,
    title: raw.title || "Untitled",
    path,
    lastEditedTime: str(raw.last_edited_time),
    icon,
    isRow,
    properties,
    blocks: raw.blocks.map((b) => normalizeBlock(b, assetMap)),
    comments: (raw.comments ?? []).map((c) => ({
      id: c.id,
      author: c.created_by,
      text: c.text,
      createdAt: c.created_time,
      resolved: c.resolved,
      replies: c.replies.map((r) => ({
        id: r.id,
        author: r.created_by,
        text: r.text,
        createdAt: r.created_time,
        resolved: r.resolved,
      })),
    })),
  };
}

// ------------------------------------------------------------------ databases

function normalizeDataSource(
  ds: ExtractedDataSource,
  assetMap: Map<string, AssetRef>,
): IrDataSource {
  const schema = Object.entries(ds.properties)
    .map(([name, def]) => ({ name, type: isObj(def) ? str(def.type) : "unknown" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const rows: IrRow[] = ds.rows.map((row) => ({
    id: row.id,
    title: row.title || "Untitled",
    properties: Object.fromEntries(
      Object.entries(isObj(row.properties) ? row.properties : {}).map(([k, v]) => [
        k,
        normalizePropertyValue(v),
      ]),
    ),
    blocks: row.blocks.map((b) => normalizeBlock(b, assetMap)),
  }));

  return { id: ds.id, name: ds.name, schema, rows };
}

function normalizeDatabase(db: ExtractedDatabase, assetMap: Map<string, AssetRef>): IrDatabase {
  const dataSources = db.data_sources.map((ds) => normalizeDataSource(ds, assetMap));
  const viewStubs = db.views.map((v) => ({
    id: isObj(v) ? str(v.id) : "",
    name: isObj(v) ? str(v.name) : "Unnamed view",
    viewType: isObj(v) ? str(v.type) : "unknown",
  }));
  return { id: db.id, name: db.name, dataSources, viewStubs };
}

// ------------------------------------------------------------------ path resolution

/**
 * Builds a map of page id → path (array of title segments from root).
 * Used to set `IrPage.path` for link resolution and filesystem rendering.
 */
function buildPathMap(pages: ExtractedPage[]): Map<string, string[]> {
  const pageById = new Map(pages.map((p) => [p.id, p]));
  const pathMap = new Map<string, string[]>();

  function resolvePath(id: string, visited = new Set<string>()): string[] {
    const cached = pathMap.get(id);
    if (cached) return cached;
    if (visited.has(id)) return []; // cycle guard
    visited.add(id);
    const page = pageById.get(id);
    if (!page) return [];
    const parent = isObj(page.parent) ? page.parent : {};
    const parentPageId = str(parent.page_id) || str(parent.block_id);
    const parentPath = parentPageId ? resolvePath(parentPageId, visited) : [];
    const path = [...parentPath, page.title || "Untitled"];
    pathMap.set(id, path);
    return path;
  }

  for (const p of pages) resolvePath(p.id);
  return pathMap;
}

// ------------------------------------------------------------------ main entry

/**
 * Converts a raw `ExtractionResult` into the clean, renderer-agnostic `IrWorkspace`.
 */
export function normalize(result: ExtractionResult): IrWorkspace {
  // Build a lookup so block-level asset rewrites can be verified (currently pass-through).
  const assetMap = new Map(result.assets.map((a) => [a.path, a]));

  // Path resolution needs all pages (including database rows flattened).
  const allExtractedPages = [
    ...result.pages,
    ...result.databases.flatMap((db) => db.data_sources.flatMap((ds) => ds.rows)),
  ];
  const pathMap = buildPathMap(allExtractedPages);

  const pages: IrPage[] = result.pages.map((p) =>
    normalizePage(p, pathMap.get(p.id) ?? [p.title || "Untitled"], assetMap, false),
  );

  const databases: IrDatabase[] = result.databases.map((db) => normalizeDatabase(db, assetMap));

  return { pages, databases };
}
