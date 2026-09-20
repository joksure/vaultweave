import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../src/core/exit-codes.js";
import { acquireLock, LOCK_FILENAME } from "../src/core/lock.js";
import type { Notifier, NotifyEvent } from "../src/core/notify/index.js";
import { runOperatedSync } from "../src/core/operations.js";
import { openStateDb } from "../src/core/state/index.js";
import { makeReport } from "./support/report.js";

let outDir: string;
beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), "sheaf-ops-"));
});
afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

function recorder(
  label = "rec:one",
  secret = "https://hooks.example/SECRET",
): Notifier & { events: NotifyEvent[] } {
  const events: NotifyEvent[] = [];
  return { kind: "rec", label, secrets: [secret], events, send: async (e) => void events.push(e) };
}

const okReport = () => makeReport({ startedAt: new Date().toISOString() });
const badReport = () =>
  makeReport({
    startedAt: new Date().toISOString(),
    ok: false,
    errors: [{ code: "page_failed", id: "p1", message: "boom" }],
  });

const sync = () => ({ token: "ntn_TOKENTOKENTOKENTOKEN1234", outDir });

describe("runOperatedSync", () => {
  it("succeeds quietly with no notifiers", async () => {
    const r = await runOperatedSync(
      { sync: sync() },
      { runSync: async () => okReport(), readHistory: () => [] },
    );
    expect(r).toMatchObject({ status: "completed", exitCode: EXIT.OK, notifications: [] });
  });

  it("alerts on the first failure and exits 1", async () => {
    const alert = recorder();
    const r = await runOperatedSync(
      { sync: sync(), onError: [alert] },
      { runSync: async () => badReport(), readHistory: () => [] },
    );
    expect(r.exitCode).toBe(EXIT.FAILED);
    expect(alert.events.map((e) => e.kind)).toEqual(["failed"]);
    expect(alert.events[0]?.failureStreak).toBe(1);
  });

  it("follows the 1,2,4,8 alert policy from persisted history", async () => {
    const sent: number[] = [];
    for (let prior = 0; prior < 9; prior++) {
      const alert = recorder();
      const history = Array.from({ length: prior }, (_, i) => ({
        startedAt: `old-${i}`,
        ok: false,
      }));
      await runOperatedSync(
        { sync: sync(), onError: [alert] },
        { runSync: async () => badReport(), readHistory: () => history },
      );
      if (alert.events.length > 0) sent.push(prior + 1);
    }
    expect(sent).toEqual([1, 2, 4, 8]);
  });

  it("sends 'recovered' to the alert channel after failures, and 'succeeded' to the success channel", async () => {
    const alert = recorder("rec:alert", "https://a.example/A1");
    const chatter = recorder("rec:chat", "https://c.example/C1");
    await runOperatedSync(
      { sync: sync(), onError: [alert], onSuccess: [chatter] },
      {
        runSync: async () => okReport(),
        readHistory: () => [
          { startedAt: "x2", ok: false },
          { startedAt: "x1", ok: false },
        ],
      },
    );
    expect(alert.events.map((e) => e.kind)).toEqual(["recovered"]);
    expect(alert.events[0]?.previousFailures).toBe(2);
    expect(chatter.events.map((e) => e.kind)).toEqual(["succeeded"]);
  });

  it("does not send both messages to a target that is on both lists", async () => {
    const both = recorder();
    await runOperatedSync(
      { sync: sync(), onError: [both], onSuccess: [both] },
      { runSync: async () => okReport(), readHistory: () => [{ startedAt: "x", ok: false }] },
    );
    expect(both.events.map((e) => e.kind)).toEqual(["succeeded"]);
  });

  it("stays silent on a success with no prior failures and no success channel", async () => {
    const alert = recorder();
    await runOperatedSync(
      { sync: sync(), onError: [alert] },
      { runSync: async () => okReport(), readHistory: () => [] },
    );
    expect(alert.events).toEqual([]);
  });

  it("a broken notifier never changes the outcome and is reported", async () => {
    const dead: Notifier = {
      kind: "dead",
      label: "dead:host",
      secrets: ["https://hooks.example/SECRET"],
      send: async () => {
        throw new Error("HTTP 404 from https://hooks.example/SECRET");
      },
    };
    const r = await runOperatedSync(
      { sync: sync(), onError: [dead] },
      { runSync: async () => badReport(), readHistory: () => [] },
    );
    expect(r.exitCode).toBe(EXIT.FAILED);
    expect(r.notifications[0]).toMatchObject({ ok: false, label: "dead:host" });
    expect(r.notifications[0]?.error).not.toContain("SECRET");
  });

  it("turns a crash into a failed report, an alert, a DB entry and a released lock", async () => {
    const alert = recorder();
    const r = await runOperatedSync(
      { sync: sync(), onError: [alert] },
      {
        runSync: async () => {
          throw new Error("disk full while using ntn_TOKENTOKENTOKENTOKEN1234");
        },
      },
    );
    expect(r.exitCode).toBe(EXIT.FAILED);
    expect(r.report?.errors[0]?.code).toBe("run_crashed");
    expect(r.report?.aborted).not.toContain("TOKENTOKEN");
    expect(alert.events).toHaveLength(1);
    await expect(stat(join(outDir, LOCK_FILENAME))).rejects.toThrow();
    const db = openStateDb(outDir);
    expect(db.getRecentOutcomes()[0]?.ok).toBe(false);
    db.close();
  });

  it("skips (exit 3) without syncing or alerting when another run holds the lock", async () => {
    const held = await acquireLock(outDir, { heartbeatMs: 60_000 });
    const alert = recorder();
    let called = false;
    const r = await runOperatedSync(
      { sync: sync(), onError: [alert] },
      {
        runSync: async () => {
          called = true;
          return okReport();
        },
      },
    );
    await held.release();
    expect(r).toMatchObject({ status: "skipped_locked", exitCode: EXIT.LOCKED });
    expect(r.lockHolder?.pid).toBe(process.pid);
    expect(called).toBe(false);
    expect(alert.events).toEqual([]);
  });

  it("releases the lock before notifying (a slow webhook must not block the next run)", async () => {
    let lockPresentDuringNotify: boolean | undefined;
    const spy: Notifier = {
      kind: "spy",
      label: "spy:x",
      secrets: [],
      send: async () => {
        lockPresentDuringNotify = await stat(join(outDir, LOCK_FILENAME)).then(
          () => true,
          () => false,
        );
      },
    };
    await runOperatedSync(
      { sync: sync(), onError: [spy] },
      { runSync: async () => badReport(), readHistory: () => [] },
    );
    expect(lockPresentDuringNotify).toBe(false);
  });

  it("treats an unusable output directory as a failed run, not an exception", async () => {
    const alert = recorder();
    const r = await runOperatedSync(
      { sync: { token: "t", outDir: join(outDir, "file.txt", "nested") }, onError: [alert] },
      {
        acquireLock: async () => {
          throw new Error("EACCES: permission denied");
        },
        readHistory: () => [],
      },
    );
    expect(r.exitCode).toBe(EXIT.FAILED);
    expect(r.report?.errors[0]?.message).toContain("EACCES");
    expect(alert.events).toHaveLength(1);
  });

  it("with the real pipeline, the persisted history drives the streak across runs", async () => {
    const alert = recorder();
    const failing = {
      runExtract: () => ({
        extract: async () => {
          throw new Error("unauthorized");
        },
      }),
      runWriteWorkspace: async () => ({ pagePaths: {}, filesWritten: [], errors: [] }),
      runGitSync: async () => null,
    };
    const sent: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const before = alert.events.length;
      const r = await runOperatedSync({ sync: sync(), onError: [alert] }, { syncDeps: failing });
      expect(r.exitCode).toBe(EXIT.FAILED);
      sent.push(alert.events.length > before);
      await new Promise((res) => setTimeout(res, 3)); // distinct startedAt
    }
    expect(sent).toEqual([true, true, false]); // streak 1, 2 alert; 3 does not
    const report = JSON.parse(await readFile(join(outDir, ".sheaf-run-report.json"), "utf8"));
    expect(report.schemaVersion).toBe(1);
  });
});
