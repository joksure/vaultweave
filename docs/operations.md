# Operating sheaf unattended

## Exit codes

| Code | Meaning |
|---|---|
| 0 | The run finished and nothing failed. |
| 1 | The run failed or is incomplete (see `.sheaf-run-report.json`), or the configuration is invalid. |
| 2 | The command exists but is not implemented yet (`backup`, `verify`). |
| 3 | Skipped: another sheaf run holds the lock for this output directory. Nothing was changed. |

`sheaf sync --json` prints the run report on stdout. The same report is written atomically to
`<out>/.sheaf-run-report.json` and stored in the state DB. `schemaVersion` is `1`.

## `sheaf watch`

```bash
sheaf watch --interval 6h --out ./backup --git --notify slack:https://hooks.slack.com/services/...
```

- Runs immediately, then waits `--interval` **after each run finishes**, so runs never overlap. Minimum 1 minute.
- After a failed run it retries sooner: 5 m, 10 m, 20 m… never longer than the interval. A skipped run (lock busy)
  is retried within a minute.
- A run that throws unexpectedly counts as a failure; the daemon keeps going.
- **SIGINT/SIGTERM:** stops scheduling and lets the current run finish. A second signal exits immediately (code
  130). An interrupted run is safe: the cursor only advances after a successful run and files are written
  atomically. A run cannot be aborted mid-flight, so under systemd give it a generous `TimeoutStopSec`.
- No `--notify` and no `notify.on_error` → a warning at start-up: failures would only be visible in the log.

### systemd

```ini
[Unit]
Description=sheaf Notion backup
After=network-online.target

[Service]
EnvironmentFile=/etc/sheaf.env               # contains SHEAF_TOKEN=…; chmod 0600, owned by the service user
ExecStart=/usr/bin/npx --yes sheaf watch --interval 6h --out /var/backups/notion --git --quiet
Restart=on-failure
RestartSec=30
TimeoutStopSec=30min

[Install]
WantedBy=multi-user.target
```

`Restart=on-failure` restarts after a crash; the lock left behind is reclaimed automatically.

## Alerts

Targets: `webhook:<url>`, `slack:<url>`, `discord:<url>` — via `--notify` (repeatable) or `notify:` in the config
(`on_error`, `on_success`; a single target or a list). `--notify` overrides `notify.on_error`.

| When | Sent to |
|---|---|
| Failure #1, 2, 4, 8, 16… in a row | `on_error` |
| First success after failures | `on_error` (one "recovered" notice) |
| Every success | `on_success` (default: silent) |

A dead alert channel never changes the backup outcome or exit code; the run prints
`⚠ … notification to slack:host was NOT delivered: <reason>` on stderr. The streak comes from the state DB, so if
that is lost (a CI runner without cache) every failure alerts.

### Generic webhook payload

```json
{
  "event": "sheaf.sync.failed",          // or sheaf.sync.succeeded / sheaf.sync.recovered
  "ok": false,
  "title": "sheaf backup FAILED (2 in a row)",
  "summary": "Aborted: …",
  "details": ["host: backup-box", "started: …"],
  "host": "backup-box",
  "failureStreak": 2,
  "report": { "schemaVersion": 1, "startedAt": "…", "durationMs": 1234, "ok": false,
              "counts": { "pagesLive": 0, "apiRequests": 1 }, "aborted": "…",
              "errorCount": 0, "errors": [{ "code": "…", "id": "…", "message": "…" }] }
}
```

Header `x-sheaf-event: sync.failed`. Delivery: 10 s timeout, up to 3 retries on network errors/429/5xx
(honouring `Retry-After`), no retry on other 4xx, redirects refused.

### SMTP email

SMTP is available as an optional notifier. Configure it through `notify.on_error` (or `--notify`):

```yaml
notify:
  on_error: smtp:smtp://backup-user:password@mail.example.com:587/sheaf@example.com/ops@example.com
```

Use `smtps://` or port `465` for implicit TLS. `smtp://` on port `587` uses STARTTLS through nodemailer.
Credentials and the complete SMTP URL are scrubbed from errors. The message contains only run metadata,
counts, error codes, and hostname; page content is never included. `nodemailer` is loaded only when an SMTP
notification is sent. If it is not installed, install the optional dependency with `npm install nodemailer`.
For safer configuration, use environment expansion:

```yaml
notify:
  on_error: smtp:${SHEAF_SMTP_URL}
```

The same failure policy applies: alerts are sent on failure 1, 2, 4, 8, … and once when the backup recovers.


```ts
import { registerNotifier } from "sheaf";
registerNotifier("pager", (arg) => ({
  kind: "pager", label: "pager:prod", secrets: [arg],
  send: async (event) => { /* event.kind, event.report … */ },
}));
```

Custom kinds are available through the library API (`createNotifier`, `runOperatedSync`). The `sheaf` binary
cannot load plugins yet, so `--notify pager:…` on the command line only works for the three built-in kinds.

## `sheaf doctor`

```bash
sheaf doctor --out ./backup --git            # cheap checks
sheaf doctor --out ./backup --git --deep     # + workspace coverage and asset scan
sheaf doctor --json                          # attach to bug reports
```

| Check | Fails when |
|---|---|
| `token` / `auth` / `reachable` | no token · rejected · the integration sees 0 pages |
| `scope` | reading a page's blocks is refused → the integration lacks **Read content** |
| `last_run` | the last run failed, or the last success is older than 2.5× `interval` (48 h default) |
| `git` (with `--git`) | `git` is not installed. Missing identity is only a warning: sheaf commits as `sheaf` |
| `assets` | downloads stuck > 24 h; with `--deep`, Markdown references an asset that is not on disk |
| `coverage` (`--deep`) | ≥ 50 % of backed-up pages are no longer reachable (likely lost access). Fewer only warns |

`doctor` never creates files: it opens the state DB read-only. `--deep` walks the workspace through search
(capped at 5000 results) and scans up to 50 000 Markdown files.

## Locking

`<out>/.sheaf.lock` is created atomically and its mtime is refreshed every 30 s. A lock is reclaimed when its
holder is a dead process on this host, or when nothing refreshed it for 5 minutes (containers change PID and
hostname on restart, so the lease is what makes recovery reliable there). Do not put the output directory on a
filesystem shared by several machines unless clocks are in sync.

## GitHub Actions

Use [`templates/github-workflow.yml`](../templates/github-workflow.yml). The repository is checked out into
`./backup` (the git repo sheaf commits to), the state DB travels through the cache — saved even when the sync
fails — and the backup commit is pushed even after a partial failure. **Keep the repository private.**
