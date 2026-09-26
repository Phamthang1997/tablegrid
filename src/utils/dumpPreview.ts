/**
 * A "just enough" parser for the dump preview in the Import Database dialog: it reads a CREATE TABLE
 * into a column list and an INSERT INTO into value rows, so the visual table can be shown next to the
 * raw SQL.
 *
 * For display only — the statements that really run are handled by the backend
 * (split_sql_statements).
 */

import i18n from '../i18n';

export interface DumpColumn {
  name: string;
  /** The type plus the rest of the column definition, e.g. "varchar(255) NOT NULL". */
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  defaultValue: string | null;
}

export interface DumpTable {
  name: string;
  columns: DumpColumn[];
  /** Table-level constraints: PRIMARY KEY (...), FOREIGN KEY ..., UNIQUE KEY ..., CHECK ... */
  constraints: string[];
}

export interface DumpRows {
  table: string;
  /** null when the INSERT lists no columns. */
  columns: string[] | null;
  rows: string[][];
}

// An identifier may be quoted (`x`, "x", [x]) and may carry a schema prefix (public."Trip").
const IDENT = '((?:[A-Za-z0-9_$]|[`"\'\\[\\]]|\\.)+)';

/** Strips an identifier's quotes and any schema prefix, leaving the bare name. */
function unquoteIdent(raw: string): string {
  const cleaned = raw.trim().replace(/[`"'[\]]/g, '');
  const dot = cleaned.lastIndexOf('.');
  return dot >= 0 ? cleaned.slice(dot + 1) : cleaned;
}

/** Splits on commas at the outermost paren level, ignoring those inside strings or nested parens. */
function splitTopLevel(body: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { if (i + 1 < body.length) cur += body[++i]; continue; }
      if (ch === quote) {
        // A '' inside a string is an escaped quote, not the end of the string
        if (body[i + 1] === quote) { cur += body[++i]; continue; }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth--; cur += ch; continue; }
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * The position of the ')' closing the paren opened at `start` (ignoring nested parens and parens
 * inside strings), or -1 when it never closes. `start` has to point at a '('.
 */
function matchingParen(s: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) {
        if (s[i + 1] === quote) { i++; continue; }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Takes the contents of the first outermost paren pair. */
function outerParens(stmt: string): string | null {
  const start = stmt.indexOf('(');
  if (start < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < stmt.length; i++) {
    const ch = stmt[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) {
        if (stmt[i + 1] === quote) { i++; continue; }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return stmt.slice(start + 1, i);
    }
  }
  return null;
}

const TABLE_CONSTRAINT_RE = /^(PRIMARY\s+KEY|UNIQUE|KEY|INDEX|FULLTEXT|SPATIAL|CONSTRAINT|FOREIGN\s+KEY|CHECK|EXCLUDE)\b/i;

/** Parses a CREATE TABLE statement. Returns null when it is not one. */
export function parseCreateTable(stmt: string): DumpTable | null {
  const head = new RegExp(`^\\s*CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}`, 'i').exec(stmt);
  if (!head) return null;
  const name = unquoteIdent(head[1]);
  const body = outerParens(stmt);
  if (!body) return { name, columns: [], constraints: [] };

  const columns: DumpColumn[] = [];
  const constraints: string[] = [];

  for (const part of splitTopLevel(body)) {
    if (TABLE_CONSTRAINT_RE.test(part)) {
      constraints.push(part.replace(/\s+/g, ' '));
      continue;
    }
    const m = new RegExp(`^${IDENT}\\s*([\\s\\S]*)$`).exec(part);
    if (!m) continue;
    const rest = (m[2] || '').replace(/\s+/g, ' ').trim();
    const def = /\bDEFAULT\s+('(?:[^']|'')*'|[^\s,]+)/i.exec(rest);
    columns.push({
      name: unquoteIdent(m[1]),
      type: rest || '—',
      notNull: /\bNOT\s+NULL\b/i.test(rest),
      primaryKey: /\bPRIMARY\s+KEY\b/i.test(rest),
      autoIncrement: /\b(AUTO_INCREMENT|AUTOINCREMENT|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY)\b/i.test(rest),
      defaultValue: def ? def[1] : null,
    });
  }

  // A table-level PRIMARY KEY (a, b) -> marked back onto the columns, to read more easily.
  for (const c of constraints) {
    const pk = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(c);
    if (!pk) continue;
    for (const raw of splitTopLevel(pk[1])) {
      const col = columns.find((x) => x.name.toLowerCase() === unquoteIdent(raw).toLowerCase());
      if (col) col.primaryKey = true;
    }
  }

  return { name, columns, constraints };
}

/**
 * Strips leading whitespace and comments from a statement. The twin of `strip_leading_comments()` in
 * database.rs: the splitter keeps comments inside a statement's text, so a mysqldump file has
 * `-- Dumping data for table x` sitting immediately before its LOCK TABLES / INSERT.
 */
export function stripLeadingSqlComments(stmt: string): string {
  return stmt.replace(/^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');
}

/** The objects a dump will create — used to drop same-named ones before replaying it (`scan_dump_file` reads them). */
export interface DumpObjects {
  tables: string[];
  views: string[];
  triggers: string[];
  procedures: string[];
  functions: string[];
}

/**
 * Builds the DROP ... IF EXISTS statements for replaying a dump onto a database that already holds
 * same-named objects (without them, `CREATE TABLE` fails with "already exists" and the whole import
 * rolls back).
 *
 * The order: triggers -> views -> routines -> tables. Per-dialect differences:
 *   - Postgres: `DROP TRIGGER` needs `ON <table>` and `DROP FUNCTION` needs a signature -> both are
 *     skipped, and only tables and views are dropped, with CASCADE.
 *   - SQLite: has no procedures or functions.
 */
export function buildDropStatements(objs: DumpObjects, dbType: string): string[] {
  const q = dbType === 'mysql' ? '`' : '"';
  const qi = (n: string) => `${q}${n}${q}`;
  const out: string[] = [];

  if (dbType === 'mysql') {
    for (const t of objs.triggers) out.push(`DROP TRIGGER IF EXISTS ${qi(t)};`);
    for (const v of objs.views) out.push(`DROP VIEW IF EXISTS ${qi(v)};`);
    for (const p of objs.procedures) out.push(`DROP PROCEDURE IF EXISTS ${qi(p)};`);
    for (const f of objs.functions) out.push(`DROP FUNCTION IF EXISTS ${qi(f)};`);
    for (const t of objs.tables) out.push(`DROP TABLE IF EXISTS ${qi(t)};`);
    return out;
  }

  if (dbType === 'postgres') {
    for (const v of objs.views) out.push(`DROP VIEW IF EXISTS ${qi(v)} CASCADE;`);
    for (const t of objs.tables) out.push(`DROP TABLE IF EXISTS ${qi(t)} CASCADE;`);
    return out;
  }

  // SQLite
  for (const t of objs.triggers) out.push(`DROP TRIGGER IF EXISTS ${qi(t)};`);
  for (const v of objs.views) out.push(`DROP VIEW IF EXISTS ${qi(v)};`);
  for (const t of objs.tables) out.push(`DROP TABLE IF EXISTS ${qi(t)};`);
  return out;
}

/**
 * An "object already exists" error (MySQL 1050, Postgres 42P07, SQLite "already exists") tells the
 * user nothing about what to do -> suggest turning the overwrite option on.
 */
export function addExistsHint(error: string, overwriteAlreadyOn: boolean): string {
  const isExists = /already exists|1050|42P07/i.test(error);
  if (!isExists || overwriteAlreadyOn) return error;
  return i18n.t('errors.existsHint', { error });
}

/** Strips the quotes from a SQL literal for display (NULL stays the word NULL). */
function literalToText(raw: string): string {
  const s = raw.trim();
  if (/^'([\s\S]*)'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'").replace(/\\'/g, "'");
  return s;
}

/** One field of COPY's text format: `\N` is NULL, and a backslash escapes the next character. */
function copyFieldToText(raw: string): string {
  if (raw === '\\N') return 'NULL';
  const esc: Record<string, string> = { t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v' };
  return raw.replace(/\\(.)/g, (_m, c: string) => esc[c] ?? c);
}

/**
 * Parses a `COPY t (cols) FROM stdin;` statement followed by its data lines — the shape
 * `scan_dump_file` returns in its preview sample for a pg_dump file. Returns null when it is not one.
 */
export function parseCopy(stmt: string): DumpRows | null {
  const head = new RegExp(`^\\s*COPY\\s+${IDENT}\\s*(\\([^)]*\\))?\\s*FROM\\s+stdin\\b[^\\n]*\\n`, 'i').exec(stmt);
  if (!head) return null;
  const columns = head[2] ? splitTopLevel(head[2].slice(1, -1)).map(unquoteIdent) : null;
  const rows: string[][] = [];
  for (const line of stmt.slice(head[0].length).split('\n')) {
    const text = line.replace(/\r$/, '');
    if (text === '' || text === '\\.') continue;
    rows.push(text.split('\t').map(copyFieldToText));
  }
  return { table: unquoteIdent(head[1]), columns, rows };
}

/** Parses an INSERT INTO statement. Returns null when it is not one. */
export function parseInsert(stmt: string): DumpRows | null {
  const head = new RegExp(`^\\s*INSERT(?:\\s+OR\\s+\\w+)?(?:\\s+IGNORE)?\\s+INTO\\s+${IDENT}`, 'i').exec(stmt);
  if (!head) return null;
  const table = unquoteIdent(head[1]);

  const afterName = stmt.slice(head[0].length);
  const valuesIdx = afterName.search(/\bVALUES?\b/i);
  const colsPart = valuesIdx >= 0 ? afterName.slice(0, valuesIdx) : afterName;
  const colsBody = outerParens(colsPart);
  const columns = colsBody ? splitTopLevel(colsBody).map(unquoteIdent) : null;

  const rows: string[][] = [];
  if (valuesIdx >= 0) {
    const tuplesPart = afterName.slice(valuesIdx).replace(/^\s*VALUES?\b/i, '');
    // Each tuple is one outermost paren pair: (...),(...). Walked by index rather than by repeatedly
    // slicing the remainder: the export batches up to 500 rows into one INSERT, and slicing per tuple
    // would make this O(n²) on a statement hundreds of thousands of characters long.
    let i = 0;
    while (i < tuplesPart.length) {
      while (i < tuplesPart.length && /[\s,]/.test(tuplesPart[i])) i++;
      // No tuples left -> what follows is something else (ON DUPLICATE KEY UPDATE, RETURNING…).
      if (tuplesPart[i] !== '(') break;
      const end = matchingParen(tuplesPart, i);
      if (end < 0) break;
      rows.push(splitTopLevel(tuplesPart.slice(i + 1, end)).map(literalToText));
      i = end + 1;
    }
  }

  return { table, columns, rows };
}

/** One statement of the preview `scan_dump_file` returns — the fields of `PreviewStmt`, computed in Rust. */
export interface ScannedStatement {
  /** Clipped when `clipped` — the preview shows it, it does not run it. */
  text: string;
  table: string | null;
  kind: 'structure' | 'data';
  skipped: boolean;
  commentOnly: boolean;
  commentRuns: boolean;
  clipped: boolean;
}

/**
 * What `scan_dump_file` learned about a dump file, streamed from disk so the file never enters the
 * webview (see `database/commands/dump_scan.rs`).
 */
export interface DumpScan {
  fileBytes: number;
  gzip: boolean;
  /** "pg_restore 18.6" when the file is a pg_dump -Fc/-Ft archive read through the machine's pg_restore. */
  via: string | null;
  /** Passed back to `restore_backup` so it does not have to read the file once more to find out. */
  mysqlScript: boolean;
  statements: number;
  /** The same list `parseDumpTableNames` gave: the choices for a partial import, in file order. */
  tables: string[];
  objects: DumpObjects;
  /** `parseDumpDatabase`'s answer: a `USE`, else a `CREATE DATABASE/SCHEMA`. */
  database: string | null;
  plan: {
    /** Statements that run whatever is selected. */
    always: number;
    /** Statements that run only when their table is selected. */
    byTable: Record<string, number>;
  };
  preview: {
    structure: ScannedStatement[];
    data: ScannedStatement[];
    /** False when the preview left statements out or clipped one: it is a sample, not the file. */
    complete: boolean;
  };
}

/**
 * How many statements a restore of `scan` will run — the rule the dialogs used to apply over every
 * split statement, applied to the per-table counts instead. With no table detected in the file,
 * everything runs.
 */
export function plannedFromScan(
  plan: DumpScan['plan'],
  tables: string[],
  selected: Iterable<string>,
  prepended = 0,
): number {
  let n = prepended + plan.always;
  const keys = tables.length === 0 ? Object.keys(plan.byTable) : selected;
  for (const name of keys) n += plan.byTable[name] ?? 0;
  return n;
}

/** The file name at the end of a path, for either separator. */
export function fileBaseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}
