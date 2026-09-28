/**
 * Types and pure helpers for "compare two databases" (`src-tauri/src/db_compare.rs`).
 *
 * The types below are the TypeScript twin of the JSON that `compare_schemas`,
 * `compare_data_overview` and `compare_table_data` return — change the shape in Rust and
 * change it here too, the same way `dbHelper.ts` mirrors `database.rs`.
 *
 * Everything in this file is pure (no monaco, no `@tauri-apps/api`, no i18n side effects)
 * so it is unit-testable under Vitest's node environment; the i18n-facing helpers return
 * translation KEYS and let the component call `t()`.
 */

/** Which side an item exists on. `different` = present on both but not equal. */
export type DiffStatus = 'onlySource' | 'onlyTarget' | 'different' | 'identical';

/** What differs on a column that exists on both sides. */
export type ColumnChange =
  | 'type'
  | 'nullable'
  | 'default'
  | 'autoIncrement'
  | 'comment'
  | 'position';

export interface CompareSide {
  /** Database name (MySQL/Postgres). Empty = the database currently connected. */
  database?: string;
  /** Postgres schema (defaults to `public` on the backend). */
  schema?: string;
  /** SQLite file path. */
  filePath?: string;
}

export interface CompareSideInfo {
  label: string;
  server: string;
  dialect: string;
  schema: string;
  tableCount: number;
}

export interface ColumnMeta {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  autoIncrement: boolean;
  comment: string | null;
  position: number;
}

export interface IndexMeta {
  name: string;
  columns: string[];
  unique: boolean;
  /** Postgres only: ` USING hnsw (embedding vector_cosine_ops) WITH (m='16')`. */
  using?: string | null;
}

export interface ForeignKeyMeta {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string | null;
  onUpdate: string | null;
}

export interface ItemDiff<T> {
  name: string;
  status: DiffStatus;
  changes: string[];
  source: T | null;
  target: T | null;
}

export interface TableDiff {
  name: string;
  kind: 'table' | 'view';
  status: DiffStatus;
  changes: string[];
  diffCount: number;
  columns: ItemDiff<ColumnMeta>[];
  indexes: ItemDiff<IndexMeta>[];
  foreignKeys: ItemDiff<ForeignKeyMeta>[];
  primaryKey: { source: string[] | null; target: string[] | null; differs: boolean };
  viewDefinitionDiffers: boolean;
}

export interface SchemaCompareSummary {
  tablesOnlySource: number;
  tablesOnlyTarget: number;
  tablesDifferent: number;
  tablesIdentical: number;
  columnsOnlySource: number;
  columnsOnlyTarget: number;
  columnsDifferent: number;
  indexDiffs: number;
  foreignKeyDiffs: number;
}

export interface SchemaCompareResult {
  success: boolean;
  source: CompareSideInfo;
  target: CompareSideInfo;
  identical: boolean;
  summary: SchemaCompareSummary;
  tables: TableDiff[];
  syncSql: string[];
  includeDrops: boolean;
  warnings: string[];
}

export type CountStatus = 'onlySource' | 'onlyTarget' | 'sameCount' | 'differentCount';

export interface TableCountDiff {
  name: string;
  status: CountStatus;
  sourceRows: number | null;
  targetRows: number | null;
  primaryKey: string[];
  comparable: boolean;
  error: string | null;
}

export interface DataOverviewResult {
  success: boolean;
  source: CompareSideInfo;
  target: CompareSideInfo;
  tables: TableCountDiff[];
  tablesWithDifference: number;
}

export type RowStatus = 'onlySource' | 'onlyTarget' | 'different';

export interface RowDiff {
  status: RowStatus;
  key: any[];
  source: Record<string, any> | null;
  target: Record<string, any> | null;
  changedColumns: string[];
}

export interface DataCompareResult {
  success: boolean;
  table: string;
  source: CompareSideInfo;
  target: CompareSideInfo;
  keyColumns: string[];
  columns: string[];
  columnsOnlySource: string[];
  columnsOnlyTarget: string[];
  identical: boolean;
  summary: {
    onlySource: number;
    onlyTarget: number;
    different: number;
    identical: number;
    sourceRows: number;
    targetRows: number;
  };
  rows: RowDiff[];
  /** true when `rows` was capped — the counts in `summary` are still complete. */
  rowsTruncated: boolean;
  /** true when a side had more rows than the fetch limit. */
  truncated: boolean;
  syncSql: string[];
  includeDrops: boolean;
  warnings: string[];
}

// ---- Pure helpers ----

/** Colour tone for a status badge. Maps to the app's `--st-*` variables in the component. */
export function statusTone(status: DiffStatus | CountStatus | RowStatus): 'ok' | 'warn' | 'danger' | 'muted' {
  switch (status) {
    case 'onlySource':
      return 'ok';
    case 'onlyTarget':
      return 'danger';
    case 'different':
    case 'differentCount':
      return 'warn';
    default:
      return 'muted';
  }
}

/** Translation key for a status label. Never build a key by interpolation — see CLAUDE.md. */
export function statusLabelKey(status: DiffStatus | CountStatus): string {
  switch (status) {
    case 'onlySource':
      return 'compare.statusOnlySource';
    case 'onlyTarget':
      return 'compare.statusOnlyTarget';
    case 'different':
      return 'compare.statusDifferent';
    case 'differentCount':
      return 'compare.statusDifferentCount';
    case 'sameCount':
      return 'compare.statusSameCount';
    default:
      return 'compare.statusIdentical';
  }
}

/** Translation key for one entry of a column's `changes` list. */
export function columnChangeKey(change: string): string {
  switch (change) {
    case 'type':
      return 'compare.changeType';
    case 'nullable':
      return 'compare.changeNullable';
    case 'default':
      return 'compare.changeDefault';
    case 'autoIncrement':
      return 'compare.changeAutoIncrement';
    case 'comment':
      return 'compare.changeComment';
    case 'position':
      return 'compare.changePosition';
    case 'columns':
      return 'compare.changeColumns';
    case 'unique':
      return 'compare.changeUnique';
    case 'refTable':
      return 'compare.changeRefTable';
    case 'refColumns':
      return 'compare.changeRefColumns';
    case 'onDelete':
      return 'compare.changeOnDelete';
    case 'onUpdate':
      return 'compare.changeOnUpdate';
    case 'exists':
      return 'compare.changeExists';
    case 'primaryKey':
      return 'compare.changePrimaryKey';
    case 'viewDefinition':
      return 'compare.changeViewDefinition';
    case 'definition':
      return 'compare.changeDefinition';
    case 'kind':
      return 'compare.changeKind';
    default:
      return 'compare.changeOther';
  }
}

export interface TableFilter {
  /** Empty set = show every status. */
  statuses: Set<DiffStatus>;
  search: string;
}

/** Filters the table list of a schema comparison by status and name. */
export function filterTableDiffs(tables: TableDiff[], filter: TableFilter): TableDiff[] {
  const q = filter.search.trim().toLowerCase();
  return tables.filter((t) => {
    if (filter.statuses.size > 0 && !filter.statuses.has(t.status)) return false;
    if (q && !t.name.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Total number of differences, i.e. what the "N differences" chip shows. */
export function totalDiffCount(summary: SchemaCompareSummary): number {
  return (
    summary.tablesOnlySource +
    summary.tablesOnlyTarget +
    summary.tablesDifferent
  );
}

/** One-line description of a column, for the side-by-side detail rows. */
export function describeColumn(c: ColumnMeta | null): string {
  if (!c) return '—';
  const bits = [c.type];
  bits.push(c.nullable ? 'NULL' : 'NOT NULL');
  if (c.autoIncrement) bits.push('AUTO_INCREMENT');
  if (c.default !== null && c.default !== undefined && String(c.default) !== '') {
    bits.push(`DEFAULT ${c.default}`);
  }
  return bits.join(' · ');
}

export function describeIndex(i: IndexMeta | null): string {
  if (!i) return '—';
  // The Postgres tail says what the columns alone cannot: an HNSW index and a btree on the same
  // column would otherwise read identically on both sides of a "definition" difference.
  if (i.using && i.using.trim()) return `${i.unique ? 'UNIQUE ' : ''}${i.using.trim()}`;
  return `${i.unique ? 'UNIQUE ' : ''}(${i.columns.join(', ')})`;
}

export function describeForeignKey(f: ForeignKeyMeta | null): string {
  if (!f) return '—';
  const rules = [
    f.onDelete && f.onDelete.toUpperCase() !== 'NO ACTION' ? `ON DELETE ${f.onDelete}` : '',
    f.onUpdate && f.onUpdate.toUpperCase() !== 'NO ACTION' ? `ON UPDATE ${f.onUpdate}` : '',
  ].filter(Boolean);
  return `(${f.columns.join(', ')}) → ${f.refTable}(${f.refColumns.join(', ')})${
    rules.length ? ` · ${rules.join(' · ')}` : ''
  }`;
}

/**
 * Renders one cell of a data diff for display. `null` becomes a visible marker rather than
 * an empty cell, so a NULL is distinguishable from an empty string.
 */
export function formatCell(v: any): string {
  if (v === null || v === undefined) return '(NULL)';
  if (typeof v === 'object') return JSON.stringify(v);
  if (v === '') return '(empty)';
  return String(v);
}

/** Joins the backend's statement list into the script shown in the SQL pane. */
export function joinSyncSql(lines: string[]): string {
  return lines.join('\n');
}

/**
 * True when the script contains at least one runnable statement — a script that is only
 * comments (everything was gated behind "include drops") must not enable "Run".
 */
export function hasRunnableSql(lines: string[]): boolean {
  return lines.some((l) => {
    const s = l.trim();
    return s.length > 0 && !s.startsWith('--');
  });
}

/** Suggested file name for downloading the generated script. */
export function syncSqlFileName(kind: 'schema' | 'data', label: string): string {
  const safe = (label || 'db').replace(/[^\w.-]+/g, '_').slice(0, 40);
  return `sync_${kind}_${safe}.sql`;
}
