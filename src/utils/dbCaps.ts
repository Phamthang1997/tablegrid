/**
 * What a connection type can do, asked in one place.
 *
 * DuckDB is the reason this exists. It is here to query FILES (Parquet / CSV / JSON) in place, and
 * the backend implements only reading for it — the funnels, the catalog, paged table data, table
 * and view definitions — while every write path answers "not supported". Before this, features were
 * gated by scattered `dbType === 'sqlite'` / `!== 'mysql'` checks whose `else` quietly meant "a
 * server database", which for DuckDB is wrong in both directions: it is not a server, and it is not
 * SQLite either. A new check should ask here rather than compare type strings again.
 *
 * Pure (no React, no Tauri) — tested in `__tests__/dbCaps.test.ts`.
 */

export type SqlDbType = 'sqlite' | 'postgres' | 'mysql' | 'duckdb';

/** One file is one database: a path instead of host/port, no database list, no create/drop. */
export function isFileDb(t: string | null | undefined): boolean {
  return t === 'sqlite' || t === 'duckdb';
}

export interface DbCaps {
  /** Grid edits, structure edits, create/rename/drop/truncate, table import. */
  write: boolean;
  /** Manual-transaction mode (the title bar's auto/manual switch). */
  tx: boolean;
  /** Export / import / backup / copy a whole database. */
  dump: boolean;
  /** Compare two databases, schema migration snapshots. */
  compare: boolean;
  dataGen: boolean;
  /** The Properties tab (sizes, engine statistics). */
  properties: boolean;
  processMonitor: boolean;
  /** Exposing the connection to an AI client over MCP. */
  mcp: boolean;
  /** Attach a data file (Parquet / CSV / JSON) as a view. */
  attachFiles: boolean;
}

const FULL: DbCaps = {
  write: true,
  tx: true,
  dump: true,
  compare: true,
  dataGen: true,
  properties: true,
  processMonitor: true,
  mcp: true,
  attachFiles: false,
};

export function dbCaps(t: string | null | undefined): DbCaps {
  if (t === 'duckdb') {
    return {
      write: false,
      tx: false,
      dump: false,
      compare: false,
      dataGen: false,
      properties: false,
      processMonitor: false,
      // `read_csv('…')` opens any file on the machine, so an AI client must not be able to query it.
      mcp: false,
      attachFiles: true,
    };
  }
  // SQLite has no server process list; everything else it shares with the servers.
  if (t === 'sqlite') return { ...FULL, processMonitor: false };
  return FULL;
}

/** File extensions DuckDB reads without any extension beyond what the app compiles in. */
export const DUCK_DATA_EXTENSIONS = ['parquet', 'csv', 'tsv', 'json', 'jsonl', 'ndjson'] as const;

/** The `read_*` call for a data file, or null when its extension is not one DuckDB reads. */
export function duckReaderFor(path: string): string | null {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const lit = `'${path.replace(/\\/g, '/').replace(/'/g, "''")}'`;
  switch (ext) {
    case 'parquet':
      return `read_parquet(${lit})`;
    case 'csv':
    case 'tsv':
      return `read_csv_auto(${lit})`;
    case 'json':
    case 'jsonl':
    case 'ndjson':
      return `read_json_auto(${lit})`;
    default:
      return null;
  }
}

/**
 * A view name for a file: its stem, reduced to `[a-z0-9_]`, not starting with a digit, and made
 * unique against the names already taken (`sales`, `sales_2`, …). Quoting would allow any name, but
 * a plain one is what the user will type in the editor afterwards.
 */
export function viewNameForFile(path: string, taken: Iterable<string>): string {
  const base = (path.split(/[\\/]/).pop() || 'file').replace(/\.[^.]*$/, '');
  // Accents are dropped rather than turned into `_`: `Đơn hàng.csv` reads as `don_hang`, not `n_h_ng`.
  const plain = base.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd');
  let name = plain.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'file';
  if (/^\d/.test(name)) name = `f_${name}`;
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  if (!used.has(name)) return name;
  for (let i = 2; ; i++) {
    if (!used.has(`${name}_${i}`)) return `${name}_${i}`;
  }
}

/** `CREATE VIEW` for an attached file. `name` must come from `viewNameForFile`. */
export function attachFileSql(name: string, path: string): string | null {
  const reader = duckReaderFor(path);
  return reader ? `CREATE VIEW "${name}" AS SELECT * FROM ${reader}` : null;
}
