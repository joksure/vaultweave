import { HttpResponse, http, type RequestHandler } from "msw";
import type { JsonObject } from "../../src/core/extractor/json.js";
import { FILES_HOST, FIXTURE_TOKEN, type FixtureWorkspace } from "./world.js";

const API = "https://api.notion.com/v1";

export interface FakeOptions {
  token?: string;
  /** Answer 429 to every Nth API request (the 429s themselves are counted). */
  rateLimitEvery?: number;
  retryAfterSeconds?: number;
  /** Fail requests whose "METHOD /v1/path" matches, the first `times` times. */
  failures?: Array<{ match: RegExp; status: number; times: number }>;
  /** Signed file URLs stop working after this many further API requests. Default: never. */
  urlTtl?: number;
  /**
   * Honor `filter.timestamp === "last_edited_time"` in search by dropping older objects, as the
   * real API does. Off by default: the golden tests mock a server that returns everything.
   */
  honorSearchFilters?: boolean;
  /** The first GET of every file answers 403, as if its signature had just expired. */
  expireFirstFetch?: boolean;
  /** Search result order. Real Notion's order is arbitrary; the extractor must not depend on it. */
  searchOrder?: "asc" | "desc";
  /** Raw file paths that answer 404. */
  missingFiles?: string[];
}

const CODES: Record<number, string> = {
  400: "validation_error",
  401: "unauthorized",
  404: "object_not_found",
  429: "rate_limited",
  500: "internal_server_error",
  502: "gateway_timeout",
  503: "service_unavailable",
};

function errorResponse(status: number, message: string, headers: Record<string, string> = {}) {
  return HttpResponse.json(
    {
      object: "error",
      status,
      code: CODES[status] ?? "internal_server_error",
      message,
      request_id: "req_fixture",
    },
    { status, headers },
  );
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function paginate(
  items: JsonObject[],
  pageSize: number | undefined,
  cursor: string | null | undefined,
) {
  const size = pageSize ?? 100;
  if (size > 100) throw new HttpError(400, "page_size must be <= 100");
  const start = cursor ? Number(Buffer.from(cursor, "base64").toString("utf8")) : 0;
  const next = start + size;
  const hasMore = next < items.length;
  return {
    object: "list",
    results: items.slice(start, next),
    next_cursor: hasMore ? Buffer.from(String(next)).toString("base64") : null,
    has_more: hasMore,
  };
}

export function createFakeNotion(ws: FixtureWorkspace, opts: FakeOptions = {}) {
  const token = opts.token ?? FIXTURE_TOKEN;
  /** "METHOD /v1/path" of every API request that reached the server (file downloads excluded). */
  const log: string[] = [];
  const fileLog: string[] = [];
  const state = { requests: 0 };
  const failureCounts = new Map<number, number>();
  const fetchedFiles = new Set<string>();

  const sign = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v.startsWith(`${FILES_HOST}/`) ? `${v}?X-Sig=${state.requests}&X-Expires=3600` : v;
    }
    if (Array.isArray(v)) return v.map(sign);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sign(x)]));
    }
    return v;
  };

  const notFound = (what: string, id: string) =>
    new HttpError(404, `Could not find ${what} with ID: ${id}.`);

  function route(
    method: "get" | "post",
    path: string,
    fn: (ctx: { params: Record<string, string>; url: URL; body: JsonObject }) => JsonObject,
  ): RequestHandler {
    return http[method](`${API}${path}`, async ({ request, params }) => {
      const url = new URL(request.url);
      const label = `${request.method} ${url.pathname}`;
      state.requests++;
      log.push(label);

      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return errorResponse(401, "API token is invalid.");
      }
      if (opts.rateLimitEvery && state.requests % opts.rateLimitEvery === 0) {
        return errorResponse(429, "You have been rate limited.", {
          "retry-after": String(opts.retryAfterSeconds ?? 1),
        });
      }
      for (const [i, f] of (opts.failures ?? []).entries()) {
        const done = failureCounts.get(i) ?? 0;
        if (f.match.test(label) && done < f.times) {
          failureCounts.set(i, done + 1);
          return errorResponse(f.status, "Injected failure.");
        }
      }
      try {
        const body =
          method === "post" ? ((await request.json().catch(() => ({}))) as JsonObject) : {};
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(params)) flat[k] = String(v);
        return HttpResponse.json(sign(fn({ params: flat, url, body })) as JsonObject);
      } catch (err) {
        if (err instanceof HttpError) return errorResponse(err.status, err.message);
        throw err;
      }
    });
  }

  const num = (v: string | null | undefined) => (v ? Number(v) : undefined);

  const handlers: RequestHandler[] = [
    route("post", "/search", ({ body }) => {
      let ids = [...ws.searchable];
      if (opts.searchOrder === "desc") ids = ids.reverse();
      let items = ids.map((id) => (ws.pages.get(id) ?? ws.dataSources.get(id)) as JsonObject);
      const filter = body.filter as
        | { timestamp?: string; last_edited_time?: { after?: string } }
        | undefined;
      const after =
        filter?.timestamp === "last_edited_time" ? filter.last_edited_time?.after : undefined;
      if (opts.honorSearchFilters && after) {
        const cursor = Date.parse(after);
        // The real API only returns objects that *changed*; an object whose timestamp is at or
        // before the cursor is left out entirely.
        items = items.filter((o) => {
          const edited = o.last_edited_time;
          return typeof edited === "string" && Date.parse(edited) > cursor;
        });
      }
      const sorts = (body.sorts as JsonObject[] | undefined) ?? [];
      const sort = body.sort as JsonObject | undefined;
      const allSorts = sort ? [sort, ...sorts] : sorts;
      const byEdited = allSorts.find(
        (s) => s.timestamp === "last_edited_time" && s.direction === "ascending",
      );
      if (byEdited) {
        items = [...items].sort((a, b) =>
          String(a.last_edited_time).localeCompare(String(b.last_edited_time)),
        );
      }
      return paginate(
        items,
        body.page_size as number | undefined,
        body.start_cursor as string | undefined,
      );
    }),

    route("get", "/pages/:id", ({ params }) => {
      const page = ws.pages.get(params.id as string);
      if (!page) throw notFound("page", params.id as string);
      return page;
    }),

    route("get", "/pages/:pageId/properties/:propId", ({ params, url }) => {
      const items = ws.propertyItems.get(`${params.pageId}:${params.propId}`);
      if (!items) throw notFound("property", params.propId as string);
      return {
        ...paginate(
          items,
          num(url.searchParams.get("page_size")),
          url.searchParams.get("start_cursor"),
        ),
        type: "property_item",
        property_item: {
          id: params.propId as string,
          next_url: null,
          type: "relation",
          relation: {},
        },
      };
    }),

    route("get", "/blocks/:id", ({ params }) => {
      const block = ws.blockIndex.get(params.id as string);
      if (!block) throw notFound("block", params.id as string);
      return block;
    }),

    route("get", "/blocks/:id/children", ({ params, url }) => {
      const id = params.id as string;
      const known = ws.pages.has(id) || ws.blockIndex.has(id);
      if (!known) throw notFound("block", id);
      return paginate(
        ws.blocks.get(id) ?? [],
        num(url.searchParams.get("page_size")),
        url.searchParams.get("start_cursor"),
      );
    }),

    route("get", "/databases/:id", ({ params }) => {
      const db = ws.databases.get(params.id as string);
      if (!db) throw notFound("database", params.id as string);
      return db;
    }),

    route("get", "/data_sources/:id", ({ params }) => {
      const ds = ws.dataSources.get(params.id as string);
      if (!ds) throw notFound("data_source", params.id as string);
      return ds;
    }),

    route("post", "/data_sources/:id/query", ({ params, body }) => {
      const id = params.id as string;
      const rowIds = ws.rows.get(id);
      if (!rowIds) throw notFound("data_source", id);
      let rows = rowIds.map((r) => ws.pages.get(r) as JsonObject);
      const sorts = (body.sorts as JsonObject[] | undefined) ?? [];
      const byCreated = sorts.some(
        (s) => s.timestamp === "created_time" && s.direction === "ascending",
      );
      // Without an explicit sort real Notion gives no ordering guarantee: make that visible.
      rows = byCreated ? rows : [...rows].reverse();
      return paginate(
        rows,
        body.page_size as number | undefined,
        body.start_cursor as string | undefined,
      );
    }),

    route("get", "/views", ({ url }) => {
      const dbId = url.searchParams.get("database_id");
      if (!dbId || !ws.databases.has(dbId)) throw notFound("database", String(dbId));
      const refs = (ws.views.get(dbId) ?? []).map((v) => ({ object: "view", id: v.id as string }));
      return paginate(
        refs,
        num(url.searchParams.get("page_size")),
        url.searchParams.get("start_cursor"),
      );
    }),

    route("get", "/views/:id", ({ params }) => {
      for (const list of ws.views.values()) {
        const v = list.find((x) => x.id === params.id);
        if (v) return v;
      }
      throw notFound("view", params.id as string);
    }),

    // Notion-hosted files (S3-like): signature must be present and fresh.
    http.get(`${FILES_HOST}/f/*`, ({ request }) => {
      const url = new URL(request.url);
      const raw = url.pathname.slice("/f/".length);
      fileLog.push(raw);
      const denied = () =>
        new HttpResponse(
          "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>",
          {
            status: 403,
            headers: { "content-type": "application/xml" },
          },
        );
      if (opts.missingFiles?.includes(raw)) return new HttpResponse("Not found", { status: 404 });
      const sig = Number(url.searchParams.get("X-Sig"));
      if (!url.searchParams.has("X-Sig")) return denied();
      if (opts.urlTtl !== undefined && state.requests - sig > opts.urlTtl) return denied();
      if (opts.expireFirstFetch && !fetchedFiles.has(raw)) {
        fetchedFiles.add(raw);
        return denied();
      }
      const file = ws.files.get(raw);
      if (!file) return new HttpResponse("Not found", { status: 404 });
      return new HttpResponse(file.body, {
        status: 200,
        headers: {
          "content-type": file.contentType,
          "content-length": String(file.body.byteLength),
        },
      });
    }),
  ];

  return { handlers, log, fileLog, state };
}
