/**
 * Intermediate Representation (IR) — the canonical form between extraction and rendering.
 *
 * Design goals:
 * - Renderer-agnostic: Markdown, CSV and JSON renderers all consume the same IR.
 * - Lossless within API limits: preserves every piece of content the official API exposes.
 * - Explicit stubs: non-exportable content (views, automations) is represented as `IrStub`
 *   rather than silently omitted (P1 + honesty-matrix §7).
 * - No Notion internals: internal IDs and object shapes are only kept where needed for
 *   relation resolution.
 */

// ------------------------------------------------------------------ rich text

export interface IrAnnotations {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
  /** Notion color token, e.g. "red", "blue_background". "default" → no class. */
  color: string;
}

export interface IrRichTextSpan {
  kind: "text" | "mention" | "equation";
  text: string;
  /** URL for linked text or mention. */
  href: string | null;
  annotations: IrAnnotations;
}

export type IrRichText = IrRichTextSpan[];

// ------------------------------------------------------------------ block tree

export type IrBlock =
  | IrParagraph
  | IrHeading
  | IrBulletedListItem
  | IrNumberedListItem
  | IrTodo
  | IrToggle
  | IrQuote
  | IrCallout
  | IrCode
  | IrEquation
  | IrDivider
  | IrTableOfContents
  | IrTable
  | IrTableRow
  | IrImage
  | IrVideo
  | IrAudio
  | IrFile
  | IrPdf
  | IrBookmark
  | IrEmbed
  | IrLinkToPage
  | IrChildPageRef
  | IrChildDatabaseRef
  | IrSyncedBlock
  | IrColumnList
  | IrColumn
  | IrUnsupported
  | IrStub;

interface IrBlockBase {
  id: string;
  children: IrBlock[];
}

export interface IrParagraph extends IrBlockBase {
  type: "paragraph";
  text: IrRichText;
}

export interface IrHeading extends IrBlockBase {
  type: "heading";
  level: 1 | 2 | 3;
  text: IrRichText;
  isToggleable: boolean;
}

export interface IrBulletedListItem extends IrBlockBase {
  type: "bulleted_list_item";
  text: IrRichText;
}

export interface IrNumberedListItem extends IrBlockBase {
  type: "numbered_list_item";
  text: IrRichText;
}

export interface IrTodo extends IrBlockBase {
  type: "to_do";
  text: IrRichText;
  checked: boolean;
}

export interface IrToggle extends IrBlockBase {
  type: "toggle";
  text: IrRichText;
}

export interface IrQuote extends IrBlockBase {
  type: "quote";
  text: IrRichText;
}

export interface IrCallout extends IrBlockBase {
  type: "callout";
  text: IrRichText;
  icon: IrIcon | null;
}

export interface IrCode extends IrBlockBase {
  type: "code";
  text: string;
  language: string;
  caption: IrRichText;
}

export interface IrEquation extends IrBlockBase {
  type: "equation";
  expression: string;
}

export interface IrDivider extends IrBlockBase {
  type: "divider";
}

export interface IrTableOfContents extends IrBlockBase {
  type: "table_of_contents";
}

export interface IrTable extends IrBlockBase {
  type: "table";
  hasColumnHeader: boolean;
  hasRowHeader: boolean;
}

export interface IrTableRow extends IrBlockBase {
  type: "table_row";
  cells: IrRichText[];
}

export interface IrMedia extends IrBlockBase {
  caption: IrRichText;
  /** Relative asset path (e.g. "assets/abc123-photo.png") or null if download failed. */
  assetPath: string | null;
  /** Original signed URL stripped of query params, for display fallback. */
  source: string | null;
  /** For external files: the plain URL. */
  externalUrl: string | null;
}

export interface IrImage extends IrMedia {
  type: "image";
}

export interface IrVideo extends IrMedia {
  type: "video";
}

export interface IrAudio extends IrMedia {
  type: "audio";
}

export interface IrFile extends IrMedia {
  type: "file";
  name: string;
}

export interface IrPdf extends IrMedia {
  type: "pdf";
}

export interface IrBookmark extends IrBlockBase {
  type: "bookmark";
  url: string;
  caption: IrRichText;
}

export interface IrEmbed extends IrBlockBase {
  type: "embed";
  url: string;
  caption: IrRichText;
}

export interface IrLinkToPage extends IrBlockBase {
  type: "link_to_page";
  /** Notion page or database ID. */
  targetId: string;
  targetKind: "page" | "database";
}

export interface IrChildPageRef extends IrBlockBase {
  type: "child_page_ref";
  pageId: string;
  title: string;
}

export interface IrChildDatabaseRef extends IrBlockBase {
  type: "child_database_ref";
  databaseId: string;
  title: string;
}

export interface IrSyncedBlock extends IrBlockBase {
  type: "synced_block";
  /** null when this IS the original; set to original block id for copies. */
  syncedFromId: string | null;
}

export interface IrColumnList extends IrBlockBase {
  type: "column_list";
}

export interface IrColumn extends IrBlockBase {
  type: "column";
}

export interface IrUnsupported extends IrBlockBase {
  type: "unsupported";
}

/**
 * Explicit stub for content that the official API cannot export.
 * Rendered as an HTML comment so output is complete but honest.
 */
export interface IrStub extends IrBlockBase {
  type: "stub";
  /** Human-readable description, e.g. "database view "Roadmap" (Kanban)". */
  description: string;
}

// ------------------------------------------------------------------ icons

export interface IrEmojiIcon {
  kind: "emoji";
  emoji: string;
}

export interface IrFileIcon {
  kind: "file";
  /** Relative asset path or null if download failed. */
  assetPath: string | null;
  source: string | null;
}

export interface IrExternalIcon {
  kind: "external";
  url: string;
}

export type IrIcon = IrEmojiIcon | IrFileIcon | IrExternalIcon;

// ------------------------------------------------------------------ property values (for CSV/JSON)

export type IrPropertyValue =
  | { type: "title"; text: string }
  | { type: "rich_text"; text: string }
  | { type: "number"; value: number | null }
  | { type: "select"; name: string | null }
  | { type: "multi_select"; names: string[] }
  | { type: "date"; start: string | null; end: string | null; timeZone: string | null }
  | { type: "checkbox"; checked: boolean }
  | { type: "url"; url: string | null }
  | { type: "email"; email: string | null }
  | { type: "phone_number"; phone: string | null }
  | { type: "people"; ids: string[] }
  | { type: "relation"; ids: string[] }
  | { type: "formula"; result: string }
  | { type: "rollup"; result: string }
  | { type: "created_time"; iso: string }
  | { type: "last_edited_time"; iso: string }
  | { type: "created_by"; id: string }
  | { type: "last_edited_by"; id: string }
  | { type: "files"; names: string[]; assetPaths: Array<string | null> }
  | { type: "status"; name: string | null }
  | { type: "unique_id"; prefix: string | null; number: number | null }
  | { type: "unknown"; raw: string };

// ------------------------------------------------------------------ IR documents

export interface IrComment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  resolved: boolean;
}

export interface IrCommentThread {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  resolved: boolean;
  replies: IrComment[];
}

export interface IrPage {
  id: string;
  title: string;
  /** Path segments relative to workspace root, e.g. ["Engineering Handbook", "Onboarding"]. */
  path: string[];
  lastEditedTime: string;
  icon: IrIcon | null;
  /** Whether this page is a row in a database. */
  isRow: boolean;
  /** Frontmatter properties (all defined properties for database rows). */
  properties: Record<string, IrPropertyValue>;
  /** Rendered block tree. */
  blocks: IrBlock[];
  comments: IrCommentThread[];
}

export interface IrDataSource {
  id: string;
  name: string;
  /** Property schema (ordered by name). */
  schema: Array<{ name: string; type: string }>;
  rows: IrRow[];
}

export interface IrRow {
  id: string;
  title: string;
  properties: Record<string, IrPropertyValue>;
  /** Block body (if fetched). */
  blocks: IrBlock[];
}

export interface IrDatabase {
  id: string;
  name: string;
  dataSources: IrDataSource[];
  /**
   * Views can't be exported via the official API (per honesty matrix).
   * Each view becomes a stub here so renderers can emit the HTML comment.
   */
  viewStubs: Array<{ id: string; name: string; viewType: string }>;
}

export interface IrWorkspace {
  pages: IrPage[];
  databases: IrDatabase[];
}
