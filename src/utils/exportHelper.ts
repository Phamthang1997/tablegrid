// Exports one table's data to a file on the client (CSV/JSON/SQL/XLSX) and downloads it with
// <a download>. This is the file-saving mechanism actually in use in the app (as SqlEditor does for
// query results), with no Tauri save dialog involved. XLSX is built by the self-contained xlsxWriter,
// with no external library.

import { buildXlsx, buildXlsxWorkbook, buildZip, type XlsxSheet, type ZipEntry } from './xlsxWriter';
import i18n from '../i18n';

export type ExportFormat = 'csv' | 'json' | 'sql' | 'xlsx';

// Downloads a Blob under a given file name.
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- CSV ----
function csvCell(v: any): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(colNames: string[], rows: any[]): string {
  const header = colNames.map(csvCell).join(',');
  const body = rows.map((r) => colNames.map((c) => csvCell(r?.[c])).join(',')).join('\r\n');
  // A BOM so Excel reads the UTF-8 correctly
  return '﻿' + header + (body ? '\r\n' + body : '');
}

// ---- JSON ----
export function buildJson(rows: any[]): string {
  return JSON.stringify(rows, null, 2);
}

// ---- SQL (INSERT) ----

/**
 * Is this column a binary type (BLOB / bytea / VARBINARY / …)?
 *
 * It has to be known because the backend hands a binary cell over as a BYTE ARRAY (`json!(bytes)`),
 * and an array of numbers is indistinguishable from a JSON column holding `[1,2,3]` — so the column's
 * TYPE is what decides, never a guess from the value. Getting it wrong here means an image or file in
 * the database is exported as the text `'[137,80,78,71,...]'` and is unrecoverable for good.
 */
export function isBinaryType(type: string | null | undefined, dbType: string): boolean {
  const t = (type || '').toLowerCase();
  if (!t) return false;
  if (dbType === 'postgres') return t.startsWith('bytea');
  // MySQL's spatial types also arrive as raw bytes (internally 4 bytes of SRID plus WKB), and MySQL
  // accepts them written back as a hex literal. Sakila has `address.location GEOMETRY NOT NULL` —
  // without this line it becomes the string '[0,0,0,0,1,...]' and the re-import dies on the type.
  if (MYSQL_SPATIAL_TYPES.has(t.split('(')[0].trim())) return true;
  // MySQL: blob/tinyblob/mediumblob/longblob, binary(n), varbinary(n).
  // SQLite: types are free-form, but its affinity rules likewise only look for 'BLOB' in the name.
  return /\b(blob|binary)\b/.test(t) || t.includes('blob') || t.startsWith('binary') || t.startsWith('varbinary');
}

const MYSQL_SPATIAL_TYPES = new Set([
  'geometry',
  'point',
  'linestring',
  'polygon',
  'multipoint',
  'multilinestring',
  'multipolygon',
  'geometrycollection',
  'geomcollection',
]);

/** A byte array -> a hex literal, per dialect. */
function binaryLiteral(bytes: number[], dbType: string): string {
  const hex = bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
  // Postgres: the string '\xAB12' (standard_conforming_strings is on by default, so the \ is a real
  // character).
  if (dbType === 'postgres') return `'\\x${hex}'::bytea`;
  // MySQL and SQLite share the X'AB12' syntax; for an empty string X'' is valid on both.
  return `X'${hex}'`;
}

/**
 * Quotes an identifier for one dialect. MySQL uses backticks, Postgres and SQLite double
 * quotes — see the note on dialect quoting in CLAUDE.md.
 *
 * Exported because the clipboard copies in `copyAs.ts` build the same kind of statement, and
 * the grid's own version of this was hardcoded to backticks: a `SQL INSERT` copied from a
 * Postgres table came out unusable.
 */
export function quoteIdent(name: string, dbType: string): string {
  const q = dbType === 'mysql' ? '`' : '"';
  // A quote inside an identifier is escaped by doubling it, in all three dialects.
  return `${q}${name.split(q).join(q + q)}${q}`;
}

/** One value as a SQL literal. Exported for the same reason as `quoteIdent`. */
export function sqlValue(v: any, dbType: string, isBinary = false): string {
  if (v === null || v === undefined) return 'NULL';
  if (isBinary && Array.isArray(v)) return binaryLiteral(v, dbType);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `'${s.replace(/'/g, "''")}'`;
}

// How many rows are batched into one INSERT, and the length cap on that statement.
//
// One INSERT per row turns a sakila dump into ~50,000 statements, and `restore_backup` runs each as
// its own round trip -> batching rows cuts the number of round trips by about two orders of magnitude.
// The length cap keeps a statement under MySQL's `max_allowed_packet` (4MB by default on 5.7).
const SQL_ROWS_PER_INSERT = 500;
const SQL_INSERT_MAX_CHARS = 200_000;

export function buildSql(
  tableName: string,
  colNames: string[],
  rows: any[],
  dbType: string,
  /** The names of the binary columns — their values are written as hex literals rather than strings. */
  binaryCols?: Set<string>,
  /**
   * The table has a `GENERATED ALWAYS AS IDENTITY` column (Postgres) -> the INSERT needs
   * `OVERRIDING SYSTEM VALUE`, or Postgres refuses the dump's id values and renumbers them itself —
   * at which point every foreign key pointing at this table is wrong.
   */
  overridingSystemValue = false
): string {
  const qi = (n: string) => quoteIdent(n, dbType);
  const cols = colNames.map(qi).join(', ');
  if (rows.length === 0) return i18n.t('errors.sqlTableNoData', { table: qi(tableName) });

  const overriding = overridingSystemValue ? ' OVERRIDING SYSTEM VALUE' : '';
  const prefix = `INSERT INTO ${qi(tableName)} (${cols})${overriding} VALUES\n`;
  const out: string[] = [];
  let tuples: string[] = [];
  let chars = 0;
  const flush = () => {
    if (tuples.length === 0) return;
    out.push(prefix + tuples.join(',\n') + ';');
    tuples = [];
    chars = 0;
  };

  for (const r of rows) {
    const tuple = `(${colNames.map((c) => sqlValue(r?.[c], dbType, binaryCols?.has(c))).join(', ')})`;
    // The cap is checked BEFORE adding, and only once the batch holds a row: a single row longer than
    // the cap still has to go on its own, since it cannot be split in two.
    if (tuples.length > 0 && (tuples.length >= SQL_ROWS_PER_INSERT || chars + tuple.length > SQL_INSERT_MAX_CHARS)) {
      flush();
    }
    tuples.push(tuple);
    chars += tuple.length + 2; // +2 for the ",\n" joining two tuples
  }
  flush();
  return out.join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Orders views by dependency: when view B reads view A, A has to be created first.
 *
 * The object list in the Export dialog is alphabetical, so the view `actor_info` once landed second in
 * the dump — ahead of the `film` table it SELECTs from — and the re-import failed immediately
 * (MySQL 1146 "Table doesn't exist"). Tables are always exported before any view; among the views this
 * topological sort is what is needed. Dependencies are detected by looking for other view names inside
 * the DDL body, matched on word boundaries so `film_list` does not match
 * `nicer_but_slower_film_list`.
 *
 * A dependency cycle is broken where it is found — no correct order exists, and valid SQL cannot
 * create a cycle of views, so this is only a guard against looping forever.
 */
export function orderViewsByDependency<T extends { name: string; sql: string }>(views: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const v of views) byKey.set(v.name.toLowerCase(), v);

  const deps = new Map<string, string[]>();
  for (const v of views) {
    const found: string[] = [];
    for (const other of views) {
      if (other === v) continue;
      const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(other.name)}([^A-Za-z0-9_]|$)`, 'i');
      if (re.test(v.sql)) found.push(other.name.toLowerCase());
    }
    deps.set(v.name.toLowerCase(), found);
  }

  const out: T[] = [];
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const d of deps.get(key) || []) visit(d);
    const v = byKey.get(key);
    if (v) out.push(v);
  };
  for (const v of views) visit(v.name.toLowerCase());
  return out;
}

/**
 * Remove the `DEFINER=user@host` clause MySQL puts in every `SHOW CREATE ...` output.
 *
 * A dump keeping it can only be restored by an account that may impersonate that definer:
 * anyone else gets error 1227 (`Access denied; you need SUPER privilege`), and the definer
 * often does not even exist on the target server. Dropping the clause makes MySQL default it
 * to whoever runs the restore, which is what a portable dump wants.
 *
 * `SQL SECURITY DEFINER` is deliberately kept — it is a different clause (no `=` after the
 * keyword, so the pattern cannot match it) and stays valid once the definer defaults.
 */
const DEFINER_RE =
  /\s*DEFINER\s*=\s*(?:`(?:[^`]|``)*`|'(?:[^']|'')*'|"(?:[^"]|"")*"|[^\s@]+)@(?:`(?:[^`]|``)*`|'(?:[^']|'')*'|"(?:[^"]|"")*"|\S+)/gi;

export function stripDefiner(ddl: string): string {
  return ddl.replace(DEFINER_RE, '');
}

/**
 * Wrap statements whose body contains `;` in a MySQL `DELIMITER` block.
 *
 * A procedure/function/trigger body ends every inner statement with `;`, so a dump that just
 * writes it out gets cut mid-body by any `;`-based splitter — the server then receives
 * `CREATE PROCEDURE p() BEGIN INSERT ...` as a complete statement and fails. `DELIMITER $$`
 * is a client-side command, understood by both splitters in this app (`splitStatements` here
 * and `split_sql_statements` in Rust) and by the mysql CLI.
 *
 * Only MySQL needs this: Postgres bodies are already quoted as `$$…$$` and SQLite triggers
 * end with `END;` which its own splitter handles.
 */
export function wrapMysqlDelimiter(statements: string[]): string[] {
  if (statements.length === 0) return [];
  const bodies = statements.map((s) => {
    const trimmed = s.trim();
    return (trimmed.endsWith(';') ? trimmed.slice(0, -1).trimEnd() : trimmed) + '$$';
  });
  return ['DELIMITER $$', ...bodies, 'DELIMITER ;'];
}

/**
 * Which selected views read a table that is NOT selected.
 *
 * `CREATE VIEW` is validated as it runs, so a dump holding a view without its source table dies on
 * import (MySQL 1146) — and the user finds out only after the export is done and the file has been
 * carried elsewhere. This only WARNS rather than ticking anything itself: a partial export is a
 * legitimate thing to want, and the decision stays the user's.
 *
 * Detected by looking for table names inside the DDL body on word boundaries — the same way
 * `orderViewsByDependency` orders views, so the two cannot read the relationship differently.
 */
export function missingViewDeps(
  selectedViews: { name: string; sql: string }[],
  allTableNames: string[],
  selectedNames: Set<string>
): { view: string; missing: string[] }[] {
  const out: { view: string; missing: string[] }[] = [];
  for (const v of selectedViews) {
    const missing: string[] = [];
    for (const table of allTableNames) {
      if (table.toLowerCase() === v.name.toLowerCase()) continue;
      if (selectedNames.has(table.toLowerCase())) continue;
      const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(table)}([^A-Za-z0-9_]|$)`, 'i');
      if (re.test(v.sql)) missing.push(table);
    }
    if (missing.length > 0) out.push({ view: v.name, missing });
  }
  return out;
}

// ---- The modal's preview (a limited number of rows) ----
// For xlsx it returns HTML (the modal renders it with dangerouslySetInnerHTML); the rest return raw text.
function htmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildPreview(
  format: ExportFormat,
  tableName: string,
  colNames: string[],
  rows: any[],
  dbType: string,
  limit = 10
): string {
  const sample = rows.slice(0, limit);
  if (format === 'csv') return buildCsv(colNames, sample);
  if (format === 'json') return buildJson(sample);
  if (format === 'sql') return buildSql(tableName, colNames, sample, dbType);
  // xlsx -> table HTML
  const head = colNames.map((c) => `<th style="border:1px solid var(--win-border);padding:2px 6px;text-align:left;">${htmlEsc(c)}</th>`).join('');
  const body = sample
    .map((r) => {
      const tds = colNames
        .map((c) => {
          const v = r?.[c];
          const text = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
          return `<td style="border:1px solid var(--win-border);padding:2px 6px;">${htmlEsc(text)}</td>`;
        })
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');
  return `<table style="border-collapse:collapse;font-size:11px;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** A file already built in memory, waiting to be written to a directory or downloaded. */
export interface BuiltFile {
  name: string;
  data: Uint8Array | string;
  mime: string;
}

const MIME: Record<ExportFormat, string> = {
  csv: 'text/csv;charset=utf-8',
  json: 'application/json',
  sql: 'text/plain;charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * Builds the export file's contents for ONE table without downloading it, leaving the caller to
 * decide between writing into a directory the user picked and downloading through the WebView.
 */
export function buildTableFile(
  tableName: string,
  colNames: string[],
  rows: any[],
  format: ExportFormat,
  dbType: string,
  fileName?: string
): BuiltFile {
  const base = stripExt((fileName || '').trim()) || tableName;
  switch (format) {
    case 'csv':
      return { name: `${base}.csv`, data: buildCsv(colNames, rows), mime: MIME.csv };
    case 'json':
      return { name: `${base}.json`, data: buildJson(rows), mime: MIME.json };
    case 'sql':
      return { name: `${base}.sql`, data: buildSql(tableName, colNames, rows, dbType), mime: MIME.sql };
    case 'xlsx':
      return { name: `${base}.xlsx`, data: buildXlsx(tableName, colNames, rows), mime: MIME.xlsx };
  }
}

/**
 * Builds the export contents for SEVERAL tables without downloading: xlsx as multiple sheets, json
 * keyed by table, and csv as a single .csv for one table or a .zip for several.
 */
export function buildDatabaseFile(
  sheets: XlsxSheet[],
  format: 'json' | 'csv' | 'xlsx',
  filename: string
): BuiltFile {
  const base = stripExt(filename) || 'export';
  if (format === 'xlsx') {
    return { name: `${base}.xlsx`, data: buildXlsxWorkbook(sheets), mime: MIME.xlsx };
  }
  if (format === 'json') {
    const byTable = Object.fromEntries(sheets.map((s) => [s.name, s.rows]));
    return { name: `${base}.json`, data: JSON.stringify(byTable, null, 2), mime: MIME.json };
  }
  if (sheets.length === 1) {
    const s = sheets[0];
    return { name: `${s.name || base}.csv`, data: buildCsv(s.colNames, s.rows), mime: MIME.csv };
  }
  const enc = new TextEncoder();
  const usedNames = new Set<string>();
  const entries: ZipEntry[] = sheets.map((s) => {
    const n = (s.name || 'table').replace(/[\\/:*?"<>|]/g, '_');
    let candidate = `${n}.csv`;
    let k = 2;
    while (usedNames.has(candidate.toLowerCase())) candidate = `${n}_${k++}.csv`;
    usedNames.add(candidate.toLowerCase());
    return { name: candidate, data: enc.encode(buildCsv(s.colNames, s.rows)) };
  });
  return { name: `${base}.zip`, data: buildZip(entries), mime: 'application/zip' };
}

// ---- Entry point: export and download the whole file ----
// fileName: the downloaded file's name, without an extension. Left empty -> the table name is used.
// tableName still drives the contents (INSERT INTO / sheet names), so fileName does not replace it.
export function exportTableToFile(
  tableName: string,
  colNames: string[],
  rows: any[],
  format: ExportFormat,
  dbType: string,
  fileName?: string
): void {
  const base = stripExt((fileName || '').trim()) || tableName;
  switch (format) {
    case 'csv':
      downloadBlob(new Blob([buildCsv(colNames, rows)], { type: 'text/csv;charset=utf-8' }), `${base}.csv`);
      break;
    case 'json':
      downloadBlob(new Blob([buildJson(rows)], { type: 'application/json' }), `${base}.json`);
      break;
    case 'sql':
      downloadBlob(new Blob([buildSql(tableName, colNames, rows, dbType)], { type: 'text/plain;charset=utf-8' }), `${base}.sql`);
      break;
    case 'xlsx': {
      const bytes = buildXlsx(tableName, colNames, rows);
      downloadBlob(xlsxBlob(bytes), `${base}.xlsx`);
      break;
    }
  }
}

// Builds an .xlsx Blob from bytes (copied into a clean ArrayBuffer to satisfy the BlobPart type).
function xlsxBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/**
 * Exports several tables into one .xlsx (a sheet per table) and downloads it.
 */
export function exportSheetsToXlsx(sheets: XlsxSheet[], filename: string): void {
  const bytes = buildXlsxWorkbook(sheets);
  const name = filename.toLowerCase().endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  downloadBlob(xlsxBlob(bytes), name);
}

// Strips a file name's extension, if any, so a new one can be appended.
function stripExt(name: string): string {
  return name.replace(/\.[^./\\]+$/, '');
}

/**
 * Exports several tables as JSON: one object of { tableName: rows }.
 */
export function exportTablesToJson(byTable: Record<string, any[]>, filename: string): void {
  const base = stripExt(filename) || 'export';
  downloadBlob(new Blob([JSON.stringify(byTable, null, 2)], { type: 'application/json' }), `${base}.json`);
}

/**
 * Exports several tables as CSV: one table downloads a .csv directly; several are packed into a .zip
 * with one .csv per table.
 */
export function exportTablesToCsv(sheets: XlsxSheet[], filename: string): void {
  const base = stripExt(filename) || 'export';
  if (sheets.length === 1) {
    const s = sheets[0];
    downloadBlob(new Blob([buildCsv(s.colNames, s.rows)], { type: 'text/csv;charset=utf-8' }), `${s.name || base}.csv`);
    return;
  }
  const enc = new TextEncoder();
  const usedNames = new Set<string>();
  const entries: ZipEntry[] = sheets.map((s) => {
    let n = (s.name || 'table').replace(/[\\/:*?"<>|]/g, '_');
    let candidate = `${n}.csv`;
    let k = 2;
    while (usedNames.has(candidate.toLowerCase())) candidate = `${n}_${k++}.csv`;
    usedNames.add(candidate.toLowerCase());
    return { name: candidate, data: enc.encode(buildCsv(s.colNames, s.rows)) };
  });
  downloadBlob(new Blob([buildZip(entries).slice().buffer], { type: 'application/zip' }), `${base}.zip`);
}

// ---- Suggested file names ----

/**
 * `20260812_213045` — sortable in time order, and no character Windows forbids in a file name.
 *
 * Lives here rather than next to a dialog because both the Export dialog and Connection Manager's
 * Backup screen suggest a name; two copies would drift the moment one of them changes format.
 */
export function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Removes characters a file name cannot hold (a table or database name may contain spaces, dots…). */
export function safeFileBase(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_') || 'database';
}

/**
 * Basename without extension — the label a SQLite path contributes to a suggested file name.
 * `C:\data\demo.db` -> `demo`, so the suggestion is `bk_demo_…` and not the whole escaped path.
 */
export function fileBaseFromPath(path: string): string {
  const leaf = path.trim().split(/[\\/]/).pop() || '';
  return leaf.replace(/\.[^.]+$/, '');
}
