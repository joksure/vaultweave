import { ConfigError } from "../../config.js";
import { scrubSecrets } from "../scrub.js";
import { postJson } from "./http.js";
import { buildMessage, tidy } from "./message.js";
import type { Notifier, NotifierContext, NotifierFactory, NotifyEvent } from "./types.js";

/** Validates a webhook target; the returned label carries the host only (the path is the secret). */
function parseWebhookUrl(kind: string, arg: string): { url: string; label: string } {
  let u: URL;
  try {
    u = new URL(arg);
  } catch {
    throw new ConfigError(`notify target "${kind}:…" needs a valid URL after the colon`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new ConfigError(`notify target "${kind}:…" must be an http(s) URL`);
  }
  return { url: u.toString(), label: `${kind}:${u.host}` };
}

function fence(text: string): string {
  // A stray ``` inside error text would end the code block early.
  return `\`\`\`\n${text.replaceAll("```", "'''")}\n\`\`\``;
}

function makeNotifier(
  kind: string,
  arg: string,
  ctx: NotifierContext,
  toBody: (event: NotifyEvent, secrets: readonly string[]) => unknown,
  headers: (event: NotifyEvent) => Record<string, string> = () => ({}),
): Notifier {
  const { url, label } = parseWebhookUrl(kind, arg);
  const secrets = [url, arg];
  return {
    kind,
    label,
    secrets,
    send: (event) => postJson(url, toBody(event, secrets), ctx, headers(event)),
  };
}

/** Generic JSON webhook: a stable, documented machine-readable payload. */
export const webhookNotifier: NotifierFactory = (arg, ctx) =>
  makeNotifier(
    "webhook",
    arg,
    ctx,
    (event, secrets) => {
      const msg = buildMessage(event, secrets);
      const r = event.report;
      return {
        event: `sheaf.sync.${event.kind}`,
        ok: msg.ok,
        title: msg.title,
        summary: msg.summary,
        details: msg.details,
        host: event.host,
        failureStreak: event.failureStreak,
        report: {
          schemaVersion: r.schemaVersion,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          durationMs: r.durationMs,
          ok: r.ok,
          incremental: r.incremental,
          counts: r.counts,
          aborted: r.aborted,
          warningCount: r.warnings.length,
          errorCount: r.errors.length,
          errors: r.errors
            .slice(0, 20)
            .map((i) => ({ code: i.code, id: i.id, message: tidy(i.message, secrets) })),
          gitCommit: r.gitCommit,
        },
      };
    },
    (event) => ({ "x-sheaf-event": `sync.${event.kind}` }),
  );

/** Slack incoming webhook. `& < >` are escaped so error text cannot trigger `<!channel>` pings. */
export const slackNotifier: NotifierFactory = (arg, ctx) =>
  makeNotifier("slack", arg, ctx, (event, secrets) => {
    const msg = buildMessage(event, secrets);
    const esc = (s: string) =>
      s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const icon = msg.ok
      ? event.kind === "recovered"
        ? ":large_green_circle:"
        : ":white_check_mark:"
      : ":rotating_light:";
    return {
      text: `${icon} *${esc(msg.title)}*\n${esc(msg.summary)}\n${fence(esc(msg.details.join("\n")))}`,
    };
  });

const DISCORD_LIMIT = 1900; // hard cap is 2000

/** Discord webhook. `allowed_mentions` is emptied so error text cannot ping @everyone. */
export const discordNotifier: NotifierFactory = (arg, ctx) =>
  makeNotifier("discord", arg, ctx, (event, secrets) => {
    const msg = buildMessage(event, secrets);
    const icon = msg.ok ? (event.kind === "recovered" ? "🟢" : "✅") : "🚨";
    let content = `${icon} **${msg.title}**\n${msg.summary}\n${fence(msg.details.join("\n"))}`;
    if (content.length > DISCORD_LIMIT) content = `${content.slice(0, DISCORD_LIMIT - 5)}\n\`\`\``;
    return { username: "sheaf", content, allowed_mentions: { parse: [] } };
  });

interface SmtpTarget {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to: string;
  secure: boolean;
}

function parseSmtpTarget(arg: string): SmtpTarget {
  let url: URL;
  try {
    url = new URL(arg);
  } catch {
    throw new ConfigError(
      'notify target "smtp:…" needs smtp://user:pass@host:port/from@example.com/to@example.com',
    );
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:")
    throw new ConfigError('notify target "smtp:…" must use smtp:// or smtps://');
  const [from, to] = url.pathname.slice(1).split("/");
  if (!url.hostname || !url.username || !url.password || !from || !to)
    throw new ConfigError('notify target "smtp:…" needs credentials, host, from and to addresses');
  const port = Number(url.port || (url.protocol === "smtps:" ? 465 : 587));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ConfigError('notify target "smtp:…" has an invalid port');
  return {
    host: url.hostname,
    port,
    user: decodeURIComponent(url.username),
    pass: decodeURIComponent(url.password),
    from: decodeURIComponent(from),
    to: decodeURIComponent(to),
    secure: url.protocol === "smtps:" || port === 465,
  };
}

export function registerSmtpNotifier(
  register: (kind: string, factory: NotifierFactory) => void,
): void {
  register("smtp", smtpNotifier);
}

export const smtpNotifier: NotifierFactory = (arg, ctx) => {
  const configured = arg.startsWith("//") ? `smtp:${arg}` : arg || process.env.SHEAF_SMTP_URL;
  if (!configured) throw new ConfigError("SMTP notifier needs a target or SHEAF_SMTP_URL");
  const target = parseSmtpTarget(configured);
  const secretUrl = configured;
  const label = `smtp:${target.host}:${target.port}`;
  return {
    kind: "smtp",
    label,
    secrets: [secretUrl, target.user, target.pass, target.from, target.to],
    send: async (event) => {
      const msg = buildMessage(event, [
        secretUrl,
        target.user,
        target.pass,
        target.from,
        target.to,
      ]);
      const subject = msg.title;
      const text = scrubSecrets(`${msg.summary}\n${msg.details.join("\n")}`, [
        secretUrl,
        target.user,
        target.pass,
        target.from,
        target.to,
      ]);
      let createTransport:
        | ((options: Record<string, unknown>) => {
            sendMail(message: Record<string, unknown>): Promise<unknown>;
          })
        | undefined = ctx.smtpTransport;
      if (!createTransport) {
        try {
          const mod = await import("nodemailer");
          createTransport = (options) => mod.default.createTransport(options);
        } catch {
          throw new Error(
            "SMTP notifier requires optional dependency nodemailer; install it with npm install nodemailer",
          );
        }
      }
      try {
        await createTransport({
          host: target.host,
          port: target.port,
          secure: target.secure,
          auth: { user: target.user, pass: target.pass },
        }).sendMail({ from: target.from, to: target.to, subject, text });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const scrubbed = scrubSecrets(detail, [
          secretUrl,
          target.user,
          target.pass,
          target.from,
          target.to,
        ])
          .split(target.user)
          .join("***")
          .split(target.pass)
          .join("***");
        throw new Error(`SMTP delivery failed: ${scrubbed}`);
      }
    },
  };
};
