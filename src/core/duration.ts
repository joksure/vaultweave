const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Parses "30s" | "15m" | "6h" | "1d" into milliseconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+)([smhd])$/.exec(text.trim());
  if (!m) throw new RangeError(`Invalid duration "${text}" (expected e.g. 30m, 6h, 1d)`);
  const value = Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
  if (value <= 0) throw new RangeError(`Duration must be greater than zero: "${text}"`);
  return value;
}

/** Compact human form: 90_000 → "1m 30s", 21_600_000 → "6h". */
export function formatDuration(ms: number): string {
  let rest = Math.max(0, Math.round(ms / 1000));
  if (rest === 0) return "0s";
  const parts: string[] = [];
  for (const [label, size] of [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
    ["s", 1],
  ] as const) {
    const n = Math.floor(rest / size);
    if (n > 0) parts.push(`${n}${label}`);
    rest -= n * size;
  }
  return parts.join(" ");
}
