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
   * `filter.last_edited_time` is the documented search filter for incremental sync; the pinned
   * SDK's `SearchParameters` type does not describe it yet (it is passed through as a body key).
   * `sort` pins the result order so pagination cannot be perturbed by Notion's arbitrary default.
   */
  search(p: {
    page_size: number;
    start_cursor?: string;
    filter?: {
      timestamp: "last_edited_time";
      last_edited_time: { after: string };
    };
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
    search: async (p) =>
      asList(await client.search({ ...p } as unknown as Parameters<Client["search"]>[0])),
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
