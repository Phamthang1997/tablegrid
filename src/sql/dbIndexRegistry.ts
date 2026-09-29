import { editorConnId } from './editorScope';
import { dbHelper } from '../utils/dbHelper';

export interface ColumnIndexMeta {
  name: string;
  type: string;
  isPrimaryKey: boolean;
  nullable: boolean;
}

export interface TableIndexMeta {
  name: string;
  columnCount: number;
}

/** Maximum suggestion limit — error messages and Quick Fix menus must be glanceable. */
const MAX_SUGGESTIONS = 3;

/**
 * Damerau–Levenshtein distance, bailing out as soon as it is certain to exceed `max`.
 *
 * *Damerau* is needed — it has a transposition of two adjacent characters — rather than plain
 * Levenshtein: the most common typo is two keys swapped, and `nmae` ↔ `name` is **1** transposition
 * but **2** ordinary edits, so at a tight threshold plain Levenshtein misses exactly the case that
 * happens most.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = [];
  let prev: number[] = [];
  let cur: number[] = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      // Transposition: "ab" -> "ba" counts as 1 edit operation.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1; // entire row exceeds threshold -> early exit
    prev2.length = 0;
    prev2.push(...prev);
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Ranks the names in `pool` by how close they are to `search`.
 *
 * The previous version compared **substrings** only, so it caught `emai` → `email` but missed
 * `nmae` → `name` — precisely the kind of mistake a "did you mean…" exists for. Substring matching
 * is kept (half-typed text is a very common state in an editor) and ranked **above** edit distance,
 * with names a few keystrokes away coming after.
 *
 * The threshold scales with length: for a 3-character name, allowing 2 edits would match nearly
 * anything.
 */
function rankSimilar(search: string, pool: string[]): string[] {
  if (!search) return [];
  const max = search.length <= 3 ? 1 : 2;
  const scored: { name: string; rank: number; dist: number }[] = [];

  for (const name of pool) {
    const lower = name.toLowerCase();
    if (lower === search) continue; // exact match produces no diagnostic
    if (lower.includes(search) || search.includes(lower)) {
      scored.push({ name, rank: 0, dist: Math.abs(lower.length - search.length) });
      continue;
    }
    const dist = editDistance(search, lower, max);
    if (dist <= max) scored.push({ name, rank: 1, dist });
  }

  scored.sort((a, b) => a.rank - b.rank || a.dist - b.dist || a.name.localeCompare(b.name));
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.name);
}

/**
 * In-Memory DB Index Registry for instant O(1) symbol resolution & static inspection.
 */
export class DbIndexRegistry {
  private tables = new Map<string, TableIndexMeta>();
  private columns = new Map<string, Map<string, ColumnIndexMeta>>();
  private foreignKeys = new Map<string, any[]>();
  private isBuilding = false;
  private isPrimed = false;
  /** Connection the current index was built from. `null` = nothing built yet. */
  private builtFor: string | null = null;

  /**
   * Builds the in-memory index graph, **or returns immediately if it already holds this
   * connection's**.
   *
   * The check is the point. Callers are many and repetitive: every mounted `SqlEditor` runs it on
   * mount and whenever its connection changes, `inspection.ts` runs it per Monaco model, and two
   * window listeners run it on schema changes. Without a memory of what it already has, each of
   * those was a full `get_full_catalog` round trip — with three query tabs open, three fetches of
   * the same catalog back to back, which is what made switching connections feel slow.
   *
   * A different connection still rebuilds: `builtFor` not matching is exactly that case, so callers
   * do not need to `invalidate()` first. `invalidate()` stays for the real reason to discard —
   * the schema changed under us.
   */
  async buildIndex(): Promise<void> {
    const connId = editorConnId();
    if (this.isBuilding) return;
    if (this.isPrimed && this.builtFor === connId) return;
    this.isBuilding = true;
    try {
      const full = await dbHelper.getFullCatalog(connId);
      this.tables.clear();
      this.columns.clear();
      this.foreignKeys.clear();

      for (const [tblName, colList] of Object.entries(full.columns || {})) {
        const lowerTbl = tblName.toLowerCase();
        const cols = (colList as any[]).map((c) => ({
          name: c.name,
          type: c.type || 'UNKNOWN',
          isPrimaryKey: !!c.isPrimaryKey,
          nullable: c.nullable !== false,
        }));

        this.tables.set(lowerTbl, { name: tblName, columnCount: cols.length });

        const colMap = new Map<string, ColumnIndexMeta>();
        for (const col of cols) {
          colMap.set(col.name.toLowerCase(), col);
        }
        this.columns.set(lowerTbl, colMap);
      }

      for (const [tblName, fks] of Object.entries(full.foreignKeys || {})) {
        this.foreignKeys.set(tblName.toLowerCase(), fks as any[]);
      }

      this.isPrimed = true;
      this.builtFor = connId;
    } catch {
      /* Keep existing index state if network/backend fails */
    } finally {
      this.isBuilding = false;
    }
  }

  isReady(): boolean {
    return this.isPrimed;
  }

  hasTable(tableName: string): boolean {
    if (!tableName) return false;
    const clean = tableName.replace(/[`"[\]]/g, '').toLowerCase();
    return this.tables.has(clean);
  }

  getRealTableName(tableName: string): string | null {
    if (!tableName) return null;
    const clean = tableName.replace(/[`"[\]]/g, '').toLowerCase();
    return this.tables.get(clean)?.name || null;
  }

  getTableColumns(tableName: string): ColumnIndexMeta[] {
    if (!tableName) return [];
    const clean = tableName.replace(/[`"[\]]/g, '').toLowerCase();
    const colMap = this.columns.get(clean);
    return colMap ? Array.from(colMap.values()) : [];
  }

  hasColumn(tableName: string, columnName: string): boolean {
    if (!tableName || !columnName) return false;
    const cleanTbl = tableName.replace(/[`"[\]]/g, '').toLowerCase();
    const cleanCol = columnName.replace(/[`"[\]]/g, '').toLowerCase();
    const colMap = this.columns.get(cleanTbl);
    return colMap ? colMap.has(cleanCol) : false;
  }

  getColumn(tableName: string, columnName: string): ColumnIndexMeta | null {
    if (!tableName || !columnName) return null;
    const cleanTbl = tableName.replace(/[`"[\]]/g, '').toLowerCase();
    const cleanCol = columnName.replace(/[`"[\]]/g, '').toLowerCase();
    const colMap = this.columns.get(cleanTbl);
    return colMap ? colMap.get(cleanCol) || null : null;
  }

  findSimilarColumns(columnName: string, tableName?: string): string[] {
    const search = columnName.replace(/[`"[\]]/g, '').toLowerCase();
    const pool: string[] = [];

    if (tableName) {
      const cleanTbl = tableName.replace(/[`"[\]]/g, '').toLowerCase();
      const colMap = this.columns.get(cleanTbl);
      if (colMap) for (const col of colMap.values()) pool.push(col.name);
    } else {
      for (const colMap of this.columns.values()) {
        for (const col of colMap.values()) if (!pool.includes(col.name)) pool.push(col.name);
      }
    }
    return rankSimilar(search, pool);
  }

  /** Similar table names — provides candidates for Quick Fix on "table not found" errors. */
  findSimilarTables(tableName: string): string[] {
    const search = tableName.replace(/[`"[\]]/g, '').toLowerCase();
    return rankSimilar(search, Array.from(this.tables.values()).map((tbl) => tbl.name));
  }

  invalidate(): void {
    this.isPrimed = false;
    this.builtFor = null;
    this.tables.clear();
    this.columns.clear();
    this.foreignKeys.clear();
  }
}

export const dbIndexRegistry = new DbIndexRegistry();

/**
 * The index holds ONE connection's symbols — the one the focused editor belongs to.
 *
 * So a schema change somewhere else must not rebuild it: doing so would refill it from the focused
 * editor's connection over and over for events that have nothing to do with it, and — while the
 * event carried no id at all — could rebuild it at a moment when the focused editor and the changed
 * database were different connections. An event with no id is treated as "mine", which is what
 * every dispatch looked like before they carried one.
 */
function onSchemaChanged(e: Event): void {
  const connId = (e as CustomEvent<{ connId?: string }>).detail?.connId;
  if (connId && connId !== editorConnId()) return;
  dbIndexRegistry.invalidate();
  void dbIndexRegistry.buildIndex();
}

if (typeof window !== 'undefined' && !(window as any).__dbIndexListener) {
  (window as any).__dbIndexListener = true;
  window.addEventListener('table-renamed', onSchemaChanged);
  window.addEventListener('database-restored', onSchemaChanged);
  // DDL run from the editor, and a DuckDB file attached as a view. Without it the index kept the
  // tables it had at connect, so a table created a moment ago was underlined as unknown.
  window.addEventListener('schema-changed', onSchemaChanged);
}
