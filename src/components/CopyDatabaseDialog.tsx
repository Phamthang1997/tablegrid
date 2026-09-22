import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { dbHelper, type OpenConnection } from '../utils/dbHelper';
import { serverKeyOf } from '../utils/safeMode';
import {
  KIND_LABEL_KEY,
  KIND_ORDER,
  buildDumpObjects,
  keysWithTriggers,
  objKey,
  splitSelection,
  type DumpObj,
  type DumpObjKind,
  type DumpSelection,
} from '../utils/dumpObjects';
import { Modal, ModalFooter } from './Modal';

/** What the dialog hands back; `App` turns it into a background job. */
export interface CopyDatabaseOptions extends DumpSelection {
  sourceConnId: string;
  targetConnId: string;
  /** For the job title and the result message — already the human-readable label the picker showed. */
  sourceLabel: string;
  targetLabel: string;
  /** The target database's own name, for the job's `db` field and its exclusivity key. */
  targetDb: string;
  dbType: 'sqlite' | 'postgres' | 'mysql';
  /**
   * The SOURCE connection's Postgres schema, passed on to `buildDump` exactly as the export path
   * does: it is what the dump's header names, and therefore where the objects land.
   */
  sourceSchema: string | null;
  sqlOptions: { dropTable: boolean; includeStructure: boolean; includeContent: boolean };
  continueOnError: boolean;
  /**
   * Connections the dialog OPENED for this copy, which the job must close when it is finished.
   *
   * Ownership transfers here: whatever the dialog opened while the user was still picking it closes
   * itself, but these two are in use for the length of the run, so the job outlives the dialog and
   * has to be the one to let them go. Connections the user already had open are never in this list.
   */
  ownedConnIds: string[];
}

interface CopyDatabaseDialogProps {
  /** The connection the tab was opened from — the source's default, never a hidden dependency. */
  connId: string;
  open?: boolean;
  onClose: () => void;
  /** Returns true when the job was queued (the dialog closes itself), false to keep it open. */
  onSubmit: (options: CopyDatabaseOptions) => Promise<boolean>;
  asTab?: boolean;
}

const labelStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--win-text-secondary)',
  display: 'block',
  marginBottom: '6px',
};

const selectStyle: React.CSSProperties = { height: '30px', fontSize: '11px', width: '100%' };

const hintStyle: React.CSSProperties = {
  fontSize: '10px',
  color: 'var(--win-text-secondary)',
  lineHeight: 1.5,
  marginTop: '4px',
};

const DIALECT_LABEL: Record<string, string> = {
  sqlite: 'SQLite',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
};

// Diacritics are stripped so the search box ignores them (as the Sidebar's does).
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');
const removeAccents = (s: string) =>
  s.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();

/** A connection's Postgres schema, defaulted the way the backend defaults it. */
const schemaOf = (c: OpenConnection) => (c.dialect === 'postgres' ? c.schema || 'public' : null);

/** Every reason the Copy button can be off — literal keys, so `t()` type-checks them. */
type BlockKey =
  | 'copyDb.errNoSource'
  | 'copyDb.errNoTarget'
  | 'copyDb.errSamePlace'
  | 'copyDb.errDialect'
  | 'copyDb.errReadOnly'
  | 'copyDb.errNothingToWrite'
  | 'copyDb.errNoObjects';

/** One side of the copy: a connection that anchors the SERVER, plus a database on it. */
interface SidePick {
  /** `connId` of an open connection — it identifies the server, not necessarily the database below. */
  conn: string;
  db: string;
}

/** A resolved side: a live `conn_id` to read or write through. */
interface ResolvedSide {
  connId: string;
  schema: string | null;
  /**
   * This call is what opened the connection — nobody had it before.
   *
   * It decides ownership, and therefore what may be closed again. Derived by looking the returned id
   * up in the list the picker already holds, because `open_database` is idempotent and so cannot say
   * by itself whether it created anything.
   */
  created: boolean;
}

/**
 * A `(connection, database)` pair turned into a live `conn_id`.
 *
 * `open_database` is **idempotent** — it hands back the connection already holding that database — so
 * this is also the "it is already open" path, and there is no second code path to keep in step. The
 * one exception is SQLite, where one file *is* one database and `open_database` refuses outright; its
 * anchor connection is already the answer.
 *
 * It does open a pool for a database that was not open, and deliberately leaves it open: that is what
 * `handleImportDatabase` does for its target too, and the database genuinely is open afterwards.
 */
async function resolveSide(
  anchor: OpenConnection,
  db: string,
  known: OpenConnection[],
): Promise<{ ok: true; side: ResolvedSide } | { ok: false; error: string }> {
  if (anchor.dialect === 'sqlite' || !db || db === anchor.db) {
    return { ok: true, side: { connId: anchor.connId, schema: schemaOf(anchor), created: false } };
  }
  const opened = await dbHelper.openDatabase(anchor.connId, db);
  if (!opened.success || !opened.connId) return { ok: false, error: opened.error || '' };
  return {
    ok: true,
    side: {
      connId: opened.connId,
      schema: opened.schema ?? null,
      created: !known.some((c) => c.connId === opened.connId),
    },
  };
}

/**
 * The databases of one server, for the picker's second select.
 *
 * A hook rather than an effect written twice: both sides need exactly this, and the two call sites
 * are top-level, so the rules of hooks hold. SQLite is skipped — `list_databases` has nothing to say
 * about a file.
 */
function useDatabaseList(anchor: OpenConnection | undefined) {
  // The list is stored WITH the connection it belongs to, and read back only when the two agree.
  // That is what makes "clear it when the anchor changes" a derivation rather than a setState in an
  // effect — and it also closes a real hole: without the key, the previous server's database list
  // stayed on screen, selectable, for as long as the new one took to answer.
  const [state, setState] = useState<{ key: string; dbs: string[] }>({ key: '', dbs: [] });
  const [loading, setLoading] = useState(false);
  const connId = anchor?.connId || '';
  const isSqlite = anchor?.dialect === 'sqlite';

  useEffect(() => {
    if (!connId || isSqlite) return;
    let cancelled = false;
    // queueMicrotask: a setState called synchronously in an effect is a cascading render
    // (react/set-state-in-effect). The flag is not derivable — it is an IPC call in flight.
    queueMicrotask(() => setLoading(true));
    (async () => {
      try {
        const res = await dbHelper.listDatabases(connId);
        if (!cancelled) setState({ key: connId, dbs: res.databases || [] });
      } catch {
        if (!cancelled) setState({ key: connId, dbs: [] });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [connId, isSqlite]);

  return { dbs: state.key === connId ? state.dbs : [], loading };
}

/**
 * Copy one database into another — structure and data, **same dialect only**.
 *
 * It is the existing export and restore halves wired straight together: `buildDump` reads through a
 * reader bound to the source connection, and `restore_backup` replays the text onto the target one.
 * No file is written, and nothing new decides what a `CREATE TABLE` should look like — which is
 * exactly why this is limited to one dialect. Copying MySQL to Postgres needs a type-mapping table,
 * and a wrong mapping is silent data loss rather than an error.
 *
 * **Each side is a `(connection, database)` pair, not a connection.** Picking only among the
 * connections already open was the first shape, and it made the ordinary case impossible: with one
 * connection open there was nothing to copy INTO, and copying `sakila` to `sakila_backup` on the same
 * server — the commonest thing anyone wants here — required opening the target by hand first. The
 * connection identifies the SERVER; `resolveSide` turns the pair into a live `conn_id`.
 */
export const CopyDatabaseDialog: React.FC<CopyDatabaseDialogProps> = ({
  connId,
  open = true,
  onClose,
  onSubmit,
  asTab = false,
}) => {
  const { t } = useTranslation();
  const [conns, setConns] = useState<OpenConnection[]>([]);
  const connsRef = React.useRef<OpenConnection[]>([]);
  const [connsLoading, setConnsLoading] = useState(false);
  const [sourcePick, setSourcePick] = useState<SidePick>({ conn: connId, db: '' });
  const [targetPick, setTargetPick] = useState<SidePick>({ conn: '', db: '' });
  // The source resolved to a live connection — everything on the right-hand side reads through it.
  // Stored WITH the pick it came from, for the reason `useDatabaseList` spells out: read back only
  // when the two agree, so switching source reads as "not resolved yet" instead of handing the object
  // list the PREVIOUS database's connection for as long as the new one takes to open.
  const [sourceResolved, setSourceResolved] = useState<{ key: string; side: ResolvedSide } | null>(null);
  const [objects, setObjects] = useState<DumpObj[]>([]);
  // Keyed `kind:name`, never by a bare name — a table and a trigger can share one.
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [dropTable, setDropTable] = useState(true);
  const [includeStructure, setIncludeStructure] = useState(true);
  const [includeContent, setIncludeContent] = useState(true);
  const [continueOnError, setContinueOnError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The form as it looked when a copy was queued from it.
   *
   * The tab deliberately does **not** close on Copy, unlike Export and Import. Those two end in
   * something the user can see — a file on disk, a database they are looking at — while a copy into
   * another database produces nothing on screen at all: the tab vanished, the jobs bell appears only
   * after the first job exists, and `buildDump` then read sakila's 16 tables page by page for half a
   * minute with no sign anywhere that anything was happening.
   *
   * Comparing the signature rather than holding a boolean is the same keyed derivation
   * `useDatabaseList` uses: touching any picker, option or tick makes the banner go and the button
   * come back, with nothing to reset by hand from a dozen different setters.
   */
  const [queuedSig, setQueuedSig] = useState<string | null>(null);

  /**
   * Connections this dialog opened **itself**, and may therefore close again.
   *
   * Picking a database has to open it — every read command takes a `conn_id` — so browsing the two
   * dropdowns left a trail of connections in the rail that the user never asked for. A ref rather
   * than state: nothing renders from it, and a re-render per open would be noise.
   *
   * Ownership is given up in exactly two places: `submit` hands the source and the target to the job
   * (which outlives this component and closes them at the end), and `releaseOwned` closes the rest.
   * A connection the user already had open is never in here, so it can never be closed by us.
   */
  const ownedRef = React.useRef<Set<string>>(new Set());

  /** Close every connection we still own except `keep`, and let the rail redraw. */
  const releaseOwned = React.useCallback((keep?: string) => {
    const ids = [...ownedRef.current].filter((id) => id !== keep);
    if (ids.length === 0) return;
    for (const id of ids) ownedRef.current.delete(id);
    void Promise.all(ids.map((id) => dbHelper.disconnect(id))).then(() => {
      // DbRail refetches on this event whatever `connId` says (see its `onRestored`), which is how the
      // closed connections leave the rail.
      window.dispatchEvent(new CustomEvent('database-restored', { detail: { connId: '' } }));
    });
  }, []);

  // The tab is going: anything still owned was only ever opened to fill these dropdowns.
  useEffect(() => () => releaseOwned(), [releaseOwned]);

  /**
   * The picker's source of truth, loaded on mount and again from the Refresh button.
   *
   * A callback rather than a `reloadKey` state bumped into the effect's deps: that key is never READ
   * in the effect body, so it is an extra dependency, and `react/exhaustive-effect-dependencies` is at
   * zero in this codebase precisely so that a finding is worth reading.
   */
  const loadConns = React.useCallback(() => {
    queueMicrotask(() => setConnsLoading(true));
    (async () => {
      try {
        const list = await dbHelper.listConnections();
        // Redis is not a SQL dump — it has its own transfer dialog (`RedisTransferDialog`).
        const sql = list.filter((c) => c.dialect !== 'redis');
        // The ref is what `resolveSide` reads to decide whether IT opened a connection. Kept beside
        // the state rather than in the resolve effect's deps, where it would re-resolve — and
        // therefore re-open — the source on every Refresh.
        connsRef.current = sql;
        setConns(sql);
      } catch {
        connsRef.current = [];
        setConns([]);
      } finally {
        setConnsLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (open) loadConns();
  }, [open, loadConns]);

  const sourceConn = useMemo(
    () => conns.find((c) => c.connId === sourcePick.conn),
    [conns, sourcePick.conn],
  );
  const targetConn = useMemo(
    () => conns.find((c) => c.connId === targetPick.conn),
    [conns, targetPick.conn],
  );

  const sourceDbs = useDatabaseList(sourceConn);
  const targetDbs = useDatabaseList(targetConn);

  // A side's database defaults to the one its anchor connection already holds — reconciled during
  // render rather than in an effect, so the select never paints empty for a frame.
  const sourceDb = sourcePick.db || sourceConn?.db || '';
  const targetDb = targetPick.db || targetConn?.db || '';

  // Resolving the SOURCE is what makes the object list possible: every read takes a `conn_id`, and the
  // database picked may not be the one the anchor connection holds.
  const sourceKey = `${sourcePick.conn}|${sourceDb}`;

  useEffect(() => {
    if (!open || !sourceConn || !sourceDb) return;
    let cancelled = false;
    const key = `${sourceConn.connId}|${sourceDb}`;
    (async () => {
      const r = await resolveSide(sourceConn, sourceDb, connsRef.current);
      if (cancelled) return;
      if (!r.ok) {
        setError(t('copyDb.errOpenTarget', { db: sourceDb, message: r.error }));
        return;
      }
      if (r.side.created) ownedRef.current.add(r.side.connId);
      // Clicking through the dropdown used to leave one connection open per database visited; the
      // one just picked is kept and every earlier one goes.
      releaseOwned(r.side.connId);
      setError(null);
      setSourceResolved({ key, side: r.side });
    })();
    return () => { cancelled = true; };
  }, [open, sourceConn, sourceDb, t, releaseOwned]);

  const resolvedSource = sourceResolved?.key === sourceKey ? sourceResolved.side : null;
  const sourceConnId = resolvedSource?.connId || '';

  useEffect(() => {
    if (!open || !sourceConnId) return;
    let cancelled = false;
    queueMicrotask(() => setObjectsLoading(true));
    (async () => {
      try {
        // The same three sources the export dialog reads. A failure to fetch routines or triggers
        // returns an empty array rather than breaking the dialog.
        const [list, dbObjs, triggers] = await Promise.all([
          dbHelper.getTables(sourceConnId),
          dbHelper.getDatabaseObjects(sourceConnId),
          dbHelper.getAllTriggers(sourceConnId),
        ]);
        if (cancelled) return;
        const all = buildDumpObjects(list, dbObjs, triggers);
        setObjects(all);
        setSelected(all.map(objKey));
      } catch {
        if (!cancelled) { setObjects([]); setSelected([]); }
      } finally {
        if (!cancelled) setObjectsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, sourceConnId]);

  if (!open && !asTab) return null;

  /** `<database> — <server>`, because two servers may both hold a `sakila`. */
  const sideLabel = (anchor: OpenConnection | undefined, db: string) => {
    if (!anchor) return db;
    const server = serverKeyOf(anchor.connId);
    return server ? `${db} — ${server}` : db;
  };

  const shown = search.trim()
    ? objects.filter((o) => removeAccents(o.name).includes(removeAccents(search.trim())))
    : objects;
  const allShownSelected = shown.length > 0 && shown.every((o) => selected.includes(objKey(o)));
  const chosen = objects.filter((o) => selected.includes(objKey(o)));

  const toggleAllShown = () => {
    const keys = keysWithTriggers(objects, shown);
    if (allShownSelected) setSelected(selected.filter((k) => !keys.includes(k)));
    else setSelected([...new Set([...selected, ...keys])]);
  };

  const toggleOne = (key: string) => {
    const obj = objects.find((o) => objKey(o) === key);
    const keys = obj ? keysWithTriggers(objects, [obj]) : [key];
    setSelected((prev) =>
      prev.includes(key) ? prev.filter((k) => !keys.includes(k)) : [...new Set([...prev, ...keys])]
    );
  };

  const kindItems = (kind: DumpObjKind) => objects.filter((o) => o.kind === kind);
  const isKindFullySelected = (kind: DumpObjKind) => {
    const items = kindItems(kind);
    return items.length > 0 && items.every((o) => selected.includes(objKey(o)));
  };
  const toggleKind = (kind: DumpObjKind) => {
    const keys = keysWithTriggers(objects, kindItems(kind));
    const on = isKindFullySelected(kind);
    setSelected((prev) =>
      on ? prev.filter((k) => !keys.includes(k)) : [...new Set([...prev, ...keys])]
    );
  };

  const groups = KIND_ORDER
    .map((kind) => ({ kind, items: shown.filter((o) => o.kind === kind) }))
    .filter((g) => g.items.length > 0);

  /**
   * The same place on both sides — one SERVER and one database, compared case-insensitively because
   * MySQL is. Comparing the two `connId`s would not do it: the target's may still be the anchor's
   * while its database select points elsewhere, and two connections can hold the same database.
   */
  const samePlace =
    !!sourceConn && !!targetConn &&
    sourceConn.serverId === targetConn.serverId &&
    sourceDb.toLowerCase() === targetDb.toLowerCase();

  /**
   * Why the Copy button is off, as a translation key.
   *
   * Every one of these is a refusal the backend would make anyway (a dialect mismatch produces an
   * unreadable driver error, a read-only connection a refusal from Rust); saying it here, next to the
   * picker that caused it, is the difference between a fixable mistake and a failed job.
   *
   * The type is the union of the literal keys rather than `string`, so `t()` stays type-checked —
   * a `t(x as 'copyDb.errNoTarget')` cast would let a typo through as a visible raw key.
   */
  const blockKey: BlockKey | null =
    !sourceConn || !sourceDb ? 'copyDb.errNoSource'
    : !targetConn || !targetDb ? 'copyDb.errNoTarget'
    : samePlace ? 'copyDb.errSamePlace'
    : targetConn.dialect !== sourceConn.dialect ? 'copyDb.errDialect'
    : targetConn.readOnly ? 'copyDb.errReadOnly'
    : !includeStructure && !includeContent ? 'copyDb.errNothingToWrite'
    : chosen.length === 0 ? 'copyDb.errNoObjects'
    : null;

  /**
   * Postgres, source schema ≠ target schema.
   *
   * The dump names the SOURCE schema in its header (`CREATE SCHEMA` + `SET search_path`), so the
   * objects land in a schema of that name on the target server — not in the schema the target
   * connection is pointed at. Renaming a schema mid-copy would also need `pg_get_indexdef()`'s output
   * rewritten, which is Postgres' own text and always carries the source schema. A warning rather
   * than a refusal: this is legitimate as long as the user knows where it lands.
   *
   * The target's schema is read from the open connection holding that database when there is one, and
   * is otherwise `public` — which is what `current_schema()` answers on a database nobody has pointed
   * elsewhere yet.
   */
  const targetSchema =
    conns.find((c) => c.serverId === targetConn?.serverId && c.db === targetDb)?.schema || 'public';
  const schemaWarning =
    sourceConn?.dialect === 'postgres' && targetConn && (resolvedSource?.schema || 'public') !== targetSchema
      ? { from: resolvedSource?.schema || 'public', to: targetSchema }
      : null;

  const formSig = [
    sourceConnId,
    targetPick.conn,
    targetDb,
    selected.join(','),
    `${dropTable}${includeStructure}${includeContent}${continueOnError}`,
  ].join('|');
  const queued = queuedSig !== null && queuedSig === formSig;

  const submit = async () => {
    if (!sourceConn || !targetConn || !resolvedSource || blockKey) return;
    setError(null);
    setSubmitting(true);
    try {
      // The target is resolved HERE, not inside the job: opening a database can fail, and it has to be
      // able to say so while the user is still standing in front of the dialog. Same reason
      // `handleImportDatabase` creates and opens its target before queueing anything.
      const resolved = await resolveSide(targetConn, targetDb, connsRef.current);
      if (!resolved.ok) {
        setError(t('copyDb.errOpenTarget', { db: targetDb, message: resolved.error }));
        return;
      }
      // Ownership TRANSFERS to the job, which outlives this tab: both connections are in use for the
      // whole run, so they are taken out of `ownedRef` (nothing here may close them any more) and
      // handed over instead. Only what this dialog actually opened travels — a connection the user
      // already had is not ours to close.
      const owned = [resolvedSource, resolved.side]
        .filter((s) => s.created)
        .map((s) => s.connId);
      for (const id of owned) ownedRef.current.delete(id);
      const ok = await onSubmit({
        ownedConnIds: owned,
        sourceConnId: resolvedSource.connId,
        targetConnId: resolved.side.connId,
        sourceLabel: sideLabel(sourceConn, sourceDb),
        targetLabel: sideLabel(targetConn, targetDb),
        targetDb,
        dbType: sourceConn.dialect as 'sqlite' | 'postgres' | 'mysql',
        sourceSchema: resolvedSource.schema,
        ...splitSelection(chosen),
        // `dropTable && includeStructure`, not the raw flag — see the checkbox's comment below.
        sqlOptions: { dropTable: dropTable && includeStructure, includeStructure, includeContent },
        continueOnError,
      });
      // Queued, not closed — see `queuedSig`.
      if (ok) setQueuedSig(formSig);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  /** One side of the picker: the server-anchoring connection, then a database on it. */
  const renderSide = (
    which: 'source' | 'target',
    pick: SidePick,
    setPick: (p: SidePick) => void,
    anchor: OpenConnection | undefined,
    db: string,
    list: { dbs: string[]; loading: boolean },
  ) => {
    const isSqlite = anchor?.dialect === 'sqlite';
    // The anchor's own database is always offered, even before `list_databases` answers — otherwise
    // the select shows a value that is not among its options and the browser blanks it.
    const options = anchor && !list.dbs.includes(anchor.db) ? [anchor.db, ...list.dbs] : list.dbs;
    return (
      <div>
        <label style={labelStyle}>
          {which === 'source' ? t('copyDb.sourceLabel') : t('copyDb.targetLabel')}
        </label>
        <select
          className="form-input"
          value={pick.conn}
          disabled={submitting || connsLoading}
          // Changing the server clears the database: a name from the previous server means nothing here.
          onChange={(e) => setPick({ conn: e.target.value, db: '' })}
          style={selectStyle}
        >
          <option value="">{t('copyDb.pickConnection')}</option>
          {conns.map((c) => (
            <option key={c.connId} value={c.connId}>
              {serverKeyOf(c.connId) || c.db} · {DIALECT_LABEL[c.dialect] || c.dialect}
            </option>
          ))}
        </select>

        <div style={{ marginTop: '8px' }}>
          <label style={labelStyle}>{t('copyDb.databaseLabel')}</label>
          <select
            className="form-input"
            value={db}
            disabled={submitting || !anchor || isSqlite || list.loading}
            onChange={(e) => setPick({ conn: pick.conn, db: e.target.value })}
            style={selectStyle}
          >
            <option value="">
              {list.loading ? t('copyDb.loadingDatabases') : t('copyDb.pickDatabase')}
            </option>
            {options.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          {isSqlite && <div style={hintStyle}>{t('copyDb.sqliteOneDb')}</div>}
        </div>
      </div>
    );
  };

  const bodyContent = (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={{
        width: '360px',
        flexShrink: 0,
        borderRight: '1px solid var(--win-border)',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        overflowY: 'auto',
      }}>
        {renderSide('source', sourcePick, setSourcePick, sourceConn, sourceDb, sourceDbs)}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--win-text-secondary)' }}>
          <ArrowRight size={14} />
          <span style={{ fontSize: '10.5px' }}>{t('copyDb.direction')}</span>
        </div>

        {/* The target's server list is NOT filtered to exclude the source: `sakila` -> `sakila_backup`
            on one server is the commonest copy there is. What may not coincide is the (server,
            database) pair, which `samePlace` checks. */}
        {renderSide('target', targetPick, setTargetPick, targetConn, targetDb, targetDbs)}

        <button
          className="btn btn-secondary"
          onClick={loadConns}
          disabled={submitting || connsLoading}
          style={{ alignSelf: 'flex-start', padding: '0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}
          title={t('copyDb.refreshHint')}
        >
          <RefreshCw size={12} />
          {t('copyDb.refresh')}
        </button>

        {/* Acknowledgement at the point of action: the job is queued and this says where to watch it.
            Above the destructive warning, because it describes what has ALREADY been set going. */}
        {queued && (
          <div style={{
            fontSize: '10.5px',
            lineHeight: 1.5,
            color: 'var(--st-ok)',
            background: 'var(--win-bg-window)',
            border: '1px solid var(--win-border)',
            borderRadius: '4px',
            padding: '8px 10px',
          }}>
            <div style={{ fontWeight: 600 }}>{t('copyDb.queuedTitle')}</div>
            <div style={{ color: 'var(--win-text-secondary)', marginTop: '2px' }}>
              {t('jobs.startedInBackground')}
            </div>
            <div style={{ color: 'var(--win-text-secondary)', marginTop: '2px' }}>
              {t('copyDb.queuedAgain')}
            </div>
          </div>
        )}

        {/* The destination is named in full, because everything below it is destructive. */}
        {targetConn && targetDb && (
          <div style={{
            fontSize: '10.5px',
            lineHeight: 1.5,
            color: 'var(--st-danger)',
            background: 'var(--win-bg-window)',
            border: '1px solid var(--win-border)',
            borderRadius: '4px',
            padding: '8px 10px',
          }}>
            {/* Three states, and they fail in three different ways — one message for all of them
                would be wrong in two of the three. */}
            {!includeStructure
              ? t('copyDb.warnDataOnly', { target: sideLabel(targetConn, targetDb) })
              : dropTable
                ? t('copyDb.warnOverwrite', { target: sideLabel(targetConn, targetDb) })
                : t('copyDb.warnAppend', { target: sideLabel(targetConn, targetDb) })}
          </div>
        )}

        {schemaWarning && (
          <div style={{
            fontSize: '10.5px',
            lineHeight: 1.5,
            color: 'var(--st-warn)',
            background: 'var(--win-bg-window)',
            border: '1px solid var(--win-border)',
            borderRadius: '4px',
            padding: '8px 10px',
          }}>
            {t('copyDb.warnSchema', { from: schemaWarning.from, to: schemaWarning.to })}
          </div>
        )}

        <div>
          <label style={labelStyle}>{t('copyDb.optionsLabel')}</label>
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            padding: '10px',
            background: 'var(--win-bg-window)',
            border: '1px solid var(--win-border)',
            borderRadius: '4px',
          }}>
            {/* Tied to "structure", because `buildDump` emits the DROP independently of the CREATE:
                data-only + drop would empty the target and then INSERT into tables that no longer
                exist — and on MySQL a DROP commits implicitly, so the restore's rollback cannot undo
                it. The checkbox is disabled rather than silently ignored, so the reason is readable. */}
            <label style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '11px',
              cursor: includeStructure ? 'pointer' : 'not-allowed',
              opacity: includeStructure ? 1 : 0.5,
            }}>
              <input
                type="checkbox"
                checked={dropTable && includeStructure}
                disabled={!includeStructure}
                onChange={(e) => setDropTable(e.target.checked)}
              />
              {t('copyDb.optDrop')}
            </label>
            {!includeStructure && (
              <div style={{ fontSize: '10px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>
                {t('copyDb.optDropNeedsStructure')}
              </div>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', cursor: 'pointer' }}>
              <input type="checkbox" checked={includeStructure} onChange={(e) => setIncludeStructure(e.target.checked)} />
              {t('copyDb.optStructure')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', cursor: 'pointer' }}>
              <input type="checkbox" checked={includeContent} onChange={(e) => setIncludeContent(e.target.checked)} />
              {t('copyDb.optData')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', cursor: 'pointer' }}>
              <input type="checkbox" checked={continueOnError} onChange={(e) => setContinueOnError(e.target.checked)} />
              {t('copyDb.optContinueOnError')}
            </label>
            <div style={{ fontSize: '10px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>
              {t('copyDb.optContinueHint')}
            </div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>
            {t('copyDb.objectsToCopy', { selected: selected.length, total: objects.length })}
          </label>
          <button
            onClick={toggleAllShown}
            disabled={shown.length === 0}
            style={{
              padding: '2px 8px',
              fontSize: '10px',
              cursor: 'pointer',
              background: 'var(--win-bg-card)',
              border: '1px solid var(--win-border)',
              borderRadius: '3px',
              color: 'var(--win-text-primary)',
              whiteSpace: 'nowrap',
            }}
          >
            {allShownSelected ? t('exportDialog.deselectAll') : t('exportDialog.selectAll')}
          </button>
        </div>

        <input
          type="text"
          className="form-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('exportDialog.searchTables')}
          style={{ height: '28px', fontSize: '11px', width: '100%' }}
        />

        {!objectsLoading && objects.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {KIND_ORDER.map((kind) => {
              const n = kindItems(kind).length;
              if (n === 0) return null;
              const all = isKindFullySelected(kind);
              return (
                <button
                  key={kind}
                  onClick={() => toggleKind(kind)}
                  title={t('exportDialog.toggleGroup')}
                  style={{
                    fontSize: '9px',
                    fontWeight: 600,
                    padding: '1px 5px',
                    borderRadius: '3px',
                    cursor: 'pointer',
                    border: '1px solid var(--win-border)',
                    background: all ? 'var(--win-accent)' : 'transparent',
                    color: all ? '#fff' : 'var(--win-text-secondary)',
                  }}
                >{t(KIND_LABEL_KEY[kind])} {n}</button>
              );
            })}
          </div>
        )}

        <div style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          border: '1px solid var(--win-border)',
          borderRadius: '4px',
          background: 'var(--win-bg-window)',
          padding: '8px',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}>
          {objectsLoading ? (
            <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('exportDialog.loadingTables')}</div>
          ) : shown.length === 0 ? (
            <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>
              {objects.length === 0 ? t('exportDialog.noTables') : t('exportDialog.noTableMatch')}
            </div>
          ) : (
            groups.map((group) => (
              <React.Fragment key={group.kind}>
                <div style={{
                  position: 'sticky',
                  top: '-8px',
                  zIndex: 1,
                  background: 'var(--win-bg-window)',
                  padding: '4px 0 2px',
                  fontSize: '10px',
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                  color: 'var(--win-text-secondary)',
                  borderBottom: '1px solid var(--win-border)',
                }}>
                  {t(KIND_LABEL_KEY[group.kind])} · {group.items.length}
                </div>
                {group.items.map((obj) => {
                  const key = objKey(obj);
                  return (
                    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={selected.includes(key)} onChange={() => toggleOne(key)} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{obj.name}</span>
                      {obj.table && (
                        <span style={{ fontSize: '10px', color: 'var(--win-text-secondary)', flexShrink: 0 }}>
                          {t('exportDialog.triggerOn', { table: obj.table })}
                        </span>
                      )}
                    </label>
                  );
                })}
              </React.Fragment>
            ))
          )}
        </div>
      </div>
    </div>
  );

  const footerContent = (
    <>
      {(error || blockKey) && (
        <span style={{
          marginRight: 'auto',
          fontSize: '11px',
          color: error ? 'var(--st-danger)' : 'var(--win-text-secondary)',
        }}>
          {error || (blockKey ? t(blockKey) : '')}
        </span>
      )}
      {/* "Cancel" once something has been set going would read as "cancel the copy", which this button
          cannot do — the tray's own Cancel can. */}
      <button className="btn btn-secondary" onClick={onClose} disabled={submitting} style={{ flexShrink: 0 }}>
        {queued ? t('common.close') : t('common.cancel')}
      </button>
      <button
        className="btn btn-primary"
        onClick={submit}
        disabled={submitting || objectsLoading || queued || !!blockKey}
        style={{ background: 'var(--win-accent)', color: '#fff', border: 'none', flexShrink: 0 }}
      >
        {submitting ? t('copyDb.starting') : t('copyDb.start')}
      </button>
    </>
  );

  if (asTab) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', width: '100%', overflow: 'hidden', background: 'var(--win-bg-window)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 18px', borderBottom: '1px solid var(--win-border)', background: 'var(--win-bg-card)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
              {t('copyDb.title')}
            </span>
            <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
              {t('copyDb.sameDialectOnly')}
            </span>
          </div>
        </div>
        {bodyContent}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '10px 18px', borderTop: '1px solid var(--win-border)', background: 'var(--win-bg-card)', flexShrink: 0, gap: '8px' }}>
          {footerContent}
        </div>
      </div>
    );
  }

  return (
    <Modal
      title={t('copyDb.title')}
      onClose={onClose}
      closeDisabled={submitting}
      width="860px"
      height="560px"
      zIndex={9999}
    >
      {bodyContent}
      <ModalFooter>{footerContent}</ModalFooter>
    </Modal>
  );
};
