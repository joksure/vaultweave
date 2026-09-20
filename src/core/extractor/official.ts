import type { NotionApi } from "./api.js";
import type { AssetDownloader, AssetRef } from "./assets.js";
import { CircuitOpenError, RequestExecutor } from "./executor.js";
import type { JsonObject } from "./json.js";
import { isObject, mapLimit, omit, plainText, stripQuery } from "./json.js";
import { collectAll } from "./paginate.js";
import type {
  ExtractedBlock,
  ExtractedDatabase,
  ExtractedDataSource,
  ExtractedPage,
  ExtractionCounts,
  ExtractionIssue,
  ExtractionResult,
} from "./types.js";

const PAGE_SIZE = 100;
/** The API returns at most this many items for title/rich_text/people/relation values. */
const PROPERTY_TRUNCATION = 25;
/** These blocks are separate resources (pages / databases); their "children" are not block children. */
const SEPARATE_RESOURCE_BLOCKS = new Set(["child_page", "child_database"]);

export interface ProgressEvent {
  kind: "page" | "database";
  id: string;
  title: string;
}

/** What a single `extract()` call is asked to do. */
export interface ExtractionOptions {
  /** Restrict the run to these page/database IDs (omit for the whole workspace). */
  roots?: readonly string[];
  /**
   * Incremental extraction: only objects edited strictly *after* this ISO timestamp are
   * discovered through search. Backing this filter with the Notion `last_edited_time`
   * filter is what makes a second run with no changes cost almost no API calls.
   * Omit for a full re-crawl. Ignored when `roots` is set (those objects are fetched by id).
   */
  sinceTimestamp?: string;
}

export interface OfficialExtractorOptions {
  api: NotionApi;
  assets: AssetDownloader;
  executor?: RequestExecutor;
  /** Parallel block-children fetches within one page. */
  concurrency?: number;
  /** Also fetch the body (blocks) of database rows. Default true. */
  rowBodies?: boolean;
  maxDepth?: number;
  onProgress?: (e: ProgressEvent) => void;
}

interface ChildRefs {
  pages: string[];
  databases: string[];
}

interface FileSite {
  holder: Record<string, unknown>;
  pointer: Array<string | number>;
}

function isFatal(err: unknown): boolean {
  return (
    err instanceof CircuitOpenError ||
    (err as { code?: string } | undefined)?.code === "unauthorized"
  );
}

function describe(err: unknown): string {
  const code = (err as { code?: string } | undefined)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  return code ? `[${code}] ${msg}` : msg;
}

function findFileSites(node: unknown, pointer: Array<string | number>, out: FileSite[]): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) findFileSites(node[i], [...pointer, i], out);
    return;
  }
  if (!isObject(node)) return;
  // Notion-hosted file: {type:"file", file:{url, expiry_time}}. External URLs are left alone.
  if (node.type === "file" && isObject(node.file) && typeof node.file.url === "string") {
    out.push({ holder: node, pointer });
    return;
  }
  for (const [k, v] of Object.entries(node))
    if (k !== "children") findFileSites(v, [...pointer, k], out);
}

function getAt(root: unknown, pointer: ReadonlyArray<string | number>): unknown {
  let cur: unknown = root;
  for (const key of pointer) {
    if (Array.isArray(cur) && typeof key === "number") cur = cur[key];
    else if (isObject(cur) && typeof key === "string") cur = cur[key];
    else return undefined;
  }
  return cur;
}

function syncedSourceId(block: ExtractedBlock): string | undefined {
  if (block.type !== "synced_block") return undefined;
  const payload = block.synced_block;
  if (!isObject(payload) || !isObject(payload.synced_from)) return undefined;
  const id = payload.synced_from.block_id;
  return typeof id === "string" ? id : undefined;
}

function pageTitle(properties: unknown): string {
  if (!isObject(properties)) return "";
  for (const prop of Object.values(properties)) {
    if (isObject(prop) && prop.type === "title") return plainText(prop.title);
  }
  return "";
}

function clone<T extends Record<string, unknown>>(raw: T): T {
  return structuredClone(omit(raw, ["request_id"]));
}

export class OfficialExtractor {
  private readonly api: NotionApi;
  private readonly assets: AssetDownloader;
  private readonly executor: RequestExecutor;
  private readonly concurrency: number;
  private readonly rowBodies: boolean;
  private readonly maxDepth: number;
  private readonly onProgress?: (e: ProgressEvent) => void;

  // --- per-run state (reset by extract) ---
  private pages = new Map<string, ExtractedPage>();
  private databases = new Map<string, ExtractedDatabase>();
  private visitedPages = new Set<string>();
  private visitedDatabases = new Set<string>();
  /** Page objects returned by this run's search (incremental runs reuse their `last_edited_time`). */
  private discovered = new Map<string, JsonObject>();
  private sinceTimestamp: string | undefined;
  private assetMap = new Map<string, AssetRef>();
  private warnings: ExtractionIssue[] = [];
  private errors: ExtractionIssue[] = [];
  private counts: ExtractionCounts = emptyCounts();
  private aborted: string | undefined;
  private incremental = false;

  constructor(opts: OfficialExtractorOptions) {
    this.api = opts.api;
    this.assets = opts.assets;
    this.executor = opts.executor ?? new RequestExecutor();
    this.concurrency = opts.concurrency ?? 3;
    this.rowBodies = opts.rowBodies ?? true;
    this.maxDepth = opts.maxDepth ?? 30;
    this.onProgress = opts.onProgress;
  }

  /**
   * Extracts everything the integration can see, or only the given roots (page or database IDs).
   * With `sinceTimestamp` only objects edited after it are found through search (incremental run).
   * Never throws for per-object problems — they are listed in `errors` and `ok` becomes false.
   * Auth failures and an unreachable Notion abort the run (`aborted`), returning what was gathered.
   */
  async extract(opts: ExtractionOptions = {}): Promise<ExtractionResult> {
    this.reset();
    // Roots are fetched by id, so a search filter would have nothing to discover: `sinceTimestamp`
    // deliberately does not apply to `roots` (those objects are known to have changed).
    this.sinceTimestamp = opts.roots && opts.roots.length > 0 ? undefined : opts.sinceTimestamp;
    this.incremental = this.sinceTimestamp !== undefined;
    try {
      if (opts.roots && opts.roots.length > 0) {
        for (const id of opts.roots) await this.extractRoot(id);
      } else {
        await this.extractEverything();
      }
    } catch (err) {
      if (!isFatal(err)) throw err;
      this.aborted = describe(err);
    }
    return this.result();
  }

  // ------------------------------------------------------------------ discovery

  private async extractEverything(): Promise<void> {
    let found: JsonObject[];
    try {
      found = await collectAll((cursor) =>
        this.exec("search", () =>
          this.api.search({
            page_size: PAGE_SIZE,
            start_cursor: cursor,
            ...(this.sinceTimestamp
              ? {
                  // Only objects edited after the cursor: Notion drops everything older,
                  // so an unchanged workspace costs one search call and nothing else.
                  filter: {
                    timestamp: "last_edited_time",
                    last_edited_time: { after: this.sinceTimestamp },
                  },
                  sort: { timestamp: "last_edited_time", direction: "ascending" },
                }
              : {}),
          }),
        ),
      );
    } catch (err) {
      if (isFatal(err)) throw err;
      // Without discovery there is nothing to extract: abort cleanly instead of throwing.
      this.aborted = `Search failed: ${describe(err)}`;
      return;
    }
    const byId = (a: JsonObject, b: JsonObject) => String(a.id).localeCompare(String(b.id));
    const foundPages = found.filter((r) => r.object === "page").sort(byId);
    const dataSources = found.filter((r) => r.object === "data_source").sort(byId);
    for (const p of foundPages) this.discovered.set(String(p.id), p);

    const databaseIds = new Set<string>(
      found.filter((r) => r.object === "database").map((r) => String(r.id)),
    );
    for (const ds of dataSources) {
      const parent = ds.parent;
      if (isObject(parent) && typeof parent.database_id === "string")
        databaseIds.add(parent.database_id);
      else
        this.warn(
          "data_source_without_database",
          String(ds.id),
          "Data source has no database parent; skipped",
        );
    }
    // In an incremental run the parent database is usually unchanged and therefore absent from
    // search: fetching it is the only way to reach its data source's rows, and it is one request.
    for (const ref of found.filter((r) => r.object === "data_source")) {
      if (isObject(ref.parent) && typeof ref.parent.database_id === "string")
        databaseIds.add(ref.parent.database_id);
    }
    // Refresh the parent of a changed page too: it carries the database schema, and its rows are
    // reached through the data source, not through the page.
    for (const page of foundPages) {
      const parent = page.parent;
      if (isObject(parent) && parent.type === "data_source_id") {
        const databaseId = parent.database_id;
        if (typeof databaseId === "string") databaseIds.add(databaseId);
      } else if (isObject(parent) && parent.type === "database_id") {
        const databaseId = parent.database_id;
        if (typeof databaseId === "string") databaseIds.add(databaseId);
      }
    }
    for (const id of [...databaseIds].sort()) await this.extractDatabase(id);

    // Top-level pages first; nested pages are reached through their parents' child_page blocks.
    const isWorkspacePage = (p: JsonObject) => isObject(p.parent) && p.parent.type === "workspace";
    for (const p of foundPages) if (isWorkspacePage(p)) await this.extractPage(String(p.id), p);

    if (this.sinceTimestamp) {
      // Incremental: everything search returned must be refreshed, whether or not a parent page
      // reached it. As in a full run, children of an already-expanded page come from its body —
      // refresh-or-reuse is therefore decided per page below, not globally.
      for (const p of foundPages) {
        const id = String(p.id);
        if (!this.visitedPages.has(id)) await this.extractPage(id, p);
      }
    } else {
      // Sweep: anything visible to the integration but not reached (e.g. parent not shared with it).
      for (const p of foundPages) {
        const id = String(p.id);
        if (this.visitedPages.has(id)) continue;
        this.warn(
          "orphan_page",
          id,
          "Reachable via search only (its parent is not accessible); extracted standalone",
        );
        await this.extractPage(id, p);
      }
    }
  }

  private async extractRoot(id: string): Promise<void> {
    let raw: JsonObject;
    try {
      raw = await this.exec("pages.retrieve", () => this.api.getPage(id));
    } catch (err) {
      if (isFatal(err)) throw err;
      const code = (err as { code?: string }).code;
      if (code === "object_not_found" || code === "validation_error") {
        await this.extractDatabase(id); // not a page: maybe a database
        return;
      }
      this.error("root_failed", id, err);
      return;
    }
    await this.extractPage(id, raw);
  }

  // ------------------------------------------------------------------ pages

  private async extractPage(id: string, hint?: JsonObject): Promise<void> {
    if (this.visitedPages.has(id)) return;
    const raw =
      hint ??
      this.discovered.get(id) ??
      (await this.exec("pages.retrieve", () => this.api.getPage(id)));
    // In an incremental run a page's body is reused when the page itself is unchanged and the
    // subtree below it is unchanged too: this is what makes an idle second run cost no calls.
    if (this.incremental && this.unchanged(raw) && !this.hasChangedDescendant(id)) return;
    this.visitedPages.add(id);
    await this.guard("page_failed", id, async () => {
      const { page, refs } = await this.buildPage(raw, true);
      this.pages.set(id, page);
      this.onProgress?.({ kind: "page", id, title: page.title });
      await this.follow(refs);
    });
  }

  private async buildPage(
    raw: JsonObject,
    withBody: boolean,
  ): Promise<{ page: ExtractedPage; refs: ChildRefs }> {
    const id = String(raw.id);
    const page = clone(raw) as unknown as ExtractedPage;
    await this.completeProperties(page);
    await this.rewriteAssets(
      page,
      () => this.exec("pages.retrieve", () => this.api.getPage(id)),
      id,
    );
    page.title = pageTitle(page.properties);
    page.blocks = [];
    let refs: ChildRefs = { pages: [], databases: [] };
    if (withBody) {
      page.blocks = await this.fetchBlocks(id, 0, new Set([id]));
      refs = this.collectChildRefs(page.blocks);
    }
    return { page, refs };
  }

  /** Follows child_page / child_database blocks found in a body. */
  private async follow(refs: ChildRefs): Promise<void> {
    for (const id of refs.pages) await this.extractPage(id);
    for (const id of refs.databases) await this.extractDatabase(id);
  }

  private collectChildRefs(
    blocks: readonly ExtractedBlock[],
    into: ChildRefs = { pages: [], databases: [] },
  ): ChildRefs {
    for (const b of blocks) {
      if (b.type === "child_page") into.pages.push(b.id);
      else if (b.type === "child_database") into.databases.push(b.id);
      this.collectChildRefs(b.children, into);
    }
    return into;
  }

  // ------------------------------------------------------------------ blocks

  private async fetchBlocks(
    parentId: string,
    depth: number,
    ancestors: ReadonlySet<string>,
  ): Promise<ExtractedBlock[]> {
    const raws = await collectAll((cursor) =>
      this.exec("blocks.children.list", () =>
        this.api.listBlockChildren({
          block_id: parentId,
          page_size: PAGE_SIZE,
          start_cursor: cursor,
        }),
      ),
    );
    const blocks = raws.map((r) => ({ ...clone(r), children: [] }) as unknown as ExtractedBlock);
    this.counts.blocks += blocks.length;

    await mapLimit(blocks, this.concurrency, async (block) => {
      await this.rewriteAssets(
        block,
        () => this.exec("blocks.retrieve", () => this.api.getBlock(block.id)),
        block.id,
      );
      if (block.type === "unsupported") {
        this.warn(
          "unsupported_block",
          block.id,
          "Block type is not supported by the Notion API; content not exported",
        );
      }
      if (SEPARATE_RESOURCE_BLOCKS.has(block.type)) return;

      // A duplicate synced block has no children of its own: read them from the original.
      const sourceId = syncedSourceId(block) ?? block.id;
      if (!block.has_children && sourceId === block.id) return;

      if (ancestors.has(sourceId)) {
        this.warn(
          "block_cycle",
          block.id,
          "Block references one of its own ancestors; not expanded again",
        );
        return;
      }
      if (depth + 1 > this.maxDepth) {
        this.warn(
          "max_depth",
          block.id,
          `Nesting deeper than ${this.maxDepth}; deeper content not exported`,
        );
        return;
      }
      try {
        block.children = await this.fetchBlocks(
          sourceId,
          depth + 1,
          new Set([...ancestors, sourceId]),
        );
      } catch (err) {
        if (isFatal(err)) throw err;
        this.error("block_children_failed", block.id, err);
        block.extraction_error = describe(err);
      }
    });
    return blocks;
  }

  // ------------------------------------------------------------------ properties

  /** Notion truncates long property values; fetch the complete list where that can happen. */
  private async completeProperties(page: ExtractedPage): Promise<void> {
    if (!isObject(page.properties)) return;
    for (const [name, prop] of Object.entries(page.properties)) {
      if (!isObject(prop) || typeof prop.type !== "string") continue;
      const type = prop.type;
      const value = prop[type];
      let truncated = false;
      if (type === "relation") truncated = prop.has_more === true;
      else if (type === "title" || type === "rich_text" || type === "people") {
        truncated = Array.isArray(value) && value.length >= PROPERTY_TRUNCATION;
      } else if (type === "rollup" && isObject(value) && Array.isArray(value.array)) {
        if (value.array.length >= PROPERTY_TRUNCATION) {
          this.warn(
            "rollup_maybe_truncated",
            page.id,
            `Rollup "${name}" has ${value.array.length} items; the API may have truncated it`,
          );
        }
      }
      if (!truncated) continue;
      try {
        const items = await collectAll((cursor) =>
          this.exec("pages.properties.retrieve", () =>
            this.api.getPageProperty({
              page_id: page.id,
              property_id: String(prop.id),
              page_size: PAGE_SIZE,
              start_cursor: cursor,
            }),
          ),
        );
        prop[type] = items.map((item) => item[type]);
        if (type === "relation") prop.has_more = false;
      } catch (err) {
        if (isFatal(err)) throw err;
        this.error("property_incomplete", page.id, err, `property "${name}" may be truncated`);
      }
    }
  }

  // ------------------------------------------------------------------ databases

  private async extractDatabase(id: string): Promise<void> {
    if (this.visitedDatabases.has(id)) return;
    this.visitedDatabases.add(id);
    await this.guard("database_failed", id, async () => {
      const raw = await this.exec("databases.retrieve", () => this.api.getDatabase(id));
      const db = clone(raw);
      await this.rewriteAssets(
        db,
        () => this.exec("databases.retrieve", () => this.api.getDatabase(id)),
        id,
      );

      const refs: ChildRefs = { pages: [], databases: [] };
      const dataSources: ExtractedDataSource[] = [];
      const sourceRefs: unknown[] = Array.isArray(raw.data_sources) ? raw.data_sources : [];
      for (const ref of sourceRefs) {
        if (isObject(ref)) dataSources.push(await this.extractDataSource(String(ref.id), refs));
      }

      const views = await this.extractViews(id);
      const out = {
        ...db,
        name: plainText(raw.title),
        data_sources: dataSources,
        views,
      } as unknown as ExtractedDatabase;
      this.databases.set(id, out);
      this.onProgress?.({ kind: "database", id, title: out.name });
      await this.follow(refs);
    });
  }

  private async extractDataSource(id: string, refs: ChildRefs): Promise<ExtractedDataSource> {
    const raw = await this.exec("data_sources.retrieve", () => this.api.getDataSource(id));
    const ds = clone(raw);
    await this.rewriteAssets(
      ds,
      () => this.exec("data_sources.retrieve", () => this.api.getDataSource(id)),
      id,
    );

    const rowObjects = await collectAll((cursor) =>
      this.exec("data_sources.query", () =>
        this.api.queryDataSource({
          data_source_id: id,
          page_size: PAGE_SIZE,
          start_cursor: cursor,
        }),
      ),
    );
    const rows: ExtractedPage[] = [];
    for (const rowObj of rowObjects) {
      const rowId = String(rowObj.id);
      this.visitedPages.add(rowId);
      const built = await this.guard("row_failed", rowId, () =>
        this.buildPage(rowObj, this.rowBodies),
      );
      if (!built) continue;
      rows.push(built.page);
      refs.pages.push(...built.refs.pages);
      refs.databases.push(...built.refs.databases);
    }
    this.counts.rows += rows.length;
    return { ...ds, name: plainText(raw.title), rows } as unknown as ExtractedDataSource;
  }

  private async extractViews(databaseId: string): Promise<Array<Record<string, unknown>>> {
    const views: Array<Record<string, unknown>> = [];
    let refs: JsonObject[];
    try {
      refs = await collectAll((cursor) =>
        this.exec("views.list", () =>
          this.api.listViews({
            database_id: databaseId,
            page_size: PAGE_SIZE,
            start_cursor: cursor,
          }),
        ),
      );
    } catch (err) {
      if (isFatal(err)) throw err;
      this.error("views_failed", databaseId, err);
      return views;
    }
    for (const ref of refs) {
      const viewId = String(ref.id);
      try {
        const view = clone(await this.exec("views.retrieve", () => this.api.getView(viewId)));
        // A "partial" view object has no name/url: the definition itself was not returned.
        if (typeof view.name !== "string") {
          this.warn(
            "view_partial",
            viewId,
            "Notion returned only a partial view object; configuration not exported",
          );
        }
        views.push(view);
      } catch (err) {
        if (isFatal(err)) throw err;
        this.error("view_failed", viewId, err);
      }
    }
    this.counts.views += views.length;
    return views;
  }

  // ------------------------------------------------------------------ files

  /**
   * Downloads every Notion-hosted file inside `item` right now (signed URLs expire) and replaces
   * `{type:"file", file:{url}}` by `{type:"file", file:{source, asset}}`. A failed download keeps
   * `asset: null` and is reported as an error — never silently dropped.
   */
  private async rewriteAssets(
    item: Record<string, unknown>,
    refetch: () => Promise<JsonObject>,
    ownerId: string,
  ): Promise<void> {
    const sites: FileSite[] = [];
    findFileSites(item, [], sites);
    for (const site of sites) {
      const file = site.holder.file as Record<string, unknown>;
      const source = stripQuery(String(file.url));
      const name = typeof site.holder.name === "string" ? site.holder.name : undefined;
      try {
        const asset = await this.assets.download({
          url: String(file.url),
          name,
          refreshUrl: async () => {
            const node = getAt(await refetch(), site.pointer);
            if (isObject(node) && isObject(node.file) && typeof node.file.url === "string")
              return node.file.url;
            throw new Error("File is no longer present on the object");
          },
        });
        this.assetMap.set(asset.path, asset);
        site.holder.file = { source, asset };
      } catch (err) {
        if (isFatal(err)) throw err;
        this.error("asset_download_failed", ownerId, err, source);
        site.holder.file = { source, asset: null };
      }
    }
  }

  // ------------------------------------------------------------------ incremental decisions

  /** True when the object's `last_edited_time` is not after the cursor (i.e. it did not change). */
  private unchanged(raw: JsonObject): boolean {
    const edited = raw.last_edited_time;
    if (typeof edited !== "string" || !this.sinceTimestamp) return false;
    const at = Date.parse(edited);
    const since = Date.parse(this.sinceTimestamp);
    // An unparseable timestamp is treated as "changed": re-fetching is the safe direction.
    if (Number.isNaN(at) || Number.isNaN(since)) return false;
    return at <= since;
  }

  /**
   * Whether a block-level edit was seen anywhere below `id`. A parent page only needs re-fetching
   * when a descendant block (its own children, recursively) was edited after the cursor — the
   * search filter surfaces edited *blocks* by reporting the page (or the container block) they
   * live in. Deeper descendants stay owned by their own parent's body.
   */
  private hasChangedDescendant(id: string): boolean {
    for (const [changedId, edited] of this.discovered) {
      if (changedId === id) continue;
      const parent = this.parentId(edited);
      if (parent !== null && parent === id) return true;
    }
    return false;
  }

  /** `parent` of a Notion object as a plain id, or null when it points at nothing (workspace). */
  private parentId(obj: JsonObject): string | null {
    const parent = obj.parent;
    if (!isObject(parent)) return null;
    for (const key of ["page_id", "database_id", "block_id", "data_source_id"]) {
      const value = parent[key];
      if (typeof value === "string") return value;
    }
    return null;
  }

  // ------------------------------------------------------------------ plumbing

  private exec<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return this.executor.run(label, fn);
  }

  private async guard<T>(code: string, id: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (isFatal(err)) throw err;
      this.error(code, id, err);
      return undefined;
    }
  }

  private warn(code: string, id: string, message: string): void {
    this.warnings.push({ code, id, message });
  }

  private error(code: string, id: string, err: unknown, detail?: string): void {
    this.errors.push({
      code,
      id,
      message: detail ? `${describe(err)} (${detail})` : describe(err),
    });
  }

  private reset(): void {
    this.pages = new Map();
    this.databases = new Map();
    this.visitedPages = new Set();
    this.visitedDatabases = new Set();
    this.discovered = new Map();
    this.sinceTimestamp = undefined;
    this.incremental = false;
    this.assetMap = new Map();
    this.warnings = [];
    this.errors = [];
    this.counts = emptyCounts();
    this.aborted = undefined;
  }

  private result(): ExtractionResult {
    const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
    const databases = [...this.databases.values()].sort(byId);
    const assets = [...this.assetMap.values()].sort((a, b) => a.path.localeCompare(b.path));
    const issueOrder = (a: ExtractionIssue, b: ExtractionIssue) =>
      a.code.localeCompare(b.code) ||
      a.id.localeCompare(b.id) ||
      a.message.localeCompare(b.message);

    const counts: ExtractionCounts = {
      ...this.counts,
      pages: this.pages.size,
      databases: databases.length,
      dataSources: databases.reduce((n, d) => n + d.data_sources.length, 0),
      assets: assets.length,
    };
    const result: ExtractionResult = {
      pages: [...this.pages.values()].sort(byId),
      databases,
      assets,
      warnings: [...this.warnings].sort(issueOrder),
      errors: [...this.errors].sort(issueOrder),
      ok: this.errors.length === 0 && this.aborted === undefined,
      stats: {
        ...this.executor.stats,
        counts,
        assetsDownloaded: this.assets.stats.downloaded,
        assetBytes: this.assets.stats.bytes,
        assetUrlRefreshes: this.assets.stats.urlRefreshes,
      },
    };
    Object.defineProperty(result, "incremental", { value: this.incremental, enumerable: false });
    if (this.aborted !== undefined) result.aborted = this.aborted;
    return result;
  }
}

function emptyCounts(): ExtractionCounts {
  return { pages: 0, databases: 0, dataSources: 0, rows: 0, blocks: 0, views: 0, assets: 0 };
}
