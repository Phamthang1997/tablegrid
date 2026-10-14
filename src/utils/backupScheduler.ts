// Runs the scheduled backups (`backupSchedule.ts` holds the model and decides WHEN). Started once by
// the main window's App; the standalone terminal window never starts it, or every open window would
// dump the same database.
//
// A run is an ordinary background job — the tray shows it, Stop cancels it, the OS notification says
// how it ended when the window is not in front — built from pieces that already exist:
// the profile's secrets (`configWithSecrets`), a job connection of its own (`connectJob`, so the
// user's session and transaction are never touched), the Backup button's dump (`planDatabaseBackup`)
// and the streamed file sink. What is new is only the clock, and the pruning afterwards.

import i18n from '../i18n';
import { dbHelper, type DbConnectionConfig } from './dbHelper';
import { writeDump } from './dumpBuilder';
import { joinPath, openFileSink } from './fileSave';
import { connKey } from './connKey';
import { configWithSecrets, loadSavedProfiles } from './connectProfile';
import { runOnJobConnection } from './jobConnection';
import { JobCancelledError, onJobSettled, startJob } from './jobs';
import { planDatabaseBackup } from './profileBackup';
import {
  backupFileName,
  dueDecision,
  listSchedules,
  patchSchedule,
  sanitizePrefix,
  type BackupSchedule,
} from './backupSchedule';

/** How often the clock is looked at. A slot is at worst this late. */
const TICK_MS = 30 * 1000;
/** The first look after startup waits a little, so a catch-up run does not compete with the app's own start. */
const FIRST_TICK_MS = 15 * 1000;

/** Schedules with a job queued or running — "Run now" and the tick both leave these alone. */
const active = new Set<string>();
/** Job id -> schedule id, for the jobs still unsettled. */
const jobSchedule = new Map<string, string>();

// Freed when the job SETTLES, not at the end of `run`: a job cancelled while still queued never
// runs at all, and freeing it in `run`'s `finally` left that schedule "running" for the rest of
// the session — no tick and no "Run now" would ever touch it again.
onJobSettled((rec) => {
  const id = jobSchedule.get(rec.id);
  if (!id) return;
  jobSchedule.delete(rec.id);
  active.delete(id);
  if (rec.startedAt === null) {
    patchSchedule(id, { last: { at: rec.queuedAt, ok: false, message: i18n.t('backupSchedule.cancelled') } });
  }
});

export function isScheduleRunning(id: string): boolean {
  return active.has(id);
}

/** The database a schedule dumps, as shown to the user. */
export function scheduleDbLabel(s: BackupSchedule, config: DbConnectionConfig | undefined): string {
  if (!config) return s.database || '?';
  if (config.type === 'sqlite') {
    const path = config.sqlitePath || '';
    return path.split(/[\\/]/).pop() || path;
  }
  return s.database || config.database || '';
}

function configFor(s: BackupSchedule, base: DbConnectionConfig): DbConnectionConfig {
  if (base.type === 'sqlite' || !s.database) return base;
  return { ...base, database: s.database };
}

/**
 * Submits one backup of `s` as a job. `slot` is the slot it covers, recorded before the job even
 * queues (see the module comment of `backupSchedule.ts`); `undefined` for "Run now", which claims no
 * slot. Returns false when the schedule already has a job, or its profile is gone.
 */
export function submitScheduledBackup(s: BackupSchedule, slot?: number): boolean {
  if (active.has(s.id)) return false;
  const profile = loadSavedProfiles().find((p) => p.id === s.profileId);
  if (slot !== undefined) patchSchedule(s.id, { lastSlotAt: slot });
  const startedAt = Date.now();
  if (!profile || profile.type === 'redis') {
    patchSchedule(s.id, {
      last: { at: startedAt, ok: false, message: i18n.t('backupSchedule.errProfileGone') },
    });
    return false;
  }
  const baseConfig = profile.config as DbConnectionConfig;
  const dbLabel = scheduleDbLabel(s, baseConfig);
  const server = connKey(configFor(s, baseConfig));
  active.add(s.id);

  const jobId = startJob({
    kind: 'dump',
    title: i18n.t('backupSchedule.jobTitle', { n: dbLabel }),
    db: dbLabel,
    conn: server,
    // Same lock as the Backup button's, so a scheduled run and a restore into that database wait
    // for each other instead of producing a torn dump.
    lockKey: `br|${server}|${dbLabel}`,
    run: async (ctx) => {
      try {
        const { config: withSecrets, warning } = await configWithSecrets(profile);
        const config = configFor(s, withSecrets);
        const connRes = await dbHelper.connectJob(config);
        if (!connRes.success || !connRes.connId) {
          const msg = i18n.t('connection.errConnectFailed', { message: connRes.message });
          throw new Error(warning ? `${msg}\n\n${warning}` : msg);
        }
        const name = backupFileName(s.prefix, startedAt, s.gzip);
        const path = await runOnJobConnection(
          { connId: connRes.connId, schema: connRes.schema ?? null },
          [],
          async ({ connId }) => {
            const { spec, reader } = await planDatabaseBackup(
              connId,
              config.type,
              connRes.schema ?? null,
              { dropTable: true, includeStructure: true, includeContent: true },
              ctx,
            );
            // Straight to the file, no download fallback: a folder that cannot be written is an
            // error to report, not a reason to build the whole dump in memory.
            const sink = await openFileSink(joinPath(s.folder, name), s.gzip);
            try {
              await writeDump(spec, reader, (text) => sink.write(text));
              return await sink.close();
            } catch (err) {
              await sink.abort();
              throw err;
            }
          },
        );

        // Only after the new file is complete, so a failed run never costs an old backup.
        let pruneNote = '';
        try {
          const pruned = await dbHelper.pruneBackups(s.folder, sanitizePrefix(s.prefix), s.keep);
          if (pruned.deleted.length > 0) pruneNote = i18n.t('backupSchedule.pruned', { n: pruned.deleted.length });
          if (pruned.failed.length > 0) {
            pruneNote = i18n.t('backupSchedule.pruneFailed', { n: pruned.failed.length, a: pruned.failed[0].error });
          }
        } catch (e) {
          pruneNote = i18n.t('backupSchedule.pruneFailed', { n: 1, a: String(e) });
        }
        const message = [i18n.t('backupSchedule.done', { n: dbLabel }), pruneNote].filter(Boolean).join(' ');
        patchSchedule(s.id, { last: { at: startedAt, ok: true, message, path } });
        return { message, path, dir: s.folder };
      } catch (err) {
        const cancelled = err instanceof JobCancelledError;
        patchSchedule(s.id, {
          last: {
            at: startedAt,
            ok: false,
            message: cancelled ? i18n.t('backupSchedule.cancelled') : err instanceof Error ? err.message : String(err),
          },
        });
        throw err;
      }
    },
  });
  jobSchedule.set(jobId, s.id);
  return true;
}

/** One look at the clock. Exported for the "Run due now" path and for tests of the wiring. */
export function tick(now = Date.now()): void {
  for (const s of listSchedules()) {
    if (active.has(s.id)) continue;
    const d = dueDecision(s, now);
    if (d.kind === 'skip') {
      patchSchedule(s.id, { lastSlotAt: d.slot });
    } else if (d.kind === 'run') {
      submitScheduledBackup(s, d.slot);
    }
  }
}

let started = false;

/** Starts the clock. Idempotent — React's StrictMode mounts effects twice in development. */
export function startBackupScheduler(): () => void {
  if (started) return () => undefined;
  started = true;
  const first = setTimeout(() => tick(), FIRST_TICK_MS);
  const every = setInterval(() => tick(), TICK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(every);
    started = false;
  };
}
