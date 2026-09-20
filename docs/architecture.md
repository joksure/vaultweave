# sheaf — Technical Blueprint
> v0.1 · Target: global OSS release · Status: design

## 1. Positioning

**One-line:** `Your Notion, out of Notion.` — An open-source CLI + library that
turns a Notion workspace into portable, versioned, human-readable files
(Markdown + assets + database CSV/JSON), with incremental sync to Git.

**Problem it solves (validated):**
- Notion has **no scheduled automatic backups** (confirmed in official docs).
- Export is manual-only, link expires in 7 days, can take up to 30 hours, and
  large workspaces fail (official FAQ acknowledges the error).
- Retention is plan-gated: trash 7/30/90 days (Free/Plus/Business); permanent
  deletion is unrecoverable by anyone, including Notion support.
- Existing OSS backup tools rely on a stolen `token_v2` browser cookie —
  brittle, expires, unsupported.

**Non-goals:** We never promise "full backup". We publish an exact honesty
matrix (§7) of what the API can and cannot export. Trust > feature claims.

---

## 2. Design Principles

| # | Principle | Consequence in code |
|---|-----------|---------------------|
| P1 | Honest about API limits | `CAPABILITIES.md` is generated from the same enum the engine uses; nothing claimed that isn't exported |
| P2 | Rolling point-in-time history | Git is the default history store; every sync is a commit |
| P3 | Universal output format | Markdown + frontmatter YAML; databases → `*.csv` + `*.json` with relation IDs preserved |
| P4 | No silent failures | Every run emits a structured report; failure → notifier fires before exit code non-zero |
| P5 | No cookie-hacking baseline | Official API path is the default; internal-API module is opt-in, clearly risk-labelled |
| P6 | Agent-friendly output | Clean Markdown without Notion internal noise — readable by Claude Code / Cursor directly off the repo |

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        CLI (sheaf)                 │
│  backup │ sync │ watch │ verify │ doctor │ capabilities      │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────┐   ┌───────────────────────────┐
│        Core Engine          │   │      State Store          │
│  ┌───────────────────────┐  │   │  SQLite (local):          │
│  │ 1. Extractor          │  │   │  - last_sync cursors      │
│  │    official API (def.)│  │   │  - content hashes         │
│  │    internal API (opt) │  │   │  - relation map           │
│  ├───────────────────────┤  │   │  - run reports            │
│  │ 2. Normalizer         │  │   └───────────────────────────┘
│  │    BlockTree → IR     │  │
│  │    (AST + frontmatter)│  │   ┌───────────────────────────┐
│  ├───────────────────────┤  │   │      Notifier             │
│  │ 3. Renderer           │  │   │  webhook / Slack /        │
│  │    md │ csv │ json    │  │   │  Discord / email (SMTP)   │
│  └───────────────────────┘  │   └───────────────────────────┘
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐   ┌───────────────────────────┐
│      Sync Targets           │   │   Scheduler Modes         │
│  filesystem (default)       │   │  one-shot (CLI)           │
│  git auto-commit            │   │  watch (daemon, --interval)│
│  S3 / R2 / GCS (optional)   │   │  GitHub Actions (cron)    │
│  Google Drive (optional)    │   │                           │
└─────────────────────────────┘   └───────────────────────────┘
```

### Data flow (incremental sync)
1. Load state DB → diff workspace since `last_sync` (search endpoint with
   `last_edited_time` filter).
2. Queue affected page/database IDs into a token-bucket rate limiter
   (Notion API: avg 3 req/s → conservative 2.5 req/s + jitter).
3. Fetch block trees recursively; download file assets (S3 URLs, signed —
   must fetch during sync; they expire).
4. Normalize to IR → render → write to target → update state DB → commit.
5. Emit JSON run report; on any error: notify + exit code.

---

## 4. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript (strict)** | First-class official SDK (`@notionhq/client`); `notion-to-md` ecosystem to reuse/block-tree knowledge; future MCP server (roadmap) is natural |
| Runtime / packaging | **Bun** | Single-binary builds (`bun build --compile`) for end users without Node; npm publish for library consumers |
| CLI framework | **Commander + @inquirer/prompts** | Mature, tiny, great DX for `doctor` interactive setup |
| State store | **SQLite (bun:sqlite)** | Zero-config, transactional, survives cron; state file lives next to output repo |
| Rendering | Custom MD renderer on shared IR | `notion-to-md` as reference but we own the IR (CSV/JSON need it) |
| Git sync | **isomorphic-git** or shell `git` | Prefer shelling out to real git (users' credentials, GPG signing, hooks) |
| Config | YAML (`.sheaf.yaml`) + env vars | `SHEAF_TOKEN`, `NOTION_SYNC_INTERVAL`, etc. |
| CI | GitHub Actions (matrix: mac/linux/win) | Releases via release-please; binaries attached per release |
| Tests | Vitest + MSW (API mock) + golden-file snapshot tests | Golden files = rendered MD committed in repo; regression-proof |
| Notifier | Pluggable: webhook / Slack / Discord / SMTP | P4 principle — pluggable so OSS users extend |

**Deliberately not chosen:**
- Python — fine, but splits you from the Notion JS SDK ecosystem and the MCP roadmap.
- Pure Go — great binaries, but you'd re-implement block-tree→Markdown nuances already solved in TS.

---

## 5. Repository Structure

```
sheaf/
├── README.md
├── CAPABILITIES.md              # generated honesty matrix (P1)
├── LICENSE                      # MIT
├── package.json
├── src/
│   ├── cli/                     # commander commands
│   │   ├── backup.ts
│   │   ├── sync.ts
│   │   ├── watch.ts
│   │   ├── verify.ts            # re-parse output, checksum vs source
│   │   ├── doctor.ts            # token scope check, rate-limit probe
│   │   └── capabilities.ts
│   ├── core/
│   │   ├── extractor/
│   │   │   ├── official.ts      # @notionhq/client wrapper
│   │   │   └── internal.ts      # ⚠ opt-in, token_v2, risk-labelled
│   │   ├── normalizer/          # BlockTree → IR
│   │   │   ├── ir.ts            # canonical types
│   │   │   └── relations.ts     # DB ↔ page ID mapping
│   │   ├── renderer/
│   │   │   ├── markdown.ts
│   │   │   ├── csv.ts
│   │   │   └── json.ts
│   │   ├── state/               # SQLite layer
│   │   ├── ratelimit.ts         # token bucket + backoff(429)
│   │   └── pipeline.ts          # orchestrates extract→render→write
│   ├── targets/
│   │   ├── filesystem.ts
│   │   ├── git.ts
│   │   ├── s3.ts                # optional deps, lazy-loaded
│   │   └── notifier/
│   └── config.ts
├── templates/
│   └── github-workflow.yml      # copy-paste scheduled backup Action
├── examples/
│   ├── minimal/
│   └── with-git-sync/
├── tests/
│   ├── fixtures/                # recorded API responses (golden)
│   └── golden/                  # expected .md/.csv outputs
└── docs/
    ├── architecture.md          # (this blueprint, kept in-repo)
    └── security.md              # token handling, CI secrets
```

---

## 6. Security Model

- **Token storage:** env var first (`SHEAF_TOKEN`), OS keyring optional
  (`--save-token`), never written into the output/synced repo.
- **Least privilege:** `doctor` checks the integration's capabilities and
  warns on workspace-level tokens when a narrower scope works.
- **CI mode:** `SHEAF_TOKEN` from GitHub Secrets only; workflow template
  uses `permissions: contents: write` minimally.
- **Output hygiene:** `.gitignore` convention for `state.sqlite`; a
  `--redact` flag strips property values matching user regex (emails, etc.).
- **Internal-API module:** requires explicit `--i-understand-token-v2-risk`;
  prints warning each run; docs state it can break anytime (it has before).

---

## 7. Honesty Matrix (CAPABILITIES.md — generated)

| Capability | Official API | Internal API |
|---|---|---|
| Pages & nested blocks → Markdown | ✅ | ✅ |
| Databases (schema + rows) → CSV/JSON | ✅ (rows via query, all props) | ✅ |
| Relations between DBs | ✅ (preserved as IDs + resolved map) | ✅ |
| Files/images/attachments | ✅ (re-hosted copies fetched during sync) | ✅ |
| Comments | ✅ page-level | ✅ incl. resolved |
| Database views (table/board/calendar/timeline/gallery/…) | ✅ (definitions as JSON via the Views API, API ≥ 2025-09-03) | ✅ |
| Page-level granular permissions matrix | ❌ not exposed | partial |
| Automation/rules & button configs | ❌ | partial |
| Trash recovery | ❌ (use rolling history instead) | ❌ |

Rule: anything ❌ is rendered as a visible stub comment in output
(`<!-- NOT BACKED UP: automation "Weekly digest" -->`) so no one
mistakes silence for success.

---

## 8. Milestones

### M0 — Scaffolding (week 1) · *exit: repo builds, CI green*
- Repo from `bun init --template`, strict TS, release-please, Vitest,
  lint/format (biome), GitHub Actions matrix build.
- CLI skeleton with `doctor` (token check + rate-limit probe).

### M1 — Extraction Core (weeks 2–3) · *exit: golden tests pass*
- Official-API extractor: recursive block tree, pagination, token-bucket
  limiter, 429 backoff, asset downloader with resume.
- Recorded API fixtures (MSW) → golden file tests for 3 fixture workspaces
  (docs-heavy, database-heavy, media-heavy).

### M2 — Renderers + Filesystem Target (weeks 4–5) · *exit: `backup` produces clean output*
- IR → Markdown/frontmatter, DB → CSV + JSON relation map.
- Stubs for non-exportable content per honesty matrix.
- `verify` command: re-parse output, compare checksums vs live workspace.

### M3 — State, Incremental, Git Sync (weeks 6–7) · *exit: 2nd run is near-zero API calls*
- SQLite state: cursors, content hashes, relation map.
- `sync` to git target: auto-commit, conventional-commit messages,
  `--since` incremental, delete handling (tombstones, not silent rm).

### M4 — Operations Layer (week 8) · *exit: unattended run survives failures*
- `watch` daemon mode; GitHub Action template (scheduled backup);
  notifier plugins (webhook/Slack/Discord); run report JSON + exit codes;
  `doctor` extended (token scope, missing pages, stale assets).

### M5 — Global Release Prep (weeks 9–10) · *exit: v1.0.0 tagged*
- Docs site (VitePress): quickstart ×3 personas (personal, team, CI).
- Homebrew tap + scoop + standalone binaries via Bun compile.
- CAPABILITIES.md generation wired into CI (drift check).
- Hacker News / r/Notion launch post (drafted from README problem section).

### Post-v1 (not in scope yet)
- Cloud targets (S3/GCS/Drive) as optional plugin packages.
- Read-only local MCP server over the synced repo (agent story, avoids
  competing head-on with Notion's hosted MCP).
- Multi-workspace monorepo layout.

---


## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Notion API rate limits on large workspaces | Token bucket 2.5 rps + resumable checkpointing in state DB |
| Internal-API module breaks (it has before) | Optional, isolated module; official path is default; e2e test on cron detects breakage early |
| Asset URLs expire mid-sync | Download assets during extraction phase, retry with fresh URL on 403 |
| Trademark/branding friction with Notion | Name/product copy reviewed vs Notion brand guidelines; "not affiliated" disclaimer |
| Maintenance load (support issues) | Issue templates that auto-attach `doctor --json` output; honesty matrix reduces false-bug reports |

---

## Revision note — M1

- **Database views are exportable.** The original matrix listed views as an API limit. Notion now exposes them as
  a first-class resource (`GET /v1/views?database_id=…`, `GET /v1/views/{id}`, API version ≥ 2025-09-03), so the
  extractor exports view definitions as JSON. Only this row was re-verified; the other ❌ rows (permissions,
  automations/buttons) should be re-checked against the current API docs before v1.0.
- **Data sources.** With API 2025-09-03 a database is a container of one or more *data sources*; schema and rows
  live on the data source. The extractor models this explicitly (see [extraction-model.md](./extraction-model.md)).
- **API version is pinned** (`NOTION_API_VERSION` in `src/core/extractor/api.ts`) so a change of the SDK default
  never silently changes what we export.

## Revision note — M4

- **Operations layer** (`src/core/operations.ts`): one run = lock → sync → history/streak → notify. `sync` and each
  `watch` tick share it, so cron and daemon behave identically. The lock is released *before* notifying.
- **Notifiers** are pluggable (`registerNotifier`); built-ins are webhook, Slack, Discord. **SMTP is not built**:
  it needs a new dependency and was deferred (bridge email through a webhook receiver for now).
- **Alert policy:** alert on the 1st, 2nd, 4th, 8th… consecutive failure, plus one "recovered" notice. The streak
  comes from the persisted run history (`run_reports`, capped at 1000 rows), so it works for one-shot cron runs.
- **Pipeline fixes made while doing M4** (all regression-tested):
  - the writer now returns `pagePaths` (page id → file). Before, the pipeline tried to guess the path from the
    id and matched nothing on real data: **no page was ever tracked, so change detection and tombstones never
    ran**. The M3 tests did not notice because they mocked the writer;
  - tombstones are only created after a run that saw the whole workspace (not failed, aborted, or `--root`);
  - the cursor advances only after a successful run; a failed `git commit` fails the run.
- **`doctor` scope check is a probe.** The Notion API does not list an integration's capabilities, so the check
  reads one page's blocks and reports `restricted_resource` as a missing "Read content" capability. The blueprint's
  "warn on workspace-level tokens" is not implementable through the API and is not claimed.

### Known M3 gaps left open

1. **Extraction is not incremental.** `sinceTimestamp` is computed but never reaches the extractor; every run
   crawls the whole workspace. The M3 exit criterion ("2nd run ≈ zero API calls") is not met.
2. **Tombstones overwrite the last content** of a page. If an integration merely *loses access*, the backup of
   that page is replaced (git history keeps it; a plain folder does not). `doctor --deep` warns before it happens.
3. Only workspace pages are tracked — database rows are not, so deleted rows are not tombstoned.
4. A renamed/moved page is written to its new path; the old file is left behind.
5. `ignore:` and `redact:` are parsed but not applied.

