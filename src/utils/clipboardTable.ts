/**
 * Reading a table off the clipboard, for the grid's Ctrl+V.
 *
 * What lands there is TAB-separated: the grid's own Ctrl+C writes it (`buildTsv` in `copyAs.ts`),
 * and so do Excel, Google Sheets and LibreOffice. Pure and DOM-free, so the rules below are tested.
 */

/** Rows pasted at once, at most. Past this the Import dialog is the right tool. */
export const PASTE_ROW_LIMIT = 5000;

/**
 * Splits TSV into rows of cells.
 *
 * Spreadsheets wrap a cell in quotes when it holds a tab, a line break or a quote (`""` inside).
 * A field is read as quoted only when it is well formed AND the quoting was needed — its content
 * carries one of those characters. Otherwise the quotes are data: the grid's own copy never quotes,
 * so a value that is literally `"x"` comes back as `"x"`, not as `x`.
 *
 * One trailing line break (spreadsheets add it) does not make an empty last row.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const n = text.length;

  while (i <= n) {
    const quoted = text[i] === '"' ? readQuoted(text, i) : null;
    let value: string;
    if (quoted) {
      value = quoted.value;
      i = quoted.end;
    } else {
      let j = i;
      while (j < n && text[j] !== '\t' && text[j] !== '\n' && text[j] !== '\r') j++;
      value = text.slice(i, j);
      i = j;
    }
    row.push(value);

    if (i >= n) {
      rows.push(row);
      break;
    }
    if (text[i] === '\t') {
      i++;
      continue;
    }
    // A line break: \r\n, \n or a lone \r.
    i += text[i] === '\r' && text[i + 1] === '\n' ? 2 : 1;
    rows.push(row);
    row = [];
    if (i >= n) break;
  }

  return rows;
}

/** A quoted field starting at `start`, or null when it is not one (see `parseTsv`). */
function readQuoted(text: string, start: number): { value: string; end: number } | null {
  let value = '';
  let i = start + 1;
  let needed = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      if (text[i + 1] === '"') {
        value += '"';
        needed = true;
        i += 2;
        continue;
      }
      const after = text[i + 1];
      const closes = after === undefined || after === '\t' || after === '\n' || after === '\r';
      return closes && needed ? { value, end: i + 1 } : null;
    }
    if (ch === '\t' || ch === '\n' || ch === '\r') needed = true;
    value += ch;
    i++;
  }
  return null;
}

export type PastePlan =
  | { ok: true; header: boolean; rows: Record<string, string>[] }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'tooWide'; width: number; columns: number }
  | { ok: false; reason: 'tooMany'; rows: number; limit: number };

/**
 * Maps parsed cells onto the grid's columns.
 *
 * A first row whose every cell names a column (case-insensitively, each once) is a HEADER — what
 * the context menu's "Copy as TSV" writes — and the cells are mapped by name, so a paste does not
 * depend on the columns being in the same order. Without one they are mapped by POSITION onto
 * `columns`, which the caller passes in on-screen order: that is the order Ctrl+C wrote them in.
 *
 * A row wider than the columns is refused rather than truncated, since it almost always means the
 * clipboard holds another table's rows and every value would land a column off.
 */
export function planPaste(grid: string[][], columns: readonly string[]): PastePlan {
  const lines = grid.filter((cells) => cells.some((c) => c !== ''));
  if (lines.length === 0) return { ok: false, reason: 'empty' };

  const byLower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  const first = lines[0];
  const named = first.map((c) => byLower.get(c.trim().toLowerCase()));
  const header =
    named.every((c) => c !== undefined) && new Set(named).size === named.length;

  const target = header ? (named as string[]) : columns;
  const body = header ? lines.slice(1) : lines;
  if (body.length === 0) return { ok: false, reason: 'empty' };
  if (body.length > PASTE_ROW_LIMIT) {
    return { ok: false, reason: 'tooMany', rows: body.length, limit: PASTE_ROW_LIMIT };
  }

  const width = Math.max(...body.map((cells) => cells.length));
  if (width > target.length) {
    return { ok: false, reason: 'tooWide', width, columns: target.length };
  }

  const rows = body.map((cells) => {
    const out: Record<string, string> = {};
    cells.forEach((value, idx) => {
      out[target[idx]] = value;
    });
    return out;
  });
  return { ok: true, header, rows };
}
