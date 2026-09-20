/**
 * Single source of truth for the "honesty matrix" (design principle P1).
 *
 * CAPABILITIES.md is generated from this list, the `capabilities` CLI command
 * prints it, and CI fails if the committed file drifts from it.
 * Never claim something in docs that is not encoded here.
 */

export type Status = "supported" | "partial" | "unsupported";

export interface Capability {
  id: string;
  name: string;
  /** What the official Notion API allows. */
  official: Status;
  /** What the opt-in internal (token_v2) path allows. */
  internal: Status;
  officialNote?: string;
  internalNote?: string;
  /** Milestone in which the tool starts exporting this; `null` when it never will. */
  plannedIn: "M1" | "M2" | null;
  /**
   * True once the library extractor (and the experimental `extract` command) captures this.
   * It is not yet rendered to Markdown/CSV, so it does not count as `implemented`.
   */
  extracted: boolean;
  /** True only once `backup`/`sync` really export this. Keep in sync with reality. */
  implemented: boolean;
}

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "pages",
    name: "Pages & nested blocks → Markdown",
    official: "supported",
    internal: "supported",
    plannedIn: "M2",
    extracted: true,
    implemented: true,
  },
  {
    id: "databases",
    name: "Databases (schema + rows) → CSV/JSON",
    official: "supported",
    officialNote: "rows via query, all properties",
    internal: "supported",
    plannedIn: "M2",
    extracted: true,
    implemented: true,
  },
  {
    id: "relations",
    name: "Relations between databases",
    official: "supported",
    officialNote: "preserved as IDs + resolved map",
    internal: "supported",
    plannedIn: "M2",
    extracted: true,
    implemented: true,
  },
  {
    id: "files",
    name: "Files / images / attachments",
    official: "supported",
    officialNote: "re-hosted copies fetched during sync",
    internal: "supported",
    plannedIn: "M2",
    extracted: true,
    implemented: true,
  },
  {
    id: "comments",
    name: "Comments",
    official: "supported",
    officialNote: "page-level",
    internal: "supported",
    internalNote: "including resolved",
    plannedIn: "M2",
    extracted: false,
    implemented: false,
  },
  {
    id: "views",
    name: "Database views (table / board / calendar / timeline / gallery / …)",
    official: "supported",
    officialNote: "definitions as JSON via the Views API, API version >= 2025-09-03",
    internal: "supported",
    plannedIn: "M2",
    extracted: true,
    // Views are extracted as JSON but rendered as stubs (layout info not reproducible in MD/CSV).
    implemented: false,
  },
  {
    id: "permissions",
    name: "Page-level granular permissions matrix",
    official: "unsupported",
    officialNote: "not exposed",
    internal: "partial",
    plannedIn: null,
    extracted: false,
    implemented: false,
  },
  {
    id: "automations",
    name: "Automations / rules & button configs",
    official: "unsupported",
    internal: "partial",
    plannedIn: null,
    extracted: false,
    implemented: false,
  },
  {
    id: "trash",
    name: "Trash recovery",
    official: "unsupported",
    officialNote: "use rolling Git history instead",
    internal: "unsupported",
    plannedIn: null,
    extracted: false,
    implemented: false,
  },
];

const SYMBOL: Record<Status, string> = {
  supported: "✅",
  partial: "◐ partial",
  unsupported: "❌",
};

function cell(status: Status, note?: string): string {
  const base = SYMBOL[status];
  if (!note) return base;
  // Bold the reason for hard limits so nobody skims past it.
  return status === "unsupported" ? `${base} **${note}**` : `${base} (${note})`;
}

function implementation(c: Capability): string {
  if (c.implemented) return "✅ implemented";
  if (c.official === "unsupported") return "— (cannot be exported; stubbed)";
  if (c.extracted)
    return `🧪 extracted (experimental \`extract\`); export planned (${c.plannedIn ?? "later"})`;
  return c.plannedIn ? `🚧 planned (${c.plannedIn})` : "🚧 planned";
}

export function renderCapabilitiesMarkdown(
  capabilities: readonly Capability[] = CAPABILITIES,
): string {
  const rows = capabilities.map(
    (c) =>
      `| ${c.name} | ${cell(c.official, c.officialNote)} | ${cell(c.internal, c.internalNote)} | ${implementation(c)} |`,
  );

  return [
    "<!-- GENERATED FILE — do not edit by hand. Run `npm run capabilities`. -->",
    "# Capabilities (honesty matrix)",
    "",
    "What Notion lets us export, and what `vaultweave` actually exports today.",
    "This file is generated from `src/core/capabilities.ts`; CI fails on drift.",
    "",
    "| Capability | Official API | Internal API (opt-in) | Tool status |",
    "|---|---|---|---|",
    ...rows,
    "",
    "**Rule:** anything marked ❌ is rendered as a visible stub in the output, e.g.",
    '`<!-- NOT BACKED UP: automation "Weekly digest" -->`, so silence is never mistaken for success.',
    "",
  ].join("\n");
}

/** Visible placeholder written into output for content the API cannot export. */
export function renderStub(kind: string, name: string, detail?: string): string {
  const safe = (s: string) => s.replaceAll("--", "\u2013").replaceAll('"', "'");
  const suffix = detail ? ` (${safe(detail)})` : "";
  return `<!-- NOT BACKED UP: ${safe(kind)} "${safe(name)}"${suffix} -->`;
}
