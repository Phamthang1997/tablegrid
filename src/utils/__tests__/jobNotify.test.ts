import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TFunction } from 'i18next';
import {
  NOTIFY_BODY_MAX,
  getJobNotifyEnabled,
  jobNotification,
  setJobNotifyEnabled,
  shouldNotifyJob,
} from '../jobNotify';
import { onJobSettled, resetJobs, startJob, type JobRecord } from '../jobs';

// A `t` that shows which key and values it was asked for, so a test can tell the branches apart
// without depending on the English wording.
const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key}(${Object.values(values).join('|')})` : key) as unknown as TFunction;

const on = { enabled: true, background: true };

describe('shouldNotifyJob', () => {
  it('notifies a finished or failed job while the app is in the background', () => {
    expect(shouldNotifyJob({ state: 'done', startedAt: 1 }, on)).toBe(true);
    expect(shouldNotifyJob({ state: 'error', startedAt: 1 }, on)).toBe(true);
  });

  it('stays quiet while the user is looking at the app — the tray already says it', () => {
    expect(shouldNotifyJob({ state: 'done', startedAt: 1 }, { enabled: true, background: false })).toBe(false);
  });

  it('stays quiet when switched off', () => {
    expect(shouldNotifyJob({ state: 'error', startedAt: 1 }, { enabled: false, background: true })).toBe(false);
  });

  it('never notifies a cancel — the user pressed it — or a job that never ran', () => {
    expect(shouldNotifyJob({ state: 'cancelled', startedAt: 1 }, on)).toBe(false);
    expect(shouldNotifyJob({ state: 'done', startedAt: null }, on)).toBe(false);
    expect(shouldNotifyJob({ state: 'running', startedAt: 1 }, on)).toBe(false);
  });
});

describe('jobNotification', () => {
  const rec = (over: Partial<JobRecord>) =>
    ({ title: 'Backup — sakila', state: 'done', result: null, error: null, ...over }) as JobRecord;

  it('uses the job title and its result message', () => {
    expect(jobNotification(rec({ result: { message: 'Saved to C:/bk.sql' } }), t)).toEqual({
      title: 'Backup — sakila',
      body: 'Saved to C:/bk.sql',
    });
  });

  it('mentions a warning rather than pasting it', () => {
    const n = jobNotification(rec({ result: { message: 'ok', warning: '• 40 failed statements…' } }), t);
    expect(n.body).toBe('ok\njobs.notifyHasWarning');
  });

  it('words a failure, and clips a long driver error', () => {
    const n = jobNotification(rec({ state: 'error', error: 'x'.repeat(2000) }), t);
    expect(n.body.startsWith('jobs.notifyFailed(')).toBe(true);
    expect(n.body.length).toBe(NOTIFY_BODY_MAX + 1);
  });

  it('falls back to "done" when the job returned nothing', () => {
    expect(jobNotification(rec({}), t).body).toBe('jobs.stateDone');
  });
});

describe('the on/off preference', () => {
  const memory = new Map<string, string>();
  beforeEach(() => {
    memory.clear();
    (globalThis as any).localStorage = {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
      removeItem: (k: string) => void memory.delete(k),
    };
  });
  afterEach(() => {
    delete (globalThis as any).localStorage;
  });

  it('is on by default and remembers being turned off', () => {
    expect(getJobNotifyEnabled()).toBe(true);
    setJobNotifyEnabled(false);
    expect(getJobNotifyEnabled()).toBe(false);
    setJobNotifyEnabled(true);
    expect(getJobNotifyEnabled()).toBe(true);
  });
});

describe('onJobSettled', () => {
  beforeEach(() => resetJobs());

  it('hears every settled job once, and a throwing listener does not break settling', async () => {
    const seen: string[] = [];
    onJobSettled(() => { throw new Error('listener broke'); });
    onJobSettled((r) => seen.push(`${r.title}:${r.state}`));
    startJob({ kind: 'dump', title: 'a', lockKey: 'a', run: async () => ({ message: 'm' }) });
    startJob({ kind: 'dump', title: 'b', lockKey: 'b', run: async () => { throw 'boom'; } });
    const until = (check: () => boolean, tries = 50): Promise<void> =>
      check() || tries <= 0
        ? Promise.resolve()
        : new Promise<void>((r) => setTimeout(r, 0)).then(() => until(check, tries - 1));
    await until(() => seen.length === 2);
    expect(seen.sort()).toEqual(['a:done', 'b:error']);
  });
});
