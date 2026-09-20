/**
 * Commands that exist in the CLI surface but are not built yet fail loudly
 * (exit code 2) instead of pretending to succeed — see design principle P4.
 */
export function notImplemented(command: string, milestone: string): void {
  process.stderr.write(
    `vaultweave ${command}: not implemented yet (planned for ${milestone}).\n` +
      "See CAPABILITIES.md and docs/architecture.md for the roadmap.\n",
  );
  process.exitCode = 2;
}
