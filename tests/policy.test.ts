import { describe, expect, it } from "vitest";
import { analyzeHistory, shouldAlertOnFailure } from "../src/core/notify/policy.js";

const o = (n: number, ok: boolean) => ({ startedAt: `2026-09-${String(n).padStart(2, "0")}`, ok });

describe("shouldAlertOnFailure", () => {
  it("alerts on 1, 2, 4, 8, 16… and stays quiet otherwise", () => {
    const alerting = Array.from({ length: 40 }, (_, i) => i).filter(shouldAlertOnFailure);
    expect(alerting).toEqual([1, 2, 4, 8, 16, 32]);
  });
});

describe("analyzeHistory", () => {
  it("counts the current failure when history does not contain it yet", () => {
    expect(analyzeHistory(o(5, false), [o(4, false), o(3, false), o(2, true)])).toEqual({
      failureStreak: 3,
      previousFailures: 0,
    });
  });

  it("does not double count when history already includes the current run", () => {
    expect(analyzeHistory(o(5, false), [o(5, false), o(4, false), o(3, true)])).toEqual({
      failureStreak: 2,
      previousFailures: 0,
    });
  });

  it("reports how many failures preceded a success", () => {
    expect(analyzeHistory(o(5, true), [o(5, true), o(4, false), o(3, false), o(2, true)])).toEqual({
      failureStreak: 0,
      previousFailures: 2,
    });
  });

  it("is safe with no history at all", () => {
    expect(analyzeHistory(o(1, false), [])).toEqual({ failureStreak: 1, previousFailures: 0 });
    expect(analyzeHistory(o(1, true), [])).toEqual({ failureStreak: 0, previousFailures: 0 });
  });
});
