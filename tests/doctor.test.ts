import { describe, expect, it } from "vitest";
import { type NotionLike, runDoctor } from "../src/core/doctor.js";
import { TokenBucket } from "../src/core/ratelimit.js";

function client(overrides: Partial<NotionLike> = {}): NotionLike {
  return {
    users: { me: async () => ({ name: "Backup Bot" }) },
    search: async () => ({ results: [{}, {}], has_more: false }),
    ...overrides,
  };
}

const instant = new TokenBucket({ ratePerSecond: 1000, burst: 1000 });

describe("runDoctor", () => {
  it("passes on a healthy setup", async () => {
    const report = await runDoctor({ hasToken: true, client: client(), nodeVersion: "22.1.0" });
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual(["node", "token", "auth", "reachable"]);
  });

  it("fails without a token and does not try the network", async () => {
    const report = await runDoctor({ hasToken: false, nodeVersion: "22.0.0" });
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)?.id).toBe("token");
  });

  it("flags an old Node version", async () => {
    const report = await runDoctor({ hasToken: true, client: client(), nodeVersion: "18.19.0" });
    expect(report.checks[0]).toMatchObject({ id: "node", ok: false });
  });

  it("stops after a rejected token", async () => {
    const report = await runDoctor({
      hasToken: true,
      nodeVersion: "22.0.0",
      client: client({
        users: {
          me: async () => {
            throw new Error("API token is invalid.");
          },
        },
      }),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.map((c) => c.id)).toEqual(["node", "token", "auth"]);
  });

  it("fails when the integration can see no pages", async () => {
    const report = await runDoctor({
      hasToken: true,
      nodeVersion: "22.0.0",
      client: client({ search: async () => ({ results: [], has_more: false }) }),
    });
    expect(report.checks.at(-1)).toMatchObject({ id: "reachable", ok: false });
  });

  it("counts 429s in the rate-limit probe", async () => {
    let calls = 0;
    const report = await runDoctor({
      hasToken: true,
      nodeVersion: "22.0.0",
      probeRateLimit: true,
      probeRequests: 4,
      limiter: instant,
      client: client({
        search: async (args) => {
          calls++;
          // call 1 is the reachability check; fail two of the probe calls
          if (args.page_size === 1 && calls % 2 === 0)
            throw Object.assign(new Error("x"), { code: "rate_limited" });
          return { results: [{}], has_more: false };
        },
      }),
    });
    const probe = report.checks.find((c) => c.id === "rate_limit");
    expect(probe?.ok).toBe(false);
    expect(probe?.message).toMatch(/2\/4/);
  });
});
