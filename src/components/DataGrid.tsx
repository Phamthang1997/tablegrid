import React, { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { clampMenu, type MenuRect } from '../utils/menuPosition';
import { countKey, nextCountMode, seekColumn, seekViewKey } from '../utils/gridPaging';
import { getCommitPreviewForKey, setCommitPreviewForKey } from '../utils/commitPreview';
import { connKeyOfConn } from '../utils/safeMode';
import { dbHelper } from '../utils/dbHelper';
import type { SchemaInfo, ColumnInfo, GridChange } from '../utils/dbHelper';
import {
  Save, RotateCcw, Plus, ChevronLeft, ChevronRight,
  CheckCircle2, AlertTriangle, Minus, Copy, Calendar, ArrowUpRight,
  Search, X, ChevronDown, FileUp, FileDown, BarChart2, Sliders
} from 'lucide-react';
import { StructureViewer } from './StructureViewer';
import { parseXlsx } from '../utils/xlsxReader';
import { collectColumns, inferColType } from '../utils/importPreview';
import { ProgressBar, type ProgressState } from './ProgressBar';
import { ImportFilePicker } from './ImportFilePicker';
import { ExportTableDialog } from './ExportTableDialog';
import ReactDOM from 'react-dom';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { LazyModalFallback } from './LazyEditorFallback';
import { MediaCellPreview, MediaViewerModal, detectMedia, type MediaInfo } from './media';
import { DataVisualizer } from './chart';
import { TablePropertiesView } from './TablePropertiesView';

// Lazy because `RowDocumentModal` has a JSON tab built on `@monaco-editor/react`: a static import
// here is a static path from the entry to Monaco, and it undoes the `React.lazy` of `SqlEditor` and
// the Redis `Console` as well — the 4MB Monaco chunk goes back to being a `modulepreload` at
// startup. See CLAUDE.md, the Build/config section. Verify with `dist/index.html` after
// `npm run build-frontend`.
const RowDocumentModal = React.lazy(() =>
  import('./RowDocumentModal').then((m) => ({ default: m.RowDocumentModal })));

/** Rows per batch when importing into a table, so progress can be reported. */
const IMPORT_BATCH_SIZE = 500;

// The platform's modifier symbol, so only one shortcut is ever shown.
const modKey = /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl+';

const LoadingSpinner: React.FC<{ size?: number; style?: React.CSSProperties }> = ({ size = 16, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className="loading-spinner"
    style={style}
  >
    <circle
      cx="12"
      cy="12"
      r="10"
      stroke="var(--win-border-strong, #383b44)"
      strokeWidth="3"
      opacity="0.2"
    />
    <path
      d="M12 2C6.47715 2 2 6.47715 2 12C2 13.5683 2.36155 15.0506 3.00769 16.3718"
      stroke="var(--win-accent)"
      strokeWidth="3"
      strokeLinecap="round"
    />
  </svg>
);

const getInitialFilterClause = (filterObj?: { column: string; value: any }, type?: string) => {
  if (!filterObj || !filterObj.column) return '';
  const qc = type === 'mysql' ? '`' : '"';
  const val = String(filterObj.value).replace(/'/g, "''");
  const col = `${qc}${filterObj.column}${qc}`;
  return `${col} = '${val}'`;
};

const isDateField = (colName: string, colType?: string, val?: any): boolean => {
  const name = colName.toLowerCase();
  const type = (colType || '').toLowerCase();
  const strVal = String(val || '');

  if (type.includes('date') || type.includes('timestamp') || type.includes('time')) return true;
  if (name.endsWith('_at') || name.includes('date') || name.includes('time') || name.includes('updated') || name.includes('created')) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(strVal)) return true;

  return false;
};

const formatForPicker = (val: string): string => {
  if (!val) {
    const now = new Date();
    return now.toISOString().slice(0, 19);
  }
  const str = String(val).trim().replace(' ', 'T');
  const match = str.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)/);
  if (match) return match[1];

  try {
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const hours = String(d.getHours()).padStart(2, '0');
      const mins = String(d.getMinutes()).padStart(2, '0');
      const secs = String(d.getSeconds()).padStart(2, '0');
      return `${year}-${month}-${day}T${hours}:${mins}:${secs}`;
    }
  } catch {}

  return '';
};

/** The panes the bottom bar switches between. `properties` is read-only, like `chart`. */
export type GridViewMode = 'data' | 'structure' | 'chart' | 'properties';

interface DataGridProps {
  /** The connection this component acts on. Passed explicitly, never read from the ambient id (§4.1). */
  connId: string;
  tableName: string;
  dbType: 'sqlite' | 'postgres' | 'mysql';
  initialViewMode?: GridViewMode;
  initialFilter?: { column: string; value: any };
  readOnly?: boolean;
  /**
   * `TableItem.schema` — set only when the tab was opened from the sidebar's Temporary section on
   * Postgres, where the relation lives in `pg_temp_N`. Every read below has to name it or the
   * backend qualifies with the connection's schema and cannot find the table the tab is showing.
   */
  tableSchema?: string;
  /**
   * Whether there are uncommitted edits. App uses it to put the "unsaved" dot on the tab and to ask
   * for confirmation before leaving — replacing the old global `window.__gridDirty`, which triggered
   * no render and so left the tab strip unable to react.
   */
  onDirtyChange?: (dirty: boolean) => void;
}

interface FilterRow {
  id: string;
  active: boolean;
  column: string;
  operator: string;
  value: string;
}

function parseCSV(text: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          cell += '"';
          i++; // skip next quote
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',' || char === '\t') {
        row.push(cell.trim());
        cell = '';
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && nextChar === '\n') {
          i++;
        }
        row.push(cell.trim());
        if (row.length > 1 || row[0] !== '') {
          result.push(row);
        }
        row = [];
        cell = '';
      } else {
        cell += char;
      }
    }
  }

  if (cell !== '' || row.length > 0) {
    row.push(cell.trim());
    result.push(row);
  }

  return result;
}

export const DataGrid: React.FC<DataGridProps> = ({ connId, tableName, dbType, initialViewMode = 'data', initialFilter, readOnly = false, onDirtyChange, tableSchema }) => {
  const { t, i18n } = useTranslation();
  // Thousands separators follow the active UI language instead of a hardcoded locale.
  const fmtNum = (n: number) => n.toLocaleString(i18n.language);
  // `t` gets a new identity on every language switch. Memoized callbacks that
  // feed an effect read it through this ref instead, so switching language does
  // not re-run fetchSchema — that effect clears the unsaved edit buffer.
  const tRef = useRef(t);
  tRef.current = t;

  // Same reason: App passes an inline arrow, so the callback changes identity on every render. Put
  // straight into the deps of the effect watching changeCount, that effect re-runs constantly, and
  // each re-run's cleanup fires `false` -> the unsaved dot on the tab flickers.
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [schema, setSchema] = useState<SchemaInfo | null>(null);

  // Data State
  const [rows, setRows] = useState<any[]>([]);
  /** `null` = not counted, or not countable. Quite different from `0`, which means the table is empty — see `gridPaging.ts`. */
  const [totalCount, setTotalCount] = useState<number | null>(null);
  /** `false` when the row count is the planner's estimate; the UI has to say so with a `~`. */
  const [countExact, setCountExact] = useState(true);
  /** Whether another page follows, from the backend reading one extra row — right even when the count is an estimate. */
  const [hasMore, setHasMore] = useState(false);
  const [primaryKey, setPrimaryKey] = useState('id');

  // Pagination & Filtering
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  /**
   * Bumped after the grid itself writes to the table (a commit, an import) and when the user presses
   * Refresh — the only three ways the total row count changes while neither the table name nor the
   * filter does. It is `countKey`'s third part, i.e. what forces the next read to count again.
   */
  const [dataVersion, setDataVersion] = useState(0);
  /** The key of the most recent count that **came back** (not the most recent one sent). */
  const lastCountedKeyRef = useRef<string | null>(null);
  /** Set once when the user presses "count exactly", and cleared right after that read. */
  const forceExactCountRef = useRef(false);
  /**
   * The keyset cursor of each page: `cursors[i]` is the cursor that opens page `i + 1`, so
   * `cursors[0]` is always `null` (page 1 needs none).
   *
   * In a ref rather than state because nothing renders from it, and carried alongside the ordering's
   * `key` (`seekViewKey`) so it discards itself when the user changes filter, sort or page size — see
   * `gridPaging.ts`. The grid navigates only with Prev/Next, so this stack is always contiguous:
   * reaching page N means page N − 1 was read immediately before it.
   */
  const cursorsRef = useRef<{ key: string; cursors: (string | null)[] }>({ key: '', cursors: [null] });
  const [sortBy, setSortBy] = useState<string | undefined>(undefined);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [filterText, setFilterText] = useState<string>(() =>
    getInitialFilterClause(initialFilter, dbType)
  );
  const [activeFilter, setActiveFilter] = useState<string>(() =>
    getInitialFilterClause(initialFilter, dbType)
  );

  // Advanced Filter Builder State
  const [filterMode, setFilterMode] = useState<'visual' | 'sql'>('visual');
  const [filterRows, setFilterRows] = useState<FilterRow[]>([]);

  // Editing State
  const [updates, setUpdates] = useState<{ [rowId: string]: { [colName: string]: any } }>({});
  const [deletes, setDeletes] = useState<Set<any>>(new Set());
  const [inserts, setInserts] = useState<any[]>([]);
  const [nextTempId, setNextTempId] = useState(1);
  const [editingCell, setEditingCell] = useState<{ rowId: any; colName: string } | null>(null);
  const [editValue, setEditValue] = useState<any>('');

  // Undo/Redo for the change buffer (updates/deletes/inserts). History is recorded by an effect, so
  // it does not have to be woven into every mutation site. Each time the buffer changes -> the
  // PREVIOUS snapshot is pushed onto undoStack.
  type GridSnap = { updates: any; deletes: any[]; inserts: any[] };
  const [undoStack, setUndoStack] = useState<GridSnap[]>([]);
  const [redoStack, setRedoStack] = useState<GridSnap[]>([]);
  const prevSnapRef = React.useRef<GridSnap>({ updates: {}, deletes: [], inserts: [] });
  const skipHistoryRef = React.useRef(true); // skip the first run (mount) and the restores that undo/redo performs
  const curSnap = (): GridSnap => ({
    updates: JSON.parse(JSON.stringify(updates)),
    deletes: Array.from(deletes),
    inserts: JSON.parse(JSON.stringify(inserts)),
  });

  useEffect(() => {
    const cur = curSnap();
    if (skipHistoryRef.current) {
      skipHistoryRef.current = false;
      prevSnapRef.current = cur;
      return;
    }
    setUndoStack(s => [...s, prevSnapRef.current].slice(-100));
    setRedoStack([]);
    prevSnapRef.current = cur;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updates, deletes, inserts]);

  const restoreSnap = (snap: GridSnap) => {
    skipHistoryRef.current = true;
    setUpdates(snap.updates);
    setDeletes(new Set(snap.deletes));
    setInserts(snap.inserts);
    prevSnapRef.current = snap;
  };

  const undoGridChange = () => {
    if (undoStack.length === 0) return;
    const target = undoStack[undoStack.length - 1];
    setRedoStack(r => [...r, curSnap()]);
    setUndoStack(s => s.slice(0, -1));
    restoreSnap(target);
  };

  const redoGridChange = () => {
    if (redoStack.length === 0) return;
    const target = redoStack[redoStack.length - 1];
    setUndoStack(s => [...s, curSnap()]);
    setRedoStack(r => r.slice(0, -1));
    restoreSnap(target);
  };

  // Resets the history (after a successful commit: the buffer is empty, and undoing back into changes already written to the DB is not allowed)
  const resetGridHistory = () => {
    skipHistoryRef.current = true;
    setUndoStack([]);
    setRedoStack([]);
    prevSnapRef.current = { updates: {}, deletes: [], inserts: [] };
  };

  // The transaction preview shown before committing
  const [commitPreview, setCommitPreview] = useState<string[] | null>(null);
  /**
   * Only there to force the "do not show again" checkbox to re-render: the real value lives in
   * localStorage per server (`commitPreview.ts`), outside React, so without this state ticking the
   * box would not change its appearance.
   */
  const [, setPreviewOptOutTick] = useState(0);
  const [pendingChanges, setPendingChanges] = useState<GridChange[]>([]);

  // Selected row for highlighting
  // The selection is a SET, and `selectedRowId` below is derived from it rather than stored
  // alongside — two sources of truth for "what is selected" is how a grid ends up highlighting one
  // row and acting on another.
  //
  // Keys are the same `selectionKey` the rows render with: the primary key when there is one, and
  // `__idx_<n>` when there is not. An inserted row uses its `__tempId`.
  const [selectedRowIds, setSelectedRowIds] = useState<Set<any>>(new Set());
  // Where a Shift+click measures from. Set by every plain and Ctrl click, never by Shift itself, so
  // repeated Shift+clicks grow and shrink the same range instead of walking the anchor along.
  const [anchorRowId, setAnchorRowId] = useState<any | null>(null);

  // The single-selection value the row-at-a-time features still ask for (open the document viewer,
  // find a row's index). Deliberately `null` when several rows are selected: those features have no
  // sensible answer for "which one", and silently picking the first would act on a row the user did
  // not point at.
  const selectedRowId = selectedRowIds.size === 1 ? selectedRowIds.values().next().value : null;

  /** Replace the whole selection with one row. Used by every path that is not a modifier click. */
  const setSelectedRowId = useCallback((id: any | null) => {
    setSelectedRowIds(id === null || id === undefined ? new Set() : new Set([id]));
    setAnchorRowId(id ?? null);
  }, []);

  // Studio 3T-style Document / Row Viewer Modal
  const [documentViewerIndex, setDocumentViewerIndex] = useState<number | null>(null);

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number;
    rowId: any; row: any;
    colName: string; cellValue: any;
  } | null>(null);

  // The context menu's position after its real size has been measured (so it cannot overflow the window)
  const cellMenuRef = useRef<HTMLDivElement>(null);
  const [cellMenuPos, setCellMenuPos] = useState<MenuRect | null>(null);

  useLayoutEffect(() => {
    if (!contextMenu) {
      setCellMenuPos(null);
      return;
    }
    const el = cellMenuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCellMenuPos(clampMenu(contextMenu.x, contextMenu.y, r.width, r.height, window.innerWidth, window.innerHeight));
  }, [contextMenu]);

  // Quick Look Modal State
  const [quickLookCell, setQuickLookCell] = useState<{ colName: string; value: any } | null>(null);
  const [mediaViewerTarget, setMediaViewerTarget] = useState<{ media: MediaInfo; colName: string; tableName: string } | null>(null);

  // Schema View Toggle
  const [viewMode, setViewMode] = useState<GridViewMode>(initialViewMode);
  const [structSection, setStructSection] = useState<'columns' | 'indexes' | 'fks' | 'check_constraints' | 'triggers' | 'partitions' | 'ddl'>('columns');
  const [showFilterBar, setShowFilterBar] = useState<boolean>(() =>
    !!(initialFilter && initialFilter.column)
  );

  // Columns Visibility State
  const [visibleColumns, setVisibleColumns] = useState<string[]>([]);
  const [pendingVisibleColumns, setPendingVisibleColumns] = useState<string[]>([]);
  const [showColumnsPopover, setShowColumnsPopover] = useState(false);

  // Quick Search State (Search Anything on loaded rows)
  const [quickSearchQuery, setQuickSearchQuery] = useState('');
  const [showQuickSearch, setShowQuickSearch] = useState(false);
  const quickSearchInputRef = useRef<HTMLInputElement>(null);

  // Import & Export Combined Popover State
  const [showIoPopover, setShowIoPopover] = useState(false);
  const ioPopoverRef = useRef<HTMLDivElement>(null);

  // Export state — every option and the preview live in ExportTableDialog
  const [showExportDialog, setShowExportDialog] = useState(false);

  // Import Preview State
  const [importTab, setImportTab] = useState<'structure' | 'data'>('structure');
  const [importProgress, setImportProgress] = useState<ProgressState | null>(null);
  const [showImportPicker, setShowImportPicker] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFileName, setImportFileName] = useState('');
  const [importFileType, setImportFileType] = useState<'csv' | 'json' | 'sql'>('csv');
  const [importPendingRows, setImportPendingRows] = useState<any[]>([]);
  const [importSqlContent, setImportSqlContent] = useState('');

  // The columns present in the file (the union of every row's keys: CSV/JSON rows may omit some)
  const importFileCols = React.useMemo(() => collectColumns(importPendingRows), [importPendingRows]);

  // Columns in the file that the target table lacks -> the import would fail, so warn first.
  const importUnknownCols = React.useMemo(() => {
    if (columns.length === 0) return [];
    const target = columns.map(c => c.name.toLowerCase());
    return importFileCols.filter(c => !target.includes(c.toLowerCase()));
  }, [importFileCols, columns]);

  const handleImportClick = () => {
    setShowImportPicker(true);
  };

  // Takes the file from ImportFilePicker (which already checked the extension) and parses it for the preview.
  const handleFileImport = async (file: File) => {
    setShowImportPicker(false);
    setImportTab('structure');
    setImportFileName(file.name);
    setErrorMsg(null);
    setSuccessMsg(null);

    // XLSX is binary -> read an ArrayBuffer and parse it separately.
    if (file.name.toLowerCase().endsWith('.xlsx')) {
      try {
        const buf = await file.arrayBuffer();
        const sheetRows = await parseXlsx(buf);
        if (sheetRows.length === 0) throw new Error(t('dataGrid.errXlsxEmpty'));
        setImportFileType('json'); // object-shaped sheetRows, sharing the DB-write branch with CSV/JSON
        setImportPendingRows(sheetRows);
        setShowImportModal(true);
      } catch (err: any) {
        setErrorMsg(t('dataGrid.errReadFile', { message: err.message }));
      }
      return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target?.result as string;

        if (file.name.endsWith('.json')) {
          const parsedJson = JSON.parse(text);
          if (!Array.isArray(parsedJson)) {
            throw new Error(t('dataGrid.errJsonArray'));
          }
          setImportFileType('json');
          setImportPendingRows(parsedJson);
          setShowImportModal(true);
        } else if (file.name.endsWith('.csv')) {
          let cleanText = text;
          if (cleanText.charCodeAt(0) === 0xFEFF) {
            cleanText = cleanText.substring(1);
          }
          const parsedCsv = parseCSV(cleanText);
          if (parsedCsv.length < 2) {
            throw new Error(t('dataGrid.errCsvEmpty'));
          }
          const headers = parsedCsv[0];
          const rowsToImport: any[] = [];
          for (let i = 1; i < parsedCsv.length; i++) {
            const values = parsedCsv[i];
            const row: any = {};
            headers.forEach((h, idx) => {
              const val = values[idx];
              row[h] = val === undefined || val === '' ? null : val;
            });
            rowsToImport.push(row);
          }
          setImportFileType('csv');
          setImportPendingRows(rowsToImport);
          setShowImportModal(true);
        } else if (file.name.endsWith('.sql')) {
          setImportFileType('sql');
          setImportSqlContent(text);
          setShowImportModal(true);
        } else {
          throw new Error(t('dataGrid.errUnsupportedFile'));
        }
      } catch (err: any) {
        setErrorMsg(t('dataGrid.errReadFile', { message: err.message }));
      }
    };
    reader.readAsText(file);
  };

  const confirmImport = async () => {
    setShowImportModal(false);
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    setImportProgress({
      label: importFileType === 'sql'
        ? t('dataGrid.importRunningSql')
        : t('dataGrid.importWritingRows', { n: importPendingRows.length, table: tableName }),
    });

    try {
      if (importFileType === 'sql') {
        // See the note in App.tsx: a .sql file holds several statements, so it has to go through executeQueryMulti.
        const res = await dbHelper.executeQueryMulti(connId, importSqlContent);
        setImportProgress(null);
        setLoading(false);
        if (res.success) {
          setSuccessMsg(t('dataGrid.importSqlSuccess'));
          refetchAfterWrite();
        } else {
          setErrorMsg(t('dataGrid.errImportSql', { message: res.error }));
        }
      } else {
        // Written in batches so real progress can be reported (the backend inserts row by row within each).
        const total = importPendingRows.length;
        let done = 0;
        for (let i = 0; i < total; i += IMPORT_BATCH_SIZE) {
          const batch = importPendingRows.slice(i, i + IMPORT_BATCH_SIZE);
          const resData = await dbHelper.importTableData(connId, tableName, batch);
          if (!resData.success) {
            setImportProgress(null);
            setLoading(false);
            const failure = resData.error || t('dataGrid.errImportFailed');
            setErrorMsg(
              done > 0 ? t('dataGrid.errImportWithProgress', { message: failure, done, total }) : failure
            );
            refetchAfterWrite();
            return;
          }
          done += batch.length;
          setImportProgress({
            label: t('dataGrid.importWriting', { table: tableName }),
            current: done,
            total,
            detail: t('dataGrid.importRowsDetail', { done: fmtNum(done), total: fmtNum(total) }),
          });
        }
        setImportProgress(null);
        setLoading(false);
        setSuccessMsg(t('dataGrid.importDone', { n: done, table: tableName }));
        refetchAfterWrite();
      }
    } catch (err: any) {
      setImportProgress(null);
      setLoading(false);
      setErrorMsg(t('common.connectionError', { message: err.message }));
    }
  };

  // Messages
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Success messages dismiss themselves. The paths with their own timers (copying a cell, saving
  // changes…) still disappear earlier on those timers; this effect covers the ones without — Export
  // and Import call onSuccess from their dialogs, which used to leave the green bar hanging forever.
  useEffect(() => {
    if (!successMsg) return;
    const timer = setTimeout(() => setSuccessMsg(null), 4000);
    return () => clearTimeout(timer);
  }, [successMsg]);

  // Error messages dismiss themselves after 6 seconds
  useEffect(() => {
    if (!errorMsg) return;
    const timer = setTimeout(() => setErrorMsg(null), 6000);
    return () => clearTimeout(timer);
  }, [errorMsg]);

  // Fetch Table Schema (Metadata)
  const fetchSchema = useCallback(async () => {
    try {
      const s = await dbHelper.getTableSchema(connId, tableName, tableSchema);
      if (s && Array.isArray(s.columns)) {
        setSchema(s);
        setColumns(s.columns);
        setVisibleColumns(s.columns.map(c => c.name));
        setPendingVisibleColumns(s.columns.map(c => c.name));
        const pk = s.columns.find(c => c.isPrimaryKey);
        setPrimaryKey(pk ? pk.name : 'id');
      } else {
        setSchema(null);
        setColumns([]);
        setVisibleColumns([]);
        setPendingVisibleColumns([]);
        if (s && (s as any).error) {
          setErrorMsg((s as any).error);
        }
      }
    } catch (err: any) {
      console.error(err);
      setErrorMsg(tRef.current('dataGrid.errLoadSchema'));
      setSchema(null);
      setColumns([]);
      setVisibleColumns([]);
      setPendingVisibleColumns([]);
    }
  }, [connId, tableName, tableSchema]);

  // Sync columns with filter builder
  useEffect(() => {
    if (columns.length > 0) {
      if (initialFilter && initialFilter.column) {
        setFilterRows([
          { id: '1', active: true, column: initialFilter.column, operator: '=', value: String(initialFilter.value) }
        ]);
      } else {
        setFilterRows([
          { id: '1', active: true, column: columns[0].name, operator: 'Contains', value: '' }
        ]);
      }
    } else {
      setFilterRows([]);
    }
  }, [columns, initialFilter]);

  // Filter Row Mutations
  const addFilterRow = useCallback((afterId?: string) => {
    const newRow: FilterRow = {
      id: String(Date.now()),
      active: true,
      column: columns[0]?.name || '',
      operator: 'Contains',
      value: ''
    };
    if (afterId) {
      setFilterRows(prev => {
        const idx = prev.findIndex(r => r.id === afterId);
        if (idx !== -1) {
          const next = [...prev];
          next.splice(idx + 1, 0, newRow);
          return next;
        }
        return [...prev, newRow];
      });
    } else {
      setFilterRows(prev => [...prev, newRow]);
    }
  }, [columns]);

  // Keyboard Shortcuts (Ctrl/Cmd + F for search, Ctrl/Cmd + I to insert, Delete/Backspace to delete row, Ctrl/Cmd + S to commit)
  //
  // The old version declared 10 deps but was MISSING 5 handlers (handleAddRow, handleCommit,
  // handleDeleteRow, undo/redoGridChange). That is not merely a lint warning: the handlers get
  // frozen at whichever render the effect last ran on, so a shortcut can call an old version with
  // old state (Ctrl+I using a stale activeColumns, for instance). Adding them to the deps is not
  // right either: they are recreated every render, so the listener would be detached and reattached
  // constantly. The answer: keep the latest handlers in a ref and attach ONE listener, stable for
  // the component's whole life.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => { });

  keyHandlerRef.current = (e: KeyboardEvent) => {
    {
      // 0. Switch between Data and Structure (Ctrl/Cmd + [ or ])
      if ((e.metaKey || e.ctrlKey) && e.key === ']') {
        e.preventDefault();
        setViewMode('structure');
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '[') {
        e.preventDefault();
        setViewMode('data');
        return;
      }

      // 1a. Toggle SQL Filter bar (Ctrl/Cmd + Shift + F)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowFilterBar(prev => !prev);
        return;
      }

      // 1b. Open Quick Search (Search Anything) (Ctrl/Cmd + F)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowQuickSearch(true);
        setTimeout(() => {
          quickSearchInputRef.current?.focus();
          quickSearchInputRef.current?.select();
        }, 30);
        return;
      }

      // 2. Insert new row (Ctrl/Cmd + I, or Ctrl/Cmd + Shift + N to match the docs)
      if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'i' || (e.shiftKey && e.key.toLowerCase() === 'n'))) {
        e.preventDefault();
        handleAddRow();
        return;
      }

      // 2b. Undo/Redo buffer change (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y)
      // Only while NOT typing in a cell or text field, so the input's native undo keeps working
      if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
        const el = document.activeElement;
        const editingText = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.getAttribute('contenteditable') === 'true');
        if (!editingText) {
          const isRedo = e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey);
          e.preventDefault();
          if (isRedo) redoGridChange(); else undoGridChange();
          return;
        }
      }

      // 3. Save / Commit Changes (Ctrl/Cmd + S)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleCommit();
        return;
      }

      // 3a. Copy the selected rows (Ctrl/Cmd + C)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'c') {
        const el = document.activeElement;
        const inTextField = el && (
          el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.getAttribute('contenteditable') === 'true'
        );
        // Three ways this must NOT take over, all of them cases where the native copy is the right
        // one: a cell editor or the search box owns the keystroke, or the user has highlighted text
        // and means to copy that text rather than the rows it happens to sit in.
        if (inTextField || editingCell) return;
        if ((window.getSelection()?.toString() || '').length > 0) return;
        if (selectedRowIds.size === 0) return;
        e.preventDefault();
        copySelectionAsTsv();
        return;
      }

      // 4. Delete Selected Row (Delete or Backspace - only when not editing a text input/textarea)
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRowIds.size > 0) {
        const activeEl = document.activeElement;
        const isEditingText = activeEl && (
          activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.getAttribute('contenteditable') === 'true'
        );
        if (!isEditingText) {
          e.preventDefault();
          handleDeleteRow();
        }
      }

      // 5. Open Document Viewer (Space key when a row is selected and not editing)
      if (e.key === ' ' && !editingCell && selectedRowId !== null) {
        const activeEl = document.activeElement;
        const isEditingText = activeEl && (
          activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.getAttribute('contenteditable') === 'true'
        );
        if (!isEditingText) {
          e.preventDefault();
          const rowIdx = rows.findIndex((r, idx) => (r[primaryKey] !== undefined && r[primaryKey] !== null ? r[primaryKey] : `__idx_${idx}`) === selectedRowId);
          if (rowIdx >= 0) {
            setDocumentViewerIndex(rowIdx);
          }
        }
      }
    }
  };

  // ONE listener attached for the component's whole life; it always calls the latest handlers through
  // the ref, so there is no stale closure and nothing is detached and reattached on every state change.
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  // Fetch Data Row
  const fetchData = useCallback(async () => {
    setLoading(true);
    // Counted only when what is being counted changes (the table, the filter, the data). Turning a
    // page, changing the sort or the page size cannot change that number, while `COUNT(*)` rescans
    // the whole table — see `gridPaging.ts`.
    const key = countKey(tableName, activeFilter, dataVersion);
    const forceExact = forceExactCountRef.current;
    forceExactCountRef.current = false;
    const mode = nextCountMode(lastCountedKeyRef.current, key, forceExact);

    // Keyset: a deep page is read with `WHERE pk > <cursor>` instead of `OFFSET n`, which makes the
    // server read and then discard the first n rows. When seeking is not possible (a composite key, a
    // sort on another column, or no cursor for this page yet) `cursor` is `null` and the backend
    // falls back to page-number paging.
    const seekCol = seekColumn(
      columns.filter((c) => c.isPrimaryKey).map((c) => c.name), sortBy, activeFilter
    );
    const viewKey = seekViewKey(tableName, activeFilter, sortBy, sortDir, pageSize);
    if (cursorsRef.current.key !== viewKey) {
      cursorsRef.current = { key: viewKey, cursors: [null] };
    }
    const cursor = seekCol ? cursorsRef.current.cursors[page - 1] ?? null : null;

    const data = await dbHelper.getTableData(
      connId, tableName, page, pageSize, sortBy, sortDir, activeFilter,
      { countMode: mode, seekColumn: seekCol, cursor, schema: tableSchema }
    );
    setRows(data.rows);
    setHasMore(data.hasMore);
    // Records the cursor that opens the next page. Only while the key has not changed during the
    // round trip — if it has, this cursor belongs to a different ordering and using it reads the
    // wrong rows.
    if (seekCol && data.nextCursor && cursorsRef.current.key === viewKey) {
      cursorsRef.current.cursors[page] = data.nextCursor;
    }
    if (data.totalCount !== null) {
      setTotalCount(data.totalCount);
      setCountExact(data.countExact);
      // Marked as counted only when a real number came back: a failed count has to be retried next
      // time rather than sitting on a `null` forever. An estimate has still answered for this key.
      lastCountedKeyRef.current = key;
    } else if (mode !== 'skip') {
      // A count was asked for and none came back: clear the old total rather than showing another table's or filter's number.
      setTotalCount(null);
      setCountExact(true);
    }
    if (data.primaryKey) setPrimaryKey(data.primaryKey);
    setLoading(false);
  }, [connId, tableName, tableSchema, page, pageSize, sortBy, sortDir, activeFilter, dataVersion, columns]);

  /** Re-reads the current page and counts EXACTLY, after the user clicks the estimated number. */
  const recountExact = useCallback(() => {
    forceExactCountRef.current = true;
    fetchData();
  }, [fetchData]);

  /**
   * The grid has just written to the table (a commit or an import), so it must re-read AND re-count.
   *
   * It bumps `dataVersion` rather than calling `fetchData()`: `dataVersion` is in `fetchData`'s deps,
   * so calling it directly would run with the old closure (skipping the count) and then the effect
   * would run again — two page reads for one write.
   */
  const refetchAfterWrite = useCallback(() => setDataVersion((v) => v + 1), []);

  useEffect(() => {
    // Honours the initial view (Data/Structure) when the tab opens, rather than always forcing 'data'
    setViewMode(initialViewMode);
    fetchSchema().then(() => {
      // Reset changes on table change
      setUpdates({});
      setDeletes(new Set());
      setInserts([]);
      // Clears both the set and the Shift anchor — leaving an anchor behind would let the first
      // Shift+click in the newly opened table measure from a row that belonged to the old one.
      setSelectedRowId(null);
      setPage(1);
      setSortBy(undefined);
      // The sort direction has to return to ASC along with the column: clearing the column but
      // keeping 'desc' leaves a freshly opened table sorted descending by its primary key (the
      // direction now applies even with no column sorted — see `seekColumn`), i.e. a strange order
      // with no arrow anywhere to explain it.
      setSortDir('asc');
      const clause = getInitialFilterClause(initialFilter, dbType);
      setActiveFilter(clause);
      setFilterText(clause);
      if (clause) {
        setShowFilterBar(true);
      }
    });
  }, [tableName, fetchSchema, initialViewMode, initialFilter, dbType, setSelectedRowId]);

  useEffect(() => {
    if (columns.length > 0) {
      fetchData();
    }
  }, [columns, fetchData]);

  // Handle Sort Toggle
  const handleSort = (colName: string) => {
    if (sortBy === colName) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(colName);
      setSortDir('asc');
    }
    setPage(1);
  };

  // Handle Cell Editing
  const startEdit = (rowId: any, colName: string, currentValue: any) => {
    if (readOnly) {
      setErrorMsg(t('dataGrid.errReadOnlyEdit'));
      setTimeout(() => setErrorMsg(null), 3000);
      return;
    }
    // Primary-key columns are editable too: the backend's UPDATE uses the original PK value in the
    // WHERE while SET applies the new one (rowId keeps the original value until commit + refetch).
    setEditingCell({ rowId, colName });
    setEditValue(currentValue === null ? '' : currentValue);
  };

  const saveEdit = (e?: React.FocusEvent) => {
    if (e?.relatedTarget && (e.relatedTarget as HTMLElement).closest('.grid-edit-wrapper')) {
      return;
    }
    if (!editingCell) return;
    const { rowId, colName } = editingCell;

    // Check if cell changed from original
    const isTemp = String(rowId).startsWith('temp_');

    if (isTemp) {
      // Modify the inserts array (identified by __tempId, not by the PK column, since the PK may itself be edited)
      setInserts(prev =>
        prev.map(row => {
          if (row.__tempId === rowId) {
            return { ...row, [colName]: editValue };
          }
          return row;
        })
      );
    } else {
      // Find original row
      const originalRow = rows.find(r => r[primaryKey] === rowId);
      const originalVal = originalRow ? originalRow[colName] : undefined;

      if (String(originalVal) !== String(editValue)) {
        setUpdates(prev => {
          const rowUpdates = prev[rowId] || {};
          return {
            ...prev,
            [rowId]: {
              ...rowUpdates,
              [colName]: editValue
            }
          };
        });
      } else {
        // Revert to original if match
        setUpdates(prev => {
          const rowUpdates = { ...prev[rowId] };
          delete rowUpdates[colName];
          const newUpdates = { ...prev };
          if (Object.keys(rowUpdates).length === 0) {
            delete newUpdates[rowId];
          } else {
            newUpdates[rowId] = rowUpdates;
          }
          return newUpdates;
        });
      }
    }

    setEditingCell(null);
  };

  // Add Empty Row
  const handleAddRow = () => {
    if (readOnly) {
      setErrorMsg(t('dataGrid.errReadOnlyAdd'));
      setTimeout(() => setErrorMsg(null), 3000);
      return;
    }

    const tempId = `temp_${nextTempId}`;
    setNextTempId(nextTempId + 1);

    // __tempId is an internal identifier; the PK column is left empty for the user to fill or the DB to generate (auto-increment)
    const newRow: any = { __tempId: tempId };
    columns.forEach(col => {
      newRow[col.name] = col.name === primaryKey ? '' : (col.defaultValue || '');
    });

    setInserts([...inserts, newRow]);

    // The row is selected and its first input opened: a blank row you have to guess is
    // "double-click to edit" is hard to use. Auto-increment PK columns are skipped, since the DB
    // generates those.
    const firstEditable = activeColumns.find(c => !(c.isPrimaryKey && c.autoIncrement)) || activeColumns[0];
    setSelectedRowId(tempId);
    if (firstEditable) {
      startEdit(tempId, firstEditable.name, newRow[firstEditable.name] ?? '');
    }

    setSuccessMsg(t('dataGrid.rowAdded'));
    setTimeout(() => setSuccessMsg(null), 4000);
  };

  // Delete Selected / Marked Row
  const handleDeleteRow = (targetRowId?: any) => {
    // Acts on the WHOLE selection unless a specific row is named (the row context menu names one).
    // Safe to widen because nothing is deleted here: an existing row is only marked, and the marks
    // are what Save turns into DELETEs — so a mis-aimed Delete is undone by pressing it again, or
    // by not saving.
    const targets = targetRowId !== undefined ? [targetRowId] : Array.from(selectedRowIds);
    if (targets.length === 0) {
      setErrorMsg(t('dataGrid.errNoRowSelected'));
      return;
    }

    const temps = targets.filter(id => String(id).startsWith('temp_'));
    const existing = targets.filter(id => !String(id).startsWith('temp_'));

    if (temps.length > 0) {
      const drop = new Set(temps);
      setInserts(inserts.filter(row => !drop.has(row.__tempId)));
    }
    if (existing.length > 0) {
      setDeletes(prev => {
        const next = new Set(prev);
        // Toggle per row, so pressing Delete twice on the same selection puts it back exactly.
        for (const id of existing) {
          if (next.has(id)) next.delete(id);
          else next.add(id);
        }
        return next;
      });
    }
    setSelectedRowId(null);
  };

  // The foreign-key helper (real foreign keys only, excluding the current table's primary key)
  const getFkInfo = useCallback((colName: string) => {
    if (!colName) return null;

    // 1. Look in the schema's exact foreignKeys metadata
    if (schema?.foreignKeys && Array.isArray(schema.foreignKeys)) {
      const fk = schema.foreignKeys.find(
        f => (f.column || '').toLowerCase() === colName.toLowerCase()
      );
      if (fk?.refTable) {
        return { refTable: fk.refTable, refColumn: fk.refColumn || colName };
      }
    }

    // 2. The heuristic fallback: applied only when the column is NOT a primary key and the guessed
    // table name is NOT the current table
    const isPk = colName === primaryKey || columns.some(c => c.name === colName && c.isPrimaryKey);
    if (!isPk) {
      const lower = colName.toLowerCase();
      if (lower.endsWith('_id') && lower !== 'id') {
        const guessed = colName.slice(0, -3);
        if (guessed.toLowerCase() !== tableName.toLowerCase()) {
          return { refTable: guessed, refColumn: colName };
        }
      }
    }
    return null;
  }, [schema, primaryKey, columns, tableName]);

  const handleFkClick = useCallback((colName: string, cellVal: any, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
    }
    if (cellVal === null || cellVal === undefined || String(cellVal).trim() === '') return;
    const fk = getFkInfo(colName);
    if (!fk) return;
    window.dispatchEvent(new CustomEvent('open-table-tab', {
      detail: {
        table: fk.refTable,
        viewMode: 'data',
        initialFilter: { column: fk.refColumn || colName, value: cellVal }
      }
    }));
  }, [getFkInfo]);

  // Duplicate selected row (append as new insert)
  const handleDuplicateRow = (row: any) => {
    const tempId = `temp_${nextTempId}`;
    setNextTempId(n => n + 1);
    // The PK value is not copied (that would collide); left empty for the user to fill or the DB to generate
    const newRow: any = { __tempId: tempId };
    columns.forEach(col => {
      newRow[col.name] = col.name === primaryKey ? '' : (row[col.name] ?? null);
    });
    setInserts(prev => [...prev, newRow]);
    setSelectedRowId(tempId);
    setSuccessMsg(t('dataGrid.rowDuplicated'));
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  // Copy helpers
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    });
  };

  /**
   * The rows a context-menu copy acts on: the whole selection when the clicked row is part of it,
   * and just that row otherwise.
   *
   * `selectForContextMenu` has already arranged for exactly that — right-clicking outside the
   * selection replaces it — so this only has to read it back, in SCREEN order. Reading it from
   * `orderedRowKeys` rather than from the Set is what makes a copied Markdown table come out in the
   * order the user is looking at; a `Set` preserves insertion order, which for a Shift range is the
   * click order, not the row order.
   */
  /**
   * Maps a selection key back to its row object.
   *
   * Built from `displayedRows`/`displayedInserts`, never from `rows`/`inserts`: a row with no
   * primary key is keyed `__idx_<position>`, and the position has to be the one the render used, or
   * an active quick search shifts every key by the number of rows it hid — silently copying and
   * exporting rows the user did not pick.
   */
  const rowByKey = (): Map<any, any> => {
    const byKey = new Map<any, any>();
    displayedRows.forEach((row, idx) => {
      const id = row[primaryKey];
      byKey.set(id !== undefined && id !== null ? id : `__idx_${idx}`, row);
    });
    displayedInserts.forEach(row => byKey.set(row.__tempId, row));
    return byKey;
  };

  /** The selected rows as objects, in screen order. Empty when nothing is selected. */
  const selectedRows = (): any[] => {
    if (selectedRowIds.size === 0) return [];
    const byKey = rowByKey();
    return orderedRowKeys.filter(k => selectedRowIds.has(k)).map(k => byKey.get(k)).filter(Boolean);
  };

  const rowsToCopy = (clicked: any): any[] => {
    if (selectedRowIds.size <= 1) return [clicked];
    const picked = selectedRows();
    return picked.length > 0 ? picked : [clicked];
  };

  const csvCell = (v: any) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const copyRowAsCSV = (row: any, withHeader: boolean) => {
    const cols = activeColumns.map(c => c.name);
    const lines = rowsToCopy(row).map(r => cols.map(c => csvCell(r[c])).join(','));
    copyToClipboard(withHeader ? [cols.join(','), ...lines].join('\n') : lines.join('\n'));
    setSuccessMsg(t('dataGrid.copiedRowCsv'));
    setTimeout(() => setSuccessMsg(null), 2000);
  };

  const copyRowAsSQL = (row: any) => {
    const cols = activeColumns.map(c => c.name);
    const colList = cols.map(c => `\`${c}\``).join(', ');
    // One statement per row rather than one multi-VALUES INSERT: these are pasted into an editor
    // and edited by hand, and a row that turns out to be wrong is then deleted by deleting its line.
    const statements = rowsToCopy(row).map(r => {
      const valList = cols.map(c => {
        const v = r[c];
        if (v === null || v === undefined) return 'NULL';
        return `'${String(v).replace(/'/g, "''")}'`;
      }).join(', ');
      return `INSERT INTO \`${tableName}\` (${colList}) VALUES (${valList});`;
    });
    copyToClipboard(statements.join('\n'));
    setSuccessMsg(t('dataGrid.copiedRowSql'));
    setTimeout(() => setSuccessMsg(null), 2000);
  };

  const copyRowAsMarkdown = (row: any) => {
    const cols = activeColumns.map(c => c.name);
    const header = `| ${cols.join(' | ')} |`;
    const sep = `| ${cols.map(() => '---').join(' | ')} |`;
    // Escape backslashes first, then pipes (so `|` does not split the cell), and replace newlines
    // so multi-line text does not break Markdown table row structure.
    const body = rowsToCopy(row).map(
      r =>
        `| ${cols
          .map(c =>
            String(r[c] ?? '')
              .replace(/\\/g, '\\\\')
              .replace(/\|/g, '\\|')
              .replace(/\r?\n/g, ' '),
          )
          .join(' | ')} |`,
    );
    copyToClipboard([header, sep, ...body].join('\n'));
    setSuccessMsg(t('dataGrid.copiedRowMarkdown'));
    setTimeout(() => setSuccessMsg(null), 2000);
  };

  const copyRowAsJson = (row: any) => {
    const cols = activeColumns.map(c => c.name);
    const objects = rowsToCopy(row).map(r =>
      Object.fromEntries(cols.map(c => [c, r[c] ?? null])),
    );
    copyToClipboard(JSON.stringify(objects, null, 2));
    setSuccessMsg(t('dataGrid.copiedRowJson'));
    setTimeout(() => setSuccessMsg(null), 2000);
  };

  /**
   * Ctrl+C's format is TAB-separated, not CSV: its destination is almost always a spreadsheet, and
   * CSV pasted into one lands in a single column. The context menu keeps CSV for when the user
   * actually wants a .csv. No header row, matching DBeaver and TablePlus — rows are usually pasted
   * into a sheet that already has one.
   *
   * A tab or newline inside a value would break the row/column split, so both become a space. That
   * is the same trade the Markdown copy makes with `|`, and it is why this is a copy for pasting
   * rather than a lossless export — the export dialog is where fidelity lives.
   */
  const copySelectionAsTsv = () => {
    const picked = selectedRows();
    if (picked.length === 0) return;
    const cols = activeColumns.map(c => c.name);
    const cell = (v: any) => (v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]+/g, ' '));
    copyToClipboard(picked.map(r => cols.map(c => cell(r[c])).join('\t')).join('\n'));
    setSuccessMsg(t('dataGrid.copiedRowsTsv', { n: picked.length }));
    setTimeout(() => setSuccessMsg(null), 2000);
  };

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close); };
  }, [contextMenu]);

  // Discard all changes
  const handleDiscard = () => {
    setUpdates({});
    setDeletes(new Set());
    setInserts([]);
    setEditingCell(null);
    setSuccessMsg(t('dataGrid.discarded'));
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  // Commit changes to Database
  const handleCommit = async () => {
    const changesList: GridChange[] = [];

    // 1. Gather Deletes
    deletes.forEach(rowId => {
      changesList.push({ type: 'delete', rowId });
    });

    // 2. Gather Inserts
    inserts.forEach(row => {
      const data = { ...row };
      delete data.__tempId;
      // A PK column is dropped from the INSERT only while it is empty -> the DB generates it
      // (auto-increment). Once the user has typed a PK value (officeCode, say), it is kept and goes
      // into the INSERT.
      const pkVal = data[primaryKey];
      if (pkVal === '' || pkVal === null || pkVal === undefined || String(pkVal).startsWith('temp_')) {
        delete data[primaryKey];
      }
      changesList.push({ type: 'insert', rowId: row.__tempId, newData: data });
    });

    // 3. Gather Updates
    Object.keys(updates).forEach(rowId => {
      const originalRow = rows.find(r => String(r[primaryKey]) === String(rowId));
      changesList.push({
        type: 'update',
        rowId,
        originalData: originalRow,
        newData: updates[rowId]
      });
    });

    if (readOnly) {
      setErrorMsg(t('dataGrid.errReadOnlyCommit'));
      setTimeout(() => setErrorMsg(null), 4000);
      return;
    }

    if (changesList.length === 0) {
      setErrorMsg(t('dataGrid.errNoChanges'));
      setTimeout(() => setErrorMsg(null), 3000);
      return;
    }

    // With the preview off (the switch in the Safe Mode popover) it saves straight away. The
    // `preview: true` round is not made either: that is another trip to the backend just to build
    // something nobody reads.
    if (!getCommitPreviewForKey(connKeyOfConn(connId))) {
      setPendingChanges(changesList);
      await commitNow(changesList);
      return;
    }

    // Fetches the SQL that will run so the user can see it first (the transaction preview)
    setLoading(true);
    const preview = await dbHelper.commitChanges(connId, tableName, changesList, primaryKey, true);
    setLoading(false);

    if (!preview.success) {
      setErrorMsg(t('dataGrid.errPreview', { message: preview.message }));
      return;
    }
    setPendingChanges(changesList);
    setCommitPreview(preview.sqls || []);
  };

  /**
   * The real write. Split out of `handleConfirmCommit` because two paths now reach it: through the
   * preview dialog, and directly when that dialog is switched off. It takes `changes` as a parameter
   * rather than reading `pendingChanges`: the direct path has only just called `setPendingChanges`,
   * so state has not caught up in this render.
   */
  const commitNow = async (changes: GridChange[]) => {
    setCommitPreview(null);
    setLoading(true);
    const res = await dbHelper.commitChanges(connId, tableName, changes, primaryKey);
    setLoading(false);
    setPendingChanges([]);

    if (res.success) {
      setSuccessMsg(t('dataGrid.commitSuccess'));
      setUpdates({});
      setDeletes(new Set());
      setInserts([]);
      resetGridHistory(); // buffer already write DB -> delete undo/redo
      refetchAfterWrite();
      setTimeout(() => setSuccessMsg(null), 4000);
    } else {
      setErrorMsg(t('dataGrid.errCommit', { message: res.message }));
    }
  };

  /** The preview dialog's confirm button. */
  const handleConfirmCommit = () => commitNow(pendingChanges);

  // Helper to build SQL WHERE clause from visual filters
  const buildWhereFromVisual = (rowsToBuild: FilterRow[]) => {
    const active = rowsToBuild.filter(r => r.active && r.column);
    if (active.length === 0) return '';
    // Identifier quoting per dialect: MySQL uses backticks, the others double quotes
    const qc = dbType === 'mysql' ? '`' : '"';
    return active.map(r => {
      const col = `${qc}${r.column}${qc}`;
      const val = r.value.replace(/'/g, "''");
      switch (r.operator) {
        case '=': return `${col} = '${val}'`;
        case '!=':
        case '<>': return `${col} != '${val}'`;
        case '<': return `${col} < '${val}'`;
        case '>': return `${col} > '${val}'`;
        case '<=': return `${col} <= '${val}'`;
        case '>=': return `${col} >= '${val}'`;
        case 'IN': return `${col} IN (${r.value.trim()})`;
        case 'NOT IN': return `${col} NOT IN (${r.value.trim()})`;
        case 'IS NULL': return `${col} IS NULL`;
        case 'IS NOT NULL': return `${col} IS NOT NULL`;
        case 'BETWEEN': return `${col} BETWEEN ${r.value.trim()}`;
        case 'NOT BETWEEN': return `${col} NOT BETWEEN ${r.value.trim()}`;
        case 'LIKE': return `${col} LIKE '${val}'`;
        case 'Contains': return `${col} LIKE '%${val}%'`;
        case 'Not contains': return `${col} NOT LIKE '%${val}%'`;
        case 'Starts with': return `${col} LIKE '${val}%'`;
        case 'Ends with': return `${col} LIKE '%${val}'`;
        default: return `${col} = '${val}'`;
      }
    }).join(' AND ');
  };



  const removeFilterRow = (id: string) => {
    if (filterRows.length <= 1) {
      // Removing the last filter row closes the filter bar and clears the condition
      setShowFilterBar(false);
      clearFilter();
      return;
    }
    const remaining = filterRows.filter(r => r.id !== id);
    setFilterRows(remaining);
    if (activeFilter) {
      setActiveFilter(buildWhereFromVisual(remaining));
      setPage(1);
    }
  };

  const updateFilterRow = (id: string, fieldUpdates: Partial<FilterRow>) => {
    setFilterRows(filterRows.map(r => r.id === id ? { ...r, ...fieldUpdates } : r));
  };

  // Filter Trigger
  const triggerFilter = () => {
    if (filterMode === 'sql') {
      setActiveFilter(filterText);
    } else {
      setActiveFilter(buildWhereFromVisual(filterRows));
    }
    setPage(1);
  };

  const applySingleFilterRow = (rowId: string) => {
    const updated = filterRows.map(r => r.id === rowId ? { ...r, active: true } : r);
    setFilterRows(updated);
    setActiveFilter(buildWhereFromVisual(updated));
    setPage(1);
  };

  // Builds a complete SELECT from the filter currently applied, ready to paste into the SQL editor.
  // ORDER BY comes along when a sort is active, so the SQL reproduces exactly what the grid shows.
  const buildFilterSql = () => {
    const qc = dbType === 'mysql' ? '`' : '"';
    const where = filterMode === 'sql' ? filterText.trim() : buildWhereFromVisual(filterRows);
    let sql = `SELECT * FROM ${qc}${tableName}${qc}`;
    if (where) sql += `\nWHERE ${where}`;
    if (sortBy) sql += `\nORDER BY ${qc}${sortBy}${qc} ${sortDir.toUpperCase()}`;
    return sql + ';';
  };

  const handleCopyFilterSql = async () => {
    try {
      await navigator.clipboard.writeText(buildFilterSql());
      setSuccessMsg(t('dataGrid.copiedFilterSql'));
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch {
      setErrorMsg(t('dataGrid.errClipboard'));
      setTimeout(() => setErrorMsg(null), 3000);
    }
  };

  const clearFilter = () => {
    setFilterText('');
    if (columns.length > 0) {
      setFilterRows([
        { id: '1', active: true, column: columns[0].name, operator: 'Contains', value: '' }
      ]);
    } else {
      setFilterRows([]);
    }
    setActiveFilter('');
    setPage(1);
  };

  // Helper count of pending changes
  const changeCount = Object.keys(updates).length + deletes.size + inserts.length;

  // The guard against leaving with unsaved edits:
  //  - beforeunload: warns on reload or app close.
  //  - onDirtyChange: tells App so it can confirm before a tab/table switch or a disconnect, and put
  //    the "unsaved" dot on the tab.
  //
  // The cleanup reports `false`: by then the tab has already changed, and App always clears the flag
  // rather than assigning it per tab, so an unmounting grid cannot leave a mark on the new tab.
  useEffect(() => {
    onDirtyChangeRef.current?.(changeCount > 0);
    const handler = (e: BeforeUnloadEvent) => {
      if (changeCount > 0) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      onDirtyChangeRef.current?.(false);
    };
  }, [changeCount]);

  // Click outside listener for Import/Export combined popover
  useEffect(() => {
    if (!showIoPopover) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ioPopoverRef.current && !ioPopoverRef.current.contains(e.target as Node)) {
        setShowIoPopover(false);
      }
    };
    const timer = setTimeout(() => {
      window.addEventListener('click', handleClickOutside);
    }, 10);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('click', handleClickOutside);
    };
  }, [showIoPopover]);

  // Auto focus input when Quick Search opens
  useEffect(() => {
    if (showQuickSearch) {
      setTimeout(() => {
        quickSearchInputRef.current?.focus();
        quickSearchInputRef.current?.select();
      }, 50);
    }
  }, [showQuickSearch]);

  const activeColumns = columns.filter(c => visibleColumns.includes(c.name));

  // ————— Quick Search (Search Anything) Helpers —————
  const normalizeSearch = (val: any): string => {
    if (val === null || val === undefined) return '';
    return String(val)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  };

  const rowMatchesSearch = useCallback((row: any, query: string, rowUpdates: any = {}) => {
    const trimmed = query.trim();
    if (!trimmed) return true;
    const q = normalizeSearch(trimmed);
    return activeColumns.some(col => {
      const cellVal = col.name in rowUpdates ? rowUpdates[col.name] : row[col.name];
      return normalizeSearch(cellVal).includes(q);
    });
  }, [activeColumns]);

  const renderCellWithHighlight = (cellVal: any, query: string): React.ReactNode => {
    if (cellVal === null || cellVal === undefined || cellVal === '') return cellVal;
    const trimmed = query.trim();
    if (!trimmed) return String(cellVal);
    const str = String(cellVal);
    const normStr = normalizeSearch(str);
    const normQ = normalizeSearch(trimmed);
    const matchIdx = normStr.indexOf(normQ);
    if (matchIdx === -1) return str;

    const before = str.slice(0, matchIdx);
    const matched = str.slice(matchIdx, matchIdx + trimmed.length);
    const after = str.slice(matchIdx + trimmed.length);
    return (
      <>
        {before}
        <mark className="grid-search-mark">{matched}</mark>
        {renderCellWithHighlight(after, query)}
      </>
    );
  };

  const displayedRows = React.useMemo(() => {
    if (!quickSearchQuery.trim()) return rows;
    return rows.filter((row) => {
      const rowId = row[primaryKey];
      const hasPK = rowId !== undefined && rowId !== null;
      const rowUpdates = hasPK ? (updates[rowId] || {}) : {};
      return rowMatchesSearch(row, quickSearchQuery, rowUpdates);
    });
  }, [rows, quickSearchQuery, primaryKey, updates, rowMatchesSearch]);

  const displayedInserts = React.useMemo(() => {
    if (!quickSearchQuery.trim()) return inserts;
    return inserts.filter(row => rowMatchesSearch(row, quickSearchQuery, {}));
  }, [inserts, quickSearchQuery, rowMatchesSearch]);

  /**
   * Every selectable row's key, in the order they appear on screen — existing rows first, then the
   * rows added in this session, which is how the two `.map()`s below render them.
   *
   * A Shift range is a range of what the user can SEE. Computing it from `rows` alone would make a
   * shift-click span rows hidden by the quick search, so the selection would include rows that are
   * not on screen and cannot be unselected by clicking.
   */
  const orderedRowKeys = React.useMemo(() => {
    const keys = displayedRows.map((row, idx) => {
      const id = row[primaryKey];
      return id !== undefined && id !== null ? id : `__idx_${idx}`;
    });
    return keys.concat(displayedInserts.map(row => row.__tempId));
  }, [displayedRows, displayedInserts, primaryKey]);

  /**
   * One click on a row, with the three behaviours every table has:
   *
   * - plain: select just this row;
   * - Ctrl/Cmd: add or remove this row, leaving the rest alone;
   * - Shift: select from the anchor to here, replacing the selection.
   *
   * Shift deliberately does not move the anchor, so holding Shift and clicking around resizes one
   * range instead of chaining ranges end to end. Ctrl does move it, because the row just toggled is
   * what the next Shift should measure from.
   */
  const handleRowClick = useCallback(
    (key: any, e: React.MouseEvent) => {
      // Shift+Click also extends the BROWSER's text selection across every row it spans. Left alone
      // that highlight looks wrong AND breaks Ctrl+C, which stands aside whenever text is selected
      // so that copying a highlighted cell value still works.
      if (e.shiftKey) window.getSelection()?.removeAllRanges();
      if (e.shiftKey && anchorRowId !== null) {
        const from = orderedRowKeys.indexOf(anchorRowId);
        const to = orderedRowKeys.indexOf(key);
        if (from >= 0 && to >= 0) {
          const [lo, hi] = from <= to ? [from, to] : [to, from];
          setSelectedRowIds(new Set(orderedRowKeys.slice(lo, hi + 1)));
          return;
        }
        // The anchor scrolled out of the filtered list: fall through to a plain select rather than
        // silently selecting nothing.
      }
      if (e.ctrlKey || e.metaKey) {
        setSelectedRowIds(prev => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        setAnchorRowId(key);
        return;
      }
      setSelectedRowId(key);
    },
    [anchorRowId, orderedRowKeys, setSelectedRowId],
  );

  /**
   * What a right-click does to the selection: nothing, if the row it landed on is already part of
   * it. Right-clicking inside a selection to reach "copy" must not first throw that selection away
   * — that is the one interaction where clearing it destroys exactly what the user was about to act
   * on. On a row outside the selection it behaves like a plain click.
   */
  const selectForContextMenu = useCallback(
    (key: any) => {
      setSelectedRowIds(prev => (prev.has(key) ? prev : new Set([key])));
      setAnchorRowId(key);
    },
    [],
  );

  return (
    <div className="table-data-view">
      {viewMode === 'data' && showFilterBar && (
        <div className="visual-filter-container">
          {filterMode === 'sql' ? (
            /* Raw SQL Input Mode */
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', width: '100%' }}>
                <input
                  type="text"
                  className="sidebar-search-input"
                  style={{ width: '100%', paddingRight: '24px' }}
                  placeholder={t('dataGrid.filterSqlPlaceholder')}
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && triggerFilter()}
                  autoFocus
                />
                {activeFilter && (
                  <button
                    onClick={clearFilter}
                    style={{
                      position: 'absolute', right: '8px', background: 'transparent',
                      border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer',
                      fontSize: '14px'
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="visual-filter-footer">
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button className="visual-filter-btn-apply" onClick={clearFilter}>
                    {t('dataGrid.clearAll')}
                  </button>
                  <button className="visual-filter-btn-apply" onClick={() => setFilterMode('visual')} style={{ fontWeight: 600 }}>
                    {t('dataGrid.filterVisual')}
                  </button>
                  <button className="visual-filter-btn-apply" onClick={handleCopyFilterSql} title={t('dataGrid.copySqlTitle')}>
                    <Copy size={12} /> {t('dataGrid.copySql')}
                  </button>
                </div>
                <button className="visual-filter-btn-primary" onClick={triggerFilter}>
                  {t('dataGrid.runSqlFilter')}
                </button>
              </div>
            </div>
          ) : (
            /* Visual Filter Builder Mode */
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {filterRows.map((row) => (
                <div key={row.id} className="visual-filter-row">
                  <input
                    type="checkbox"
                    className="visual-filter-checkbox"
                    checked={row.active}
                    onChange={(e) => updateFilterRow(row.id, { active: e.target.checked })}
                  />
                  <select
                    className="visual-filter-select"
                    value={row.column}
                    onChange={(e) => updateFilterRow(row.id, { column: e.target.value })}
                  >
                    {columns.map(col => (
                      <option key={col.name} value={col.name}>{col.name}</option>
                    ))}
                  </select>
                  {/* ONLY the displayed label changes; the value has to stay as it is, because it goes
                      straight into building the WHERE clause. */}
                  <select
                    className="visual-filter-select"
                    style={{ minWidth: '130px' }}
                    value={row.operator}
                    onChange={(e) => updateFilterRow(row.id, { operator: e.target.value })}
                  >
                    <option value="=">=</option>
                    <option value="!=">&lt;&gt;</option>
                    <option value="<">&lt;</option>
                    <option value=">">&gt;</option>
                    <option value="<=">&lt;=</option>
                    <option value=">=">&gt;=</option>
                    <optgroup label="────────────">
                      <option value="IN">IN</option>
                      <option value="NOT IN">NOT IN</option>
                    </optgroup>
                    <optgroup label="────────────">
                      <option value="IS NULL">IS NULL</option>
                      <option value="IS NOT NULL">IS NOT NULL</option>
                    </optgroup>
                    <optgroup label="────────────">
                      <option value="BETWEEN">BETWEEN</option>
                      <option value="NOT BETWEEN">NOT BETWEEN</option>
                    </optgroup>
                    <optgroup label="────────────">
                      <option value="LIKE">LIKE</option>
                      <option value="Contains">{t('dataGrid.opContains', 'Contains')}</option>
                      <option value="Not contains">Not contains</option>
                      <option value="Starts with">{t('dataGrid.opStartsWith', 'Starts with')}</option>
                      <option value="Ends with">{t('dataGrid.opEndsWith', 'Ends with')}</option>
                    </optgroup>
                  </select>
                  <input
                    type="text"
                    className="visual-filter-input"
                    placeholder={t('dataGrid.filterValuePlaceholder')}
                    value={row.value}
                    disabled={row.operator === 'IS NULL' || row.operator === 'IS NOT NULL'}
                    onChange={(e) => updateFilterRow(row.id, { value: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && triggerFilter()}
                    style={{ flex: 1, minWidth: '220px' }}
                  />
                  <button className="visual-filter-btn-apply" onClick={() => applySingleFilterRow(row.id)} title={t('dataGrid.applyRowTitle')}>
                    {t('dataGrid.applyRow')}
                  </button>
                  <button className="visual-filter-btn-icon" onClick={() => removeFilterRow(row.id)} title={t('dataGrid.removeFilterRow')} aria-label={t('dataGrid.removeFilterRow')}>
                    <Minus size={13} />
                  </button>
                  <button className="visual-filter-btn-icon" onClick={() => addFilterRow(row.id)} title={t('dataGrid.addFilterRow')} aria-label={t('dataGrid.addFilterRow')}>
                    <Plus size={13} />
                  </button>
                </div>
              ))}
              <div className="visual-filter-footer">
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <button className="visual-filter-btn-apply" onClick={clearFilter}>
                    {t('dataGrid.clearAll')}
                  </button>
                  <button className="visual-filter-btn-apply" onClick={() => setFilterMode('sql')} style={{ fontWeight: 600 }}>
                    {t('dataGrid.filterBySql')}
                  </button>
                  <button className="visual-filter-btn-apply" onClick={handleCopyFilterSql} title={t('dataGrid.copySqlTitle')}>
                    <Copy size={12} /> {t('dataGrid.copySql')}
                  </button>
                  {/* Shows only the running platform's shortcut, rather than printing "⌘F / Ctrl+F"
                      and leaving the user to work out which half applies. */}
                  <div className="visual-filter-footer-info" style={{ marginLeft: '12px' }}>
                    <span>{t('dataGrid.shortcutToggleFilter')} <kbd>{modKey}F</kbd></span>
                    <span>{t('dataGrid.shortcutAddRow')} <kbd>{modKey}I</kbd></span>
                  </div>
                </div>
                <button className="visual-filter-btn-primary" onClick={triggerFilter}>
                  {t('dataGrid.applyAll')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}      {/* Commit/Discard buttons removed from here to prevent squeezing */}

      {/* Import progress — the preview modal has closed, so it is reported in the grid's message bar */}
      {importProgress && (
        <div className="info-bar info-bar-blue">
          <ProgressBar progress={importProgress} />
        </div>
      )}

      {successMsg && (
        <div className="info-bar info-bar-success">
          <div className="info-bar-content">
            <CheckCircle2 size={16} />
            <span>{successMsg}</span>
          </div>
          {/* Dismissible by hand, rather than waiting out the 5 seconds */}
          <button className="info-bar-close" onClick={() => setSuccessMsg(null)}>×</button>
        </div>
      )}

      {errorMsg && (
        <div className="info-bar info-bar-error">
          <div className="info-bar-content">
            <AlertTriangle size={16} />
            <span>{errorMsg}</span>
          </div>
          <button className="info-bar-close" onClick={() => setErrorMsg(null)}>×</button>
        </div>
      )}

      {viewMode === 'data' && showQuickSearch && (
        <div className="grid-quick-search-bar">
          <div className="grid-quick-search-left">
            <div className="grid-quick-search-wrap">
              <Search size={14} className="grid-quick-search-icon" />
              <input
                ref={quickSearchInputRef}
                type="text"
                className="grid-quick-search-input"
                placeholder={t('dataGrid.quickSearchPlaceholder', 'Search anything across all visible columns... (Esc to close)')}
                value={quickSearchQuery}
                onChange={(e) => setQuickSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    if (quickSearchQuery) {
                      setQuickSearchQuery('');
                    } else {
                      setShowQuickSearch(false);
                    }
                  }
                }}
              />
              <div className="grid-quick-search-actions">
                {quickSearchQuery && (
                  <button
                    className="grid-quick-search-btn-clear"
                    onClick={() => setQuickSearchQuery('')}
                    title={t('dataGrid.quickSearchClear', 'Clear search')}
                    aria-label={t('dataGrid.quickSearchClear', 'Clear search')}
                  >
                    <X size={13} />
                  </button>
                )}
                {quickSearchQuery.trim() && (
                  <span className={`grid-quick-search-badge ${displayedRows.length + displayedInserts.length === 0 ? 'empty' : ''}`}>
                    {displayedRows.length + displayedInserts.length === 0
                      ? t('dataGrid.quickSearchNoMatches', '0 results')
                      : t('dataGrid.quickSearchMatches', { matched: displayedRows.length + displayedInserts.length, total: rows.length + inserts.length, defaultValue: `${displayedRows.length + displayedInserts.length}/${rows.length + inserts.length}` })}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="grid-quick-search-right">
            <span className="grid-quick-search-kbd">Esc</span>
            <button
              className="grid-quick-search-btn-close"
              onClick={() => { setShowQuickSearch(false); setQuickSearchQuery(''); }}
              title={t('dataGrid.quickSearchClose', 'Close quick search')}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {viewMode === 'structure' && schema ? (
        <StructureViewer
          connId={connId}
          tableName={tableName}
          schema={schema}
          dbType={dbType}
          onSchemaChanged={fetchSchema}
          readOnly={readOnly}
          activeSection={structSection}
          onSectionChange={setStructSection}
        />
      ) : viewMode === 'chart' ? (
        <DataVisualizer
          rows={rows}
          columnNames={columns.map(c => c.name)}
          tableName={tableName}
        />
      ) : viewMode === 'properties' ? (
        <TablePropertiesView connId={connId} tableName={tableName} tableSchema={tableSchema} />
      ) : (
        <div className="grid-table-container">
          {loading && rows.length === 0 ? (
            <div className="grid-loading-box">
              <LoadingSpinner size={32} />
              <span className="grid-loading-text">{t('dataGrid.loadingData')}</span>
            </div>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  {activeColumns.map(col => {
                    const fkInfo = getFkInfo(col.name);
                    return (
                      <th key={col.name} className="grid-th-clickable" onClick={() => handleSort(col.name)}>
                        <div className="grid-th-content">
                          <span>{col.name}</span>
                          {col.isPrimaryKey && <span className="key-badge">PK</span>}
                          {fkInfo && <span className="fk-badge" title={`Foreign Key ➔ ${fkInfo.refTable}.${fkInfo.refColumn}`}>FK</span>}
                          {sortBy === col.name && (
                            <span className="grid-sort-icon">
                              {sortDir === 'asc' ? '▲' : '▼'}
                            </span>
                          )}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {/* 1. Render database rows */}
                {displayedRows.map((row, index) => {
                  const rowId = row[primaryKey];
                  // Guard: if PK is missing, use index-based fallback to prevent shared state across rows
                  const hasPK = rowId !== undefined && rowId !== null;
                  const selectionKey = hasPK ? rowId : `__idx_${index}`;
                  const isDeleted = hasPK && deletes.has(rowId);
                  const isSelected = selectedRowIds.has(selectionKey);
                  const rowUpdates = hasPK ? (updates[rowId] || {}) : {};

                  return (
                    <tr
                      key={selectionKey}
                      className={`${isDeleted ? 'grid-row-deleted' : ''} ${isSelected ? 'selected' : ''}`}
                      onClick={(e) => handleRowClick(selectionKey, e)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        selectForContextMenu(selectionKey);
                        const colName = (e.target as HTMLElement).closest('td')?.dataset.col || activeColumns[0]?.name || '';
                        const cellVal = colName in rowUpdates ? rowUpdates[colName] : row[colName];
                        setContextMenu({ x: e.clientX, y: e.clientY, rowId: selectionKey, row, colName, cellValue: cellVal });
                      }}
                    >
                      {activeColumns.map(col => {
                        const isCellDirty = col.name in rowUpdates;
                        const cellVal = isCellDirty ? rowUpdates[col.name] : row[col.name];
                        const isEditing = editingCell?.rowId === rowId && editingCell?.colName === col.name;
                        const fkInfo = getFkInfo(col.name);

                        return (
                          <td
                            key={col.name}
                            data-col={col.name}
                            className={`${isCellDirty ? 'grid-cell-dirty' : ''} ${isEditing ? 'is-editing' : ''}`.trim()}
                            onDoubleClick={() => startEdit(rowId, col.name, cellVal)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              // Must mirror the <tr> handler above, whose call this stopPropagation
                              // suppresses: a cell fills its row, so right-clicking a row IS right-
                              // clicking a cell, and the single-select setter used here threw away a
                              // multi-row selection every time the menu was opened on it.
                              selectForContextMenu(selectionKey);
                              setContextMenu({ x: e.clientX, y: e.clientY, rowId: selectionKey, row, colName: col.name, cellValue: cellVal });
                            }}
                          >
                            {isEditing ? (
                              <>
                                <span className="grid-cell-ghost">{cellVal === null ? 'NULL' : String(cellVal)}</span>
                                <div className="grid-edit-wrapper">
                                <input
                                  type="text"
                                  className={`grid-input-edit ${isDateField(col.name, col.type, cellVal) ? 'has-date-picker' : ''}`}
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  onBlur={saveEdit}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') saveEdit();
                                    if (e.key === 'Escape') setEditingCell(null);
                                  }}
                                  autoFocus
                                />
                                {isDateField(col.name, col.type, cellVal) && (
                                  <div
                                    className="grid-date-picker-btn"
                                    title={t('common.selectDate', 'Select Date & Time')}
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      const pickerEl = e.currentTarget.querySelector('input[type="datetime-local"]') as HTMLInputElement;
                                      if (pickerEl && typeof pickerEl.showPicker === 'function') {
                                        try { pickerEl.showPicker(); } catch {}
                                      }
                                    }}
                                  >
                                    <Calendar size={13} style={{ pointerEvents: 'none' }} />
                                    <input
                                      type="datetime-local"
                                      step="1"
                                      className="grid-date-picker-input"
                                      value={formatForPicker(editValue)}
                                      onMouseDown={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        if (typeof e.currentTarget.showPicker === 'function') {
                                          try { e.currentTarget.showPicker(); } catch {}
                                        }
                                      }}
                                      onChange={(e) => {
                                        if (e.target.value) {
                                          const orig = String(cellVal || editValue || '');
                                          if (orig.includes('+')) {
                                            const tz = orig.slice(orig.indexOf('+'));
                                            setEditValue(e.target.value + tz);
                                          } else if (orig.includes('Z')) {
                                            setEditValue(e.target.value + 'Z');
                                          } else if (orig.includes(' ') && !orig.includes('T')) {
                                            setEditValue(e.target.value.replace('T', ' '));
                                          } else {
                                            setEditValue(e.target.value);
                                          }
                                        }
                                      }}
                                    />
                                  </div>
                                )}
                               </div>
                              </>
                            ) : cellVal === null ? (
                              <span className="grid-cell-null">NULL</span>
                            ) : fkInfo && cellVal !== '' && cellVal !== undefined ? (
                              <div
                                className="grid-cell-fk"
                                onClick={(e) => handleFkClick(col.name, cellVal, e)}
                                title={`FK ➔ ${fkInfo.refTable}.${fkInfo.refColumn} = ${cellVal}`}
                              >
                                <span className="grid-cell-fk-val">{renderCellWithHighlight(cellVal, quickSearchQuery)}</span>
                                <span className="grid-cell-fk-btn" title={`Mở bảng ${fkInfo.refTable}`}>
                                  <ArrowUpRight size={10} strokeWidth={2.4} />
                                </span>
                              </div>
                            ) : (
                              <MediaCellPreview
                                value={cellVal}
                                columnName={col.name}
                                tableName={tableName}
                                fallbackText={renderCellWithHighlight(cellVal, quickSearchQuery)}
                              />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}

                {/* 2. Render new added rows */}
                {displayedInserts.map((row) => {
                  const rowId = row.__tempId;
                  const isSelected = selectedRowIds.has(rowId);
                  return (
                    <tr
                      key={rowId}
                      className={`grid-row-added ${isSelected ? 'selected' : ''}`}
                      onClick={(e) => handleRowClick(rowId, e)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        selectForContextMenu(rowId);
                        const colName = (e.target as HTMLElement).closest('td')?.dataset.col || activeColumns[0]?.name || '';
                        setContextMenu({ x: e.clientX, y: e.clientY, rowId, row, colName, cellValue: row[colName] });
                      }}
                    >
                      {activeColumns.map(col => {
                        const cellVal = row[col.name];
                        const isEditing = editingCell?.rowId === rowId && editingCell?.colName === col.name;
                        const fkInfo = getFkInfo(col.name);

                        return (
                          <td
                            key={col.name}
                            data-col={col.name}
                            className={isEditing ? 'is-editing' : ''}
                            onDoubleClick={() => startEdit(rowId, col.name, cellVal)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              // Same reason as the cell handler of the existing-rows table above.
                              selectForContextMenu(rowId);
                              setContextMenu({ x: e.clientX, y: e.clientY, rowId, row, colName: col.name, cellValue: cellVal });
                            }}
                          >
                            {isEditing ? (
                              <>
                                <span className="grid-cell-ghost">{cellVal === null || cellVal === '' ? '—' : String(cellVal)}</span>
                                <div className="grid-edit-wrapper">
                                <input
                                  type="text"
                                  className={`grid-input-edit ${isDateField(col.name, col.type, cellVal) ? 'has-date-picker' : ''}`}
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  onBlur={saveEdit}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') saveEdit();
                                    if (e.key === 'Escape') setEditingCell(null);
                                  }}
                                  autoFocus
                                />
                                {isDateField(col.name, col.type, cellVal) && (
                                  <div
                                    className="grid-date-picker-btn"
                                    title={t('common.selectDate', 'Select Date & Time')}
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      const pickerEl = e.currentTarget.querySelector('input[type="datetime-local"]') as HTMLInputElement;
                                      if (pickerEl && typeof pickerEl.showPicker === 'function') {
                                        try { pickerEl.showPicker(); } catch {}
                                      }
                                    }}
                                  >
                                    <Calendar size={13} style={{ pointerEvents: 'none' }} />
                                    <input
                                      type="datetime-local"
                                      step="1"
                                      className="grid-date-picker-input"
                                      value={formatForPicker(editValue)}
                                      onMouseDown={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        if (typeof e.currentTarget.showPicker === 'function') {
                                          try { e.currentTarget.showPicker(); } catch {}
                                        }
                                      }}
                                      onChange={(e) => {
                                        if (e.target.value) {
                                          const orig = String(cellVal || editValue || '');
                                          if (orig.includes('+')) {
                                            const tz = orig.slice(orig.indexOf('+'));
                                            setEditValue(e.target.value + tz);
                                          } else if (orig.includes('Z')) {
                                            setEditValue(e.target.value + 'Z');
                                          } else if (orig.includes(' ') && !orig.includes('T')) {
                                            setEditValue(e.target.value.replace('T', ' '));
                                          } else {
                                            setEditValue(e.target.value);
                                          }
                                        }
                                      }}
                                    />
                                  </div>
                                )}
                               </div>
                              </>
                            ) : cellVal === null || cellVal === '' ? (
                              /* A cell with no value: a faint dash makes the cell visible, where an
                                 empty string leaves the whole row looking blank. */
                              <span className="grid-cell-empty">—</span>
                            ) : fkInfo && cellVal !== undefined ? (
                              <div
                                className="grid-cell-fk"
                                onClick={(e) => handleFkClick(col.name, cellVal, e)}
                                title={`FK ➔ ${fkInfo.refTable}.${fkInfo.refColumn} = ${cellVal}`}
                              >
                                <span className="grid-cell-fk-val">{renderCellWithHighlight(cellVal, quickSearchQuery)}</span>
                                <span className="grid-cell-fk-btn" title={`Mở bảng ${fkInfo.refTable}`}>
                                  <ArrowUpRight size={10} strokeWidth={2.4} />
                                </span>
                              </div>
                            ) : (
                              <MediaCellPreview
                                value={cellVal}
                                columnName={col.name}
                                tableName={tableName}
                                fallbackText={renderCellWithHighlight(cellVal, quickSearchQuery)}
                              />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}

                {/* 3. Empty search result row */}
                {displayedRows.length === 0 && displayedInserts.length === 0 && quickSearchQuery.trim() !== '' && (
                  <tr>
                    <td colSpan={activeColumns.length} className="doc-field-empty">
                      {t('dataGrid.quickSearchNoMatches', '0 results')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* The background, top border and height come from the .grid-pagination class so this bar is
          exactly as tall as the sidebar's footer (--ws-foot-h); inline styles would override the glass. */}
      <div className="grid-pagination gp-container">
        {/* Left segment: Data | Structure | Chart & + Row */}
        <div className="gp-left-section">
          <button
            className={`gp-btn ${viewMode === 'data' ? 'on' : ''}`}
            onClick={() => setViewMode('data')}
          >
            {t('dataGrid.dataTab')}
          </button>

          <button
            className={`gp-btn ${viewMode === 'structure' ? 'on' : ''}`}
            onClick={() => { setViewMode('structure'); setStructSection('columns'); }}
          >
            {t('dataGrid.structureTab')}
          </button>

          <button
            className={`gp-btn ${viewMode === 'chart' ? 'on' : ''}`}
            onClick={() => setViewMode('chart')}
            title={t('dataGrid.chartViewTitle', 'Visualize table data with charts')}
          >
            <BarChart2 size={12} />
            <span>{t('dataGrid.chartTab', 'Chart')}</span>
          </button>

          <button
            className={`gp-btn ${viewMode === 'properties' ? 'on' : ''}`}
            onClick={() => setViewMode('properties')}
            title={t('dataGrid.propertiesViewTitle')}
          >
            <Sliders size={12} />
            <span>{t('dataGrid.propertiesTab')}</span>
          </button>

          {viewMode === 'structure' && (
            <>
              <button
                className={`gp-btn ${structSection === 'columns' ? 'on' : ''}`}
                onClick={() => setStructSection('columns')}
              >
                Columns {schema?.columns?.length !== undefined ? <span className="st-seg-count">{schema.columns.length}</span> : null}
              </button>
              <button
                className={`gp-btn ${structSection === 'indexes' ? 'on' : ''}`}
                onClick={() => setStructSection('indexes')}
              >
                Indexes {schema?.indexes?.length !== undefined ? <span className="st-seg-count">{schema.indexes.length}</span> : null}
              </button>
              <button
                className={`gp-btn ${structSection === 'fks' ? 'on' : ''}`}
                onClick={() => setStructSection('fks')}
              >
                Foreign keys {schema?.foreignKeys?.length !== undefined ? <span className="st-seg-count">{schema.foreignKeys.length}</span> : null}
              </button>
              <button
                className={`gp-btn ${structSection === 'check_constraints' ? 'on' : ''}`}
                onClick={() => setStructSection('check_constraints')}
              >
                Check Constraints
              </button>
              <button
                className={`gp-btn ${structSection === 'triggers' ? 'on' : ''}`}
                onClick={() => setStructSection('triggers')}
              >
                Triggers
              </button>
              <button
                className={`gp-btn ${structSection === 'partitions' ? 'on' : ''}`}
                onClick={() => setStructSection('partitions')}
              >
                Partitions
              </button>
              <button
                className={`gp-btn ${structSection === 'ddl' ? 'on' : ''}`}
                onClick={() => setStructSection('ddl')}
              >
                DDL
              </button>
            </>
          )}

          {viewMode === 'data' && (
            <>
              <button className="gp-btn icon" onClick={handleAddRow} title={t('dataGrid.addRowTitle')}>
                <Plus size={13} />
              </button>

              <button
                className="gp-btn icon danger"
                onClick={handleDeleteRow}
                disabled={selectedRowIds.size === 0}
                title={t('dataGrid.deleteRowTitle')}
              >
                <Minus size={13} />
              </button>
            </>
          )}

          {/* Commit/Discard Actions */}
          {changeCount > 0 && (
            <div className="gp-btn-group">
              <button className="gp-btn icon" onClick={handleDiscard} title={t('dataGrid.discardTitle')}>
                <RotateCcw size={12} />
              </button>
              <button className="gp-btn save" onClick={handleCommit} title={t('dataGrid.saveTitle')}>
                <Save size={12} />
                <span>{t('dataGrid.saveButton', { n: changeCount })}</span>
              </button>
            </div>
          )}
        </div>

        {/* Middle section: Row Count */}
        {viewMode === 'data' && (
          <div
            className="gp-status-text"
            title={!countExact && totalCount !== null ? t('dataGrid.rowsApproxTitle') : undefined}
          >
            <Trans
              // Three variants, because the total has three genuinely different states: exact,
              // estimated (the `~`), and uncountable. One sentence for all three makes an estimate
              // look like a real number — and on InnoDB it can be tens of percent out.
              i18nKey={
                totalCount === null
                  ? 'dataGrid.rowsRangeNoTotal'
                  : countExact
                    ? 'dataGrid.rowsRange'
                    : 'dataGrid.rowsRangeApprox'
              }
              values={{
                from: (page - 1) * pageSize + 1,
                // From the page's real row count, not from `totalCount`: the last page is shorter than
                // `pageSize`, and `totalCount` may be an estimate and so cannot be clamped correctly.
                to: (page - 1) * pageSize + rows.length,
                total: totalCount === null ? '' : fmtNum(totalCount),
              }}
              components={{ strong: <b /> }}
            />
            {!countExact && totalCount !== null && (
              // An estimate always comes with a way out: one click and there is a real number.
              <button
                className="gp-count-exact"
                onClick={recountExact}
                title={t('dataGrid.countExactTitle')}
              >
                {t('dataGrid.countExactBtn')}
              </button>
            )}
          </div>
        )}

        {/* Right section: Columns | Import/Export | Search | Filters | Navigation */}
        {viewMode === 'data' && (
          <div className="gp-right-section">
            <div className="gp-popover-wrap">
              <button
                className={`gp-btn ${showColumnsPopover ? 'on' : ''}`}
                onClick={() => {
                  if (!showColumnsPopover) {
                    setPendingVisibleColumns([...visibleColumns]);
                  }
                  setShowColumnsPopover(!showColumnsPopover);
                }}
                title={t('dataGrid.columnsTitle')}
              >
                {t('dataGrid.columnsBtn')}
              </button>

              {showColumnsPopover && (
                <div className="ws-menu gp-popover-menu">
                  <div className="gp-popover-heading">
                    {t('dataGrid.columnsHeading')}
                  </div>

                  <div>
                    <select
                      className="form-input"
                      style={{
                        width: '100%',
                        height: '28px',
                        fontSize: '11px',
                        padding: '2px 6px',
                        background: 'var(--win-bg-window)',
                        border: '1px solid var(--win-border)',
                        color: 'var(--win-text-primary)',
                        borderRadius: '4px',
                        outline: 'none',
                        cursor: 'pointer'
                      }}
                      value=""
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val && !pendingVisibleColumns.includes(val)) {
                          setPendingVisibleColumns([...pendingVisibleColumns, val]);
                        }
                      }}
                    >
                      <option value="" disabled style={{ background: 'var(--win-bg-window)', color: 'var(--win-text-primary)' }}>{t('dataGrid.addColumnOption')}</option>
                      {columns.map(c => c.name)
                        .filter(name => !pendingVisibleColumns.includes(name))
                        .map(name => (
                          <option key={name} value={name} style={{ background: 'var(--win-bg-window)', color: 'var(--win-text-primary)' }}>{name}</option>
                        ))}
                    </select>
                  </div>

                  <div style={{
                    minHeight: '80px',
                    maxHeight: '160px',
                    overflowY: 'auto',
                    border: '1px solid var(--win-border)',
                    borderRadius: '4px',
                    padding: '8px',
                    background: 'var(--win-bg-hover, rgba(0,0,0,0.05))',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '6px',
                    alignContent: 'flex-start'
                  }}>
                    {pendingVisibleColumns.length === 0 ? (
                      <span style={{ fontSize: '11px', color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>{t('dataGrid.noVisibleColumns')}</span>
                    ) : (
                      pendingVisibleColumns.map(colName => (
                        <div
                          key={colName}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            background: 'var(--win-accent-glow)',
                            border: '1px solid rgba(77, 139, 244, 0.4)',
                            color: 'var(--win-text-primary)',
                            fontSize: '11px',
                            padding: '2px 8px',
                            borderRadius: '12px',
                            fontWeight: 500
                          }}
                        >
                          <span>{colName}</span>
                          <button
                            onClick={() => setPendingVisibleColumns(pendingVisibleColumns.filter(c => c !== colName))}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--win-accent)',
                              padding: 0,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              marginLeft: '2px',
                              fontWeight: 'bold',
                              fontSize: '12px'
                            }}
                          >
                            ×
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px' }}>
                    <button
                      className="btn btn-secondary"
                      onClick={() => setPendingVisibleColumns([])}
                      style={{
                        height: '26px',
                        fontSize: '11px',
                        padding: '0 12px',
                        background: 'var(--win-bg-hover)',
                        border: '1px solid var(--win-border)',
                        color: 'var(--win-text-primary)',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      {t('dataGrid.clearBtn')}
                    </button>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        className="btn btn-secondary"
                        onClick={() => setShowColumnsPopover(false)}
                        style={{
                          height: '26px',
                          fontSize: '11px',
                          padding: '0 12px',
                          background: 'var(--win-bg-hover)',
                          border: '1px solid var(--win-border)',
                          color: 'var(--win-text-primary)',
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => {
                          setVisibleColumns([...pendingVisibleColumns]);
                          setShowColumnsPopover(false);
                        }}
                        style={{
                          height: '26px',
                          fontSize: '11px',
                          padding: '0 14px',
                          background: 'var(--win-accent)',
                          border: 'none',
                          color: '#ffffff',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontWeight: 600
                        }}
                      >
                        {t('dataGrid.applyBtn')}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Combined Import / Export Dropdown Popover */}
            <div className="gp-popover-wrap" ref={ioPopoverRef}>
              <button
                className={`gp-btn ${showIoPopover ? 'on' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowIoPopover(prev => !prev);
                }}
                disabled={loading}
                title={t('dataGrid.ioTitle', 'Import or Export table data')}
              >
                <span>{t('dataGrid.ioBtn', 'Import / Export')}</span>
                <ChevronDown size={11} />
              </button>

              {showIoPopover && (
                <div className="ws-menu gp-io-popover">
                  <button
                    className="gp-io-item"
                    onClick={() => {
                      setShowIoPopover(false);
                      handleImportClick();
                    }}
                  >
                    <FileUp size={13} />
                    <span>{t('dataGrid.importBtn', 'Import')} (CSV, JSON, XLSX, SQL)</span>
                  </button>
                  <button
                    className="gp-io-item"
                    onClick={() => {
                      setShowIoPopover(false);
                      setShowExportDialog(true);
                    }}
                  >
                    <FileDown size={13} />
                    <span>{t('dataGrid.exportBtn', 'Export')} (CSV, JSON, SQL, XLSX)</span>
                  </button>
                </div>
              )}
            </div>

            {/* Quick Search Button */}
            <button
              className={`gp-btn ${showQuickSearch ? 'on' : ''}`}
              onClick={() => {
                setShowQuickSearch(prev => !prev);
                if (!showQuickSearch) {
                  setTimeout(() => quickSearchInputRef.current?.focus(), 50);
                }
              }}
              title={t('dataGrid.quickSearchTitle', 'Quickly search anything in the loaded rows (Ctrl+F)')}
            >
              {t('dataGrid.quickSearchBtn', 'Search')}
            </button>

            {/* Filters Button */}
            <button
              className={`gp-btn ${showFilterBar ? 'on' : ''}`}
              onClick={() => setShowFilterBar(!showFilterBar)}
              title={t('dataGrid.filtersTitle')}
            >
              {t('dataGrid.filtersBtn')}
            </button>

            <div className="gp-pager">
              <button
                className="gp-pager-btn"
                onClick={() => setPage(p => Math.max(p - 1, 1))}
                disabled={page === 1}
                title={t('dataGrid.prevPage')}
              >
                <ChevronLeft size={14} />
              </button>

              <span className="gp-pager-sep" />

              <select
                className="gp-pager-select"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(parseInt(e.target.value));
                  setPage(1);
                }}
                title={t('dataGrid.rowsPerPage')}
              >
                <option value="50">50</option>
                <option value="100">100</option>
                <option value="200">200</option>
              </select>

              <span className="gp-pager-sep" />

              {/* `hasMore` comes from one extra row read in the backend, not from
                  `totalCount / pageSize`: dividing an estimate would disable this button on the wrong
                  page, while this is a fact about the data and holds even with no count at all. */}
              <button
                className="gp-pager-btn"
                onClick={() => setPage(p => p + 1)}
                disabled={!hasMore}
                title={t('dataGrid.nextPage')}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Exporting a table: the options and preview dialog, shared with the Sidebar's context menu */}
      <ExportTableDialog
        connId={connId}
        open={showExportDialog}
        tableName={tableName}
        dbType={dbType}
        grid={{
          columns: columns.map((c) => c.name),
          visibleColumns,
          sortBy,
          sortDir,
          filter: activeFilter,
          // Passed down ONLY when the count is exact. The dialog's `fetchAllRows` loops until
          // `all.length >= total`, so an estimate that is too low writes a truncated file with no
          // error. `null` is the safe answer: the dialog counts exactly itself on its first page read.
          totalCount: countExact ? totalCount : null,
          selectedRows: showExportDialog ? selectedRows() : undefined,
        }}
        onClose={() => setShowExportDialog(false)}
        onSuccess={setSuccessMsg}
        onError={setErrorMsg}
      />

      {/* File picker: states the allowed formats before opening the OS dialog */}
      <ImportFilePicker
        open={showImportPicker}
        targetTable={tableName}
        onCancel={() => setShowImportPicker(false)}
        onConfirm={handleFileImport}
      />

      {showImportModal && (
        <Modal
          title={t('dataGrid.importPreviewTitle', { file: importFileName })}
          onClose={() => setShowImportModal(false)}
          width="720px"
          zIndex={9999}
        >
          <ModalBody style={{ gap: '12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
              {importFileType === 'sql' ? (
                <span>{t('dataGrid.importSqlNote')}</span>
              ) : (
                <span>
                  <Trans
                    i18nKey="dataGrid.importSummary"
                    values={{
                      format: importFileType.toUpperCase(),
                      rows: importPendingRows.length,
                      cols: importFileCols.length,
                      table: tableName,
                    }}
                    components={{ strong: <b />, code: <b style={{ fontFamily: 'monospace' }} /> }}
                  />
                </span>
              )}
            </div>

            {importFileType === 'sql' ? (
              <textarea
                readOnly
                value={importSqlContent.slice(0, 5000) + (importSqlContent.length > 5000 ? t('dataGrid.importTruncated') : '')}
                style={{
                  width: '100%',
                  height: '280px',
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
            ) : (
              <>
                {/* Tabs: structure (the file's columns vs the target table) | data (the first 10 rows) */}
                <div style={{ display: 'flex', gap: '4px' }}>
                  {([
                    { id: 'structure', label: t('dataGrid.importTabStructure', { n: importFileCols.length }) },
                    { id: 'data', label: t('dataGrid.importTabData', { n: importPendingRows.length }) },
                  ] as const).map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setImportTab(tab.id)}
                      style={{
                        padding: '4px 12px',
                        fontSize: '11px',
                        borderRadius: '4px',
                        border: '1px solid var(--win-border)',
                        cursor: 'pointer',
                        background: importTab === tab.id ? 'var(--win-accent)' : 'transparent',
                        color: importTab === tab.id ? '#fff' : 'var(--win-text-secondary)',
                        fontWeight: 600
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {importUnknownCols.length > 0 && (
                  <div style={{
                    fontSize: '11px',
                    color: 'var(--st-warn, #d98600)',
                    background: 'rgba(255,170,0,0.08)',
                    border: '1px solid rgba(255,170,0,0.35)',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    lineHeight: 1.5
                  }}>
                    <Trans
                      i18nKey="dataGrid.importUnknownCols"
                      values={{
                        n: importUnknownCols.length,
                        table: tableName,
                        cols: importUnknownCols.join(', '),
                      }}
                      components={{ code: <b style={{ fontFamily: 'monospace' }} /> }}
                    />
                  </div>
                )}

                <div style={{
                  height: '280px',
                  overflow: 'auto',
                  border: '1px solid var(--win-border)',
                  borderRadius: '4px',
                  background: 'var(--win-bg-window)'
                }}>
                  {importPendingRows.length === 0 ? (
                    <div style={{ padding: '20px', textAlign: 'center', color: 'var(--win-text-disabled)' }}>{t('dataGrid.importNoRows')}</div>
                  ) : importTab === 'structure' ? (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                      <thead>
                        <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                          {[t('dataGrid.colInFile'), t('dataGrid.colInferredType'), t('dataGrid.colInTarget'), t('dataGrid.colTargetType')].map(h => (
                            <th key={h} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderRight: '1px solid var(--win-border)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {importFileCols.map(col => {
                          const target = columns.find(c => c.name.toLowerCase() === col.toLowerCase());
                          return (
                            <tr key={col} style={{ borderBottom: '1px solid var(--win-border)' }}>
                              <td style={{ padding: '6px 8px', borderRight: '1px solid var(--win-border)', fontFamily: 'monospace', color: 'var(--win-text-primary)' }}>{col}</td>
                              <td style={{ padding: '6px 8px', borderRight: '1px solid var(--win-border)', color: 'var(--win-text-secondary)' }}>{inferColType(importPendingRows, col)}</td>
                              <td style={{ padding: '6px 8px', borderRight: '1px solid var(--win-border)', color: target ? 'var(--win-text-primary)' : 'var(--st-warn, #d98600)' }}>
                                {target ? target.name : t('dataGrid.colMissing')}
                              </td>
                              <td style={{ padding: '6px 8px', color: 'var(--win-text-secondary)', fontFamily: 'monospace' }}>{target?.type || '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                      <thead>
                        <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                          {importFileCols.map(col => (
                            <th key={col} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderRight: '1px solid var(--win-border)' }}>
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {importPendingRows.slice(0, 10).map((row, rIdx) => (
                          <tr key={rIdx} style={{ borderBottom: '1px solid var(--win-border)' }}>
                            {importFileCols.map(col => (
                              <td key={col} style={{ padding: '6px 8px', color: 'var(--win-text-primary)', borderRight: '1px solid var(--win-border)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '180px' }}>
                                {row[col] === null || row[col] === undefined
                                  ? <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>NULL</span>
                                  : String(row[col])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            )}
          </ModalBody>

          <ModalFooter>
            <button
              className="btn btn-secondary"
              onClick={() => setShowImportModal(false)}
              style={{ padding: '0 12px' }}
            >
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary"
              onClick={confirmImport}
              style={{ padding: '0 16px', background: 'var(--win-accent)', color: '#fff', border: 'none' }}
            >
              {t('dataGrid.confirmImport')}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {/* ─── Right-Click Context Menu ─── */}
      {contextMenu && (
        <div
          ref={cellMenuRef}
          onClick={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            // The position is adjusted to the menu's real size (it used to assume a fixed 320/230, so
            // a long menu was still clipped at the bottom of the window).
            top: cellMenuPos ? cellMenuPos.top : contextMenu.y,
            left: cellMenuPos ? cellMenuPos.left : contextMenu.x,
            visibility: cellMenuPos ? 'visible' : 'hidden',
            zIndex: 99999,
            background: 'var(--win-bg-popover, #ffffff)',
            border: '1px solid var(--win-border-strong)',
            borderRadius: '8px',
            boxShadow: '0 10px 30px rgba(0, 0, 0, 0.25), 0 2px 8px rgba(0, 0, 0, 0.15)',
            padding: '4px 0',
            minWidth: '220px',
            fontSize: '12px',
          }}
        >
          {/* Row actions */}
          <div style={{ padding: '2px 8px 4px', color: 'var(--win-text-disabled)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('dataGrid.ctxRow')}</div>
          <button className="context-menu-item" onClick={() => {
            const cm = contextMenu;
            setContextMenu(null);
            const rowIdx = rows.findIndex((r, idx) => (r[primaryKey] !== undefined && r[primaryKey] !== null ? r[primaryKey] : `__idx_${idx}`) === cm.rowId);
            if (rowIdx >= 0) {
              setDocumentViewerIndex(rowIdx);
            }
          }}>
            <span>📑</span> {t('dataGrid.ctxViewDocument', 'Xem chi tiết dòng (Document Viewer)')}
          </button>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); handleDuplicateRow(contextMenu.row); }}>
            <span>📋</span> {t('dataGrid.ctxDuplicate')}
          </button>
          <button className="context-menu-item" style={{ color: 'var(--st-danger)' }} onClick={() => { setContextMenu(null); handleDeleteRow(contextMenu.rowId); }}>
            <span>🗑</span> {t('dataGrid.ctxDeleteRow')}
          </button>

          <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />

          {/* Sort actions */}
          <div style={{ padding: '2px 8px 4px', color: 'var(--win-text-disabled)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('dataGrid.ctxSortBy', { col: contextMenu.colName })}</div>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); setSortBy(contextMenu.colName); setSortDir('asc'); setPage(1); }}>
            <span>↑</span> {t('dataGrid.ctxAsc')}
          </button>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); setSortBy(contextMenu.colName); setSortDir('desc'); setPage(1); }}>
            <span>↓</span> {t('dataGrid.ctxDesc')}
          </button>

          <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />

          {/* Copy cell */}
          <div style={{ padding: '2px 8px 4px', color: 'var(--win-text-disabled)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('dataGrid.ctxCell', { col: contextMenu.colName })}</div>
          <button className="context-menu-item" onClick={() => {
            const cm = contextMenu;
            setContextMenu(null);
            startEdit(cm.rowId, cm.colName, cm.cellValue);
          }}>
            <span>✏️</span> {t('dataGrid.ctxEditCell')}
          </button>
          <button className="context-menu-item" onClick={() => {
            setContextMenu(null);
            copyToClipboard(contextMenu.cellValue === null ? '' : String(contextMenu.cellValue));
            setSuccessMsg(t('dataGrid.copiedCell')); setTimeout(() => setSuccessMsg(null), 2000);
          }}>
            <span>📄</span> {t('dataGrid.ctxCopyCell')}
          </button>
          <button className="context-menu-item" onClick={() => {
            setContextMenu(null);
            const allVals = rows.map(r => r[contextMenu.colName]).filter(v => v !== null && v !== undefined).join('\n');
            copyToClipboard(allVals);
            setSuccessMsg(t('dataGrid.copiedColumn')); setTimeout(() => setSuccessMsg(null), 2000);
          }}>
            <span>📋</span> {t('dataGrid.ctxCopyColumn')}
          </button>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); setQuickLookCell({ colName: contextMenu.colName, value: contextMenu.cellValue }); }}>
            <span>🔍</span> {t('dataGrid.ctxQuickLook')}
          </button>
          {(() => {
            const media = detectMedia(contextMenu.cellValue, contextMenu.colName);
            if (media) {
              return (
                <button
                  className="context-menu-item"
                  onClick={() => {
                    const cm = contextMenu;
                    setContextMenu(null);
                    setMediaViewerTarget({
                      media,
                      colName: cm.colName,
                      tableName,
                    });
                  }}
                >
                  <span>🖼️</span> {t('dataGrid.ctxViewImage', 'Xem ảnh (Media Viewer)')}
                </button>
              );
            }
            return null;
          })()}
          {(() => {
            const fk = getFkInfo(contextMenu.colName);
            if (fk && contextMenu.cellValue !== null && contextMenu.cellValue !== undefined && contextMenu.cellValue !== '') {
              return (
                <button
                  className="context-menu-item"
                  onClick={() => {
                    const cm = contextMenu;
                    setContextMenu(null);
                    handleFkClick(cm.colName, cm.cellValue);
                  }}
                >
                  <span>🔗</span> {t('dataGrid.ctxGoToFk', { table: fk.refTable, defaultValue: `Mở bảng ${fk.refTable} (${fk.refColumn} = ${contextMenu.cellValue})` })}
                </button>
              );
            }
            return null;
          })()}

          <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />

          {/* Copy row */}
          <div style={{ padding: '2px 8px 4px', color: 'var(--win-text-disabled)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{selectedRowIds.size > 1 ? t('dataGrid.ctxCopyRowsAs', { n: selectedRowIds.size }) : t('dataGrid.ctxCopyRowAs')}</div>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); copyRowAsCSV(contextMenu.row, false); }}>
            <span>📊</span> CSV
          </button>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); copyRowAsCSV(contextMenu.row, true); }}>
            <span>📊</span> {t('dataGrid.ctxCsvHeader')}
          </button>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); copyRowAsSQL(contextMenu.row); }}>
            <span>🗄</span> SQL INSERT
          </button>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); copyRowAsMarkdown(contextMenu.row); }}>
            <span>📝</span> Markdown Table
          </button>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); copyRowAsJson(contextMenu.row); }}>
            <span>📦</span> {t('dataGrid.ctxJsonArray')}
          </button>
        </div>
      )}

      {/* ─── Quick Look Modal ─── */}
      {quickLookCell && (
        <Modal
          title={<>{t('dataGrid.quickLook')} — <span style={{ color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{quickLookCell.colName}</span></>}
          onClose={() => setQuickLookCell(null)}
          width="700px"
          maxHeight="70vh"
          zIndex={99998}
        >
          <ModalBody style={{ gap: 0, flex: 1, background: 'var(--win-bg-window)', fontFamily: 'var(--win-font-mono)', fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {quickLookCell.value === null
              ? <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>NULL</span>
              : String(quickLookCell.value)
            }
          </ModalBody>
          <ModalFooter>
            <button className="btn btn-secondary" onClick={() => { copyToClipboard(quickLookCell.value === null ? '' : String(quickLookCell.value)); }}>{t('common.copy')}</button>
            <button className="btn btn-primary" style={{ background: 'var(--st-ok)', borderColor: 'var(--st-ok)' }} onClick={() => setQuickLookCell(null)}>{t('common.close')}</button>
          </ModalFooter>
        </Modal>
      )}

      {/* ─── Media / Image Viewer Modal (from Context Menu or Click) ─── */}
      {mediaViewerTarget && typeof document !== 'undefined' && ReactDOM.createPortal(
        <MediaViewerModal
          isOpen={!!mediaViewerTarget}
          onClose={() => setMediaViewerTarget(null)}
          media={mediaViewerTarget.media}
          columnName={mediaViewerTarget.colName}
          tableName={mediaViewerTarget.tableName}
        />,
        document.body
      )}

      {/* ─── The transaction preview modal (the SQL, before committing) ─── */}
      {commitPreview && (
        <Modal
          title={t('dataGrid.commitPreviewTitle', { n: commitPreview.length })}
          onClose={() => { setCommitPreview(null); setPendingChanges([]); }}
          width="640px"
          maxWidth="92%"
          maxHeight="80vh"
          zIndex={99999}
        >
          <ModalBody style={{ padding: '16px', gap: 0, background: 'var(--win-bg-window)', fontFamily: 'var(--win-font-mono)', fontSize: '12px', color: 'var(--win-text-primary)', flex: 1 }}>
            {commitPreview.length === 0 ? (
              <div style={{ color: 'var(--win-text-disabled)' }}>{t('dataGrid.commitPreviewEmpty')}</div>
            ) : (
              commitPreview.map((sql, idx) => (
                <pre key={idx} style={{ margin: '0 0 10px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', paddingBottom: '8px', borderBottom: idx < commitPreview.length - 1 ? '1px dashed var(--win-border)' : 'none' }}>
                  {sql};
                </pre>
              ))
            )}
          </ModalBody>
          <ModalFooter>
            {/* The switch sits right here because this is the moment it feels intrusive. It takes
                effect from the NEXT save (this dialog is already open), and can be turned back on in
                the Safe Mode popover — the label says where, because a "do not show again" with no way
                back is a trap. */}
            <label
              style={{
                display: 'flex', alignItems: 'center', gap: '8px', marginRight: 'auto',
                fontSize: '11px', color: 'var(--win-text-secondary)', cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={!getCommitPreviewForKey(connKeyOfConn(connId))}
                onChange={(e) => {
                  setCommitPreviewForKey(connKeyOfConn(connId), !e.target.checked);
                  setPreviewOptOutTick((v) => v + 1);
                }}
              />
              <span>{t('dataGrid.commitPreviewSkip')}</span>
            </label>
            <button className="btn btn-secondary" onClick={() => { setCommitPreview(null); setPendingChanges([]); }} disabled={loading}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleConfirmCommit} disabled={loading || commitPreview.length === 0} style={{ background: 'var(--st-ok)', borderColor: 'var(--st-ok)' }}>
              {loading ? t('dataGrid.commitRunning') : t('dataGrid.commitConfirm')}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {/* ─── Studio 3T / TablePlus Style Document / Row Viewer Modal ─── */}
      {documentViewerIndex !== null && (
        <React.Suspense fallback={<LazyModalFallback />}>
          <RowDocumentModal
            isOpen={documentViewerIndex !== null}
            onClose={() => setDocumentViewerIndex(null)}
            tableName={tableName}
            primaryKey={primaryKey}
            rowIndex={documentViewerIndex}
            rows={rows}
            columns={columns}
            foreignKeys={schema?.foreignKeys}
            onNavigateRow={(newIdx) => setDocumentViewerIndex(newIdx)}
          />
        </React.Suspense>
      )}
    </div>
  );
};
