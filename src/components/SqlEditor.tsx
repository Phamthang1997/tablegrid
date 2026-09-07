import React, { useState, useRef, useEffect } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import * as monaco from 'monaco-editor';
import Editor from '@monaco-editor/react';

// Worker factory + loader binding, shared with the Redis console (see the module's header).
import '../sql/monacoSetup';
import { setupSqlCompletion, langIdForDbType, LANG_IDS } from '../sql/sqlLanguage';
import { setupSqlHover, findTable, openTableTab } from '../sql/intellisense';
import { defineSqlThemes, sqlThemeName } from '../sql/theme';
import { SQL_EDITOR_OPTIONS } from '../sql/editorOptions';
import { formatSql, minifySql } from '../sql/format';
import { attachEditorInspection } from '../sql/inspection';
import { registerSqlRenameProvider } from '../sql/refactor';
import { registerSqlQuickFix } from '../sql/quickFix';
import { registerSqlSignatureHelp } from '../sql/signatureHelp';
import { registerSqlPeekDefinition } from '../sql/peekDefinition';
import { registerSqlOutline } from '../sql/outline';
import {
  statementAt, analyzeStatements, splitStatements, isSchemaChangingSql, applyLimitToSql,
  findUnsafeStatements, type UnsafeStatement, type UnsafeStatementKind,
} from '../sql/statements';
import * as catalog from '../sql/catalog';
import { willPromptForSql } from '../utils/safeMode';
import { resolveResultEditability, type ResultEditability, type NotEditableReason } from '../sql/editableResult';
import { SqlSnippetPanel } from './SqlSnippetPanel';
import { MediaCellPreview } from './media';
import { DataVisualizer } from './chart';

// Registers smart completion + hover + theme + rename provider (shared, run once)
setupSqlCompletion();
setupSqlHover();
defineSqlThemes();
registerSqlRenameProvider(monaco);
registerSqlQuickFix(monaco);
registerSqlSignatureHelp(monaco);
registerSqlPeekDefinition(monaco);
registerSqlOutline(monaco);
import { setEditorConnId } from '../sql/editorScope';
import { dbIndexRegistry } from '../sql/dbIndexRegistry';
import { dbHelper, type GridChange } from '../utils/dbHelper';

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

// Registers the format provider (Shift+Alt+F / Format Document) for ALL three dialects, including
// the 'genericsql' one SQLite uses.
// The current dbType: the provider is registered once but has to format for the connected database,
// including after the user switches to a connection of another kind without reloading the app.
let formatterDbType = 'sqlite';
function registerSqlFormatter(dbType: string) {
  formatterDbType = dbType;
  const w = window as any;
  // The flag and disposable have to live on window: an HMR reload resets module variables and
  // registers the provider a second time -> Monaco ends up with two formatters for one language.
  if (Array.isArray(w.__sqlFormatDisposables)) {
    for (const d of w.__sqlFormatDisposables) {
      try { d.dispose(); } catch { /* already cancel */ }
    }
  }
  const formatProvider = {
    provideDocumentFormattingEdits(model: any) {
      const formatted = formatSql(model.getValue(), formatterDbType);
      return [{ range: model.getFullModelRange(), text: formatted }];
    },
  };
  w.__sqlFormatDisposables = ['sql', ...LANG_IDS].map((lang) =>
    monaco.languages.registerDocumentFormattingEditProvider(lang, formatProvider)
  );
}
import { Play, Clipboard, Trash2, CheckCircle2, AlertTriangle, ChevronLeft, ChevronRight, Copy, AlignLeft, History, X, Bookmark, ChevronDown, MoreHorizontal, SlidersHorizontal, Star, Columns, Rows, Settings, Network, Zap, FileText, Square, Calendar, BarChart2 } from 'lucide-react';
import { getQueryParamsConfig, saveQueryParamsConfig, extractQueryParams, buildParameterizedSql, type QueryParamsConfig } from '../utils/queryParamHelper';
import { buildExplainQuery, explainJsonLabel, parseExplainOutput, supportsJsonExplain, type ExplainResult } from '../utils/explainHelper';
import {
  HISTORY_CHANGED_EVENT,
  addHistoryEntry,
  addSavedQuery,
  clearHistory,
  deleteHistoryEntry,
  deleteSavedQuery,
  loadHistory,
  loadSavedQueries,
  matchesScope,
  parseHistoryScope,
  recordHistoryResult,
  type HistoryEntry,
  type HistoryScope,
  type SavedQueryEntry,
} from '../utils/queryHistory';
import { QueryParamsConfigModal } from './QueryParamsConfigModal';
import { QueryParamsModal } from './QueryParamsModal';
import { ConfirmDialog } from './ConfirmDialog';
import { ExplainViewer } from './ExplainViewer';
import { Modal, ModalBody, ModalFooter } from './Modal';

interface SqlEditorProps {
  /** The connection this component acts on. Passed explicitly, never read from the ambient id (§4.1). */
  connId: string;
  /** The connection is labelled production -> the dangerous-statement warning asks for the database name. */
  isProdConn?: boolean;
  /**
   * THIS connection is read-only (the backend flag, distinct from the global `readOnly` switch).
   *
   * Both are needed: the backend is where the refusal actually happens, but if the UI does not know,
   * it invites the user to type a database name to confirm a statement that is certain to be
   * blocked — a dialog promising something that will not happen.
   */
  connReadOnly?: boolean;
  dbType?: string;
  /** The identity of the connected server (utils/connKey) — used to tag and filter history. */
  connKey?: string;
  /** The database in use, shown on each history row when viewing "all connections". */
  dbName?: string;
  initialSql?: string;
  initialSql2?: string;
  initialSplitMode?: 'none' | 'vertical' | 'horizontal';
  initialEditorHeight?: number;
  onRunSuccess?: () => void;
  theme?: 'dark' | 'light';
  readOnly?: boolean;
  onSqlChange?: (sql: string) => void;
  onSql2Change?: (sql2: string) => void;
  onSplitModeChange?: (mode: 'none' | 'vertical' | 'horizontal') => void;
  onEditorHeightChange?: (height: number) => void;
}

// The history drawer's scope filter. A module-level constant table, so it holds translation KEYS and
// t() is called in the component (i18next has to be able to check each key).
const SCOPE_OPTIONS = [
  { scope: 'db', labelKey: 'sqlEditor.scopeDb', titleKey: 'sqlEditor.scopeDbTitle' },
  { scope: 'conn', labelKey: 'sqlEditor.scopeConn', titleKey: 'sqlEditor.scopeConnTitle' },
  { scope: 'all', labelKey: 'sqlEditor.scopeAll', titleKey: 'sqlEditor.scopeAllTitle' },
] as const;

// The read-only statements allowed to run in read-only mode
const READ_ONLY_PREFIXES = ['SELECT', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC', 'PRAGMA', 'WITH'];
function isReadOnlySql(text: string): boolean {
  // Shares the editor's splitter: a ';' inside a string, a comment or a dollar-quoted block, and a
  // statement terminator changed by DELIMITER, are all handled correctly (a hand-rolled split(';')
  // would misjudge those scripts).
  return splitStatements(text).every(stmt => {
    const first = stmt.text.split(/\s+/)[0].toUpperCase();
    return READ_ONLY_PREFIXES.includes(first);
  });
}

/** Where the caret is, as the toolbar spells it out. */
interface CaretPos { line: number; column: number }

/**
 * The caret readout is the one thing on the toolbar that changes on every keystroke, every arrow
 * key and every frame of a drag-selection — and it is read by nothing else. Held as `useState` on
 * `SqlEditor` it re-rendered all 3,500 lines of it ~30 times a second for two numbers (measured:
 * 83 commits in 2.5s, ~4ms each, all attributed to that one hook).
 *
 * So it lives outside React instead, in the smallest store that can notify one subscriber — the
 * same shape as `utils/jobs.ts` and `utils/queryHistory.ts`, for the same reason. One store per
 * pane, created per `SqlEditor` instance rather than at module level: several tabs stay mounted at
 * once (see `QueryTabPanel` in App.tsx) and a module-level store would let them share a caret.
 *
 * `set` keeps the SAME object when the position has not moved, because `useSyncExternalStore`
 * compares snapshots by identity and a fresh object every time would re-render on every event
 * again — which is the bug this exists to remove.
 */
function createCaretStore() {
  let pos: CaretPos = { line: 1, column: 1 };
  const listeners = new Set<() => void>();
  return {
    get: () => pos,
    set: (line: number, column: number) => {
      if (pos.line === line && pos.column === column) return;
      pos = { line, column };
      listeners.forEach((fn) => fn());
    },
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

type CaretStore = ReturnType<typeof createCaretStore>;

/** Memoized so a `SqlEditor` render does not drag it along; `store` is a stable per-pane object. */
const CaretReadout = React.memo(function CaretReadout({ store }: { store: CaretStore }) {
  const pos = React.useSyncExternalStore(store.subscribe, store.get);
  return <span className="sql-status-info">line {pos.line}, column {pos.column}</span>;
});

/**
 * `<Editor>` from `@monaco-editor/react` is `memo()`'d, and a `loading` prop written inline as JSX
 * is a new element on every render, which defeats that on its own. Rendered once here instead —
 * it needs a component rather than a plain string because the text is translated.
 */
const EditorLoading: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--win-text-secondary)', fontSize: '13px' }}>
      {t('sqlEditor.loadingEditor')}
    </div>
  );
};

/** Created once: the whole point is that this element's identity never changes. */
const EDITOR_LOADING = <EditorLoading />;

export const SqlEditor: React.FC<SqlEditorProps> = ({
  connId,
  isProdConn = false,
  connReadOnly = false,
  dbType = 'sqlite',
  connKey = '',
  dbName = '',
  initialSql = '',
  initialSql2 = '',
  initialSplitMode = 'none',
  initialEditorHeight,
  onRunSuccess,
  theme = 'dark',
  readOnly = false,
  onSqlChange,
  onSql2Change,
  onSplitModeChange,
  onEditorHeightChange,
}) => {
  const { t, i18n } = useTranslation();
  // Dates and thousands separators follow the active UI language.
  const locale = i18n.language;
  // Monaco actions and the run-glyph are registered once per editor mount, so
  // their labels are read through a ref that always holds the latest `t`.
  const tRef = useRef(t);
  tRef.current = t;

  const langId = langIdForDbType(dbType); // 'mysql' | 'pgsql' cho smart completion
  const [sql, setSql] = useState(initialSql);
  const [sql2, setSql2] = useState(initialSql2);

  // `initialSql` is a prop, and the parent hands back a NEW one every time the draft is flushed up
  // to `App` (`tabs[].sql`) — which changed `<Editor>`'s `defaultValue` and so defeated its memo on
  // every flush, no matter what this file does with its own callbacks. Only the mount-time value
  // ever means anything: Monaco reads `defaultValue` when it creates the model and never again, and
  // the `sql`/`sql2` state above is seeded from it once. Frozen here so a parent re-render cannot
  // churn the prop.
  const initialSqlRef = useRef(initialSql);
  const initialSql2Ref = useRef(initialSql2);
  const [splitMode, setSplitMode] = useState<'none' | 'vertical' | 'horizontal'>(initialSplitMode);
  const [splitRatio, setSplitRatio] = useState<number>(50);
  const [isDraggingSplit, setIsDraggingSplit] = useState<boolean>(false);
  const [focusedEditor, setFocusedEditor] = useState<1 | 2>(1);
  const [showSnippetPanel, setShowSnippetPanel] = useState<boolean>(false);
  const editorRef2 = useRef<any>(null);

  const insertSnippetAtCursor = (template: string, targetPaneId?: 1 | 2) => {
    const activePane = targetPaneId || focusedEditor || 1;
    const ed = activePane === 1 ? editorRef.current : editorRef2.current;
    if (!ed) return;

    const selection = ed.getSelection();
    if (selection) {
      ed.executeEdits('snippet-panel', [
        {
          range: selection,
          text: template,
          forceMoveMarkers: true,
        },
      ]);
      ed.focus();
    }
  };

  const [results, setResults] = useState<any[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [allResults, setAllResults] = useState<any[]>([]);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [showCopyDropdown, setShowCopyDropdown] = useState(false);
  const [runningQueryId, setRunningQueryId] = useState<string | null>(null);

  // Pane 2 execution results state
  const [results2, setResults2] = useState<any[]>([]);
  const [columns2, setColumns2] = useState<string[]>([]);
  const [allResults2, setAllResults2] = useState<any[]>([]);
  const [activeTabIndex2, setActiveTabIndex2] = useState(0);
  const [loading2, setLoading2] = useState(false);
  const [hasRun2, setHasRun2] = useState(false);
  const [errorMsg2, setErrorMsg2] = useState<string | null>(null);
  const [statusMsg2, setStatusMsg2] = useState<string | null>(null);
  const [page2, setPage2] = useState(1);
  const [pageSize2, setPageSize2] = useState(50);
  const [showCopyDropdown2, setShowCopyDropdown2] = useState(false);
  const [runningQueryId2, setRunningQueryId2] = useState<string | null>(null);

  // Result visualization view modes ('grid' | 'chart')
  // Grid vs Chart, kept PER RESULT TAB rather than per pane. One run produces one result set per
  // statement ("1: SELECT (19,040)", "2: SELECT (20,000)", …) and they are different shapes of
  // data, so the one worth charting is rarely the one worth reading as a grid; a single flag per
  // pane forced every result into the same view.
  //
  // Keyed by result index, and deliberately NOT cleared when a new run replaces the results: while
  // you iterate on a statement, re-running it should come back in the view you left it in — the
  // same way the sort column survives a re-run.
  const [pane1ViewModes, setPane1ViewModes] = useState<Record<number, 'grid' | 'chart'>>({});
  const [pane2ViewModes, setPane2ViewModes] = useState<Record<number, 'grid' | 'chart'>>({});

  const viewModeOf = (paneId: 1 | 2, resultIndex: number): 'grid' | 'chart' =>
    (paneId === 1 ? pane1ViewModes : pane2ViewModes)[resultIndex] ?? 'grid';

  const setViewMode = (paneId: 1 | 2, resultIndex: number, mode: 'grid' | 'chart') => {
    const setter = paneId === 1 ? setPane1ViewModes : setPane2ViewModes;
    // `prev` is returned unchanged when the mode is already the one asked for, so clicking the
    // button that is already active costs no render at all.
    setter((prev) => (prev[resultIndex] === mode ? prev : { ...prev, [resultIndex]: mode }));
  };

  const [userEditorHeight, setUserEditorHeight] = useState<number | null>(
    initialEditorHeight ?? null
  );
  const [userEditorHeight2, setUserEditorHeight2] = useState<number | null>(null);
  const [isDraggingResizer, setIsDraggingResizer] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState<HistoryEntry[]>([]);
  const [historySearch, setHistorySearch] = useState('');

  const [savedQueries, setSavedQueries] = useState<SavedQueryEntry[]>([]);
  const [historyTab, setHistoryTab] = useState<'history' | 'saved'>('history');
  // Viewing the history of the current database, of the whole server, or of every connection. The
  // choice is remembered across launches (the tf_* convention): it is a working habit, not a
  // transient state.
  const [historyScope, setHistoryScope] = useState<HistoryScope>(
    () => parseHistoryScope(localStorage.getItem('tf_history_scope'))
  );

  const changeHistoryScope = (scope: HistoryScope) => {
    setHistoryScope(scope);
    localStorage.setItem('tf_history_scope', scope);
  };

  /** With no idea which connection this is (plain vite-dev), nothing can be filtered. */
  const effectiveScope: HistoryScope = connKey ? historyScope : 'all';
  const inScope = (entry: HistoryEntry) => matchesScope(entry, connKey, dbName, effectiveScope);

  const [showSaveModal, setShowSaveModal] = useState(false);
  /**
   * Pending confirmation for the three history/saved-query deletions. One state instead of
   * three flags — the dialog is the same shape, only the wording differs.
   *
   * `window.confirm()` is unusable here: the Tauri webview maps it to `plugin:dialog|confirm`,
   * a command the dialog plugin does not ship, so it throws and the click does nothing.
   */
  const [confirmAction, setConfirmAction] = useState<
    | { kind: 'clearHistory' }
    | { kind: 'deleteSaved'; id: string }
    | { kind: 'deleteHistoryItem'; id: string }
    | null
  >(null);
  const [newQueryName, setNewQueryName] = useState('');

  const [runMenuPane, setRunMenuPane] = useState<1 | 2 | null>(null);
  const [moreMenuPane, setMoreMenuPane] = useState<1 | 2 | null>(null);
  const [, setSplitMenuPane] = useState<1 | 2 | null>(null);
  const [formatMenuPane, setFormatMenuPane] = useState<1 | 2 | null>(null);
  const [limitMenuPane, setLimitMenuPane] = useState<1 | 2 | null>(null);
  const [editorSettingsMenuPane, setEditorSettingsMenuPane] = useState<1 | 2 | null>(null);
  // A row cap by default, not "No limit". `SELECT *` on a real table returns tens of thousands of
  // rows to fill a grid that shows 50 at a time, and every one of them is decoded in Rust, shipped
  // over IPC and held in memory — measured at ~6 seconds for 79k rows, against 80ms of actual query
  // time. Someone who wants the whole table still says so in one click, and the button shows the
  // cap at all times so the number on screen is never mistaken for the whole answer.
  const [limitPane1, setLimitPane1] = useState<string>('100 rows');
  const [limitPane2, setLimitPane2] = useState<string>('100 rows');
  const [dropdownPlacement, setDropdownPlacement] = useState<Record<string, 'up' | 'down'>>({});

  // TablePlus Editor & Grid Settings states (Image 2 + Image 3)
  const [editorFontSize, setEditorFontSize] = useState<number>(13);
  const [showInvisibleChars, setShowInvisibleChars] = useState<boolean>(false);
  const [wordWrap, setWordWrap] = useState<boolean>(true);
  const [highlightQuery, setHighlightQuery] = useState<boolean>(true);
  const [showRowNumbers, setShowRowNumbers] = useState<boolean>(true);
  const [autoFitColsPane1, setAutoFitColsPane1] = useState<boolean>(false);
  const [autoFitColsPane2, setAutoFitColsPane2] = useState<boolean>(false);
  // Mount and focus alone are not enough: switching connection changes `connId` while this editor
  // is already mounted and focused, and no focus event fires for that.
  useEffect(() => {
    setEditorConnId(connId);
    // Nothing told the symbol index about a CONNECTION change — it rebuilt only on table-renamed
    // and database-restored — so it kept the previous connection's tables and the inspection marked
    // every table of the new one as non-existent.
    //
    // No `invalidate()` here on purpose: `buildIndex` compares against the connection it already
    // holds, so it rebuilds when this one differs and returns immediately when it does not. Every
    // mounted editor runs this effect, and forcing a discard first turned each of them into another
    // full catalog fetch.
    void dbIndexRegistry.buildIndex();
  }, [connId]);

  // Caret position, per pane. A store rather than state — see `createCaretStore` for why.
  // Lazy `useState` because these must be created exactly once per mount and never replaced;
  // nothing ever calls the setter.
  const [caretStores] = useState(() => ({ 1: createCaretStore(), 2: createCaretStore() }));

  // The SQL result grid's column sort state (sort column and direction)
  const [sortCol1, setSortCol1] = useState<string | null>(null);
  const [sortDir1, setSortDir1] = useState<'asc' | 'desc' | null>(null);
  const [sortCol2, setSortCol2] = useState<string | null>(null);
  const [sortDir2, setSortDir2] = useState<'asc' | 'desc' | null>(null);

  const handleTableSort = (colName: string, paneId: 1 | 2) => {
    if (paneId === 1) {
      if (sortCol1 !== colName) {
        setSortCol1(colName);
        setSortDir1('asc');
      } else if (sortDir1 === 'asc') {
        setSortDir1('desc');
      } else {
        setSortCol1(null);
        setSortDir1(null);
      }
    } else {
      if (sortCol2 !== colName) {
        setSortCol2(colName);
        setSortDir2('asc');
      } else if (sortDir2 === 'asc') {
        setSortDir2('desc');
      } else {
        setSortCol2(null);
        setSortDir2(null);
      }
    }
  };

  const sortedResults1 = React.useMemo(() => {
    if (!sortCol1 || !sortDir1) return results;
    const list = [...results];
    list.sort((a, b) => {
      const valA = a[sortCol1];
      const valB = b[sortCol1];
      if (valA === valB) return 0;
      if (valA === null || valA === undefined) return 1;
      if (valB === null || valB === undefined) return -1;
      if (typeof valA === 'number' && typeof valB === 'number') {
        return sortDir1 === 'asc' ? valA - valB : valB - valA;
      }
      const comp = String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: 'base' });
      return sortDir1 === 'asc' ? comp : -comp;
    });
    return list;
  }, [results, sortCol1, sortDir1]);

  const sortedResults2 = React.useMemo(() => {
    if (!sortCol2 || !sortDir2) return results2;
    const list = [...results2];
    list.sort((a, b) => {
      const valA = a[sortCol2];
      const valB = b[sortCol2];
      if (valA === valB) return 0;
      if (valA === null || valA === undefined) return 1;
      if (valB === null || valB === undefined) return -1;
      if (typeof valA === 'number' && typeof valB === 'number') {
        return sortDir2 === 'asc' ? valA - valB : valB - valA;
      }
      const comp = String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: 'base' });
      return sortDir2 === 'asc' ? comp : -comp;
    });
    return list;
  }, [results2, sortCol2, sortDir2]);

  const toggleDropdown = (menuKey: string, paneId: 1 | 2, e: React.MouseEvent<HTMLElement>, setMenuPane: React.Dispatch<React.SetStateAction<1 | 2 | null>>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const placement = spaceBelow < 280 && rect.top > spaceBelow ? 'up' : 'down';
    setDropdownPlacement(prev => ({ ...prev, [`${menuKey}_${paneId}`]: placement }));
    setMenuPane(prev => prev === paneId ? null : paneId);
  };

  const handleInnerResizerMouseDown = (e: React.MouseEvent, paneId: 1 | 2 = 1) => {
    e.preventDefault();
    setIsDraggingResizer(true);
    const startY = e.clientY;

    const paneEl = paneId === 1 ? pane1Ref.current : pane2Ref.current;
    const editorEl = (paneEl?.querySelector('.monaco-editor-wrapper') as HTMLElement) || (paneEl?.firstElementChild as HTMLElement);
    const currentHeight = editorEl ? editorEl.clientHeight : 220;
    const startHeight = (paneId === 1 ? userEditorHeight : userEditorHeight2) ?? currentHeight;

    let currentH = startHeight;
    let rafId: number | null = null;

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
    if (editorEl) {
      editorEl.style.pointerEvents = 'none';
    }

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = moveEvent.clientY - startY;
      const maxH = paneEl ? paneEl.clientHeight - 100 : window.innerHeight - 180;
      const newHeight = Math.max(60, Math.min(maxH, startHeight + deltaY));
      currentH = newHeight;

      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (editorEl) {
            editorEl.style.flex = `0 0 ${currentH}px`;
          }
        });
      }
    };

    const onMouseUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      if (editorEl) {
        editorEl.style.pointerEvents = '';
      }
      setIsDraggingResizer(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);

      if (paneId === 1) {
        setUserEditorHeight(currentH);
        onEditorHeightChange?.(currentH);
        if (editorRef.current) editorRef.current.layout();
      } else {
        setUserEditorHeight2(currentH);
        if (editorRef2.current) editorRef2.current.layout();
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // Query Parameters State
  const [queryParamsConfig, setQueryParamsConfig] = useState<QueryParamsConfig>(getQueryParamsConfig());
  const [showQueryParamsConfigModal, setShowQueryParamsConfigModal] = useState(false);
  const [paramPromptData, setParamPromptData] = useState<{ pane: 1 | 2; originalSql: string; params: string[]; action: 'run' | 'explain'; variant?: 'explain' | 'analyze' | 'json' } | null>(null);

  // Asks again before running a statement that wipes data (a DELETE with no WHERE, a DROP TABLE).
  // A warning only — to refuse outright, switch read-only mode on.
  const [unsafePrompt, setUnsafePrompt] = useState<{
    pane: 1 | 2;
    sql: string;
    items: UnsafeStatement[];
    /** Which path "Run anyway" continues on (the Run button or EXPLAIN ANALYZE). */
    resume: 'run' | 'analyze';
  } | null>(null);

  // The switch returns literal keys, NEVER an interpolated one (i18next has to be able to check each).
  const unsafeKindLabel = (kind: UnsafeStatementKind): string => {
    switch (kind) {
      case 'deleteNoWhere': return t('sqlEditor.unsafeKindDeleteNoWhere');
      case 'dropTable': return t('sqlEditor.unsafeKindDropTable');
      case 'updateNoWhere': return t('sqlEditor.unsafeKindUpdateNoWhere');
      case 'truncate': return t('sqlEditor.unsafeKindTruncate');
    }
  };

  // EXPLAIN State
  const [explainResult1, setExplainResult1] = useState<ExplainResult | null>(null);
  const [explainResult2, setExplainResult2] = useState<ExplainResult | null>(null);
  const [activeTabType1, setActiveTabType1] = useState<'data' | 'explain'>('data');
  const [activeTabType2, setActiveTabType2] = useState<'data' | 'explain'>('data');

  const pane1Ref = useRef<HTMLDivElement>(null);
  const pane2Ref = useRef<HTMLDivElement>(null);

  const hasResult1 = loading || hasRun || errorMsg !== null || explainResult1 !== null;
  const hasResult2 = loading2 || hasRun2 || errorMsg2 !== null || explainResult2 !== null;

  // ─── Editing directly in the result grid ───────────────────────────────────────────
  // Only the edit buffer is split per pane: at most one cell is being typed into and at
  // most one preview dialog is open at a time, so those stay single.
  const [cellEdits, setCellEdits] = useState<Record<1 | 2, Record<string, Record<string, any>>>>({ 1: {}, 2: {} });
  const [editingCell, setEditingCell] = useState<{ pane: 1 | 2; rowKey: string; col: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editCommit, setEditCommit] = useState<
    { pane: 1 | 2; table: string; primaryKey: string; sqls: string[]; changes: GridChange[] } | null
  >(null);
  const [editCommitting, setEditCommitting] = useState(false);
  const [editMsg, setEditMsg] = useState<{ pane: 1 | 2; text: string; kind: 'ok' | 'err' } | null>(null);
  // `getCachedSchema` is a synchronous read, so a cache miss has to be turned into a
  // re-render once the fetch lands. Only the setter is used — the value itself is never read.
  const [, setSchemaTick] = useState(0);

  // Load history & saved queries on mount, then follow the shared store: each query tab is its own
  // SqlEditor with its own copy, so it has to reload when another tab adds or deletes something
  // (utils/queryHistory emits HISTORY_CHANGED_EVENT after every write).
  useEffect(() => {
    const reload = () => {
      setHistoryList(loadHistory());
      setSavedQueries(loadSavedQueries());
    };
    reload();
    window.addEventListener(HISTORY_CHANGED_EVENT, reload);
    return () => window.removeEventListener(HISTORY_CHANGED_EVENT, reload);
  }, []);

  // Recalculate Monaco editor layout when history drawer, split mode, height, or results change
  useEffect(() => {
    const timer = setTimeout(() => {
      if (editorRef.current) editorRef.current.layout();
      if (editorRef2.current) editorRef2.current.layout();
    }, 50);
    return () => clearTimeout(timer);
  }, [showHistory, splitMode, splitRatio, userEditorHeight, userEditorHeight2, hasResult1, hasResult2]);

  /** Returns the history row's id so `runRawSql` can write the outcome onto it when the run finishes. */
  const addToHistory = (queryText: string): string => {
    const { list, id } = addHistoryEntry(queryText, connKey, dbName, Date.now().toString());
    setHistoryList(list);
    return id;
  };

  // Clears exactly the scope being viewed, no more.
  // The switch returns literal keys, NEVER an interpolated one (i18next has to be able to check each).
  const clearHistoryLabel = (): string => {
    switch (effectiveScope) {
      case 'db': return t('sqlEditor.clearDbHistory');
      case 'conn': return t('sqlEditor.clearConnHistory');
      case 'all': return t('sqlEditor.clearAllHistory');
    }
  };

  // Same reason as the switch in clearHistoryLabel: the key must be a literal.
  const clearHistoryMessage = (): string => {
    switch (effectiveScope) {
      case 'db': return t('sqlEditor.confirmClearDbHistory');
      case 'conn': return t('sqlEditor.confirmClearConnHistory');
      case 'all': return t('sqlEditor.confirmClearHistory');
    }
  };

  const handleClearHistory = () => setConfirmAction({ kind: 'clearHistory' });

  const runConfirmAction = () => {
    if (!confirmAction) return;
    const action = confirmAction;
    setConfirmAction(null);
    if (action.kind === 'clearHistory') setHistoryList(clearHistory(effectiveScope, connKey, dbName));
    else if (action.kind === 'deleteSaved') setSavedQueries(deleteSavedQuery(action.id));
    else setHistoryList(deleteHistoryEntry(action.id));
  };

  const handleSaveQuery = () => {
    if (editorRef.current) {
      const val = editorRef.current.getValue();
      if (!val.trim()) {
        setStatusMsg(t('sqlEditor.errNoSqlToSave'));
        setTimeout(() => setStatusMsg(null), 3000);
        return;
      }
      setNewQueryName(t('sqlEditor.defaultQueryName', { date: new Date().toLocaleDateString(locale) }));
      setShowSaveModal(true);
    }
  };

  const handleConfirmSaveQuery = () => {
    if (editorRef.current) {
      const val = editorRef.current.getValue();
      const name = newQueryName.trim() || t('sqlEditor.defaultQueryName', { date: new Date().toLocaleDateString(locale) });

      setSavedQueries(addSavedQuery(name, val, connKey, dbName, Date.now().toString()));
      setShowSaveModal(false);
      setNewQueryName('');
      setStatusMsg(t('sqlEditor.savedQuery', { name }));
      setTimeout(() => setStatusMsg(null), 3000);
    }
  };

  const handleDeleteSaved = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmAction({ kind: 'deleteSaved', id });
  };

  const handleSelectHistoryItem = (sqlText: string) => {
    if (editorRef.current) {
      editorRef.current.setValue(sqlText);
      setSql(sqlText);
      setStatusMsg(t('sqlEditor.loadedQuery'));
      setTimeout(() => setStatusMsg(null), 3000);
    }
  };

  const getGroupTitle = (dateStr: string) => {
    const date = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    if (date.toDateString() === today.toDateString()) {
      return t('sqlEditor.today');
    } else if (date.toDateString() === yesterday.toDateString()) {
      return t('sqlEditor.yesterday');
    } else {
      return date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
    }
  };

  /** "37 ms · 200 rows" — parts that are absent are skipped (an older row with no outcome, a DDL statement returning none). */
  const historyMetrics = (item: HistoryEntry): string => {
    const parts: string[] = [];
    if (item.ms !== undefined) parts.push(t('sqlEditor.historyMs', { n: item.ms.toLocaleString(locale) }));
    if (item.rows) parts.push(t('sqlEditor.historyRows', { n: item.rows.toLocaleString(locale) }));
    if (item.affected) parts.push(t('sqlEditor.historyAffected', { n: item.affected.toLocaleString(locale) }));
    return parts.join(' · ');
  };

  const getFilteredHistory = () => {
    const filtered = historyList.filter(item =>
      inScope(item) && item.sql.toLowerCase().includes(historySearch.toLowerCase())
    );

    const groups: { [key: string]: HistoryEntry[] } = {};
    filtered.forEach(item => {
      const dateKey = new Date(item.timestamp).toDateString();
      if (!groups[dateKey]) {
        groups[dateKey] = [];
      }
      groups[dateKey].push(item);
    });

    return groups;
  };

  const getFilteredSaved = () => {
    return savedQueries.filter(item =>
      inScope(item) && (
        item.name.toLowerCase().includes(historySearch.toLowerCase()) ||
        item.sql.toLowerCase().includes(historySearch.toLowerCase())
      )
    );
  };

  // The count on the tab heading has to match the list being shown (already filtered by connection).
  const historyCount = historyList.filter(inScope).length;
  const savedCount = savedQueries.filter(inScope).length;

  const editorRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // The content is synced out to React state and the parent on a BEAT (a trailing debounce).
  // Every keystroke used to call onSqlChange -> App.setTabs -> a re-render of the WHOLE app (every
  // tab, DataGrid included), so holding Backspace stuttered visibly. The "real" content is always
  // read from the editor (getPaneSql/getCurrentStatement), so lagging the state changes no
  // behaviour: `sql`/`sql2` are only ever read as a fallback for when there is no editor instance.
  //
  // 600ms rather than 150ms, because one flush is NOT cheap and never was local to this component:
  // it calls `onSqlChange` -> `App.setTabs`, which re-renders App and the whole title bar/sidebar
  // chrome (DbRail, TabManager, TxControl, SafeModeControl…) and re-serializes every tab into
  // localStorage. Measured at ~9ms per flush. At 150ms a continuous typing burst paid that four
  // times a second; at 600ms an uninterrupted burst pays it zero times, because the flush only
  // lands once the user pauses. Nothing is risked by the longer wait: `onDidBlurEditorText` flushes
  // immediately, and so does the unmount cleanup below, so leaving the pane, switching tabs and
  // closing all still persist at once. Only a crash mid-burst can lose anything, and it now loses
  // at most 600ms of typing.
  const SQL_SYNC_DELAY = 600;
  const sqlSyncRef = useRef<{ timer: any; value: string | null }[]>([
    { timer: null, value: null },
    { timer: null, value: null },
  ]);

  const flushSqlSync = (paneId: 1 | 2) => {
    const slot = sqlSyncRef.current[paneId - 1];
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    if (slot.value === null) return;
    const val = slot.value;
    slot.value = null;
    if (paneId === 1) { setSql(val); onSqlChange?.(val); }
    else { setSql2(val); onSql2Change?.(val); }
  };

  const queueSqlSync = (paneId: 1 | 2, val: string) => {
    const slot = sqlSyncRef.current[paneId - 1];
    slot.value = val;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => flushSqlSync(paneId), SQL_SYNC_DELAY);
  };

  // The parent's callback is kept in a ref: the unmount cleanup has to call the LATEST one, while
  // the effect may only run once (empty deps) and so cannot read it from the closure.
  const changeCallbacksRef = useRef({ onSqlChange, onSql2Change });
  changeCallbacksRef.current = { onSqlChange, onSql2Change };

  // Leaving the component: flush whatever is still pending, so nothing just typed is lost on close or tab switch
  useEffect(() => () => {
    [1, 2].forEach((p) => {
      const slot = sqlSyncRef.current[p - 1];
      if (slot.timer) clearTimeout(slot.timer);
      if (slot.value === null) return;
      const cb = changeCallbacksRef.current;
      if (p === 1) cb.onSqlChange?.(slot.value);
      else cb.onSql2Change?.(slot.value);
    });
  }, []);

  const handleSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingSplit(true);

    const startX = e.clientX;
    const startY = e.clientY;
    const initialRatio = splitRatio;

    const wrapper = containerRef.current?.querySelector('.sql-editor-split-wrapper');
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (splitMode === 'vertical') {
        const deltaX = moveEvent.clientX - startX;
        const newRatio = Math.max(15, Math.min(85, initialRatio + (deltaX / rect.width) * 100));
        setSplitRatio(newRatio);
      } else if (splitMode === 'horizontal') {
        const deltaY = moveEvent.clientY - startY;
        const newRatio = Math.max(15, Math.min(85, initialRatio + (deltaY / rect.height) * 100));
        setSplitRatio(newRatio);
      }
    };

    const handleMouseUp = () => {
      setIsDraggingSplit(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (editorRef.current) editorRef.current.layout();
      if (editorRef2.current) editorRef2.current.layout();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleEditorDidMount = (editor: any, editorId: 1 | 2) => {
    if (editorId === 1) {
      editorRef.current = editor;
    } else {
      editorRef2.current = editor;
    }

    // Tell the Monaco layer which connection this editor belongs to.
    //
    // Completion, hover, F12 and the inspection index are registered ONCE for the whole app and are
    // called BY Monaco, so they cannot take a `connId` argument — they read `editorConnId()` instead
    // (see src/sql/editorScope.ts). Setting it on focus is what makes that honest: the provider that
    // is about to run belongs to the editor the user is typing in.
    //
    // Without this the scope stays empty and every one of those readers asks the backend for
    // connection "", which fails — the visible symptom being the inspection marking every table as
    // non-existent while the sidebar lists them.
    setEditorConnId(connId);
    editor.onDidFocusEditorText(() => setEditorConnId(connId));

    const syncCursor = () => {
      const pos = editor.getPosition();
      // Straight into the store: this fires on every cursor and selection event, so it must not
      // touch `SqlEditor`'s state. Only `CaretReadout` re-renders.
      if (pos) caretStores[editorId].set(pos.lineNumber, pos.column);
    };

    editor.onDidFocusEditorText(() => {
      setFocusedEditor(editorId);
      syncCursor();
    });

    editor.onDidChangeCursorPosition(syncCursor);
    editor.onDidChangeCursorSelection(syncCursor);
    syncCursor();

    // Leaving the pane -> flush whatever the debounce is holding straight out to state/parent
    editor.onDidBlurEditorText(() => {
      flushSqlSync(editorId);
    });

    // Format / Beautify / Minify actions cho Monaco context menu
    editor.addAction({
      id: 'format-beautify-sql',
      label: tRef.current('sqlEditor.actionBeautify'),
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.1,
      run: () => {
        handleBeautify(editorId);
      }
    });

    editor.addAction({
      id: 'format-minify-sql',
      label: tRef.current('sqlEditor.actionMinify'),
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.2,
      run: () => {
        handleMinify(editorId);
      }
    });

    // Shortcuts cho Beautify (Ctrl+Shift+F) & Minify (Ctrl+Shift+M)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => {
      handleBeautify(editorId);
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyM, () => {
      handleMinify(editorId);
    });

    // Monaco context menu actions cho Split Panes
    editor.addAction({
      id: 'split-pane-vertical',
      label: tRef.current('sqlEditor.actionSplitVertical'),
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.5,
      run: () => {
        setSplitMode('vertical');
        onSplitModeChange?.('vertical');
      }
    });

    editor.addAction({
      id: 'split-pane-horizontal',
      label: 'Chia khung ngang (Top / Bottom)',
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.6,
      run: () => {
        setSplitMode('horizontal');
        onSplitModeChange?.('horizontal');
      }
    });

    editor.addAction({
      id: 'close-split-pane',
      label: tRef.current('sqlEditor.actionSinglePane'),
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.7,
      run: () => {
        setSplitMode('none');
        onSplitModeChange?.('none');
      }
    });

    editor.addAction({
      id: 'explain-query-plan',
      label: tRef.current('sqlEditor.actionExplain'),
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.8,
      run: () => {
        handleExplain(editorId, 'explain');
      }
    });

    // The Explain shortcut (Ctrl+Alt+E / Cmd+Option+E)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyE, () => {
      handleExplain(editorId, 'explain');
    });

    // The split-pane shortcut (Ctrl+Shift+D / Cmd+Shift+D)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyD, () => {
      setSplitMode(prev => {
        const next = prev === 'vertical' ? 'horizontal' : prev === 'horizontal' ? 'none' : 'vertical';
        onSplitModeChange?.(next);
        return next;
      });
    });

    // Shortcuts (they read straight from the editor, so stale state is not a concern)
    // getTextToRun, not getCurrentStatement: the Run button and the menu item labelled
    // "Ctrl+Enter" both honour the selection, so the key itself must too — otherwise the
    // same advertised shortcut runs something different from the button next to it.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      executeSql(getTextToRun(editorId), editorId);
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => {
      executeSql(editor.getValue(), editorId);
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => {
      handleSaveQuery();
    });

    // F2 / context menu: smart Rename Symbol
    editor.addAction({
      id: 'trigger-symbol-rename',
      label: 'Rename Symbol',
      keybindings: [monaco.KeyCode.F2],
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.0,
      run: (ed: any) => {
        ed.trigger('keyboard', 'editor.action.rename', {});
      },
    });

    // Alt+Enter / context menu: Quick Fix for whatever is underlined (see sql/quickFix.ts).
    // Monaco's default Ctrl+. does not work on the user's machine (whether because of the keyboard
    // or the input method is unclear), so a key of our own is bound: Alt+Enter is JetBrains/DataGrip's
    // "intention actions" key and does not collide with Ctrl+Enter / Ctrl+Shift+Enter, which already
    // belong to running statements. The context-menu entry is the most discoverable path of all — an
    // invisible shortcut may as well not exist — and it is also the quickest way to tell "the key
    // never arrived" apart from "the provider returned nothing".
    editor.addAction({
      id: 'trigger-sql-quick-fix',
      label: tRef.current('sqlEditor.actionQuickFix'),
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.Enter],
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 0.9,
      run: (ed: any) => {
        ed.trigger('keyboard', 'editor.action.quickFix', {});
      },
    });

    // Alt+F12: read a table's DDL in place, without leaving the tab (see sql/peekDefinition.ts).
    // Kept off F12 because they are two different intents: glancing at a structure vs. actually
    // opening the table to look at its data.
    editor.addAction({
      id: 'peek-table-definition',
      label: tRef.current('sqlEditor.actionPeekDefinition'),
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.F12],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.05,
      run: (ed: any) => {
        ed.trigger('keyboard', 'editor.action.peekDefinition', {});
      },
    });

    // F12 / context menu: open the table under the caret in a new tab
    editor.addAction({
      id: 'open-table-under-cursor',
      label: tRef.current('sqlEditor.actionOpenTable'),
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.1,
      // Ctrl+B is JetBrains/DataGrip’s familiar "go to declaration" key; F12 is the fallback.
      keybindings: [monaco.KeyCode.F12, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB],
      run: () => {
        const pos = editor.getPosition();
        const word = pos ? editor.getModel()?.getWordAtPosition(pos) : null;
        if (word) void openTableIfExists(word.word, editorId);
      }
    });

    // Ctrl/Cmd + Click on a table name -> open its tab (like go-to-definition)
    editor.onMouseDown((e: any) => {
      if (!(e.event?.ctrlKey || e.event?.metaKey)) return;
      if (e.target?.type !== monaco.editor.MouseTargetType.CONTENT_TEXT || !e.target.position) return;
      const word = editor.getModel()?.getWordAtPosition(e.target.position);
      if (word) void openTableIfExists(word.word, editorId, false);
    });

    // Clicking the gutter arrow -> run the statement that starts on that line
    editor.onMouseDown((e: any) => {
      if (e.target?.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return;
      editor.setPosition(e.target.position);
      const stmt = getCurrentStatement(editor);
      if (stmt) executeSql(stmt, editorId);
    });

    // Highlights the statement under the caret — the one Ctrl+Enter runs WHEN NOTHING IS SELECTED.
    // With a selection, the selection wins (see getTextToRun) and Monaco already highlights it.
    const decorations = editor.createDecorationsCollection([]);
    let highlightTimer: any = null;
    const refreshStatementHighlight = () => {
      const model = editor.getModel();
      const pos = editor.getPosition();
      if (!model || !pos) return;
      const text = model.getValue();
      // A very large script: skipped, so it does not cost CPU on every keystroke
      if (text.length > 200000) { decorations.set([]); return; }
      // Gets both the statement list and the one under the caret from a single masking pass
      const { statements: stmts, current: stmt } = analyzeStatements(text, model.getOffsetAt(pos));
      if (!stmt) { decorations.set([]); return; }

      const from = model.getPositionAt(stmt.start);
      const to = model.getPositionAt(stmt.end);
      const items: any[] = [{
        // The "run this statement" arrow in the gutter, placed on the statement’s first line
        range: new monaco.Range(from.lineNumber, 1, from.lineNumber, 1),
        options: {
          glyphMarginClassName: 'sql-run-glyph',
          glyphMarginHoverMessage: { value: tRef.current('sqlEditor.runThisStatement') },
        },
      }];
      // The background and bar are only drawn when there are several statements — with one, shading the whole page means nothing
      if (stmts.length > 1) {
        items.push({
          range: new monaco.Range(from.lineNumber, 1, to.lineNumber, model.getLineMaxColumn(to.lineNumber)),
          options: {
            isWholeLine: true,
            className: 'sql-current-stmt',
            linesDecorationsClassName: 'sql-current-stmt-strip',
            overviewRuler: { color: 'rgba(96, 165, 250, 0.45)', position: monaco.editor.OverviewRulerLane.Left },
          },
        });
      }
      decorations.set(items);
    };
    const scheduleHighlight = () => {
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = setTimeout(refreshStatementHighlight, 80);
    };
    editor.onDidChangeCursorPosition(scheduleHighlight);
    editor.onDidChangeModelContent(scheduleHighlight);
    editor.onDidDispose(() => { if (highlightTimer) clearTimeout(highlightTimer); });
    refreshStatementHighlight();

    registerSqlFormatter(dbType);
    void catalog.getTables(connId); // warm the catalog in the background for completion and hover
    const cleanupInspection = attachEditorInspection(monaco, editor);
    editor.onDidDispose(() => {
      cleanupInspection();
    });

    setTimeout(() => {
      editor.layout();
    }, 100);
  };

  // `Editor` is `memo()`'d inside @monaco-editor/react, so an inline arrow for `onChange`/`onMount`
  // is a new prop identity every render and defeats it — and its `onChange` effect then disposes
  // and re-subscribes Monaco's `onDidChangeModelContent` listener each time, for nothing. These
  // four wrappers never change identity and read the current implementation through a ref, the
  // same trick `tRef` and `changeCallbacksRef` above use.
  const editorCallbacksRef = useRef({ queueSqlSync, handleEditorDidMount });
  editorCallbacksRef.current = { queueSqlSync, handleEditorDidMount };

  const handleChange1 = React.useCallback((val: string | undefined) => {
    editorCallbacksRef.current.queueSqlSync(1, val || '');
  }, []);
  const handleChange2 = React.useCallback((val: string | undefined) => {
    editorCallbacksRef.current.queueSqlSync(2, val || '');
  }, []);
  const handleMount1 = React.useCallback((editor: any) => {
    editorCallbacksRef.current.handleEditorDidMount(editor, 1);
  }, []);
  const handleMount2 = React.useCallback((editor: any) => {
    editorCallbacksRef.current.handleEditorDidMount(editor, 2);
  }, []);

  // Opens a table tab when `name` really is a table or view in the current DB.
  // `notify` = false for Ctrl+Click (a stray click on a keyword stays silent), = true for F12.
  const openTableIfExists = async (name: string, paneId: 1 | 2, notify = true) => {
    const found = await findTable(name);
    if (!found) {
      if (!notify) return;
      const setMsg = paneId === 1 ? setStatusMsg : setStatusMsg2;
      setMsg(t('sqlEditor.errTableNotFound', { name }));
      setTimeout(() => setMsg(null), 3000);
      return;
    }
    openTableTab(found.name);
  };

  const executeSql = async (queryText?: string, targetPane?: 1 | 2, skipUnsafeCheck = false) => {
    const pane = targetPane || focusedEditor;
    const textToRun = queryText || (pane === 2 ? sql2 : sql);
    if (!textToRun.trim()) return;

    // Read-only mode: only reading statements are allowed (SELECT/SHOW/…)
    if ((readOnly || connReadOnly) && !isReadOnlySql(textToRun)) {
      // Two different switches block writes and they live in different places. Naming the wrong one
      // leaves the user toggling something that changes nothing.
      const msg = connReadOnly && !readOnly ? t('sqlEditor.errConnReadOnlyRun') : t('sqlEditor.errReadOnlyRun');
      if (pane === 1) setErrorMsg(msg);
      else setErrorMsg2(msg);
      return;
    }

    // Warns before wiping data. No `readOnly` check is needed here: with read-only on, every
    // DELETE/DROP was already stopped by the branch above, so this code only runs while writes are
    // allowed.
    // Placed BEFORE the query-parameter prompt so the path through QueryParamsModal is asked about
    // too. Safe Mode asks just before the command leaves `dbHelper`, and its dialog lists exactly
    // these statements with the same warning label. Asking here as well is two dialogs for one run.
    if (!skipUnsafeCheck && !willPromptForSql(connId, textToRun)) {
      const items = findUnsafeStatements(textToRun);
      if (items.length > 0) {
        setUnsafePrompt({ pane, sql: textToRun, items, resume: 'run' });
        return;
      }
    }

    // Process Query Parameters if enabled
    if (queryParamsConfig.enabled) {
      const detectedParams = extractQueryParams(textToRun, queryParamsConfig.patternIndex);
      if (detectedParams.length > 0) {
        setParamPromptData({
          pane,
          originalSql: textToRun,
          params: detectedParams,
          action: 'run'
        });
        return;
      }
    }

    await runRawSql(textToRun, pane);
  };

  const runRawSql = async (rawSqlText: string, pane: 1 | 2, params?: any[]) => {
    const limitOpt = pane === 1 ? limitPane1 : limitPane2;
    const textToRun = applyLimitToSql(rawSqlText, limitOpt);
    const historyId = addToHistory(textToRun); // Log query history immediately

    const isPane1 = pane === 1;
    const queryId = `q_${crypto.randomUUID()}`;

    // The cell-edit buffer is keyed by the primary-key values of the OLD result set. Keeping it
    // across a new run would attach those edits to different rows, so it is cleared with the results.
    discardEdits(isPane1 ? 1 : 2);

    if (isPane1) {
      setLoading(true);
      setHasRun(true);
      setErrorMsg(null);
      setStatusMsg(null);
      setPage(1);
      setActiveTabIndex(0);
      setRunningQueryId(queryId);
      setAllResults([]);
      setResults([]);
      setColumns([]);
    } else {
      setLoading2(true);
      setHasRun2(true);
      setErrorMsg2(null);
      setStatusMsg2(null);
      setPage2(1);
      setActiveTabIndex2(0);
      setRunningQueryId2(queryId);
      setAllResults2([]);
      setResults2([]);
      setColumns2([]);
    }

    // Streamed results are gathered into acc and mirrored out to state. While streaming, only the
    // first statement (tab 0) is shown live; the later ones still accumulate and are there when their
    // tab is opened.
    const acc: { query: string; columns: string[]; data: any[]; affected?: number }[] = [];
    let errText: string | null = null;
    let cancelled = false;
    const t0 = performance.now();
    let tFirst = 0; // when the first batch of data arrived (~ execution done, transfer starting)

    // Tauri's Channel sends messages out of Rust fire-and-forget, so they can still be queued when
    // invoke()'s promise resolves. Waiting on the invoke alone totals up a half-filled `acc` -> the
    // status bar reports "0 rows" (and exec = transfer, because `tFirst` was never set) while the
    // grid is still filling in behind it. The Rust command always sends exactly ONE terminating
    // message ('done' or 'error') before returning, and the channel preserves order, so waiting for
    // that message is both sufficient and impossible to hang on.
    let markStreamEnd: () => void = () => { };
    const streamEnded = new Promise<void>(resolve => { markStreamEnd = resolve; });

    const flushNow = () => {
      const snapshot = acc.map(r => ({ query: r.query, columns: r.columns, data: r.data, affected: r.affected }));
      if (isPane1) {
        setAllResults(snapshot);
        const first = snapshot[0];
        // `.slice()` is not a copy for its own sake: `acc[i].data` is pushed into in place, so the
        // array identity never changes and React would bail out of every update after the first.
        // What made it expensive was how OFTEN it ran, which is what the throttle below fixes.
        if (first) { setColumns(first.columns); setResults(first.data.slice()); }
      } else {
        setAllResults2(snapshot);
        const first = snapshot[0];
        if (first) { setColumns2(first.columns); setResults2(first.data.slice()); }
      }
    };

    // Rust pushes a batch every 500 rows (`STREAM_BATCH`), so a run returning 79k rows delivers ~159
    // of them — and mirroring each one straight into state was ~159 React commits, every one
    // re-rendering the editor and the result grid to display the same 50 rows, plus one copy of the
    // whole first result set each time. Measured at ~9-18ms per commit, that is seconds of the
    // "transfer" figure in the status bar, spent on frames nobody can see: the screen repaints at
    // ~16ms and the numbers scroll past unread anyway.
    //
    // Leading-edge throttle, deliberately: the FIRST batch still lands immediately, so results
    // appear as fast as they ever did; only the flood behind it is coalesced. Rows are never
    // dropped — `acc` keeps accumulating and the final `flushNow()` after the stream ends mirrors
    // whatever the last window was still holding.
    const FLUSH_INTERVAL_MS = 120;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushPending = false;

    const flush = () => {
      if (flushTimer !== null) { flushPending = true; return; }
      flushNow();
      flushTimer = setTimeout(function tick() {
        flushTimer = null;
        if (flushPending) { flushPending = false; flush(); }
      }, FLUSH_INTERVAL_MS);
    };

    const stopFlushing = () => {
      if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
      flushPending = false;
    };

    try {
      await dbHelper.executeQueryStream(connId, textToRun, queryId, (msg) => {
        if (msg.type === 'columns') {
          const i = msg.stmtIndex ?? 0;
          acc[i] = { query: msg.query || '', columns: msg.columns || [], data: [] };
          flush();
        } else if (msg.type === 'rows') {
          if (tFirst === 0) tFirst = performance.now();
          const i = msg.stmtIndex ?? 0;
          if (!acc[i]) acc[i] = { query: '', columns: [], data: [] };
          acc[i].data.push(...(msg.rows || []));
          flush();
        } else if (msg.type === 'affected') {
          // A writing statement (INSERT/UPDATE/DELETE/DDL): no columns or rows, only an affected count.
          if (tFirst === 0) tFirst = performance.now();
          const i = msg.stmtIndex ?? 0;
          acc[i] = { query: msg.query || '', columns: [], data: [], affected: msg.affected ?? 0 };
          flush();
        } else if (msg.type === 'error') {
          errText = msg.message || t('sqlEditor.errUnknownExec');
          markStreamEnd();
        } else if (msg.type === 'done') {
          cancelled = !!msg.cancelled;
          markStreamEnd();
        }
      }, params);
      await streamEnded;
    } catch (e: any) {
      errText = t('sqlEditor.errQuery', { message: String(e) });
    }

    // One last mirror, unthrottled: whatever the final window was still holding has to reach state,
    // and the pending timer must not fire into a run that is already over.
    stopFlushing();
    flushNow();

    const totalRows = acc.reduce((s, r) => s + r.data.length, 0);
    const affectedTotal = acc.reduce((s, r) => s + (r.affected || 0), 0);
    const elapsed = performance.now() - t0;
    const execMs = tFirst > 0 ? tFirst - t0 : elapsed;
    const timeInfo = t('sqlEditor.timeInfo', { exec: execMs.toFixed(0), load: elapsed.toFixed(0) });
    const n = acc.length;

    const setLoad = isPane1 ? setLoading : setLoading2;
    const setErr = isPane1 ? setErrorMsg : setErrorMsg2;
    const setStat = isPane1 ? setStatusMsg : setStatusMsg2;
    const setRunId = isPane1 ? setRunningQueryId : setRunningQueryId2;

    setLoad(false);
    setRunId(null);

    // The run's outcome lands on the history row created when it started: the status dot, the timing
    // and the row count all appear right there in the history drawer.
    setHistoryList(recordHistoryResult(historyId, {
      // Pressing Stop is neither success nor failure -> leave it blank rather than putting a green
      // tick on a run that never finished.
      ok: errText ? false : (cancelled ? undefined : true),
      ms: Math.round(execMs),
      rows: totalRows,
      affected: affectedTotal,
      error: errText || undefined,
    }));

    if (errText) {
      setErr(errText);
      if (acc.length > 0 && onRunSuccess) onRunSuccess();
    } else {
      const head = cancelled
        ? t('sqlEditor.stopped')
        : (n > 1 ? t('sqlEditor.execOkMulti', { n }) : t('sqlEditor.execOk'));
      const parts: string[] = [];
      if (affectedTotal > 0) parts.push(t('sqlEditor.affectedPart', { n: affectedTotal.toLocaleString(locale) }));
      const detailsStr = parts.length > 0 ? ` — ${parts.join(', ')}` : '';
      setStat(`${head}${detailsStr} (${timeInfo}).`);
      if (onRunSuccess) onRunSuccess();
    }

    // The statement just run changed the structure (DDL) or the database (USE / search_path) -> clear
    // the catalog cache so completion and hover see the new tables and columns at once, without
    // waiting for the TTL.
    //
    // The event carries the same news to the Sidebar, which otherwise only refetches on a rename or
    // a restore: a `CREATE TEMP TABLE` run here has to make the Temporary section appear, and the
    // matching `DROP` has to make it disappear, without the user reaching for Refresh. `connId` is
    // on the detail because every listener filters on it — a DDL statement on one connection must
    // not make every other sidebar refetch.
    if (isSchemaChangingSql(textToRun)) {
      catalog.invalidateCatalog();
      window.dispatchEvent(new CustomEvent('schema-changed', { detail: { connId } }));
    }
  };

  const handleExplain = async (paneId: 1 | 2 = focusedEditor, variant: 'explain' | 'analyze' | 'json' = 'explain', skipUnsafeCheck = false) => {
    // Same resolution as the Run button, selection included.
    const textToRun = getTextToRun(paneId);
    if (!textToRun.trim()) return;

    // EXPLAIN ANALYZE REALLY executes the statement (Postgres: `EXPLAIN (… ANALYZE …)`, MySQL:
    // `EXPLAIN ANALYZE`) — `EXPLAIN ANALYZE DELETE FROM t` deletes real data. So it has to pass the
    // same two gates the Run button does. The other variants only fetch a plan and need neither.
    if (variant === 'analyze') {
      if ((readOnly || connReadOnly) && !isReadOnlySql(textToRun)) {
        // Two different switches block writes and they live in different places. Naming the wrong one
        // leaves the user toggling something that changes nothing.
        const msg = connReadOnly && !readOnly ? t('sqlEditor.errConnReadOnlyRun') : t('sqlEditor.errReadOnlyRun');
        if (paneId === 1) setErrorMsg(msg);
        else setErrorMsg2(msg);
        return;
      }
      // The same reason as in `handleRun`: let Safe Mode ask once rather than stacking two dialogs.
      if (!skipUnsafeCheck && !willPromptForSql(connId, textToRun)) {
        const items = findUnsafeStatements(textToRun);
        if (items.length > 0) {
          setUnsafePrompt({ pane: paneId, sql: textToRun, items, resume: 'analyze' });
          return;
        }
      }
    }

    // With Query Parameters on and placeholders in the statement -> prompt for values, then EXPLAIN the parameterized form.
    if (queryParamsConfig.enabled) {
      const detectedParams = extractQueryParams(textToRun, queryParamsConfig.patternIndex);
      if (detectedParams.length > 0) {
        setParamPromptData({ pane: paneId, originalSql: textToRun, params: detectedParams, action: 'explain', variant });
        return;
      }
    }

    await runExplainQuery(buildExplainQuery(textToRun, dbType, variant), paneId);
  };

  // Runs an already-built EXPLAIN (possibly with params bound at the driver level) and shows the plan.
  const runExplainQuery = async (explainQuery: string, paneId: 1 | 2, params?: any[]) => {
    const isPane1 = paneId === 1;
    if (isPane1) {
      setLoading(true);
      setErrorMsg(null);
    } else {
      setLoading2(true);
      setErrorMsg2(null);
    }

    try {
      const res = await dbHelper.executeQuery(connId, explainQuery, params);
      const rows = res.data || (res as any).rows || [];
      if (res.success && rows.length > 0) {
        const parsed = parseExplainOutput(rows, dbType);
        if (isPane1) {
          setExplainResult1(parsed);
          setActiveTabType1('explain');
          setHasRun(true);
        } else {
          setExplainResult2(parsed);
          setActiveTabType2('explain');
          setHasRun2(true);
        }
      } else {
        const err = res.error || t('sqlEditor.errExplainFailed');
        if (isPane1) setErrorMsg(err);
        else setErrorMsg2(err);
      }
    } catch (e: any) {
      const err = t('sqlEditor.errExplain', { message: e.message || e });
      if (isPane1) setErrorMsg(err);
      else setErrorMsg2(err);
    } finally {
      if (isPane1) setLoading(false);
      else setLoading2(false);
    }
  };

  const stopQuery = (paneId: 1 | 2 = focusedEditor) => {
    const qid = paneId === 1 ? runningQueryId : runningQueryId2;
    if (qid) dbHelper.cancelQuery(qid);
  };

  // The statement under the caret. It uses statementAt (which ignores a ';' inside a string or a
  // comment), so it no longer cuts wrongly on things like: WHERE note = 'a;b'
  const getCurrentStatement = (editor: any): string => {
    if (!editor) return '';
    const model = editor.getModel();
    const pos = editor.getPosition();
    if (!model || !pos) return '';
    const text = model.getValue();
    return statementAt(text, model.getOffsetAt(pos))?.text || '';
  };

  const getPaneEditor = (paneId: 1 | 2 = focusedEditor) => {
    return paneId === 2 ? editorRef2.current : editorRef.current;
  };

  // The content always comes from the editor itself (exact), with state as a fallback only, since it
  // is updated on the debounce's beat.
  const getPaneSql = (paneId: 1 | 2 = focusedEditor) => {
    const value = getPaneEditor(paneId)?.getValue?.();
    return typeof value === 'string' ? value : (paneId === 2 ? sql2 : sql);
  };

  // The SQL the user means to act on: the selection when there is one, otherwise the
  // statement under the caret. Shared by Run and EXPLAIN — EXPLAIN used to read only the
  // statement under the caret, so selecting a sub-query and explaining it analysed the
  // whole statement instead, silently disagreeing with what the Run button would execute.
  const getTextToRun = (paneId: 1 | 2 = focusedEditor): string => {
    const editor = getPaneEditor(paneId);
    if (!editor) return paneId === 2 ? sql2 : sql;
    const selection = editor.getSelection();
    const selectedText = selection ? editor.getModel().getValueInRange(selection) : '';
    return selectedText.trim() ? selectedText : getCurrentStatement(editor);
  };

  const handleRun = (paneId: 1 | 2 = focusedEditor) => {
    const editor = getPaneEditor(paneId);
    if (!editor) return;
    flushSqlSync(paneId); // running -> push the content out to the state/parent right away
    executeSql(getTextToRun(paneId), paneId);
  };

  const runAll = (paneId: 1 | 2 = focusedEditor) => {
    setRunMenuPane(null);
    const editor = getPaneEditor(paneId);
    if (editor) executeSql(editor.getValue(), paneId);
  };

  const runCurrent = (paneId: 1 | 2 = focusedEditor) => {
    setRunMenuPane(null);
    handleRun(paneId);
  };

  const handleQuickFavorite = (paneId: 1 | 2 = focusedEditor) => {
    setRunMenuPane(null);
    const val = getPaneSql(paneId);
    const setMsg = paneId === 1 ? setStatusMsg : setStatusMsg2;
    if (!val.trim()) {
      setMsg(t('sqlEditor.errNoSqlToFavorite'));
      setTimeout(() => setMsg(null), 3000);
      return;
    }
    const name = t('sqlEditor.favoriteName', { date: new Date().toLocaleString(locale) });
    setSavedQueries(addSavedQuery(name, val, connKey, dbName, Date.now().toString()));
    setMsg(t('sqlEditor.addedFavorite', { name }));
    setTimeout(() => setMsg(null), 3000);
  };

  const handleBeautify = (paneId: 1 | 2 = focusedEditor) => {
    const editor = getPaneEditor(paneId);
    if (!editor) return;
    const setMsg = paneId === 1 ? setStatusMsg : setStatusMsg2;
    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) {
      const selectedText = editor.getModel()?.getValueInRange(selection) || '';
      const formatted = formatSql(selectedText, dbType);
      editor.pushUndoStop();
      editor.executeEdits('format-beautify', [{
        range: selection,
        text: formatted,
        forceMoveMarkers: true
      }]);
      editor.pushUndoStop();
      setMsg(formatted === selectedText
        ? t('sqlEditor.errBeautifySelection')
        : t('sqlEditor.beautifiedSelection'));
    } else {
      const val = editor.getValue();
      const formatted = formatSql(val, dbType);
      // executeEdits rather than setValue, so Ctrl+Z can undo this beautify
      editor.pushUndoStop();
      editor.executeEdits('format-beautify', [{
        range: editor.getModel().getFullModelRange(),
        text: formatted,
        forceMoveMarkers: true
      }]);
      editor.pushUndoStop();
      if (paneId === 1) { setSql(formatted); onSqlChange?.(formatted); }
      else { setSql2(formatted); onSql2Change?.(formatted); }
      setMsg(formatted === val
        ? t('sqlEditor.errBeautifyAll')
        : t('sqlEditor.beautifiedAll'));
    }
    setTimeout(() => setMsg(null), 3000);
  };

  const handleMinify = (paneId: 1 | 2 = focusedEditor) => {
    const editor = getPaneEditor(paneId);
    if (!editor) return;
    const setMsg = paneId === 1 ? setStatusMsg : setStatusMsg2;
    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) {
      const selectedText = editor.getModel()?.getValueInRange(selection) || '';
      const minified = minifySql(selectedText);
      editor.pushUndoStop();
      editor.executeEdits('format-minify', [{
        range: selection,
        text: minified,
        forceMoveMarkers: true
      }]);
      editor.pushUndoStop();
      setMsg(t('sqlEditor.minifiedSelection'));
    } else {
      const val = editor.getValue();
      const minified = minifySql(val);
      editor.pushUndoStop();
      editor.executeEdits('format-minify', [{
        range: editor.getModel().getFullModelRange(),
        text: minified,
        forceMoveMarkers: true
      }]);
      editor.pushUndoStop();
      if (paneId === 1) { setSql(minified); onSqlChange?.(minified); }
      else { setSql2(minified); onSql2Change?.(minified); }
      setMsg(t('sqlEditor.minifiedAll'));
    }
    setTimeout(() => setMsg(null), 3000);
  };

  const handleCopySql = (paneId: 1 | 2 = focusedEditor) => {
    const val = getPaneSql(paneId);
    const setMsg = paneId === 1 ? setStatusMsg : setStatusMsg2;
    if (val) {
      navigator.clipboard.writeText(val);
      setMsg(t('sqlEditor.copiedSql'));
      setTimeout(() => setMsg(null), 3000);
    }
  };

  const handlePasteSql = async (paneId: 1 | 2 = focusedEditor) => {
    const setMsg = paneId === 1 ? setStatusMsg : setStatusMsg2;
    try {
      const text = await navigator.clipboard.readText();
      const editor = getPaneEditor(paneId);
      if (editor) {
        editor.setValue(text);
        if (paneId === 1) {
          setSql(text);
          onSqlChange?.(text);
        } else {
          setSql2(text);
          onSql2Change?.(text);
        }
        setMsg(t('sqlEditor.pastedSql'));
        setTimeout(() => setMsg(null), 3000);
      }
    } catch {
      setMsg(t('sqlEditor.errClipboardRead'));
      setTimeout(() => setMsg(null), 3000);
    }
  };

  const handleClear = (paneId: 1 | 2 = focusedEditor) => {
    const editor = getPaneEditor(paneId);
    if (editor) {
      editor.setValue('');
      if (paneId === 1) {
        setSql('');
        onSqlChange?.('');
      } else {
        setSql2('');
        onSql2Change?.('');
      }
    }
  };

  const renderPaneActionBar = (paneId: 1 | 2) => {
    return (
      <div className="sql-toolbar-wrap">
        <div className="sql-pane-action-bar">
          {/* Left block: the settings Sliders icon and the caret position (line X, column Y) */}
          <div className="sql-toolbar-left">
            <div className="gp-popover-wrap">
              <button
                onClick={(e) => {
                  setRunMenuPane(null);
                  setMoreMenuPane(null);
                  setFormatMenuPane(null);
                  setLimitMenuPane(null);
                  toggleDropdown('settings', paneId, e, setEditorSettingsMenuPane);
                }}
                className="sql-sliders-btn"
                title={t('sqlEditor.settingsTitle', 'Cấu hình Editor & Lưới')}
              >
                <SlidersHorizontal size={14} />
              </button>

              {/* TablePlus Editor & Grid Settings Popover Menu (Image 3) */}
              {editorSettingsMenuPane === paneId && (
                <>
                  <div className="sql-menu-overlay" onClick={() => setEditorSettingsMenuPane(null)} />
                  <div className="ws-menu" style={{
                    position: 'absolute',
                    top: dropdownPlacement[`settings_${paneId}`] === 'up' ? undefined : 'calc(100% + 4px)',
                    bottom: dropdownPlacement[`settings_${paneId}`] === 'up' ? 'calc(100% + 4px)' : undefined,
                    left: 0,
                    minWidth: '230px',
                    display: 'flex',
                    flexDirection: 'column',
                    padding: '4px 0',
                    fontSize: '12px',
                    // MUST stay above `.sql-menu-overlay`, which is `position: fixed; inset: 0;
                    // z-index: 9998` — a sheet over the whole window whose only job is to close the
                    // menu on an outside click. At 999 it covered this menu instead (the wrapper is
                    // only `position: relative`, so it opens no stacking context and the two
                    // z-indexes compare directly), and every click in the popover hit the sheet: the
                    // menu just closed. The font-size `<select>` is where it showed, because a
                    // native select has to open a dropdown of its own and visibly never did.
                    // Every other menu in this file pairs 9998 with 9999; this one was a digit short.
                    zIndex: 9999,
                  }}>
                    {/* Font size */}
                    <div style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span>{t('sqlEditor.fontSize', 'Font size')}</span>
                      <select
                        value={editorFontSize}
                        onChange={(e) => setEditorFontSize(Number(e.target.value))}
                        style={{ background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '3px', padding: '1px 4px', fontSize: '11px' }}
                      >
                        <option value="11">11px</option>
                        <option value="12">12px</option>
                        <option value="13">13px (Default)</option>
                        <option value="14">14px</option>
                        <option value="15">15px</option>
                        <option value="16">16px</option>
                      </select>
                    </div>

                    <div className="sql-menu-divider" />

                    <button className="copy-dropdown-item" onClick={() => setShowInvisibleChars(v => !v)}>
                      <span className="sql-item-check">{showInvisibleChars ? '✓' : ''}</span>
                      <span>{t('sqlEditor.showInvisibleChars', 'Show invisible Characters')}</span>
                    </button>

                    <button className="copy-dropdown-item" onClick={() => setWordWrap(v => !v)}>
                      <span className="sql-item-check">{wordWrap ? '✓' : ''}</span>
                      <span>{t('sqlEditor.wrapLines', 'Wrap lines to Editor Width')}</span>
                    </button>

                    <button className="copy-dropdown-item" onClick={() => setHighlightQuery(v => !v)}>
                      <span className="sql-item-check">{highlightQuery ? '✓' : ''}</span>
                      <span>{t('sqlEditor.highlightQuery', 'Highlight current Query')}</span>
                    </button>

                    <div className="sql-menu-divider" />

                    <button className="copy-dropdown-item" onClick={() => setShowRowNumbers(v => !v)}>
                      <span className="sql-item-check">{showRowNumbers ? '✓' : ''}</span>
                      <span>{t('sqlEditor.showRowNumbers', 'Show result Row Numbers')}</span>
                    </button>

                    <button className="copy-dropdown-item" onClick={() => {
                      if (paneId === 1) setAutoFitColsPane1(v => !v);
                      else setAutoFitColsPane2(v => !v);
                      setEditorSettingsMenuPane(null);
                    }}>
                      <span className="sql-item-check">{(paneId === 1 ? autoFitColsPane1 : autoFitColsPane2) ? '✓' : ''}</span>
                      <span>{t('sqlEditor.autoFitColumns', 'Auto-fit Column Widths')}</span>
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* status cursor position: line X, column Y (Image 2) */}
            <CaretReadout store={caretStores[paneId]} />
          </div>

          {/* Right block: the No-limit button plus the Format, Run and [...] cluster */}
          <div className="sql-toolbar-right">
            {/* The No-limit / row-limit button */}
            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-secondary"
                onClick={(e) => {
                  setRunMenuPane(null);
                  setMoreMenuPane(null);
                  setFormatMenuPane(null);
                  toggleDropdown('limit', paneId, e, setLimitMenuPane);
                }}
                style={{
                  padding: '0 10px',
                  fontSize: '12px',
                  height: '26px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px'
                }}
                title={t('sqlEditor.queryLimitTitle', 'Giới hạn số dòng trả về')}
              >
                <span>{paneId === 1 ? limitPane1 : limitPane2}</span>
                <span style={{ fontSize: '8px', opacity: 0.7 }}>▼</span>
              </button>
              {limitMenuPane === paneId && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setLimitMenuPane(null)} />
                  <div style={{
                    position: 'absolute',
                    top: dropdownPlacement[`limit_${paneId}`] === 'up' ? undefined : 'calc(100% + 4px)',
                    bottom: dropdownPlacement[`limit_${paneId}`] === 'up' ? 'calc(100% + 4px)' : undefined,
                    left: 0,
                    minWidth: '130px',
                    background: 'var(--win-bg-popover, var(--win-bg-card))',
                    border: '1px solid var(--win-border-strong, var(--win-border))',
                    borderRadius: '6px',
                    boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
                    zIndex: 9999,
                    padding: '4px 0'
                  }}>
                    {['No limit', '100 rows', '500 rows', '1,000 rows', '5,000 rows', '10,000 rows'].map(opt => (
                      <button
                        key={opt}
                        className={`context-menu-item ${(paneId === 1 ? limitPane1 : limitPane2) === opt ? 'active' : ''}`}
                        onClick={() => {
                          if (paneId === 1) setLimitPane1(opt);
                          else setLimitPane2(opt);
                          setLimitMenuPane(null);
                        }}
                        style={{ padding: '6px 12px', width: '100%', textAlign: 'left', fontSize: '12px' }}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* The [...] overflow menu, gathering Parameters, Split pane, History, Copy, Paste and Clear */}
            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-secondary"
                onClick={(e) => {
                  setRunMenuPane(null);
                  setFormatMenuPane(null);
                  setSplitMenuPane(null);
                  setLimitMenuPane(null);
                  toggleDropdown('more', paneId, e, setMoreMenuPane);
                }}
                style={{ padding: '0 8px', fontSize: '12px', height: '26px', display: 'flex', alignItems: 'center', gap: '4px' }}
                title={t('sqlEditor.moreActions')}
              >
                <MoreHorizontal size={14} />
              </button>
              {moreMenuPane === paneId && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setMoreMenuPane(null)} />
                  <div style={{
                    position: 'absolute',
                    top: dropdownPlacement[`more_${paneId}`] === 'up' ? undefined : 'calc(100% + 4px)',
                    bottom: dropdownPlacement[`more_${paneId}`] === 'up' ? 'calc(100% + 4px)' : undefined,
                    right: 0,
                    minWidth: '200px',
                    background: 'var(--win-bg-popover, var(--win-bg-card))',
                    border: '1px solid var(--win-border-strong, var(--win-border))',
                    borderRadius: '6px',
                    boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
                    zIndex: 9999,
                    padding: '4px 0'
                  }}>
                    {/* The Split pane entry */}
                    <div style={{ padding: '4px 12px 2px 12px', fontSize: '10px', fontWeight: 700, color: 'var(--win-text-disabled)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      Chia khung (Split Panes)
                    </div>
                    <button
                      className={`context-menu-item ${splitMode === 'none' ? 'active' : ''}`}
                      onClick={() => { setMoreMenuPane(null); setSplitMode('none'); onSplitModeChange?.('none'); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}
                    >
                      <Square size={13} style={{ flexShrink: 0 }} />
                      <span>{t('sqlEditor.singlePane')}</span>
                    </button>
                    <button
                      className={`context-menu-item ${splitMode === 'vertical' ? 'active' : ''}`}
                      onClick={() => { setMoreMenuPane(null); setSplitMode('vertical'); onSplitModeChange?.('vertical'); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}
                    >
                      <Columns size={13} style={{ flexShrink: 0 }} />
                      <span>{t('sqlEditor.splitVertical')}</span>
                    </button>
                    <button
                      className={`context-menu-item ${splitMode === 'horizontal' ? 'active' : ''}`}
                      onClick={() => { setMoreMenuPane(null); setSplitMode('horizontal'); onSplitModeChange?.('horizontal'); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}
                    >
                      <Rows size={13} style={{ flexShrink: 0 }} />
                      <span>Chia ngang (Top / Bottom)</span>
                    </button>

                    <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />
                    <button className="context-menu-item" onClick={() => { setMoreMenuPane(null); setShowQueryParamsConfigModal(true); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}>
                      <Settings size={12} style={{ flexShrink: 0, color: queryParamsConfig.enabled ? 'var(--win-accent)' : undefined }} />
                      <span>{t('sqlEditor.paramOptions')}</span>
                    </button>

                    <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />
                    <button className="context-menu-item" onClick={() => { setMoreMenuPane(null); handleCopySql(paneId); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}>
                      <Copy size={12} style={{ flexShrink: 0 }} />
                      <span>{t('sqlEditor.copySql')}</span>
                    </button>
                    <button className="context-menu-item" onClick={() => { setMoreMenuPane(null); handlePasteSql(paneId); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}>
                      <Clipboard size={12} style={{ flexShrink: 0 }} />
                      <span>{t('sqlEditor.pasteSql')}</span>
                    </button>
                    <button className="context-menu-item" onClick={() => { setMoreMenuPane(null); handleClear(paneId); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}>
                      <Trash2 size={12} style={{ flexShrink: 0 }} />
                      <span>{t('sqlEditor.clearAll')}</span>
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* The SQL formatting menu: Beautify / Minify */}
            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-secondary"
                onClick={(e) => {
                  setRunMenuPane(null);
                  setMoreMenuPane(null);
                  setSplitMenuPane(null);
                  setLimitMenuPane(null);
                  toggleDropdown('format', paneId, e, setFormatMenuPane);
                }}
                style={{ padding: '0 10px', fontSize: '12px', height: '26px', display: 'flex', alignItems: 'center', gap: '5px' }}
                title={t('sqlEditor.formatTitle')}
              >
                <AlignLeft size={12} />
                <span>{t('sqlEditor.format')}</span>
                <span style={{ fontSize: '7px', opacity: 0.7 }}>▼</span>
              </button>
              {formatMenuPane === paneId && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setFormatMenuPane(null)} />
                  <div style={{
                    position: 'absolute',
                    top: dropdownPlacement[`format_${paneId}`] === 'up' ? undefined : 'calc(100% + 4px)',
                    bottom: dropdownPlacement[`format_${paneId}`] === 'up' ? 'calc(100% + 4px)' : undefined,
                    right: 0,
                    width: 'max-content',
                    minWidth: '270px',
                    background: 'var(--win-bg-popover, var(--win-bg-card))',
                    border: '1px solid var(--win-border-strong, var(--win-border))',
                    borderRadius: '6px',
                    boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
                    zIndex: 9999,
                    padding: '4px 0',
                    boxSizing: 'border-box'
                  }}>
                    <button
                      className="context-menu-item"
                      onClick={() => { setFormatMenuPane(null); handleBeautify(paneId); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}
                    >
                      <AlignLeft size={13} style={{ flexShrink: 0 }} />
                      <span>{t('sqlEditor.beautify')}</span>
                      <kbd style={{ marginLeft: 'auto', paddingLeft: '16px', flexShrink: 0, fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'inherit' }}>Ctrl+Shift+F</kbd>
                    </button>
                    <button
                      className="context-menu-item"
                      onClick={() => { setFormatMenuPane(null); handleMinify(paneId); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}
                    >
                      <Rows size={13} style={{ flexShrink: 0 }} />
                      <span>{t('sqlEditor.minify')}</span>
                      <kbd style={{ marginLeft: 'auto', paddingLeft: '16px', flexShrink: 0, fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'inherit' }}>Ctrl+Shift+M</kbd>
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* The Snippets button (SQL templates) */}
            <button
              className={`btn ${showSnippetPanel ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setShowSnippetPanel(!showSnippetPanel)}
              style={{ padding: '0 8px', fontSize: '11.5px', height: '26px', display: 'flex', alignItems: 'center', gap: '4px' }}
              title="Mở thư viện mẫu SQL Snippet"
            >
              <span style={{ fontWeight: 700, fontSize: '12px', color: showSnippetPanel ? '#ffffff' : '#10b981' }}>()</span>
              <span>Snippets</span>
            </button>

            {/* The split button: Run SQL / run options, in the FAR RIGHT corner */}
            <div style={{ position: 'relative', display: 'flex' }}>
              <button
                className="btn btn-primary btn-join-l"
                onClick={() => handleRun(paneId)}
                disabled={paneId === 1 ? loading : loading2}
                style={{ display: 'flex', alignItems: 'center', padding: '0 12px', height: '26px', fontSize: '12px' }}
                title={t('sqlEditor.runCurrentTitle')}
              >
                <Play size={12} fill="currentColor" />
                <span>{t('sqlEditor.run')}</span>
              </button>
              <button
                className="btn btn-primary btn-join-r"
                onClick={(e) => {
                  setMoreMenuPane(null);
                  setSplitMenuPane(null);
                  setFormatMenuPane(null);
                  setLimitMenuPane(null);
                  toggleDropdown('run', paneId, e, setRunMenuPane);
                }}
                disabled={paneId === 1 ? loading : loading2}
                style={{ padding: '0 8px', display: 'flex', alignItems: 'center', height: '26px' }}
                title={t('sqlEditor.runOptions')}
              >
                <ChevronDown size={12} />
              </button>
              {runMenuPane === paneId && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setRunMenuPane(null)} />
                  <div className="sql-run-menu" style={{
                    position: 'absolute',
                    top: dropdownPlacement[`run_${paneId}`] === 'up' ? undefined : 'calc(100% + 4px)',
                    bottom: dropdownPlacement[`run_${paneId}`] === 'up' ? 'calc(100% + 4px)' : undefined,
                    right: 0,
                    width: 'max-content',
                    minWidth: '240px',
                    background: 'var(--win-bg-popover, var(--win-bg-card))',
                    border: '1px solid var(--win-border-strong, var(--win-border))',
                    borderRadius: '6px',
                    boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
                    zIndex: 9999,
                    padding: '4px 0',
                    boxSizing: 'border-box'
                  }}>
                    <button className="context-menu-item" onClick={() => { setRunMenuPane(null); runCurrent(paneId); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}>
                      <Play size={13} style={{ flexShrink: 0 }} />
                      <span>{t('sqlEditor.runCurrent')}</span>
                      <kbd style={{ marginLeft: 'auto', paddingLeft: '12px', fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'inherit' }}>Ctrl+Enter</kbd>
                    </button>
                    <button className="context-menu-item" onClick={() => { setRunMenuPane(null); runAll(paneId); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}>
                      <Zap size={13} style={{ flexShrink: 0, color: 'var(--st-warn)' }} />
                      <span>{t('sqlEditor.runAll')}</span>
                      <kbd style={{ marginLeft: 'auto', paddingLeft: '12px', fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'inherit' }}>Ctrl+Shift+Enter</kbd>
                    </button>

                    <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />
                    <div style={{ padding: '4px 12px 2px 12px', fontSize: '10px', fontWeight: 700, color: 'var(--win-text-disabled)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      {t('sqlEditor.explainHeading')}
                    </div>

                    <button
                      className="context-menu-item"
                      onClick={() => { setRunMenuPane(null); handleExplain(paneId, 'explain'); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}
                    >
                      <Network size={13} style={{ flexShrink: 0, color: 'var(--win-accent)' }} />
                      <span>{t('sqlEditor.explainEstimate')}</span>
                      <kbd style={{ marginLeft: 'auto', paddingLeft: '12px', fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'inherit' }}>Ctrl+Alt+E</kbd>
                    </button>
                    <button
                      className="context-menu-item"
                      onClick={() => { setRunMenuPane(null); handleExplain(paneId, 'analyze'); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}
                    >
                      <Zap size={13} style={{ flexShrink: 0, color: 'var(--st-ok)' }} />
                      <span>{t('sqlEditor.explainAnalyze')}</span>
                    </button>
                    {supportsJsonExplain(dbType) && (
                      <button
                        className="context-menu-item"
                        onClick={() => { setRunMenuPane(null); handleExplain(paneId, 'json'); }}
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}
                      >
                        <FileText size={13} style={{ flexShrink: 0 }} />
                        <span>{explainJsonLabel(dbType)}</span>
                      </button>
                    )}

                    <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />
                    <button className="context-menu-item" onClick={() => { setRunMenuPane(null); handleQuickFavorite(paneId); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}>
                      <Star size={13} style={{ flexShrink: 0 }} />
                      <span>{t('sqlEditor.addFavorite')}</span>
                    </button>
                    <button className="context-menu-item" onClick={() => { setRunMenuPane(null); handleSaveQuery(); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}>
                      <Bookmark size={13} style={{ flexShrink: 0 }} />
                      <span>{t('sqlEditor.saveQuery')}</span>
                      <kbd style={{ marginLeft: 'auto', paddingLeft: '12px', fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'inherit' }}>Ctrl+S</kbd>
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* The Stop button, shown while a query is running */}
            {(paneId === 1 ? loading : loading2) && (
              <button
                className="btn btn-secondary"
                onClick={() => stopQuery(paneId)}
                style={{ padding: '2px 8px', fontSize: '11px', height: '24px', display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--st-danger)', borderColor: 'var(--st-danger)' }}
                title={t('sqlEditor.stopTitle')}
              >
                <X size={12} />
                <span>{t('sqlEditor.stop')}</span>
              </button>
            )}
          </div>
        </div>

        {/* The drag resizer line (isDraggingResizer) sits on the LOWER divider between the action bar and the results */}
        <div
          onMouseDown={(e) => handleInnerResizerMouseDown(e, paneId)}
          style={{
            height: '4px',
            cursor: 'row-resize',
            background: isDraggingResizer ? 'var(--win-accent, #3b82f6)' : 'var(--win-border-light, rgba(229, 231, 235, 0.5))',
            flexShrink: 0,
            userSelect: 'none',
            transition: 'background 0.15s ease',
            position: 'relative',
            zIndex: 10
          }}
          title={t('sqlEditor.resizeEditorTitle', 'Kéo để thay đổi chiều cao')}
        />
      </div>
    );
  };

  const handleTabChange = (index: number, paneId: 1 | 2 = 1) => {
    // Each result tab is a different statement, possibly on a different table — the cell-edit buffer
    // does not carry over.
    discardEdits(paneId);
    if (paneId === 1) {
      setActiveTabIndex(index);
      setPage(1);
      const targetResult = allResults[index];
      if (targetResult) {
        setResults(targetResult.data || []);
        setColumns(targetResult.columns || []);
      }
    } else {
      setActiveTabIndex2(index);
      setPage2(1);
      const targetResult = allResults2[index];
      if (targetResult) {
        setResults2(targetResult.data || []);
        setColumns2(targetResult.columns || []);
      }
    }
  };


  const handleCopyAs = (format: 'table' | 'object' | 'array', paneId: 1 | 2 = 1) => {
    const curResults = paneId === 1 ? results : results2;
    const curColumns = paneId === 1 ? columns : columns2;
    if (curResults.length === 0) return;

    let textToCopy = '';
    let successMsg = '';

    if (format === 'table') {
      const headers = curColumns.join('\t');
      const rows = curResults.map(row =>
        curColumns.map(col => {
          const val = row[col];
          return val === null ? 'NULL' : String(val).replace(/\t/g, ' ').replace(/\n/g, ' ');
        }).join('\t')
      ).join('\n');
      textToCopy = `${headers}\n${rows}`;
      successMsg = t('sqlEditor.copiedTable');
    } else if (format === 'object') {
      textToCopy = JSON.stringify(curResults, null, 2);
      successMsg = t('sqlEditor.copiedJsonObject');
    } else if (format === 'array') {
      let arrayData;
      if (curColumns.length === 1) {
        const singleCol = curColumns[0];
        arrayData = curResults.map(row => row[singleCol]);
      } else {
        arrayData = curResults.map(row => curColumns.map(col => row[col]));
      }
      textToCopy = JSON.stringify(arrayData, null, 2);
      successMsg = t('sqlEditor.copiedJsonArray', {
        shape: curColumns.length === 1 ? t('sqlEditor.arrayShape1d') : t('sqlEditor.arrayShape2d'),
      });
    }

    navigator.clipboard.writeText(textToCopy);
    if (paneId === 1) {
      setStatusMsg(successMsg);
      setTimeout(() => setStatusMsg(null), 3000);
    } else {
      setStatusMsg2(successMsg);
      setTimeout(() => setStatusMsg2(null), 3000);
    }
  };

  const handleExportCsv = (paneId: 1 | 2 = 1) => {
    const curResults = paneId === 1 ? results : results2;
    const curColumns = paneId === 1 ? columns : columns2;
    if (curResults.length === 0) return;
    const headers = curColumns.map(c => `"${c.replace(/"/g, '""')}"`).join(',');
    const rows = curResults.map(row =>
      curColumns.map(col => {
        const val = row[col];
        if (val === null) return '""';
        return `"${String(val).replace(/"/g, '""')}"`;
      }).join(',')
    ).join('\n');
    // The BOM belongs in the template, not concatenated onto it \u2014 Excel needs it to read UTF-8.
    const csvContent = `\uFEFF${headers}\n${rows}`;
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `query_result_pane${paneId}_${Date.now()}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    if (paneId === 1) {
      setStatusMsg(t('sqlEditor.downloadedCsv', { pane: 1 }));
      setTimeout(() => setStatusMsg(null), 3000);
    } else {
      setStatusMsg2(t('sqlEditor.downloadedCsv', { pane: 2 }));
      setTimeout(() => setStatusMsg2(null), 3000);
    }
  };

  const handleExportJson = (paneId: 1 | 2 = 1) => {
    const curResults = paneId === 1 ? results : results2;
    if (curResults.length === 0) return;
    const jsonContent = JSON.stringify(curResults, null, 2);
    const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `query_result_pane${paneId}_${Date.now()}.json`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    if (paneId === 1) {
      setStatusMsg(t('sqlEditor.downloadedJson', { pane: 1 }));
      setTimeout(() => setStatusMsg(null), 3000);
    } else {
      setStatusMsg2(t('sqlEditor.downloadedJson', { pane: 2 }));
      setTimeout(() => setStatusMsg2(null), 3000);
    }
  };

  /** Jumps to the parent row / referenced table when a foreign-key cell is clicked */
  const handleFkClick = async (colName: string, cellVal: any, pTargetTable?: string, _paneId: 1 | 2 = 1) => {
    if (cellVal === null || cellVal === undefined || String(cellVal).trim() === '') return;

    let targetTable = '';
    let targetCol = colName;

    // 1. Look in the current table's foreign keys in the catalog
    if (pTargetTable) {
      const schema = catalog.getCachedSchema(connId, pTargetTable) || await catalog.getSchema(connId, pTargetTable);
      if (schema && schema.foreignKeys) {
        // The field names have to match get_full_catalog's JSON: column / refTable / refColumn
        // (see SchemaInfo in dbHelper.ts and the json! in database.rs).
        const fk = schema.foreignKeys.find(
          (f) => (f.column || '').toLowerCase() === colName.toLowerCase()
        );
        if (fk?.refTable) {
          targetTable = fk.refTable;
          if (fk.refColumn) targetCol = fk.refColumn;
        }
      }
    }

    // 2. Fall back to the naming convention (e.g. language_id -> table language, column language_id)
    if (!targetTable) {
      if (colName.toLowerCase().endsWith('_id')) {
        targetTable = colName.substring(0, colName.length - 3);
      } else {
        targetTable = colName;
      }
    }

    // 3. With the target column still unknown, check the target table's schema to use the right column or its PK
    if (targetTable) {
      const targetSchema = catalog.getCachedSchema(connId, targetTable) || await catalog.getSchema(connId, targetTable);
      if (targetSchema && targetSchema.columns && targetSchema.columns.length > 0) {
        const hasCol = targetSchema.columns.some((c: any) => c.name.toLowerCase() === colName.toLowerCase());
        if (hasCol) {
          targetCol = colName;
        } else {
          const pkCol = targetSchema.columns.find((c: any) => c.isPrimaryKey);
          if (pkCol) targetCol = pkCol.name;
        }
      }
    }

    // Opens a data tab on the referenced table with a filter applied (WHERE targetCol = cellVal),
    // rather than overwriting the SQL currently in the editor.
    window.dispatchEvent(new CustomEvent('open-table-tab', {
      detail: {
        table: targetTable,
        viewMode: 'data',
        initialFilter: { column: targetCol || colName, value: cellVal }
      }
    }));
  };

  // ─── Editing directly in the result grid ───────────────────────────────────────────

  /** Editability of the result tab currently shown in a pane. Pure — safe to call in render. */
  const editabilityOf = (query: string, cols: string[]): ResultEditability =>
    resolveResultEditability(query, cols, (tbl: string) => catalog.getCachedSchema(connId, tbl));

  /**
   * Same, plus the app-wide Read-only switch. Deliberately a separate wrapper rather than a
   * check inside `editabilityOf`: the schema-warming effect below keys off the *structural*
   * reason, so folding Read-only into it would stop the prefetch and leave the grid stuck on
   * `unknownTable` after the user turns Read-only back off.
   */
  const editabilityInMode = (query: string, cols: string[]): ResultEditability => {
    const e = editabilityOf(query, cols);
    if (!readOnly || !e.editable) return e;
    return { editable: false, reason: 'readOnlyMode', table: e.table };
  };

  // A table missing from the catalog cache reads as read-only. Fetch it in the background,
  // then bump the tick so the grid resolves again. `schemaTick` is deliberately NOT a
  // dependency: a table that genuinely cannot be introspected would loop forever.
  useEffect(() => {
    const wanted = new Set<string>();
    for (const [all, idx] of [[allResults, activeTabIndex], [allResults2, activeTabIndex2]] as const) {
      const r = all[idx];
      if (!r) continue;
      const e = editabilityOf(r.query || '', r.columns || []);
      if (!e.editable && e.reason === 'unknownTable' && e.table) wanted.add(e.table);
    }
    if (wanted.size === 0) return;
    let alive = true;
    Promise.all([...wanted].map(tbl => catalog.getSchema(connId, tbl))).then(() => {
      if (alive) setSchemaTick(x => x + 1);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allResults, activeTabIndex, allResults2, activeTabIndex2]);

  // Turning Read-only on drops the buffered cell edits. They cannot be saved any more, and the
  // grid stops rendering them as dirty (`pTarget` is null), so keeping them would leave state
  // the user can neither see nor discard — and it would come back when Read-only is turned off,
  // by then possibly on top of re-run rows.
  useEffect(() => {
    if (!readOnly) return;
    setEditingCell(null);
    setCellEdits({ 1: {}, 2: {} });
  }, [readOnly]);

  // The switch returns literal keys, NEVER an interpolated one (i18next has to be able to check each).
  const notEditableLabel = (reason: NotEditableReason, table?: string): string => {
    const v = { table: table || '' };
    switch (reason) {
      case 'readOnlyMode': return t('sqlEditor.whyReadOnlyMode');
      case 'notSelect': return t('sqlEditor.whyNotSelect');
      case 'notSimple': return t('sqlEditor.whyNotSimple');
      case 'multiTable': return t('sqlEditor.whyMultiTable');
      case 'derivedTable': return t('sqlEditor.whyDerivedTable');
      case 'computedColumns': return t('sqlEditor.whyComputedColumns');
      case 'unknownTable': return t('sqlEditor.whyUnknownTable', v);
      case 'noPrimaryKey': return t('sqlEditor.whyNoPrimaryKey', v);
      case 'pkNotSelected': return t('sqlEditor.whyPkNotSelected', v);
    }
  };

  const countEdits = (pane: 1 | 2) =>
    Object.values(cellEdits[pane]).reduce((n, cols) => n + Object.keys(cols).length, 0);

  const showEditMsg = (pane: 1 | 2, text: string, kind: 'ok' | 'err') => {
    setEditMsg({ pane, text, kind });
    setTimeout(() => setEditMsg(cur => (cur && cur.text === text ? null : cur)), 4000);
  };

  const startCellEdit = (pane: 1 | 2, rowKey: string, col: string, current: any) => {
    setEditingCell({ pane, rowKey, col });
    setEditValue(current === null || current === undefined ? '' : String(current));
  };

  /** `original` is the value straight off the row, i.e. before any buffered edit. */
  const saveCellEdit = (original: any, e?: React.FocusEvent) => {
    if (e?.relatedTarget && (e.relatedTarget as HTMLElement).closest('.grid-edit-wrapper')) {
      return;
    }
    if (!editingCell) return;
    const { pane, rowKey, col } = editingCell;
    setCellEdits(prev => {
      const paneEdits = { ...prev[pane] };
      const rowEdits = { ...paneEdits[rowKey] };
      // Typed back to the original value -> drop it, so the Save button never counts a no-op.
      if (String(original ?? '') === editValue) delete rowEdits[col];
      else rowEdits[col] = editValue;
      if (Object.keys(rowEdits).length === 0) delete paneEdits[rowKey];
      else paneEdits[rowKey] = rowEdits;
      return { ...prev, [pane]: paneEdits };
    });
    setEditingCell(null);
  };

  const discardEdits = (pane: 1 | 2) => {
    setCellEdits(prev => ({ ...prev, [pane]: {} }));
    setEditingCell(null);
  };

  const handleEditSave = async (pane: 1 | 2, table: string, primaryKey: string) => {
    if (readOnly) {
      showEditMsg(pane, t('sqlEditor.errEditReadOnly'), 'err');
      return;
    }
    const changes: GridChange[] = Object.entries(cellEdits[pane]).map(([rowKey, cols]) => ({
      type: 'update',
      rowId: rowKey,
      newData: cols,
    }));
    if (changes.length === 0) return;
    const preview = await dbHelper.commitChanges(connId, table, changes, primaryKey, true);
    if (!preview.success) {
      showEditMsg(pane, t('sqlEditor.errEditPreview', { message: preview.message }), 'err');
      return;
    }
    setEditCommit({ pane, table, primaryKey, sqls: preview.sqls || [], changes });
  };

  const handleEditCommitConfirm = async () => {
    if (!editCommit) return;
    const { pane, table, primaryKey, changes } = editCommit;
    setEditCommitting(true);
    const res = await dbHelper.commitChanges(connId, table, changes, primaryKey);
    setEditCommitting(false);
    setEditCommit(null);
    if (!res.success) {
      showEditMsg(pane, t('sqlEditor.errEditCommit', { message: res.message }), 'err');
      return;
    }

    // Write the saved values straight into the rows on screen instead of re-running the
    // statement: the values are already known, while a re-run would add a second history
    // entry for the same query and can be arbitrarily expensive.
    const paneEdits = cellEdits[pane];
    const patch = (list: any[]) => list.map(r => {
      const e = paneEdits[String(r[primaryKey])];
      return e ? { ...r, ...e } : r;
    });
    const idx = pane === 1 ? activeTabIndex : activeTabIndex2;
    const setRows = pane === 1 ? setResults : setResults2;
    const setAll = pane === 1 ? setAllResults : setAllResults2;
    setRows(prev => patch(prev));
    setAll(prev => prev.map((r, i) => (i === idx ? { ...r, data: patch(r.data || []) } : r)));

    setCellEdits(prev => ({ ...prev, [pane]: {} }));
    showEditMsg(pane, t('sqlEditor.editCommitSuccess', { n: changes.length, table }), 'ok');
  };

  const renderResultGrid = (paneId: 1 | 2) => {
    const pResults = paneId === 1 ? results : results2;
    const pColumns = paneId === 1 ? columns : columns2;
    const pAllResults = paneId === 1 ? allResults : allResults2;
    const pActiveTabIndex = paneId === 1 ? activeTabIndex : activeTabIndex2;
    const pLoading = paneId === 1 ? loading : loading2;
    const pHasRun = paneId === 1 ? hasRun : hasRun2;
    const pErrorMsg = paneId === 1 ? errorMsg : errorMsg2;
    const pStatusMsg = paneId === 1 ? statusMsg : statusMsg2;
    const pPage = paneId === 1 ? page : page2;
    const pPageSize = paneId === 1 ? pageSize : pageSize2;
    const pShowCopyDropdown = paneId === 1 ? showCopyDropdown : showCopyDropdown2;
    const pSetPage = paneId === 1 ? setPage : setPage2;
    const pSetPageSize = paneId === 1 ? setPageSize : setPageSize2;
    const pSetShowCopyDropdown = paneId === 1 ? setShowCopyDropdown : setShowCopyDropdown2;

    // Read for the result tab currently on screen, not for the pane — see `pane1ViewModes`.
    const pViewMode = viewModeOf(paneId, pActiveTabIndex);

    const pExplainResult = paneId === 1 ? explainResult1 : explainResult2;
    const pActiveTabType = paneId === 1 ? activeTabType1 : activeTabType2;
    const pSetActiveTabType = paneId === 1 ? setActiveTabType1 : setActiveTabType2;

    const activeResult = pAllResults[pActiveTabIndex] || { data: [], columns: [], affectedRows: 0, query: '' };
    const totalPagesNum = Math.ceil(pResults.length / pPageSize) || 1;
    const pSortCol = paneId === 1 ? sortCol1 : sortCol2;
    const pSortDir = paneId === 1 ? sortDir1 : sortDir2;
    const sortedResults = paneId === 1 ? sortedResults1 : sortedResults2;

    const pEditability = editabilityInMode(activeResult.query || '', pColumns);
    const pTarget = pEditability.editable ? pEditability : null;
    const pEditableCols = pTarget ? new Set(pTarget.columns) : null;
    const pEdits = cellEdits[paneId];
    const pEditCount = countEdits(paneId);

    return (
      <div
        className="sql-results-wrapper"
        style={{
          flex: (paneId === 1 ? userEditorHeight : userEditorHeight2) !== null ? 1 : '1 1 0%',
          minHeight: '60px',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderTop: 'none'
        }}
      >
        <div className="sql-results-tabs" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--win-bg-window)', borderBottom: '1px solid var(--win-border-light, rgba(229,231,235,0.4))', overflow: 'visible', paddingRight: '8px', height: '28px', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: '2px', overflowX: 'auto', flex: 1, height: '100%', alignItems: 'center', scrollbarWidth: 'none' }}>
            {pAllResults.length > 0 ? (
              pAllResults.map((resItem, idx) => {
                const firstWord = resItem.query.trim().split(/\s+/)[0].toUpperCase();
                // The count suffix: a write shows "✓N" (rows affected), a read shows "(N)" (rows returned).
                const countSuffix = resItem.affected !== undefined && resItem.affected !== null
                  ? ` ✓${Number(resItem.affected).toLocaleString(locale)}`
                  : ` (${(resItem.data?.length || 0).toLocaleString(locale)})`;
                const label = `${idx + 1}: ${firstWord || 'SQL'}${countSuffix}`;
                const isActive = pActiveTabType === 'data' && pActiveTabIndex === idx;
                return (
                  <div
                    key={idx}
                    className={`sql-results-tab ${isActive ? 'active' : ''}`}
                    onClick={() => {
                      pSetActiveTabType('data');
                      handleTabChange(idx, paneId);
                    }}
                    style={{
                      padding: '4px 12px',
                      fontSize: '11px',
                      cursor: 'pointer',
                      borderBottom: isActive ? '2px solid var(--win-accent)' : 'none',
                      color: isActive ? 'var(--win-text-primary)' : 'var(--win-text-secondary)',
                      fontWeight: isActive ? 600 : 'normal',
                      whiteSpace: 'nowrap'
                    }}
                    title={resItem.query}
                  >
                    {label}
                  </div>
                );
              })
            ) : (
              <div
                className={`sql-results-tab ${pActiveTabType === 'data' ? 'active' : ''}`}
                onClick={() => pSetActiveTabType('data')}
                style={{ fontSize: '11px', padding: '4px 12px', cursor: 'pointer' }}
              >
                {t('sqlEditor.results')}
              </div>
            )}

            {pExplainResult && (
              <div
                className={`sql-results-tab ${pActiveTabType === 'explain' ? 'active' : ''}`}
                onClick={() => pSetActiveTabType('explain')}
                style={{
                  padding: '4px 12px',
                  fontSize: '11px',
                  cursor: 'pointer',
                  borderBottom: pActiveTabType === 'explain' ? '2px solid var(--win-accent)' : 'none',
                  color: pActiveTabType === 'explain' ? 'var(--win-accent)' : 'var(--win-text-secondary)',
                  fontWeight: pActiveTabType === 'explain' ? 600 : 'normal',
                  whiteSpace: 'nowrap',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
              >
                <Network size={12} />
                <span>EXPLAIN Plan</span>
              </div>
            )}
          </div>

          {pResults.length > 0 && (
            <div className="sql-results-controls">
              {/* Grid / Chart View Mode Toggle */}
              <div className="sql-view-modes">
                <button
                  type="button"
                  className={`btn sql-view-btn ${pViewMode === 'grid' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setViewMode(paneId, pActiveTabIndex, 'grid')}
                  title={t('sqlEditor.viewModeGridTitle', 'Table Grid View')}
                >
                  <Rows size={12} />
                  <span>{t('sqlEditor.viewModeGrid', 'Grid')}</span>
                </button>
                <button
                  type="button"
                  className={`btn sql-view-btn ${pViewMode === 'chart' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setViewMode(paneId, pActiveTabIndex, 'chart')}
                  title={t('sqlEditor.viewModeChartTitle', 'Visualize with Chart')}
                >
                  <BarChart2 size={12} />
                  <span>{t('sqlEditor.viewModeChart', 'Chart')}</span>
                </button>
              </div>

              {pEditability.editable ? (
                <span
                  className="sql-badge-editable"
                  title={t('sqlEditor.editableHint', { table: pEditability.table })}
                >
                  {t('sqlEditor.editableBadge', { table: pEditability.table })}
                </span>
              ) : (
                <span
                  className="sql-badge-readonly"
                  title={notEditableLabel(pEditability.reason, pEditability.table)}
                >
                  {t('sqlEditor.readOnlyBadge')}
                </span>
              )}

              {pTarget && pEditCount > 0 && (
                <>
                  <button
                    className="btn btn-secondary sql-edit-btn"
                    onClick={() => discardEdits(paneId)}
                    title={t('sqlEditor.editDiscardTitle')}
                  >
                    {t('sqlEditor.editDiscard')}
                  </button>
                  <button
                    className="btn btn-primary sql-edit-btn sql-edit-btn-save"
                    onClick={() => handleEditSave(paneId, pTarget.table, pTarget.primaryKey)}
                    title={t('sqlEditor.editSaveTitle')}
                  >
                    {t('sqlEditor.editSave', { n: pEditCount })}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="sql-results-content" style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
          {pActiveTabType === 'explain' && pExplainResult ? (
            <ExplainViewer
              explainResult={pExplainResult}
              // Only MySQL has a cost-less EXPLAIN variant worth re-running as JSON; Postgres
              // already returns JSON for every variant and SQLite never reports cost.
              onRequestJsonPlan={
                /mysql|maria/i.test(dbType) ? () => handleExplain(paneId, 'json') : undefined
              }
            />
          ) : (
            <>
              {pErrorMsg && (
                <div style={{ padding: '16px', color: 'var(--st-danger)', fontFamily: 'var(--win-font-mono)', fontSize: '12px', whiteSpace: 'pre-wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', fontWeight: 600 }}>
                    <AlertTriangle size={16} />
                    <span>{t('sqlEditor.sqlError')}</span>
                  </div>
                  {pErrorMsg}
                </div>
              )}

              {!pErrorMsg && pResults.length === 0 && pColumns.length === 0 && (
                <div style={{ padding: '30px 16px', textAlign: 'center', color: 'var(--win-text-disabled)', fontSize: '12px' }}>
                  {pLoading ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--win-text-secondary)' }}>
                      <LoadingSpinner size={14} />
                      <span>{t('sqlEditor.running')}</span>
                    </div>
                  ) : pHasRun ? (
                    activeResult && activeResult.affected !== undefined && activeResult.affected !== null
                      ? t('sqlEditor.execOkAffected', { n: Number(activeResult.affected).toLocaleString(locale) })
                      : t('sqlEditor.execOkNoRows')
                  ) : (
                    t('sqlEditor.pressRunHint')
                  )}
                </div>
              )}

              {!pErrorMsg && (pResults.length > 0 || pColumns.length > 0) && (
                pViewMode === 'chart' ? (
                  <DataVisualizer
                    rows={pResults}
                    columnNames={pColumns}
                    title={t('sqlEditor.chartResultsTitle', 'Query Results Visualization')}
                  />
                ) : (
                  <div className="grid-table-container" style={{ height: '100%' }}>
                    <table className="grid-table">
                      <thead>
                        <tr>
                          {showRowNumbers && (
                            <th
                              className="grid-header-index"
                              style={{ width: '28px', textAlign: 'center', fontWeight: 400, color: '#9ca3af', cursor: 'pointer' }}
                              onClick={() => {
                                if (paneId === 1) setAutoFitColsPane1(v => !v);
                                else setAutoFitColsPane2(v => !v);
                              }}
                              title={t('sqlEditor.autoFitColumnsTitle', 'Tự động vừa khớp độ rộng cột')}
                            >
                              <span style={{ fontSize: '11px', opacity: (paneId === 1 ? autoFitColsPane1 : autoFitColsPane2) ? 1 : 0.65, display: 'inline-block', color: (paneId === 1 ? autoFitColsPane1 : autoFitColsPane2) ? 'var(--win-accent)' : undefined }}>⇄</span>
                            </th>
                          )}
                          {/* Keyed by POSITION, not by name: `SELECT *` across several JOINs returns
                            repeated column names (film_id exists in film/film_actor/inventory), so a
                            column name is not a unique key — React warns and may duplicate or drop
                            cells. */}
                          {pColumns.map((col, ci) => {
                            const sampleVal = pResults[0]?.[col];
                            const isNum = typeof sampleVal === 'number' || (sampleVal !== null && sampleVal !== undefined && !isNaN(Number(sampleVal)) && String(sampleVal).trim() !== '') || col.toLowerCase().endsWith('_id') || col.toLowerCase().includes('year');
                            const isAutoFit = paneId === 1 ? autoFitColsPane1 : autoFitColsPane2;
                            const isSorted = pSortCol === col;
                            return (
                              <th
                                key={ci}
                                onClick={() => handleTableSort(col, paneId)}
                                style={{
                                  textAlign: isNum ? 'right' : 'left',
                                  whiteSpace: isAutoFit ? 'nowrap' : undefined,
                                  cursor: 'pointer',
                                  userSelect: 'none'
                                }}
                                title={t('sqlEditor.sortColumnTitle', { col })}
                              >
                                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', justifyContent: isNum ? 'flex-end' : 'flex-start', width: '100%' }}>
                                  <span>{col}</span>
                                  {isSorted && (
                                    <span style={{ fontSize: '10px', color: 'var(--win-accent, #3b82f6)', flexShrink: 0 }}>
                                      {pSortDir === 'asc' ? '▲' : '▼'}
                                    </span>
                                  )}
                                </div>
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {sortedResults.slice((pPage - 1) * pPageSize, pPage * pPageSize).map((row, index) => (
                          <tr key={index}>
                            {showRowNumbers && (
                              <td className="grid-row-index" style={{ textAlign: 'right', paddingRight: '6px', userSelect: 'none' }}>
                                {(pPage - 1) * pPageSize + index + 1}
                              </td>
                            )}
                            {pColumns.map((col, ci) => {
                              // It has to be keyed by primary-key VALUE rather than row index: the grid
                              // pages on the client, so an index is only meaningful within the current page.
                              const rowKey = pTarget ? String(row[pTarget.primaryKey]) : '';
                              const edited = pTarget ? pEdits[rowKey]?.[col] : undefined;
                              const isDirty = edited !== undefined;
                              const cellVal = isDirty ? edited : row[col];
                              const canEdit = !!pEditableCols?.has(col);
                              const isEditing =
                                editingCell?.pane === paneId && editingCell.rowKey === rowKey && editingCell.col === col;
                              const isFkCol = col.toLowerCase().endsWith('_id') && !col.toLowerCase().startsWith('id');
                              const isNum = typeof cellVal === 'number' || (cellVal !== null && cellVal !== undefined && !isNaN(Number(cellVal)) && String(cellVal).trim() !== '') || col.toLowerCase().endsWith('_id') || col.toLowerCase().includes('year');
                              const isAutoFit = paneId === 1 ? autoFitColsPane1 : autoFitColsPane2;

                              return (
                                <td
                                  key={ci}
                                  className={`${isDirty ? 'grid-cell-dirty' : ''} ${isEditing ? 'is-editing' : ''}`.trim()}
                                  style={{ textAlign: isNum ? 'right' : 'left', whiteSpace: isAutoFit ? 'nowrap' : undefined }}
                                  title={
                                    pTarget && !canEdit
                                      ? t('sqlEditor.editColumnReadOnly', { table: pTarget.table })
                                      : undefined
                                  }
                                  onDoubleClick={canEdit ? () => startCellEdit(paneId, rowKey, col, cellVal) : undefined}
                                >
                                  {isEditing ? (
                                    <>
                                      <span className="grid-cell-ghost">{cellVal === null ? 'NULL' : String(cellVal)}</span>
                                      <div className="grid-edit-wrapper">
                                        <input
                                          type="text"
                                          className="grid-input-edit"
                                          value={editValue}
                                          onChange={(e) => setEditValue(e.target.value)}
                                          onBlur={(e) => saveCellEdit(row[col], e)}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') saveCellEdit(row[col]);
                                            if (e.key === 'Escape') setEditingCell(null);
                                          }}
                                          autoFocus
                                        />
                                        {(col.toLowerCase().includes('date') || col.toLowerCase().includes('time') || col.toLowerCase().endsWith('_at') || /^\d{4}-\d{2}-\d{2}/.test(String(cellVal || ''))) && (
                                          <div
                                            className="grid-date-picker-btn"
                                            title={t('common.selectDate', 'Select Date & Time')}
                                            onMouseDown={(e) => {
                                              e.preventDefault();
                                              e.stopPropagation();
                                              const pickerEl = e.currentTarget.querySelector('input[type="datetime-local"]') as HTMLInputElement;
                                              if (pickerEl && typeof pickerEl.showPicker === 'function') {
                                                try { pickerEl.showPicker(); } catch { }
                                              }
                                            }}
                                          >
                                            <Calendar size={13} style={{ pointerEvents: 'none' }} />
                                            <input
                                              type="datetime-local"
                                              step="1"
                                              className="grid-date-picker-input"
                                              value={(() => {
                                                if (!editValue) return new Date().toISOString().slice(0, 19);
                                                const str = String(editValue).trim().replace(' ', 'T');
                                                const match = str.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)/);
                                                return match ? match[1] : '';
                                              })()}
                                              onMouseDown={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                if (typeof e.currentTarget.showPicker === 'function') {
                                                  try { e.currentTarget.showPicker(); } catch { }
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
                                    <span style={{ color: 'var(--win-accent, #3b82f6)', opacity: 0.8, fontStyle: 'italic' }}>{'NULL'}</span>
                                  ) : isFkCol ? (
                                    <div
                                      style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'flex-end',
                                        gap: '4px',
                                        width: '100%',
                                        cursor: 'pointer'
                                      }}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleFkClick(col, cellVal, pTarget?.table, paneId);
                                      }}
                                      title={t('sqlEditor.fkNavigateTitle', { col, val: cellVal })}
                                    >
                                      <span style={{ textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: '3px', color: 'var(--win-accent, #3b82f6)' }}>
                                        {String(cellVal)}
                                      </span>
                                      <span
                                        style={{
                                          opacity: 0.85,
                                          fontSize: '11px',
                                          color: 'var(--win-accent, #3b82f6)',
                                          padding: '0 3px',
                                          borderRadius: '3px',
                                          transition: 'all 0.15s ease'
                                        }}
                                        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'var(--win-accent, #3b82f6)'; e.currentTarget.style.color = '#fff'; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.85'; e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--win-accent, #3b82f6)'; }}
                                      >
                                        →
                                      </span>
                                    </div>
                                  ) : (
                                    <MediaCellPreview
                                      value={cellVal}
                                      columnName={col}
                                      tableName={pTarget?.table}
                                      fallbackText={String(cellVal)}
                                    />
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              )}
            </>
          )}
        </div>

        {!pErrorMsg && (
          <div className="grid-pagination" style={{ borderTop: '1px solid var(--win-border-light, rgba(229,231,235,0.4))', background: 'var(--win-bg-window)', flexShrink: 0, padding: '2px 8px', fontSize: '11px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: '26px' }}>
            {/* Left: the execution message / result */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: '12px' }}>
              {editMsg && editMsg.pane === paneId ? (
                <>
                  {editMsg.kind === 'ok'
                    ? <CheckCircle2 size={12} style={{ color: 'var(--st-ok)', flexShrink: 0 }} />
                    : <AlertTriangle size={12} style={{ color: 'var(--st-danger)', flexShrink: 0 }} />}
                  <span style={{ color: editMsg.kind === 'ok' ? 'var(--st-ok)' : 'var(--st-danger)', fontWeight: 500 }}>{editMsg.text}</span>
                </>
              ) : pStatusMsg ? (
                <>
                  <CheckCircle2 size={12} style={{ color: 'var(--st-ok)', flexShrink: 0 }} />
                  <span style={{ color: 'var(--st-ok)', fontWeight: 500 }}>
                    {pStatusMsg}
                  </span>
                </>
              ) : pResults.length > 0 ? (
                <>
                  <CheckCircle2 size={12} style={{ color: 'var(--st-ok)', flexShrink: 0 }} />
                  <span style={{ color: 'var(--st-ok)', fontWeight: 500 }}>
                    {t('sqlEditor.execOkDefault', { n: pResults.length })}
                  </span>
                </>
              ) : (
                <span style={{ color: 'var(--win-text-disabled)' }}>{t('sqlEditor.paneReady', { pane: paneId })}</span>
              )}
            </div>

            {/* Right: the pagination controls and Export */}
            {pResults.length > 0 && (
              <div className="pagination-controls" style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)', marginRight: '4px' }}>
                  <Trans
                    i18nKey="sqlEditor.rowsRange"
                    values={{
                      from: (pPage - 1) * pPageSize + 1,
                      to: Math.min(pPage * pPageSize, pResults.length),
                      total: pResults.length,
                    }}
                    components={{ strong: <b /> }}
                  />
                </span>

                <div className="gp-pager" style={{ height: '22px' }}>
                  <button
                    className="gp-pager-btn"
                    onClick={() => pSetPage(p => Math.max(p - 1, 1))}
                    disabled={pPage === 1}
                    title={t('sqlEditor.prevPage')}
                  >
                    <ChevronLeft size={13} />
                  </button>

                  <span className="gp-pager-sep" />

                  <select
                    className="gp-pager-select"
                    value={pPageSize}
                    onChange={(e) => {
                      pSetPageSize(parseInt(e.target.value));
                      pSetPage(1);
                    }}
                    title={t('sqlEditor.rowsPerPage')}
                    style={{ fontSize: '11px', fontWeight: 600 }}
                  >
                    <option value="50">50</option>
                    <option value="100">100</option>
                    <option value="200">200</option>
                  </select>

                  <span className="gp-pager-sep" />

                  <button
                    className="gp-pager-btn"
                    onClick={() => pSetPage(p => Math.min(p + 1, totalPagesNum))}
                    disabled={pPage >= totalPagesNum}
                    title={t('sqlEditor.nextPage')}
                  >
                    <ChevronRight size={13} />
                  </button>
                </div>

                <div style={{ width: '1px', height: '12px', background: 'var(--win-border)', margin: '0 4px' }} />

                {/* Export/copy data, gathered into a single button below */}
                <div style={{ position: 'relative', display: 'inline-block' }}>
                  <button
                    className="btn btn-secondary"
                    onClick={() => pSetShowCopyDropdown(!pShowCopyDropdown)}
                    style={{ padding: '2px 8px', fontSize: '11px', height: '22px', display: 'flex', alignItems: 'center', gap: '4px' }}
                    title={t('sqlEditor.exportTitle', 'Xuất/Sao chép dữ liệu')}
                  >
                    <span>Export</span>
                    <span style={{ fontSize: '7px', opacity: 0.7 }}>▼</span>
                  </button>
                  {pShowCopyDropdown && (
                    <>
                      <div
                        style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
                        onClick={() => pSetShowCopyDropdown(false)}
                      />
                      <div style={{
                        position: 'absolute',
                        bottom: '26px',
                        right: 0,
                        background: 'var(--win-bg-popover, var(--win-bg-card))',
                        border: '1px solid var(--win-border-strong, var(--win-border))',
                        borderRadius: '6px',
                        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                        zIndex: 9999,
                        minWidth: '170px',
                        display: 'flex',
                        flexDirection: 'column',
                        padding: '4px 0',
                      }}>
                        <button className="copy-dropdown-item" onClick={() => { handleCopyAs('table', paneId); pSetShowCopyDropdown(false); }}>{t('sqlEditor.copyAsTable')}</button>
                        <button className="copy-dropdown-item" onClick={() => { handleCopyAs('object', paneId); pSetShowCopyDropdown(false); }}>{t('sqlEditor.copyAsJsonObject')}</button>
                        <button className="copy-dropdown-item" onClick={() => { handleCopyAs('array', paneId); pSetShowCopyDropdown(false); }}>{t('sqlEditor.copyAsJsonArray')}</button>
                        <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />
                        <button className="copy-dropdown-item" onClick={() => { handleExportCsv(paneId); pSetShowCopyDropdown(false); }}>Export CSV</button>
                        <button className="copy-dropdown-item" onClick={() => { handleExportJson(paneId); pSetShowCopyDropdown(false); }}>Export JSON</button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // The generic is load-bearing: without a contextual type, `wordWrap: cond ? 'on' : 'off'` and
  // `renderWhitespace` widen to `string` in the object literal and no longer satisfy Monaco's
  // unions, so the `options={editorOptions}` call sites below fail to compile.
  const editorOptions = React.useMemo<monaco.editor.IStandaloneEditorConstructionOptions>(() => ({
    ...SQL_EDITOR_OPTIONS,
    fontSize: editorFontSize,
    renderWhitespace: showInvisibleChars ? 'all' : 'none',
    wordWrap: wordWrap ? 'on' : 'off',
    readOnly: readOnly,
  }), [editorFontSize, showInvisibleChars, wordWrap, readOnly]);

  const memoizedResultGrid1 = React.useMemo(() => {
    return renderResultGrid(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    results, columns, allResults, activeTabIndex, loading, hasRun, errorMsg, statusMsg,
    page, pageSize, showCopyDropdown, explainResult1, activeTabType1,
    sortCol1, sortDir1, sortedResults1, cellEdits, editingCell, editValue, editMsg,
    pane1ViewModes, showRowNumbers, autoFitColsPane1, userEditorHeight, dbType, locale, t
  ]);

  const memoizedResultGrid2 = React.useMemo(() => {
    return renderResultGrid(2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    results2, columns2, allResults2, activeTabIndex2, loading2, hasRun2, errorMsg2, statusMsg2,
    page2, pageSize2, showCopyDropdown2, explainResult2, activeTabType2,
    sortCol2, sortDir2, sortedResults2, cellEdits, editingCell, editValue, editMsg,
    pane2ViewModes, showRowNumbers, autoFitColsPane2, userEditorHeight2, dbType, locale, t
  ]);

  return (
    <div className="sql-editor-container" ref={containerRef} style={{ display: 'flex', flexDirection: 'row', height: '100%', width: '100%', overflow: 'hidden', position: 'relative' }}>
      {/* Main Split Wrapper: holds Pane 1 and optional Pane 2 side-by-side or stacked */}
      <div className={`sql-editor-split-wrapper ${splitMode}`} style={{
        flex: 1,
        display: 'flex',
        flexDirection: splitMode === 'horizontal' ? 'column' : 'row',
        overflow: 'hidden',
        position: 'relative',
        minWidth: 0
      }}>
        {/* Pane 1 */}
        <div
          ref={pane1Ref}
          className="sql-pane"
          style={{
            flex: splitMode === 'none' ? '1 1 100%' : 'none',
            width: splitMode === 'vertical' ? `${splitRatio}%` : '100%',
            height: splitMode === 'horizontal' ? `${splitRatio}%` : '100%',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            border: splitMode === 'none' ? 'none' : focusedEditor === 1 ? '1px solid var(--win-accent)' : '1px solid var(--win-border)'
          }}
        >
          {/* Editor 1 Section */}
          <div
            className="monaco-editor-wrapper"
            style={{
              flex: userEditorHeight !== null
                ? `0 0 ${userEditorHeight}px`
                : '2 1 0%',
              minHeight: '60px',
              position: 'relative',
              overflow: 'hidden'
            }}
          >
            <Editor
              height="100%"
              language={langId}
              theme={sqlThemeName(theme)}
              defaultValue={initialSqlRef.current}
              onChange={handleChange1}
              onMount={handleMount1}
              loading={EDITOR_LOADING}
              options={editorOptions}
            />
          </div>

          {/* Action Bar & Resizer handle for Pane 1 */}
          {renderPaneActionBar(1)}

          {/* Result Grid 1 Section */}
          {memoizedResultGrid1}
        </div>

        {/* Resizer Divider Bar between Pane 1 & Pane 2 */}
        {splitMode !== 'none' && (
          <div
            className={`${splitMode === 'vertical' ? 'split-divider-h' : 'split-divider-v'} ${isDraggingSplit ? 'dragging' : ''}`}
            onMouseDown={handleSplitMouseDown}
            title={t('sqlEditor.resizePanes')}
          />
        )}

        {/* Pane 2 (Rendered when splitMode !== 'none') */}
        {splitMode !== 'none' && (
          <div
            ref={pane2Ref}
            className="sql-pane"
            style={{
              flex: '1 1 0%',
              width: splitMode === 'vertical' ? `calc(${100 - splitRatio}% - 6px)` : '100%',
              height: splitMode === 'horizontal' ? `calc(${100 - splitRatio}% - 6px)` : '100%',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              border: focusedEditor === 2 ? '1px solid var(--win-accent)' : '1px solid var(--win-border)',
              position: 'relative'
            }}
          >
            {/* Editor 2 Section */}
            <div
              className="monaco-editor-wrapper"
              style={{
                flex: userEditorHeight2 !== null
                  ? `0 0 ${userEditorHeight2}px`
                  : '2 1 0%',
                minHeight: '60px',
                position: 'relative',
                overflow: 'hidden'
              }}
            >
              <button
                className="split-pane-close-btn"
                onClick={() => {
                  setSplitMode('none');
                  onSplitModeChange?.('none');
                }}
                style={{ position: 'absolute', top: '4px', right: '8px', zIndex: 10, background: 'rgba(0,0,0,0.5)', border: 'none', color: '#fff', borderRadius: '3px', padding: '2px 4px', cursor: 'pointer' }}
                title={t('sqlEditor.closePane2')}
              >
                <X size={12} />
              </button>
              <Editor
                height="100%"
                language={langId}
                theme={sqlThemeName(theme)}
                defaultValue={initialSql2Ref.current}
                onChange={handleChange2}
                onMount={handleMount2}
                loading={EDITOR_LOADING}
                options={editorOptions}
              />
            </div>

            {/* Action Bar & Resizer handle for Pane 2 */}
            {renderPaneActionBar(2)}

            {/* Result Grid 2 Section */}
            {memoizedResultGrid2}
          </div>
        )}
      </div>

      {showSnippetPanel && (
        <SqlSnippetPanel
          dbType={dbType}
          onInsertSnippet={(template) => insertSnippetAtCursor(template)}
          onClose={() => setShowSnippetPanel(false)}
        />
      )}

      {showHistory && (
        <div className="sql-history-panel">
          <div className="sql-history-header" style={{ padding: '0', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--win-border)', width: '100%', boxSizing: 'border-box' }}>
              <div className="sql-history-title">
                <History size={13} />
                <span>{t('sqlEditor.queryTable')}</span>
              </div>
              <button
                className="btn btn-secondary"
                onClick={() => setShowHistory(false)}
                style={{ padding: '2px 6px', height: '20px', minWidth: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={12} />
              </button>
            </div>
            <div style={{ display: 'flex', background: 'rgba(0,0,0,0.02)', width: '100%' }}>
              <button
                style={{
                  flex: 1,
                  padding: '6px',
                  fontSize: '11px',
                  border: 'none',
                  background: historyTab === 'history' ? 'rgba(255,255,255,0.02)' : 'transparent',
                  borderBottom: historyTab === 'history' ? '2px solid var(--win-accent)' : 'none',
                  color: historyTab === 'history' ? 'var(--win-text-primary)' : 'var(--win-text-secondary)',
                  cursor: 'pointer',
                  fontWeight: historyTab === 'history' ? 600 : 'normal'
                }}
                onClick={() => setHistoryTab('history')}
              >
                {t('sqlEditor.historyTab', { n: historyCount })}
              </button>
              <button
                style={{
                  flex: 1,
                  padding: '6px',
                  fontSize: '11px',
                  border: 'none',
                  background: historyTab === 'saved' ? 'rgba(255,255,255,0.02)' : 'transparent',
                  borderBottom: historyTab === 'saved' ? '2px solid var(--win-accent)' : 'none',
                  color: historyTab === 'saved' ? 'var(--win-text-primary)' : 'var(--win-text-secondary)',
                  cursor: 'pointer',
                  fontWeight: historyTab === 'saved' ? 600 : 'normal'
                }}
                onClick={() => setHistoryTab('saved')}
              >
                {t('sqlEditor.savedTab', { n: savedCount })}
              </button>
            </div>
          </div>
          <div className="sql-history-search">
            <input
              type="text"
              className="sql-history-search-input"
              placeholder={historyTab === 'history' ? t('sqlEditor.searchHistory') : t('sqlEditor.searchSaved')}
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
            />
            {/* Scope: the current database (the default), the whole server, or every connection.
                A query written against dev often needs re-running on prod, so other connections'
                history has to be reachable — it is simply not mixed into the default. */}
            {!!connKey && (
              <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
                {SCOPE_OPTIONS.map(({ scope, labelKey, titleKey }) => (
                  <button
                    key={scope}
                    onClick={() => changeHistoryScope(scope)}
                    title={t(titleKey)}
                    style={{
                      flex: 1,
                      padding: '3px 6px',
                      fontSize: '10px',
                      cursor: 'pointer',
                      borderRadius: '3px',
                      border: '1px solid var(--win-border)',
                      background: historyScope === scope ? 'var(--win-accent)' : 'transparent',
                      color: historyScope === scope ? '#fff' : 'var(--win-text-secondary)',
                      fontWeight: historyScope === scope ? 600 : 'normal',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {t(labelKey)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="sql-history-list">
            {historyTab === 'history' ? (
              Object.keys(getFilteredHistory()).length === 0 ? (
                <div className="sql-history-empty">
                  {t('sqlEditor.noHistory')}
                </div>
              ) : (
                Object.keys(getFilteredHistory()).map(dateKey => {
                  const groupItems = getFilteredHistory()[dateKey];
                  return (
                    <div key={dateKey} className="sql-history-group">
                      <div className="sql-history-group-title">
                        {getGroupTitle(dateKey)}
                      </div>
                      {groupItems.map(item => {
                        const timeStr = new Date(item.timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
                        return (
                          <div
                            key={item.id}
                            className="sql-history-item"
                            onClick={() => handleSelectHistoryItem(item.sql)}
                            title={item.error || t('sqlEditor.loadIntoEditor')}
                          >
                            <div className="sql-history-item-meta">
                              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                {/* The run's outcome. Older rows (and one still running) have no
                                    item.ok -> nothing is shown, rather than pretending success. */}
                                {item.ok === true && <CheckCircle2 size={11} style={{ color: 'var(--st-ok)', flexShrink: 0 }} />}
                                {item.ok === false && <AlertTriangle size={11} style={{ color: 'var(--st-danger)', flexShrink: 0 }} />}
                                {timeStr}
                                {/* Which DB it ran on: needed only while viewing several connections.
                                    Rows written before this existed have no item.db. */}
                                {effectiveScope !== 'db' && item.db && (
                                  <span style={{ opacity: 0.7 }}>· {item.db}</span>
                                )}
                                {historyMetrics(item) && (
                                  <span style={{ opacity: 0.7 }}>· {historyMetrics(item)}</span>
                                )}
                              </span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span
                                  style={{ cursor: 'pointer', color: 'var(--win-accent)', display: 'flex', alignItems: 'center', gap: '2px' }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigator.clipboard.writeText(item.sql);
                                    setStatusMsg(t('sqlEditor.copiedSqlShort'));
                                    setTimeout(() => setStatusMsg(null), 2500);
                                  }}
                                  title={t('sqlEditor.copySqlTitle')}
                                >
                                  <Copy size={11} /> {t('sqlEditor.copy')}
                                </span>
                                <span
                                  style={{ cursor: 'pointer', color: 'var(--st-danger)', display: 'flex', alignItems: 'center', gap: '2px' }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setConfirmAction({ kind: 'deleteHistoryItem', id: item.id });
                                  }}
                                  title={t('sqlEditor.deleteHistoryItemTitle')}
                                >
                                  {t('sqlEditor.delete')}
                                </span>
                              </div>
                            </div>
                            <div className="sql-history-item-sql">
                              {item.sql}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })
              )
            ) : (
              getFilteredSaved().length === 0 ? (
                <div className="sql-history-empty">
                  {t('sqlEditor.noSaved')}
                </div>
              ) : (
                getFilteredSaved().map(item => {
                  const dateStr = new Date(item.timestamp).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });
                  return (
                    <div
                      key={item.id}
                      className="sql-history-item"
                      onClick={() => handleSelectHistoryItem(item.sql)}
                      style={{ borderLeft: '3px solid var(--win-accent)', paddingLeft: '8px' }}
                      title={t('sqlEditor.loadThisQuery')}
                    >
                      <div className="sql-history-item-meta">
                        <span style={{ fontWeight: 600, color: 'var(--win-text-primary)' }}>{item.name}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {effectiveScope !== 'db' && item.db && <span style={{ opacity: 0.7 }}>{item.db}</span>}
                          <span>{dateStr}</span>
                          <span
                            style={{ cursor: 'pointer', color: 'var(--win-accent)', display: 'flex', alignItems: 'center', gap: '2px' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(item.sql);
                              setStatusMsg(t('sqlEditor.copiedSqlShort'));
                              setTimeout(() => setStatusMsg(null), 2500);
                            }}
                            title={t('sqlEditor.copySqlTitle')}
                          >
                            <Copy size={11} /> {t('sqlEditor.copy')}
                          </span>
                          <span
                            style={{ cursor: 'pointer', color: 'var(--st-danger)' }}
                            onClick={(e) => handleDeleteSaved(item.id, e)}
                            title={t('sqlEditor.deleteSavedTitle')}
                          >
                            {t('sqlEditor.delete')}
                          </span>
                        </div>
                      </div>
                      <div className="sql-history-item-sql">
                        {item.sql}
                      </div>
                    </div>
                  );
                })
              )
            )}
          </div>
          {historyTab === 'history' && historyCount > 0 && (
            <div style={{ padding: '8px', borderTop: '1px solid var(--win-border)', display: 'flex', justifyContent: 'flex-end', background: 'rgba(0, 0, 0, 0.02)' }}>
              <button
                className="btn btn-secondary"
                onClick={handleClearHistory}
                style={{ width: '100%' }}
              >
                {clearHistoryLabel()}
              </button>
            </div>
          )}
        </div>
      )}

      {showSaveModal && (
        <Modal
          title={t('sqlEditor.saveModalTitle')}
          onClose={() => { setShowSaveModal(false); setNewQueryName(''); }}
          width="360px"
          zIndex={9999}
        >
          <ModalBody style={{ gap: '12px' }}>
            <div>
              <label style={{ fontSize: '11px', display: 'block', marginBottom: '6px', color: 'var(--win-text-secondary)' }}>
                {t('sqlEditor.saveModalLabel')}
              </label>
              <input
                type="text"
                className="form-input"
                value={newQueryName}
                onChange={(e) => setNewQueryName(e.target.value)}
                placeholder={t('sqlEditor.saveModalPlaceholder')}
                autoFocus
                style={{ width: '100%', boxSizing: 'border-box', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', padding: '6px', fontSize: '12px' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConfirmSaveQuery();
                  if (e.key === 'Escape') {
                    setShowSaveModal(false);
                    setNewQueryName('');
                  }
                }}
              />
            </div>
          </ModalBody>
          <ModalFooter>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setShowSaveModal(false);
                setNewQueryName('');
              }}
              style={{ padding: '0 12px' }}
            >
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary"
              onClick={handleConfirmSaveQuery}
              style={{ padding: '0 12px' }}
            >
              {t('sqlEditor.saveModalConfirm')}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {/* Query Params Config Modal */}
      {showQueryParamsConfigModal && (
        <QueryParamsConfigModal
          initialConfig={queryParamsConfig}
          onSave={(newCfg) => {
            setQueryParamsConfig(newCfg);
            saveQueryParamsConfig(newCfg);
          }}
          onClose={() => setShowQueryParamsConfigModal(false)}
        />
      )}

      {/* Query Params Prompt Modal */}
      {paramPromptData && (
        <QueryParamsModal
          params={paramPromptData.params}
          sqlPreview={paramPromptData.originalSql}
          onSubmit={(valuesMap) => {
            // For EXPLAIN: wrap EXPLAIN around the original statement first, then swap the
            // placeholders -> native + values. For an ordinary run: swap them in the original
            // directly. Both bind at the driver level (nothing is interpolated, which is what stops
            // SQL injection).
            const p = paramPromptData.pane;
            const isExplain = paramPromptData.action === 'explain';
            const srcSql = isExplain
              ? buildExplainQuery(paramPromptData.originalSql, dbType, paramPromptData.variant || 'explain')
              : paramPromptData.originalSql;
            const { sql: finalSql, values } = buildParameterizedSql(
              srcSql,
              queryParamsConfig.patternIndex,
              valuesMap,
              dbType
            );
            setParamPromptData(null);
            if (isExplain) {
              runExplainQuery(finalSql, p, values);
            } else {
              runRawSql(finalSql, p, values);
            }
          }}
          onClose={() => setParamPromptData(null)}
        />
      )}

      {/* The warning for a DELETE with no WHERE, or a DROP TABLE. It lists the offending statement
          verbatim — more useful than an extracted table name, because in a multi-statement script the
          user needs to know EXACTLY which one. */}
      {unsafePrompt && (
        <ConfirmDialog
          open
          danger
          title={t('sqlEditor.unsafeTitle')}
          message={
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <span>{t('sqlEditor.unsafeIntro', { n: unsafePrompt.items.length })}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '180px', overflowY: 'auto' }}>
                {unsafePrompt.items.map((item, i) => (
                  <div key={i} style={{ border: '1px solid var(--win-border)', borderRadius: '4px', padding: '6px 8px', background: 'var(--win-bg-window)' }}>
                    <div style={{ fontSize: '10px', color: 'var(--st-danger)', fontWeight: 600, marginBottom: '2px' }}>
                      {unsafeKindLabel(item.kind)}
                    </div>
                    <code style={{ fontFamily: 'var(--win-font-mono)', fontSize: '11px', wordBreak: 'break-all', color: 'var(--win-text-primary)' }}>
                      {item.text.length > 160 ? `${item.text.slice(0, 160)}…` : item.text}
                    </code>
                  </div>
                ))}
              </div>
            </div>
          }
          note={isProdConn ? t('sqlEditor.unsafeNoteProd') : t('sqlEditor.unsafeNote')}
          // On a connection labelled production, an OK button is one reflex away from a wiped
          // table. Typing the database name forces the user to look at WHICH database this is —
          // which is the mistake being guarded against, not the SQL itself.
          requireText={isProdConn ? dbName : undefined}
          confirmLabel={t('sqlEditor.unsafeConfirm')}
          onConfirm={() => {
            const p = unsafePrompt;
            setUnsafePrompt(null);
            if (p.resume === 'analyze') handleExplain(p.pane, 'analyze', true);
            else executeSql(p.sql, p.pane, true);
          }}
          onCancel={() => setUnsafePrompt(null)}
        />
      )}

      {/* Clearing history / deleting a saved statement — replaces window.confirm, see confirmAction. */}
      {confirmAction && (
        <ConfirmDialog
          open
          danger
          title={
            confirmAction.kind === 'clearHistory' ? clearHistoryLabel()
              : confirmAction.kind === 'deleteSaved' ? t('sqlEditor.deleteSavedTitle')
                : t('sqlEditor.deleteHistoryItemTitle')
          }
          message={
            confirmAction.kind === 'clearHistory' ? clearHistoryMessage()
              : confirmAction.kind === 'deleteSaved' ? t('sqlEditor.confirmDeleteSaved')
                : t('sqlEditor.confirmDeleteHistoryItem')
          }
          onConfirm={runConfirmAction}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {/* ─── Previewing the SQL before writing the edited cells (as DataGrid does) ─── */}
      {editCommit && (
        <Modal
          title={t('sqlEditor.editPreviewTitle', { n: editCommit.sqls.length })}
          onClose={() => setEditCommit(null)}
          width="640px"
          maxWidth="92%"
          maxHeight="80vh"
          zIndex={99999}
          closeDisabled={editCommitting}
        >
          <ModalBody style={{ padding: '16px', gap: 0, background: 'var(--win-bg-window)', fontFamily: 'var(--win-font-mono)', fontSize: '12px', color: 'var(--win-text-primary)', flex: 1 }}>
            {editCommit.sqls.map((stmt, idx) => (
              <pre key={idx} style={{ margin: '0 0 10px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', paddingBottom: '8px', borderBottom: idx < editCommit.sqls.length - 1 ? '1px dashed var(--win-border)' : 'none' }}>
                {stmt};
              </pre>
            ))}
          </ModalBody>
          <ModalFooter>
            <button className="btn btn-secondary" onClick={() => setEditCommit(null)} disabled={editCommitting}>
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary"
              onClick={handleEditCommitConfirm}
              disabled={editCommitting || editCommit.sqls.length === 0}
              style={{ background: 'var(--st-ok)', borderColor: 'var(--st-ok)' }}
            >
              {editCommitting ? t('sqlEditor.editCommitRunning') : t('sqlEditor.editCommitConfirm')}
            </button>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
};

export default SqlEditor;

