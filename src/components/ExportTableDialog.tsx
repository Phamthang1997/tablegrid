import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import { dbHelper } from '../utils/dbHelper';
import { buildTableFile, buildPreview, type ExportFormat } from '../utils/exportHelper';
import { getLastExportDir, openInFileManager, pickExportFolder, saveExportFile } from '../utils/fileSave';
import { ProgressBar, type ProgressState } from './ProgressBar';
import { ConfirmDialog } from './ConfirmDialog';
import { Modal, ModalBody, ModalFooter } from './Modal';

/** The grid's context — present only when opened from a table tab (the bar under DataGrid). */
export interface ExportGridContext {
  columns: string[];
  visibleColumns: string[];
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  filter?: string;
  /**
   * The grid's EXACT row count, or `null` when the grid only has an estimate.
   *
   * `fetchAllRows` stops once `all.length >= total`, so a number that is too low here means an
   * exported file truncated with no error at all. With `null` the loop takes its total from its own
   * first page read — and that one always counts exactly (`dbHelper.getTableData`'s default
   * `countMode`).
   */
  totalCount?: number | null;
  /**
   * The rows the user has selected in the grid, in screen order, or undefined/empty when nothing is
   * selected. Row OBJECTS rather than keys: they are already in the frontend's hands, so exporting a
   * selection reads nothing from the database at all.
   */
  selectedRows?: any[];
}

interface ExportTableDialogProps {
  /** The connection this component acts on. Passed explicitly, never read from the ambient id (§4.1). */
  connId: string;
  open: boolean;
  tableName: string;
  dbType: string;
  /** Left empty (opened from the Sidebar's context menu) -> the column list is read from the schema. */
  grid?: ExportGridContext;
  onClose: () => void;
  onSuccess?: (msg: string) => void;
  onError?: (msg: string) => void;
}

const FORMATS: ExportFormat[] = ['csv', 'json', 'sql', 'xlsx'];

/** Rows per call while loading a whole table for export, so progress can be reported. */
const FETCH_PAGE_SIZE = 2000;
/** How many sample rows the preview step fetches. */
const PREVIEW_ROWS = 20;

const labelStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--win-text-secondary)',
  display: 'block',
  marginBottom: '6px',
};

/**
 * Exporting ONE table: step 1 picks the options, step 2 previews and downloads the file.
 * Shared by the Export button in the bar under the grid and the "Export data…" entry in the Sidebar's
 * context menu, so both paths lead to the same dialog.
 */
export const ExportTableDialog: React.FC<ExportTableDialogProps> = ({
  connId,
  open,
  tableName,
  dbType,
  grid,
  onClose,
  onSuccess,
  onError,
}) => {
  const { t, i18n } = useTranslation();
  const fmtNum = (n: number) => n.toLocaleString(i18n.language);

  const [step, setStep] = useState<'options' | 'preview'>('options');
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [fileName, setFileName] = useState(tableName);
  const [visibleOnly, setVisibleOnly] = useState(false);
  const [applyView, setApplyView] = useState(true); // use the sort/filter currently applied on the grid
  // Off by default: "export this table" is what the button says, and a selection left over from an
  // earlier click must not quietly shrink the file the user asked for.
  const [onlySelected, setOnlySelected] = useState(false);
  const [schemaCols, setSchemaCols] = useState<string[]>([]);
  const [fetchedRows, setFetchedRows] = useState<any[]>([]); // sample rows, for the preview only
  const [fetchedTotal, setFetchedTotal] = useState(0);
  const [fetching, setFetching] = useState(false);
  const [dir, setDir] = useState(getLastExportDir());
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [done, setDone] = useState<
    { message: string; path?: string; dir?: string; viaDownload: boolean } | null
  >(null);

  // Each open is a new export pass.
  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setStep('options');
      setFileName(tableName);
      setFetchedRows([]);
    });
  }, [open, tableName]);

  // With no grid context, the columns come from the schema, so the CSV/SQL header keeps the right order.
  useEffect(() => {
    if (!open || grid) return;
    let cancelled = false;
    (async () => {
      const s = await dbHelper.getTableSchema(connId, tableName);
      if (!cancelled) setSchemaCols((s.columns || []).map((c) => c.name));
    })();
    return () => { cancelled = true; };
  }, [connId, open, grid, tableName]);

  /**
   * The preview of a SELECTION is derived, not fetched and not stored.
   *
   * Those rows are already in memory, so an effect writing them into state would only be React
   * synchronising with itself — and it had a real cost: the write ran synchronously while the
   * fetch path queues its `setFetching(true)` in a microtask, so the two orders had to be reasoned
   * about together to keep the preview from sticking on "loading" forever. Deriving removes the
   * ordering question instead of documenting it (and clears oxlint's `set-state-in-effect`).
   */
  const pickedRows = onlySelected && grid?.selectedRows?.length ? grid.selectedRows : null;
  const pickedPreview = React.useMemo(
    () => (pickedRows ? pickedRows.slice(0, PREVIEW_ROWS) : null),
    [pickedRows],
  );
  const rows = pickedPreview ?? fetchedRows;
  const totalRows = pickedRows ? pickedRows.length : fetchedTotal;
  const loading = pickedRows ? false : fetching;

  const colNames = React.useMemo(() => {
    const all = grid ? grid.columns : schemaCols;
    if (!grid || !visibleOnly || grid.visibleColumns.length === 0) return all;
    return all.filter((n) => grid.visibleColumns.includes(n));
  }, [grid, schemaCols, visibleOnly]);

  // The preview step fetches only A FEW SAMPLE ROWS, for speed; the full data is loaded only when
  // export is pressed (see fetchAllRows) — which is when the progress bar appears.
  useEffect(() => {
    if (!open || step !== 'preview') return;
    // A selection needs no read, and must not do one: the picked rows are not page 1 of anything.
    // `pickedPreview` above already IS that preview, so this effect has nothing left to do.
    if (pickedRows) return;
    let cancelled = false;
    queueMicrotask(() => {
      setFetching(true);
    });
    (async () => {
      const useView = !!grid && applyView;
      const data = await dbHelper.getTableData(connId, 
        tableName,
        1,
        PREVIEW_ROWS,
        useView ? grid?.sortBy : undefined,
        useView ? grid?.sortDir : undefined,
        useView ? grid?.filter : undefined
      );
      if (cancelled) return;
      setFetchedRows(data.rows || []);
      setFetchedTotal(grid?.totalCount || data.totalCount || 0);
      setFetching(false);
    })();
    return () => { cancelled = true; };
  }, [connId, open, step, tableName, grid, applyView, pickedRows]);

  /** Loads EVERY row page by page, reporting real progress from the rows fetched so far. */
  const fetchAllRows = async (): Promise<any[]> => {
    // Same as the preview: already in memory, so there is no page to wait for and no progress to
    // report. `applyView` is irrelevant here — the selection is in screen order, which is the sorted
    // and filtered order the user was looking at when they made it.
    if (onlySelected && grid?.selectedRows?.length) return grid.selectedRows;
    const useView = !!grid && applyView;
    const all: any[] = [];
    let total = totalRows;
    let page = 1;
    for (;;) {
      setProgress({
        label: t('exportDialog.loadingTable', { table: tableName }),
        current: all.length,
        total: total || undefined,
        detail: total
          ? t('exportDialog.rowsOfTotal', { rows: fmtNum(all.length), total: fmtNum(total) })
          : t('exportDialog.rows', { rows: fmtNum(all.length) }),
      });
      const data = await dbHelper.getTableData(connId, 
        tableName,
        page,
        FETCH_PAGE_SIZE,
        useView ? grid?.sortBy : undefined,
        useView ? grid?.sortDir : undefined,
        useView ? grid?.filter : undefined
      );
      const batch = data.rows || [];
      all.push(...batch);
      if (!total && data.totalCount) total = data.totalCount;
      if (batch.length < FETCH_PAGE_SIZE) break;
      if (total && all.length >= total) break;
      page++;
    }
    setProgress({
      label: t('exportDialog.loadingTable', { table: tableName }),
      current: all.length,
      total: all.length,
      detail: t('exportDialog.rows', { rows: fmtNum(all.length) }),
    });
    return all;
  };

  // Builds preview on format or rows / columns change.
  const preview = React.useMemo(() => {
    if (!open || step !== 'preview' || loading) return '';
    const cols = colNames.length ? colNames : (rows[0] ? Object.keys(rows[0]) : []);
    return buildPreview(format, tableName, cols, rows, dbType, PREVIEW_ROWS);
  }, [open, step, loading, format, rows, colNames, tableName, dbType]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const chooseFolder = async () => {
    const picked = await pickExportFolder(dir || undefined);
    if (picked) setDir(picked);
  };

  const download = async () => {
    try {
      // Only here is the full data loaded — until now the preview used a few sample rows.
      const allRows = await fetchAllRows();
      const cols = colNames.length ? colNames : (allRows[0] ? Object.keys(allRows[0]) : []);
      setProgress({ label: t('exportDialog.building', { format: format.toUpperCase() }) });
      const file = buildTableFile(tableName, cols, allRows, format, dbType, fileName);
      setProgress({ label: t('exportDialog.writing') });
      const res = await saveExportFile(dir || null, file.name, file.data, file.mime);
      setProgress(null);
      setDone({
        message: t('exportDialog.exportedTable', { table: tableName, rows: allRows.length, format: format.toUpperCase() }),
        path: res.path || file.name,
        dir: res.dir,
        viaDownload: res.savedTo === 'download',
      });
    } catch (err: any) {
      setProgress(null);
      onError?.(t('exportDialog.errExport', { message: err?.message || err }));
    }
  };

  const closeDone = (openFolder: boolean) => {
    const dirToOpen = done?.dir;
    const msg = done?.message;
    setDone(null);
    if (openFolder && dirToOpen) openInFileManager(dirToOpen);
    if (msg) onSuccess?.(msg + (dirToOpen ? ` (${dirToOpen})` : ''));
    onClose();
  };

  // Once exported, it offers to open the containing folder rather than closing at once.
  if (done) {
    return (
      <ConfirmDialog
        open
        tone="success"
        title={t('app.exportDoneTitle')}
        message={
          <>
            {done.message}
            {done.path && (
              <div style={{ marginTop: '6px', fontFamily: 'monospace', wordBreak: 'break-all', color: 'var(--win-text-secondary)' }}>
                {done.dir && done.viaDownload ? `${done.dir}` : done.path}
              </div>
            )}
          </>
        }
        note={done.viaDownload ? t('app.exportDoneNoteWebView') : undefined}
        confirmLabel={done.dir ? t('app.openFolder') : t('common.close')}
        cancelLabel={t('common.close')}
        onConfirm={() => closeDone(true)}
        onCancel={() => closeDone(false)}
      />
    );
  }

  return (
    <Modal
      title={step === 'options'
        ? t('exportDialog.titleOptions', { table: tableName })
        : t('exportDialog.titlePreview', { table: tableName })}
      onClose={onClose}
      width={step === 'options' ? '500px' : '640px'}
      zIndex={10000}
    >
        {step === 'options' ? (
          <>
            <ModalBody>
              <div className="form-group">
                <label style={labelStyle}>{t('exportDialog.fileName')}</label>
                <input
                  type="text"
                  className="form-input"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  placeholder={tableName}
                  style={{ height: '30px', fontSize: '11px', width: '100%' }}
                />
              </div>

              <div className="form-group">
                <label style={labelStyle}>{t('exportDialog.saveFolder')}</label>
                <div style={{ display: 'flex', gap: '8px' }}>
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
                    style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}
                  >
                    <FolderOpen size={13} />
                    {t('exportDialog.pick')}
                  </button>
                  {dir && (
                    <button className="btn btn-secondary" onClick={() => setDir('')} style={{ padding: '0 10px', whiteSpace: 'nowrap' }}>
                      {t('exportDialog.clear')}
                    </button>
                  )}
                </div>
              </div>

              <div>
                <label style={labelStyle}>{t('exportDialog.formatLabel')}</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {FORMATS.map((fmt) => (
                    <button
                      key={fmt}
                      onClick={() => setFormat(fmt)}
                      style={{
                        padding: '6px 16px',
                        fontSize: '11px',
                        borderRadius: '4px',
                        border: '1px solid var(--win-border)',
                        cursor: 'pointer',
                        background: format === fmt ? 'var(--win-accent)' : 'transparent',
                        color: format === fmt ? '#fff' : 'var(--win-text-secondary)',
                        fontWeight: 600
                      }}
                    >
                      {fmt.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              {grid && (
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
                    <input type="checkbox" checked={visibleOnly} onChange={(e) => setVisibleOnly(e.target.checked)} />
                    <span>{t('exportDialog.visibleColumnsOnly', { shown: grid.visibleColumns.length, total: grid.columns.length })}</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: onlySelected ? 'var(--win-text-disabled)' : 'var(--win-text-primary)', cursor: onlySelected ? 'default' : 'pointer' }}>
                    <input type="checkbox" checked={applyView} disabled={onlySelected} onChange={(e) => setApplyView(e.target.checked)} />
                    <span>{t('exportDialog.applyGridView')}</span>
                  </label>
                  {!!grid.selectedRows?.length && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} />
                      <span>{t('exportDialog.onlySelectedRows', { n: grid.selectedRows.length })}</span>
                    </label>
                  )}
                </div>
              )}

              <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', lineHeight: 1.5, display: onlySelected ? 'none' : undefined }}>
                {t('exportDialog.exportAllRowsNote')}
                {grid?.totalCount
                  ? <Trans i18nKey="exportDialog.exportAllRowsCount" values={{ n: grid.totalCount }} components={{ strong: <b style={{ color: 'var(--win-text-primary)' }} /> }} />
                  : null}.
                {' '}{t('exportDialog.previewOnlyNote', { n: PREVIEW_ROWS })}
              </div>
            </ModalBody>

            <ModalFooter>
              <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
              <button
                className="btn btn-primary"
                onClick={() => setStep('preview')}
                style={{ background: 'var(--win-accent)', color: '#fff', border: 'none' }}
              >
                {t('exportDialog.previewAndExport')}
              </button>
            </ModalFooter>
          </>
        ) : (
          <>
            <ModalBody style={{ gap: '12px' }}>
              <div style={{ display: 'flex', gap: '4px', borderBottom: '1px solid var(--win-border)', paddingBottom: '8px' }}>
                {FORMATS.map((fmt) => (
                  <button
                    key={fmt}
                    onClick={() => setFormat(fmt)}
                    style={{
                      padding: '4px 12px',
                      fontSize: '11px',
                      borderRadius: '4px',
                      border: '1px solid transparent',
                      cursor: 'pointer',
                      background: format === fmt ? 'var(--win-accent)' : 'transparent',
                      color: format === fmt ? '#fff' : 'var(--win-text-secondary)',
                      fontWeight: format === fmt ? 600 : 500
                    }}
                  >
                    {fmt.toUpperCase()}
                  </button>
                ))}
              </div>

              <div>
                <div style={{ fontSize: '10px', color: 'var(--win-text-secondary)', marginBottom: '6px', fontWeight: 600 }}>
                  {t('exportDialog.sampleRows', { n: Math.min(rows.length, PREVIEW_ROWS) })}
                  {!loading && (
                    <Trans
                      i18nKey="exportDialog.sampleRowsNote"
                      values={{ rows: totalRows || rows.length, cols: colNames.length || '?' }}
                      components={{ strong: <b style={{ color: 'var(--win-text-primary)' }} /> }}
                    />
                  )}:
                </div>
                {loading ? (
                  <div style={{
                    height: '240px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--win-bg-window)',
                    border: '1px solid var(--win-border)',
                    borderRadius: '4px',
                    fontSize: '11px',
                    color: 'var(--win-text-secondary)'
                  }}>
                    {t('exportDialog.loadingPreview')}
                  </div>
                ) : format === 'xlsx' ? (
                  <div
                    style={{
                      height: '240px',
                      overflow: 'auto',
                      background: 'var(--win-bg-window)',
                      border: '1px solid var(--win-border)',
                      borderRadius: '4px',
                      padding: '8px',
                      fontSize: '11px'
                    }}
                    dangerouslySetInnerHTML={{ __html: preview }}
                  />
                ) : (
                  <textarea
                    readOnly
                    value={preview}
                    style={{
                      width: '100%',
                      height: '240px',
                      background: 'var(--win-bg-window)',
                      border: '1px solid var(--win-border)',
                      color: 'var(--win-text-primary)',
                      fontFamily: 'monospace',
                      fontSize: '11px',
                      padding: '10px',
                      borderRadius: '4px',
                      resize: 'none',
                      outline: 'none'
                    }}
                  />
                )}
              </div>
            </ModalBody>

            <ModalFooter style={{ gap: '12px' }}>
              {progress ? (
                <ProgressBar progress={progress} />
              ) : (
                <button className="btn btn-secondary" onClick={() => setStep('options')} style={{ marginRight: 'auto' }}>
                  {t('exportDialog.backToOptions')}
                </button>
              )}
              <button
                className="btn btn-secondary"
                onClick={() => navigator.clipboard.writeText(preview)}
                disabled={loading || !!progress || !preview || format === 'xlsx'}
                title={format === 'xlsx' ? t('exportDialog.copyPreviewDisabled') : undefined}
                style={{ flexShrink: 0 }}
              >
                {t('exportDialog.copyPreview')}
              </button>
              <button
                className="btn btn-primary"
                onClick={download}
                disabled={loading || !!progress}
                style={{ background: 'var(--win-accent)', color: '#fff', border: 'none', flexShrink: 0 }}
              >
                {dir ? t('exportDialog.exportToFolder') : t('exportDialog.downloadFile')}
              </button>
            </ModalFooter>
          </>
        )}
    </Modal>
  );
};
