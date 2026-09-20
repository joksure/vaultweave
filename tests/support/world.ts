/**
 * Deterministic builders for API-shaped Notion fixtures.
 *
 * These are *synthetic* (hand-modelled on the documented API 2025-09-03 payloads), not
 * recordings of a real workspace. Validate against a real one with `sheaf extract`.
 */
import type { JsonObject } from "../../src/core/extractor/json.js";

export const FILES_HOST = "https://files.fixture.test";
export const FIXTURE_TOKEN = "secret_fixture";

export interface StoredFile {
  body: Uint8Array;
  contentType: string;
}

export interface FixtureWorkspace {
  name: string;
  pages: Map<string, JsonObject>;
  /** parent (page or block) id -> ordered children */
  blocks: Map<string, JsonObject[]>;
  blockIndex: Map<string, JsonObject>;
  databases: Map<string, JsonObject>;
  dataSources: Map<string, JsonObject>;
  /** data source id -> row page ids (insertion order; oldest first) */
  rows: Map<string, string[]>;
  /** database id -> views */
  views: Map<string, JsonObject[]>;
  /** raw (still URL-encoded) path after /f/ -> file */
  files: Map<string, StoredFile>;
  /** `${pageId}:${propertyId}` -> complete list of property items */
  propertyItems: Map<string, JsonObject[]>;
  /** ids returned by search (pages and data sources) */
  searchable: string[];
}

export interface Fixture {
  name: string;
  ws: FixtureWorkspace;
  ids: Record<string, string>;
}

// ------------------------------------------------------------------ rich text & parents

const annotations = (o: RtOptions = {}): JsonObject => ({
  bold: !!o.bold,
  italic: !!o.italic,
  strikethrough: false,
  underline: false,
  code: !!o.code,
  color: o.color ?? "default",
});

export interface RtOptions {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
  color?: string;
}

export function rt(text: string, o: RtOptions = {}): JsonObject {
  return {
    type: "text",
    text: { content: text, link: o.link ? { url: o.link } : null },
    annotations: annotations(o),
    plain_text: text,
    href: o.link ?? null,
  };
}

export function mentionPage(id: string, text: string): JsonObject {
  return {
    type: "mention",
    mention: { type: "page", page: { id } },
    annotations: annotations(),
    plain_text: text,
    href: `https://www.notion.so/${id.replaceAll("-", "")}`,
  };
}

export const WORKSPACE_PARENT: JsonObject = { type: "workspace", workspace: true };
export const pageParent = (id: string): JsonObject => ({ type: "page_id", page_id: id });
export const emoji = (e: string): JsonObject => ({ type: "emoji", emoji: e });
export const externalFile = (url: string): JsonObject => ({ type: "external", external: { url } });

// ------------------------------------------------------------------ blocks

export interface BlockNode {
  type: string;
  payload: JsonObject;
  children?: BlockNode[];
  /** Preassigned id (needed for cross references and for child_page/child_database). */
  id?: string;
  /** Force has_children even though the node lists none (child pages, synced copies). */
  hasChildren?: boolean;
}

const node = (
  type: string,
  payload: JsonObject,
  children?: BlockNode[],
  extra: Partial<BlockNode> = {},
): BlockNode => ({ type, payload, children, ...extra });

const rich = (text: string | JsonObject[]): JsonObject[] =>
  typeof text === "string" ? [rt(text)] : text;

export const paragraph = (text: string | JsonObject[], children?: BlockNode[]) =>
  node("paragraph", { rich_text: rich(text), color: "default" }, children);
export const heading = (level: 1 | 2 | 3, text: string) =>
  node(`heading_${level}`, { rich_text: rich(text), is_toggleable: false, color: "default" });
export const bulleted = (text: string, children?: BlockNode[]) =>
  node("bulleted_list_item", { rich_text: rich(text), color: "default" }, children);
export const numbered = (text: string, children?: BlockNode[]) =>
  node("numbered_list_item", { rich_text: rich(text), color: "default" }, children);
export const todo = (text: string, checked: boolean) =>
  node("to_do", { rich_text: rich(text), checked, color: "default" });
export const toggle = (text: string, children: BlockNode[], id?: string) =>
  node("toggle", { rich_text: rich(text), color: "default" }, children, { id });
export const quote = (text: string) => node("quote", { rich_text: rich(text), color: "default" });
export const callout = (text: string, icon: JsonObject) =>
  node("callout", { rich_text: rich(text), icon, color: "gray_background" });
export const code = (text: string, language: string) =>
  node("code", { rich_text: [rt(text)], caption: [], language });
export const divider = () => node("divider", {});
export const toc = () => node("table_of_contents", { color: "default" });
export const equation = (expression: string) => node("equation", { expression });
export const bookmark = (url: string) => node("bookmark", { caption: [], url });
export const embed = (url: string) => node("embed", { caption: [], url });
export const linkToPage = (pageId: string) =>
  node("link_to_page", { type: "page_id", page_id: pageId });
export const unsupported = () => node("unsupported", {});
export const table = (rows: string[][]) =>
  node(
    "table",
    { table_width: rows[0]?.length ?? 0, has_column_header: true, has_row_header: false },
    rows.map((r) => node("table_row", { cells: r.map((c) => [rt(c)]) })),
  );
export const columnList = (cols: BlockNode[][]) =>
  node(
    "column_list",
    {},
    cols.map((c) => node("column", {}, c)),
  );
export const childPage = (id: string, title: string) =>
  node("child_page", { title }, undefined, { id, hasChildren: true });
export const childDatabase = (id: string, title: string) =>
  node("child_database", { title }, undefined, { id, hasChildren: true });
export const syncedOriginal = (children: BlockNode[], id?: string) =>
  node("synced_block", { synced_from: null }, children, { id });
export const syncedCopy = (originalId: string) =>
  node("synced_block", { synced_from: { type: "block_id", block_id: originalId } }, undefined, {
    hasChildren: true,
  });
export const image = (file: JsonObject, caption?: string) =>
  node("image", { caption: caption ? [rt(caption)] : [], ...file });
export const fileBlock = (file: JsonObject, name: string) =>
  node("file", { caption: [], ...file, name });
export const pdf = (file: JsonObject) => node("pdf", { caption: [], ...file });
export const video = (file: JsonObject) => node("video", { caption: [], ...file });
export const audio = (file: JsonObject) => node("audio", { caption: [], ...file });

// ------------------------------------------------------------------ property values & schema

export const P = {
  title: (text: string): JsonObject => ({ id: "title", type: "title", title: [rt(text)] }),
  richText: (id: string, text: string): JsonObject => ({
    id,
    type: "rich_text",
    rich_text: [rt(text)],
  }),
  select: (id: string, name: string, color = "default"): JsonObject => ({
    id,
    type: "select",
    select: { id: `${id}-${name}`, name, color },
  }),
  multiSelect: (id: string, names: string[]): JsonObject => ({
    id,
    type: "multi_select",
    multi_select: names.map((name) => ({ id: `${id}-${name}`, name, color: "default" })),
  }),
  date: (id: string, start: string): JsonObject => ({
    id,
    type: "date",
    date: { start, end: null, time_zone: null },
  }),
  number: (id: string, n: number): JsonObject => ({ id, type: "number", number: n }),
  checkbox: (id: string, b: boolean): JsonObject => ({ id, type: "checkbox", checkbox: b }),
  url: (id: string, u: string): JsonObject => ({ id, type: "url", url: u }),
  people: (id: string, userIds: string[]): JsonObject => ({
    id,
    type: "people",
    people: userIds.map((u) => ({ object: "user", id: u })),
  }),
  relation: (id: string, ids: string[], hasMore = false): JsonObject => ({
    id,
    type: "relation",
    relation: ids.map((x) => ({ id: x })),
    has_more: hasMore,
  }),
  files: (id: string, files: Array<{ name: string; file: JsonObject }>): JsonObject => ({
    id,
    type: "files",
    files: files.map((f) => ({ name: f.name, ...f.file })),
  }),
  formula: (id: string, n: number): JsonObject => ({
    id,
    type: "formula",
    formula: { type: "number", number: n },
  }),
  rollup: (id: string, n: number): JsonObject => ({
    id,
    type: "rollup",
    rollup: { type: "number", number: n, function: "count" },
  }),
  createdTime: (id: string, iso: string): JsonObject => ({
    id,
    type: "created_time",
    created_time: iso,
  }),
};

export type PropertyDef = [name: string, id: string, type: string, config: JsonObject];
export const def = (
  name: string,
  id: string,
  type: string,
  config: JsonObject = {},
): PropertyDef => [name, id, type, config];
export const schemaOf = (...defs: PropertyDef[]): JsonObject =>
  Object.fromEntries(
    defs.map(([name, id, type, config]) => [name, { id, name, type, [type]: config }]),
  );

// ------------------------------------------------------------------ the world

type Kind = "page" | "block" | "database" | "dataSource" | "view" | "user";
const PREFIX: Record<Kind, string> = {
  page: "1",
  block: "2",
  database: "3",
  dataSource: "4",
  view: "5",
  user: "9",
};

export interface PageOptions {
  id?: string;
  title: string;
  parent: JsonObject;
  icon?: JsonObject;
  cover?: JsonObject;
  properties?: JsonObject;
  searchable?: boolean;
}

export class World {
  readonly ws: FixtureWorkspace;
  private counters: Partial<Record<Kind, number>> = {};
  private minute = 0;

  constructor(name: string) {
    this.ws = {
      name,
      pages: new Map(),
      blocks: new Map(),
      blockIndex: new Map(),
      databases: new Map(),
      dataSources: new Map(),
      rows: new Map(),
      views: new Map(),
      files: new Map(),
      propertyItems: new Map(),
      searchable: [],
    };
  }

  /** Readable, deterministic UUID-shaped ids: 1… pages, 2… blocks, 3… databases, 4… data sources. */
  id(kind: Kind): string {
    const n = (this.counters[kind] ?? 0) + 1;
    this.counters[kind] = n;
    return `${PREFIX[kind].repeat(8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;
  }

  /** Strictly increasing timestamps (row order in queries depends on it). */
  time(): string {
    this.minute++;
    return new Date(Date.UTC(2026, 0, 1) + this.minute * 60_000).toISOString();
  }

  /** Timestamp cursor for incremental tests: call right after `touch()` to get that page's stamp. */
  lastTime(): string {
    return new Date(Date.UTC(2026, 0, 1) + this.minute * 60_000).toISOString();
  }

  /** Marks an object as edited now (a fresh `last_edited_time`), so search can find it. */
  touch(obj: JsonObject): string {
    const edited = this.time();
    obj.last_edited_time = edited;
    return edited;
  }

  file(rawPath: string, body: Uint8Array, contentType: string): JsonObject {
    this.ws.files.set(rawPath, { body, contentType });
    return {
      type: "file",
      file: { url: `${FILES_HOST}/f/${rawPath}`, expiry_time: "2026-01-01T01:00:00.000Z" },
    };
  }

  page(o: PageOptions): string {
    const id = o.id ?? this.id("page");
    this.ws.pages.set(
      id,
      this.pageObject(id, o.parent, {
        title: o.title,
        icon: o.icon,
        cover: o.cover,
        properties: { title: P.title(o.title), ...(o.properties ?? {}) },
      }),
    );
    if (o.searchable !== false) this.ws.searchable.push(id);
    return id;
  }

  private pageObject(
    id: string,
    parent: JsonObject,
    o: { title: string; icon?: JsonObject; cover?: JsonObject; properties: JsonObject },
  ): JsonObject {
    return {
      object: "page",
      id,
      created_time: this.time(),
      last_edited_time: this.time(),
      cover: o.cover ?? null,
      icon: o.icon ?? null,
      parent,
      archived: false,
      in_trash: false,
      properties: o.properties,
      url: `https://www.notion.so/${id.replaceAll("-", "")}`,
      public_url: null,
    };
  }

  addBlocks(parentId: string, parentKind: "page_id" | "block_id", nodes: BlockNode[]): void {
    const list = this.ws.blocks.get(parentId) ?? [];
    for (const n of nodes) {
      const id = n.id ?? this.id("block");
      const block: JsonObject = {
        object: "block",
        id,
        parent: { type: parentKind, [parentKind]: parentId },
        created_time: this.time(),
        last_edited_time: this.time(),
        has_children: (n.children?.length ?? 0) > 0 || n.hasChildren === true,
        archived: false,
        in_trash: false,
        type: n.type,
        [n.type]: n.payload,
      };
      list.push(block);
      this.ws.blockIndex.set(id, block);
      if (n.children?.length) this.addBlocks(id, "block_id", n.children);
    }
    this.ws.blocks.set(parentId, list);
  }

  /** Blocks directly under a page. */
  body(pageId: string, nodes: BlockNode[]): void {
    this.addBlocks(pageId, "page_id", nodes);
  }

  database(o: { id?: string; title: string; parent: JsonObject; inline?: boolean }): string {
    const id = o.id ?? this.id("database");
    this.ws.databases.set(id, {
      object: "database",
      id,
      title: [rt(o.title)],
      description: [],
      parent: o.parent,
      is_inline: o.inline ?? false,
      in_trash: false,
      archived: false,
      created_time: this.time(),
      last_edited_time: this.time(),
      icon: null,
      cover: null,
      url: `https://www.notion.so/${id.replaceAll("-", "")}`,
      public_url: null,
      data_sources: [],
    });
    return id;
  }

  dataSource(databaseId: string, o: { name: string; properties: JsonObject }): string {
    const id = this.id("dataSource");
    const db = this.ws.databases.get(databaseId);
    if (!db) throw new Error(`unknown database ${databaseId}`);
    (db.data_sources as JsonObject[]).push({ id, name: o.name });
    this.ws.dataSources.set(id, {
      object: "data_source",
      id,
      title: [rt(o.name)],
      description: [],
      parent: { type: "database_id", database_id: databaseId },
      database_parent: db.parent as JsonObject,
      properties: o.properties,
      created_time: this.time(),
      last_edited_time: this.time(),
      archived: false,
      in_trash: false,
      icon: null,
    });
    this.ws.rows.set(id, []);
    this.ws.searchable.push(id);
    return id;
  }

  row(
    dataSourceId: string,
    o: { title: string; properties?: JsonObject; cover?: JsonObject; titleProperty?: string },
  ): string {
    const ds = this.ws.dataSources.get(dataSourceId);
    if (!ds) throw new Error(`unknown data source ${dataSourceId}`);
    const id = this.id("page");
    const databaseId = (ds.parent as JsonObject).database_id as string;
    this.ws.pages.set(
      id,
      this.pageObject(
        id,
        { type: "data_source_id", data_source_id: dataSourceId, database_id: databaseId },
        {
          title: o.title,
          cover: o.cover,
          properties: { [o.titleProperty ?? "Name"]: P.title(o.title), ...(o.properties ?? {}) },
        },
      ),
    );
    this.ws.rows.get(dataSourceId)?.push(id);
    this.ws.searchable.push(id);
    return id;
  }

  view(
    databaseId: string,
    o: { name: string; type: string; dataSourceId: string; configuration: JsonObject },
  ): string {
    const id = this.id("view");
    const list = this.ws.views.get(databaseId) ?? [];
    list.push({
      object: "view",
      id,
      parent: { type: "database_id", database_id: databaseId },
      name: o.name,
      type: o.type,
      created_time: this.time(),
      last_edited_time: this.time(),
      url: `https://www.notion.so/${databaseId.replaceAll("-", "")}?v=${id.replaceAll("-", "")}`,
      data_source_id: o.dataSourceId,
      filter: null,
      sorts: [],
      quick_filters: null,
      configuration: o.configuration,
    });
    this.ws.views.set(databaseId, list);
    return id;
  }

  propertyItems(pageId: string, propertyId: string, items: JsonObject[]): void {
    this.ws.propertyItems.set(`${pageId}:${propertyId}`, items);
  }
}

/** Deterministic pseudo-random bytes (so file hashes in golden files never change). */
export function bytes(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}
