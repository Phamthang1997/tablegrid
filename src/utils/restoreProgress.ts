// Turns `restore_backup`'s progress messages into something a progress bar can show.
//
// Two screens run a restore — the Import Database dialog and Connection Manager's Restore — and
// both now run it as a background job, so the label, the counter and the ETA are computed here
// instead of once per screen. The ETA needs a start time, hence a factory: the returned function
// keeps its own, and one restore is one reporter.
//
// Module-level, so no hook: `t` is passed in, the same way `formatRestoreEta` already took it.

import type { TFunction } from 'i18next';
import type { JobProgress, JobResult } from './jobs';

/**
 * What the tray says about a restore the user stopped.
 *
 * The statements that ran were rolled back — except on MySQL, which commits implicitly on every
 * CREATE/DROP/ALTER, so the tables the dump had already created are still there, empty or not. That
 * is said out loud rather than promising a clean undo the server did not do.
 */
export function restoreCancelledResult(
  t: TFunction,
  res: { statementsCount?: number; dialect?: string },
): JobResult {
  return {
    message: t('jobs.restoreCancelled', { n: (res.statementsCount || 0).toLocaleString() }),
    warning: res.dialect === 'mysql' ? t('jobs.restoreCancelledMysql') : undefined,
  };
}

/** Message shape `restore_backup` sends over its Channel. */
export interface RestoreProgressMsg {
  type: string;
  done?: number;
  total?: number;
  statementsCount?: number;
}

/**
 * Seconds -> "12 seconds" / "2 min 5 sec".
 * Takes `t` because it is module-level and cannot call the hook itself.
 */
export function formatRestoreEta(t: TFunction, totalSeconds: number): string {
  const s = Math.max(1, Math.round(totalSeconds));
  if (s < 60) return t('connection.etaSeconds', { s });
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? t('connection.etaMinutesSeconds', { m, s: rest }) : t('connection.etaMinutes', { m });
  const h = Math.floor(m / 60);
  const restM = m % 60;
  return restM ? t('connection.etaHoursMinutes', { h, m: restM }) : t('connection.etaHours', { h });
}

/**
 * One reporter per restore. Returns `null` for a message that carries nothing to show, so a caller
 * can pass it straight to `ctx.report`.
 *
 * ETA comes from the rate actually observed, not from a guess per statement: a dump is a few DDL
 * statements and then thousands of INSERTs, so any fixed per-statement estimate is wrong at both
 * ends of the run.
 */
export function makeRestoreReporter(t: TFunction): (msg: RestoreProgressMsg) => JobProgress {
  const startedAt = Date.now();
  return (msg) => {
    const done = msg.done ?? 0;
    const total = msg.total ?? 0;

    if (msg.type === 'start') {
      return { label: t('connection.restoreRunning', { n: total.toLocaleString() }), current: 0, total };
    }

    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = done > 0 ? done / elapsed : 0;
    const remain = rate > 0 && total > done ? Math.round((total - done) / rate) : 0;
    const counts = { done: done.toLocaleString(), total: total.toLocaleString() };
    return {
      label: t('connection.restoreInProgress'),
      current: done,
      total,
      detail: remain > 0
        ? t('connection.restoreDetailEta', { ...counts, eta: formatRestoreEta(t, remain) })
        : t('connection.restoreDetail', counts),
    };
  };
}
