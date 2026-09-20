/**
 * Settings shared by `sync` and `watch`: flags override config, config overrides env,
 * and anything invalid fails LOUDLY before a single API request is made (P4) — including a
 * misconfigured alert channel, because an alert that silently cannot be delivered is worse
 * than a refusal to start.
 */

import { type Config, ConfigError, loadConfig } from "../config.js";
import { parseDuration } from "../core/duration.js";
import { createNotifiers, type Notifier, type NotifierContext } from "../core/notify/index.js";

export interface RunOptions {
  token?: string;
  out?: string;
  git?: boolean;
  config?: string;
  rowBodies?: boolean;
  quiet?: boolean;
  root?: string[];
  /** Alert targets (repeatable); overrides `notify.on_error` from the config. */
  notify?: string[];
  interval?: string;
  s3Bucket?: string;
  s3Prefix?: string;
  s3Region?: string;
  s3Endpoint?: string;
  s3ForcePathStyle?: boolean;
}

export interface ResolvedSettings {
  config: Config;
  token: string;
  outDir: string;
  useGit: boolean;
  rowBodies: boolean;
  ignore: string[];
  redact: string[];
  s3Targets: Config["targets"];
  roots?: string[];
  quiet: boolean;
  intervalMs?: number;
  onError: Notifier[];
  onSuccess: Notifier[];
}

/** A shorter interval would hammer the Notion API (avg limit 3 req/s) for no benefit. */
export const MIN_INTERVAL_MS = 60_000;

export async function resolveSettings(
  opts: RunOptions,
  env: Record<string, string | undefined> = process.env,
  extra: { requireInterval?: boolean; notifierContext?: NotifierContext } = {},
): Promise<ResolvedSettings> {
  const config = await loadConfig(opts.config, env);

  const token = opts.token ?? config.token ?? env.VAULTWEAVE_TOKEN;
  if (!token) throw new ConfigError("No Notion token found. Set VAULTWEAVE_TOKEN or pass --token.");

  let intervalMs: number | undefined;
  const intervalText = opts.interval ?? config.interval;
  if (intervalText !== undefined) {
    try {
      intervalMs = parseDuration(intervalText);
    } catch (err) {
      throw new ConfigError((err as Error).message);
    }
    if (intervalMs < MIN_INTERVAL_MS) {
      throw new ConfigError(`Interval "${intervalText}" is too short — the minimum is 1m.`);
    }
  } else if (extra.requireInterval) {
    throw new ConfigError(
      '`watch` needs an interval: pass --interval (e.g. "6h") or set `interval:` in the config.',
    );
  }

  const onErrorTargets = opts.notify?.length ? opts.notify : config.notify.on_error;

  return {
    config,
    token,
    outDir: opts.out ?? config.out,
    useGit: opts.git ?? config.git ?? false,
    rowBodies: opts.rowBodies ?? true,
    ignore: config.ignore,
    redact: config.redact,
    s3Targets: opts.s3Bucket
      ? [
          {
            type: "s3",
            bucket: opts.s3Bucket,
            prefix: opts.s3Prefix ?? "",
            region: opts.s3Region,
            endpoint: opts.s3Endpoint,
            forcePathStyle: opts.s3ForcePathStyle ?? false,
          },
        ]
      : config.targets,
    roots: opts.root?.length ? opts.root : undefined,
    quiet: opts.quiet ?? false,
    intervalMs,
    onError: createNotifiers(onErrorTargets, extra.notifierContext),
    onSuccess: createNotifiers(config.notify.on_success, extra.notifierContext),
  };
}
