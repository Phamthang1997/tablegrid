import { beforeEach, describe, expect, it } from 'vitest';
import {
  backupFileName,
  dueDecision,
  lastSlot,
  MISSED_AFTER_MS,
  newSchedule,
  nextSlot,
  parseTime,
  sanitizePrefix,
  validateSchedule,
  type BackupSchedule,
} from '../backupSchedule';

// Local-time dates, since slots are computed on the local calendar.
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

const sched = (patch: Partial<BackupSchedule> = {}): BackupSchedule => ({
  ...newSchedule(at(2026, 9, 1), 'p1'),
  folder: 'C:/backups',
  prefix: 'sakila',
  ...patch,
});

describe('slots', () => {
  it('daily: today at the time once it has passed, otherwise yesterday', () => {
    const s = sched({ frequency: 'daily', time: '02:30' });
    expect(lastSlot(s, at(2026, 9, 26, 3, 0))).toBe(at(2026, 9, 26, 2, 30));
    expect(lastSlot(s, at(2026, 9, 26, 2, 30))).toBe(at(2026, 9, 26, 2, 30));
    expect(lastSlot(s, at(2026, 9, 26, 1, 0))).toBe(at(2026, 9, 25, 2, 30));
    expect(nextSlot(s, at(2026, 9, 26, 3, 0))).toBe(at(2026, 9, 27, 2, 30));
    expect(nextSlot(s, at(2026, 9, 26, 1, 0))).toBe(at(2026, 9, 26, 2, 30));
  });

  it('weekly: the last matching weekday', () => {
    // 2026-09-26 is a Saturday (6).
    const s = sched({ frequency: 'weekly', weekday: 1, time: '23:00' });
    expect(lastSlot(s, at(2026, 9, 26, 12))).toBe(at(2026, 9, 21, 23));
    expect(nextSlot(s, at(2026, 9, 26, 12))).toBe(at(2026, 9, 28, 23));
    // On the weekday itself, before the time: last week's.
    expect(lastSlot(s, at(2026, 9, 28, 22))).toBe(at(2026, 9, 21, 23));
  });

  it('every N hours: on a grid from 00:MM', () => {
    const s = sched({ frequency: 'hours', everyHours: 6, time: '00:15' });
    expect(lastSlot(s, at(2026, 9, 26, 13, 0))).toBe(at(2026, 9, 26, 12, 15));
    expect(lastSlot(s, at(2026, 9, 26, 12, 10))).toBe(at(2026, 9, 26, 6, 15));
    expect(lastSlot(s, at(2026, 9, 26, 0, 5))).toBe(at(2026, 9, 25, 18, 15));
    expect(nextSlot(s, at(2026, 9, 26, 13, 0))).toBe(at(2026, 9, 26, 18, 15));
    expect(nextSlot(s, at(2026, 9, 26, 19, 0))).toBe(at(2026, 9, 27, 0, 15));
  });
});

describe('dueDecision', () => {
  const s = sched({ frequency: 'daily', time: '02:00', createdAt: at(2026, 9, 20) });

  it('runs a slot not yet claimed, once', () => {
    const now = at(2026, 9, 26, 2, 1);
    expect(dueDecision(s, now)).toEqual({ kind: 'run', slot: at(2026, 9, 26, 2), missed: false });
    expect(dueDecision({ ...s, lastSlotAt: at(2026, 9, 26, 2) }, now)).toEqual({ kind: 'wait' });
  });

  it('never runs a slot from before the schedule existed', () => {
    const fresh = { ...s, createdAt: at(2026, 9, 26, 10) };
    expect(dueDecision(fresh, at(2026, 9, 26, 11))).toEqual({ kind: 'wait' });
  });

  it('makes up a missed slot once with catch-up, skips it without', () => {
    const now = at(2026, 9, 26, 9, 0); // app opened long after 02:00
    expect(dueDecision(s, now)).toEqual({ kind: 'run', slot: at(2026, 9, 26, 2), missed: true });
    expect(dueDecision({ ...s, catchUp: false }, now)).toEqual({ kind: 'skip', slot: at(2026, 9, 26, 2) });
    // Several days missed: still ONE run, for the latest slot.
    expect(dueDecision({ ...s, lastSlotAt: at(2026, 9, 21, 2) }, now)).toMatchObject({ slot: at(2026, 9, 26, 2) });
  });

  it('a run a few minutes late is not "missed"', () => {
    const now = at(2026, 9, 26, 2) + MISSED_AFTER_MS - 1000;
    expect(dueDecision({ ...s, catchUp: false }, now)).toMatchObject({ kind: 'run', missed: false });
  });

  it('a disabled schedule waits', () => {
    expect(dueDecision({ ...s, enabled: false }, at(2026, 9, 26, 3))).toEqual({ kind: 'wait' });
  });
});

describe('names and validation', () => {
  beforeEach(() => undefined);

  it('file names carry a sortable local timestamp', () => {
    expect(backupFileName('sakila', at(2026, 9, 6, 2, 5, 9), true)).toBe('sakila-20260906-020509.sql.gz');
    expect(backupFileName('sakila', at(2026, 9, 6, 2, 5, 9), false)).toBe('sakila-20260906-020509.sql');
  });

  it('prefixes are cleaned to what prune_backups accepts', () => {
    expect(sanitizePrefix(' my db/prod ')).toBe('my_db_prod');
    expect(sanitizePrefix('../x')).toBe('_x');
    expect(sanitizePrefix('cơ sở')).toBe('c_s_');
    expect(sanitizePrefix('   ')).toBe('backup');
  });

  it('times are HH:MM', () => {
    expect(parseTime('2:05')).toEqual({ h: 2, m: 5 });
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('ab')).toBeNull();
  });

  it('refuses two schedules pruning each other', () => {
    const a = sched({ id: 'a' });
    const b = sched({ id: 'b', folder: 'C:/backups/' });
    expect(validateSchedule(b, [a])).toBe('backupSchedule.errSamePrefix');
    expect(validateSchedule({ ...b, prefix: 'other' }, [a])).toBeNull();
    expect(validateSchedule({ ...b, keep: 0 }, [])).toBe('backupSchedule.errKeep');
    expect(validateSchedule({ ...b, folder: ' ' }, [])).toBe('backupSchedule.errNoFolder');
    expect(validateSchedule({ ...b, profileId: '' }, [])).toBe('backupSchedule.errNoProfile');
  });
});
