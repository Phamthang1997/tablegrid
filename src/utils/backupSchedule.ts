/**
 * Scheduled backups: the model, the clock arithmetic and the store. Pure — no Tauri, no React — so
 * everything that decides WHEN a backup runs is tested (`__tests__/backupSchedule.test.ts`). The
 * part that runs one is `backupScheduler.ts`.
 *
 * Three decisions worth knowing:
 * - **The app has to be running.** There is no service or OS task behind this: a backup is built by
 *   the same TypeScript `writeDump` every other dump uses, through a connection only the app can open
 *   (SSH, IAM, the master password). A slot that passes while the app is closed is a MISSED run, and
 *   `catchUp` decides whether it is made up on the next start — once, however many slots were
 *   missed, since three dumps of the same database in a row are worth one.
 * - **A slot is claimed when it starts, not when it succeeds.** `lastSlotAt` moves forward as the job
 *   is submitted, so a backup that fails is reported and retried at the NEXT slot, not every tick
 *   until it works — against a server that is down, that would be a dump attempt every 30 seconds.
 * - **The file name carries the time** (`<prefix>-YYYYMMDD-HHMMSS.sql.gz`), which is what lets
 *   `prune_backups` find this schedule's files, and only them, and order them without trusting mtime.
 */

export type BackupFrequency = 'daily' | 'weekly' | 'hours';

/** Every N hours, from 00:MM. Divisors of 24, so the slots land at the same times every day. */
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;

export interface BackupRunRecord {
  /** When the run started (ms). */
  at: number;
  ok: boolean;
  /** Already translated — the scheduler writes it. */
  message: string;
  path?: string;
}

export interface BackupSchedule {
  id: string;
  enabled: boolean;
  /** A saved connection profile (`tf_connection_profiles`). Its secrets are read at run time. */
  profileId: string;
  /** Database to dump; '' = the profile's own. Ignored for SQLite, where the file IS the database. */
  database: string;
  folder: string;
  /** File name prefix — see `sanitizePrefix`. */
  prefix: string;
  gzip: boolean;
  /** How many of this schedule's files to keep in `folder`; older ones are deleted after a run. */
  keep: number;
  frequency: BackupFrequency;
  /** 'HH:MM', local time. For `hours`, only the minutes are used. */
  time: string;
  /** 0 = Sunday … 6 = Saturday, for `weekly`. */
  weekday: number;
  /** For `hours`: one of `HOUR_STEPS`. */
  everyHours: number;
  /** Make up ONE missed run at startup (the app was closed at the slot). */
  catchUp: boolean;
  createdAt: number;
  /** The slot the last run was started for (ms), so the same slot is never run twice. */
  lastSlotAt?: number;
  last?: BackupRunRecord;
}

/** A run that has not started within this long of its slot counts as missed. */
export const MISSED_AFTER_MS = 10 * 60 * 1000;

export function parseTime(time: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

type SlotRule = Pick<BackupSchedule, 'frequency' | 'time' | 'weekday' | 'everyHours'>;

function stepOf(s: SlotRule): number {
  return HOUR_STEPS.includes(s.everyHours as (typeof HOUR_STEPS)[number]) ? s.everyHours : 24;
}

/**
 * The most recent slot at or before `now`, in ms. Computed on the local calendar with `setHours` /
 * `setDate`, so a slot at 02:30 stays at 02:30 across a DST change instead of drifting by an hour.
 */
export function lastSlot(s: SlotRule, now: number): number {
  const t = parseTime(s.time) ?? { h: 0, m: 0 };
  const d = new Date(now);
  const slot = new Date(now);
  if (s.frequency === 'hours') {
    const step = stepOf(s);
    // The latest hour on the step grid (00:MM, step:MM, …) that is not in the future.
    slot.setHours(d.getHours() - (d.getHours() % step), t.m, 0, 0);
    if (slot.getTime() > now) slot.setHours(slot.getHours() - step, t.m, 0, 0);
    return slot.getTime();
  }
  slot.setHours(t.h, t.m, 0, 0);
  if (s.frequency === 'weekly') {
    slot.setDate(slot.getDate() - ((d.getDay() - s.weekday + 7) % 7));
    if (slot.getTime() > now) slot.setDate(slot.getDate() - 7);
    return slot.getTime();
  }
  if (slot.getTime() > now) slot.setDate(slot.getDate() - 1);
  return slot.getTime();
}

/** The first slot strictly after `now`, for display ("next run"). */
export function nextSlot(s: SlotRule, now: number): number {
  const t = parseTime(s.time) ?? { h: 0, m: 0 };
  const d = new Date(lastSlot(s, now));
  if (s.frequency === 'hours') {
    d.setHours(d.getHours() + stepOf(s), t.m, 0, 0);
  } else {
    d.setDate(d.getDate() + (s.frequency === 'weekly' ? 7 : 1));
    d.setHours(t.h, t.m, 0, 0);
  }
  return d.getTime();
}

export type DueDecision =
  /** Run it now, for this slot. */
  | { kind: 'run'; slot: number; missed: boolean }
  /** A missed slot that is not made up: advance past it without running. */
  | { kind: 'skip'; slot: number }
  | { kind: 'wait' };

/**
 * What the scheduler should do with `s` at `now`. A slot the schedule has not claimed yet
 * (`lastSlotAt`, or its creation time) is either run, or — when it is older than
 * `MISSED_AFTER_MS` and `catchUp` is off — skipped.
 */
export function dueDecision(s: BackupSchedule, now: number): DueDecision {
  if (!s.enabled) return { kind: 'wait' };
  const slot = lastSlot(s, now);
  const claimedUpTo = Math.max(s.lastSlotAt ?? 0, s.createdAt);
  if (slot <= claimedUpTo) return { kind: 'wait' };
  const missed = now - slot > MISSED_AFTER_MS;
  if (missed && !s.catchUp) return { kind: 'skip', slot };
  return { kind: 'run', slot, missed };
}

/** Letters, digits, `_`, `-`, `.` — the set `prune_backups` accepts. Everything else becomes `_`. */
export function sanitizePrefix(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^[.]+/, '')
    .slice(0, 120);
  return cleaned || 'backup';
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `<prefix>-YYYYMMDD-HHMMSS.sql[.gz]`, in local time — the name `prune_backups` recognises. */
export function backupFileName(prefix: string, at: number, gzip: boolean): string {
  const d = new Date(at);
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${sanitizePrefix(prefix)}-${stamp}.sql${gzip ? '.gz' : ''}`;
}

/** Translation keys, resolved by the caller (this module has no `t()`). */
export type ScheduleProblem =
  | 'backupSchedule.errNoProfile'
  | 'backupSchedule.errNoFolder'
  | 'backupSchedule.errTime'
  | 'backupSchedule.errKeep'
  | 'backupSchedule.errSamePrefix';

export const KEEP_MAX = 365;

/**
 * What is wrong with `s`, or null. `others` are the other schedules: two writing the same prefix
 * into the same folder would prune EACH OTHER's files, since the prefix is how a schedule finds its
 * own — so that is refused rather than warned about.
 */
export function validateSchedule(s: BackupSchedule, others: BackupSchedule[]): ScheduleProblem | null {
  if (!s.profileId) return 'backupSchedule.errNoProfile';
  if (!s.folder.trim()) return 'backupSchedule.errNoFolder';
  if (!parseTime(s.time)) return 'backupSchedule.errTime';
  if (!Number.isInteger(s.keep) || s.keep < 1 || s.keep > KEEP_MAX) return 'backupSchedule.errKeep';
  const norm = (f: string) => f.trim().replace(/[\\/]+$/, '').toLowerCase();
  const clash = others.some(
    (o) => o.id !== s.id && norm(o.folder) === norm(s.folder) && sanitizePrefix(o.prefix) === sanitizePrefix(s.prefix),
  );
  return clash ? 'backupSchedule.errSamePrefix' : null;
}

// ===== Store =====
//
// Global, not per connection: a schedule NAMES its profile, and the list is shown whichever
// connection is open (or none). Kept outside React, like `jobs.ts`, because the scheduler reads and
// writes it with no component mounted.

export const SCHEDULES_KEY = 'tf_backup_schedules';

type Listener = () => void;
const listeners = new Set<Listener>();
let cache: BackupSchedule[] | null = null;

function read(): BackupSchedule[] {
  try {
    const raw = localStorage.getItem(SCHEDULES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function listSchedules(): BackupSchedule[] {
  if (!cache) cache = read();
  return cache;
}

function write(next: BackupSchedule[]): void {
  cache = next;
  try {
    localStorage.setItem(SCHEDULES_KEY, JSON.stringify(next));
  } catch {
    /* the in-memory list still holds it for this session */
  }
  for (const fn of listeners) fn();
}

export function subscribeSchedules(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Insert or replace by id. Records are replaced, never mutated — `useSyncExternalStore` needs that. */
export function saveSchedule(s: BackupSchedule): void {
  const all = listSchedules();
  const i = all.findIndex((x) => x.id === s.id);
  write(i < 0 ? [...all, s] : all.map((x) => (x.id === s.id ? s : x)));
}

export function deleteSchedule(id: string): void {
  write(listSchedules().filter((x) => x.id !== id));
}

export function patchSchedule(id: string, patch: Partial<BackupSchedule>): void {
  write(listSchedules().map((x) => (x.id === id ? { ...x, ...patch } : x)));
}

/** For tests: forget the cached list. */
export function resetScheduleCache(): void {
  cache = null;
}

export function newSchedule(now: number, profileId = ''): BackupSchedule {
  return {
    id: `bs_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    enabled: true,
    profileId,
    database: '',
    folder: '',
    prefix: '',
    gzip: true,
    keep: 7,
    frequency: 'daily',
    time: '02:00',
    weekday: 0,
    everyHours: 6,
    catchUp: true,
    createdAt: now,
  };
}
