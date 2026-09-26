import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { GridContextMenu, MenuHeading, MenuItem, MenuSeparator, MenuSub } from './GridContextMenu';
import { ColumnStatsDialog, TransposeDialog, ValueEditorDialog } from './GridToolDialogs';
import { resolveRowClick, resolveRowContextMenu } from '../utils/rowSelection';
import { countKey, nextCountMode, seekColumn, seekViewKey } from '../utils/gridPaging';
import { getCommitPreviewForKey, setCommitPreviewForKey } from '../utils/commitPreview';
import { connKeyOfConn } from '../utils/safeMode';
import {
  buildCsvRows,
  buildInList,
  buildInsertStatements,
  buildJsonValues,
  buildMarkdownTable,
  buildTsv,
  buildUpdateStatements,
  updateRefusalMessage,
} from '../utils/copyAs';
import { dbHelper } from '../utils/dbHelper';
import type { SchemaInfo, ColumnInfo, GridChange } from '../utils/dbHelper';
import {
  Save, RotateCcw, Plus, ChevronLeft, ChevronRight,
  CheckCircle2, AlertTriangle, Minus, Copy, Calendar, ArrowUpRight,
  Search, X, ChevronDown, FileUp, FileDown, BarChart2, Sliders
} from 'lucide-react';
import { StructureViewer } from './StructureViewer';
import { ProgressBar, type ProgressState } from './ProgressBar';
import { ImportFilePicker } from './ImportFilePicker';
import { ExportTableDialog } from './ExportTableDialog';
import { ImportTableDataDialog } from './ImportTableDataDialog';
import ReactDOM from 'react-dom';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { LazyModalFallback } from './LazyEditorFallback';
import { MediaCellPreview, MediaViewerModal, detectMedia, type MediaInfo } from './media';
import { DataVisualizer } from './chart';
import { TablePropertiesView } from './TablePropertiesView';
import { SearchHighlight } from './SearchHighlight';
import { rowMatchesQuery } from '../utils/gridSearch';

// Lazy because `RowDocumentModal` has a JSON tab built on `@monaco-editor/react`: a static import
// here is a static path from the entry to Monaco, and it undoes the `React.lazy` of `SqlEditor` and
// the Redis `Console` as well — the 4MB Monaco chunk goes back to being a `modulepreload` at
// startup. See CLAUDE.md, the Build/config section. Verify with `dist/index.html` after
// `npm run build-frontend`.
const RowDocumentModal = React.lazy(() =>
  import('./RowDocumentModal').then((m) => ({ default: m.RowDocumentModal })));

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
      style={{ stroke: 'var(--win-border-strong)' }}
      strokeWidth="3"
      opacity="0.2"
    />
    <path
      d="M12 2C6.47715 2 2 6.47715 2 12C2 13.5683 2.36155 15.0506 3.00769 16.3718"
      style={{ stroke: 'var(--win-accent)' }}
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
  const [selectedRowIds, setSelectedRowIds] = useState<ReadonlySet<any>>(new Set());
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

  // The tools the context menu opens (GridToolDialogs.tsx). The value editor replaced Quick Look:
  // same entry point, but it formats JSON and can write the value back into the edit buffer.
  const [valueEditor, setValueEditor] = useState<{ rowId: any; colName: string; value: any; editable: boolean; reason?: string } | null>(null);
  const [statsTarget, setStatsTarget] = useState<{ column: string; values: unknown[]; scope: string; note?: string } | null>(null);
  const [transposeTarget, setTransposeTarget] = useState<any[] | null>(null);
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
  /**
   * Column widths measured when quick search opens, so filtering cannot move them.
   *
   * `.grid-table` is `table-layout: auto`: a column is as wide as the widest cell CURRENTLY
   * RENDERED, so hiding rows re-lays out the grid on every keystroke and the columns jump under the
   * text being typed. Filtering only removes rows, so the widths taken before the first keystroke
   * are the widest this row set can need — freezing them can leave a column roomier than its
   * content, never clip it. Carried with the `of` array so a refetch (paging is server-side here)
   * drops them without an effect to do the invalidating. SqlEditor's result grid does the same.
   */
  const [frozenCols, setFrozenCols] = useState<{ of: any[]; widths: number[] } | null>(null);
  const gridTableRef = useRef<HTMLTableElement>(null);

  // Import & Export Combined Popover State
  const [showIoPopover, setShowIoPopover] = useState(false);
  const ioPopoverRef = useRef<HTMLDivElement>(null);

  // Export state — every option and the preview live in ExportTableDialog
  const [showExportDialog, setShowExportDialog] = useState(false);

  // Import Preview State
  const [importProgress, setImportProgress] = useState<ProgressState | null>(null);
  const [showImportPicker, setShowImportPicker] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFileName, setImportFileName] = useState('');
  const [importSqlContent, setImportSqlContent] = useState('');

  const handleImportClick = () => {
    setShowImportPicker(true);
  };

  // A CSV / Excel / JSON file for THIS table goes to the mapping dialog (`ImportTableDataDialog`),
  // which converts and checks every row and imports in one transaction. A .sql file is statements
  // rather than rows, so it keeps the run-the-script path below.
  const [importDialogFile, setImportDialogFile] = useState<File | null>(null);

  // Takes the file from ImportFilePicker (which already checked the extension) and parses it for the preview.
  const handleFileImport = async (file: File) => {
    setShowImportPicker(false);
    if (!file.name.toLowerCase().endsWith('.sql')) {
      setImportDialogFile(file);
      return;
    }
    setImportFileName(file.name);
    setErrorMsg(null);
    setSuccessMsg(null);

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target?.result as string;

        setImportSqlContent(text);
        setShowImportModal(true);
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
    setImportProgress({ label: t('dataGrid.importRunningSql') });

    try {
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
        openQuickSearchBar();
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
    applyCellValue(rowId, colName, editValue);
    setEditingCell(null);
  };

  /**
   * Puts one cell's new value into the edit buffer. Shared by the inline editor and the value
   * editor, so a value applied from either one is dirty-tracked, undone and saved the same way.
   */
  const applyCellValue = (rowId: any, colName: string, nextValue: any) => {
    // Check if cell changed from original
    const isTemp = String(rowId).startsWith('temp_');

    if (isTemp) {
      // Modify the inserts array (identified by __tempId, not by the PK column, since the PK may itself be edited)
      setInserts(prev =>
        prev.map(row => {
          if (row.__tempId === rowId) {
            return { ...row, [colName]: nextValue };
          }
          return row;
        })
      );
    } else {
      // Find original row
      const originalRow = rows.find(r => r[primaryKey] === rowId);
      const originalVal = originalRow ? originalRow[colName] : undefined;

      if (String(originalVal) !== String(nextValue)) {
        setUpdates(prev => {
          const rowUpdates = prev[rowId] || {};
          return {
            ...prev,
            [rowId]: {
              ...rowUpdates,
              [colName]: nextValue
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

  const copyRowAsCSV = (row: any, withHeader: boolean) => {
    const cols = activeColumns.map(c => c.name);
    copyToClipboard(buildCsvRows(cols, rowsToCopy(row), withHeader));
    setSuccessMsg(t('dataGrid.copiedRowCsv'));
    setTimeout(() => setSuccessMsg(null), 2000);
  };

  const copyRowAsSQL = (row: any) => {
    const cols = activeColumns.map(c => c.name);
    copyToClipboard(buildInsertStatements(tableName, cols, rowsToCopy(row), dbType));
    setSuccessMsg(t('dataGrid.copiedRowSql'));
    setTimeout(() => setSuccessMsg(null), 2000);
  };

  /**
   * The columns an UPDATE is keyed on: every column the schema marks as part of the primary
   * key, falling back to the name the backend reported when none of them is flagged.
   */
  const keyColumns = (): string[] => {
    const flagged = columns.filter(c => c.isPrimaryKey).map(c => c.name);
    if (flagged.length > 0) return flagged;
    return columns.some(c => c.name === primaryKey) ? [primaryKey] : [];
  };

  const copyRowAsUpdate = (row: any) => {
    const keys = keyColumns();
    // The key goes into the column list even when it is hidden: it is what the WHERE needs,
    // and `buildUpdateStatements` leaves it out of the SET either way.
    const cols = activeColumns.map(c => c.name);
    const withKeys = [...cols, ...keys.filter(k => !cols.includes(k))];
    const generated = new Set(columns.filter(c => c.generated).map(c => c.name));
    const result = buildUpdateStatements(
      tableName,
      withKeys,
      rowsToCopy(row),
      dbType,
      keys,
      generated,
    );
    if (result.refused) {
      setErrorMsg(updateRefusalMessage(result.refused));
      return;
    }
    copyToClipboard(result.sql);
    setSuccessMsg(t('dataGrid.copiedRowUpdate'));
    setTimeout(() => setSuccessMsg(null), 2000);
  };

  /**
   * One column as a parenthesised value list, to paste after somebody else's `IN`.
   *
   * The SCOPE is a parameter rather than something guessed from the selection, and that is a
   * correction: `selectForContextMenu` leaves at least the clicked row selected, so "is there
   * a selection" is always true and any threshold on its size reads as arbitrary. Right-
   * clicking outside a multi-row selection collapses it to one row, and the copy then
   * silently switched from the rows to the whole column. Two menu entries, each saying which
   * it is, and neither can surprise anyone.
   *
   * The column scope reads `displayedRows`, not `rows`: a quick search that hides half the
   * table must not copy the hidden half.
   */
  const copyAsInList = (colName: string, row: any, scope: 'rows' | 'column') => {
    const source = scope === 'rows' ? rowsToCopy(row) : displayedRows;
    const result = buildInList(source.map(r => r[colName]), dbType);
    if (result.count === 0) {
      setErrorMsg(t('dataGrid.copyInListEmpty'));
      return;
    }
    copyToClipboard(result.sql);
    const skipped = result.nullsDropped + result.duplicatesDropped;
    setSuccessMsg(
      skipped > 0
        ? t('dataGrid.copiedInListTrimmed', { n: result.count, skipped })
        : t('dataGrid.copiedInList', { n: result.count }),
    );
    setTimeout(() => setSuccessMsg(null), 2500);
  };

  const copyRowAsTsv = (row: any) => {
    const cols = activeColumns.map(c => c.name);
    // With the header, unlike Ctrl+C: that one goes into a sheet that already has one, and
    // this is picked from a menu deliberately.
    copyToClipboard(buildTsv(cols, rowsToCopy(row), true));
    setSuccessMsg(t('dataGrid.copiedRowsTsv', { n: rowsToCopy(row).length }));
    setTimeout(() => setSuccessMsg(null), 2000);
  };

  const copyRowAsJsonValues = (row: any) => {
    const cols = activeColumns.map(c => c.name);
    copyToClipboard(buildJsonValues(cols, rowsToCopy(row)));
    setSuccessMsg(t('dataGrid.copiedRowJsonValues'));
    setTimeout(() => setSuccessMsg(null), 2000);
  };

  const copyRowAsMarkdown = (row: any) => {
    const cols = activeColumns.map(c => c.name);
    copyToClipboard(buildMarkdownTable(cols, rowsToCopy(row)));
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

  /**
   * The two doors into quick search (Ctrl+F and the toolbar button) and the three out of it (Esc,
   * the bar's ×, the toolbar button again) all go through these, because the width measurement has
   * to happen on EVERY open — a door that skips it is a door that still lets the columns jump.
   */
  const openQuickSearchBar = () => {
    // Read against the unfiltered grid, before the bar renders. Once per open, never per keystroke.
    const heads = gridTableRef.current ? Array.from(gridTableRef.current.querySelectorAll('thead th')) : [];
    if (heads.length > 0) {
      setFrozenCols({ of: rows, widths: heads.map(th => Math.round(th.getBoundingClientRect().width)) });
    }
    setShowQuickSearch(true);
  };

  const closeQuickSearchBar = () => {
    setShowQuickSearch(false);
    setQuickSearchQuery('');
    // Back to the browser's own sizing: with every row on screen again, the measurements are only a
    // stale copy of what auto layout is about to compute anyway.
    setFrozenCols(null);
  };

  const activeColumns = columns.filter(c => visibleColumns.includes(c.name));
  const frozenColWidths = showQuickSearch && frozenCols?.of === rows ? frozenCols.widths : null;

  // Matching and the match's position live in `utils/gridSearch.ts`, shared with SqlEditor's result
  // grid. What stays here is the one part that is this grid's own: searching a row by its BUFFERED
  // edits rather than by what the database returned, so a row the user has just typed into does not
  // vanish from their own filter.
  const rowMatchesSearch = useCallback(
    (row: any, query: string, rowUpdates: any = {}) =>
      rowMatchesQuery(row, activeColumns.map(c => c.name), query, rowUpdates),
    [activeColumns],
  );

  // The old body sliced the ORIGINAL string with an index found in the NFD-NORMALIZED one. Those
  // two are not the same length — NFD splits `ễ` into a letter plus a combining mark that the strip
  // then removes — so on any text with diacritics the highlight landed a few characters off, further
  // off with every mark before it. `findMatchRange` maps the index back; see `gridSearch.ts`.
  const renderCellWithHighlight = (cellVal: any, query: string): React.ReactNode => {
    if (cellVal === null || cellVal === undefined || cellVal === '') return cellVal;
    if (!query.trim()) return String(cellVal);
    return <SearchHighlight text={String(cellVal)} query={query} />;
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
   * One click on a row. Which rows that leaves selected is decided by `resolveRowClick` in
   * `utils/rowSelection.ts`, shared with the SQL editor's result grid -- the two grids agree on
   * nothing underneath (see that file) but must agree on this, because a gesture that works in
   * one and not the other reads as a bug rather than as two features.
   */
  const handleRowClick = useCallback(
    (key: any, e: React.MouseEvent) => {
      // Shift+Click also extends the BROWSER's text selection across every row it spans. Left alone
      // that highlight looks wrong AND breaks Ctrl+C, which stands aside whenever text is selected
      // so that copying a highlighted cell value still works.
      if (e.shiftKey) window.getSelection()?.removeAllRanges();
      const next = resolveRowClick(
        orderedRowKeys,
        { rows: selectedRowIds, anchor: anchorRowId },
        key,
        { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey },
      );
      setSelectedRowIds(next.rows);
      setAnchorRowId(next.anchor);
    },
    [anchorRowId, orderedRowKeys, selectedRowIds],
  );

  /** Keeps a selection the right-clicked row belongs to — see `resolveRowContextMenu`. */
  const selectForContextMenu = useCallback(
    (key: any) => {
      // Read through the updater rather than from state: this runs from a contextmenu handler that
      // may fire before a pending selection change has been applied, and the kept set is returned
      // by reference so an unchanged selection still costs no render.
      setSelectedRowIds(prev => resolveRowContextMenu({ rows: prev, anchor: key }, key).rows);
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
                      closeQuickSearchBar();
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
            <span className="grid-quick-search-kbd">{t('dataGrid.quickSearchEscKey')}</span>
            <button
              className="grid-quick-search-btn-close"
              onClick={closeQuickSearchBar}
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
            <table className="grid-table" ref={gridTableRef}>
              {/* Only while quick search is open — see `frozenCols`. `<col>` sets a whole column's
                  width without touching a single cell, and it lines up 1:1 with the header cells
                  below. Keyed by position because a column IS its position here. */}
              {frozenColWidths && (
                <colgroup>
                  {frozenColWidths.map((w, i) => (
                    <col key={i} style={{ width: `${w}px` }} />
                  ))}
                </colgroup>
              )}
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
                if (showQuickSearch) closeQuickSearchBar();
                else {
                  openQuickSearchBar();
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
      />

      {importDialogFile && (
        <ImportTableDataDialog
          connId={connId}
          tableName={tableName}
          tableSchema={tableSchema}
          file={importDialogFile}
          onClose={() => setImportDialogFile(null)}
        />
      )}

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
              <span>{t('dataGrid.importSqlNote')}</span>
            </div>

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

      {/* ─── Right-Click Context Menu ───
          Cell → column → row, most-used first. The ten copy formats sit behind "Copy as ▸": as a
          flat list they were half the menu and pushed Edit / Delete out of reach. */}
      {contextMenu && (() => {
        const cm = contextMenu;
        const nSel = selectedRowIds.size;
        const media = detectMedia(cm.cellValue, cm.colName);
        const fk = getFkInfo(cm.colName);
        const hasFkValue = !!fk && cm.cellValue !== null && cm.cellValue !== undefined && cm.cellValue !== '';
        // A row without a primary key is keyed by its position (`__idx_<n>`), and an UPDATE for it
        // would have nothing to put in its WHERE — so the value editor opens read-only there.
        const hasKey = String(cm.rowId).startsWith('temp_') || !String(cm.rowId).startsWith('__idx_');
        const statsOnSelection = nSel > 1;
        return (
          <GridContextMenu x={cm.x} y={cm.y} onClose={() => setContextMenu(null)}>
            <MenuHeading>{t('dataGrid.ctxCell', { col: cm.colName })}</MenuHeading>
            {!readOnly && (
              <MenuItem icon="✏️" label={t('dataGrid.ctxEditCell')} onSelect={() => startEdit(cm.rowId, cm.colName, cm.cellValue)} />
            )}
            <MenuItem
              icon="📝"
              label={t('gridTools.openValueEditor')}
              onSelect={() => setValueEditor({
                rowId: cm.rowId,
                colName: cm.colName,
                value: cm.cellValue,
                editable: !readOnly && hasKey,
                reason: readOnly ? t('gridTools.editorReadOnly') : !hasKey ? t('gridTools.editorNoKey') : undefined,
              })}
            />
            <MenuItem
              icon="📄"
              label={t('dataGrid.ctxCopyCell')}
              onSelect={() => {
                copyToClipboard(cm.cellValue === null ? '' : String(cm.cellValue));
                setSuccessMsg(t('dataGrid.copiedCell')); setTimeout(() => setSuccessMsg(null), 2000);
              }}
            />
            {hasFkValue && fk && (
              <MenuItem
                icon="🔗"
                label={t('dataGrid.ctxGoToFk', { table: fk.refTable, defaultValue: `Mở bảng ${fk.refTable} (${fk.refColumn} = ${cm.cellValue})` })}
                onSelect={() => handleFkClick(cm.colName, cm.cellValue)}
              />
            )}
            {media && (
              <MenuItem
                icon="🖼️"
                label={t('dataGrid.ctxViewImage', 'Xem ảnh (Media Viewer)')}
                onSelect={() => setMediaViewerTarget({ media, colName: cm.colName, tableName })}
              />
            )}

            <MenuHeading>{t('gridTools.columnHeading', { col: cm.colName })}</MenuHeading>
            <MenuItem icon="↑" label={t('dataGrid.ctxAsc')} onSelect={() => { setSortBy(cm.colName); setSortDir('asc'); setPage(1); }} />
            <MenuItem icon="↓" label={t('dataGrid.ctxDesc')} onSelect={() => { setSortBy(cm.colName); setSortDir('desc'); setPage(1); }} />
            <MenuItem
              icon="Σ"
              label={t('gridTools.columnStats')}
              onSelect={() => {
                const source = statsOnSelection ? selectedRows() : displayedRows;
                setStatsTarget({
                  column: cm.colName,
                  values: source.map(r => r[cm.colName]),
                  scope: statsOnSelection
                    ? t('gridTools.scopeSelected', { n: source.length })
                    : t('gridTools.scopePage', { n: source.length }),
                  note: statsOnSelection ? undefined : t('gridTools.statsPageNote'),
                });
              }}
            />
            <MenuSub icon="📋" label={t('gridTools.copyColumn')}>
              <MenuItem
                icon="📋"
                label={t('gridTools.columnValuesPage')}
                onSelect={() => {
                  const allVals = displayedRows.map(r => r[cm.colName]).filter(v => v !== null && v !== undefined).join('\n');
                  copyToClipboard(allVals);
                  setSuccessMsg(t('dataGrid.copiedColumn')); setTimeout(() => setSuccessMsg(null), 2000);
                }}
              />
              <MenuItem icon="🔢" label={t('dataGrid.ctxCopyInListColumn')} onSelect={() => copyAsInList(cm.colName, cm.row, 'column')} />
              <MenuItem icon="🔢" label={t('dataGrid.ctxCopyInListRows', { col: cm.colName })} onSelect={() => copyAsInList(cm.colName, cm.row, 'rows')} />
            </MenuSub>

            <MenuHeading>{nSel > 1 ? t('gridTools.rowsHeading', { n: nSel }) : t('gridTools.rowHeading')}</MenuHeading>
            {nSel <= 1 && (
              <MenuItem
                icon="📑"
                label={t('dataGrid.ctxViewDocument', 'Xem chi tiết dòng (Document Viewer)')}
                hint="Space"
                onSelect={() => {
                  const rowIdx = rows.findIndex((r, idx) => (r[primaryKey] !== undefined && r[primaryKey] !== null ? r[primaryKey] : `__idx_${idx}`) === cm.rowId);
                  if (rowIdx >= 0) setDocumentViewerIndex(rowIdx);
                }}
              />
            )}
            <MenuItem
              icon="⇄"
              label={nSel > 1 ? t('gridTools.transposeN', { n: nSel }) : t('gridTools.transpose')}
              onSelect={() => setTransposeTarget(rowsToCopy(cm.row))}
            />
            <MenuSub icon="📋" label={t('gridTools.copyAs')}>
              <MenuItem icon="📋" label={t('dataGrid.ctxCopyTsv')} onSelect={() => copyRowAsTsv(cm.row)} />
              <MenuItem icon="📊" label="CSV" onSelect={() => copyRowAsCSV(cm.row, false)} />
              <MenuItem icon="📊" label={t('dataGrid.ctxCsvHeader')} onSelect={() => copyRowAsCSV(cm.row, true)} />
              <MenuItem icon="🗄" label="SQL INSERT" onSelect={() => copyRowAsSQL(cm.row)} />
              <MenuItem icon="✏️" label={t('dataGrid.ctxCopySqlUpdate')} onSelect={() => copyRowAsUpdate(cm.row)} />
              <MenuItem icon="📝" label="Markdown Table" onSelect={() => copyRowAsMarkdown(cm.row)} />
              <MenuItem icon="📦" label={t('dataGrid.ctxJsonObjects')} onSelect={() => copyRowAsJson(cm.row)} />
              <MenuItem icon="📦" label={t('dataGrid.ctxJsonValues')} onSelect={() => copyRowAsJsonValues(cm.row)} />
            </MenuSub>
            {!readOnly && (
              <>
                <MenuItem icon="⧉" label={t('dataGrid.ctxDuplicate')} onSelect={() => handleDuplicateRow(cm.row)} />
                <MenuSeparator />
                {/* Names the clicked row, as it always has — the Delete KEY acts on the whole
                    selection, so its hint is only shown when the two agree. */}
                <MenuItem icon="🗑" danger label={t('dataGrid.ctxDeleteRow')} hint={nSel <= 1 ? 'Del' : undefined} onSelect={() => handleDeleteRow(cm.rowId)} />
              </>
            )}
          </GridContextMenu>
        );
      })()}

      {valueEditor && (
        <ValueEditorDialog
          column={valueEditor.colName}
          value={valueEditor.value}
          onApply={valueEditor.editable ? (text) => applyCellValue(valueEditor.rowId, valueEditor.colName, text) : undefined}
          readOnlyReason={valueEditor.reason}
          onClose={() => setValueEditor(null)}
        />
      )}
      {statsTarget && (
        <ColumnStatsDialog
          column={statsTarget.column}
          values={statsTarget.values}
          scope={statsTarget.scope}
          note={statsTarget.note}
          onClose={() => setStatsTarget(null)}
        />
      )}
      {transposeTarget && (
        <TransposeDialog
          columns={activeColumns.map(c => c.name)}
          rows={transposeTarget}
          onClose={() => setTransposeTarget(null)}
        />
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
