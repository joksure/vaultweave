/**
 * Secret scrubbing for anything that leaves the machine or lands in a log line.
 *
 * Notion tokens and webhook URLs are credentials. Error messages are free text that can
 * echo them back, so every outbound message passes through `scrubSecrets`.
 */

const NOTION_TOKEN = /\b(?:secret_|ntn_)[A-Za-z0-9]{16,}\b/g;
const SMTP_CREDENTIAL = /((?:smtp(?:s)?|smtps?):\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;
const MIN_SECRET_LENGTH = 6;

export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join("***");
  }
  return out.replace(SMTP_CREDENTIAL, "$1***:***@").replace(NOTION_TOKEN, "***");
}
