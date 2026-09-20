import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { computeBackoffMs } from "../ratelimit.js";
import { stripQuery } from "./json.js";

export interface AssetRef {
  /** Path relative to the output directory, always with forward slashes. */
  path: string;
  sha256: string;
  bytes: number;
  /** Original file name as shown in Notion (decoded, unsanitised — display only). */
  name: string;
  mime: string | null;
}

export class AssetError extends Error {
  override name = "AssetError";
  constructor(
    message: string,
    readonly url: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
  /** Seconds from a Retry-After header, when the server sent one. */
  retryAfter?: number;
}

export interface DownloadRequest {
  /** Signed, short-lived Notion file URL. */
  url: string;
  /** Preferred display name (falls back to the URL's last path segment). */
  name?: string;
  /** Returns a fresh signed URL for the same file; called when the current one is rejected. */
  refreshUrl?: () => Promise<string>;
}

export interface AssetDownloaderOptions {
  /** Absolute directory that receives the files (created on demand). */
  dir: string;
  /** Prefix used in the returned `path` (default "assets"). */
  publicPrefix?: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  /** Per-attempt cap for the whole transfer. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AssetStats {
  downloaded: number;
  bytes: number;
  resumed: number;
  urlRefreshes: number;
  retries: number;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Turns an arbitrary (possibly hostile) file name into a safe single path segment. */
export function sanitizeFileName(raw: string): string {
  let name = raw.normalize("NFC");
  // Only the last path segment matters; separators of either flavour are dropped.
  name = name.split(/[\\/]/).pop() ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control chars
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_");
  name = name
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .trim();
  if (name === "" || WINDOWS_RESERVED.test(name)) name = `file${name ? `-${name}` : ""}`;
  if (name.length > 100) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
    name = name.slice(0, 100 - ext.length) + ext;
  }
  return name;
}

function nameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last);
  } catch {
    return "";
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function retryAfterSeconds(res: Response): number | undefined {
  const v = res.headers.get("retry-after");
  return v && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : undefined;
}

/**
 * Downloads Notion-hosted files into a content-addressed store:
 *   assets/<first-16-of-sha256>-<sanitised-name>
 * The path depends only on (content, name), never on timing, so output is deterministic.
 * The same content under the same name is stored once; the same bytes under *different* names
 * stay separate files that share a `sha256` (Git stores identical blobs once anyway, and the
 * renderer can collapse them). Interrupted transfers resume with HTTP Range
 * (partial files survive between runs), and an expired signed URL is transparently
 * replaced through `refreshUrl`.
 */
export class AssetDownloader {
  readonly stats: AssetStats = { downloaded: 0, bytes: 0, resumed: 0, urlRefreshes: 0, retries: 0 };
  private readonly dir: string;
  private readonly prefix: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inflight = new Map<string, Promise<AssetRef>>();
  /** Finalising is serialised so 'already stored?' checks and counters never race. */
  private finalizing: Promise<unknown> = Promise.resolve();

  constructor(opts: AssetDownloaderOptions) {
    this.dir = opts.dir;
    this.prefix = opts.publicPrefix ?? "assets";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Concurrent requests for the same file (same URL minus signature) share one transfer. */
  download(req: DownloadRequest): Promise<AssetRef> {
    const key = stripQuery(req.url);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.doDownload(req, key);
    this.inflight.set(key, p);
    // Failures must not be cached: a later attempt (fresh URL) should be allowed to retry.
    p.catch(() => this.inflight.delete(key));
    return p;
  }

  private async doDownload(req: DownloadRequest, key: string): Promise<AssetRef> {
    const partialDir = join(this.dir, ".partial");
    await mkdir(partialDir, { recursive: true });
    const partial = join(partialDir, createHash("sha256").update(key).digest("hex").slice(0, 32));

    let url = req.url;
    let refreshes = 0;
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        const mime = await this.transfer(url, partial);
        const displayName = req.name ?? nameFromUrl(key);
        const run = this.finalizing.then(() => this.finalize(partial, displayName, mime));
        this.finalizing = run.catch(() => undefined);
        return await run;
      } catch (err) {
        lastError = err;
        if (err instanceof AssetError && err.permanent) {
          if (err.message.startsWith("HTTP 403") || err.message.startsWith("HTTP 401")) {
            if (req.refreshUrl && refreshes < 2) {
              refreshes++;
              this.stats.urlRefreshes++;
              url = await req.refreshUrl();
              continue; // immediate retry with the fresh URL, no delay
            }
          }
          throw err;
        }
        this.stats.retries++;
        const wait =
          err instanceof AssetError && err.retryAfter !== undefined ? err.retryAfter : undefined;
        await this.sleep(computeBackoffMs(attempt, wait, { baseMs: 300, maxMs: 15_000 }));
      }
    }
    throw new AssetError(
      `Download failed after ${this.maxAttempts} attempts: ${(lastError as Error)?.message ?? lastError}`,
      key,
      false,
    );
  }

  /** One HTTP attempt; appends to `partial`. Returns the content type. */
  private async transfer(url: string, partial: string): Promise<string | null> {
    let offset = await sizeOf(partial);
    const headers: Record<string, string> = offset > 0 ? { Range: `bytes=${offset}-` } : {};
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new AssetError(`Network error: ${(err as Error).message}`, stripQuery(url), false);
    }

    const permanent = (msg: string) => new AssetError(msg, stripQuery(url), true);
    if (res.status === 401 || res.status === 403)
      throw permanent(`HTTP ${res.status} (URL rejected or expired)`);
    if (res.status === 404 || res.status === 410)
      throw permanent(`HTTP ${res.status} (file no longer exists)`);
    if (res.status === 416) {
      // Our partial file is unusable (or already complete but unverified): start over.
      await rm(partial, { force: true });
      throw new AssetError("HTTP 416 (restarting from scratch)", stripQuery(url), false);
    }
    if (res.status === 429 || res.status >= 500) {
      const e = new AssetError(`HTTP ${res.status}`, stripQuery(url), false);
      e.retryAfter = retryAfterSeconds(res);
      throw e;
    }
    if (res.status !== 200 && res.status !== 206) throw permanent(`HTTP ${res.status}`);
    if (!res.body) throw new AssetError("Empty response body", stripQuery(url), false);

    let flags: "w" | "a" = "w";
    if (res.status === 206) {
      const m = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(res.headers.get("content-range") ?? "");
      if (m && Number(m[1]) === offset) {
        flags = "a";
        this.stats.resumed++;
      } else {
        // Server answered a different range than we asked for: don't risk a corrupt splice.
        await rm(partial, { force: true });
        throw new AssetError("Unexpected Content-Range (restarting)", stripQuery(url), false);
      }
    } else {
      offset = 0; // 200: server ignored Range, whole file follows
    }

    try {
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(partial, { flags }));
    } catch (err) {
      // Keep whatever arrived; the next attempt resumes from there.
      throw new AssetError(
        `Transfer interrupted: ${(err as Error).message}`,
        stripQuery(url),
        false,
      );
    }

    const expectedTotal = this.expectedTotal(res, offset);
    const actual = await sizeOf(partial);
    if (expectedTotal !== undefined && actual !== expectedTotal) {
      if (actual > expectedTotal) await rm(partial, { force: true });
      throw new AssetError(
        `Size mismatch: got ${actual} of ${expectedTotal} bytes`,
        stripQuery(url),
        false,
      );
    }
    return res.headers.get("content-type")?.split(";")[0]?.trim() || null;
  }

  private expectedTotal(res: Response, offset: number): number | undefined {
    if (res.status === 206) {
      const m = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
      return m ? Number(m[1]) : undefined;
    }
    const len = res.headers.get("content-length");
    return len && /^\d+$/.test(len) ? Number(len) + offset : undefined;
  }

  private async finalize(
    partial: string,
    displayName: string,
    mime: string | null,
  ): Promise<AssetRef> {
    const sha256 = await sha256File(partial);
    const bytes = await sizeOf(partial);
    const safe = sanitizeFileName(displayName);
    const fileName = `${sha256.slice(0, 16)}-${safe}`;
    const finalPath = join(this.dir, fileName);
    if (await sizeOf(finalPath)) {
      await rm(partial, { force: true }); // identical content already stored
    } else {
      await rename(partial, finalPath);
      this.stats.downloaded++;
      this.stats.bytes += bytes;
    }
    return {
      path: posix.join(this.prefix, fileName),
      sha256,
      bytes,
      name: displayName || safe,
      mime,
    };
  }
}
