/** `vaultweave backup` — friendly one-shot backup entry point. */
import type { Command } from "commander";
import { runSyncCommand, type SyncCommandOptions } from "./sync.js";

/**
 * Backup intentionally reuses the sync implementation. It is a one-shot command,
 * but keeps the configured incremental cursor and Git policy; advanced flags stay
 * on `sync` while first-time users get a smaller surface.
 */
export async function runBackupCommand(
  opts: SyncCommandOptions,
  env: Record<string, string | undefined> = process.env,
  deps = {},
): Promise<number> {
  return runSyncCommand(opts, env, deps);
}

export function registerBackup(program: Command): void {
  program
    .command("backup")
    .description("Back up a Notion workspace once (use sync for advanced options)")
    .option("--token <token>", "Notion integration token (prefer VAULTWEAVE_TOKEN env var)")
    .option("--out <dir>", "output directory (default: config `out` or ./vaultweave-backup)")
    .option("--config <path>", "path to .vaultweave.yaml")
    .option("--quiet", "suppress progress output")
    .option("--json", "print the run report as JSON")
    .action(async (opts: SyncCommandOptions) => {
      process.exitCode = await runBackupCommand(opts);
    });
}
