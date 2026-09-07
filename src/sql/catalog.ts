// Metadata cache for smart completion: table/view list, and schema (columns + types + FKs) per table.
// Background loading + memory cache, invalidated on DDL execution.
//
// **Cache keyed by `connId`.** Previous global Map keyed strictly on table name caused collisions across
// multiple active connections sharing identical table names (`users`).


import { dbHelper } from '../utils/dbHelper';
import type { SchemaInfo, TableItem } from '../utils/dbHelper';

interface ConnCache {
  tables: TableItem[];
  fetchedAt: number;
  fetching: boolean;
  primed: boolean;
  schemas: Map<string, SchemaInfo>;
  /**
   * Per-table schemas fetched through `get_table_schema` — see `getSchemaDetailed`.
   *
   * A SECOND map, deliberately: `schemas` holds the bulk-primed entries, which carry only
   * name/type/isPrimaryKey and fabricate the rest, and merging the two would make it impossible
   * to tell a real `autoIncrement: false` from an absent one.
   */
  fullSchemas: Map<string, SchemaInfo>;
}

const byConn = new Map<string, ConnCache>();
const TTL = 15000;

function cacheFor(connId: string): ConnCache {
  let c = byConn.get(connId);
  if (!c) {
    c = { tables: [], fetchedAt: 0, fetching: false, primed: false, schemas: new Map(), fullSchemas: new Map() };
    byConn.set(connId, c);
  }
  return c;
}

/**
 * In-flight {@link primeCatalog} run per connection.
 *
 * The old `priming` boolean made a concurrent caller RETURN, which is right for the
 * fire-and-forget warm-up but useless to `ensureCatalogPrimed`: it has to await the run that is
 * already going rather than start a second one or give up on a cold cache.
 */
const inFlight = new Map<string, Promise<void>>();

// Bulk-loads entire schema (1 call) via get_full_catalog -> warm schemas; if empty, fall back to lazy fetch.
function primeCatalog(connId: string): Promise<void> {
  const c = cacheFor(connId);
  if (c.primed) return Promise.resolve();
  const running = inFlight.get(connId);
  if (running) return running;
  const run = primeCatalogOnce(connId, c).finally(() => {
    if (inFlight.get(connId) === run) inFlight.delete(connId);
  });
  inFlight.set(connId, run);
  return run;
}

async function primeCatalogOnce(connId: string, c: ConnCache): Promise<void> {
  try {
    const full = await dbHelper.getFullCatalog(connId);
    for (const [tbl, cols] of Object.entries(full.columns || {})) {
      c.schemas.set(tbl, {
        columns: (cols as any[]).map(col => ({
          name: col.name, type: col.type, nullable: true, isPrimaryKey: !!col.isPrimaryKey, defaultValue: null,
        })),
        indexes: [],
        foreignKeys: (full.foreignKeys?.[tbl] || []) as any,
      });
    }
    c.primed = true;
  } catch {
    /* allow getSchema lazy per-table fallback */
  }
}

/**
 * Awaits the bulk catalog prime — for a caller whose ANSWER depends on it rather than merely
 * improving with it (the FK ranking of the table list after `JOIN`, in `sqlLanguage.ts`).
 *
 * Capped by a timer, and the cap is the point: the prime keeps running in the background when it
 * expires, so the worst case is one completion popup that ranks by frequency like before — never
 * a popup held open behind a slow connection.
 */
export async function ensureCatalogPrimed(connId: string, timeoutMs = 1200): Promise<void> {
  if (cacheFor(connId).primed) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); });
  try {
    await Promise.race([primeCatalog(connId), capped]);
  } finally {
    clearTimeout(timer);
  }
}

export async function getTables(connId: string): Promise<TableItem[]> {
  const c = cacheFor(connId);
  if (Date.now() - c.fetchedAt > TTL && !c.fetching) {
    c.fetching = true;
    try {
      c.tables = await dbHelper.getTables(connId);
      c.fetchedAt = Date.now();
    } catch {
      /* preserve stale cache */
    } finally {
      c.fetching = false;
    }
  }
  void primeCatalog(connId); // background schema warm-up (non-blocking)
  return c.tables;
}

export async function getSchema(connId: string, table: string): Promise<SchemaInfo | null> {
  const c = cacheFor(connId);
  const cached = c.schemas.get(table);
  if (cached) return cached;
  try {
    const s = await dbHelper.getTableSchema(connId, table);
    c.schemas.set(table, s);
    return s;
  } catch {
    return null;
  }
}

/**
 * Reads schema ONLY from memory cache without invoking backend. Used for multi-table scan paths
 * (e.g. column hover when query lacks FROM) avoiding N backend IPC roundtrips.
 */
export function getCachedSchema(connId: string, table: string): SchemaInfo | null {
  return byConn.get(connId)?.schemas.get(table) || null;
}

/**
 * The FULL schema of one table — every flag the backend reports, unlike `getSchema`.
 *
 * `getSchema` answers from the bulk-primed cache when it can, and `primeCatalog` only receives
 * name/type/isPrimaryKey from `get_full_catalog`: it hardcodes `nullable: true`, leaves
 * `defaultValue` null and `indexes` empty, and drops `autoIncrement`/`generated`/`identityAlways`
 * entirely. A caller that must distinguish a column the database WRITES ITSELF therefore cannot
 * use it — `get_table_schema` is the only path carrying those flags (`database/introspect.rs`).
 *
 * One IPC call per table, then cached. Only call this for a table the user has named explicitly
 * (an `INSERT INTO <table>` target); on a path that scans several tables it is N round trips.
 */
export async function getSchemaDetailed(connId: string, table: string): Promise<SchemaInfo | null> {
  const c = cacheFor(connId);
  const cached = c.fullSchemas.get(table);
  if (cached) return cached;
  try {
    const s = await dbHelper.getTableSchema(connId, table);
    c.fullSchemas.set(table, s);
    return s;
  } catch {
    return null; // unknown table, or a name that is not a table at all
  }
}

/**
 * Invalidates cache. Omitting `connId` clears for **all** connections — intended for app-level events
 * (`database-restored`, `table-renamed`) lacking connection ID.
 * Passing id clears that connection only, isolating schema changes across active databases.
 */
export function invalidateCatalog(connId?: string): void {
  if (connId === undefined) {
    byConn.clear();
    inFlight.clear();
    return;
  }
  byConn.delete(connId);
  inFlight.delete(connId);
}

// Refreshes when schema structure changes (rename table / restore / switch database).
//
// Event contains `detail.connId` of modified connection, selectively invalidating only that cache.
// Previously cleared all caches indiscriminately: restoring on A forced B to reload its entire catalog.
// Events lacking id clear all caches as a safe fallback.
function onSchemaChanged(e: Event): void {
  const connId = (e as CustomEvent<{ connId?: string }>).detail?.connId;
  invalidateCatalog(connId);
}

if (typeof window !== 'undefined' && !(window as any).__catalogListener) {
  (window as any).__catalogListener = true;
  window.addEventListener('table-renamed', onSchemaChanged);
  window.addEventListener('database-restored', onSchemaChanged);
}
