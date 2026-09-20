import { ConfigError } from "../../config.js";
import { scrubSecrets } from "../scrub.js";
import { discordNotifier, slackNotifier, smtpNotifier, webhookNotifier } from "./channels.js";
import type {
  Notifier,
  NotifierContext,
  NotifierFactory,
  NotifyEvent,
  NotifyResult,
} from "./types.js";

export { NotifyError, postJson } from "./http.js";
export { buildMessage, type EventMessage } from "./message.js";
export { analyzeHistory, type RunOutcome, shouldAlertOnFailure } from "./policy.js";
export type * from "./types.js";

const registry = new Map<string, NotifierFactory>([
  ["webhook", webhookNotifier],
  ["slack", slackNotifier],
  ["discord", discordNotifier],
  ["smtp", smtpNotifier],
]);

/**
 * Plugin hook (design principle P4: pluggable so OSS users extend). A custom kind becomes
 * usable in `notify:` config targets once registered — e.g. from a wrapper script.
 */
export function registerNotifier(kind: string, factory: NotifierFactory): void {
  if (!/^[a-z]+$/.test(kind)) throw new Error(`Invalid notifier kind "${kind}"`);
  registry.set(kind, factory);
}

export function notifierKinds(): string[] {
  return [...registry.keys()].sort();
}

/** `undefined`, "silent" and empty entries mean "no notifications". */
export function normalizeTargets(value: string | readonly string[] | undefined): string[] {
  const list = value === undefined ? [] : typeof value === "string" ? [value] : [...value];
  return [...new Set(list.map((t) => t.trim()).filter((t) => t !== "" && t !== "silent"))];
}

export function createNotifier(target: string, ctx: NotifierContext = {}): Notifier {
  const idx = target.indexOf(":");
  const kind = idx === -1 ? target : target.slice(0, idx);
  const arg = idx === -1 ? "" : idx === 0 ? target : target.slice(idx + 1);
  const factory = registry.get(kind);
  if (!factory) {
    // Only the kind is echoed: the rest of the target may be a secret URL.
    throw new ConfigError(
      `Unknown notifier "${kind}" (available: ${notifierKinds().join(", ")}, or "silent")`,
    );
  }
  return factory(arg, ctx);
}

export function createNotifiers(
  targets: string | readonly string[] | undefined,
  ctx: NotifierContext = {},
): Notifier[] {
  return normalizeTargets(targets).map((t) => createNotifier(t, ctx));
}

/**
 * Sends `event` to every notifier concurrently. NEVER throws: a dead Slack webhook must not
 * mask the backup result, and one failing channel must not silence the others.
 */
export async function dispatch(
  notifiers: readonly Notifier[],
  event: NotifyEvent,
  extraSecrets: readonly string[] = [],
): Promise<NotifyResult[]> {
  const secrets = [...extraSecrets, ...notifiers.flatMap((n) => n.secrets)];
  return Promise.all(
    notifiers.map(async (n): Promise<NotifyResult> => {
      try {
        await n.send(event);
        return { label: n.label, event: event.kind, ok: true };
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        return { label: n.label, event: event.kind, ok: false, error: scrubSecrets(raw, secrets) };
      }
    }),
  );
}
