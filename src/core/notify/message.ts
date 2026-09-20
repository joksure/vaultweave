import { formatDuration } from "../duration.js";
import { scrubSecrets } from "../scrub.js";
import type { RunIssue } from "../state/report.js";
import type { NotifyEvent } from "./types.js";

export interface EventMessage {
  /** One line, e.g. "vaultweave backup FAILED (3 in a row)". */
  title: string;
  /** One or two sentences: what happened. */
  summary: string;
  /** Short factual lines (counts, first errors). Already scrubbed and truncated. */
  details: string[];
  ok: boolean;
}

const MAX_ISSUES = 5;
const MAX_LINE = 300;

/** Collapses whitespace, scrubs secrets, and caps length so one huge error cannot flood a channel. */
export function tidy(text: string, secrets: readonly string[]): string {
  const flat = scrubSecrets(text, secrets).replace(/\s+/g, " ").trim();
  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE - 1)}…` : flat;
}

function issueLine(i: RunIssue, secrets: readonly string[]): string {
  return tidy(`[${i.code}] ${i.id}: ${i.message}`, secrets);
}

/**
 * Builds the channel-independent message. It deliberately contains only run metadata
 * (counts, error codes, ids) — never page titles or page content.
 */
export function buildMessage(event: NotifyEvent, secrets: readonly string[] = []): EventMessage {
  const { report, kind } = event;
  const c = report.counts;
  const took = formatDuration(report.durationMs);
  const stats = `${c.pagesLive} pages (${c.pagesWritten} written, ${c.pagesDeleted} deleted)`;

  const details: string[] = [];

  if (kind === "failed") {
    const reason = report.aborted
      ? `Aborted: ${tidy(report.aborted, secrets)}`
      : `${report.errors.length} error(s) — the backup is incomplete.`;
    details.push(`host: ${event.host}`, `started: ${report.startedAt}`);
    details.push(`progress before failure: ${stats}, ${c.apiRequests} API requests`);
    for (const i of report.errors.slice(0, MAX_ISSUES)) details.push(issueLine(i, secrets));
    if (report.errors.length > MAX_ISSUES) {
      details.push(
        `…and ${report.errors.length - MAX_ISSUES} more (see .vaultweave-run-report.json)`,
      );
    }
    const streak = ` (${event.failureStreak} in a row)`;
    return { title: `vaultweave backup FAILED${streak}`, summary: reason, details, ok: false };
  }

  details.push(`host: ${event.host}`, `started: ${report.startedAt}`);
  if (report.warnings.length > 0) details.push(`${report.warnings.length} warning(s)`);
  if (report.gitCommit) details.push(`git: ${report.gitCommit.sha.slice(0, 8)}`);

  if (kind === "recovered") {
    return {
      title: "vaultweave backup RECOVERED",
      summary: `Back to normal after ${event.previousFailures} failed run(s): ${stats} in ${took}.`,
      details,
      ok: true,
    };
  }
  return { title: "vaultweave backup OK", summary: `${stats} in ${took}.`, details, ok: true };
}
