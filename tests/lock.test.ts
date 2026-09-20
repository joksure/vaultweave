import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, LOCK_FILENAME, LockHeldError } from "../src/core/lock.js";

let dir: string;
const lockPath = () => join(dir, LOCK_FILENAME);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sheaf-lock-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const holder = (over: object = {}) =>
  JSON.stringify({
    pid: 999_999,
    host: "other-host",
    startedAt: "2026-01-01T00:00:00Z",
    token: "t",
    ...over,
  });

describe("acquireLock", () => {
  it("acquires, blocks a second holder, and frees on release", async () => {
    const a = await acquireLock(dir, { heartbeatMs: 60_000 });
    await expect(acquireLock(dir)).rejects.toBeInstanceOf(LockHeldError);
    await a.release();
    await expect(stat(lockPath())).rejects.toThrow();
    const b = await acquireLock(dir, { heartbeatMs: 60_000 });
    await b.release();
  });

  it("lets exactly one of many simultaneous callers win", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => acquireLock(dir, { heartbeatMs: 60_000 })),
    );
    const winners = results.filter((r) => r.status === "fulfilled");
    expect(winners).toHaveLength(1);
    await (winners[0] as PromiseFulfilledResult<{ release(): Promise<void> }>).value.release();
  });

  it("reports the holder in LockHeldError", async () => {
    await writeFile(lockPath(), holder({ pid: 4242, host: "h1" }));
    const err = await acquireLock(dir, { host: "h2" }).catch((e) => e);
    expect(err).toBeInstanceOf(LockHeldError);
    expect(err.holder).toMatchObject({ pid: 4242, host: "h1" });
  });

  it("takes over a lock whose local process is dead", async () => {
    await writeFile(lockPath(), holder({ pid: 4242, host: "me" }));
    const lock = await acquireLock(dir, { host: "me", isAlive: () => false, heartbeatMs: 60_000 });
    expect(JSON.parse(await readFile(lockPath(), "utf8")).token).toBe(lock.info.token);
    await lock.release();
  });

  it("respects a live local process", async () => {
    await writeFile(lockPath(), holder({ pid: 4242, host: "me" }));
    await expect(acquireLock(dir, { host: "me", isAlive: () => true })).rejects.toBeInstanceOf(
      LockHeldError,
    );
  });

  it("respects a fresh lease from another host (pid says nothing across hosts)", async () => {
    await writeFile(lockPath(), holder());
    await expect(acquireLock(dir, { host: "me", isAlive: () => false })).rejects.toBeInstanceOf(
      LockHeldError,
    );
  });

  it("takes over an expired lease from another host", async () => {
    await writeFile(lockPath(), holder());
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lockPath(), old, old);
    const lock = await acquireLock(dir, {
      host: "me",
      staleAfterMs: 5 * 60_000,
      heartbeatMs: 60_000,
    });
    await lock.release();
  });

  it("treats a fresh unparsable file as held but an old one as stale", async () => {
    await writeFile(lockPath(), "");
    await expect(acquireLock(dir)).rejects.toBeInstanceOf(LockHeldError);
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lockPath(), old, old);
    await (await acquireLock(dir, { heartbeatMs: 60_000 })).release();
  });

  it("heartbeat refreshes the lease so a long run is never considered stale", async () => {
    const lock = await acquireLock(dir, { heartbeatMs: 20 });
    const old = new Date(Date.now() - 60 * 60_000);
    await utimes(lockPath(), old, old);
    await new Promise((r) => setTimeout(r, 120));
    const age = Date.now() - (await stat(lockPath())).mtimeMs;
    expect(age).toBeLessThan(5_000);
    await lock.release();
  });

  it("release never removes a lock that someone else took over", async () => {
    const lock = await acquireLock(dir, { heartbeatMs: 60_000 });
    await writeFile(lockPath(), holder({ token: "someone-else" }));
    await lock.release();
    expect(JSON.parse(await readFile(lockPath(), "utf8")).token).toBe("someone-else");
  });
});
