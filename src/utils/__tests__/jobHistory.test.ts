import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  JOB_HISTORY_KEY,
  JOB_HISTORY_MAX,
  JOB_HISTORY_TEXT_MAX,
  clearJobHistory,
  listJobHistory,
  recordJobHistory,
  removeJobHistoryEntry,
  resetJobHistoryCache,
  toHistoryEntry,
} from '../jobHistory';
import { JobCancelledError, cancelJob, listJobs, resetJobs, startJob, type JobRecord } from '../jobs';

// environment: 'node' has no localStorage, so a fake one stands in — including a quota, because
// the write path has a fallback for it.
class FakeStorage {
  private map = new Map<string, string>();
  /** Throws once a value is longer than this (0 = no limit). */
  limit = 0;
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    if (this.limit && value.length > this.limit) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  (globalThis as any).localStorage = storage;
  resetJobHistoryCache();
  resetJobs();
});

afterEach(() => {
  delete (globalThis as any).localStorage;
});

function rec(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job_1',
    kind: 'dump',
    title: 'Backup — sakila',
    db: 'sakila',
    conn: 'mysql:localhost:3306',
    write: false,
    lockKey: 'k',
    state: 'done',
    progress: null,
    queuedAt: 1,
    startedAt: 10,
    endedAt: 20,
    result: { message: 'ok', path: 'C:/bk/sakila.sql', dir: 'C:/bk' },
    error: null,
    cancelRequested: false,
    ...over,
  };
}

/** Waits until `check()` holds; a job settles after a few ticks, not after a fixed one. */
const until = (check: () => boolean, tries = 200): Promise<void> =>
  check()
    ? Promise.resolve()
    : tries <= 0
      ? Promise.reject(new Error('condition never held'))
      : new Promise<void>((r) => setTimeout(r, 0)).then(() => until(check, tries - 1));

describe('toHistoryEntry', () => {
  it('keeps what the tray shows and nothing live', () => {
    expect(toHistoryEntry(rec())).toEqual({
      id: 'job_1',
      kind: 'dump',
      title: 'Backup — sakila',
      db: 'sakila',
      conn: 'mysql:localhost:3306',
      state: 'done',
      startedAt: 10,
      endedAt: 20,
      message: 'ok',
      path: 'C:/bk/sakila.sql',
      dir: 'C:/bk',
    });
  });

  it('ignores a job that has not settled', () => {
    expect(toHistoryEntry(rec({ state: 'running', endedAt: null }))).toBeNull();
    expect(toHistoryEntry(rec({ state: 'queued', endedAt: null }))).toBeNull();
  });

  it('caps long error and warning texts', () => {
    const long = 'x'.repeat(JOB_HISTORY_TEXT_MAX * 3);
    const e = toHistoryEntry(rec({ state: 'error', result: null, error: long }))!;
    expect(e.error!.length).toBe(JOB_HISTORY_TEXT_MAX + 1);
    expect(e.error!.endsWith('…')).toBe(true);
  });
});

describe('the stored list', () => {
  it('is newest first, and a repeated id replaces its record', () => {
    recordJobHistory(rec({ id: 'a', endedAt: 1 }));
    recordJobHistory(rec({ id: 'b', endedAt: 2 }));
    recordJobHistory(rec({ id: 'a', endedAt: 3, state: 'error', error: 'boom', result: null }));
    expect(listJobHistory().map((e) => [e.id, e.state])).toEqual([['a', 'error'], ['b', 'done']]);
  });

  it(`keeps at most ${JOB_HISTORY_MAX} entries`, () => {
    for (let i = 0; i < JOB_HISTORY_MAX + 7; i++) recordJobHistory(rec({ id: `j${i}` }));
    const list = listJobHistory();
    expect(list).toHaveLength(JOB_HISTORY_MAX);
    expect(list[0].id).toBe(`j${JOB_HISTORY_MAX + 6}`);
  });

  it('survives a reload — it is read back from storage', () => {
    recordJobHistory(rec({ id: 'kept' }));
    resetJobHistoryCache();
    expect(listJobHistory().map((e) => e.id)).toEqual(['kept']);
  });

  it('drops malformed rows instead of breaking', () => {
    storage.setItem(JOB_HISTORY_KEY, JSON.stringify([{ nope: 1 }, toHistoryEntry(rec({ id: 'ok' }))]));
    expect(listJobHistory().map((e) => e.id)).toEqual(['ok']);
    storage.setItem(JOB_HISTORY_KEY, '{not json');
    resetJobHistoryCache();
    expect(listJobHistory()).toEqual([]);
  });

  it('keeps the newest half when the quota is hit', () => {
    for (let i = 0; i < 10; i++) recordJobHistory(rec({ id: `j${i}` }));
    const oneEntry = JSON.stringify([toHistoryEntry(rec({ id: 'j10' }))]).length;
    storage.limit = oneEntry * 7;
    recordJobHistory(rec({ id: 'j10' }));
    resetJobHistoryCache();
    const ids = listJobHistory().map((e) => e.id);
    expect(ids[0]).toBe('j10');
    expect(ids.length).toBe(6);
  });

  it('removes one entry, or all of them', () => {
    recordJobHistory(rec({ id: 'a' }));
    recordJobHistory(rec({ id: 'b' }));
    removeJobHistoryEntry('a');
    expect(listJobHistory().map((e) => e.id)).toEqual(['b']);
    clearJobHistory();
    expect(listJobHistory()).toEqual([]);
  });
});

describe('jobs.ts writes the history', () => {
  it('records a job when it settles, with its server key', async () => {
    const id = startJob({ kind: 'restore', title: 'Restore — x', db: 'x', conn: 'pg:h:5432', run: async () => ({ message: 'done' }) });
    await until(() => listJobHistory().some((e) => e.id === id));
    expect(listJobHistory()[0]).toMatchObject({ id, state: 'done', conn: 'pg:h:5432', message: 'done' });
  });

  it('records failures and cancellations too', async () => {
    const failed = startJob({ kind: 'dump', title: 'f', lockKey: 'a', run: async () => { throw 'nope'; } });
    const stopped = startJob({ kind: 'dump', title: 's', lockKey: 'b', run: async () => { throw new JobCancelledError(); } });
    await until(() => listJobHistory().length === 2);
    const byId = new Map(listJobHistory().map((e) => [e.id, e]));
    expect(byId.get(failed)).toMatchObject({ state: 'error', error: 'nope' });
    expect(byId.get(stopped)).toMatchObject({ state: 'cancelled' });
  });

  it('does not record a job cancelled before it ever ran', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    // Same lock key and both writing -> the second waits in the queue.
    startJob({ kind: 'restore', title: 'first', lockKey: 'db', write: true, run: async () => { await hold; } });
    const queued = startJob({ kind: 'restore', title: 'second', lockKey: 'db', write: true, run: async () => {} });
    expect(listJobs().find((j) => j.id === queued)?.state).toBe('queued');
    cancelJob(queued);
    release();
    await until(() => listJobHistory().length === 1);
    expect(listJobHistory().map((e) => e.title)).toEqual(['first']);
  });
});
