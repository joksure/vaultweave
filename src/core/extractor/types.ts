import type { AssetRef } from "./assets.js";
import type { ExecutorStats } from "./executor.js";

/**
 * The extraction model is deliberately *lossless*: it is the API payload, minus `request_id`,
 * plus what the extractor resolved (nested `children`, complete properties, downloaded files).
 * Deciding what is "noise" is the normalizer's job (M2), not the extractor's.
 *
 * Signed file URLs never appear: `{type:"file", file:{url, expiry_time}}` becomes
 * `{type:"file", file:{source, asset}}` where `source` is the URL without its signature and
 * `asset` points at the downloaded copy (or is `null` if the download failed — see `errors`).
 */

export interface ExtractedBlock {
  id: string;
  type: string;
  has_children: boolean;
  /** Fully resolved child blocks (empty for child_page/child_database — those are separate resources). */
  children: ExtractedBlock[];
  /** Present when this block's children could not be fetched. */
  extraction_error?: string;
  [key: string]: unknown;
}

export interface ExtractedComment {
  id: string;
  parent_id: string;
  text: string;
  created_by: string;
  created_time: string;
  resolved: boolean;
  replies: ExtractedComment[];
}

export interface ExtractedPage {
  id: string;
  /** Plain-text title derived from the title property. */
  title: string;
  parent: Record<string, unknown>;
  last_edited_time: string;
  properties: Record<string, unknown>;
  blocks: ExtractedBlock[];
  comments?: ExtractedComment[];
  [key: string]: unknown;
}

export interface ExtractedDataSource {
  id: string;
  name: string;
  /** Schema: property definitions. */
  properties: Record<string, unknown>;
  rows: ExtractedPage[];
  [key: string]: unknown;
}

export interface ExtractedDatabase {
  id: string;
  /** Plain-text name (the raw rich-text `title` is kept as-is). */
  name: string;
  data_sources: ExtractedDataSource[];
  /** View definitions (table/board/calendar/…) as returned by the Views API. */
  views: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ExtractionIssue {
  /** Machine-readable category, e.g. "asset_download_failed". */
  code: string;
  /** Notion object the issue concerns. */
  id: string;
  message: string;
}

export interface ExtractionCounts {
  pages: number;
  databases: number;
  dataSources: number;
  rows: number;
  blocks: number;
  views: number;
  assets: number;
}

export interface ExtractionStats extends ExecutorStats {
  counts: ExtractionCounts;
  assetsDownloaded: number;
  assetBytes: number;
  assetUrlRefreshes: number;
}

export interface ExtractionResult {
  /** Pages that are not database rows, sorted by id. */
  pages: ExtractedPage[];
  /** Databases with their data sources, rows and views, sorted by id. */
  databases: ExtractedDatabase[];
  /** Page comments when the API exposes them; omitted by legacy extractors. */
  comments?: ExtractedComment[];
  /** Every downloaded file, unique, sorted by path. */
  assets: AssetRef[];
  /** Things that are incomplete but not failures (e.g. a truncated rollup). */
  warnings: ExtractionIssue[];
  /** Things that failed. Any entry here means the backup is NOT complete. */
  errors: ExtractionIssue[];
  /** Set when the run was cut short (auth failure, Notion unreachable). */
  aborted?: string;
  /** True only if nothing failed and the run was not aborted. */
  ok: boolean;
  /** True when this result was produced with a time-filtered search. */
  incremental?: boolean;
  stats: ExtractionStats;
}
