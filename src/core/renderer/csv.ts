/**
 * CSV renderer: IrDataSource → CSV string (RFC 4180).
 *
 * - First row = headers (sorted alphabetically, matching IrDataSource.schema).
 * - Every subsequent row = one database row.
 * - Relation properties render as semicolon-separated page IDs (resolvable via
 *   the JSON relation map produced by renderRelationMap()).
 * - Files render as semicolon-separated asset paths.
 * - Multi-value fields (multi_select, people, relation) use "; " as separator.
 * - Complex types (formula, rollup) render as their computed string value.
 * - null / undefined → empty cell.
 */

import type { IrDataSource, IrPropertyValue } from "../normalizer/ir.js";

// ------------------------------------------------------------------ helpers

function escapeCell(value: string): string {
  if (/[,"\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function propToCsv(v: IrPropertyValue): string {
  switch (v.type) {
    case "title":
    case "rich_text":
      return v.text;
    case "number":
      return v.value === null ? "" : String(v.value);
    case "select":
    case "status":
      return v.name ?? "";
    case "multi_select":
      return v.names.join("; ");
    case "date":
      if (!v.start) return "";
      return v.end ? `${v.start}/${v.end}` : v.start;
    case "checkbox":
      return v.checked ? "true" : "false";
    case "url":
      return v.url ?? "";
    case "email":
      return v.email ?? "";
    case "phone_number":
      return v.phone ?? "";
    case "people":
      return v.ids.join("; ");
    case "relation":
      return v.ids.join("; ");
    case "formula":
    case "rollup":
      return v.result;
    case "created_time":
    case "last_edited_time":
      return v.iso;
    case "created_by":
    case "last_edited_by":
      return v.id;
    case "files":
      return v.assetPaths.map((p, i) => p ?? v.names[i] ?? "").join("; ");
    case "unique_id":
      if (v.prefix !== null && v.number !== null) return `${v.prefix}-${v.number}`;
      if (v.number !== null) return String(v.number);
      return "";
    case "unknown":
      return v.raw;
  }
}

// ------------------------------------------------------------------ main export

/**
 * Renders an `IrDataSource` as an RFC 4180 CSV string.
 *
 * Column order matches `dataSource.schema` (alphabetical by name).
 */
export function renderDataSourceCsv(dataSource: IrDataSource): string {
  const headers = dataSource.schema.map((s) => s.name);
  if (headers.length === 0) return "";

  const lines: string[] = [];

  // Header row
  lines.push(headers.map(escapeCell).join(","));

  // Data rows
  for (const row of dataSource.rows) {
    const cells = headers.map((header) => {
      const val = row.properties[header];
      return val ? escapeCell(propToCsv(val)) : "";
    });
    lines.push(cells.join(","));
  }

  return `${lines.join("\r\n")}\r\n`;
}
