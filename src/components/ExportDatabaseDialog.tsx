import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import { dbHelper } from '../utils/dbHelper';
import { getLastExportDir, pickExportFolder } from '../utils/fileSave';
import { fileStamp, missingViewDeps, safeFileBase } from '../utils/exportHelper';
import {
  KIND_LABEL_KEY as LABEL_KEY,
  KIND_ORDER,
  buildDumpObjects,
  isSqlOnlyKind,
  keysWithTriggers as keysWithTriggersOf,
  objKey,
  splitSelection,
  type DumpObj as ExportObj,
  type DumpObjKind as ExportObjKind,
} from '../utils/dumpObjects';
import { Modal, ModalFooter } from './Modal';

export type DatabaseExportFormat = 'sql' | 'json' | 'csv' | 'xlsx';

export interface DatabaseExportOptions {
  format: DatabaseExportFormat;
  tables: string[];
  /**
   * Which names in `tables` are VIEWs rather than tables. A SQL dump has to create views AFTER every
   * table and must not export a view's data — see `orderViewsByDependency` in exportHelper.ts.
   */
  views: string[];
  /**
   * The selected functions and procedures. Meaningful only for the SQL format with "include
   * structure" on; the dump writes them AFTER tables and views, because a routine's body references
   * them.
   */
  routines: { name: string; kind: 'function' | 'procedure' }[];
  /** The selected triggers — written last, after the routines (a trigger may call a function). */
  triggers: string[];
  /** MySQL scheduled events; Postgres and SQLite have none, so this is always empty. */
  events: string[];
  filename: string;
  sqlOptions: { dropTable: boolean; includeStructure: boolean; includeContent: boolean };
  compressGzip: boolean;
  /** The directory to save into; null = download through the WebView into the system's downloads folder. */
  dir: string | null;
  // There is NO progress parameter any more: the export runs as a background job (utils/jobs.ts) and
  // reports into JobsTray. The dialog closes as soon as the job is queued, so a callback here would
  // only draw for nobody.
}

interface ExportDatabaseDialogProps {
  /** The connection this component acts on. Passed explicitly, never read from the ambient id (§4.1). */
  connId: string;
  open?: boolean;
  onClose: () => void;
  /** Returns true when the export finished (the dialog closes itself), false to keep it open for edits. */
  onSubmit: (options: DatabaseExportOptions) => Promise<boolean>;
  /** The open database — used to suggest a file name when exporting several objects. */
  dbName?: string;
  asTab?: boolean;
}

const FORMAT_LABEL: Record<DatabaseExportFormat, string> = {
  sql: 'SQL',
  json: 'JSON',
  csv: 'CSV (ZIP)',
  xlsx: 'XLSX',
};

/** Translation keys for the per-format hint; resolved with `t()` in the component. */
const FORMAT_HINT_KEY = {
  sql: 'exportDialog.descSql',
  json: 'exportDialog.descJson',
  csv: 'exportDialog.descCsv',
  xlsx: 'exportDialog.descXlsx',
} as const satisfies Record<DatabaseExportFormat, string>;

const labelStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--win-text-secondary)',
  display: 'block',
  marginBottom: '6px',
};

// The object model (kinds, keys, group order, the trigger-follows-table rule) lives in
// `utils/dumpObjects.ts`: `CopyDatabaseDialog` builds the same list from the same three calls, and a
// second copy of "what can go into a dump" would drift from this one silently.

// Diacritics are stripped so table search ignores them (as the Sidebar's search box does).
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');
const removeAccents = (s: string) =>
  s.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();

/**
 * The "Export Database" dialog — a two-column layout: settings on the left (file name, format, SQL
 * options) and the table list on the right, filling the height so the dialog itself never scrolls.
 */
export const ExportDatabaseDialog: React.FC<ExportDatabaseDialogProps> = ({ connId, open = true, onClose, onSubmit, dbName, asTab = false }) => {
  const { t } = useTranslation();
  // The file name is suggested from the selection, but typing stops the suggestions
  // (`filenameTouched`) — otherwise every extra table ticked would erase the name they just chose.
  const [filename, setFilename] = useState('');
  const [filenameTouched, setFilenameTouched] = useState(false);
  // The timestamp is fixed ONCE when the dialog opens: recomputing it per render makes the number in
  // the field jump around while the user is ticking things.
  const [stamp, setStamp] = useState('');
  const [format, setFormat] = useState<DatabaseExportFormat>('sql');
  const [dropTable, setDropTable] = useState(true);
  const [includeStructure, setIncludeStructure] = useState(true);
  const [includeContent, setIncludeContent] = useState(true);
  const [compressGzip, setCompressGzip] = useState(false);
  // Tables + views + functions/procedures + triggers, in the order they will be written into the dump.
  const [objects, setObjects] = useState<ExportObj[]>([]);
  // Keyed `kind:name`, not by a bare name — see ExportObj.
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [tablesLoading, setTablesLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dir, setDir] = useState(getLastExportDir());
  // Each view's DDL, loaded in the background once the list exists — used only to warn about a missing source table.
  const [viewDefs, setViewDefs] = useState<{ name: string; sql: string }[]>([]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setSearch('');
      setError(null);
      setFilenameTouched(false);
      setStamp(fileStamp());
      setTablesLoading(true);
    });
    let cancelled = false;
    (async () => {
      // Three sources: getTables (tables and views), getDatabaseObjects (routines), getAllTriggers.
      // A failure to fetch routines or triggers returns an empty array rather than breaking the dialog.
      const [list, dbObjs, triggers] = await Promise.all([
        dbHelper.getTables(connId),
        dbHelper.getDatabaseObjects(connId),
        dbHelper.getAllTriggers(connId),
      ]);
      if (cancelled) return;
      const viewSet = new Set(list.filter((item) => item.type === 'view').map((item) => item.name));
      const all = buildDumpObjects(list, dbObjs, triggers);
      setObjects(all);
      setSelected(all.map(objKey));
      setTablesLoading(false);

      // View DDL is loaded afterwards and does NOT block the list: it only feeds the "view is missing
      // its source table" warning, and each view is a backend call, which is not worth waiting for.
      const viewNames = [...viewSet];
      if (viewNames.length > 0) {
        const defs = await Promise.all(
          viewNames.map(async (name) => {
            const def = await dbHelper.getTableDefinition(connId, name);
            return { name, sql: def.success && def.sql ? def.sql : '' };
          })
        );
        if (!cancelled) setViewDefs(defs.filter((d) => d.sql));
      }
    })();
    return () => { cancelled = true; };
  }, [connId, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, submitting]);

  if (!open) return null;

  // A non-SQL format can only export table data -> routines and triggers vanish from the list (they
  // stay in `selected`, so switching back to SQL restores the previous choice intact).
  const listable = format === 'sql' ? objects : objects.filter((o) => !isSqlOnlyKind(o.kind));
  const shown = search.trim()
    ? listable.filter((o) => removeAccents(o.name).includes(removeAccents(search.trim())))
    : listable;
  const allShownSelected = shown.length > 0 && shown.every((o) => selected.includes(objKey(o)));

  // Acting on a table carries its triggers along — see `keysWithTriggers` in `utils/dumpObjects.ts`.
  const keysWithTriggers = (items: ExportObj[]) => keysWithTriggersOf(objects, items);

  const toggleAllShown = () => {
    const keys = keysWithTriggers(shown);
    if (allShownSelected) setSelected(selected.filter((k) => !keys.includes(k)));
    else setSelected([...new Set([...selected, ...keys])]);
  };

  const toggleOne = (key: string) => {
    const target = objects.find((o) => objKey(o) === key);
    const keys = target ? keysWithTriggers([target]) : [key];
    setSelected((prev) =>
      prev.includes(key) ? prev.filter((k) => !keys.includes(k)) : [...new Set([...prev, ...keys])]
    );
  };

  /**
   * Exactly ONE object selected -> its own name is used; more than one -> the database's name.
   * A timestamp comes along so two exports in a row do not overwrite each other.
   */
  const chosenNow = listable.filter((o) => selected.includes(objKey(o)));
  const suggestedName = `${safeFileBase(
    chosenNow.length === 1 ? chosenNow[0].name : dbName || 'database'
  )}_${stamp}`;
  const effectiveFilename = filenameTouched ? filename : suggestedName;

  // Grouped by kind in KIND_ORDER; a kind with no objects disappears entirely.
  const groups = KIND_ORDER
    .map((kind) => ({ kind, items: shown.filter((o) => o.kind === kind) }))
    .filter((g) => g.items.length > 0);

  // The count chip above doubles as the select/deselect button for the whole group.
  const kindItems = (kind: ExportObjKind) => listable.filter((o) => o.kind === kind);
  const isKindFullySelected = (kind: ExportObjKind) => {
    const items = kindItems(kind);
    return items.length > 0 && items.every((o) => selected.includes(objKey(o)));
  };
  const toggleKind = (kind: ExportObjKind) => {
    const keys = keysWithTriggers(kindItems(kind));
    const on = isKindFullySelected(kind);
    setSelected((prev) =>
      on ? prev.filter((k) => !keys.includes(k)) : [...new Set([...prev, ...keys])]
    );
  };

  // A warning (nothing is ticked automatically): a selected view whose source table is not selected.
  const selectedNames = new Set(chosenNow.map((o) => o.name.toLowerCase()));
  const tableNames = objects.filter((o) => o.kind === 'table').map((o) => o.name);
  const viewWarnings =
    format === 'sql' && includeStructure
      ? missingViewDeps(
          viewDefs.filter((v) => selectedNames.has(v.name.toLowerCase())),
          tableNames,
          selectedNames
        )
      : [];

  const submit = async () => {
    const chosen = chosenNow;
    if (chosen.length === 0) {
      setError(t('exportDialog.errPickTable'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const ok = await onSubmit({
        format,
        // The old contract is kept: `tables` includes the views, and `views` merely marks which are views.
        ...splitSelection(chosen),
        filename: effectiveFilename.trim() || suggestedName,
        sqlOptions: { dropTable, includeStructure, includeContent },
        compressGzip,
        dir: dir || null,
      });
      if (ok) onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const chooseFolder = async () => {
    const picked = await pickExportFolder(dir || undefined);
    if (picked) setDir(picked);
  };

  if (!open && !asTab) return null;

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
            <label style={labelStyle}>{t('exportDialog.fileName')}</label>
            <input
              type="text"
              className="form-input"
              value={effectiveFilename}
              onChange={(e) => {
                setFilenameTouched(true);
                setFilename(e.target.value);
              }}
              placeholder={suggestedName}
              style={{ height: '30px', fontSize: '11px', width: '100%' }}
            />
          </div>

          <div className="form-group">
            <label style={labelStyle}>{t('exportDialog.saveFolder')}</label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                type="text"
                className="form-input"
                readOnly
                value={dir}
                placeholder={t('exportDialog.folderPlaceholder')}
                onClick={chooseFolder}
                title={dir || t('exportDialog.pickFolderTitle')}
                style={{ flex: 1, minWidth: 0, height: '30px', fontSize: '11px', cursor: 'pointer' }}
              />
              <button
                className="btn btn-secondary"
                onClick={chooseFolder}
                disabled={submitting}
                style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}
              >
                <FolderOpen size={13} />
                {t('exportDialog.pick')}
              </button>
              {dir && (
                <button className="btn btn-secondary" onClick={() => setDir('')} disabled={submitting} style={{ padding: '0 10px' }}>
                  {t('exportDialog.clear')}
                </button>
              )}
            </div>
          </div>

          <div>
            <label style={labelStyle}>{t('exportDialog.formatLabel')}</label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {(['sql', 'json', 'csv', 'xlsx'] as const).map((fmt) => (
                <button
                  key={fmt}
                  onClick={() => setFormat(fmt)}
                  style={{
                    padding: '6px 12px',
                    fontSize: '11px',
                    borderRadius: '4px',
                    border: '1px solid var(--win-border)',
                    cursor: 'pointer',
                    background: format === fmt ? 'var(--win-accent)' : 'transparent',
                    color: format === fmt ? '#fff' : 'var(--win-text-secondary)',
                    fontWeight: 600
                  }}
                >
                  {FORMAT_LABEL[fmt]}
                </button>
              ))}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', marginTop: '8px', lineHeight: 1.5 }}>
              {t(FORMAT_HINT_KEY[format])}
            </div>
          </div>

          {format === 'sql' && (
            <div>
              <label style={labelStyle}>{t('exportDialog.sqlOptions')}</label>
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                padding: '10px',
                background: 'var(--win-bg-window)',
                border: '1px solid var(--win-border)',
                borderRadius: '4px'
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={dropTable} onChange={(e) => setDropTable(e.target.checked)} />
                  <span>{t('exportDialog.optDropTable')}</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={includeStructure} onChange={(e) => setIncludeStructure(e.target.checked)} />
                  <span>{t('exportDialog.optStructure')}</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={includeContent} onChange={(e) => setIncludeContent(e.target.checked)} />
                  <span>{t('exportDialog.optData')}</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={compressGzip} onChange={(e) => setCompressGzip(e.target.checked)} />
                  <span>{t('exportDialog.optGzip')}</span>
                </label>
              </div>
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0, padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <label style={{ ...labelStyle, marginBottom: 0 }}>
              {t('exportDialog.objectsToExport', { selected: selected.length, total: objects.length })}
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
                whiteSpace: 'nowrap'
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

          {/* The per-kind count summary — OUTSIDE the scroll area, so whether there are routines or
              triggers is visible at once without scrolling past every table. */}
          {!tablesLoading && objects.length > 0 && (
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
                  >{t(LABEL_KEY[kind])} {n}</button>
                );
              })}
            </div>
          )}

          {/* A warning only, nothing ticked automatically: a partial export is a legitimate thing to want. */}
          {viewWarnings.length > 0 && (
            <div style={{
              fontSize: '10.5px',
              lineHeight: 1.5,
              color: 'var(--st-warn, #d68a00)',
              background: 'var(--win-bg-window)',
              border: '1px solid var(--win-border)',
              borderRadius: '4px',
              padding: '6px 8px',
            }}>
              {viewWarnings.slice(0, 3).map((w) => (
                <div key={w.view}>
                  {t('exportDialog.warnViewDeps', { view: w.view, tables: w.missing.join(', ') })}
                </div>
              ))}
              {viewWarnings.length > 3 && (
                <div>{t('exportDialog.warnViewDepsMore', { n: viewWarnings.length - 3 })}</div>
              )}
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
            gap: '6px'
          }}>
            {tablesLoading ? (
              <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('exportDialog.loadingTables')}</div>
            ) : shown.length === 0 ? (
              <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>
                {objects.length === 0 ? t('exportDialog.noTables') : t('exportDialog.noTableMatch')}
              </div>
            ) : (
              groups.map((group) => (
                <React.Fragment key={group.kind}>
                  {/* The group heading sticks to the top of the scroll area: with sakila, 23 tables push
                      routines and triggers all the way down, and without a heading they look excluded. */}
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
                    {t(LABEL_KEY[group.kind])} · {group.items.length}
                  </div>
                  {group.items.map((obj) => {
                    const key = objKey(obj);
                    return (
                      <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                        <input type="checkbox" checked={selected.includes(key)} onChange={() => toggleOne(key)} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{obj.name}</span>
                        {/* A trigger follows its owning table -> say which one. */}
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
      {error ? (
        <span style={{ marginRight: 'auto', fontSize: '11px', color: 'var(--st-danger, #ff6b6b)' }}>
          {error}
        </span>
      ) : null}
      <button className="btn btn-secondary" onClick={onClose} disabled={submitting} style={{ flexShrink: 0 }}>{t('common.cancel')}</button>
      <button
        className="btn btn-primary"
        onClick={submit}
        disabled={submitting || tablesLoading || selected.length === 0}
        style={{ background: 'var(--win-accent)', color: '#fff', border: 'none', flexShrink: 0 }}
      >
        {submitting ? t('exportDialog.exporting') : t('exportDialog.startExport')}
      </button>
    </>
  );

  if (asTab) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', width: '100%', overflow: 'hidden', background: 'var(--win-bg-window)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 18px', borderBottom: '1px solid var(--win-border)', background: 'var(--win-bg-card)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
              {t('exportDialog.dbTitle')}
            </span>
            {dbName && (
              <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: 'var(--win-bg-hover)', border: '1px solid var(--win-border)', color: 'var(--win-text-secondary)' }}>
                {dbName}
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
    <Modal
      title={t('exportDialog.dbTitle')}
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
  );
};
