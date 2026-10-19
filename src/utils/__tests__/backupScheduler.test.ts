import { beforeEach, describe, expect, it, vi } from 'vitest';

// Everything that would reach Tauri is replaced: this pins the WIRING — which slot is claimed, what
// file is written, what is pruned, what is recorded — not the dump itself, which has its own tests.
const written: { path: string; gzip: boolean; text: string[]; closed: boolean; aborted: boolean }[] = [];
vi.mock('../fileSave', () => ({
  joinPath: (dir: string, name: string) => `${dir}/${name}`,
  openFileSink: vi.fn(async (path: string, gzip: boolean) => {
    const f = { path, gzip, text: [] as string[], closed: false, aborted: false };
    written.push(f);
    return {
      write: async (t: string) => void f.text.push(t),
      close: async () => {
        f.closed = true;
        return path;
      },
      abort: async () => void (f.aborted = true),
    };
  }),
}));
const dump = { fail: false };
vi.mock('../dumpBuilder', () => ({
  writeDump: vi.fn(async (_spec: unknown, _reader: unknown, emit: (t: string) => Promise<void>) => {
    await emit('-- dump\n');
    if (dump.fail) throw new Error('read failed');
  }),
}));
vi.mock('../profileBackup', () => ({
  planDatabaseBackup: vi.fn(async () => ({ spec: {}, reader: {} })),
}));
vi.mock('../connectProfile', () => ({
  loadSavedProfiles: () => [
    { id: 'p1', name: 'prod', type: 'mysql', config: { type: 'mysql', host: 'db', port: 3306, database: 'sakila' } },
  ],
  configWithSecrets: async (p: { config: unknown }) => ({ config: p.config }),
}));
const helper = vi.hoisted(() => ({
  connectJob: vi.fn(async (_config: { database?: string }) => ({ success: true, message: '', connId: 'job1', schema: null })),
  closeJobConnection: vi.fn(async () => undefined),
  pruneBackups: vi.fn(async (_dir: string, _prefix: string, _keep: number) => ({ deleted: ['old.sql.gz'], failed: [] as { name: string; error: string }[] })),
}));
vi.mock('../dbHelper', () => ({ dbHelper: helper }));
vi.mock('../safeMode', () => ({ openJobDoor: () => () => undefined }));

import { listSchedules, newSchedule, resetScheduleCache, saveSchedule, type BackupSchedule } from '../backupSchedule';
import { isScheduleRunning, submitScheduledBackup, tick } from '../backupScheduler';
import { cancelJob, listJobs, startJob } from '../jobs';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

function schedule(patch: Partial<BackupSchedule> = {}): BackupSchedule {
  return {
    ...newSchedule(at(2026, 9, 1), 'p1'),
    id: 's1',
    folder: 'D:/bk',
    prefix: 'sakila prod',
    keep: 3,
    ...patch,
  };
}

const settled = () =>
  vi.waitFor(() => {
    expect(listJobs().every((j) => j.state !== 'running' && j.state !== 'queued')).toBe(true);
  });

beforeEach(() => {
  written.length = 0;
  dump.fail = false;
  vi.clearAllMocks();
  // Not `resetJobs()`: it also drops every `onJobSettled` listener, the scheduler's included.
  // No localStorage under node: the store lives in its cache, so dropping it empties the list.
  resetScheduleCache();
});

describe('backupScheduler', () => {
  it('claims the slot, writes a timestamped file, prunes, and records the result', async () => {
    saveSchedule(schedule({ database: 'sakila_prod' }));
    tick(at(2026, 9, 26, 2, 1));
    expect(listSchedules()[0].lastSlotAt).toBe(at(2026, 9, 26, 2));
    await settled();

    expect(helper.connectJob.mock.calls[0][0].database).toBe('sakila_prod');
    expect(written).toHaveLength(1);
    // The name uses the sanitized prefix ('sakila prod' -> 'sakila_prod'), not the database.
    expect(written[0].path).toMatch(/^D:\/bk\/sakila_prod-\d{8}-\d{6}\.sql\.gz$/);
    expect(written[0].closed).toBe(true);
    // The prefix is sanitized the same way for the name and for the prune.
    expect(helper.pruneBackups).toHaveBeenCalledWith('D:/bk', 'sakila_prod', 3);
    expect(helper.closeJobConnection).toHaveBeenCalledWith('job1');
    const last = listSchedules()[0].last!;
    expect(last.ok).toBe(true);
    expect(isScheduleRunning('s1')).toBe(false);
    // The same slot is not run again.
    tick(at(2026, 9, 26, 2, 5));
    await settled();
    expect(written).toHaveLength(1);
  });

  it('a failed dump removes its partial file, prunes nothing and is recorded as failed', async () => {
    dump.fail = true;
    saveSchedule(schedule());
    tick(at(2026, 9, 26, 2, 1));
    await settled();
    expect(written[0].aborted).toBe(true);
    expect(written[0].closed).toBe(false);
    expect(helper.pruneBackups).not.toHaveBeenCalled();
    expect(listSchedules()[0].last).toMatchObject({ ok: false, message: 'read failed' });
    expect(isScheduleRunning('s1')).toBe(false);
  });

  it('a run cancelled while still queued frees the schedule', async () => {
    // A write job on the same lock keeps the backup queued.
    const blocker = startJob({
      kind: 'restore',
      title: 'restore',
      write: true,
      lockKey: 'br|mysql:db:3306|sakila',
      run: () => new Promise(() => undefined),
    });
    saveSchedule(schedule({ prefix: 'sakila' }));
    expect(submitScheduledBackup(listSchedules()[0])).toBe(true);
    expect(isScheduleRunning('s1')).toBe(true);
    const queued = listJobs().find((j) => j.id !== blocker && j.state === 'queued');
    expect(queued).toBeTruthy();
    cancelJob(queued!.id);
    expect(isScheduleRunning('s1')).toBe(false);
    expect(listSchedules()[0].last?.ok).toBe(false);
    expect(written).toHaveLength(0);
  });
});
