import { describe, expect, it } from "vitest";
import {
  CircuitOpenError,
  classifyError,
  RequestExecutor,
} from "../src/core/extractor/executor.js";
import { TokenBucket } from "../src/core/ratelimit.js";

const apiError = (status: number, code: string, headers?: unknown) =>
  Object.assign(new Error(code), { status, code, headers });

function make(opts: ConstructorParameters<typeof RequestExecutor>[0] = {}) {
  const sleeps: number[] = [];
  const executor = new RequestExecutor({
    limiter: new TokenBucket({ ratePerSecond: 1_000_000, burst: 1_000_000 }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...opts,
  });
  return { executor, sleeps };
}

/** A function that fails with the given errors in order, then succeeds. */
function failing(...errors: unknown[]) {
  let calls = 0;
  const fn = async () => {
    const err = errors[calls++];
    if (err !== undefined) throw err;
    return "ok";
  };
  return { fn, calls: () => calls };
}

describe("classifyError", () => {
  it("treats 429 as retryable and reads Retry-After from Headers", () => {
    const c = classifyError(apiError(429, "rate_limited", new Headers({ "retry-after": "3" })));
    expect(c).toMatchObject({ retryable: true, rateLimited: true, retryAfterSeconds: 3 });
  });

  it("reads Retry-After from plain objects, case-insensitively", () => {
    expect(
      classifyError(apiError(429, "rate_limited", { "Retry-After": "7" })).retryAfterSeconds,
    ).toBe(7);
  });

  it("ignores an HTTP-date Retry-After rather than guessing", () => {
    const c = classifyError(
      apiError(429, "rate_limited", { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
    );
    expect(c.retryAfterSeconds).toBeUndefined();
    expect(c.retryable).toBe(true);
  });

  it("retries 5xx and known transient codes", () => {
    expect(classifyError(apiError(503, "service_unavailable")).retryable).toBe(true);
    expect(classifyError(apiError(502, "whatever")).retryable).toBe(true);
    expect(classifyError(apiError(0, "notionhq_client_request_timeout")).retryable).toBe(true);
  });

  it("retries network failures", () => {
    expect(classifyError(new TypeError("fetch failed")).retryable).toBe(true);
    expect(
      classifyError(Object.assign(new Error("x"), { cause: { code: "ECONNRESET" } })).retryable,
    ).toBe(true);
  });

  it("does not retry client errors, and knows the service answered", () => {
    expect(classifyError(apiError(404, "object_not_found"))).toMatchObject({
      retryable: false,
      serverResponded: true,
    });
    expect(classifyError(apiError(401, "unauthorized")).retryable).toBe(false);
    expect(classifyError(new Error("bug")).retryable).toBe(false);
  });
});

describe("RequestExecutor", () => {
  it("backs off exponentially when the server gives no hint", async () => {
    const { executor, sleeps } = make();
    const { fn } = failing(
      apiError(503, "service_unavailable"),
      apiError(503, "service_unavailable"),
    );
    await expect(executor.run("t", fn)).resolves.toBe("ok");
    expect(sleeps).toEqual([500, 1000]);
    expect(executor.stats).toMatchObject({ requests: 3, retries: 2, rateLimited: 0, failures: 0 });
  });

  it("prefers Retry-After over its own estimate and counts rate limiting", async () => {
    const { executor, sleeps } = make();
    const e = () => apiError(429, "rate_limited", { "retry-after": "2" });
    await executor.run("t", failing(e(), e()).fn);
    expect(sleeps).toEqual([2000, 2000]);
    expect(executor.stats).toMatchObject({ retries: 2, rateLimited: 2 });
  });

  it("gives up after maxRetries and throws the original error", async () => {
    const { executor } = make({ maxRetries: 2 });
    const err = apiError(503, "service_unavailable");
    const f = failing(err, err, err, err);
    await expect(executor.run("t", f.fn)).rejects.toBe(err);
    expect(f.calls()).toBe(3);
    expect(executor.stats.failures).toBe(1);
  });

  it("does not retry a client error", async () => {
    const { executor, sleeps } = make();
    const f = failing(apiError(404, "object_not_found"));
    await expect(executor.run("t", f.fn)).rejects.toMatchObject({ code: "object_not_found" });
    expect(f.calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("opens the circuit after consecutive exhausted failures and stops calling out", async () => {
    const { executor } = make({ maxRetries: 0, maxConsecutiveFailures: 3 });
    const boom = () =>
      failing(apiError(503, "service_unavailable"), apiError(503, "service_unavailable"));
    for (let i = 0; i < 3; i++)
      await expect(executor.run("t", boom().fn)).rejects.toMatchObject({ status: 503 });

    let called = false;
    await expect(
      executor.run("t", async () => {
        called = true;
        return 1;
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it("a success resets the breaker, and so does a 404 (the service is clearly up)", async () => {
    const { executor } = make({ maxRetries: 0, maxConsecutiveFailures: 2 });
    const down = () => failing(apiError(503, "service_unavailable")).fn;

    await expect(executor.run("t", down())).rejects.toBeDefined();
    await executor.run("t", async () => 1); // success -> counter back to 0
    await expect(executor.run("t", down())).rejects.toBeDefined();
    await expect(
      executor.run("t", failing(apiError(404, "object_not_found")).fn),
    ).rejects.toBeDefined(); // reset
    await expect(executor.run("t", down())).rejects.toBeDefined();
    await expect(executor.run("t", async () => "still open")).resolves.toBe("still open");
  });
});
