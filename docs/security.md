# Security

## Token handling

- **Source of truth:** the `VAULTWEAVE_TOKEN` environment variable, or your CI secret store. Prefer this over `--token`,
  which can end up in shell history and process listings.
- **Never written to disk** inside the output/synced repository. `vaultweave.db` (+ `-wal`/`-shm`), `.vaultweave.lock` and
  `.vaultweave-run-report.json` are added to the output repo's `.gitignore` on every `--git` sync, including
  repositories that already existed.
- **Optional keyring storage** (`--save-token`) is planned; it will use the OS keychain, not a file.

## Least privilege

The official integration only sees pages explicitly shared with it. Share only what you need to back up.
`vaultweave doctor` reports how many pages are reachable, so an over- or under-shared integration is visible.

## Redaction — NOT IMPLEMENTED YET

The `redact:` config key is parsed but **not applied**: nothing is stripped from the output today. The design
below is what is planned; until it ships, do not rely on it. `redact:` / `--redact` will take regular expressions; matches are stripped **before** anything is
written. In YAML use **single quotes** for patterns, otherwise `\b` is parsed as a backspace character:

```yaml
redact: ['\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b']
```

## Internal API (`token_v2`) — opt-in, not the default

Planned as an isolated module requiring an explicit `--i-understand-token-v2-risk` flag. It relies on an
undocumented browser-session cookie: it can break at any time and may violate Notion's terms for your plan.
The official-API path is the default and the only supported one.

## CI

- Store `VAULTWEAVE_TOKEN` as an encrypted repository secret; never echo it.
- Keep the repository holding your backup **private** — it contains your workspace content.
- The workflow template requests only `contents: write`.

## Notifications

- **What leaves the machine:** run metadata only — counts, error codes, Notion object ids, error text, the
  hostname. Never page titles or page content.
- **Scrubbing:** the Notion token, every configured webhook URL, and anything shaped like a Notion token
  (`secret_…`, `ntn_…`) are replaced by `***` in outgoing messages, error text and logs. Log lines identify a
  channel as `slack:hooks.slack.com` — the host only, because the URL path *is* the credential.
- **Injection:** Slack messages escape `& < >` (so error text cannot trigger `<!channel>`); Discord messages send
  `allowed_mentions: {parse: []}`; long text is truncated.
- **Transport:** redirects are refused, each attempt has a 10 s timeout, and 4xx responses are not retried.
  `http://` targets are accepted (internal receivers) but you should use `https://` for anything that leaves
  your network.
- **Fail-fast:** an unknown or malformed alert target aborts start-up instead of running without alerts.

## Concurrency

Only one sync may write an output directory at a time (`.vaultweave.lock`, a heartbeat lease). A second run exits
with code 3 and does nothing. A crashed run's lock is reclaimed automatically (dead local PID, or no heartbeat
for 5 minutes).

## Reporting issues

See [SECURITY.md](../SECURITY.md).
