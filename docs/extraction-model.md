# Extraction model (M1)

`OfficialExtractor.extract()` returns an `ExtractionResult`; `sheaf extract` writes it to
`<out>/extraction.json` (sorted keys, so Git diffs show only real changes) and downloads files to `<out>/assets/`.

The model is **lossless by design**: it is the Notion API payload plus what the extractor resolved. Deciding what
is noise (user refs, timestamps, …) is the normalizer's job in M2.

| Field | Content |
|---|---|
| `pages` | Pages that are not database rows, sorted by id. Each has `title`, `properties`, and `blocks` (a fully nested tree). |
| `databases` | Each database with its `data_sources` (`properties` = schema, `rows` = pages with their own `blocks`) and `views` (definitions from the Views API). |
| `assets` | Manifest of downloaded files: `path`, `sha256`, `bytes`, `mime`. |
| `warnings` | Incomplete but not failed, e.g. `unsupported_block`, `orphan_page`, `block_cycle`, `rollup_maybe_truncated`. |
| `errors` | Failures. **Any entry means the backup is not complete** (`ok` is false). |
| `aborted` | Set when the run was cut short: bad token, or Notion unreachable (circuit breaker). |
| `stats` | Requests, retries, rate-limited count, counts per object type, asset totals. |

## What the extractor guarantees

- **No signed URLs are ever stored.** A Notion-hosted file `{type:"file", file:{url, expiry_time}}` becomes
  `{type:"file", file:{source, asset}}`: `source` is the URL without its signature, `asset` describes the local copy
  (`null` if the download failed — and then an `asset_download_failed` error exists). External URLs are left as links.
- **Files are downloaded during extraction** (signed URLs expire after about an hour). An expired URL is refreshed
  by re-reading the owning block/page; interrupted transfers resume with HTTP `Range`.
- **Stored file names are safe**: `assets/<first 16 hex of sha256>-<sanitised name>`. The original name is kept
  in `asset.name` for display only. Identical bytes under different names are separate files sharing a `sha256`.
- **Nothing is silently truncated.** Paginated lists that lose their cursor throw; properties Notion cuts at 25
  items (relations, people, title, rich text) are completed through the property-items endpoint.
- **Output is deterministic**: pages/databases sorted by id, rows oldest-first, block order preserved, independent
  of the order Notion returns search results in.
- **Rows can be trusted to be complete or flagged**: a row or page that fails is listed in `errors`, never omitted
  quietly.
- **Requests are paced and retried** (token bucket, `Retry-After`, exponential backoff, circuit breaker).

## Known limits

- Comments are not extracted yet (M2). Linked views of a database that live on *other* pages are not listed.
- Rollups with 25+ items may be truncated by the API; this is reported as `rollup_maybe_truncated`.
- Test fixtures are **synthetic** (modelled on the documented payloads), not recordings of a real workspace.
  Run `sheaf extract` against a real one to validate shapes before relying on M1 output.
