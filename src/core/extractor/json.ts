export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Concatenated `plain_text` of a Notion rich-text array. */
export function plainText(rich: unknown): string {
  if (!Array.isArray(rich)) return "";
  return rich
    .map((r) => (isObject(r) && typeof r.plain_text === "string" ? r.plain_text : ""))
    .join("");
}

/** Drops query string and fragment — signed-URL parameters must never be persisted. */
export function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

/** Shallow copy without the listed keys. */
export function omit<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (!keys.includes(k)) out[k] = v;
  return out as T;
}

/**
 * JSON with recursively sorted object keys and a trailing newline, so files are byte-stable
 * across runs. Small objects/arrays are kept on one line (<= `width` chars) so that big
 * exports stay compact and Git diffs stay readable; larger ones are indented.
 */
export function stableStringify(value: unknown, indent = 2, width = 100): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (isObject(v)) {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort(v[k])]),
      );
    }
    return v;
  };
  const flatten = (v: unknown): string => {
    if (Array.isArray(v)) return v.length === 0 ? "[]" : `[${v.map(flatten).join(", ")}]`;
    if (isObject(v)) {
      const entries = Object.entries(v).filter(([, x]) => x !== undefined);
      if (entries.length === 0) return "{}";
      return `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${flatten(x)}`).join(", ")} }`;
    }
    return JSON.stringify(v) ?? "null";
  };
  const render = (v: unknown, level: number): string => {
    const flat = flatten(v);
    const isContainer = Array.isArray(v) || isObject(v);
    if (!isContainer || flat.length + level * indent <= width) return flat;
    const pad = " ".repeat((level + 1) * indent);
    const end = " ".repeat(level * indent);
    if (Array.isArray(v)) {
      return v.length === 0
        ? "[]"
        : `[\n${v.map((x) => pad + render(x, level + 1)).join(",\n")}\n${end}]`;
    }
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    return `{\n${entries.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${render(x, level + 1)}`).join(",\n")}\n${end}}`;
  };
  return `${render(sort(value), 0)}\n`;
}

/** Runs `fn` over `items` with bounded concurrency; results keep input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;
  return results;
}
