import React, { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ChevronDown } from 'lucide-react';
import {
  parseCreateTable,
  parseInsert,
  parseCopy,
  buildDropStatements,
  stripLeadingSqlComments,
  plannedFromScan,
  fileBaseName,
  type DumpScan,
  type DumpTable,
  type DumpRows,
} from '../utils/dumpPreview';
import { dbHelper } from '../utils/dbHelper';
import { pickOpenFile } from '../utils/fileSave';
import { ProgressBar, type ProgressState } from './ProgressBar';
import { ConfirmDialog } from './ConfirmDialog';
import { Modal, ModalFooter } from './Modal';


/** The most statements shown in the SQL view. */
const PREVIEW_LIMIT = 2000;
/** How many rows are shown per table on the Data tab (the visual form). */
const PREVIEW_ROWS = 20;

/** One table's data rows: only the first PREVIEW_ROWS are kept, while `total` is the real count. */
interface TablePreviewRows extends DumpRows {
  total: number;
}


const labelStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--win-text-secondary)',
  display: 'block',
  marginBottom: '6px',
};

// Diacritics are stripped so table search ignores them (as the Sidebar's search box does).
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');
const removeAccents = (s: string) =>
  s.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();

/** Shortens a long statement so the preview does not overflow. */
function clip(stmt: string, max = 600): string {
  return stmt.length > max ? stmt.slice(0, max) + ' …' : stmt;
}


/**
 * Seconds -> "12 seconds" / "2 min 5 sec" / "1 h 3 min" for the estimate and ETA.
 * Takes `t` because it is module-level and cannot call the hook itself.
 */
function formatDuration(t: TFunction, totalSeconds: number): string {
  const s = Math.max(1, Math.round(totalSeconds));
  if (s < 60) return t('importDialog.etaSeconds', { s });
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rest = s % 60;
    return rest ? t('importDialog.etaMinutesSeconds', { m, s: rest }) : t('importDialog.etaMinutes', { m });
  }
  const h = Math.floor(m / 60);
  const restM = m % 60;
  return restM ? t('importDialog.etaHoursMinutes', { h, m: restM }) : t('importDialog.etaHours', { h });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface ImportDatabaseDialogProps {
  open?: boolean;
  onClose: () => void;
  /** The connected database (the default target when the file names none). */
  currentDb?: string;
  /** false for SQLite: it has no notion of a database, so the target picker is hidden. */
  canManageDatabases?: boolean;
  /** The dialect, so an overwrite's DROP is built with the right syntax. */
  dbType?: string;
  /**
   * Returns true when the import finished (the dialog closes itself), false to keep it open.
   * targetDb: the destination database — empty means use the connected one.
   *
   * There is NO progress parameter: the restore runs as a background job (utils/jobs.ts) and reports
   * its progress into JobsTray. This dialog closes as soon as the job is queued, and a callback into
   * an unmounted component would only be a second copy of the ETA maths already in
   * utils/restoreProgress.ts.
   */
  onSubmit: (
    /** The dump FILE — the backend reads it itself, so it never enters the webview. */
    source: { path: string; mysqlScript: boolean },
    tables: string[],
    targetDb: string,
    continueOnError: boolean,
    /** The overwrite option's `DROP … IF EXISTS` list, run before the dump. */
    prepend: string[]
  ) => Promise<boolean>;
  asTab?: boolean;
}

/**
 * The "Import Database" dialog — a two-column layout like the Export one: the dump file and its
 * details on the left, and the tables detected in it on the right, for importing only part of it.
 */
export const ImportDatabaseDialog: React.FC<ImportDatabaseDialogProps> = ({
  open = true,
  onClose,
  currentDb,
  canManageDatabases = true,
  dbType = 'mysql',
  onSubmit,
  asTab = false,
}) => {
  const { t, i18n } = useTranslation();
  const fmtNum = (n: number) => n.toLocaleString(i18n.language);

  // The dump as a PATH plus what `scan_dump_file` read from it. The file used to be read into a JS
  // string (gunzipped by the webview) and split on the main thread, which froze the dialog on a large
  // dump and could not hold one past ~512M characters at all.
  const [path, setPath] = useState<string | null>(null);
  const [scan, setScan] = useState<DumpScan | null>(null);
  // A newer pick supersedes a scan still running; its answer must not land on the newer file.
  const scanSeq = useRef(0);
  const file = path ? { name: fileBaseName(path), size: scan?.fileBytes ?? 0 } : null;
  const [tables, setTables] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  // The target database: taken from the file when it has a `USE`/`CREATE DATABASE`, otherwise typed by the user.
  const [targetDb, setTargetDb] = useState('');
  const [dbFromFile, setDbFromFile] = useState<string | null>(null);
  // Drop same-named objects before running the dump (otherwise it fails with "already exists")
  const [overwrite, setOverwrite] = useState(false);
  // Skip a failing statement instead of rolling everything back. FK checks are already off during a
  // restore — what ruins a whole import is a failure that cannot be switched off (a view reading a
  // table the file does not contain, say).
  const [continueOnError, setContinueOnError] = useState(false);
  // The confirmation summary is on screen, before anything runs
  const [confirming, setConfirming] = useState(false);
  const [tab, setTab] = useState<'tables' | 'structure' | 'data'>('tables');
  const [viewMode, setViewMode] = useState<'visual' | 'sql'>('visual');
  // The table being viewed in the visual pane (independent of the ones ticked for import)
  const [previewTables, setPreviewTables] = useState<string[]>([]);
  const [showPreviewPicker, setShowPreviewPicker] = useState(false);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      scanSeq.current++;
      setPath(null);
      setScan(null);
      setTables([]);
      setSelected([]);
      setPreviewTables([]);
      setShowPreviewPicker(false);
      setSearch('');
      setError(null);
      setTab('tables');
      setViewMode('visual');
      setTargetDb('');
      setDbFromFile(null);
      setOverwrite(false);
      setConfirming(false);
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, submitting]);

  // The preview is built from the SAMPLE `scan_dump_file` returns — every structure statement and the
  // first INSERTs of each table — never from the file itself, so a dump of any size previews in the
  // same time. `scan.preview.complete` says whether the sample is the whole file.
  const parsed = React.useMemo(() => {
    const createdTables: DumpTable[] = [];
    const byTable = new Map<string, TablePreviewRows>();
    if (!scan) return { structure: [], data: [], createdTables, insertedRows: [] as TablePreviewRows[] };
    for (const st of scan.preview.structure) {
      const ct = parseCreateTable(stripLeadingSqlComments(st.text));
      if (ct) createdTables.push(ct);
    }
    for (const st of scan.preview.data) {
      const body = stripLeadingSqlComments(st.text);
      // A pg_dump file keeps its rows in COPY blocks; the preview sample carries a few data lines.
      const ins = parseInsert(body) ?? parseCopy(body);
      if (!ins) continue;
      const cur = byTable.get(ins.table);
      if (cur) {
        if (!cur.columns && ins.columns) cur.columns = ins.columns;
        cur.total += ins.rows.length;
        if (cur.rows.length < PREVIEW_ROWS) {
          cur.rows.push(...ins.rows.slice(0, PREVIEW_ROWS - cur.rows.length));
        }
      } else {
        byTable.set(ins.table, { ...ins, rows: ins.rows.slice(0, PREVIEW_ROWS), total: ins.rows.length });
      }
    }
    return {
      structure: scan.preview.structure,
      data: scan.preview.data,
      createdTables,
      insertedRows: [...byTable.values()],
    };
  }, [scan]);
  const previewComplete = scan?.preview.complete ?? true;

  // The objects in the dump and their DROP statements: a function of the file alone and NOT of
  // `overwrite`, so toggling that checkbox does not rescan anything. `runImport` reuses it directly.
  const dumpObjects = scan?.objects ?? null;
  const dropStatements = React.useMemo(
    () => (dumpObjects ? buildDropStatements(dumpObjects, dbType) : []),
    [dumpObjects, dbType]
  );

  // A Set rather than `selected.includes()`: the filter runs over every statement in the dump.
  const selectedSet = React.useMemo(() => new Set(selected), [selected]);
  // Statements naming no table (SET/USE…) still run; the rest must belong to a selected table.
  const keepStatement = React.useCallback(
    (s: { table: string | null }) => tables.length === 0 || !s.table || selectedSet.has(s.table),
    [tables.length, selectedSet]
  );

  // How many statements will run (the rule the backend's filter follows), for the time estimate.
  // It has to come BEFORE the `if (!open)` below: a hook may not be called after an early return.
  const plannedStatements = React.useMemo(
    () => (scan ? plannedFromScan(scan.plan, tables, selectedSet, overwrite ? dropStatements.length : 0) : 0),
    [scan, tables, selectedSet, overwrite, dropStatements]
  );

  // The preview shows only the selected tables' statements (with no table detected -> it shows everything).
  const structureShown = React.useMemo(
    () => parsed.structure.filter(keepStatement),
    [parsed, keepStatement]
  );
  const dataShown = React.useMemo(
    () => parsed.data.filter(keepStatement),
    [parsed, keepStatement]
  );

  if (!open) return null;

  const browse = async () => {
    const picked = await pickOpenFile({
      title: t('importDialog.pickFileTitle'),
      // A pg_dump -Fc/-Ft archive is read through pg_restore; what a file IS is decided by its
      // bytes, not its name, so "All files" is offered too.
      filters: [
        { name: 'SQL dump / pg_dump archive', extensions: ['sql', 'gz', 'dump', 'backup', 'tar'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (!picked) return;

    const seq = ++scanSeq.current;
    setError(null);
    setPath(picked);
    setScan(null);
    setTables([]);
    setSelected([]);
    setParsing(true);
    setProgress({ label: t('importDialog.parsing') });

    try {
      // Rust reads, gunzips (when the file starts with the gzip magic bytes, whatever its name) and
      // splits the file, and hands back only what this dialog shows.
      const res = await dbHelper.scanDumpFile(picked, (prog) => {
        if (seq !== scanSeq.current || !prog.bytesTotal) return;
        setProgress({ label: t('importDialog.parsing'), current: prog.bytesDone, total: prog.bytesTotal });
      });
      if (seq !== scanSeq.current || !res) return;
      setScan(res);
      setTables(res.tables);
      setSelected(res.tables);
      setPreviewTables(res.tables);
      // When the file names a target database it is used; otherwise the field is left for the user.
      setDbFromFile(res.database);
      setTargetDb(res.database || '');
    } catch (err: any) {
      if (seq !== scanSeq.current) return;
      setPath(null);
      setError(t('importDialog.errReadFile', { message: err?.message || String(err) }));
    } finally {
      if (seq === scanSeq.current) {
        setProgress(null);
        setParsing(false);
      }
    }
  };

  const shown = search.trim()
    ? tables.filter((tbl) => removeAccents(tbl).includes(removeAccents(search.trim())))
    : tables;
  const allShownSelected = shown.length > 0 && shown.every((tbl) => selected.includes(tbl));

  const previewClipped =
    !previewComplete || (tab === 'structure' ? structureShown.length : dataShown.length) > PREVIEW_LIMIT;

  // The visual pane filters on its own multi-select (previewTables), not on the import ticks.
  const keepTable = (name: string) => tables.length === 0 || previewTables.includes(name);
  const visualTables = parsed.createdTables.filter((tbl) => keepTable(tbl.name));
  const visualRows = parsed.insertedRows.filter((r) => keepTable(r.table));
  const togglePreviewTable = (name: string) => {
    setPreviewTables((prev) => (prev.includes(name) ? prev.filter((tbl) => tbl !== name) : [...prev, name]));
  };

  const toggleAllShown = () => {
    if (allShownSelected) setSelected(selected.filter((tbl) => !shown.includes(tbl)));
    else setSelected([...new Set([...selected, ...shown])]);
  };

  const canSubmit = !!path && !parsing && !submitting && !!scan && (tables.length === 0 || selected.length > 0);

  // Pressing "Start import" shows the summary for confirmation; the real run is in runImport().
  const askConfirm = () => {
    if (!path || !scan) return;
    // No database name (the file names none and the user typed none) -> prompt for one.
    if (canManageDatabases && !targetDb.trim() && !currentDb) {
      setError(t('importDialog.errNoTargetDb'));
      return;
    }
    setError(null);
    setConfirming(true);
  };

  const runImport = async () => {
    if (!path || !scan) return;
    setConfirming(false);
    setError(null);
    setSubmitting(true);
    setProgress({ label: t('importDialog.preparing') });
    try {
      // Overwrite: prepend DROP ... IF EXISTS and let those names through the per-table filter (the
      // backend only runs statements mentioning a name from that list).
      const objs = overwrite ? dumpObjects : null;
      const drops = overwrite ? dropStatements : [];
      const finalTables = objs
        ? [...new Set([...selected, ...objs.views, ...objs.triggers, ...objs.procedures, ...objs.functions])]
        : selected;

      const ok = await onSubmit({ path, mysqlScript: scan.mysqlScript }, finalTables, targetDb.trim(), continueOnError, drops);
      if (ok) onClose();
    } finally {
      setProgress(null);
      setSubmitting(false);
    }
  };


  // A ROUGH estimate before the run (~800 statements/second against a local server). Once it is
  // really running, the ETA is recomputed from the measured rate.
  const estimatedSeconds = plannedStatements > 0 ? plannedStatements / 800 : 0;

  if (!open && !asTab) return null;

  const confirmDialog = (
    <ConfirmDialog
      open={confirming}
      tone={overwrite ? 'danger' : 'info'}
      title={t('importDialog.confirmTitle')}
      message={
        <>
          <div>
            <Trans
              i18nKey="importDialog.restoreInto"
              values={{ db: targetDb.trim() || currentDb || t('importDialog.restoreIntoConnected') }}
              components={{ code: <b style={{ fontFamily: 'monospace' }} /> }}
            />
            {canManageDatabases && targetDb.trim() && targetDb.trim() !== currentDb
              ? t('importDialog.willBeCreated')
              : '.'}
          </div>
          <div style={{ marginTop: '8px', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
            <span style={{ color: 'var(--win-text-secondary)' }}>{t('importDialog.rowTables')}</span>
            <b>{tables.length === 0
              ? t('importDialog.allFile')
              : t('importDialog.tablesCount', { selected: selected.length, total: tables.length })}</b>
            <span style={{ color: 'var(--win-text-secondary)' }}>{t('importDialog.rowStatements')}</span>
            <b>{fmtNum(plannedStatements)}</b>
            <span style={{ color: 'var(--win-text-secondary)' }}>{t('importDialog.rowFile')}</span>
            <b>{file ? `${file.name} (${formatSize(file.size)})` : ''}</b>
            <span style={{ color: 'var(--win-text-secondary)' }}>{t('importDialog.rowEta')}</span>
            <b>~{formatDuration(t, estimatedSeconds)}</b>
          </div>
        </>
      }
      note={overwrite ? t('importDialog.noteOverwrite') : t('importDialog.noteEstimate')}
      confirmLabel={t('importDialog.startRestore')}
      cancelLabel={t('importDialog.back')}
      onConfirm={runImport}
      onCancel={() => setConfirming(false)}
    />
  );

  const bodyContent = (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div style={{
            width: '340px',
            flexShrink: 0,
            borderRight: '1px solid var(--win-border)',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
            overflowY: 'auto'
          }}>
            <div className="form-group">
              <label style={labelStyle}>{t('importDialog.sourceFile')}</label>
              <input
                type="text"
                className="form-input"
                readOnly
                value={file ? file.name : ''}
                placeholder={t('importDialog.noFileSelected')}
                onClick={browse}
                style={{ height: '30px', fontSize: '11px', width: '100%', cursor: 'pointer' }}
                title={t('importDialog.pickFileTitle')}
              />
              <button
                className="btn btn-secondary"
                onClick={browse}
                disabled={submitting}
                style={{ marginTop: '6px', width: '100%' }}
              >
                {t('importDialog.pickFile')}
              </button>
            </div>

            {/* The target database: taken from the file's `USE`/`CREATE DATABASE`, or typed in */}
            {canManageDatabases && !!scan && !parsing && (
              <div className="form-group">
                <label style={labelStyle}>{t('importDialog.targetDb')}</label>
                <input
                  type="text"
                  className="form-input"
                  value={targetDb}
                  onChange={(e) => { setTargetDb(e.target.value); setError(null); }}
                  placeholder={currentDb ? t('importDialog.targetDbPlaceholderConnected', { db: currentDb }) : t('importDialog.targetDbPlaceholder')}
                  disabled={submitting}
                  style={{ height: '30px', fontSize: '11px', width: '100%' }}
                />
                <div style={{ fontSize: '10px', color: 'var(--win-text-secondary)', marginTop: '5px', lineHeight: 1.5 }}>
                  {dbFromFile ? (
                    <Trans i18nKey="importDialog.targetFromFile" values={{ db: dbFromFile }} components={{ code: <code style={{ fontFamily: 'monospace' }} /> }} />
                  ) : (
                    <Trans i18nKey="importDialog.targetNotInFile" components={{ strong: <b /> }} />
                  )}
                  {targetDb && currentDb && targetDb !== currentDb && (
                    <div style={{ color: 'var(--st-warn, #d98600)' }}>
                      <Trans i18nKey="importDialog.willSwitchTo" values={{ db: targetDb }} components={{ code: <b style={{ fontFamily: 'monospace' }} /> }} />
                    </div>
                  )}
                </div>
              </div>
            )}

            <div>
              <label style={labelStyle}>{t('importDialog.allowedFormats')}</label>
              <div style={{
                padding: '10px',
                background: 'var(--win-bg-window)',
                border: '1px solid var(--win-border)',
                borderRadius: '4px',
                fontSize: '11px',
                color: 'var(--win-text-secondary)',
                lineHeight: 1.6
              }}>
                <div><Trans i18nKey="importDialog.formatSqlDump" components={{ code: <code style={{ fontFamily: 'monospace', color: 'var(--win-text-primary)' }} /> }} /></div>
                <div><Trans i18nKey="importDialog.formatGz" components={{ code: <code style={{ fontFamily: 'monospace', color: 'var(--win-text-primary)' }} /> }} /></div>
              </div>
            </div>

            {file && (
              <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', lineHeight: 1.6 }}>
                {parsing && <div>{t('importDialog.readingTables')}</div>}
                {!parsing && scan && (
                  <>
                    {t('importDialog.fileSize')} <b style={{ color: 'var(--win-text-primary)' }}>{formatSize(scan.fileBytes)}</b>
                    <div><Trans i18nKey="importDialog.contentStatements" values={{ n: fmtNum(scan.statements) }} components={{ strong: <b style={{ color: 'var(--win-text-primary)' }} /> }} /></div>
                    {scan.via && <div>{t('importDialog.readVia', { tool: scan.via })}</div>}
                  </>
                )}
              </div>
            )}

            {/* Replaying a dump onto a database that already has same-named tables makes MySQL report
                1050 "Table already exists" and rolls the whole import back. This option drops them
                first. */}
            <div className="form-group">
              <label style={labelStyle}>{t('importDialog.onExisting')}</label>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(e) => setOverwrite(e.target.checked)}
                  disabled={submitting}
                  style={{ marginTop: '2px' }}
                />
                <span>
                  {t('importDialog.overwriteLabel')}
                  <span style={{ display: 'block', color: 'var(--win-text-secondary)', marginTop: '2px' }}>
                    {t('importDialog.overwriteHint')}
                  </span>
                </span>
              </label>

              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer', marginTop: '8px' }}>
                <input
                  type="checkbox"
                  checked={continueOnError}
                  onChange={(e) => setContinueOnError(e.target.checked)}
                  disabled={submitting}
                  style={{ marginTop: '2px' }}
                />
                <span>
                  {t('importDialog.continueOnErrorLabel')}
                  <span style={{ display: 'block', color: 'var(--win-text-secondary)', marginTop: '2px' }}>
                    {t('importDialog.continueOnErrorHint')}
                  </span>
                </span>
              </label>
            </div>

            <div style={{
              padding: '10px',
              background: overwrite ? 'rgba(229,72,77,0.10)' : 'rgba(255,170,0,0.08)',
              border: `1px solid ${overwrite ? 'rgba(229,72,77,0.40)' : 'rgba(255,170,0,0.35)'}`,
              borderRadius: '4px',
              fontSize: '11px',
              color: 'var(--win-text-secondary)',
              lineHeight: 1.5
            }}>
              <Trans
                i18nKey={overwrite ? 'importDialog.overwriteWarn' : 'importDialog.noOverwriteWarn'}
                components={{
                  code: <code style={{ fontFamily: 'monospace', color: 'var(--win-text-primary)' }} />,
                  strong: <b />,
                }}
              />
              <div style={{ marginTop: '4px' }}>
                <Trans i18nKey="importDialog.mysqlCommitWarn" components={{ strong: <b /> }} />
              </div>
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 0, padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {/* Tabs: pick tables | preview the structure | preview the data */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ display: 'flex', gap: '4px', flex: 1, minWidth: 0 }}>
                {([
                  { id: 'tables', label: t('importDialog.tabTables', { selected: selected.length, total: tables.length }) },
                  { id: 'structure', label: t('importDialog.tabStructure', { n: structureShown.length }) },
                  { id: 'data', label: t('importDialog.tabData', { n: dataShown.length }) },
                ] as const).map((tabDef) => (
                  <button
                    key={tabDef.id}
                    onClick={() => setTab(tabDef.id)}
                    style={{
                      padding: '4px 10px',
                      fontSize: '11px',
                      borderRadius: '4px',
                      border: '1px solid var(--win-border)',
                      cursor: 'pointer',
                      background: tab === tabDef.id ? 'var(--win-accent)' : 'transparent',
                      color: tab === tabDef.id ? '#fff' : 'var(--win-text-secondary)',
                      fontWeight: 600,
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {tabDef.label}
                  </button>
                ))}
              </div>
              {tab === 'tables' && (
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
                    whiteSpace: 'nowrap'
                  }}
                >
                  {allShownSelected ? t('importDialog.deselectAll') : t('importDialog.selectAll')}
                </button>
              )}
            </div>

            {tab === 'tables' ? (
              <>
                <input
                  type="text"
                  className="form-input"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('importDialog.searchTables')}
                  disabled={tables.length === 0}
                  style={{ height: '28px', fontSize: '11px', width: '100%' }}
                />

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
                  gap: '6px'
                }}>
                  {!file ? (
                    <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>
                      {t('importDialog.pickFileHint')}
                    </div>
                  ) : parsing ? (
                    <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('importDialog.readingFile')}</div>
                  ) : tables.length === 0 ? (
                    <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>
                      {t('importDialog.noTablesDetected')}
                    </div>
                  ) : shown.length === 0 ? (
                    <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>{t('importDialog.noTableMatch')}</div>
                  ) : (
                    shown.map((name) => (
                      <label key={name} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={selected.includes(name)}
                          onChange={() => setSelected((prev) => prev.includes(name) ? prev.filter((tbl) => tbl !== name) : [...prev, name])}
                        />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                      </label>
                    ))
                  )}
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', flex: 1, minWidth: 0 }}>
                    {tab === 'structure' ? t('importDialog.previewStructure') : t('importDialog.previewData')}
                    {viewMode === 'sql' && previewClipped && (previewComplete ? t('importDialog.previewClipped', { n: PREVIEW_LIMIT }) : t('importDialog.previewSample'))}
                    {viewMode === 'visual' && tab === 'data' && t('importDialog.previewRowsNote', { n: PREVIEW_ROWS })}:
                  </div>

                  {/* Choosing which tables to view (several) — a dropdown, to stay on one row */}
                  {viewMode === 'visual' && tables.length > 0 && (
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <button
                        onClick={() => setShowPreviewPicker((v) => !v)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '3px 9px',
                          fontSize: '10px',
                          borderRadius: '3px',
                          border: '1px solid var(--win-border)',
                          cursor: 'pointer',
                          background: showPreviewPicker ? 'var(--win-bg-hover)' : 'transparent',
                          color: 'var(--win-text-primary)',
                          fontWeight: 600,
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {t('importDialog.previewTablesCount', { shown: previewTables.length, total: tables.length })}
                        <ChevronDown size={11} style={{ opacity: 0.7 }} />
                      </button>

                      {showPreviewPicker && (
                        <>
                          <div style={{ position: 'fixed', inset: 0, zIndex: 10 }} onClick={() => setShowPreviewPicker(false)} />
                          {/* The background comes from .ws-menu — the menu has to be opaque enough not to blend into the table behind it */}
                          <div className="ws-menu" style={{
                            position: 'absolute',
                            top: 'calc(100% + 4px)',
                            right: 0,
                            zIndex: 11,
                            width: '220px',
                            maxHeight: '260px',
                            overflowY: 'auto'
                          }}>
                            <button
                              onClick={() => setPreviewTables(previewTables.length === tables.length ? [] : [...tables])}
                              style={{
                                width: '100%',
                                textAlign: 'left',
                                padding: '5px 8px',
                                marginBottom: '4px',
                                fontSize: '10px',
                                fontWeight: 600,
                                background: 'transparent',
                                border: 'none',
                                borderBottom: '1px solid var(--win-border)',
                                color: 'var(--win-accent)',
                                cursor: 'pointer'
                              }}
                            >
                              {previewTables.length === tables.length ? t('importDialog.deselectAll') : t('importDialog.selectAll')}
                            </button>
                            {tables.map((name) => (
                              <label
                                key={name}
                                className="sidebar-context-item"
                                style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer', borderRadius: '3px' }}
                              >
                                <input
                                  type="checkbox"
                                  checked={previewTables.includes(name)}
                                  onChange={() => togglePreviewTable(name)}
                                />
                                <span style={{ fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                              </label>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* Toggles between the visual view and the raw SQL */}
                  <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
                    {([
                      { id: 'visual', label: t('importDialog.viewVisual') },
                      { id: 'sql', label: 'SQL' },
                    ] as const).map((v) => (
                      <button
                        key={v.id}
                        onClick={() => setViewMode(v.id)}
                        style={{
                          padding: '3px 9px',
                          fontSize: '10px',
                          borderRadius: '3px',
                          border: '1px solid var(--win-border)',
                          cursor: 'pointer',
                          background: viewMode === v.id ? 'var(--win-bg-hover)' : 'transparent',
                          color: viewMode === v.id ? 'var(--win-text-primary)' : 'var(--win-text-secondary)',
                          fontWeight: 600
                        }}
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
                </div>

                {viewMode === 'sql' ? (
                  <textarea
                    readOnly
                    value={
                      (tab === 'structure' ? structureShown : dataShown)
                        .slice(0, PREVIEW_LIMIT)
                        .map((s) => clip(s.text) + ';')
                        .join('\n\n') ||
                      (file
                        ? (parsing ? t('importDialog.readingFile') : t('importDialog.previewEmptyMatch'))
                        : t('importDialog.previewPickFile'))
                    }
                    style={{
                      flex: 1,
                      minHeight: 0,
                      width: '100%',
                      background: 'var(--win-bg-window)',
                      border: '1px solid var(--win-border)',
                      borderRadius: '4px',
                      color: 'var(--win-text-primary)',
                      fontFamily: 'monospace',
                      fontSize: '11px',
                      padding: '10px',
                      resize: 'none',
                      outline: 'none'
                    }}
                  />
                ) : (
                  <div style={{
                    flex: 1,
                    minHeight: 0,
                    overflow: 'auto',
                    border: '1px solid var(--win-border)',
                    borderRadius: '4px',
                    background: 'var(--win-bg-window)',
                    padding: '8px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px'
                  }}>
                    {!file ? (
                      <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>
                        {t('importDialog.previewPickFile')}
                      </div>
                    ) : parsing ? (
                      <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('importDialog.readingFile')}</div>
                    ) : tab === 'structure' ? (
                      visualTables.length === 0 ? (
                        <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>
                          {t('importDialog.noCreateTable')}
                          {structureShown.length > 0 && (
                            <Trans i18nKey="importDialog.noCreateTableMore" values={{ n: structureShown.length }} components={{ strong: <b /> }} />
                          )}.
                        </div>
                      ) : (
                        // Not named `t` — that is the translation function.
                        visualTables.map((vt) => (
                          <div key={vt.name} style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-primary)', marginBottom: '4px', fontFamily: 'monospace' }}>
                              {vt.name} <span style={{ fontWeight: 400, color: 'var(--win-text-secondary)', fontFamily: 'inherit' }}>{t('importDialog.columnsCount', { n: vt.columns.length })}</span>
                            </div>
                            <div style={{ overflowX: 'auto', minWidth: 0 }}>
                            <table style={{ minWidth: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                              <thead>
                                <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                                  {[t('importDialog.colColumn'), t('importDialog.colType'), t('importDialog.colNull'), t('importDialog.colKey'), t('importDialog.colDefault')].map((h) => (
                                    <th key={h} style={{ padding: '4px 8px', textAlign: 'left', fontWeight: 600, borderRight: '1px solid var(--win-border)', whiteSpace: 'nowrap' }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {vt.columns.map((c) => (
                                  <tr key={c.name} style={{ borderBottom: '1px solid var(--win-border)' }}>
                                    <td style={{ padding: '4px 8px', borderRight: '1px solid var(--win-border)', fontFamily: 'monospace', color: 'var(--win-text-primary)', whiteSpace: 'nowrap' }}>{c.name}</td>
                                    <td style={{ padding: '4px 8px', borderRight: '1px solid var(--win-border)', color: 'var(--win-text-secondary)', fontFamily: 'monospace' }}>{c.type}</td>
                                    <td style={{ padding: '4px 8px', borderRight: '1px solid var(--win-border)', color: 'var(--win-text-secondary)', whiteSpace: 'nowrap' }}>{c.notNull ? 'NOT NULL' : 'NULL'}</td>
                                    <td style={{ padding: '4px 8px', borderRight: '1px solid var(--win-border)', color: c.primaryKey ? 'var(--win-accent)' : 'var(--win-text-disabled)', whiteSpace: 'nowrap' }}>
                                      {c.primaryKey
                                        ? (c.autoIncrement ? t('importDialog.pkAuto') : t('importDialog.pk'))
                                        : (c.autoIncrement ? t('importDialog.auto') : '—')}
                                    </td>
                                    <td style={{ padding: '4px 8px', color: 'var(--win-text-secondary)', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '140px' }}>
                                      {c.defaultValue ?? '—'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            </div>
                            {vt.constraints.length > 0 && (
                              <div style={{ fontSize: '10px', color: 'var(--win-text-secondary)', marginTop: '4px', lineHeight: 1.5 }}>
                                {vt.constraints.map((c, i) => (
                                  <div key={i} style={{ fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c}</div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))
                      )
                    ) : visualRows.length === 0 ? (
                      <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
                        {t('importDialog.noInsert')}
                      </div>
                    ) : (
                      visualRows.map((r) => (
                        <div key={r.table} style={{ minWidth: 0 }}>
                          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-primary)', marginBottom: '4px', fontFamily: 'monospace' }}>
                            {r.table}{' '}
                            <span style={{ fontWeight: 400, color: 'var(--win-text-secondary)', fontFamily: 'inherit' }}>
                              {previewComplete
                                ? t('importDialog.showingRows', { shown: r.rows.length, total: r.total })
                                : t('importDialog.showingRowsSample', { shown: r.rows.length })}
                            </span>
                          </div>
                          <div style={{ overflowX: 'auto', minWidth: 0 }}>
                            <table style={{ minWidth: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                              <thead>
                                <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                                  {(r.columns || r.rows[0]?.map((_, i) => t('importDialog.unnamedColumn', { n: i + 1 })) || []).map((c, i) => (
                                    <th key={i} style={{ padding: '4px 8px', textAlign: 'left', fontWeight: 600, borderRight: '1px solid var(--win-border)', whiteSpace: 'nowrap' }}>{c}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {r.rows.map((row, ri) => (
                                  <tr key={ri} style={{ borderBottom: '1px solid var(--win-border)' }}>
                                    {row.map((v, ci) => (
                                      <td key={ci} style={{ padding: '4px 8px', borderRight: '1px solid var(--win-border)', color: 'var(--win-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '180px' }}>
                                        {/^NULL$/i.test(v)
                                          ? <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>NULL</span>
                                          : v}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
  );

  const footerContent = (
    <>
      {progress ? (
        <ProgressBar progress={progress} />
      ) : error ? (
        <span style={{ marginRight: 'auto', fontSize: '11px', color: 'var(--st-danger, #ff6b6b)' }}>
          {error}
        </span>
      ) : null}
      <button className="btn btn-secondary" onClick={onClose} disabled={submitting} style={{ flexShrink: 0 }}>{t('common.cancel')}</button>
      <button
        className="btn btn-primary"
        onClick={askConfirm}
        disabled={!canSubmit}
        style={{
          background: canSubmit ? 'var(--win-accent)' : 'var(--win-bg-hover)',
          color: canSubmit ? '#fff' : 'var(--win-text-disabled)',
          border: 'none',
          cursor: canSubmit ? 'pointer' : 'not-allowed',
          flexShrink: 0
        }}
      >
        {submitting ? t('importDialog.importing') : t('importDialog.startImport')}
      </button>
    </>
  );

  if (asTab) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', width: '100%', overflow: 'hidden', background: 'var(--win-bg-window)' }}>
        {confirmDialog}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 18px', borderBottom: '1px solid var(--win-border)', background: 'var(--win-bg-card)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
              {t('importDialog.title')}
            </span>
            {currentDb && (
              <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: 'var(--win-bg-hover)', border: '1px solid var(--win-border)', color: 'var(--win-text-secondary)' }}>
                {currentDb}
              </span>
            )}
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
    <>
      {confirmDialog}
      <Modal
        title={t('importDialog.title')}
        onClose={onClose}
        closeDisabled={submitting}
        width="820px"
        height="540px"
        zIndex={9999}
      >
        {bodyContent}
        <ModalFooter>
          {footerContent}
        </ModalFooter>
      </Modal>
    </>
  );
};
