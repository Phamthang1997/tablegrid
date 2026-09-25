// Importing a CSV / Excel / JSON file into an EXISTING table: parsing, column mapping and value
// conversion. Pure — no DOM, no Tauri — so every rule here is unit-tested (`tableImport.test.ts`);
// the dialog (`ImportTableDataDialog.tsx`) only draws it and the backend
// (`database/commands/table_import.rs`) only writes what comes out of it.
//
// What the old import did instead, and why each part below exists:
// - the file's header names WERE the INSERT column list, so a header spelled differently from the
//   column, or an extra column, failed the whole import at the database → `autoMap` + a mapping the
//   user can change;
// - every CSV value went in as a string and an empty cell was always NULL, with conversion left to
//   whatever the database's implicit casts made of it → `coerceCell`, driven by the column's type;
// - nothing said which rows would fail before writing → `validateRows` is a dry run of the whole file.
//
// Errors are returned as keys (`CellIssue`), not text: this module has no `t()`.

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type Delimiter = ',' | ';' | '\t' | '|';
export const DELIMITERS: Delimiter[] = [',', ';', '\t', '|'];

/**
 * The delimiter a CSV-ish text uses: the candidate that splits the first lines into the same number
 * of fields, most often. Quoted fields are skipped, so `"a,b";c` counts one `;` and no `,`. A file
 * that fits none (a single column) gets `,`.
 */
export function detectDelimiter(text: string): Delimiter {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 20);
  let best: Delimiter = ',';
  let bestScore = 0;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    if (counts.length === 0 || counts[0] === 0) continue;
    // Lines whose count matches the first line's — a real delimiter is consistent across rows.
    const consistent = counts.filter((c) => c === counts[0]).length;
    const score = consistent * 1000 + counts[0];
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === d && !quoted) n++;
  }
  return n;
}

/**
 * RFC 4180 CSV: fields may be quoted, `""` inside quotes is one `"`, and a quoted field may hold the
 * delimiter or a line break. Unlike the parser it replaces, nothing is trimmed and a tab is not a
 * delimiter unless it was chosen — `"a, b"` and a value that is meant to start with a space survive.
 * CRLF, LF and lone CR all end a record. A leading BOM is dropped.
 */
export function parseDelimited(text: string, delimiter: Delimiter): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
    } else if (ch === delimiter) {
      endField();
      i++;
    } else if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  // The last record, unless the file ended right after a line break.
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

export interface SourceTable {
  headers: string[];
  rows: unknown[][];
}

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/**
 * A grid of cells → headers + data rows. With `hasHeader` the first row names the columns (a blank
 * name becomes "Column N", and a repeated one "name (2)" so every source column can be picked);
 * without it they are "Column 1…N". Rows that are entirely blank are dropped — a trailing empty
 * line in a CSV, or a formatted-but-empty row in Excel, is not a row anyone meant to import.
 */
export function toSourceTable(matrix: unknown[][], hasHeader: boolean): SourceTable {
  const width = matrix.reduce((w, r) => Math.max(w, r.length), 0);
  const dataStart = hasHeader ? 1 : 0;
  const raw = hasHeader ? (matrix[0] ?? []) : [];
  const seen = new Map<string, number>();
  const headers = Array.from({ length: width }, (_, i) => {
    const base = !hasHeader || isBlank(raw[i]) ? `Column ${i + 1}` : String(raw[i]).trim();
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
  const rows: unknown[][] = [];
  for (let r = dataStart; r < matrix.length; r++) {
    const row = matrix[r] ?? [];
    if (row.every(isBlank)) continue;
    rows.push(Array.from({ length: width }, (_, i) => row[i] ?? null));
  }
  return { headers, rows };
}

/** A JSON array of objects → the same grid shape, keys in order of first appearance as the header. */
export function jsonToMatrix(data: unknown): unknown[][] {
  const list = Array.isArray(data) ? data : [data];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const obj of list) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const k of Object.keys(obj)) {
        if (!seen.has(k)) {
          seen.add(k);
          keys.push(k);
        }
      }
    }
  }
  return [keys, ...list.map((o: any) => keys.map((k) => (o && typeof o === 'object' ? (o[k] ?? null) : null)))];
}

// ---------------------------------------------------------------------------
// Target columns and mapping
// ---------------------------------------------------------------------------

export type TypeFamily =
  | 'integer'
  | 'decimal'
  | 'float'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'time'
  | 'json'
  | 'uuid'
  | 'text'
  | 'other';

/** The kind of value a column holds, from its SQL type as `get_table_schema` reports it. */
export function typeFamily(type: string): TypeFamily {
  const ty = type.toLowerCase().trim();
  // MySQL spells BOOLEAN as tinyint(1).
  if (/^(bool|boolean)\b/.test(ty) || /^tinyint\(1\)/.test(ty) || ty === 'bit(1)') return 'boolean';
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|int2|int4|int8|serial|bigserial|smallserial)\b/.test(ty)) return 'integer';
  if (/^(decimal|numeric|money|dec)\b/.test(ty)) return 'decimal';
  if (/^(real|float|double|float4|float8)\b/.test(ty)) return 'float';
  if (/^(timestamp|datetime)\b/.test(ty)) return 'datetime';
  if (/^date\b/.test(ty)) return 'date';
  if (/^time\b/.test(ty)) return 'time';
  if (/^jsonb?\b/.test(ty)) return 'json';
  if (/^uuid\b/.test(ty)) return 'uuid';
  if (/(char|text|string|clob|enum|set\()/.test(ty) || ty === '') return 'text';
  return 'other';
}

/** The declared maximum length of a character column, or null (`varchar(50)` → 50). */
export function maxLengthOf(type: string): number | null {
  const m = /^\s*(?:var)?char(?:acter)?(?:\s+varying)?\s*\(\s*(\d+)\s*\)|^\s*n?varchar\s*\(\s*(\d+)\s*\)/i.exec(type);
  const n = m ? Number(m[1] ?? m[2]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface TargetColumn {
  name: string;
  type: string;
  nullable: boolean;
  /** Has a DEFAULT or is filled by the database (auto-increment / identity). */
  hasDefault: boolean;
  /** Computed by the database — never writable, so never offered for mapping. */
  generated?: boolean;
}

/** Lower-case letters and digits only, so `First Name`, `first_name` and `FIRSTNAME` meet. */
const normalize = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/**
 * A first guess at which source column feeds each target column: an exact name, then the same name
 * ignoring case, spaces and underscores. Each source column is used at most once, and a target with
 * no match maps to nothing (`null`) — left out of the INSERT, so it gets its default.
 */
export function autoMap(headers: string[], targets: TargetColumn[]): (number | null)[] {
  const used = new Set<number>();
  const pick = (pred: (h: string) => boolean) => {
    const i = headers.findIndex((h, idx) => !used.has(idx) && pred(h));
    if (i >= 0) used.add(i);
    return i >= 0 ? i : null;
  };
  const exact = targets.map((col) => (col.generated ? null : pick((h) => h === col.name)));
  return targets.map((col, ti) => {
    if (col.generated) return null;
    if (exact[ti] !== null) return exact[ti];
    const want = normalize(col.name);
    return want ? pick((h) => normalize(h) === want) : null;
  });
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export type CellIssue =
  | 'required'
  | 'notInteger'
  | 'notNumber'
  | 'notBoolean'
  | 'notDate'
  | 'notDateTime'
  | 'notTime'
  | 'notJson'
  | 'notUuid'
  | 'tooLong';

export interface CoerceOptions {
  /** What an empty cell means in a TEXT column. Every other type reads an empty cell as NULL. */
  emptyAs: 'null' | 'empty';
  /** Trim spaces around every value (not inside quotes' meaning — just leading/trailing blanks). */
  trim: boolean;
}

export type CellValue = string | number | boolean | null;
export type Coerced = { ok: true; value: CellValue } | { ok: false; issue: CellIssue };

const TRUE_WORDS = new Set(['true', 't', 'yes', 'y', '1', 'on']);
const FALSE_WORDS = new Set(['false', 'f', 'no', 'n', '0', 'off']);

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * One source cell as the value to bind for a target column, or why it cannot be.
 *
 * Numbers that must stay exact travel as STRINGS: a DECIMAL (`0.1 + 0.2` has no exact double), and
 * an integer beyond 2^53. The backend binds them as text and — on Postgres — casts to the column's
 * type, so nothing is rounded on the way. Dates are only accepted in ISO order (`2026-09-25`):
 * `03/04/2026` is April or March depending on who wrote it, and guessing is how a whole column of
 * dates goes in silently wrong.
 */
export function coerceCell(raw: unknown, col: TargetColumn, opts: CoerceOptions): Coerced {
  const family = typeFamily(col.type);
  let v: unknown = raw;
  if (typeof v === 'string' && opts.trim) v = v.trim();

  const empty = v === null || v === undefined || v === '';
  if (empty) {
    if (family === 'text' && v === '' && opts.emptyAs === 'empty') return { ok: true, value: '' };
    // An explicit NULL into a NOT NULL column fails even when the column has a default — the
    // default only applies to a column left OUT of the INSERT. So it is flagged either way.
    return col.nullable ? { ok: true, value: null } : { ok: false, issue: 'required' };
  }

  switch (family) {
    case 'integer': {
      if (typeof v === 'number') return Number.isInteger(v) ? { ok: true, value: v } : { ok: false, issue: 'notInteger' };
      if (typeof v === 'boolean') return { ok: true, value: v ? 1 : 0 };
      const s = String(v);
      if (!/^[+-]?\d+$/.test(s)) return { ok: false, issue: 'notInteger' };
      const n = Number(s);
      return { ok: true, value: Number.isSafeInteger(n) ? n : s.replace(/^\+/, '') };
    }
    case 'decimal': {
      const s = typeof v === 'number' ? String(v) : String(v);
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return { ok: false, issue: 'notNumber' };
      return { ok: true, value: s.replace(/^\+/, '') };
    }
    case 'float': {
      if (typeof v === 'number') return { ok: true, value: v };
      const s = String(v);
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return { ok: false, issue: 'notNumber' };
      return { ok: true, value: Number(s) };
    }
    case 'boolean': {
      if (typeof v === 'boolean') return { ok: true, value: v };
      const s = String(v).toLowerCase();
      if (TRUE_WORDS.has(s)) return { ok: true, value: true };
      if (FALSE_WORDS.has(s)) return { ok: true, value: false };
      return { ok: false, issue: 'notBoolean' };
    }
    case 'date': {
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]00:00(?::00(?:\.0+)?)?)?$/.exec(String(v));
      if (!m || !validDate(+m[1], +m[2], +m[3])) return { ok: false, issue: 'notDate' };
      return { ok: true, value: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` };
    }
    case 'datetime': {
      const s = String(v);
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(s);
      if (!m || !validDate(+m[1], +m[2], +m[3])) return { ok: false, issue: 'notDateTime' };
      if (m[4] !== undefined && (+m[4] > 23 || +m[5] > 59 || (m[6] !== undefined && +m[6] > 59))) {
        return { ok: false, issue: 'notDateTime' };
      }
      return { ok: true, value: s };
    }
    case 'time': {
      const s = String(v);
      const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(s);
      if (!m || +m[1] > 23 || +m[2] > 59 || (m[3] !== undefined && +m[3] > 59)) return { ok: false, issue: 'notTime' };
      return { ok: true, value: s };
    }
    case 'json': {
      if (typeof v === 'object') return { ok: true, value: JSON.stringify(v) };
      const s = String(v);
      try {
        JSON.parse(s);
      } catch {
        return { ok: false, issue: 'notJson' };
      }
      return { ok: true, value: s };
    }
    case 'uuid': {
      const s = String(v);
      if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s)) return { ok: false, issue: 'notUuid' };
      return { ok: true, value: s };
    }
    case 'text': {
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      const max = maxLengthOf(col.type);
      // Counted in code points, as the database counts characters — not UTF-16 units.
      if (max !== null && [...s].length > max) return { ok: false, issue: 'tooLong' };
      return { ok: true, value: s };
    }
    default:
      // A type this module does not model (blob, geometry, an array, a domain): passed through as
      // text for the database to judge, rather than refused by a rule that might be wrong.
      return { ok: true, value: typeof v === 'object' ? JSON.stringify(v) : (v as CellValue) };
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface RowIssue {
  /** 0-based index into `SourceTable.rows`. */
  index: number;
  column: string;
  issue: CellIssue;
  /** The cell as it was in the file, shortened for display. */
  value: string;
}

export interface BuiltRows {
  /** The mapped target columns, in the order of every row's values. */
  columns: string[];
  /** One entry per row that converted cleanly. */
  rows: CellValue[][];
  /** For each entry of `rows`, its index into `SourceTable.rows` — how a failure is reported back. */
  indexes: number[];
  /** Every problem found, in file order. A row with several bad cells appears once per cell. */
  issues: RowIssue[];
  /** Rows with at least one problem. */
  badRows: number;
}

const display = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
};

/**
 * Converts rows `[from, to)` of the source through the mapping. `mapping[i]` is the source column
 * index for `targets[i]`, or null to leave that target out.
 *
 * `issueLimit` caps how many problems are KEPT (they are all counted in `badRows`): a dry run over
 * a million-row file with one wrong column would otherwise build a million issue objects.
 */
export function buildRows(
  source: SourceTable,
  targets: TargetColumn[],
  mapping: (number | null)[],
  opts: CoerceOptions,
  from = 0,
  to = source.rows.length,
  issueLimit = Infinity,
): BuiltRows {
  const mapped = targets
    .map((col, i) => ({ col, src: mapping[i] }))
    .filter((m): m is { col: TargetColumn; src: number } => m.src !== null && m.src !== undefined && !m.col.generated);
  const out: BuiltRows = { columns: mapped.map((m) => m.col.name), rows: [], indexes: [], issues: [], badRows: 0 };
  for (let r = from; r < Math.min(to, source.rows.length); r++) {
    const row = source.rows[r];
    const values: CellValue[] = [];
    let bad = false;
    for (const m of mapped) {
      const res = coerceCell(row[m.src], m.col, opts);
      if (res.ok) values.push(res.value);
      else {
        bad = true;
        if (out.issues.length < issueLimit) {
          out.issues.push({ index: r, column: m.col.name, issue: res.issue, value: display(row[m.src]) });
        }
      }
    }
    if (bad) out.badRows++;
    else {
      out.rows.push(values);
      out.indexes.push(r);
    }
  }
  return out;
}

/**
 * Target columns that must be fed and are not: NOT NULL, no default, not mapped. Every row would
 * fail on them, so the dialog says so before anything else rather than reporting N identical errors.
 */
export function missingRequired(targets: TargetColumn[], mapping: (number | null)[]): string[] {
  return targets
    .filter((col, i) => !col.generated && !col.nullable && !col.hasDefault && (mapping[i] === null || mapping[i] === undefined))
    .map((col) => col.name);
}

/** The row number a person sees in their spreadsheet: 1-based, counting the header line. */
export function displayRowNumber(index: number, hasHeader: boolean): number {
  return index + (hasHeader ? 2 : 1);
}
