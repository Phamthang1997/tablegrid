// Long operations that keep running after the dialog that started them is gone: export/backup,
// import/restore, data generation, keyspace transfer.
//
// **Module-level, deliberately outside React** — the same shape `queryHistory.ts` and `safeMode.ts`
// use. Two reasons, both mechanical rather than stylistic:
//
//  1. A job has to outlive every dialog, and the dialogs are unmounted by design (they are modal,
//     and the point of this module is that they no longer have to stay open).
//  2. If progress lived in `App`'s state, every progress message would re-render every tab. That is
//     exactly what `SqlEditor`'s 150ms debounce exists to avoid; do not rebuild it here.
//
// Records are **immutable**: a mutation replaces the record and rebuilds the snapshot array, so
// `useSyncExternalStore` sees a new reference and React re-renders. Mutating a record in place
// would leave the snapshot identical and the tray frozen.
//
// This module has no `t()` — it is not a component and cannot hold a hook. Every string it stores
// (`title`, `result.message`, `progress.label`) arrives **already translated** from the call site,
// the same rule `SafeModeRequest.detail` follows.

import { recordJobHistory } from './jobHistory';

export type JobKind = 'dump' | 'restore' | 'generate' | 'export-table' | 'import-table' | 'redis-transfer' | 'copy-db';

/**
 * `queued` -> `running` -> one of `done` / `error` / `cancelled`. A job that is cancelled before it
 * ever starts goes straight to `cancelled` and its `run` is never called.
 */
export type JobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

/** Same shape as `ProgressBar`'s `ProgressState`, so a job can be rendered by the existing bar. */
export interface JobProgress {
  label?: string;
  current?: number;
  total?: number;
  detail?: string;
}

/** What to show when the job is done. Text is already translated — see the module comment. */
export interface JobResult {
  message: string;
  /** File written, when the job produced one — the tray offers "open folder" for it. */
  path?: string;
  dir?: string;
  /** Saved through the webview's download instead of a chosen folder (see `saveExportFile`). */
  viaDownload?: boolean;
  /** Finished, but not cleanly (statements skipped, keys failed). Shown next to the result. */
  warning?: string;
}

export interface JobRecord {
  readonly id: string;
  readonly kind: JobKind;
  /** Already-translated one-line title, e.g. "Backup — sakila". */
  readonly title: string;
  /** Database the job acts on, for display only. */
  readonly db: string;
  /** `connKey` of the server, for the history record (`jobHistory.ts`). Not an identity to act on. */
  readonly conn?: string;
  /** Writes into the database (restore, generate). Decides exclusivity — see `canStart`. */
  readonly write: boolean;
  /** Identity of "the thing being touched": server + database. Two jobs sharing it can conflict. */
  readonly lockKey: string;
  readonly state: JobState;
  readonly progress: JobProgress | null;
  readonly queuedAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly result: JobResult | null;
  readonly error: string | null;
  /** Cancel was asked for; the job may still be winding down. */
  readonly cancelRequested: boolean;
}

/** Handed to `run`. The loop is expected to check `cancelled()` — nothing can interrupt it. */
export interface JobContext {
  readonly id: string;
  /** Publish progress. Coalesced before it reaches subscribers, so calling it per row is fine. */
  report(progress: JobProgress | null): void;
  cancelled(): boolean;
  /** `throw new JobCancelledError()` when cancel was asked for. Call at the top of each iteration. */
  throwIfCancelled(): void;
}

export interface JobSpec {
  kind: JobKind;
  title: string;
  db?: string;
  /** `connKey` of the server the job acts on — kept in the history so an entry says where it ran. */
  conn?: string;
  write?: boolean;
  lockKey?: string;
  /**
   * The work. Runs when the job reaches the front of the queue, not when `startJob` is called.
   * Returning a `JobResult` is how the tray gets something to show; returning nothing is allowed.
   */
  run(ctx: JobContext): Promise<JobResult | void>;
  /**
   * Ask the backend to stop (`cancel_data_generation`, `cancel_query`, …). Optional: a job whose
   * loop lives in TS only needs `ctx.cancelled()`. Not called for a job still queued.
   */
  onCancel?(ctx: JobContext): void | Promise<void>;
}

/** Thrown by `throwIfCancelled()`; a `run` may also throw it directly. Settles the job as cancelled. */
export class JobCancelledError extends Error {
  constructor() {
    super('job cancelled');
    this.name = 'JobCancelledError';
  }
}

/**
 * How many jobs may run at once. Reads (exports) genuinely parallelise, but every one of them holds
 * a pooled connection, so an unbounded fan-out starves the connection the user is typing in.
 */
const MAX_RUNNING = 3;

/** Finished jobs kept for the tray. Older ones are dropped, newest first. */
const KEEP_FINISHED = 20;

/**
 * Progress is published at most this often. A restore reports every 20 statements (`PROGRESS_EVERY`
 * in `database.rs`) and a dump reports per page, so without this the tray would re-render hundreds
 * of times a second on a big run.
 */
const NOTIFY_MS = 150;

interface Entry {
  rec: JobRecord;
  spec: JobSpec;
  ctx: JobContext;
  /** Set by `cancelJob`; read through `ctx.cancelled()`. */
  cancelled: boolean;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

let snapshot: JobRecord[] = [];
let snapshotStale = true;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

function rebuild(): void {
  // Newest first, like query history — the tray reads top-down and the running job is the newest.
  snapshot = [...entries.values()].map((e) => e.rec).sort((a, b) => b.queuedAt - a.queuedAt);
  snapshotStale = false;
}

function flush(): void {
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  if (snapshotStale) rebuild();
  for (const fn of listeners) fn();
}

/** State changes publish at once; progress waits for the window. */
function notify(immediate: boolean): void {
  if (immediate) {
    flush();
    return;
  }
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    flush();
  }, NOTIFY_MS);
}

function patch(id: string, changes: Partial<JobRecord>, immediate: boolean): void {
  const entry = entries.get(id);
  if (!entry) return;
  entry.rec = { ...entry.rec, ...changes } as JobRecord;
  snapshotStale = true;
  notify(immediate);
}

/**
 * Whether `rec` may start now.
 *
 * Two rules. The cap above, and: **a database being written to is exclusive.** Two restores into
 * one database is never what the user meant, and exporting a database while a restore rewrites it
 * produces a torn dump — so a read waits for a write on the same target too. Two reads may share it.
 */
function canStart(rec: JobRecord, running: JobRecord[]): boolean {
  if (running.length >= MAX_RUNNING) return false;
  return !running.some((r) => r.lockKey === rec.lockKey && (r.write || rec.write));
}

function trimFinished(): void {
  const finished = [...entries.values()]
    .filter((e) => e.rec.state === 'done' || e.rec.state === 'error' || e.rec.state === 'cancelled')
    .sort((a, b) => (b.rec.endedAt ?? 0) - (a.rec.endedAt ?? 0));
  for (const e of finished.slice(KEEP_FINISHED)) entries.delete(e.rec.id);
  if (finished.length > KEEP_FINISHED) snapshotStale = true;
}

function settle(id: string, state: JobState, result: JobResult | null, error: string | null): void {
  patch(id, { state, result, error, progress: null, endedAt: Date.now() }, true);
  // Recorded before the trim below can drop it. A job cancelled while still queued never ran, so
  // there is nothing to remember about it — the history answers "what happened", not "what was asked".
  const settled = entries.get(id)?.rec;
  if (settled && settled.startedAt !== null) recordJobHistory(settled);
  if (settled) {
    for (const fn of settledListeners) {
      try {
        fn(settled);
      } catch {
        // A listener (the OS notification) failing must not stop the job from settling.
      }
    }
  }
  trimFinished();
  flush();
}

const settledListeners = new Set<(rec: JobRecord) => void>();

/**
 * Called once for every job that settles — done, error or cancelled, including one cancelled while
 * still queued (`startedAt` null). For side effects that are about the OUTCOME rather than the list,
 * i.e. the OS notification; the tray reads the list through `subscribeJobs` instead.
 */
export function onJobSettled(fn: (rec: JobRecord) => void): () => void {
  settledListeners.add(fn);
  return () => {
    settledListeners.delete(fn);
  };
}

function pump(): void {
  const all = [...entries.values()];
  const running = all.filter((e) => e.rec.state === 'running').map((e) => e.rec);
  const queued = all.filter((e) => e.rec.state === 'queued').sort((a, b) => a.rec.queuedAt - b.rec.queuedAt);

  for (const entry of queued) {
    if (!canStart(entry.rec, running)) continue;
    running.push({ ...entry.rec, state: 'running' } as JobRecord);
    launch(entry);
  }
}

function launch(entry: Entry): void {
  const { id } = entry.rec;
  // Bookkeeping is synchronous (so a second `pump()` in the same tick cannot start it twice), but
  // `run` itself waits for a microtask: `startJob` must return the id before the job can use it.
  patch(id, { state: 'running', startedAt: Date.now() }, true);

  void (async () => {
    await Promise.resolve();
    try {
      const result = await entry.spec.run(entry.ctx);
      if (entry.cancelled) settle(id, 'cancelled', result ?? null, null);
      else settle(id, 'done', result ?? null, null);
    } catch (err: any) {
      if (entry.cancelled || err instanceof JobCancelledError) {
        settle(id, 'cancelled', null, null);
      } else {
        // `dbHelper` rethrows a *string* (so `${err}` reads well) — see its local `invoke`.
        settle(id, 'error', null, typeof err === 'string' ? err : err?.message || String(err));
      }
    } finally {
      pump();
    }
  })();
}

/** Queue a job and return its id. It starts as soon as the cap and the exclusivity rule allow. */
export function startJob(spec: JobSpec): string {
  const id = `job_${Date.now().toString(36)}_${(seq++).toString(36)}`;
  const rec: JobRecord = {
    id,
    kind: spec.kind,
    title: spec.title,
    db: spec.db || '',
    conn: spec.conn || undefined,
    write: !!spec.write,
    lockKey: spec.lockKey || spec.db || '',
    state: 'queued',
    progress: null,
    queuedAt: Date.now(),
    startedAt: null,
    endedAt: null,
    result: null,
    error: null,
    cancelRequested: false,
  };
  const entry: Entry = {
    rec,
    spec,
    cancelled: false,
    ctx: {
      id,
      report: (progress) => {
        // A report arriving after the job settled is dropped rather than resurrecting the bar.
        const e = entries.get(id);
        if (!e || e.rec.state !== 'running') return;
        patch(id, { progress }, false);
      },
      cancelled: () => !!entries.get(id)?.cancelled,
      throwIfCancelled: () => {
        if (entries.get(id)?.cancelled) throw new JobCancelledError();
      },
    },
  };
  entries.set(id, entry);
  snapshotStale = true;
  notify(true);
  pump();
  return id;
}

/**
 * Ask a job to stop. A queued job never runs; a running one is told through `ctx.cancelled()` and
 * `spec.onCancel`, and settles as `cancelled` when its `run` returns or throws.
 */
export function cancelJob(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  if (entry.rec.state === 'queued') {
    entry.cancelled = true;
    settle(id, 'cancelled', null, null);
    pump();
    return;
  }
  if (entry.rec.state !== 'running' || entry.cancelled) return;
  entry.cancelled = true;
  patch(id, { cancelRequested: true }, true);
  try {
    // Backend refusing to cancel must not kill the job — the loop still checks `cancelled()`.
    void Promise.resolve(entry.spec.onCancel?.(entry.ctx)).catch(() => {});
  } catch {
    /* skip */
  }
}

/** Newest first. Stable reference until something changes — safe for `useSyncExternalStore`. */
export function listJobs(): JobRecord[] {
  if (snapshotStale) rebuild();
  return snapshot;
}

export function subscribeJobs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Running **or** queued — what the window-close guard and the tray badge ask about. */
export function activeJobs(): JobRecord[] {
  return listJobs().filter((j) => j.state === 'running' || j.state === 'queued');
}

export function hasActiveJobs(): boolean {
  return activeJobs().length > 0;
}

/** Drop the finished rows from the tray. Running jobs are untouched. */
export function clearFinishedJobs(): void {
  for (const [id, e] of Array.from(entries)) {
    if (e.rec.state !== 'running' && e.rec.state !== 'queued') entries.delete(id);
  }
  snapshotStale = true;
  flush();
}

export function removeJob(id: string): void {
  const entry = entries.get(id);
  if (!entry || entry.rec.state === 'running' || entry.rec.state === 'queued') return;
  entries.delete(id);
  snapshotStale = true;
  flush();
}

/** Test-only: wipe the store. Nothing in the app calls this — a job list is per app run. */
export function resetJobs(): void {
  entries.clear();
  listeners.clear();
  settledListeners.clear();
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  snapshot = [];
  snapshotStale = false;
  seq = 0;
}
