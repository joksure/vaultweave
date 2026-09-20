# Contributing to sheaf

Thanks for helping! This project's core promise is **honesty and reliability**, so a few rules matter more than usual.

## Ground rules

1. **Honesty first (P1).** If you add or change what gets exported, update `src/core/capabilities.ts` and run
   `npm run capabilities`. CI fails if `CAPABILITIES.md` drifts. Never document a capability that isn't implemented.
2. **No silent failures (P4).** Errors must surface — in the run report, the notifier and the exit code.
   Prefer throwing over returning empty results.
3. **Official API by default (P5).** Anything relying on `token_v2` / internal endpoints must stay opt-in and risk-labelled.
4. **Golden fixtures for extraction changes.** Any change to extraction or rendering needs a fixture
   (`tests/fixtures/`, built with the helpers in `tests/support/world.ts`) and the expected output
   (`tests/golden/`). Review a changed golden file by reading it — do not just regenerate it
   (`npx vitest run -u`). **Never put tokens or real workspace content in fixtures.** The built-in fixtures are
   synthetic; contributions of *scrubbed* real-API payloads are very welcome.

## Setup

```bash
git clone https://github.com/YOU/sheaf && cd sheaf
nvm use && npm ci
npm run lint && npm run typecheck && npm test && npm run build
```

Tests run fully offline; never commit a real `SHEAF_TOKEN`.

## Pull requests

- Branch from `main`; keep PRs focused.
- **PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/)** (`feat:`, `fix:`, `docs:`,
  `chore:` …). We squash-merge, and the title becomes the changelog entry via release-please.
- Fill in the PR template; CI (lint, typecheck, tests, build, capabilities drift) must be green on Linux, macOS and Windows.

## Reporting bugs

Use the bug template and attach the output of `npx sheaf doctor --json`.
For security issues **do not open a public issue** — see [SECURITY.md](./SECURITY.md).

## Good first contributions

New renderers, notifier plugins, and recorded API fixtures for golden tests.
