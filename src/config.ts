import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const CONFIG_FILENAME = ".sheaf.yaml";

export class ConfigError extends Error {
  override name = "ConfigError";
}

const notifyTarget = z
  .string()
  .regex(/^(silent|[a-z]+:.+)$/, 'expected "silent" or "<kind>:<target>", e.g. webhook:https://…');

/** One target, or several (e.g. Slack for the team plus a generic webhook for a pager). */
const notifyTargets = z.union([notifyTarget, z.array(notifyTarget)]);

const s3Target = z.object({
  bucket: z.string().min(1),
  prefix: z.string().default(""),
  region: z.string().min(1).optional(),
  endpoint: z.string().url().optional(),
  forcePathStyle: z.boolean().default(false),
});
const targetConfig = z.discriminatedUnion("type", [s3Target.extend({ type: z.literal("s3") })]);

/** Accept both the normalized list form and the friendlier `targets.s3` YAML form. */
const targetConfigs = z.preprocess((value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.s3 !== undefined) {
      return [{ ...(record.s3 as Record<string, unknown>), type: "s3" }];
    }
  }
  return value;
}, z.array(targetConfig).default([]));

export const ConfigSchema = z
  .object({
    token: z.string().min(1).optional(),
    out: z.string().min(1).default("./sheaf-backup"),
    git: z.boolean().default(false),
    interval: z
      .string()
      .regex(/^\d+[smhd]$/, 'expected a duration like "30m", "6h" or "1d"')
      .optional(),
    ignore: z.array(z.string()).default([]),
    redact: z
      .array(
        z.string().refine(
          (src) => {
            try {
              new RegExp(src);
              return true;
            } catch {
              return false;
            }
          },
          { message: "not a valid regular expression" },
        ),
      )
      .default([]),
    targets: targetConfigs,
    notify: z
      .object({
        on_error: notifyTargets.optional(),
        on_success: notifyTargets.default("silent"),
      })
      .default({ on_success: "silent" }),
  })
  // Unknown keys are almost always typos; failing loudly beats silently ignoring (P4).
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

type Env = Record<string, string | undefined>;

/**
 * Expands ${VAR} and ${VAR:-default}. A missing variable without a default is an
 * error — an empty webhook URL or token must never slip through silently.
 */
export function expandEnv(value: string, env: Env): string {
  const missing: string[] = [];
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, dflt) => {
    const v = env[name as string];
    if (v !== undefined && v !== "") return v;
    if (dflt !== undefined) return dflt as string;
    missing.push(name as string);
    return "";
  });
  if (missing.length > 0) {
    throw new ConfigError(`Environment variable(s) not set: ${[...new Set(missing)].join(", ")}`);
  }
  return out;
}

function expandDeep(node: unknown, env: Env): unknown {
  if (typeof node === "string") return expandEnv(node, env);
  if (Array.isArray(node)) return node.map((n) => expandDeep(n, env));
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, expandDeep(v, env)]));
  }
  return node;
}

export function parseConfig(yamlText: string, env: Env = process.env): Config {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText) ?? {};
  } catch (err) {
    throw new ConfigError(`Invalid YAML: ${(err as Error).message}`);
  }
  const result = ConfigSchema.safeParse(expandDeep(raw, env));
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid configuration:\n${details}`);
  }
  return result.data;
}

/** Loads `path` (or ./.sheaf.yaml). A missing default file yields defaults. */
export async function loadConfig(path?: string, env: Env = process.env): Promise<Config> {
  const file = path ?? CONFIG_FILENAME;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && path === undefined) {
      return ConfigSchema.parse({});
    }
    throw new ConfigError(`Cannot read config file "${file}": ${(err as Error).message}`);
  }
  return parseConfig(text, env);
}
