import { Client } from "@notionhq/client";
import type { Command } from "commander";
import { ConfigError, loadConfig } from "../config.js";
import { formatDoctorReport, type NotionLike, runDoctor } from "../core/doctor.js";
import { parseDuration } from "../core/duration.js";

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description(
      "Check Node, token (reachability + content access), last run freshness, git and assets",
    )
    .option("--token <token>", "Notion integration token (prefer the VAULTWEAVE_TOKEN env var)")
    .option("--config <path>", "path to .vaultweave.yaml")
    .option("--out <dir>", "backup directory to inspect (default: config `out`)")
    .option("--git", "also verify git is ready for `--git` syncs")
    .option("--probe-rate-limit", "send a short request burst and look for HTTP 429s")
    .option(
      "--deep",
      "slower: walk the whole workspace to find backed-up pages that are no longer reachable, " +
        "and scan the output for missing assets",
    )
    .option("--json", "machine-readable output (attach this to bug reports)")
    .action(
      async (opts: {
        token?: string;
        config?: string;
        out?: string;
        git?: boolean;
        probeRateLimit?: boolean;
        deep?: boolean;
        json?: boolean;
      }) => {
        let token = opts.token ?? process.env.VAULTWEAVE_TOKEN;
        let outDir = opts.out;
        let useGit = opts.git;
        let intervalMs: number | undefined;
        try {
          const config = await loadConfig(opts.config);
          token = opts.token ?? config.token ?? token;
          outDir ??= config.out;
          useGit ??= config.git;
          if (config.interval) intervalMs = parseDuration(config.interval);
        } catch (err) {
          if (!(err instanceof ConfigError)) throw err;
          // A broken config is itself a finding; VAULTWEAVE_TOKEN alone can still be checked.
          process.stderr.write(`⚠ ${err.message}\n`);
        }

        const client = token ? (new Client({ auth: token }) as unknown as NotionLike) : undefined;
        const report = await runDoctor({
          hasToken: Boolean(token),
          client,
          probeRateLimit: opts.probeRateLimit,
          outDir,
          useGit,
          intervalMs,
          deep: opts.deep,
        });

        process.stdout.write(
          `${opts.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report)}\n`,
        );
        process.exitCode = report.ok ? 0 : 1;
      },
    );
}
