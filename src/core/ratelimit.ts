/**
 * Token-bucket pacing + 429 backoff.
 * Notion averages ~3 req/s; we default to a conservative 2.5 req/s plus jitter.
 */

export interface TokenBucketOptions {
  /** Sustained refill rate, tokens per second. */
  ratePerSecond: number;
  /** Max tokens that can accumulate (burst size). Defaults to 1 (no bursting). */
  burst?: number;
  /** Extra random wait (0..jitterMs) added whenever we have to sleep. */
  jitterMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class TokenBucket {
  private readonly rate: number;
  private readonly capacity: number;
  private readonly jitterMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private tokens: number;
  private last: number;

  constructor(opts: TokenBucketOptions) {
    if (!(opts.ratePerSecond > 0)) throw new RangeError("ratePerSecond must be > 0");
    this.rate = opts.ratePerSecond;
    this.capacity = Math.max(1, opts.burst ?? 1);
    this.jitterMs = Math.max(0, opts.jitterMs ?? 0);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = opts.random ?? Math.random;
    this.tokens = this.capacity;
    this.last = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsedSec = Math.max(0, t - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.rate);
    this.last = t;
  }

  /** Resolves once one request may be sent. */
  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.rate) * 1000);
      await this.sleep(waitMs + Math.floor(this.random() * this.jitterMs));
    }
  }
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
}

/**
 * Delay before retry number `attempt` (0-based) after a 429/5xx.
 * A server-provided Retry-After always wins over our own estimate.
 */
export function computeBackoffMs(
  attempt: number,
  retryAfterSeconds?: number,
  { baseMs = 500, maxMs = 60_000 }: BackoffOptions = {},
): number {
  if (
    retryAfterSeconds !== undefined &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds >= 0
  ) {
    return Math.min(maxMs, Math.ceil(retryAfterSeconds * 1000));
  }
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
}
