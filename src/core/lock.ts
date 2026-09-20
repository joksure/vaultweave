/**
 * Single-writer lock for an output directory.
 *
 * Two syncs writing the same directory at once (a slow cron run overlapping the next one, or a
 * manual `sync` while `watch` is running) would race on files and the state DB. The lock is a
 * file `<outDir>/.sheaf.lock` created atomically (`wx`), plus a *lease*:
 *
 *   - the holder refreshes the file's mtime every `heartbeatMs`;
 *   - a lock is stale if its lease expired (`staleAfterMs` without a heartbeat), OR it was
 *     taken on this host by a process that no longer exists.
 *
 * The lease makes recovery independent of PIDs and hostnames, which are unreliable in
 * containers (PID 1 after every restart, a new hostname per container).
 *
 * Known limit: if the same stale lock is taken over by two processes at the exact same
 * instant, one may delete the other's fresh lock. The window is microseconds and requires a
 * crash *and* two simultaneous restarts; the consequence is two overlapping runs, which the
 * atomic file writes and SQLite WAL tolerate.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

export const LOCK_FILENAME = ".sheaf.lock";

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
  token: string;
}

export class LockHeldError extends Error {
  override name = "LockHeldError";
  constructor(readonly holder: LockInfo | undefined) {
    super(
      holder
        ? `Another sheaf run holds the lock (pid ${holder.pid} on ${holder.host}, started ${holder.startedAt}).`
        : "Another sheaf run holds the lock.",
    );
  }
}

export interface LockOptions {
  pid?: number;
  host?: string;
  /** Lease refresh interval (default 30 s). */
  heartbeatMs?: number;
  /** Lease length without a heartbeat before the lock counts as stale (default 5 min). */
  staleAfterMs?: number;
  /** Injectable for tests. */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

export interface Lock {
  info: LockInfo;
  release(): Promise<void>;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseInfo(text: string): LockInfo | undefined {
  try {
    const v = JSON.parse(text) as Partial<LockInfo>;
    if (typeof v.pid === "number" && typeof v.host === "string" && typeof v.token === "string") {
      return v as LockInfo;
    }
  } catch {
    // fall through
  }
  return undefined;
}

export async function acquireLock(outDir: string, opts: LockOptions = {}): Promise<Lock> {
  const path = join(outDir, LOCK_FILENAME);
  const pid = opts.pid ?? process.pid;
  const host = opts.host ?? hostname();
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const staleAfterMs = opts.staleAfterMs ?? 5 * 60_000;
  const isAlive = opts.isAlive ?? processAlive;
  const now = opts.now ?? Date.now;

  await mkdir(outDir, { recursive: true });
  const info: LockInfo = {
    pid,
    host,
    startedAt: new Date(now()).toISOString(),
    token: randomUUID(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, JSON.stringify(info), { flag: "wx" });
      return startHeartbeat(path, info, heartbeatMs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    // Someone holds (or held) it. Decide whether it is stale.
    let holder: LockInfo | undefined;
    let ageMs = 0;
    try {
      holder = parseInfo(await readFile(path, "utf8"));
      ageMs = now() - (await stat(path)).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // released meanwhile: retry
      throw err;
    }

    const leaseExpired = ageMs > staleAfterMs;
    const deadLocalHolder = holder !== undefined && holder.host === host && !isAlive(holder.pid);
    // An unparsable file is usually a writer caught between create and write: trust the lease.
    if (!(leaseExpired || deadLocalHolder)) throw new LockHeldError(holder);

    try {
      await unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  throw new LockHeldError(undefined);
}

function startHeartbeat(path: string, info: LockInfo, heartbeatMs: number): Lock {
  const timer = setInterval(() => {
    const t = new Date();
    utimes(path, t, t).catch(() => undefined);
  }, heartbeatMs);
  timer.unref();

  return {
    info,
    async release() {
      clearInterval(timer);
      try {
        // Only remove a lock that is still ours (it may have been taken over after a long stall).
        const current = parseInfo(await readFile(path, "utf8"));
        if (current?.token === info.token) await unlink(path);
      } catch {
        // already gone
      }
    },
  };
}
