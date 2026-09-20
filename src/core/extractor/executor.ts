import { type BackoffOptions, computeBackoffMs, TokenBucket } from "../ratelimit.js";

export class CircuitOpenError extends Error {
  override name = "CircuitOpenError";
}

export interface ExecutorStats {
  /** Every HTTP attempt, including retries. */
  requests: number;
  retries: number;
  rateLimited: number;
  /** Requests that still failed after all retries. */
  failures: number;
}

export interface ExecutorOptions {
  limiter?: TokenBucket;
  maxRetries?: number;
  backoff?: BackoffOptions;
  /** Abort the whole run after this many consecutive requests fail even after retries. */
  maxConsecutiveFailures?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_CODES = new Set([
  "rate_limited",
  "internal_server_error",
  "service_unavailable",
  "service_overload",
  "gateway_timeout",
  "notionhq_client_request_timeout",
]);
const RETRYABLE_ERRNO = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

interface Classified {
  retryable: boolean;
  rateLimited: boolean;
  /** True when Notion itself answered (so the service is reachable). */
  serverResponded: boolean;
  retryAfterSeconds?: number;
}

function header(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const rec = headers as Record<string, unknown>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  const v = key ? rec[key] : undefined;
  return typeof v === "string" ? v : undefined;
}

export function classifyError(err: unknown): Classified {
  const e = err as { status?: number; code?: string; headers?: unknown; cause?: { code?: string } };
  const status = typeof e?.status === "number" ? e.status : undefined;
  const rateLimited = e?.code === "rate_limited" || status === 429;
  const retryAfterRaw = header(e?.headers, "retry-after");
  const retryAfterSeconds =
    retryAfterRaw !== undefined && /^\d+(\.\d+)?$/.test(retryAfterRaw.trim())
      ? Number(retryAfterRaw)
      : undefined;

  if (rateLimited) {
    return { retryable: true, rateLimited: true, serverResponded: true, retryAfterSeconds };
  }
  if ((status !== undefined && status >= 500) || (e?.code && RETRYABLE_CODES.has(e.code))) {
    return {
      retryable: true,
      rateLimited: false,
      serverResponded: status !== undefined,
      retryAfterSeconds,
    };
  }
  const errno = e?.cause?.code ?? e?.code;
  if (err instanceof TypeError || (errno && RETRYABLE_ERRNO.has(errno))) {
    return { retryable: true, rateLimited: false, serverResponded: false };
  }
  return { retryable: false, rateLimited: false, serverResponded: status !== undefined };
}

/**
 * Every Notion API call goes through here: paced by the token bucket, retried with
 * backoff on 429/5xx/network errors (honouring Retry-After), counted for the run report,
 * and cut off by a circuit breaker when the service is clearly down.
 */
export class RequestExecutor {
  readonly stats: ExecutorStats = { requests: 0, retries: 0, rateLimited: 0, failures: 0 };
  private consecutiveFailures = 0;
  private readonly limiter: TokenBucket;
  private readonly maxRetries: number;
  private readonly backoff: BackoffOptions | undefined;
  private readonly maxConsecutiveFailures: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ExecutorOptions = {}) {
    this.limiter = opts.limiter ?? new TokenBucket({ ratePerSecond: 2.5, jitterMs: 100 });
    this.maxRetries = opts.maxRetries ?? 5;
    this.backoff = opts.backoff;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 5;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      throw new CircuitOpenError(
        `Aborting: ${this.consecutiveFailures} consecutive requests failed after retries (last: ${label}). Is Notion reachable?`,
      );
    }
    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire();
      this.stats.requests++;
      try {
        const value = await fn();
        this.consecutiveFailures = 0;
        return value;
      } catch (err) {
        const c = classifyError(err);
        if (!c.retryable) {
          if (c.serverResponded) this.consecutiveFailures = 0; // e.g. 404: the service is fine
          throw err;
        }
        if (attempt >= this.maxRetries) {
          this.stats.failures++;
          this.consecutiveFailures++;
          throw err;
        }
        this.stats.retries++;
        if (c.rateLimited) this.stats.rateLimited++;
        await this.sleep(computeBackoffMs(attempt, c.retryAfterSeconds, this.backoff));
      }
    }
  }
}
