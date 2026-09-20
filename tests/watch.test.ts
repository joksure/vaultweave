import { describe, expect, it } from "vitest";
import { LOCKED_RETRY_MS, nextDelayMs, runWatchLoop, type WatchTick } from "../src/core/watch.js";

const H = 3_600_000;
const M = 60_000;

describe("nextDelayMs", () => {
  it("waits the full interval after success", () => {
    expect(nextDelayMs(6 * H, 0)).toEqual({ delayMs: 6 * H, reason: "interval" });
  });
  it("retries 5m, 10m, 20m… after failures", () => {
    expect(nextDelayMs(6 * H, 1)).toEqual({ delayMs: 5 * M, reason: "retry" });
    expect(nextDelayMs(6 * H, 2)).toEqual({ delayMs: 10 * M, reason: "retry" });
    expect(nextDelayMs(6 * H, 3)).toEqual({ delayMs: 20 * M, reason: "retry" });
  });
  it("never waits longer than the interval, and never overflows", () => {
    expect(nextDelayMs(30 * M, 4)).toEqual({ delayMs: 30 * M, reason: "interval" });
    expect(nextDelayMs(H, 10_000)).toEqual({ delayMs: H, reason: "interval" });
  });
  it("a short interval is never lengthened by the retry base", () => {
    expect(nextDelayMs(2 * M, 1)).toEqual({ delayMs: 2 * M, reason: "interval" });
  });
});

function harness(script: Array<WatchTick | Error>, intervalMs = 6 * H) {
  const controller = new AbortController();
  const delays: Array<[number, string]> = [];
  let i = 0;
  const done = runWatchLoop({
    intervalMs,
    signal: controller.signal,
    sleep: async () => {},
    runOnce: async () => {
      const step = script[i++];
      if (i >= script.length) controller.abort(); // stop after the scripted runs
      if (step instanceof Error) throw step;
      return step ?? { ok: true };
    },
    onScheduled: (ms, reason) => delays.push([ms, reason]),
  });
  return { done, delays };
}

describe("runWatchLoop", () => {
  it("schedules retry delays through a failure streak and resets after success", async () => {
    // The last scripted run aborts, so no delay is scheduled after it.
    const { done, delays } = harness([
      { ok: false },
      { ok: false },
      { ok: true },
      { ok: false },
      { ok: true },
    ]);
    expect(await done).toBe(5);
    expect(delays).toEqual([
      [5 * M, "retry"],
      [10 * M, "retry"],
      [6 * H, "interval"],
      [5 * M, "retry"],
    ]);
  });

  it("survives a run that throws and counts it as a failure", async () => {
    const { done, delays } = harness([new Error("kaboom"), { ok: true }]);
    expect(await done).toBe(2);
    expect(delays).toEqual([[5 * M, "retry"]]);
  });

  it("retries quickly when the lock is busy, without counting a failure", async () => {
    const { done, delays } = harness([
      { ok: true, skipped: true },
      { ok: true, skipped: true },
      { ok: true },
    ]);
    await done;
    expect(delays).toEqual([
      [LOCKED_RETRY_MS, "locked"],
      [LOCKED_RETRY_MS, "locked"],
    ]);
  });

  it("does not overlap runs: the next run only starts after the previous one finished", async () => {
    const controller = new AbortController();
    let running = 0;
    let maxRunning = 0;
    let n = 0;
    await runWatchLoop({
      intervalMs: 1,
      signal: controller.signal,
      sleep: async () => {},
      runOnce: async () => {
        maxRunning = Math.max(maxRunning, ++running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        if (++n === 4) controller.abort();
        return { ok: true };
      },
    });
    expect(maxRunning).toBe(1);
  });

  it("lets the current run finish when aborted mid-run, then stops without sleeping", async () => {
    const controller = new AbortController();
    let finished = false;
    let slept = false;
    const runs = await runWatchLoop({
      intervalMs: H,
      signal: controller.signal,
      sleep: async () => {
        slept = true;
      },
      runOnce: async () => {
        controller.abort();
        await new Promise((r) => setTimeout(r, 10));
        finished = true;
        return { ok: true };
      },
    });
    expect(runs).toBe(1);
    expect(finished).toBe(true);
    expect(slept).toBe(false);
  });

  it("the real abortable sleep wakes immediately on abort", async () => {
    const controller = new AbortController();
    const t0 = Date.now();
    let n = 0;
    const p = runWatchLoop({
      intervalMs: 10 * H,
      signal: controller.signal,
      runOnce: async () => {
        n++;
        return { ok: true };
      },
    });
    setTimeout(() => controller.abort(), 30);
    await p;
    expect(n).toBe(1);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
