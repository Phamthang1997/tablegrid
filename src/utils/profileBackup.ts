// A whole-database backup on a job connection: the part Connection Manager's Backup button and the
// backup scheduler share. Only "what goes into the dump" lives here — every table, view, routine,
// trigger and event the connection sees — and not where it is written, which differs: the button
// falls back to a download when the folder cannot be written, a scheduled run must not (a silent
// in-memory dump at 2 a.m. that ends in a download nobody sees is worse than an error).

import i18n from '../i18n';
import { dbHelper } from './dbHelper';
import { dumpReaderFor, type DumpReader, type DumpSpec } from './dumpBuilder';
import type { JobContext } from './jobs';

export interface BackupPlan {
  spec: DumpSpec;
  reader: DumpReader;
}

/**
 * Lists what `connId` holds and returns the spec + reader `writeDump`/`buildDump` take. Throws a
 * translated message when there is nothing to back up. Progress and cancel go through `ctx`:
 * throwing from `onProgress` is what stops a dump between two pages.
 */
export async function planDatabaseBackup(
  connId: string,
  dbType: string,
  schema: string | null,
  sqlOptions: DumpSpec['sqlOptions'],
  ctx: JobContext,
): Promise<BackupPlan> {
  // The dump is built by the very code the "Export Database" dialog uses (buildDump): the Backup
  // button used to call the Rust `export_multi_tables`, which treated views as tables (emitting
  // DROP TABLE and INSERT INTO for a view), wrote one INSERT per row, and had no routines or
  // triggers at all.
  const list = await dbHelper.getTables(connId);
  const tables = list.map((item) => item.name);
  if (tables.length === 0) {
    throw new Error(i18n.t('connection.errNoTablesToBackup'));
  }
  const [dbObjs, triggers] = await Promise.all([
    dbHelper.getDatabaseObjects(connId),
    dbHelper.getAllTriggers(connId),
  ]);
  ctx.throwIfCancelled();

  const spec: DumpSpec = {
    dbType,
    tables,
    views: list.filter((item) => item.type === 'view').map((item) => item.name),
    routines: [
      ...dbObjs.functions.map((name) => ({ name, kind: 'function' as const })),
      ...dbObjs.procedures.map((name) => ({ name, kind: 'procedure' as const })),
    ],
    triggers: triggers.map((tr) => tr.name),
    events: dbObjs.events,
    sqlOptions,
    // The schema the job's connect reported as current — the same one getTables() above read from.
    schema,
    onProgress: (p) => {
      ctx.throwIfCancelled();
      ctx.report(p);
    },
  };
  return { spec, reader: dumpReaderFor(dbHelper, connId) };
}
