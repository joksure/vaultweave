import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import {
  buildMessage,
  createNotifier,
  createNotifiers,
  dispatch,
  type Notifier,
  type NotifyEvent,
  normalizeTargets,
  postJson,
  registerNotifier,
} from "../src/core/notify/index.js";
import { scrubSecrets } from "../src/core/scrub.js";
import { makeReport } from "./support/report.js";

interface Hit {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let base: string;
let hits: Hit[];
/** Status codes to answer with, one per request; the last one repeats. */
let script: Array<number | { status: number; headers?: Record<string, string> } | "hang">;

beforeEach(async () => {
  hits = [];
  script = [204];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      const i = Math.min(hits.length - 1, script.length - 1);
      const step = script[i] ?? 204;
      if (step === "hang") return; // never answer
      const { status, headers } = typeof step === "number" ? { status: step, headers: {} } : step;
      res.writeHead(status, headers);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const instant = async () => {};

function failedEvent(over: Partial<NotifyEvent> = {}): NotifyEvent {
  return {
    kind: "failed",
    failureStreak: 1,
    previousFailures: 0,
    host: "backup-box",
    report: makeReport({
      ok: false,
      errors: [{ code: "page_failed", id: "abc", message: "not found" }],
    }),
    ...over,
  };
}

describe("postJson", () => {
  it("retries 5xx and then succeeds", async () => {
    script = [500, 502, 204];
    await postJson(`${base}/hook`, { a: 1 }, { sleep: instant });
    expect(hits).toHaveLength(3);
    expect(JSON.parse(hits[2]?.body ?? "{}")).toEqual({ a: 1 });
  });

  it("honours Retry-After on 429", async () => {
    script = [{ status: 429, headers: { "retry-after": "2" } }, 204];
    const sleeps: number[] = [];
    await postJson(`${base}/hook`, {}, { sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([2000]);
  });

  it("does not retry a permanent 4xx and never leaks the URL", async () => {
    script = [404];
    const err = await postJson(`${base}/secret-path-123`, {}, { sleep: instant }).catch((e) => e);
    expect(hits).toHaveLength(1);
    expect(String(err.message)).toBe("HTTP 404");
    expect(String(err.message)).not.toContain("secret-path-123");
  });

  it("gives up after the configured retries", async () => {
    script = [503];
    const err = await postJson(`${base}/h`, {}, { sleep: instant, retries: 2 }).catch((e) => e);
    expect(hits).toHaveLength(3);
    expect(err.message).toContain("HTTP 503");
    expect(err.message).toContain("3 attempts");
  });

  it("times out on a server that never answers", async () => {
    script = ["hang"];
    const err = await postJson(`${base}/h`, {}, { timeoutMs: 50, retries: 0 }).catch((e) => e);
    expect(err.message).toContain("timed out");
  });

  it("refuses redirects", async () => {
    script = [{ status: 302, headers: { location: `${base}/elsewhere` } }];
    const err = await postJson(`${base}/h`, {}, { sleep: instant, retries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(hits).toHaveLength(1);
  });
});

describe("channels", () => {
  it("webhook sends a stable machine-readable payload", async () => {
    const n = createNotifier(`webhook:${base}/hook`, { sleep: instant });
    await n.send(failedEvent());
    const hit = hits[0] as Hit;
    expect(hit.headers["x-vaultweave-event"]).toBe("sync.failed");
    const body = JSON.parse(hit.body);
    expect(body).toMatchObject({
      event: "vaultweave.sync.failed",
      ok: false,
      host: "backup-box",
      failureStreak: 1,
      report: { schemaVersion: 1, errorCount: 1, counts: { pagesLive: 42 } },
    });
    expect(body.report.errors[0]).toEqual({ code: "page_failed", id: "abc", message: "not found" });
  });

  it("slack escapes markup so error text cannot ping the channel", async () => {
    const n = createNotifier(`slack:${base}/services/T/B/X`, { sleep: instant });
    await n.send(
      failedEvent({
        report: makeReport({
          ok: false,
          errors: [{ code: "x", id: "1", message: "<!channel> & <@U123> ```break```" }],
        }),
      }),
    );
    const text: string = JSON.parse(hits[0]?.body ?? "{}").text;
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).toContain("&amp;");
    expect(text.match(/```/g)).toHaveLength(2); // only our own fence
  });

  it("discord disables mentions and respects the 2000 char cap", async () => {
    const n = createNotifier(`discord:${base}/api/webhooks/1/abc`, { sleep: instant });
    const errors = Array.from({ length: 50 }, (_, i) => ({
      code: "c",
      id: String(i),
      message: "x".repeat(250),
    }));
    await n.send(failedEvent({ report: makeReport({ ok: false, errors }) }));
    const body = JSON.parse(hits[0]?.body ?? "{}");
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content.length).toBeLessThanOrEqual(2000);
  });

  it("labels never contain the secret path", () => {
    const n = createNotifier("slack:https://hooks.slack.com/services/T000/B000/SECRETVALUE");
    expect(n.label).toBe("slack:hooks.slack.com");
    expect(n.label).not.toContain("SECRETVALUE");
  });

  it("SMTP sends metadata-only mail for failure streaks 1, 2 and 4", async () => {
    const messages: Record<string, unknown>[] = [];
    const n = createNotifier(
      "smtp://user:password@mail.example:587/from@example.com/to@example.com",
      {
        smtpTransport: () => ({ sendMail: async (message) => void messages.push(message) }),
      },
    );
    for (const failureStreak of [1, 2, 4]) await n.send(failedEvent({ failureStreak }));
    expect(messages.map((m) => m.subject)).toEqual([
      "vaultweave backup FAILED (1 in a row)",
      "vaultweave backup FAILED (2 in a row)",
      "vaultweave backup FAILED (4 in a row)",
    ]);
    expect(String(messages[0]?.text)).toContain("host: backup-box");
    expect(String(messages[0]?.text)).not.toContain("password");
    expect(String(messages[0]?.text)).not.toContain("Page content");
  });

  it("SMTP scrubs credentials from delivery errors", async () => {
    const n = createNotifier(
      "smtp://user:password@mail.example:587/from@example.com/to@example.com",
      {
        smtpTransport: () => ({
          sendMail: async () => {
            throw new Error("auth failed for user:password at smtp://user:password@mail.example");
          },
        }),
      },
    );
    const err = await n.send(failedEvent()).catch((e) => e);
    expect(String(err)).not.toContain("password");
    expect(String(err)).not.toContain("user");
  });
});

describe("target parsing", () => {
  it("normalizes silent / empty / duplicates", () => {
    expect(normalizeTargets(undefined)).toEqual([]);
    expect(normalizeTargets("silent")).toEqual([]);
    expect(normalizeTargets(["webhook:http://a", "webhook:http://a", " ", "silent"])).toEqual([
      "webhook:http://a",
    ]);
  });

  it("rejects unknown kinds without echoing the rest of the target", () => {
    const err = (() => {
      try {
        createNotifier("pagerduty:https://secret.example/token123");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err?.message).toContain('"pagerduty"');
    expect(err?.message).toContain("slack");
    expect(err?.message).not.toContain("token123");
  });

  it("rejects non-http URLs and garbage", () => {
    expect(() => createNotifier("webhook:file:///etc/passwd")).toThrow(ConfigError);
    expect(() => createNotifier("webhook:not a url")).toThrow(ConfigError);
    expect(() => createNotifier("slack:")).toThrow(ConfigError);
  });

  it("supports custom kinds through the registry", async () => {
    const seen: string[] = [];
    registerNotifier("custom", (arg) => ({
      kind: "custom",
      label: "custom:test",
      secrets: [arg],
      send: async (e) => void seen.push(e.kind),
    }));
    const [n] = createNotifiers("custom:whatever");
    await n?.send(failedEvent());
    expect(seen).toEqual(["failed"]);
  });
});

describe("dispatch", () => {
  const good: Notifier = { kind: "g", label: "g:ok", secrets: [], send: async () => {} };
  const bad: Notifier = {
    kind: "b",
    label: "b:down",
    secrets: ["https://hooks.example/SECRETPATH"],
    send: async () => {
      throw new Error("failed talking to https://hooks.example/SECRETPATH");
    },
  };

  it("never throws, isolates failures and scrubs secrets from errors", async () => {
    const results = await dispatch([bad, good], failedEvent());
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.label === "g:ok")?.ok).toBe(true);
    const failed = results.find((r) => r.label === "b:down");
    expect(failed?.ok).toBe(false);
    expect(failed?.error).not.toContain("SECRETPATH");
  });
});

describe("buildMessage / scrubSecrets", () => {
  it("scrubs the token and Notion-shaped tokens from error text", () => {
    const token = "ntn_ABCDEFGHIJKLMNOPQRSTUV123456";
    const msg = buildMessage(
      failedEvent({
        report: makeReport({
          ok: false,
          aborted: `401 for ${token}`,
          errors: [
            { code: "e", id: "i", message: `bad secret_abcdefghijklmnopqrstuvwx and ${token}` },
          ],
        }),
      }),
      [token],
    );
    const all = [msg.title, msg.summary, ...msg.details].join("\n");
    expect(all).not.toContain("ABCDEFGHIJKLMNOP");
    expect(all).not.toContain("secret_abcdefgh");
    expect(all).toContain("***");
  });

  it("caps issues and line length, and reports streaks", () => {
    const errors = Array.from({ length: 12 }, (_, i) => ({
      code: "c",
      id: `id${i}`,
      message: "m".repeat(1000),
    }));
    const msg = buildMessage(
      failedEvent({ failureStreak: 4, report: makeReport({ ok: false, errors }) }),
    );
    expect(msg.title).toBe("vaultweave backup FAILED (4 in a row)");
    expect(msg.details.filter((d) => d.startsWith("[c]"))).toHaveLength(5);
    expect(msg.details.every((d) => d.length <= 300)).toBe(true);
    expect(msg.details.join("\n")).toContain("and 7 more");
  });

  it("describes recovery and success", () => {
    const ok = makeReport();
    const rec = buildMessage({
      kind: "recovered",
      report: ok,
      failureStreak: 0,
      previousFailures: 3,
      host: "h",
    });
    expect(rec.title).toBe("vaultweave backup RECOVERED");
    expect(rec.summary).toContain("3 failed run(s)");
    const s = buildMessage({
      kind: "succeeded",
      report: ok,
      failureStreak: 0,
      previousFailures: 0,
      host: "h",
    });
    expect(s.summary).toBe("42 pages (3 written, 0 deleted) in 12s.");
  });

  it("scrubSecrets ignores short strings that would mangle text", () => {
    expect(scrubSecrets("a b c", ["a", ""])).toBe("a b c");
  });

  it("scrubs SMTP credentials", () => {
    expect(scrubSecrets("smtp://alice:password@mail.example:587/x", [])).not.toContain("password");
  });
});
