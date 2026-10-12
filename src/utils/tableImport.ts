// Importing a CSV / Excel / JSON file into a table: the parts the dialog decides on its own — the
// column mapping, what a new table's columns are called and typed — plus the shapes of what the
// backend answers. Pure — no DOM, no Tauri — so every rule here is unit-tested (`tableImport.test.ts`).
//
// Reading the file and converting its values is NOT here any more. It used to be: the dialog read
// the whole file into the webview, parsed it into a grid of strings and converted the grid twice
// (dry run + import), which took the webview down on a file of a few hundred MB — and a 1GB file
// cannot even be one JS string. The file is now read in Rust from its PATH (`src-tauri/src/
// import_file/`), and the conversion rules moved with it (`import_file/coerce.rs`), so what the dry
// run reports is exactly what the import does.

export type Delimiter = ',' | ';' | '\t' | '|';
export const DELIMITERS: Delimiter[] = [',', ';', '\t', '|'];

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

/**
 * The kind of value a column holds, from its SQL type — shown beside the type in the mapping table.
 * The rule that decides what a cell may become is `type_family` in `import_file/coerce.rs`; this is
 * its display twin and decides nothing.
 */
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

/**
 * Target columns that must be fed and are not: NOT NULL, no default, not mapped. Every row would
 * fail on them, so the dialog says so before anything else rather than reporting N identical errors.
 */
export function missingRequired(targets: TargetColumn[], mapping: (number | null)[]): string[] {
  return targets
    .filter((col, i) => !col.generated && !col.nullable && !col.hasDefault && (mapping[i] === null || mapping[i] === undefined))
    .map((col) => col.name);
}

/** What `import_begin` / `import_file_check` are told about one INSERT column. */
export interface MappedColumn {
  target: { name: string; type: string; nullable: boolean };
  /** Index into the file's header. */
  source: number;
}

/** The mapping as the backend wants it: one entry per target that is fed, in target order. */
export function mappedColumns(targets: TargetColumn[], mapping: (number | null)[]): MappedColumn[] {
  const out: MappedColumn[] = [];
  targets.forEach((col, i) => {
    const src = mapping[i];
    if (src === null || src === undefined || col.generated) return;
    out.push({ target: { name: col.name, type: col.type, nullable: col.nullable }, source: src });
  });
  return out;
}

// ---------------------------------------------------------------------------
// A new table
// ---------------------------------------------------------------------------

/**
 * The column type for a guessed family, per dialect. Types the conversion understands (an
 * `INTEGER` column takes integers and nothing else), so a column guessed from the whole file takes
 * every value in it. Text is plain TEXT: a guessed VARCHAR(n) would refuse the first longer value
 * in the next file.
 */
export function newTableColumnType(family: TypeFamily, dbType: string | undefined): string {
  const pg = dbType === 'postgres';
  const mysql = dbType === 'mysql';
  switch (family) {
    case 'integer':
      return pg || mysql ? 'BIGINT' : 'INTEGER';
    case 'float':
      return pg ? 'DOUBLE PRECISION' : mysql ? 'DOUBLE' : 'REAL';
    case 'boolean':
      return mysql ? 'TINYINT(1)' : 'BOOLEAN';
    case 'date':
      return 'DATE';
    case 'datetime':
      return pg ? 'TIMESTAMP' : 'DATETIME';
    default:
      return 'TEXT';
  }
}

/**
 * A table name from a file path: the name without its extensions (`orders.csv.gz` → `orders`),
 * lower-cased, anything but letters, digits and `_` turned into `_`, accents dropped.
 */
export function tableNameFromFile(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const stem = base.replace(/(\.(gz|gzip|zip))+$/i, '').replace(/\.[^.]*$/, '');
  const ascii = stem
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
  const name = ascii.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[0-9]/.test(name) ? `t_${name}` : name || 'imported';
}

// ---------------------------------------------------------------------------
// What the backend answers
// ---------------------------------------------------------------------------

export type ImportKind = 'csv' | 'json' | 'xlsx' | 'sql';

export interface FileDetect {
  kind: ImportKind;
  compression: 'gzip' | 'zip' | null;
  /** The file read inside a .zip. */
  entry: string | null;
  fileBytes: number;
}

/** How to read the file. Sent as is to every `import_file_*` command and to `import_begin`. */
export interface SourceOptions {
  encoding?: string;
  /** Absent: detected from the first lines. */
  delimiter?: Delimiter;
  hasHeader?: boolean;
  /** Excel sheet, 0-based. */
  sheet?: number;
}

export interface FileProbe extends FileDetect {
  /** The delimiter used (detected or chosen); null for JSON / Excel. */
  delimiter: string | null;
  sheets: string[];
  headers: string[];
  /** First non-blank value of each column, for the mapping table. */
  firstValues: string[];
  /** The first rows, each cell shortened. `row` is the number the user would look for in the file. */
  sample: { row: number; cells: (string | null)[] }[];
  /** A type guessed from the rows read here, per header. */
  inferred: TypeFamily[];
  /** The whole file fit in the rows read for the preview. */
  complete: boolean;
}

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

export interface RowIssue {
  /** The row as the file numbers it — a CSV record counting the header, an Excel row, a JSON element. */
  row: number;
  column: string;
  issue: CellIssue;
  /** The cell as it was in the file, shortened for display. */
  value: string;
}

export interface CoerceOptions {
  /** An empty cell in a TEXT column is '' instead of NULL. */
  emptyAsEmpty: boolean;
  /** Trim blanks around every text value. */
  trim: boolean;
}

export interface FileCheck {
  rows: number;
  badRows: number;
  /** The first problems; all are counted in `badRows` / `issuesByColumn`. */
  issues: RowIssue[];
  issuesByColumn: Record<string, number>;
  /** The header after the WHOLE file — a JSON file can add keys after the preview's rows. */
  headers: string[];
  /** Per header, when asked to guess types (a new table). */
  inferred: TypeFamily[] | null;
}

export interface ImportStepResult {
  inserted: number;
  /** Rows the database refused. */
  failed: { row: number; error: string }[];
  /** Rows the conversion refused. */
  badRows: number;
  issues: RowIssue[];
  stopped: boolean;
  done: boolean;
  rowsRead: number;
  bytesDone: number;
  bytesTotal: number;
}
