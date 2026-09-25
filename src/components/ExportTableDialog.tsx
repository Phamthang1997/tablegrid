import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import { dbHelper } from '../utils/dbHelper';
import { buildTableFile, buildPreview, createTableFileWriter, type ExportFormat } from '../utils/exportHelper';
import {
  getLastExportDir,
  pickExportFolder,
  saveExportFile,
  saveStreamedToFolder,
  type SaveResult,
} from '../utils/fileSave';
import { startJob, type JobContext } from '../utils/jobs';
import { withJobConnection } from '../utils/jobConnection';
import { connKeyOfConn } from '../utils/safeMode';
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
}

const FORMATS: ExportFormat[] = ['csv', 'json', 'sql', 'xlsx'];

/** Rows per call while loading a whole table for export, so progress can be reported. */
const FETCH_PAGE_SIZE = 2000;
/** How a background export reads the table — copied from the dialog at submit time. */
interface ReadOpts {
  useView: boolean;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  filter?: string;
  knownTotal: number;
}

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
  // export is pressed (see fetchAllRows), by the background job whose progress is in the tray.
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

  /**
   * Loads EVERY row page by page on `readConnId`, reporting real progress from the rows fetched so
   * far. Everything it reads from the dialog is passed in, because it runs inside a background job:
   * by the time the job starts the dialog is gone, and its state with it.
   */
  const readPages = async (
    readConnId: string,
    opts: ReadOpts,
    ctx: JobContext,
    onPage: (rows: any[]) => void | Promise<void>,
  ): Promise<number> => {
    let seen = 0;
    let total = opts.knownTotal;
    let page = 1;
    for (;;) {
      ctx.throwIfCancelled();
      ctx.report({
        label: t('exportDialog.loadingTable', { table: tableName }),
        current: seen,
        total: total || undefined,
        detail: total
          ? t('exportDialog.rowsOfTotal', { rows: fmtNum(seen), total: fmtNum(total) })
          : t('exportDialog.rows', { rows: fmtNum(seen) }),
      });
      const data = await dbHelper.getTableData(readConnId,
        tableName,
        page,
        FETCH_PAGE_SIZE,
        opts.useView ? opts.sortBy : undefined,
        opts.useView ? opts.sortDir : undefined,
        opts.useView ? opts.filter : undefined
      );
      const batch = data.rows || [];
      seen += batch.length;
      // Awaited before the next page is read: when the page is going to a file, a slow disk slows
      // the read down instead of letting unwritten pages pile up in memory.
      await onPage(batch);
      if (!total && data.totalCount) total = data.totalCount;
      if (batch.length < FETCH_PAGE_SIZE) break;
      if (total && seen >= total) break;
      page++;
    }
    return seen;
  };

  /** Every row, in memory — the path for XLSX, and for a download with no folder to stream into. */
  const fetchAllRows = async (readConnId: string, opts: ReadOpts, ctx: JobContext): Promise<any[]> => {
    const all: any[] = [];
    await readPages(readConnId, opts, ctx, (batch) => {
      all.push(...batch);
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

  /**
   * Queues the export as a **background job** and closes the dialog, like Export Database does.
   * Progress, the result and "open folder" live in `JobsTray` — this used to hold the dialog open
   * for the whole read, page by page, and closing it threw the export away.
   *
   * Every option is copied into locals first: the job may start from the queue after the dialog is
   * gone, and nothing it reads may belong to a component that no longer exists.
   */
  const download = () => {
    const opts = {
      useView: !!grid && applyView,
      sortBy: grid?.sortBy,
      sortDir: grid?.sortDir,
      filter: grid?.filter,
      knownTotal: totalRows,
    };
    // A selection is already in memory — no page to read, so no connection is needed at all.
    // `applyView` is irrelevant for it: the rows are in screen order, which is the sorted and
    // filtered order the user was looking at when they made the selection.
    const picked = onlySelected && grid?.selectedRows?.length ? [...grid.selectedRows] : null;
    const cols = [...colNames];
    const fmt = format;
    const name = fileName;
    const targetDir = dir || null;

    startJob({
      kind: 'export-table',
      title: t('jobs.titleExportTable', { n: tableName }),
      db: tableName,
      conn: connKeyOfConn(connId),
      lockKey: `${connId}|${tableName}`,
      run: async (ctx) => {
        const result = (res: SaveResult, rowCount: number, fallbackName: string) => ({
          message: t('exportDialog.exportedTable', { table: tableName, rows: rowCount, format: fmt.toUpperCase() }),
          path: res.path || fallbackName,
          dir: res.dir,
          viaDownload: res.savedTo === 'download',
        });
        const buildAndSave = async (allRows: any[]) => {
          ctx.throwIfCancelled();
          const header = cols.length ? cols : (allRows[0] ? Object.keys(allRows[0]) : []);
          ctx.report({ label: t('exportDialog.building', { format: fmt.toUpperCase() }) });
          const file = buildTableFile(tableName, header, allRows, fmt, dbType, name);
          ctx.report({ label: t('exportDialog.writing') });
          return result(await saveExportFile(targetDir, file.name, file.data, file.mime), allRows.length, file.name);
        };

        // A selection is already in memory: nothing to read, nothing gained by streaming.
        if (picked) return buildAndSave(picked);

        // A connection of its own, like every job: a read through the user's id would go through
        // their manual transaction and export rows they have not committed.
        return withJobConnection(connId, [], async ({ connId: jobConnId }) => {
          // XLSX is a zip whose directory comes last, so it has to be built whole.
          if (fmt === 'xlsx') return buildAndSave(await fetchAllRows(jobConnId, opts, ctx));

          // CSV / JSON / SQL go to the file a page at a time, so a table larger than memory can be
          // exported. The file name and type come from the same builder the in-memory path uses.
          const target = buildTableFile(tableName, cols, [], fmt, dbType, name);
          let rowCount = 0;
          const res = await saveStreamedToFolder(
            targetDir,
            target.name,
            { gzip: false, mime: target.mime },
            async (emit) => {
              const writer = createTableFileWriter(fmt, tableName, cols, dbType);
              rowCount = await readPages(jobConnId, opts, ctx, async (batch) => {
                const text = writer.page(batch);
                if (text) await emit(text);
              });
              const tail = writer.finish();
              if (tail) await emit(tail);
            },
            // No folder (or one the backend cannot write to): the old in-memory build, then a download.
            async () => {
              const allRows = await fetchAllRows(jobConnId, opts, ctx);
              rowCount = allRows.length;
              const header = cols.length ? cols : (allRows[0] ? Object.keys(allRows[0]) : []);
              return buildTableFile(tableName, header, allRows, fmt, dbType, name).data as string;
            },
          );
          return result(res, rowCount, target.name);
        });
      },
    });
    onClose();
  };

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
              <button className="btn btn-secondary" onClick={() => setStep('options')} style={{ marginRight: 'auto' }}>
                {t('exportDialog.backToOptions')}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => navigator.clipboard.writeText(preview)}
                disabled={loading || !preview || format === 'xlsx'}
                title={format === 'xlsx' ? t('exportDialog.copyPreviewDisabled') : undefined}
                style={{ flexShrink: 0 }}
              >
                {t('exportDialog.copyPreview')}
              </button>
              <button
                className="btn btn-primary"
                onClick={download}
                disabled={loading}
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
