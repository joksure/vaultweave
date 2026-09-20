<!-- GENERATED FILE — do not edit by hand. Run `npm run capabilities`. -->
# Capabilities (honesty matrix)

What Notion lets us export, and what `sheaf` actually exports today.
This file is generated from `src/core/capabilities.ts`; CI fails on drift.

| Capability | Official API | Internal API (opt-in) | Tool status |
|---|---|---|---|
| Pages & nested blocks → Markdown | ✅ | ✅ | ✅ implemented |
| Databases (schema + rows) → CSV/JSON | ✅ (rows via query, all properties) | ✅ | ✅ implemented |
| Relations between databases | ✅ (preserved as IDs + resolved map) | ✅ | ✅ implemented |
| Files / images / attachments | ✅ (re-hosted copies fetched during sync) | ✅ | ✅ implemented |
| Comments | ✅ (page-level) | ✅ (including resolved) | 🚧 planned (M2) |
| Database views (table / board / calendar / timeline / gallery / …) | ✅ (definitions as JSON via the Views API, API version >= 2025-09-03) | ✅ | 🧪 extracted (experimental `extract`); export planned (M2) |
| Page-level granular permissions matrix | ❌ **not exposed** | ◐ partial | — (cannot be exported; stubbed) |
| Automations / rules & button configs | ❌ | ◐ partial | — (cannot be exported; stubbed) |
| Trash recovery | ❌ **use rolling Git history instead** | ❌ | — (cannot be exported; stubbed) |

**Rule:** anything marked ❌ is rendered as a visible stub in the output, e.g.
`<!-- NOT BACKED UP: automation "Weekly digest" -->`, so silence is never mistaken for success.
