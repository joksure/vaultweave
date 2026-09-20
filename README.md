<div align="center">

# sheaf

**Your Notion, out of Notion.**

Open-source CLI that turns your Notion workspace into portable, versioned,
human-readable files — Markdown, CSV, JSON, and your attachments — with
incremental sync straight into a Git repository.

[![CI](https://img.shields.io/github/actions/workflow/status/YOU/sheaf/ci.yml?branch=main)](https://github.com/YOU/sheaf/actions)
[![npm](https://img.shields.io/npm/v/sheaf)](https://www.npmjs.com/package/sheaf)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![status](https://img.shields.io/badge/status-pre--1.0-orange)]()

</div>

---

> **⚠️ Status: early development (M4 — operations layer).**
> Working today: `sync` (Markdown / CSV / JSON output, hash-based change detection, Git history,
> deletion tombstones), `watch` (daemon), failure alerts (webhook / Slack / Discord), `doctor`,
> `capabilities`, and the experimental `extract` command. See [docs/operations.md](./docs/operations.md).
>
> **Known gaps, stated plainly:**
> - `backup` and `verify` are not implemented (exit code 2).
> - Every sync still re-reads the whole workspace from Notion; only *writing* is incremental. A run costs
>   the same number of API requests as a full one.
> - `ignore:` and `redact:` are accepted in the config but **not applied yet** — do not rely on them to
>   keep data out of your backup.
> - Not yet published to npm or Homebrew.
>
> The live status of every capability is tracked in [CAPABILITIES.md](./CAPABILITIES.md).

---

## Why this exists

Notion is where your team thinks. But getting your data *out* — reliably,
automatically, in a format that survives anything — is harder than it should be:

- **No scheduled backups.** Notion's own docs answer "Is there a way to schedule
  automatic backups?" with *"Not at the moment."*
- **Manual export only.** The export link arrives by email, **expires after 7
  days**, can take up to 30 hours to generate, and large workspaces sometimes
  fail entirely.
- **Retention is plan-gated.** Trash lives 7 days (Free) / 30 (Plus) / 90
  (Business). After that, deletion is unrecoverable — not by you, not by
  Notion support, not by any tool.
- **Existing OSS backup tools** scrape a browser cookie (`token_v2`) that
  expires, breaks, and is unsupported.

`sheaf` gives you a backup that is **rolling, automated, honest about
what it can capture, and stored in formats that will outlive any single app.**
If Notion disappeared tomorrow, your `main` branch would still open in any
text editor — and be directly readable by AI coding agents.

## Quickstart

```bash
export SHEAF_TOKEN=secret_...            # prefer the env var over --token

# one-shot sync into a folder
npx sheaf sync --out ./my-notion

# …and commit every run to a git repo inside that folder
npx sheaf sync --out ./my-notion --git

# daemon: sync every 6 hours, alert Slack when a run fails
npx sheaf watch --interval 6h --out ./my-notion --git \
  --notify slack:https://hooks.slack.com/services/...
```

Or run it fully managed in GitHub Actions — see
[`templates/github-workflow.yml`](./templates/github-workflow.yml) for a
scheduled daily backup (secrets: `SHEAF_TOKEN`, optional `SHEAF_ALERT`).

## Running unattended

A backup nobody notices failing is worse than no backup. `sheaf` is built so failure is loud:

- **Exit codes:** `0` ok · `1` failed or incomplete · `3` skipped because another run holds the lock.
- **Alerts:** `--notify` (repeatable) or `notify.on_error` in the config. Targets: `webhook:<url>` (JSON),
  `slack:<url>`, `discord:<url>`. Alerts fire on the 1st consecutive failure, then the 2nd, 4th, 8th…, and
  one *recovered* notice follows the next success. Alert text contains counts and error codes — never page
  content — and webhook URLs and tokens are scrubbed from every message and log line.
- **`watch`:** never overlaps runs, retries early after a failure (5m, 10m, 20m… up to the interval), and stops
  gracefully on SIGINT/SIGTERM.
- **`doctor`:** flags a stale backup, a failed last run, missing `git`, stuck downloads and — with `--deep` —
  backed-up pages Notion no longer shows to the integration.

Details, payload schema and a systemd unit: [docs/operations.md](./docs/operations.md).

## Targets

`sheaf sync` always writes to the local filesystem (`out:`) and can optionally write to
additional targets. Git is enabled with `git: true` or `--git`. S3-compatible storage is
configured with the AWS credential chain (environment, shared AWS config, or instance role):

```yaml
targets:
  s3:
    bucket: my-notion-backup
    prefix: notion/
    region: ap-southeast-1
    # endpoint: https://...       # R2, MinIO, or another S3-compatible service
    # forcePathStyle: true         # commonly needed by MinIO
```

The equivalent CLI options are `--s3-bucket`, `--s3-prefix`, `--s3-region`,
`--s3-endpoint`, and `--s3-force-path-style`. S3 is an optional dependency; installs that
do not use an S3 target do not load the AWS SDK. Each object is compared by content hash,
then uploaded through a temporary key and copied to its final key. Files are handled
independently, so one upload error is reported without stopping the other files.

## What gets backed up

| Content | Output | Status |
|---|---|---|
| Pages & nested blocks | `path/to/page.md` + YAML frontmatter | 🚧 planned |
| Databases (schema + rows) | `db.csv` + `db.json` (relations preserved) | 🚧 planned |
| Images / files / attachments | `assets/` (re-hosted copies) | 🚧 planned |
| Comments | `page.comments.md` | 🚧 planned |
| Database views (table/board/calendar/…) | view definitions as JSON (`db.views.json`) | 🚧 planned |
| Automations, button configs | stub comment in output | ⚠️ API limit |

We never claim "full backup". The complete, machine-checked matrix lives in
[CAPABILITIES.md](./CAPABILITIES.md), and anything not exported is marked
**explicitly** in your output — silence is never mistaken for success.

## Features

- **Incremental** — content-hash diffing means re-runs cost almost no API calls.
- **Rate-limit safe** — token-bucket pacing under Notion's 3 req/s average.
- **Point-in-time history** — every sync is a Git commit; roll back to any day.
- **Zero silent failures** — structured run reports; failures alert your
  webhook/Slack/Discord *before* the process exits non-zero.
- **Honest** — unsupported content is labelled, not dropped quietly.
- **Agent-friendly output** — clean Markdown, no internal Notion noise; point
  Claude Code or Cursor at your backup repo and ask questions about your own notes.
- **CI-native** — first-class GitHub Actions template; headless by design.

## How it works

```
Notion API ──▶ Extractor ──▶ Normalizer (IR) ──▶ Renderers (md/csv/json)
                                              │
                              SQLite state (cursors · hashes · relations)
                                              │
                                     Sync targets: fs · git · cloud
                                              │
                                   Run report ──▶ Notifier ──▶ you
```

`sheaf sync` is resumable, idempotent, and safe to run from cron,
a daemon, or CI.

## Configuration

Minimal `.sheaf.yaml`:

```yaml
token: ${SHEAF_TOKEN}        # env expansion supported
out: ./sheaf-backup
git: true                     # auto-commit per run
interval: 6h                  # used by `sheaf watch` (minimum 1m)
notify:
  on_error: slack:${SLACK_WEBHOOK}      # one target, or a list of targets
  on_success: silent
# `ignore:` and `redact:` are supported by sync configuration.
```

Run `npx sheaf doctor` to check the token (reachability and content access), the freshness of your last
backup, git readiness and stuck downloads; add `--deep` to also detect backed-up pages that are no longer
reachable.

## Security

- Token comes from env/secret stores only — **never** written into the synced repo.
- Output redaction is available through `redact:` patterns in configuration.
- An internal-API fast path exists for power users, but requires an explicit
  risk acknowledgement; the official-API path is the default and fully supported.
- See [docs/security.md](./docs/security.md).

## Install

```bash
npm i -g sheaf        # or: bun add -g sheaf
brew install YOU/tap/sheaf   # macOS
```

Standalone binaries (Linux/macOS/Windows) are attached to every
[release](https://github.com/YOU/sheaf/releases).

## Roadmap

- [x] Scaffolding, CI, CLI skeleton, `doctor`, config, rate limiter (M0)
- [x] Official-API extractor: block trees, databases, views, files, pacing and retry (M1) — experimental `extract`
- [x] Markdown/CSV/JSON renderers and filesystem target (M2)
- [x] State DB, hash-based change detection, Git history, tombstones, incremental extraction (M3)
- [x] Watch mode, notifiers, lock, run reports, extended `doctor`, Actions template (M4)
- [x] S3/S3-compatible cloud target (AWS credential chain, optional dependency)
- [ ] GCS / Google Drive cloud targets (plugin packages)
- [ ] Read-only local MCP server over your synced repo
- [ ] Team dashboard (sync health across workspaces)

## Development

```bash
nvm use            # Node 22+ (see .nvmrc)
npm ci
npm run lint       # biome (warnings are errors)
npm run typecheck
npm test           # vitest, fully offline
npm run build
npm run capabilities:check   # CAPABILITIES.md must match src/core/capabilities.ts
```

The full design lives in [docs/architecture.md](./docs/architecture.md).

## Contributing

Contributions welcome — especially new renderers, notifier plugins, and
recorded API fixtures for golden tests. Please run `npm test` and include a
golden fixture for any extraction change. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Disclaimer

Not affiliated with, endorsed by, or sponsored by Notion Labs, Inc. "Notion" is
a trademark of Notion Labs, Inc. This tool uses the official Notion API.

## License

MIT — see [LICENSE](./LICENSE).
