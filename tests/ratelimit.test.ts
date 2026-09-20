import { describe, expect, it } from "vitest";
import { computeBackoffMs, TokenBucket } from "../src/core/ratelimit.js";

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    elapsed: () => t,
  };
}

describe("TokenBucket", () => {
  it("paces requests to the configured rate", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ ratePerSecond: 2, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 5; i++) await bucket.acquire();
    // First is free (full bucket), the other 4 each wait 500 ms.
    expect(clock.elapsed()).toBe(2000);
  });

  it("allows a burst up to capacity, then throttles", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({
      ratePerSecond: 1,
      burst: 3,
      now: clock.now,
      sleep: clock.sleep,
    });
    for (let i = 0; i < 3; i++) await bucket.acquire();
    expect(clock.elapsed()).toBe(0);
    await bucket.acquire();
    expect(clock.elapsed()).toBe(1000);
  });

  it("adds jitter only when it has to wait", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({
      ratePerSecond: 1,
      jitterMs: 100,
      random: () => 0.5,
      now: clock.now,
      sleep: clock.sleep,
    });
    await bucket.acquire();
    expect(clock.elapsed()).toBe(0);
    await bucket.acquire();
    expect(clock.elapsed()).toBe(1050);
  });

  it("rejects a non-positive rate", () => {
    expect(() => new TokenBucket({ ratePerSecond: 0 })).toThrow(RangeError);
  });
});

describe("computeBackoffMs", () => {
  it("grows exponentially and is capped", () => {
    expect(computeBackoffMs(0)).toBe(500);
    expect(computeBackoffMs(1)).toBe(1000);
    expect(computeBackoffMs(3)).toBe(4000);
    expect(computeBackoffMs(30)).toBe(60_000);
  });

  it("honours Retry-After over its own estimate", () => {
    expect(computeBackoffMs(0, 7)).toBe(7000);
    expect(computeBackoffMs(5, 1)).toBe(1000);
  });

  it("ignores an invalid Retry-After", () => {
    expect(computeBackoffMs(2, Number.NaN)).toBe(2000);
  });
});
