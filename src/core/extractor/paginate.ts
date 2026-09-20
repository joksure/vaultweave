export interface PageOf<T> {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * Follows `next_cursor` until exhausted. Throws on a response that claims more data but
 * gives no usable cursor (or repeats one) — silently truncating a backup is worse than failing.
 */
export async function collectAll<T>(
  fetchPage: (cursor: string | undefined) => Promise<PageOf<T>>,
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    all.push(...page.results);
    if (!page.has_more) return all;
    if (!page.next_cursor)
      throw new Error("Pagination error: has_more is true but next_cursor is empty");
    if (seen.has(page.next_cursor))
      throw new Error("Pagination error: cursor repeated (would loop forever)");
    seen.add(page.next_cursor);
    cursor = page.next_cursor;
  }
}
