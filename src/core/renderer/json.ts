/**
 * JSON renderer: IrWorkspace → structured JSON outputs.
 *
 * Two outputs per database:
 *   1. `<db-name>.rows.json`  — rows as objects (schema + properties).
 *   2. `relations.json`       — workspace-wide relation map (page id → title + database + path).
 *
 * The relation map lets tools resolve the IDs stored in CSV relation columns
 * without re-fetching the API.
 */

import type { IrDatabase, IrDataSource, IrPropertyValue, IrWorkspace } from "../normalizer/ir.js";

// ------------------------------------------------------------------ types for the JSON output

export interface JsonRow {
  id: string;
  title: string;
  properties: Record<string, JsonPropertyValue>;
}

export type JsonPropertyValue =
  | null
  | string
  | number
  | boolean
  | string[]
  | { start: string | null; end: string | null; timeZone: string | null }
  | { prefix: string | null; number: number | null };

export interface JsonDataSourceExport {
  dataSourceId: string;
  dataSourceName: string;
  schema: Array<{ name: string; type: string }>;
  rows: JsonRow[];
}

export interface RelationEntry {
  /** Page / row title. */
  title: string;
  /** Notion database id this page is a row of (null for standalone pages). */
  databaseId: string | null;
  /** Human-readable path segments. */
  path: string[];
}

export type RelationMap = Record<string, RelationEntry>;

// ------------------------------------------------------------------ property serialization

function propToJson(v: IrPropertyValue): JsonPropertyValue {
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
      return { start: v.start, end: v.end, timeZone: v.timeZone };
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
      if (v.prefix !== null && v.number !== null) return { prefix: v.prefix, number: v.number };
      if (v.number !== null) return { prefix: null, number: v.number };
      return null;
    case "unknown":
      return null;
  }
}

// ------------------------------------------------------------------ main exports

/**
 * Serialises one data source to a `JsonDataSourceExport` object (to be written as JSON).
 */
export function renderDataSourceJson(_db: IrDatabase, ds: IrDataSource): JsonDataSourceExport {
  return {
    dataSourceId: ds.id,
    dataSourceName: ds.name,
    schema: ds.schema,
    rows: ds.rows.map((row) => ({
      id: row.id,
      title: row.title,
      properties: Object.fromEntries(
        Object.entries(row.properties).map(([k, v]) => [k, propToJson(v)]),
      ),
    })),
  };
}

/**
 * Builds a workspace-wide relation map so CSV relation IDs can be resolved offline.
 *
 * The map is keyed by Notion page/row id and includes:
 * - `title`       — human-readable name.
 * - `databaseId`  — parent database id (null for standalone pages).
 * - `path`        — breadcrumb path segments.
 */
export function renderRelationMap(workspace: IrWorkspace): RelationMap {
  const map: RelationMap = {};

  // Standalone pages
  for (const page of workspace.pages) {
    map[page.id] = { title: page.title, databaseId: null, path: page.path };
  }

  // Database rows
  for (const db of workspace.databases) {
    for (const ds of db.dataSources) {
      for (const row of ds.rows) {
        map[row.id] = { title: row.title, databaseId: db.id, path: [db.name, row.title] };
      }
    }
  }

  return map;
}
