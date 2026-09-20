import type { NotifierContext } from "./types.js";

export class NotifyError extends Error {
  override name = "NotifyError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_MS = 30_000;

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/**
 * POSTs JSON with a timeout and bounded retries (network error, timeout, 429, 5xx).
 * 4xx other than 429 is a permanent failure (bad/revoked URL) and is not retried.
 * Error messages never contain the URL: webhook URLs are secrets.
 */
export async function postJson(
  url: string,
  body: unknown,
  ctx: NotifierContext = {},
  headers: Record<string, string> = {},
): Promise<void> {
  const doFetch = ctx.fetch ?? fetch;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = ctx.retries ?? DEFAULT_RETRIES;
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload = JSON.stringify(body);

  let lastError = "unknown error";
  for (let attempt = 0; attempt <= retries; attempt++) {
    let waitMs = BASE_BACKOFF_MS * 2 ** attempt;
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "sheaf", ...headers },
        body: payload,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) throw new NotifyError(lastError, res.status);
      waitMs = retryAfterMs(res) ?? waitMs;
    } catch (err) {
      if (err instanceof NotifyError) throw err;
      const e = err as Error & { name?: string };
      lastError =
        e.name === "TimeoutError" || e.name === "AbortError"
          ? `timed out after ${timeoutMs} ms`
          : `network error (${e.cause instanceof Error ? e.cause.message : e.message})`;
    }
    if (attempt < retries) await sleep(waitMs);
  }
  throw new NotifyError(`${lastError} after ${retries + 1} attempts`);
}
