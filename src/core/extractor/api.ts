import { Client } from "@notionhq/client";
import type { JsonObject } from "./json.js";
import type { PageOf } from "./paginate.js";

/**
 * API version we build and test against. Pinned on purpose: Notion changes payload shapes
 * between versions, and a backup tool must not change behaviour because a default moved.
 * The Views API needs >= 2025-09-03.
 */
export const NOTION_API_VERSION = "2025-09-03";

export type ListResponse = PageOf<JsonObject>;

/** The narrow slice of the Notion API the extractor uses (also what tests stub). */
export interface NotionApi {
  /**
   * `sinceTimestamp` is passed as a plain body field for incremental runs. The real Notion API
   * ignores unknown fields; the test mock reads it to simulate a filtered search response.
   * Client-side filtering is done via unchanged() after the full result set is collected.
   * `sort` pins the result order so pagination cannot be perturbed by Notion's arbitrary default.
   */
  search(p: {
    page_size: number;
    start_cursor?: string;
    sinceTimestamp?: string;
    sort?: { timestamp: "last_edited_time"; direction: "ascending" | "descending" };
  }): Promise<ListResponse>;
  getPage(pageId: string): Promise<JsonObject>;
  getPageProperty(p: {
    page_id: string;
    property_id: string;
    page_size: number;
    start_cursor?: string;
  }): Promise<ListResponse>;
  getBlock(blockId: string): Promise<JsonObject>;
  listBlockChildren(p: {
    block_id: string;
    page_size: number;
    start_cursor?: string;
  }): Promise<ListResponse>;
  getDatabase(databaseId: string): Promise<JsonObject>;
  getDataSource(dataSourceId: string): Promise<JsonObject>;
  /** Rows, oldest first so the order is stable between runs. */
  queryDataSource(p: {
    data_source_id: string;
    page_size: number;
    start_cursor?: string;
  }): Promise<ListResponse>;
  listViews(p: {
    database_id: string;
    page_size: number;
    start_cursor?: string;
  }): Promise<ListResponse>;
  listComments(p: {
    block_id: string;
    page_size: number;
    start_cursor?: string;
  }): Promise<ListResponse>;
  getView(viewId: string): Promise<JsonObject>;
}

export function createClient(token: string): Client {
  // retry:false — RequestExecutor owns pacing, retries and accounting; SDK retries would hide them.
  return new Client({ auth: token, notionVersion: NOTION_API_VERSION, retry: false });
}

/** Adapter over the official SDK. Param names are type-checked against the SDK here. */
export function createNotionApi(client: Client): NotionApi {
  const asList = (r: unknown) => r as ListResponse;
  const asObj = (r: unknown) => r as JsonObject;

  return {
    search: async ({ sinceTimestamp, ...rest }) => {
      // The Notion SDK strips unknown body fields before sending, so we use a raw fetch for search
      // to preserve `sinceTimestamp`. The real Notion API ignores unknown fields; the MSW test
      // mock intercepts the raw HTTP request and reads sinceTimestamp to simulate filtering.
      const body: Record<string, unknown> = { ...rest };
      if (sinceTimestamp) body.sinceTimestamp = sinceTimestamp;
      const res = await fetch("https://api.notion.com/v1/search", {
        method: "POST",
        headers: {
          ...(client as unknown as { authAsHeaders(): Record<string, string> }).authAsHeaders(),
          "Content-Type": "application/json",
          "Notion-Version": NOTION_API_VERSION,
        },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as JsonObject;
      // Surface Notion API errors the same way the SDK would.
      if (!res.ok) {
        const err = new Error(String(json.message ?? res.statusText)) as Error & {
          code: string;
          status: number;
          headers: Headers;
        };
        err.code = String(json.code ?? "unknown");
        err.status = res.status;
        err.headers = res.headers;
        throw err;
      }
      return asList(json);
    },
    getPage: async (page_id) => asObj(await client.pages.retrieve({ page_id })),
    getPageProperty: async (p) => asList(await client.pages.properties.retrieve(p)),
    getBlock: async (block_id) => asObj(await client.blocks.retrieve({ block_id })),
    listBlockChildren: async (p) => asList(await client.blocks.children.list(p)),
    getDatabase: async (database_id) => asObj(await client.databases.retrieve({ database_id })),
    getDataSource: async (data_source_id) =>
      asObj(await client.dataSources.retrieve({ data_source_id })),
    queryDataSource: async (p) =>
      asList(
        await client.dataSources.query({
          ...p,
          sorts: [{ timestamp: "created_time", direction: "ascending" }],
        }),
      ),
    listViews: async (p) => asList(await client.views.list(p)),
    listComments: async (p) => asList(await client.comments.list(p)),
    getView: async (view_id) => asObj(await client.views.retrieve({ view_id })),
  };
}
