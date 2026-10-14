import { describe, it, expect } from 'vitest';
import {
  connKey,
  scopeKey,
  scopeKeyCandidates,
  tabsStorageKey,
  tabsStorageKeyCandidates,
  legacyTabsStorageKey,
} from '../connKey';
import type { DbConnectionConfig } from '../dbHelper';

const mysql = (over: Partial<DbConnectionConfig> = {}): DbConnectionConfig => ({
  type: 'mysql',
  host: 'localhost',
  port: 3306,
  database: 'sakila',
  ...over,
});

const pg = (over: Partial<DbConnectionConfig> = {}): DbConnectionConfig => ({
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'shop',
  ...over,
});

describe('connKey', () => {
  it('separates two servers hosting a database of the same name', () => {
    const local = connKey(mysql());
    const prod = connKey(mysql({ host: 'prod.example.com' }));
    expect(local).not.toBe(prod);
  });

  it('ignores the database, so USE keeps one identity', () => {
    expect(connKey(mysql({ database: 'sakila' }))).toBe(connKey(mysql({ database: 'world' })));
  });

  it('ignores credentials: same server with two accounts is one connection', () => {
    expect(connKey(mysql({ user: 'root', password: 'a' })))
      .toBe(connKey(mysql({ user: 'readonly', password: 'b' })));
  });

  it('fills in the default port so :3306 and an empty port agree', () => {
    expect(connKey(mysql({ port: undefined }))).toBe(connKey(mysql({ port: 3306 })));
    expect(connKey(mysql({ port: 3307 }))).not.toBe(connKey(mysql({ port: 3306 })));
  });

  it('folds host case and default port for postgres and redis too', () => {
    expect(connKey({ type: 'postgres', host: 'DB.Example.COM' })).toBe('postgres:db.example.com:5432');
    expect(connKey({ type: 'redis', host: 'cache' })).toBe('redis:cache:6379');
  });

  it('separates redis servers that share a database index', () => {
    const a = connKey({ type: 'redis', host: 'a', dbIndex: 0 });
    const b = connKey({ type: 'redis', host: 'b', dbIndex: 0 });
    expect(a).not.toBe(b);
  });

  it('identifies sqlite by file path, normalizing separators and case', () => {
    expect(connKey({ type: 'sqlite', sqlitePath: 'C:\\data\\Demo.db' })).toBe('sqlite:c:/data/demo.db');
    expect(connKey({ type: 'sqlite', sqlitePath: ' C:/data/demo.db ' })).toBe('sqlite:c:/data/demo.db');
  });

  it('separates two sqlite files with the same name in different folders', () => {
    expect(connKey({ type: 'sqlite', sqlitePath: '/a/demo.db' }))
      .not.toBe(connKey({ type: 'sqlite', sqlitePath: '/b/demo.db' }));
  });

  it('returns an empty identity when there is nothing to derive it from', () => {
    expect(connKey(null)).toBe('');
    expect(connKey(undefined)).toBe('');
    expect(connKey({ type: 'sqlite' })).toBe('');
  });
});

describe('scopeKey', () => {
  it('adds the database on top of the server', () => {
    expect(scopeKey(mysql())).toBe('mysql:localhost:3306/sakila');
  });

  it('lets an explicit database win over the one in the config', () => {
    // Changing database (USE / switch_database) does not rebuild the config, so it has to be passed by hand.
    expect(scopeKey(mysql(), 'world')).toBe('mysql:localhost:3306/world');
  });

  it('adds nothing for sqlite: one file is one database', () => {
    const config: DbConnectionConfig = { type: 'sqlite', sqlitePath: '/a/demo.db' };
    expect(scopeKey(config, 'demo')).toBe(connKey(config));
  });

  it('falls back to the server alone when no database is known', () => {
    expect(scopeKey(mysql({ database: undefined }))).toBe('mysql:localhost:3306');
  });

  it('separates two schemas of one postgres database', () => {
    expect(scopeKey(pg(), 'shop', 'sales')).toBe('postgres:localhost:5432/shop:sales');
    expect(scopeKey(pg(), 'shop', 'sales')).not.toBe(scopeKey(pg(), 'shop', 'staging'));
  });

  it('spells `public` exactly like a key written before schemas existed', () => {
    // Omitting the suffix for public is what keeps an upgrading user from losing their tabs.
    const before = scopeKey(pg(), 'shop');
    expect(scopeKey(pg(), 'shop', 'public')).toBe(before);
    expect(scopeKey(pg(), 'shop', null)).toBe(before);
    expect(scopeKey(pg(), 'shop', '  ')).toBe(before);
  });

  it('ignores the schema on mysql and sqlite, which have none of their own', () => {
    expect(scopeKey(mysql(), 'sakila', 'sales')).toBe('mysql:localhost:3306/sakila');
    const sqlite: DbConnectionConfig = { type: 'sqlite', sqlitePath: '/a/demo.db' };
    expect(scopeKey(sqlite, 'demo', 'sales')).toBe(connKey(sqlite));
  });
});

describe('scopeKeyCandidates', () => {
  it('reads the schema-less key as a fallback so tabs survive the upgrade', () => {
    expect(scopeKeyCandidates(pg(), 'shop', 'sales')).toEqual([
      'postgres:localhost:5432/shop:sales',
      'postgres:localhost:5432/shop',
    ]);
  });

  it('offers one key when there is nothing older to fall back to', () => {
    expect(scopeKeyCandidates(pg(), 'shop', 'public')).toEqual(['postgres:localhost:5432/shop']);
    expect(scopeKeyCandidates(mysql(), 'sakila', 'sales')).toEqual(['mysql:localhost:3306/sakila']);
  });
});

describe('tabsStorageKey', () => {
  it('uses the connection-scoped key when a config is available', () => {
    expect(tabsStorageKey(mysql(), 'mysql', 'sakila')).toBe('tn_tabs_mysql:localhost:3306/sakila');
  });

  it('does not collide across servers, unlike the legacy key', () => {
    const local = tabsStorageKey(mysql(), 'mysql', 'sakila');
    const prod = tabsStorageKey(mysql({ host: 'prod' }), 'mysql', 'sakila');
    expect(local).not.toBe(prod);
    expect(legacyTabsStorageKey('mysql', 'sakila')).toBe('tn_tabs_mysql_sakila');
  });

  it('falls back to the legacy key without a config (vite-dev, no backend)', () => {
    expect(tabsStorageKey(null, 'mysql', 'sakila')).toBe(legacyTabsStorageKey('mysql', 'sakila'));
  });

  it('keys a non-public schema separately', () => {
    expect(tabsStorageKey(pg(), 'postgres', 'shop', 'sales'))
      .toBe('tn_tabs_postgres:localhost:5432/shop:sales');
    expect(tabsStorageKey(pg(), 'postgres', 'shop', 'public'))
      .toBe(tabsStorageKey(pg(), 'postgres', 'shop'));
  });
});

describe('tabsStorageKeyCandidates', () => {
  it('reads newest first, then the schema-less key, then the pre-connKey one', () => {
    expect(tabsStorageKeyCandidates(pg(), 'postgres', 'shop', 'sales')).toEqual([
      'tn_tabs_postgres:localhost:5432/shop:sales',
      'tn_tabs_postgres:localhost:5432/shop',
      'tn_tabs_postgres_shop',
    ]);
  });

  it('offers only the legacy key when there is no usable config', () => {
    expect(tabsStorageKeyCandidates(null, 'mysql', 'sakila')).toEqual(['tn_tabs_mysql_sakila']);
  });

  it('never repeats a key when the spellings coincide', () => {
    const keys = tabsStorageKeyCandidates(mysql(), 'mysql', 'sakila');
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('connKey — DuckDB', () => {
  const duck = (sqlitePath?: string): DbConnectionConfig => ({ type: 'duckdb', sqlitePath });

  it('is keyed by its file, like SQLite, and never collides with a SQLite file of the same path', () => {
    expect(connKey(duck('C:/data/a.duckdb'))).not.toBe(connKey(duck('C:/data/b.duckdb')));
    expect(connKey(duck('C:/data/a.db'))).not.toBe(connKey({ type: 'sqlite', sqlitePath: 'C:/data/a.db' }));
  });

  it('gives every in-memory database one scratch key rather than none', () => {
    expect(connKey(duck(''))).toBe('duckdb::memory:');
    expect(connKey(duck(undefined))).toBe('duckdb::memory:');
  });

  it('adds no database level: one file is one database', () => {
    expect(scopeKey(duck('C:/data/a.duckdb'), 'main')).toBe(connKey(duck('C:/data/a.duckdb')));
  });
});
