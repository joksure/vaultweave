## What & why

<!-- One or two sentences. Link the issue: Fixes #123 -->

## Checklist

- [ ] PR title follows Conventional Commits (`feat:`, `fix:`, `docs:` …)
- [ ] `npm run lint && npm run typecheck && npm test && npm run build` pass locally
- [ ] Extraction/rendering change → golden fixture added or updated (scrubbed of tokens and personal data)
- [ ] Export behaviour changed → `src/core/capabilities.ts` updated and `npm run capabilities` re-run
- [ ] No secrets, real tokens or workspace content committed
