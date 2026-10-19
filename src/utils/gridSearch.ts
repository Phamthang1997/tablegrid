/**
 * Quick search, shared by the two row grids (`DataGrid` and `SqlEditor`'s result grid).
 *
 * Pure, and in its own module for the reason `rowSelection.ts` and `copyAs.ts` are: the two grids
 * agree on nothing structurally (server paging vs client paging, PK-keyed vs object-keyed rows), so
 * what they share is pulled out as functions rather than merged into one component. "Does this row
 * match" and "where does the match sit" are also exactly the parts worth testing, and neither can
 * be tested through a grid.
 *
 * Matching ignores case AND diacritics, so `nguyen` finds `Nguyễn` — the app's own data is largely
 * Vietnamese and a search that demands the tone marks is a search nobody uses.
 */

/** Case- and diacritic-insensitive form. `null`/`undefined` become `''` so a NULL cell never matches. */
export function normalizeSearch(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Does any of `columnNames` hold the query in this row?
 *
 * `overrides` is the grid's buffered cell edits: a row the user has typed into must be searched by
 * what is ON SCREEN, not by what the database returned, or the row they just edited vanishes from
 * their own filter. `DataGrid` passes them; the result grid passes nothing.
 */
export function rowMatchesQuery(
  row: Record<string, unknown> | null | undefined,
  columnNames: string[],
  query: string,
  overrides: Record<string, unknown> = {},
): boolean {
  const trimmed = query.trim();
  if (!trimmed) return true;
  const q = normalizeSearch(trimmed);
  return columnNames.some((name) => {
    const cell = name in overrides ? overrides[name] : row?.[name];
    return normalizeSearch(cell).includes(q);
  });
}

/** The rows that match. Returns the SAME array when the query is empty, so an idle search costs no re-render downstream. */
export function filterRowsByQuery<T>(rows: T[], columnNames: string[], query: string): T[] {
  if (!query.trim()) return rows;
  return rows.filter((row) => rowMatchesQuery(row as Record<string, unknown>, columnNames, query));
}

/**
 * Where the first match sits **in the original string**, or null.
 *
 * The indices are the point of this function. Normalizing the haystack changes its LENGTH — NFD
 * splits `ễ` into a base letter plus a combining mark, which the strip then removes — so an index
 * found in the normalized text does not address the same character in the original, and slicing the
 * original with it cuts the highlight in the wrong place (further off with every diacritic before
 * it). The map is built per character so every normalized position knows which original character
 * produced it.
 */
export function findMatchRange(text: string, query: string): { start: number; end: number } | null {
  const q = normalizeSearch(query.trim());
  if (!q || !text) return null;

  let norm = '';
  const originIndex: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const piece = normalizeSearch(text[i]);
    for (let k = 0; k < piece.length; k++) {
      norm += piece[k];
      originIndex.push(i);
    }
  }

  const at = norm.indexOf(q);
  if (at === -1) return null;
  return { start: originIndex[at], end: originIndex[at + q.length - 1] + 1 };
}
