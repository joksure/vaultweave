import { describe, expect, it } from "vitest";
import {
  mapLimit,
  omit,
  plainText,
  stableStringify,
  stripQuery,
} from "../src/core/extractor/json.js";
import { collectAll } from "../src/core/extractor/paginate.js";

describe("stripQuery", () => {
  it("removes signatures and fragments", () => {
    expect(
      stripQuery("https://s3.example.com/a/b.png?X-Amz-Signature=abc&X-Amz-Expires=3600#x"),
    ).toBe("https://s3.example.com/a/b.png");
  });
  it("still strips when the URL is not parseable", () => {
    expect(stripQuery("not a url?secret=1")).toBe("not a url");
  });
});

describe("plainText / omit", () => {
  it("joins rich text and tolerates junk", () => {
    expect(plainText([{ plain_text: "a" }, { plain_text: "b" }, null, {}])).toBe("ab");
    expect(plainText(undefined)).toBe("");
  });
  it("omit drops only the named keys", () => {
    expect(omit({ a: 1, b: 2, request_id: "x" }, ["request_id"])).toEqual({ a: 1, b: 2 });
  });
});

describe("stableStringify", () => {
  it("sorts keys at every level, so insertion order never matters", () => {
    const a = stableStringify({ b: 1, a: { d: 1, c: [{ z: 1, y: 2 }] } });
    const b = stableStringify({ a: { c: [{ y: 2, z: 1 }], d: 1 }, b: 1 });
    expect(a).toBe(b);
    expect(a.indexOf('"a"')).toBeLessThan(a.indexOf('"b"'));
  });

  it("is valid JSON that round-trips, and ends with a newline", () => {
    const value = { s: 'line\nbreak "q"', n: [1, 2.5, null, true], o: { x: {} }, e: [] };
    const text = stableStringify(value, 2, 20);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(value);
  });

  it("keeps small values on one line and expands big ones", () => {
    expect(stableStringify({ a: 1, b: [1, 2] })).toBe('{ "a": 1, "b": [1, 2] }\n');
    const big = stableStringify({ text: "x".repeat(120), n: 1 });
    expect(big.split("\n").length).toBeGreaterThan(2);
  });
});

describe("collectAll", () => {
  const pages = (n: number) => async (cursor: string | undefined) => {
    const i = cursor ? Number(cursor) : 0;
    return { results: [i], has_more: i < n - 1, next_cursor: i < n - 1 ? String(i + 1) : null };
  };

  it("follows cursors to the end", async () => {
    expect(await collectAll(pages(4))).toEqual([0, 1, 2, 3]);
  });

  it("refuses to silently truncate when a cursor is missing", async () => {
    await expect(
      collectAll(async () => ({ results: [1], has_more: true, next_cursor: null })),
    ).rejects.toThrow(/next_cursor is empty/);
  });

  it("refuses to loop on a repeated cursor", async () => {
    await expect(
      collectAll(async () => ({ results: [1], has_more: true, next_cursor: "same" })),
    ).rejects.toThrow(/cursor repeated/);
  });
});

describe("mapLimit", () => {
  it("keeps input order and never exceeds the limit", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it("waits for in-flight work, then rethrows", async () => {
    let finished = 0;
    await expect(
      mapLimit([1, 2, 3], 3, async (n) => {
        await new Promise((r) => setTimeout(r, n * 5));
        if (n === 1) throw new Error("boom");
        finished++;
      }),
    ).rejects.toThrow("boom");
    expect(finished).toBe(2);
  });

  it("handles an empty list", async () => {
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  });
});
