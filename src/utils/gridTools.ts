/**
 * Pure helpers behind the grids' context-menu tools: column statistics, the transposed row view
 * and the value editor's JSON/size handling. Shared by `DataGrid` and `SqlEditor`'s result grid
 * for the same reason `copyAs.ts` and `rowSelection.ts` are — the two grids disagree on where rows
 * come from, but not on what a column's sum is. No React, no Tauri, so it is unit-tested.
 */

/**
 * A cell as text, or `null` for SQL NULL. Objects (a JSON column decoded by the backend) go
 * through `JSON.stringify` rather than `String`, which would turn every one into
 * `[object Object]` — equal to each other for `distinct`, and useless in the value editor.
 */
export function cellText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

// A plain decimal literal. Deliberately narrower than `Number()`, which also accepts '', ' ',
// '0x1F', 'Infinity' and '1e400' — a hex-looking code or a blank string is not a number to sum.
const NUMERIC_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

export interface NumericStats {
  sum: number;
  avg: number;
  min: number;
  max: number;
  /**
   * True when at least one value could not be represented exactly as a double: an integer past
   * 2^53 (BIGINT ids) or a decimal with more than 15 significant digits (sqlx ships DECIMAL as a
   * string). The numbers are still shown, but marked approximate rather than presented as exact.
   */
  approximate: boolean;
}

export interface ColumnStats {
  /** Rows in scope, NULLs included. */
  count: number;
  nulls: number;
  /** Empty strings — counted apart from NULL, since the two mean different things in SQL. */
  empty: number;
  /** Distinct non-NULL values, compared as text. */
  distinct: number;
  /** Present only when every non-NULL, non-empty value is numeric and there is at least one. */
  numeric: NumericStats | null;
  /** Smallest / largest non-NULL value in text order — meaningful for ISO dates and names. */
  minText: string | null;
  maxText: string | null;
  minLength: number | null;
  maxLength: number | null;
}

function significantDigits(s: string): number {
  const mantissa = s.replace(/^[-+]/, '').split(/[eE]/)[0].replace('.', '');
  return mantissa.replace(/^0+/, '').length;
}

export function computeColumnStats(values: readonly unknown[]): ColumnStats {
  let nulls = 0;
  let empty = 0;
  const seen = new Set<string>();
  let minText: string | null = null;
  let maxText: string | null = null;
  let minLength: number | null = null;
  let maxLength: number | null = null;

  let allNumeric = true;
  let numCount = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let approximate = false;

  for (const v of values) {
    const text = cellText(v);
    if (text === null) {
      nulls++;
      continue;
    }
    seen.add(text);
    if (minText === null || text < minText) minText = text;
    if (maxText === null || text > maxText) maxText = text;
    if (minLength === null || text.length < minLength) minLength = text.length;
    if (maxLength === null || text.length > maxLength) maxLength = text.length;
    if (text === '') {
      empty++;
      continue;
    }
    if (!allNumeric) continue;

    let n: number;
    if (typeof v === 'number') {
      n = v;
      if (!Number.isFinite(n)) {
        allNumeric = false;
        continue;
      }
      if (Number.isInteger(n) && !Number.isSafeInteger(n)) approximate = true;
    } else if (typeof v === 'bigint') {
      n = Number(v);
      if (!Number.isSafeInteger(n)) approximate = true;
    } else if (typeof v === 'string' && NUMERIC_RE.test(v.trim())) {
      const s = v.trim();
      n = Number(s);
      if (!Number.isFinite(n)) {
        allNumeric = false;
        continue;
      }
      if (significantDigits(s) > 15) approximate = true;
    } else {
      allNumeric = false;
      continue;
    }
    numCount++;
    sum += n;
    if (n < min) min = n;
    if (n > max) max = n;
  }

  const numeric: NumericStats | null =
    allNumeric && numCount > 0
      ? { sum, avg: sum / numCount, min, max, approximate }
      : null;

  return {
    count: values.length,
    nulls,
    empty,
    distinct: seen.size,
    numeric,
    minText,
    maxText,
    minLength,
    maxLength,
  };
}

export interface TransposedField {
  column: string;
  values: unknown[];
  /** True when there are several rows and they do not all hold the same value here. */
  differs: boolean;
}

/** Rows turned into one entry per column, which is what makes comparing a few rows readable. */
export function transposeRows(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): TransposedField[] {
  return columns.map((column) => {
    const values = rows.map((r) => r[column]);
    const first = cellText(values[0]);
    const differs = values.length > 1 && values.some((v) => cellText(v) !== first);
    return { column, values, differs };
  });
}

/** The transposed view as TSV: `headers` is the first line (e.g. "column", "row 1", …). */
export function buildTransposedTsv(headers: readonly string[], fields: readonly TransposedField[]): string {
  const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ');
  const lines = [headers.map(clean).join('\t')];
  for (const f of fields) {
    lines.push([f.column, ...f.values.map((v) => cellText(v) ?? '')].map(clean).join('\t'));
  }
  return lines.join('\n');
}

/**
 * The text pretty-printed as JSON, or `null` when it is not a JSON object/array. Scalars are
 * refused on purpose: `123` and `"x"` are valid JSON, and offering "Format JSON" on every number
 * cell would be noise.
 */
export function tryFormatJson(text: string, indent: number | 0 = 2): string | null {
  const s = text.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return null;
  try {
    return JSON.stringify(JSON.parse(s), null, indent || undefined);
  } catch {
    return null;
  }
}

export interface TextMetrics {
  chars: number;
  lines: number;
  bytes: number;
}

export function textMetrics(text: string): TextMetrics {
  return {
    chars: text.length,
    lines: text === '' ? 0 : text.split('\n').length,
    bytes: new TextEncoder().encode(text).length,
  };
}
