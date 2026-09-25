// Query history + saved queries (the SQL editor's history drawer).
//
// Every mutation is a read-modify-write against localStorage, never a write of
// component state: each query tab mounts its own SqlEditor with its own copy of
// the list, so writing state back would resurrect entries another tab deleted
// and drop the ones it added. After writing, a `sql-history-changed` event tells
// the other mounted editors to reload.
//
// Entries carry the connection they were run on (`conn` = connKey, `db` = the
// database name at that moment) so the drawer can show one connection at a time.
// Both fields are optional: entries written before this existed have neither and
// are always shown.

import { newSavedQueries, type SharedQuery } from './queryShare';

export interface HistoryEntry {
  id: string;
  sql: string;
  timestamp: string;
  conn?: string;
  db?: string;
  /** The run's outcome — patched on when it finishes (see `recordHistoryResult`). */
  ok?: boolean;
  /** time run, ms. */
  ms?: number;
  rows?: number;
  affected?: number;
  /** The truncated error message; present only when `ok === false`. */
  error?: string;
}

/**
 * The outcome of ONE RUN (which may hold several statements), so `ok: false` means "at least one
 * statement failed" — matching the UI's one-row-per-run model.
 */
export interface HistoryRunResult {
  /** Left empty when the user stopped the run midway: neither a success nor an error. */
  ok?: boolean;
  ms: number;
  rows?: number;
  affected?: number;
  error?: string;
}

export interface SavedQueryEntry extends HistoryEntry {
  name: string;
}

export const HISTORY_KEY = 'sql_query_history';
export const SAVED_KEY = 'sql_saved_queries';

/** A driver error can run to thousands of characters; the history only needs enough to recognise what happened. */
export const ERROR_MAX_LENGTH = 200;

/** Kept per connection, not globally — a chatty database must not evict the others. */
export const HISTORY_LIMIT = 500;

export const HISTORY_CHANGED_EVENT = 'sql-history-changed';

/** Read lazily: this module is imported in a node test environment with no DOM. */
function store(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function readList<T>(key: string): T[] {
  const raw = store()?.getItem(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Persist, and on a full quota drop the oldest half and retry once. History is
 * the most expendable thing in localStorage — losing the tail of it beats
 * throwing out of the caller and losing the entry being added.
 */
function writeList<T>(key: string, list: T[]): T[] {
  const s = store();
  if (!s) return list;
  try {
    s.setItem(key, JSON.stringify(list));
    return list;
  } catch {
    const shrunk = list.slice(0, Math.floor(list.length / 2));
    try {
      s.setItem(key, JSON.stringify(shrunk));
      return shrunk;
    } catch {
      return list;
    }
  }
}

function notifyChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(HISTORY_CHANGED_EVENT));
}

/**
 * How much of the history the drawer shows: the database in use, the whole
 * server (one timeline across USE), or everything.
 */
export type HistoryScope = 'db' | 'conn' | 'all';

export function parseHistoryScope(value: string | null): HistoryScope {
  return value === 'conn' || value === 'all' ? value : 'db';
}

/** An entry with no connection recorded belongs to no connection, so it matches every one. */
export function matchesConn(entry: HistoryEntry, conn: string): boolean {
  return !entry.conn || entry.conn === conn;
}

/**
 * An entry is in scope when it is not tagged (written before connections were
 * recorded — those stay visible everywhere so no history is ever hidden) or when
 * its tags match. `db` narrows on top of `conn`, never on its own: two servers
 * both hosting `sakila` must not share a scope.
 */
export function matchesScope(
  entry: HistoryEntry,
  conn: string,
  db: string,
  scope: HistoryScope,
): boolean {
  if (scope === 'all') return true;
  if (!matchesConn(entry, conn)) return false;
  if (scope === 'conn') return true;
  return !entry.db || entry.db === db;
}

/**
 * Keep the newest `limit` entries of each connection, preserving the newest-first
 * order of the whole list. Trimming the list as a whole would let one busy
 * connection push every other connection's history out.
 */
export function trimHistory<T extends HistoryEntry>(list: T[], limit = HISTORY_LIMIT): T[] {
  const seen: Record<string, number> = {};
  return list.filter((entry) => {
    const key = entry.conn || '';
    seen[key] = (seen[key] || 0) + 1;
    return seen[key] <= limit;
  });
}

export function loadHistory(): HistoryEntry[] {
  return readList<HistoryEntry>(HISTORY_KEY);
}

export function loadSavedQueries(): SavedQueryEntry[] {
  return readList<SavedQueryEntry>(SAVED_KEY);
}

/**
 * Prepend a statement. Returns the stored list plus the id the run was logged
 * under — the caller patches the result onto it with `recordHistoryResult` once
 * the query finishes.
 *
 * A statement identical to the previous one on the same connection is not logged
 * twice: the existing row is moved back to the top with a fresh timestamp, so the
 * list stays ordered newest-first (the drawer groups by day in list order) and
 * shows the outcome of the latest run rather than the first one.
 */
export function addHistoryEntry(
  sql: string,
  conn: string,
  db: string,
  id: string,
): { list: HistoryEntry[]; id: string } {
  const list = loadHistory();
  if (!sql.trim()) return { list, id };

  const previous = list.find((entry) => matchesConn(entry, conn));
  const repeat = previous && previous.sql.trim() === sql.trim() ? previous : null;

  const entry: HistoryEntry = repeat
    ? { ...repeat, timestamp: new Date().toISOString(), db, ok: undefined, ms: undefined, rows: undefined, affected: undefined, error: undefined }
    : { id, sql, timestamp: new Date().toISOString(), conn, db };

  const rest = repeat ? list.filter((e) => e.id !== repeat.id) : list;
  const updated = writeList(HISTORY_KEY, trimHistory([entry, ...rest]));
  notifyChanged();
  return { list: updated, id: entry.id };
}

/**
 * Writes the outcome onto the history row created when the run started. That row may have been
 * deleted (from another tab) while the statement ran — in which case it is skipped, not recreated.
 */
export function recordHistoryResult(id: string, result: HistoryRunResult): HistoryEntry[] {
  const list = loadHistory();
  const index = list.findIndex((entry) => entry.id === id);
  if (index < 0) return list;

  const { error, ...rest } = result;
  list[index] = {
    ...list[index],
    ...rest,
    ...(error ? { error: error.slice(0, ERROR_MAX_LENGTH) } : {}),
  };
  const updated = writeList(HISTORY_KEY, list);
  notifyChanged();
  return updated;
}

export function deleteHistoryEntry(id: string): HistoryEntry[] {
  const updated = writeList(HISTORY_KEY, loadHistory().filter((entry) => entry.id !== id));
  notifyChanged();
  return updated;
}

/**
 * Clear the scope the drawer is showing: this database, this server, or
 * everything. Untagged entries survive anything but `'all'` — they are shown in
 * every scope, so deleting them from one would silently delete them from the
 * others; `'all'` is the only place the user is looking at them as a whole.
 */
export function clearHistory(scope: HistoryScope, conn: string, db: string): HistoryEntry[] {
  const kept = scope === 'all'
    ? []
    : loadHistory().filter((entry) => !entry.conn || !matchesScope(entry, conn, db, scope));
  const updated = writeList(HISTORY_KEY, kept);
  notifyChanged();
  return updated;
}

export function addSavedQuery(
  name: string,
  sql: string,
  conn: string,
  db: string,
  id: string,
): SavedQueryEntry[] {
  const entry: SavedQueryEntry = {
    id,
    name,
    sql,
    timestamp: new Date().toISOString(),
    conn,
    db,
  };
  const updated = writeList(SAVED_KEY, [entry, ...loadSavedQueries()]);
  notifyChanged();
  return updated;
}

/**
 * Adds the saved queries from an imported file (`queryShare.ts`), skipping those already here.
 *
 * Read-modify-write against storage like every mutation in this module, so an import in one tab
 * cannot resurrect what another tab deleted. Imported entries carry no `conn`/`db` — the file does
 * not either, see `buildShareFile` — and so show under every connection, the way pre-scope history
 * does. They go to the top in file order, newest first after that.
 */
export function importSavedQueries(incoming: SharedQuery[]): { added: number; skipped: number } {
  const current = loadSavedQueries();
  const { added, skipped } = newSavedQueries(current, incoming);
  if (added.length === 0) return { added: 0, skipped };
  const base = Date.now();
  const stamp = new Date(base).toISOString();
  const entries: SavedQueryEntry[] = added.map((q, i) => ({
    // `Date.now()` alone is how an id is minted elsewhere; a suffix keeps a batch unique.
    id: `${base}_${i}`,
    name: q.name,
    sql: q.sql,
    timestamp: stamp,
  }));
  writeList(SAVED_KEY, [...entries, ...current]);
  notifyChanged();
  return { added: added.length, skipped };
}

export function deleteSavedQuery(id: string): SavedQueryEntry[] {
  const updated = writeList(SAVED_KEY, loadSavedQueries().filter((entry) => entry.id !== id));
  notifyChanged();
  return updated;
}
