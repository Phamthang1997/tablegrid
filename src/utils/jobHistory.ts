// What happened to the background jobs of earlier sessions — the answer to "did last night's backup
// finish, and did it fail?" (docs/background-jobs-plan.md, Phase 4).
//
// `jobs.ts` holds the jobs of THIS run and forgets them on reload, deliberately: a job cannot survive
// a restart (Appendix B of the plan — resuming a half-applied restore honestly is not possible). What
// can survive is its outcome, and that is all this module keeps: one small record per finished job,
// in localStorage, newest first.
//
// Same shape as `queryHistory.ts`: every write is a read-modify-write against storage, never a write
// of some in-memory copy, because the standalone terminal window shares this storage. Pure except
// for localStorage and one window event, both guarded, so it runs under Vitest's node environment.

import type { JobKind, JobRecord } from './jobs';

export interface JobHistoryEntry {
  id: string;
  kind: JobKind;
  /** Already translated when the job ran, so it reads in the language of that session. */
  title: string;
  db: string;
  /** `connKey` of the server, when the job knew it — see `connKey.ts`. */
  conn?: string;
  state: 'done' | 'error' | 'cancelled';
  startedAt: number | null;
  endedAt: number;
  message?: string;
  warning?: string;
  error?: string;
  /** The file a dump wrote, for "open folder". */
  path?: string;
  dir?: string;
}

export const JOB_HISTORY_KEY = 'tf_job_history';
export const JOB_HISTORY_CHANGED_EVENT = 'job-history-changed';

/** Enough to cover a week of nightly backups plus whatever else ran, and small enough to never matter for quota. */
export const JOB_HISTORY_MAX = 50;

/**
 * Error and warning texts are capped. A restore's warning lists failing statements and a driver
 * error can carry a whole statement; nobody reads 50KB in a tray row, and the drafts sharing this
 * storage are what `QuotaExceededError` would cost.
 */
export const JOB_HISTORY_TEXT_MAX = 600;

let cache: JobHistoryEntry[] | null = null;

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === JOB_HISTORY_KEY) {
      cache = null;
      notify();
    }
  });
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(JOB_HISTORY_CHANGED_EVENT));
}

function clip(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  return text.length > JOB_HISTORY_TEXT_MAX ? `${text.slice(0, JOB_HISTORY_TEXT_MAX)}…` : text;
}

function isEntry(v: unknown): v is JobHistoryEntry {
  const e = v as JobHistoryEntry;
  return !!e && typeof e.id === 'string' && typeof e.title === 'string' && typeof e.endedAt === 'number';
}

/** Newest first. A stable reference until something changes — safe for `useSyncExternalStore`. */
export function listJobHistory(): JobHistoryEntry[] {
  if (cache) return cache;
  try {
    if (typeof localStorage === 'undefined') return (cache = []);
    const parsed = JSON.parse(localStorage.getItem(JOB_HISTORY_KEY) || '[]');
    // A malformed entry is dropped, not allowed to break the tray: this is a convenience record.
    return (cache = Array.isArray(parsed) ? parsed.filter(isEntry) : []);
  } catch {
    return (cache = []);
  }
}

function write(list: JobHistoryEntry[]): void {
  cache = list;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(JOB_HISTORY_KEY, JSON.stringify(list));
    } catch {
      // Quota: keep the newest half rather than nothing. If even that fails, the history simply does
      // not persist this time — the jobs themselves are unaffected.
      try {
        cache = list.slice(0, Math.ceil(list.length / 2));
        localStorage.setItem(JOB_HISTORY_KEY, JSON.stringify(cache));
      } catch {
        /* skip */
      }
    }
  }
  notify();
}

/** The history entry for a job that just settled, or `null` for one still running. */
export function toHistoryEntry(rec: JobRecord): JobHistoryEntry | null {
  if (rec.state !== 'done' && rec.state !== 'error' && rec.state !== 'cancelled') return null;
  const entry: JobHistoryEntry = {
    id: rec.id,
    kind: rec.kind,
    title: rec.title,
    db: rec.db,
    state: rec.state,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt ?? Date.now(),
  };
  if (rec.conn) entry.conn = rec.conn;
  const message = clip(rec.result?.message);
  const warning = clip(rec.result?.warning);
  const error = clip(rec.error);
  if (message) entry.message = message;
  if (warning) entry.warning = warning;
  if (error) entry.error = error;
  if (rec.result?.path) entry.path = rec.result.path;
  if (rec.result?.dir) entry.dir = rec.result.dir;
  return entry;
}

/** Called by `jobs.ts` when a job settles. A job with the same id replaces its earlier record. */
export function recordJobHistory(rec: JobRecord): void {
  const entry = toHistoryEntry(rec);
  if (!entry) return;
  const rest = listJobHistory().filter((e) => e.id !== entry.id);
  write([entry, ...rest].slice(0, JOB_HISTORY_MAX));
}

export function removeJobHistoryEntry(id: string): void {
  const list = listJobHistory();
  if (!list.some((e) => e.id === id)) return;
  write(list.filter((e) => e.id !== id));
}

export function clearJobHistory(): void {
  write([]);
}

export function subscribeJobHistory(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test seam: forget the parsed copy so the next read goes back to storage. */
export function resetJobHistoryCache(): void {
  cache = null;
  listeners.clear();
}
