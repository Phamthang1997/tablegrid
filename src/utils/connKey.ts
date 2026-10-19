// Stable identity for a connection, used as the localStorage scope for everything
// that must not leak between servers: open tabs + their auto-saved SQL, query
// history, saved queries.
//
// Why this exists: the old key was `${dbType}_${dbName}`, and `dbName` is just
// `config.database || config.sqlitePath` (see dbHelper.connect). Two servers
// hosting a database of the same name therefore shared one key — opening prod
// restored the draft SQL and tabs of localhost, and both wrote over each other.
// Redis was worse: `dbName` is `db${index}`, so every Redis server collapsed
// into `redis_db0`.
//
// Two levels of granularity, deliberately different:
//   connKey  -> the server (host:port, or the SQLite file). Query history uses
//               this, so switching database with USE keeps one timeline.
//   scopeKey -> server + database (+ Postgres schema). Tabs use this, because a
//               tab list belongs to a specific database (a table tab means
//               nothing after USE) and, on Postgres, to one schema of it.
// Credentials are not part of the identity: two profiles pointing at the same
// server with a full and a read-only account are the same server to the user.

import type { DbConnectionConfig } from './dbHelper';

const DEFAULT_PORTS: Record<string, number> = {
  postgres: 5432,
  mysql: 3306,
  redis: 6379,
};

/** Windows paths are case-insensitive and mix separators, so normalize before comparing. */
function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').toLowerCase();
}

/**
 * Identity of the server behind `config`, or `''` when there is no config to
 * derive it from (callers fall back to the legacy key in that case).
 *
 * SSH tunnels do not change the result: the frontend config always holds the
 * real remote host/port, the 127.0.0.1 rewrite happens in Rust.
 */
export function connKey(config?: DbConnectionConfig | null): string {
  if (!config) return '';
  if (config.type === 'sqlite') {
    const path = config.sqlitePath?.trim();
    return path ? `sqlite:${normalizePath(path)}` : '';
  }
  // A DuckDB file is keyed like a SQLite one. Without a path it is an in-memory database, and every
  // in-memory session shares one scratch key: there is no other identity to tell two apart.
  if (config.type === 'duckdb') {
    const path = config.sqlitePath?.trim();
    return `duckdb:${path ? normalizePath(path) : ':memory:'}`;
  }
  const host = (config.host || 'localhost').trim().toLowerCase();
  const port = config.port || DEFAULT_PORTS[config.type] || 0;
  return `${config.type}:${host}:${port}`;
}

/**
 * Identity of one database on that server. `database` overrides the one in
 * `config` (the app switches database without rebuilding the config object).
 * SQLite adds nothing — one file is one database, already in `connKey`.
 *
 * `schema` adds a third level, and only Postgres has one: two schemas of the
 * same database hold different tables, so a tab list (and the SQL drafted in
 * it) belongs to one of them, not to both. It is appended only when it differs
 * from `public`, so every key written before schemas existed keeps its exact
 * spelling and nobody loses tabs on upgrade — see `scopeKeyCandidates`.
 */
export function scopeKey(
  config?: DbConnectionConfig | null,
  database?: string | null,
  schema?: string | null,
): string {
  const base = connKey(config);
  if (!base || config?.type === 'sqlite' || config?.type === 'duckdb') return base;
  const db = (database ?? config?.database ?? '').trim();
  const withDb = db ? `${base}/${db}` : base;
  if (config?.type !== 'postgres') return withDb;
  const sch = (schema ?? '').trim();
  return sch && sch !== 'public' ? `${withDb}:${sch}` : withDb;
}

/**
 * The keys to try, newest spelling first, when *reading* state back.
 *
 * Only the first is ever written. The rest exist because the key gained levels
 * over time and a user upgrading mid-session would otherwise open the app to an
 * empty workspace: `public` on Postgres is already covered by `scopeKey` itself
 * returning the un-suffixed form, and the pre-`connKey` key is handled by
 * `legacyTabsStorageKey` at the call site.
 */
export function scopeKeyCandidates(
  config?: DbConnectionConfig | null,
  database?: string | null,
  schema?: string | null,
): string[] {
  const scoped = scopeKey(config, database, schema);
  const unscoped = scopeKey(config, database, null);
  return scoped === unscoped ? [scoped] : [scoped, unscoped];
}

/**
 * Key holding the open tabs (and the SQL auto-saved inside them) for one database.
 *
 * Takes the whole config but **returns a projection of it**: `connKey` keeps only `type:host:port`
 * (or the SQLite path), so nothing secret can reach the returned string or the `localStorage` key it
 * becomes. Worth saying here rather than only on `connKey`, because a scanner following the config
 * into this call reports the write as clear-text storage of a credential (CodeQL alerts 30/31 on
 * `App.tsx`), and the next reviewer should be able to see why that is wrong without tracing it.
 */
export function tabsStorageKey(
  config: DbConnectionConfig | null | undefined,
  dbType: string,
  dbName: string,
  schema?: string | null,
): string {
  const scope = scopeKey(config, dbName, schema);
  return scope ? `tn_tabs_${scope}` : legacyTabsStorageKey(dbType, dbName);
}

/**
 * Every tab key worth reading for this connection, newest first. Written keys
 * always come from `tabsStorageKey`; this is the read side only.
 */
export function tabsStorageKeyCandidates(
  config: DbConnectionConfig | null | undefined,
  dbType: string,
  dbName: string,
  schema?: string | null,
): string[] {
  const scoped = scopeKeyCandidates(config, dbName, schema).map((s) => `tn_tabs_${s}`);
  const keys = scoped.length && scopeKey(config, dbName, schema) ? scoped : [];
  keys.push(legacyTabsStorageKey(dbType, dbName));
  // A connection with no usable config falls back to the legacy key alone.
  return Array.from(new Set(keys));
}

/**
 * The pre-`connKey` tab key. Only read, never written: it is adopted once when
 * the new key is still empty so nobody loses the tabs they had open.
 */
export function legacyTabsStorageKey(dbType: string, dbName: string): string {
  return `tn_tabs_${dbType}_${dbName}`;
}
