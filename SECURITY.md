# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's private reporting:
**Security → Report a vulnerability** on this repository.

We aim to acknowledge reports within 3 working days and to ship a fix or mitigation for confirmed
issues as quickly as is practical. Please include reproduction steps and the affected version.

## Supported versions

Pre-1.0: only the latest released version receives fixes.

## What is in scope

- Leaking a Notion token into logs, output files, the synced Git repository or CI logs.
- Path traversal / unsafe file writes while re-hosting assets or rendering titles.
- Bypassing `--redact` so sensitive values reach disk.

## Handling your token

See [docs/security.md](./docs/security.md). In short: use `SHEAF_TOKEN` from the environment or your CI
secret store; grant the integration access only to the pages you need; never commit `.env` or `state.sqlite`.
