import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ERROR_MAX_LENGTH,
  HISTORY_KEY,
  SAVED_KEY,
  addHistoryEntry,
  addSavedQuery,
  clearHistory,
  deleteHistoryEntry,
  deleteSavedQuery,
  importSavedQueries,
  loadHistory,
  loadSavedQueries,
  matchesConn,
  matchesScope,
  parseHistoryScope,
  recordHistoryResult,
  trimHistory,
  type HistoryEntry,
} from '../queryHistory';

// environment: 'node' -> there is no localStorage. A fake one is built so the write path can be
// tested too, the out-of-quota branch included. `window` stays undefined, so the function dispatching
// the CustomEvent no-ops by itself.
class FakeStorage {
  private map = new Map<string, string>();
  /** Throws QuotaExceededError once the total character count passes the threshold (0 = no limit). */
  limit = 0;

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    if (this.limit && value.length > this.limit) {
      throw new Error('QuotaExceededError');
    }
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  (globalThis as any).localStorage = storage;
});

afterEach(() => {
  delete (globalThis as any).localStorage;
});

const CONN_A = 'mysql:localhost:3306';
const CONN_B = 'mysql:prod:3306';

const seed = (entries: HistoryEntry[]) => storage.setItem(HISTORY_KEY, JSON.stringify(entries));

describe('matchesConn', () => {
  it('matches the same connection', () => {
    expect(matchesConn({ id: '1', sql: 'a', timestamp: '', conn: CONN_A }, CONN_A)).toBe(true);
    expect(matchesConn({ id: '1', sql: 'a', timestamp: '', conn: CONN_B }, CONN_A)).toBe(false);
  });

  it('keeps entries written before connections were recorded visible everywhere', () => {
    expect(matchesConn({ id: '1', sql: 'a', timestamp: '' }, CONN_A)).toBe(true);
    expect(matchesConn({ id: '1', sql: 'a', timestamp: '' }, CONN_B)).toBe(true);
  });
});

describe('matchesScope', () => {
  const tagged = (conn: string, db: string): HistoryEntry => ({ id: '1', sql: 'a', timestamp: '', conn, db });

  it('db scope keeps only the database in use', () => {
    expect(matchesScope(tagged(CONN_A, 'sakila'), CONN_A, 'sakila', 'db')).toBe(true);
    expect(matchesScope(tagged(CONN_A, 'albums1'), CONN_A, 'sakila', 'db')).toBe(false);
  });

  it('db scope still separates the same database name on two servers', () => {
    expect(matchesScope(tagged(CONN_B, 'sakila'), CONN_A, 'sakila', 'db')).toBe(false);
  });

  it('conn scope keeps every database of that server, but not another server', () => {
    expect(matchesScope(tagged(CONN_A, 'albums1'), CONN_A, 'sakila', 'conn')).toBe(true);
    expect(matchesScope(tagged(CONN_B, 'sakila'), CONN_A, 'sakila', 'conn')).toBe(false);
  });

  it('all scope keeps everything', () => {
    expect(matchesScope(tagged(CONN_B, 'other'), CONN_A, 'sakila', 'all')).toBe(true);
  });

  it('keeps untagged entries visible in every scope', () => {
    const legacy: HistoryEntry = { id: '1', sql: 'a', timestamp: '' };
    expect(matchesScope(legacy, CONN_A, 'sakila', 'db')).toBe(true);
    expect(matchesScope(legacy, CONN_A, 'sakila', 'conn')).toBe(true);
  });

  it('keeps an entry whose database was unknown when it ran', () => {
    expect(matchesScope({ id: '1', sql: 'a', timestamp: '', conn: CONN_A }, CONN_A, 'sakila', 'db')).toBe(true);
  });
});

describe('parseHistoryScope', () => {
  it('defaults to the narrowest scope, including for the value used before db scoping', () => {
    expect(parseHistoryScope(null)).toBe('db');
    expect(parseHistoryScope('current')).toBe('db');
    expect(parseHistoryScope('nonsense')).toBe('db');
  });

  it('round-trips the stored scopes', () => {
    expect(parseHistoryScope('conn')).toBe('conn');
    expect(parseHistoryScope('all')).toBe('all');
  });
});

describe('trimHistory', () => {
  const entry = (id: number, conn: string): HistoryEntry => ({
    id: String(id),
    sql: `select ${id}`,
    timestamp: '',
    conn,
  });

  it('counts the limit per connection so a busy one cannot evict the others', () => {
    const list = [
      ...Array.from({ length: 5 }, (_, i) => entry(i, CONN_A)),
      entry(99, CONN_B),
    ];
    const trimmed = trimHistory(list, 3);
    expect(trimmed.filter(e => e.conn === CONN_A)).toHaveLength(3);
    expect(trimmed.filter(e => e.conn === CONN_B)).toHaveLength(1);
  });

  it('drops the oldest of a connection and keeps the newest-first order', () => {
    const list = [entry(1, CONN_A), entry(2, CONN_B), entry(3, CONN_A), entry(4, CONN_A)];
    expect(trimHistory(list, 2).map(e => e.id)).toEqual(['1', '2', '3']);
  });

  it('treats untagged entries as one group of their own', () => {
    const legacy: HistoryEntry[] = [
      { id: 'l1', sql: 'a', timestamp: '' },
      { id: 'l2', sql: 'b', timestamp: '' },
      entry(1, CONN_A),
    ];
    expect(trimHistory(legacy, 1).map(e => e.id)).toEqual(['l1', '1']);
  });
});

describe('addHistoryEntry', () => {
  it('tags the entry with the connection and database it ran on', () => {
    addHistoryEntry('select 1', CONN_A, 'sakila', '1');
    expect(loadHistory()[0]).toMatchObject({ sql: 'select 1', conn: CONN_A, db: 'sakila' });
  });

  it('returns the id the run was logged under', () => {
    expect(addHistoryEntry('select 1', CONN_A, 'sakila', '1').id).toBe('1');
  });

  it('does not log the same statement twice in a row on one connection', () => {
    addHistoryEntry('select 1', CONN_A, 'sakila', '1');
    addHistoryEntry('select 1', CONN_A, 'sakila', '2');
    expect(loadHistory()).toHaveLength(1);
  });

  it('reuses the existing row for a repeat, so the result lands on the row shown', () => {
    addHistoryEntry('select 1', CONN_A, 'sakila', '1');
    expect(addHistoryEntry('select 1', CONN_A, 'sakila', '2').id).toBe('1');
  });

  it('clears the previous result when a repeat starts running again', () => {
    const first = addHistoryEntry('select 1', CONN_A, 'sakila', '1').id;
    recordHistoryResult(first, { ok: false, ms: 5, error: 'boom' });
    addHistoryEntry('select 1', CONN_A, 'sakila', '2');
    expect(loadHistory()[0].ok).toBeUndefined();
    expect(loadHistory()[0].error).toBeUndefined();
  });

  it('deduplicates per connection: the same statement on another one is still logged', () => {
    addHistoryEntry('select 1', CONN_A, 'sakila', '1');
    addHistoryEntry('select 1', CONN_B, 'sakila', '2');
    expect(loadHistory().map(e => e.id)).toEqual(['2', '1']);
  });

  it('moves a repeat back to the top so the list stays newest-first', () => {
    // The history drawer groups by day off the array order, so a re-run row has to move to the top.
    addHistoryEntry('select 1', CONN_A, 'sakila', '1');
    addHistoryEntry('select 1', CONN_B, 'sakila', '2');
    addHistoryEntry('select 1', CONN_A, 'sakila', '3');
    expect(loadHistory().map(e => e.id)).toEqual(['1', '2']);
  });

  it('ignores blank input', () => {
    addHistoryEntry('   ', CONN_A, 'sakila', '1');
    expect(loadHistory()).toHaveLength(0);
  });

  it('survives a corrupted store instead of throwing', () => {
    storage.setItem(HISTORY_KEY, '{not json');
    addHistoryEntry('select 1', CONN_A, 'sakila', '1');
    expect(loadHistory()).toHaveLength(1);
  });

  it('drops the oldest half rather than losing the new entry when the quota is full', () => {
    seed(Array.from({ length: 4 }, (_, i) => ({
      id: String(i),
      sql: 'select 1',
      timestamp: '',
      conn: CONN_B,
    })));
    // Large enough to write the list with the older half dropped, but not all 5 rows.
    storage.limit = JSON.stringify(JSON.parse(storage.getItem(HISTORY_KEY) as string)).length;

    const { list } = addHistoryEntry('select new', CONN_A, 'sakila', 'new');
    expect(list[0].id).toBe('new');
    expect(list.length).toBeLessThan(5);
    expect(loadHistory()[0].id).toBe('new');
  });
});

describe('recordHistoryResult', () => {
  it('writes the outcome onto the row created when the run started', () => {
    const id = addHistoryEntry('select 1', CONN_A, 'sakila', '1').id;
    recordHistoryResult(id, { ok: true, ms: 37, rows: 200, affected: 0 });
    expect(loadHistory()[0]).toMatchObject({ ok: true, ms: 37, rows: 200 });
  });

  it('truncates a long driver error instead of storing the whole thing', () => {
    const id = addHistoryEntry('select 1', CONN_A, 'sakila', '1').id;
    recordHistoryResult(id, { ok: false, ms: 5, error: 'x'.repeat(ERROR_MAX_LENGTH + 500) });
    expect(loadHistory()[0].error).toHaveLength(ERROR_MAX_LENGTH);
  });

  it('leaves no error field on a successful run', () => {
    const id = addHistoryEntry('select 1', CONN_A, 'sakila', '1').id;
    recordHistoryResult(id, { ok: true, ms: 5 });
    expect(loadHistory()[0].error).toBeUndefined();
  });

  it('does nothing when the row was deleted while the query was running', () => {
    const id = addHistoryEntry('select 1', CONN_A, 'sakila', '1').id;
    deleteHistoryEntry(id);
    expect(recordHistoryResult(id, { ok: true, ms: 5 })).toEqual([]);
  });

  it('leaves the status blank for a run the user stopped', () => {
    const id = addHistoryEntry('select 1', CONN_A, 'sakila', '1').id;
    recordHistoryResult(id, { ms: 12, rows: 40 });
    expect(loadHistory()[0].ok).toBeUndefined();
    expect(loadHistory()[0].ms).toBe(12);
  });

  it('does not touch the other rows', () => {
    const first = addHistoryEntry('select 1', CONN_A, 'sakila', '1').id;
    addHistoryEntry('select 2', CONN_A, 'sakila', '2');
    recordHistoryResult(first, { ok: true, ms: 9 });
    expect(loadHistory().find(e => e.id === '2')?.ok).toBeUndefined();
  });
});

describe('deleteHistoryEntry', () => {
  it('rewrites from the store, so entries added elsewhere are not lost', () => {
    // Simulating two tabs: this one loads the list, then the other adds a new row.
    seed([{ id: 'old', sql: 'select 1', timestamp: '', conn: CONN_A }]);
    const staleCopy = loadHistory();
    addHistoryEntry('select 2', CONN_A, 'sakila', 'fresh');

    const updated = deleteHistoryEntry('old');
    expect(staleCopy.map(e => e.id)).toEqual(['old']); // the stale copy still sees the deleted row
    expect(updated.map(e => e.id)).toEqual(['fresh']);
    expect(loadHistory().map(e => e.id)).toEqual(['fresh']);
  });
});

describe('clearHistory', () => {
  beforeEach(() => {
    seed([
      { id: 'a-sakila', sql: 'select 1', timestamp: '', conn: CONN_A, db: 'sakila' },
      { id: 'a-albums', sql: 'select 2', timestamp: '', conn: CONN_A, db: 'albums1' },
      { id: 'b-sakila', sql: 'select 3', timestamp: '', conn: CONN_B, db: 'sakila' },
      { id: 'legacy', sql: 'select 4', timestamp: '' },
    ]);
  });

  it('clears one database only', () => {
    expect(clearHistory('db', CONN_A, 'sakila').map(e => e.id)).toEqual(['a-albums', 'b-sakila', 'legacy']);
  });

  it('clears every database of one connection', () => {
    expect(clearHistory('conn', CONN_A, 'sakila').map(e => e.id)).toEqual(['b-sakila', 'legacy']);
  });

  it('never deletes untagged entries except in the scope that owns them', () => {
    // They show up in EVERY scope, so deleting them from one db/connection scope would lose the user
    // data in another scope that they never meant to delete.
    expect(clearHistory('db', CONN_A, 'sakila').some(e => e.id === 'legacy')).toBe(true);
    expect(clearHistory('conn', CONN_A, 'sakila').some(e => e.id === 'legacy')).toBe(true);
    expect(clearHistory('all', CONN_A, 'sakila')).toEqual([]);
  });

  it('clears everything at the widest scope', () => {
    expect(clearHistory('all', CONN_A, 'sakila')).toEqual([]);
    expect(loadHistory()).toEqual([]);
  });
});

describe('saved queries', () => {
  it('stores name, connection and database', () => {
    addSavedQuery('Doanh thu', 'select 1', CONN_A, 'sakila', '1');
    expect(loadSavedQueries()[0]).toMatchObject({
      name: 'Doanh thu',
      sql: 'select 1',
      conn: CONN_A,
      db: 'sakila',
    });
  });

  it('keeps duplicates: saving the same SQL under two names is deliberate', () => {
    addSavedQuery('A', 'select 1', CONN_A, 'sakila', '1');
    addSavedQuery('B', 'select 1', CONN_A, 'sakila', '2');
    expect(loadSavedQueries()).toHaveLength(2);
  });

  it('deletes by rewriting from the store', () => {
    addSavedQuery('A', 'select 1', CONN_A, 'sakila', '1');
    addSavedQuery('B', 'select 2', CONN_A, 'sakila', '2');
    expect(deleteSavedQuery('1').map(e => e.id)).toEqual(['2']);
    expect(storage.getItem(SAVED_KEY)).toContain('select 2');
  });
});

describe('importSavedQueries', () => {
  it('adds new queries on top, untagged, and skips what is already saved', () => {
    addSavedQuery('Mine', 'SELECT 1', CONN_A, 'shop', 'x1');
    const res = importSavedQueries([
      { name: 'Mine', sql: 'SELECT 1' },
      { name: 'Theirs', sql: 'SELECT 2' },
    ]);
    expect(res).toEqual({ added: 1, skipped: 1 });
    const list = loadSavedQueries();
    expect(list.map((q) => q.name)).toEqual(['Theirs', 'Mine']);
    // Untagged, so it shows under every connection (matchesScope treats a missing conn as "any").
    expect(list[0].conn).toBeUndefined();
    expect(matchesScope(list[0], CONN_A, 'other', 'db')).toBe(true);
  });

  it('gives every entry of one batch its own id', () => {
    importSavedQueries([{ name: 'a', sql: 'SELECT 1' }, { name: 'b', sql: 'SELECT 2' }]);
    const ids = loadSavedQueries().map((q) => q.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('writes nothing when there is nothing new', () => {
    importSavedQueries([{ name: 'a', sql: 'SELECT 1' }]);
    const before = storage.getItem(SAVED_KEY);
    expect(importSavedQueries([{ name: 'a', sql: 'SELECT 1' }])).toEqual({ added: 0, skipped: 1 });
    expect(storage.getItem(SAVED_KEY)).toBe(before);
  });
});