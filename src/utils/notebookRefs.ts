// A notebook SQL cell can use the result of an earlier cell: `:q1.id` is the `id` of the FIRST row
// cell `q1` returned, `:q1.id[]` is the whole column (for `IN (…)`). This module finds those
// references and turns them into the dialect's own placeholders plus a list of values, so the
// values are BOUND — never spliced into the SQL text.
//
// Why bound: a value from a result is data, and data turned into SQL text is how a customer name
// with an apostrophe (or worse) becomes part of the statement. It also keeps types: a bound 42 is
// a number, and a bound '0042' is still a string.
//
// Pure (no IPC, no React), so every rule below is pinned by tests.

import { maskCommentsAndStrings } from './queryParamHelper';

/** What a cell's last run produced, as far as a reference needs it. */
export interface CellResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** The rows were capped (see NOTEBOOK_ROW_CAP): a `[]` reference would silently miss rows. */
  truncated: boolean;
}

export interface CellRef {
  /** Offsets in the ORIGINAL text, end exclusive. */
  start: number;
  end: number;
  cell: string;
  column: string;
  /** `[]` — the whole column rather than the first row. */
  list: boolean;
}

/** Why a reference cannot be bound. The UI turns each one into a sentence. */
export type RefProblem =
  | { kind: 'unknownCell'; cell: string }
  | { kind: 'self'; cell: string }
  | { kind: 'notRun'; cell: string }
  | { kind: 'noRows'; cell: string }
  | { kind: 'noColumn'; cell: string; column: string }
  | { kind: 'listTruncated'; cell: string; column: string }
  | { kind: 'mixedParams' };

export type BindValue = string | number | boolean | null;

/**
 * `:cell.column` and `:cell.column[]`.
 *
 * The lookbehind keeps Postgres casts out (`x::int` — the second colon follows a colon) and a
 * word character out (`a:b.c` is not ours). Names are plain identifiers: a result column called
 * `order date` cannot be referenced, which is better than guessing where such a name ends.
 */
const REF_RE = /(?<![:\w]):([A-Za-z_]\w*)\.([A-Za-z_]\w*)(\[\])?/g;

/** References outside strings and comments, in source order. */
export function findCellRefs(sql: string): CellRef[] {
  const mask = maskCommentsAndStrings(sql);
  const out: CellRef[] = [];
  for (const m of mask.matchAll(REF_RE)) {
    const start = m.index!;
    // The mask blanks strings and comments with spaces, so a match in the mask is outside both;
    // still, read the names from the original text, which is what the user sees.
    const end = start + m[0].length;
    const text = sql.slice(start, end);
    const inner = /^:([A-Za-z_]\w*)\.([A-Za-z_]\w*)(\[\])?$/.exec(text);
    if (!inner) continue;
    out.push({ start, end, cell: inner[1], column: inner[2], list: !!inner[3] });
  }
  return out;
}

/** A result column by name: exact first, then case-insensitive (Postgres folds, MySQL keeps). */
function resolveColumn(result: CellResult, column: string): string | null {
  if (result.columns.includes(column)) return column;
  const lower = column.toLowerCase();
  return result.columns.find((c) => c.toLowerCase() === lower) ?? null;
}

/** A cell value as a bind parameter: JSON scalars pass through, anything else goes as JSON text. */
export function toBindValue(v: unknown): BindValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

/** Placeholders that this module did not write: mixing them with ours would misnumber both. */
function hasOwnPlaceholders(sql: string, dialect: string): boolean {
  const mask = maskCommentsAndStrings(sql);
  return dialect === 'postgres' ? /\$\d+/.test(mask) : /\?/.test(mask);
}

export interface BoundSql {
  sql: string;
  params: BindValue[];
  /** The cells this statement read from, for the "uses q1, q2" line. */
  uses: string[];
}

/**
 * Replaces every reference with placeholders and collects the values.
 *
 * `lookup(cell)` answers `undefined` for a name no cell has, `null` for a cell that exists but
 * has not run (or failed), and its result otherwise. `self` is the running cell's own name — a
 * cell reading its own previous result would make the output depend on how often it was run.
 *
 * An empty `[]` column becomes a single NULL: `IN (NULL)` matches nothing, which is what an empty
 * list means, where `IN ()` would be a syntax error.
 */
export function bindCellRefs(
  sql: string,
  dialect: string,
  lookup: (cell: string) => CellResult | null | undefined,
  self?: string,
): BoundSql | { problem: RefProblem } {
  const refs = findCellRefs(sql);
  if (refs.length === 0) return { sql, params: [], uses: [] };
  if (hasOwnPlaceholders(sql, dialect)) return { problem: { kind: 'mixedParams' } };

  const params: BindValue[] = [];
  const uses: string[] = [];
  const placeholder = () => {
    return dialect === 'postgres' ? `$${params.length}` : '?';
  };
  let out = '';
  let at = 0;
  for (const ref of refs) {
    if (self && ref.cell === self) return { problem: { kind: 'self', cell: ref.cell } };
    const result = lookup(ref.cell);
    if (result === undefined) return { problem: { kind: 'unknownCell', cell: ref.cell } };
    if (result === null) return { problem: { kind: 'notRun', cell: ref.cell } };
    const column = resolveColumn(result, ref.column);
    if (!column) return { problem: { kind: 'noColumn', cell: ref.cell, column: ref.column } };
    if (!uses.includes(ref.cell)) uses.push(ref.cell);

    out += sql.slice(at, ref.start);
    if (ref.list) {
      if (result.truncated) return { problem: { kind: 'listTruncated', cell: ref.cell, column: ref.column } };
      const values = result.rows.length ? result.rows.map((r) => toBindValue(r[column])) : [null];
      out += values
        .map((v) => {
          params.push(v);
          return placeholder();
        })
        .join(', ');
    } else {
      if (result.rows.length === 0) return { problem: { kind: 'noRows', cell: ref.cell } };
      params.push(toBindValue(result.rows[0][column]));
      out += placeholder();
    }
    at = ref.end;
  }
  out += sql.slice(at);
  return { sql: out, params, uses };
}
