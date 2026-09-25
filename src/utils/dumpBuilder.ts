// Builds the contents of a .sql dump for both of the app's export paths.
//
// There used to be TWO versions: this code inside `App.tsx` (the "Export Database" dialog) and a
// Rust `export_multi_tables` (Connection Manager -> Backup). The Rust one did not tell views from
// tables, so it emitted `DROP TABLE`/`INSERT INTO` for a view, wrote one `INSERT` per row, could
// not report progress, and of course had no routines or triggers. Every fix made for the dialog
// missed the Backup button — so the Rust one was deleted and both places now call `buildDump()`.
//
// Database access comes in through the `reader` parameter rather than importing `dbHelper`: that
// keeps this module free of `@tauri-apps/api`, which is what makes the statement order in a dump —
// the most fragile and most important part of it — checkable by unit test.
import i18n from '../i18n';
import type { SchemaInfo } from './dbHelper';
import { buildSql, isBinaryType, orderViewsByDependency, stripDefiner, wrapMysqlDelimiter } from './exportHelper';

/** Rows read per call while pulling a table's data. */
export const EXPORT_PAGE_SIZE = 2000;

/** The part of dbHelper building a dump needs. `dbHelper` already matches this shape. */
export interface DumpReader {
  getTableDefinition(name: string): Promise<{ success: boolean; sql?: string; error?: string }>;
  getTableSchema(tableName: string): Promise<SchemaInfo>;
  getTableData(
    tableName: string,
    page?: number,
    pageSize?: number
  ): Promise<{ rows: any[]; totalCount: number | null }>;
  getObjectDefinition(
    name: string,
    kind: 'view' | 'function' | 'procedure' | 'table' | 'event'
  ): Promise<{ success: boolean; sql?: string; error?: string }>;
  getAllTriggers(): Promise<{ name: string; table: string; statement: string }[]>;
  getTableDdlExtras(tableName: string): Promise<{
    sequences: string[];
    indexes: string[];
    constraints: string[];
    comments: string[];
    sequenceValues: string[];
  }>;
}

/**
 * `dbHelper` bound to one connection, in the shape `buildDump` wants.
 *
 * `DumpReader` is deliberately an injected interface — that is what keeps `dumpBuilder` free of
 * `@tauri-apps/api` and unit-testable. Now that every read takes a `conn_id`, `dbHelper` no longer
 * *is* a `DumpReader`; this adapts it into one for a given connection, in one place, instead of
 * widening the interface with an id it has no use for.
 */
export function dumpReaderFor(
  db: {
    getTableDefinition(connId: string, name: string): Promise<{ success: boolean; sql?: string; error?: string }>;
    getTableSchema(connId: string, tableName: string): Promise<SchemaInfo>;
    getTableData(connId: string, tableName: string, page?: number, pageSize?: number): Promise<{ rows: any[]; totalCount: number | null }>;
    getObjectDefinition(connId: string, name: string, kind: 'view' | 'function' | 'procedure' | 'table' | 'event'): Promise<{ success: boolean; sql?: string; error?: string }>;
    getAllTriggers(connId: string): Promise<{ name: string; table: string; statement: string }[]>;
    getTableDdlExtras(connId: string, tableName: string): Promise<{
      sequences: string[]; indexes: string[]; constraints: string[]; comments: string[]; sequenceValues: string[];
    }>;
  },
  connId: string,
): DumpReader {
  return {
    getTableDefinition: (name) => db.getTableDefinition(connId, name),
    getTableSchema: (t) => db.getTableSchema(connId, t),
    getTableData: (t, page, pageSize) => db.getTableData(connId, t, page, pageSize),
    getObjectDefinition: (name, kind) => db.getObjectDefinition(connId, name, kind),
    getAllTriggers: () => db.getAllTriggers(connId),
    getTableDdlExtras: (t) => db.getTableDdlExtras(connId, t),
  };
}

export interface DumpProgress {
  label: string;
  current?: number;
  total?: number;
  detail?: string;
}

export interface DumpSpec {
  dbType: string;
  /** Tables AND views (same as `DatabaseExportOptions.tables`). */
  tables: string[];
  /** Which names in `tables` are views. */
  views: string[];
  routines: { name: string; kind: 'function' | 'procedure' }[];
  triggers: string[];
  /** MySQL scheduled events — written in the same DELIMITER block as the routines. */
  events?: string[];
  /**
   * The Postgres schema this dump was read from. Used only to write the header (see `dumpHeader`);
   * every DDL inside still carries a bare name, so the file can be imported into a differently named
   * schema.
   */
  schema?: string | null;
  sqlOptions: { dropTable: boolean; includeStructure: boolean; includeContent: boolean };
  onProgress?: (p: DumpProgress) => void;
}

const fmtNum = (n: number) => n.toLocaleString(i18n.language);

/** A Postgres identifier in generated SQL: always double-quoted, with inner double quotes doubled. */
function quotePgIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The session-level statements that open a dump file.
 *
 * The app's own `restore_backup` already handles encoding and foreign keys, so these lines are NOT
 * there for the Import button — they are there so the file still runs under `mysql < dump.sql`,
 * `psql -f` or `sqlite3 <` outside the app. Out there nobody turns FK checks off for you, and
 * tables are exported alphabetically, so `city` referencing `country` breaks immediately.
 *
 * `restore_backup`'s per-table filter lets `SET …` and `PRAGMA …` through unconditionally and
 * treats their failures as non-fatal (`is_session_level_stmt`), so a dump from another dialect does
 * not die on these lines either.
 *
 * `schema` (Postgres only, and only when it is not `public`): a file exported from schema `sales`
 * and re-imported without these two lines puts every object into whatever schema comes first in the
 * target's `search_path` — usually `public` — that is, **imported into the wrong place with no
 * error at all**. Writing it in the header rather than qualifying each DDL is deliberate: with bare
 * names plus `search_path`, the user retargets the whole dump by editing one line, while qualified
 * names would mean editing the entire file. `CREATE SCHEMA IF NOT EXISTS` comes along because
 * `SET search_path` to a schema that does not exist is valid but useless — the `CREATE TABLE` right
 * after it fails. Both are in `restore_backup`'s "session level" list (`is_session_level_stmt`) and
 * so always run, even when the user selected only a few tables.
 */
function dumpHeader(dbType: string, schema?: string | null): string[] {
  if (dbType === 'mysql') {
    return [
      'SET NAMES utf8mb4;',
      'SET FOREIGN_KEY_CHECKS = 0;',
      // Without this line, a 0 in an AUTO_INCREMENT column is read as "generate one for me" and the
      // re-imported database numbers things quite differently from the original. mysqldump sets the
      // same flag.
      "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
      '',
    ];
  }
  if (dbType === 'postgres') {
    const sch = (schema || '').trim();
    return [
      "SET client_encoding = 'UTF8';",
      // Binary literals are written as '\xAB12'::bytea — with this flag off, \ becomes an escape
      // character and every BLOB comes back with the wrong contents.
      'SET standard_conforming_strings = on;',
      // `public` is not written out: it is already the default of every search_path, and leaving it
      // out keeps a dump from an ordinary database byte-identical to what it was before schema
      // support existed.
      ...(sch && sch !== 'public'
        ? [
            `CREATE SCHEMA IF NOT EXISTS ${quotePgIdent(sch)};`,
            `SET search_path TO ${quotePgIdent(sch)};`,
          ]
        : []),
      '',
    ];
  }
  // SQLite: inside a transaction this PRAGMA is a no-op (SQLite says so), so it only does anything
  // when the file is run through the sqlite3 CLI — which is exactly where it is needed.
  return ['PRAGMA foreign_keys = OFF;', ''];
}

/** Puts the session state back once loading is done. */
function dumpFooter(dbType: string): string[] {
  if (dbType === 'mysql') return ['SET FOREIGN_KEY_CHECKS = 1;'];
  if (dbType === 'postgres') return [];
  return ['PRAGMA foreign_keys = ON;'];
}

/**
 * Reads all of a table's rows, page by page.
 *
 * Progress: the outer level is tables finished (plus the running table's percentage), and the
 * sub-line is the percentage of rows within that table. Paged rather than fetched in one go: the
 * old limit of 100,000 rows meant a large table was exported incomplete with nothing said.
 */
export async function readTableRows(
  reader: Pick<DumpReader, 'getTableData'>,
  table: string,
  tableIndex: number,
  total: number,
  onProgress?: (p: DumpProgress) => void
): Promise<any[]> {
  const rows: any[] = [];
  await readTablePages(reader, table, tableIndex, total, onProgress, (batch) => {
    rows.push(...batch);
  });
  return rows;
}

/** What `readTablePages` knows about a page when it hands it over. */
export interface TablePageInfo {
  /** The table's exact row count, when the backend reported one. */
  totalRows: number | null;
  /** No page follows. True on the first call for a table that fits in one page. */
  last: boolean;
}

/**
 * `readTableRows`, one page at a time: `onPage` receives each page as soon as it is read, and the
 * rows are not kept. This is what lets a dump of a table far larger than memory be written — a page
 * becomes INSERT statements and goes to disk before the next one is read.
 */
export async function readTablePages(
  reader: Pick<DumpReader, 'getTableData'>,
  table: string,
  tableIndex: number,
  total: number,
  onProgress: ((p: DumpProgress) => void) | undefined,
  onPage: (rows: any[], info: TablePageInfo) => void | Promise<void>,
): Promise<number> {
  let seen = 0;
  let page = 1;
  let totalRows = 0;
  for (;;) {
    const data = await reader.getTableData(table, page, EXPORT_PAGE_SIZE);
    const batch = data.rows || [];
    seen += batch.length;
    if (!totalRows && data.totalCount) totalRows = data.totalCount;
    const inner = totalRows ? Math.min(1, seen / totalRows) : 0;
    onProgress?.({
      label: i18n.t('app.exportTableProgress', { i: tableIndex + 1, total, table }),
      current: tableIndex + inner,
      total,
      detail: totalRows
        ? i18n.t('app.exportRowsPct', {
            rows: fmtNum(seen),
            total: fmtNum(totalRows),
            pct: Math.round(inner * 100),
          })
        : i18n.t('app.exportRows', { rows: fmtNum(seen) }),
    });
    const last = batch.length < EXPORT_PAGE_SIZE || (!!totalRows && seen >= totalRows);
    await onPage(batch, { totalRows: totalRows || null, last });
    if (last) break;
    page++;
  }
  return seen;
}

/**
 * The whole contents of the .sql file.
 *
 * The statement order is the most meaningful thing here — **tables -> views -> routines ->
 * triggers**:
 *   - `CREATE VIEW` is validated as it runs, so a view placed before the table it SELECTs from
 *     fails outright (MySQL 1146). The object list is alphabetical, which once put sakila's
 *     `actor_info` view second, long before the `film` table.
 *   - Among the views the order comes from their dependencies (`orderViewsByDependency`), because a
 *     view can read another view.
 *   - Routines and triggers come last: their bodies read tables, and a trigger may call a function.
 * Views carry NO data: `INSERT INTO <view>` fails on a non-updatable view, and those rows are
 * already in the base tables anyway.
 */
export async function buildDump(spec: DumpSpec, reader: DumpReader): Promise<string> {
  const chunks: string[] = [];
  await writeDump(spec, reader, (text) => {
    chunks.push(text);
  });
  // Every chunk ends in '\n' (see `flush`); the single string this returned before streaming
  // existed did not, and the tests pin that exact text.
  return chunks.join('').slice(0, -1);
}

/**
 * `buildDump`, written out a piece at a time instead of returned as one string.
 *
 * `emit` receives the dump in order, in chunks that each end in '\n': the header, then each table
 * (its DDL, then one chunk per PAGE of its data), then the constraints, views, routines and
 * triggers. A chunk boundary always falls between two statements, never inside one — that is what
 * makes it safe to write each chunk straight to a file. `emit` is awaited before anything else is
 * read, so a slow disk slows the export down instead of letting unwritten chunks pile up in memory.
 *
 * Throwing from `onProgress` (a cancelled job does) stops the dump between two pages.
 */
export async function writeDump(
  spec: DumpSpec,
  reader: DumpReader,
  emit: (text: string) => void | Promise<void>,
): Promise<void> {
  const { onProgress, sqlOptions } = spec;
  const isMysql = spec.dbType === 'mysql';
  const isPostgres = spec.dbType === 'postgres';
  const q = isMysql ? '`' : '"';

  // Routines and triggers have no data, only a definition -> with "include structure" off there is
  // nothing left of them to export. Counted into the total so the progress bar does not sit at 100%
  // while work continues.
  const routineList = sqlOptions.includeStructure ? spec.routines : [];
  const triggerList = sqlOptions.includeStructure ? spec.triggers : [];
  const eventList = sqlOptions.includeStructure ? spec.events || [] : [];
  const total = spec.tables.length + routineList.length + triggerList.length + eventList.length;

  const parts: string[] = [
    '-- Database Backup generated by TableGrid',
    `-- Date: ${new Date().toISOString()}`,
    '',
    ...dumpHeader(spec.dbType, spec.schema),
  ];
  /** Hands everything collected so far to `emit` and forgets it. See `writeDump`. */
  const flush = async () => {
    if (parts.length === 0) return;
    const text = parts.join('\n') + '\n';
    parts.length = 0;
    await emit(text);
  };

  const viewSet = new Set(spec.views.map((v) => v.toLowerCase()));
  const baseTables = spec.tables.filter((name) => !viewSet.has(name.toLowerCase()));
  const viewList = spec.tables.filter((name) => viewSet.has(name.toLowerCase()));

  // ALTER TABLE ... ADD CONSTRAINT is collected here and written once every table exists (see the push).
  const deferredConstraints: string[] = [];
  // A sequence's setval(): has to run after the data is in, because it reads the table's MAX().
  const deferredSequenceValues: string[] = [];

  const schemaFailed = (name: string, message?: string) =>
    i18n.t('app.exportSchemaFailed', {
      table: `${q}${name}${q}`,
      message: message || i18n.t('app.exportUnknownReason'),
    });

  for (let i = 0; i < baseTables.length; i++) {
    const table = baseTables[i];
    onProgress?.({
      label: i18n.t('app.exportTableProgress', { i: i + 1, total, table }),
      current: i,
      total,
      detail: i18n.t('app.exportReadingSchema'),
    });

    // The things that belong to a table but are not in that dialect's CREATE TABLE (indexes, FKs,
    // comments, sequences). MySQL returns nothing, because SHOW CREATE TABLE already carries it all.
    const extras = sqlOptions.includeStructure
      ? await reader.getTableDdlExtras(table)
      : { sequences: [], indexes: [], constraints: [], comments: [], sequenceValues: [] };
    // Foreign keys can only be added once EVERY table exists — tables are exported alphabetically,
    // so `city` referencing `country` would fail if the FK were attached in place.
    deferredConstraints.push(...extras.constraints);

    if (sqlOptions.dropTable) {
      parts.push(`DROP TABLE IF EXISTS ${q}${table}${q};`);
    }
    if (sqlOptions.includeStructure) {
      const def = await reader.getTableDefinition(table);
      if (def.success && def.sql) {
        parts.push(`-- Structure for table ${q}${table}${q}`);
        // Sequences come BEFORE the table: a serial column has DEFAULT nextval('...') and Postgres
        // checks it right at CREATE TABLE, so a missing sequence kills the restore at the first table.
        parts.push(...extras.sequences);
        const sql = def.sql.trim();
        parts.push(sql.endsWith(';') ? sql : sql + ';');
        parts.push(...extras.indexes);
        parts.push(...extras.comments);
      } else {
        parts.push(schemaFailed(table, def.error));
      }
      parts.push('');
    }
    if (sqlOptions.includeContent) {
      // Page by page: each page becomes INSERTs and is flushed before the next is read, so the
      // table is never in memory as a whole (Phase 3 of docs/background-jobs-plan.md). A page is
      // EXPORT_PAGE_SIZE rows, a multiple of `buildSql`'s rows-per-INSERT, so the statements come
      // out the same as when the whole table was batched at once.
      let shape: { cols: string[]; binaryCols: Set<string>; needsOverriding: boolean } | null = null;
      await readTablePages(reader, table, i, total, onProgress, async (rows, info) => {
        if (rows.length === 0) return;
        if (!shape) {
          const schema = await reader.getTableSchema(table);
          const schemaCols = schema.columns || [];
          // GENERATED/IDENTITY columns are dropped from the INSERT: the database computes them, and
          // writing to one is an error (MySQL 3105; Postgres demands OVERRIDING SYSTEM VALUE) that
          // rolls back the entire import.
          const colNames = schemaCols.filter((c) => !c.generated).map((c) => c.name);
          shape = {
            cols: colNames.length ? colNames : Object.keys(rows[0]),
            // A binary cell arrives as a byte array; unmarked, JSON.stringify turns it into
            // '[137,80,78,71,...]' and the original file is effectively lost.
            binaryCols: new Set(
              schemaCols.filter((c) => isBinaryType(c.type, spec.dbType)).map((c) => c.name)
            ),
            // An identity column is the OPPOSITE of a generated one: kept in the INSERT so the
            // original ids survive, but the statement has to ask permission to override.
            needsOverriding: schemaCols.some((c) => c.identityAlways),
          };
          // The row count is written before the rows exist on the page: exact when the table fits
          // in one page, the backend's count otherwise. It is a comment — nothing replays it.
          const count = info.last ? rows.length : (info.totalRows ?? '?');
          parts.push(i18n.t('app.exportDataComment', { table: `${q}${table}${q}`, rows: count }));
        }
        parts.push(buildSql(table, shape.cols, rows, spec.dbType, shape.binaryCols, shape.needsOverriding));
        await flush();
      });
      if (shape) parts.push('');
      deferredSequenceValues.push(...extras.sequenceValues);
    }
    onProgress?.({
      label: i18n.t('app.exportTableProgress', { i: i + 1, total, table }),
      current: i + 1,
      total,
      detail: i18n.t('app.exportTableDone'),
    });
    await flush();
  }

  // Foreign keys and the other table-level constraints: attachable only once EVERY table exists.
  if (deferredConstraints.length > 0) {
    parts.push('-- Constraints');
    parts.push(...deferredConstraints);
    parts.push('');
  }
  // setval() reads the MAX() of the data just loaded -> it must come after every INSERT. Without it
  // the sequence falls back to 1 and the next inserted row collides with the primary key.
  if (deferredSequenceValues.length > 0) {
    parts.push('-- Sequence values');
    parts.push(...deferredSequenceValues);
    parts.push('');
  }

  // Views: definitions only. With "include structure" off a view has nothing left to export, and its
  // DROP has to fall silent with it — a DROP VIEW with no CREATE VIEW simply deletes it.
  if (sqlOptions.includeStructure && viewList.length > 0) {
    const viewDefs: { name: string; sql: string }[] = [];
    for (let i = 0; i < viewList.length; i++) {
      const view = viewList[i];
      const step = baseTables.length + i;
      onProgress?.({
        label: i18n.t('app.exportTableProgress', { i: step + 1, total, table: view }),
        current: step,
        total,
        detail: i18n.t('app.exportReadingSchema'),
      });
      const def = await reader.getTableDefinition(view);
      if (def.success && def.sql) {
        const sql = def.sql.trim();
        viewDefs.push({ name: view, sql: sql.endsWith(';') ? sql : sql + ';' });
      } else {
        parts.push(schemaFailed(view, def.error));
      }
      onProgress?.({
        label: i18n.t('app.exportTableProgress', { i: step + 1, total, table: view }),
        current: step + 1,
        total,
        detail: i18n.t('app.exportTableDone'),
      });
    }

    const cascade = isPostgres ? ' CASCADE' : '';
    for (const view of orderViewsByDependency(viewDefs)) {
      if (sqlOptions.dropTable) {
        // A materialized view needs the word MATERIALIZED in its DROP; detected from the DDL just
        // fetched, which saves threading a "kind" field through the whole call chain.
        const isMatView = /^\s*CREATE\s+MATERIALIZED\s+VIEW\b/i.test(view.sql);
        const kw = isMatView ? 'MATERIALIZED VIEW' : 'VIEW';
        parts.push(`DROP ${kw} IF EXISTS ${q}${view.name}${q}${cascade};`);
      }
      parts.push(`-- Structure for view ${q}${view.name}${q}`);
      parts.push(stripDefiner(view.sql));
      parts.push('');
    }
  }

  if (routineList.length > 0 || triggerList.length > 0 || eventList.length > 0) {
    const drops: string[] = [];
    const creates: string[] = [];
    let step = baseTables.length + viewList.length;

    const reportStep = (name: string, done: boolean) => {
      onProgress?.({
        label: i18n.t('app.exportObjectProgress', { i: step + 1, total, name }),
        current: done ? step + 1 : step,
        total,
        detail: done ? i18n.t('app.exportTableDone') : i18n.t('app.exportReadingSchema'),
      });
    };

    for (const routine of routineList) {
      reportStep(routine.name, false);
      const def = await reader.getObjectDefinition(routine.name, routine.kind);
      if (def.success && def.sql) {
        // Postgres needs no DROP: pg_get_functiondef() returns CREATE OR REPLACE FUNCTION, and a
        // DROP FUNCTION here would need the parameter signature to remove the right overload.
        if (sqlOptions.dropTable && isMysql) {
          const kw = routine.kind === 'function' ? 'FUNCTION' : 'PROCEDURE';
          drops.push(`DROP ${kw} IF EXISTS ${q}${routine.name}${q};`);
        }
        // pg_get_functiondef() returns a definition with NO trailing ';', unlike MySQL's SHOW
        // CREATE — without one the next statement runs into it. The DELIMITER wrapper strips it again.
        const sql = stripDefiner(def.sql.trim());
        creates.push(sql.endsWith(';') ? sql : sql + ';');
      } else {
        parts.push(schemaFailed(routine.name, def.error));
      }
      reportStep(routine.name, true);
      step++;
    }

    // Events exist only on MySQL, and a body (`DO BEGIN ... END`) carries its own ';' just as a
    // routine does, so they share the DELIMITER block below.
    for (const name of eventList) {
      reportStep(name, false);
      const def = await reader.getObjectDefinition(name, 'event');
      if (def.success && def.sql) {
        if (sqlOptions.dropTable) {
          drops.push(`DROP EVENT IF EXISTS ${q}${name}${q};`);
        }
        const sql = stripDefiner(def.sql.trim());
        creates.push(sql.endsWith(';') ? sql : sql + ';');
      } else {
        parts.push(schemaFailed(name, def.error));
      }
      reportStep(name, true);
      step++;
    }

    // The CREATE TRIGGER statements are fetched once for the whole database (get_all_triggers);
    // Postgres also needs the owning table name, because its DROP TRIGGER requires `ON <table>`.
    const allTriggers = triggerList.length > 0 ? await reader.getAllTriggers() : [];
    const triggerByName = new Map(allTriggers.map((tr) => [tr.name, tr]));
    for (const name of triggerList) {
      reportStep(name, false);
      const tr = triggerByName.get(name);
      if (tr && tr.statement) {
        if (sqlOptions.dropTable) {
          drops.push(
            isPostgres
              ? `DROP TRIGGER IF EXISTS ${q}${name}${q} ON ${q}${tr.table}${q};`
              : `DROP TRIGGER IF EXISTS ${q}${name}${q};`
          );
        }
        const sql = stripDefiner(tr.statement.trim());
        creates.push(sql.endsWith(';') ? sql : sql + ';');
      } else {
        parts.push(schemaFailed(name));
      }
      reportStep(name, true);
      step++;
    }

    if (creates.length > 0) {
      parts.push('-- Routines and triggers');
      parts.push(...drops);
      // MySQL: a routine or trigger body has ';' of its own, so the delimiter has to change or the
      // splitter cuts straight through the body. Postgres uses dollar-quotes (both splitters
      // understand them), and on SQLite the BEGIN...END block is recognised by the splitter itself.
      parts.push(...(isMysql ? wrapMysqlDelimiter(creates) : creates));
      parts.push('');
    }
  }

  parts.push(...dumpFooter(spec.dbType));
  await flush();
}
