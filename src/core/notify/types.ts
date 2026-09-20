import type { RunReport } from "../state/report.js";

export type NotifyEventKind = "failed" | "succeeded" | "recovered";

export interface NotifyEvent {
  kind: NotifyEventKind;
  report: RunReport;
  /** Consecutive failed runs including this one (0 when the run succeeded). */
  failureStreak: number;
  /** For `recovered`: how many failed runs preceded this success. */
  previousFailures: number;
  /** Machine that ran the sync — tells a team *which* backup job is speaking. */
  host: string;
}

/**
 * A delivery channel. Implementations must:
 *  - never put secrets (tokens, webhook URLs) into `label` or thrown error messages;
 *  - throw on failure (the dispatcher isolates failures — one bad channel never blocks another).
 */
export interface Notifier {
  /** The scheme used in config, e.g. "slack". */
  readonly kind: string;
  /** Safe-to-log identifier, e.g. "slack:hooks.slack.com". Never contains the secret path. */
  readonly label: string;
  /** Strings that must be scrubbed from any text mentioning this notifier. */
  readonly secrets: readonly string[];
  send(event: NotifyEvent): Promise<void>;
}

export interface NotifierContext {
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-attempt timeout (default 10 s). */
  timeoutMs?: number;
  /** Retries after the first attempt for network errors, 429 and 5xx (default 3). */
  retries?: number;
  /** Injectable SMTP transport factory for tests; production loads nodemailer lazily. */
  smtpTransport?: (options: Record<string, unknown>) => {
    sendMail(message: Record<string, unknown>): Promise<unknown>;
  };
}

/** Builds a notifier from the part of the config target after `<kind>:`. */
export type NotifierFactory = (arg: string, ctx: NotifierContext) => Notifier;

export interface NotifyResult {
  label: string;
  event: NotifyEventKind;
  ok: boolean;
  error?: string;
}
