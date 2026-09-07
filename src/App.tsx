import React, { Suspense, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { TitleBar } from './components/TitleBar';
import { SafeModeGate } from './components/SafeModeGate';
import { McpApprovalGate } from './components/McpApprovalGate';
import { ConnectionManager } from './components/ConnectionManager';
import { Sidebar } from './components/Sidebar';
import { DbRail } from './components/DbRail';
import { DatabaseInfoModal } from './components/DatabaseInfoModal';
import { TabManager } from './components/TabManager';
import type { TabInfo } from './components/TabManager';
import { TAB_GROUP_COLORS, moveGroup, moveTabIntoGroup, reorderTabs, type TabGroup } from './utils/tabGroups';
import { DataGrid, type GridViewMode } from './components/DataGrid';
// Lazy: `SqlEditor` is the app's only static edge to `monaco-editor`, and pulling it into the
// entry chunk made the webview parse ~4.5MB (Monaco + the SQL vendor bundle) and run the
// completion/hover/theme registrations before the first frame — even for a session that never
// opens a query tab. Fetched on the first query tab instead; later mounts resolve synchronously.
// The Redis console is lazied the same way in `RedisToolTab`; both edges have to stay lazy or
// Monaco is back in the entry chunk and neither one buys anything.
const SqlEditor = React.lazy(() =>
  import('./components/SqlEditor').then((m) => ({ default: m.SqlEditor })));
const ERDiagramTab = React.lazy(() =>
  import('./components/er').then((m) => ({ default: m.ERDiagramTab })));
import { LazyEditorFallback } from './components/LazyEditorFallback';
import { AiAssistant } from './components/AiAssistant';
import { TerminalPanel } from './components/TerminalPanel';
import { RoutineEditorModal } from './components/RoutineEditorModal';
import { ViewEditorModal } from './components/ViewEditorModal';
import { SchemaMigration } from './components/SchemaMigration';
import { DbCompareDialog } from './components/DbCompareDialog';
import { LiveProcessListPanel } from './components/LiveProcessListPanel';
import { McpServerSettingsModal } from './components/McpServerSettingsModal';
import { DataGeneratorDialog } from './components/DataGeneratorDialog';
import { RedisSidebarView } from './components/redis/RedisSidebarView';
import { RedisKeyTab } from './components/redis/RedisKeyTab';
import { RedisToolTab } from './components/redis/RedisToolTab';
import {
  REDIS_TOOL_TABS,
  redisKeyTabId,
  redisToolTabId,
  redisToolTabLabel,
  type RedisTabType,
} from './components/redis/redisTabs';

/** Six Redis tool tab types for quick lookup in render branch. */
const REDIS_TOOL_TAB_TYPES = new Set<string>(REDIS_TOOL_TABS);
import { ImportFilePicker } from './components/ImportFilePicker';
import { ExportTableDialog } from './components/ExportTableDialog';
import { ExportDatabaseDialog } from './components/ExportDatabaseDialog';
import type { DatabaseExportOptions } from './components/ExportDatabaseDialog';
import { ImportDatabaseDialog } from './components/ImportDatabaseDialog';
import { DocViewerModal } from './components/DocViewerModal';
import { WhatsNewModal, WHATS_NEW_STORAGE_KEY, WHATS_NEW_AUTO_SHOW_KEY } from './components/WhatsNewModal';
import { X } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import { PostgresIcon, MySqlIcon, RedisIcon, SqliteIcon } from './components/DbIcons';
import { dbHelper, activeConnId, setActiveConnId } from './utils/dbHelper';
import { installCloseGuard } from './utils/closeGuard';
import { startJob } from './utils/jobs';
import { makeRestoreReporter } from './utils/restoreProgress';
import { isProduction, normalizeEnv, type ConnEnv } from './utils/connEnv';
import type { DbConnectionConfig } from './utils/dbHelper';
import { invalidateCatalog } from './sql/catalog';
import { splitStatements } from './sql/statements';
import { connKey, scopeKey, tabsStorageKey, tabsStorageKeyCandidates } from './utils/connKey';
import { connectSavedProfile } from './utils/connectProfile';
import { readMcpPrefs } from './utils/mcpPrefs';
import type { SavedProfile } from './components/ConnectionManager';
import { updateProfileDisplay } from './utils/connectionProfiles';
import { applyProgressStyle, getProgressStyle } from './utils/progressStyle';
import { parseXlsx } from './utils/xlsxReader';
import { collectColumns, inferColType } from './utils/importPreview';
import { addExistsHint } from './utils/dumpPreview';
import { ProgressBar, type ProgressState } from './components/ProgressBar';
import { buildDatabaseFile } from './utils/exportHelper';
import { buildDump, readTableRows, dumpReaderFor } from './utils/dumpBuilder';
import { gzipText, saveExportFile } from './utils/fileSave';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Modal, ModalBody, ModalFooter } from './components/Modal';
import type { XlsxSheet } from './utils/xlsxWriter';
import appIcon from './assets/icon.png';

/**
 * One query tab, wrapped so it can stay mounted while another tab is on screen — a `SqlEditor`
 * that unmounts loses everything the run produced (results, columns, EXPLAIN plan, paging,
 * Monaco's undo stack); only the SQL text survives, because that one is lifted into `tabs[].sql`.
 *
 * Memoized, and the write path is a single stable `onPatch` rather than three inline closures:
 * every mounted tab would otherwise re-render on each debounced keystroke of the active one.
 * `tab` is a fresh object only for the tab being edited (`tabs.map` keeps the others), so this
 * narrows the re-render down to the tab the user is actually typing in.
 */
interface QueryTabPanelProps {
  tab: TabInfo;
  active: boolean;
  dbType?: string;
  connKey: string;
  /** The connection this tab runs on. See §4.1 — never read the ambient id. */
  connId: string;
  /** The connection is labelled production. */
  isProdConn?: boolean;
  /** This connection is read-only (the backend flag), unlike `readOnly`, which is the global switch. */
  connReadOnly?: boolean;
  dbName: string;
  theme: 'dark' | 'light';
  readOnly: boolean;
  onPatch: (id: string, patch: Partial<TabInfo>) => void;
}

const QueryTabPanel = React.memo(function QueryTabPanel(props: QueryTabPanelProps) {
  const { tab, active, onPatch } = props;
  return (
    // Hidden with visibility + position:absolute rather than display:none as TerminalPanel does:
    // display:none destroys the layout box, which resets the result grid's scrollTop to 0 and makes
    // Monaco measure 0x0 and re-lay out when it reappears. This way size and scroll position
    // survive, and absolute keeps hidden tabs from taking flex space in .active-panel-container
    // (which is already position:relative).
    <div
      style={
        active
          ? { flex: 1, display: 'flex', overflow: 'hidden' }
          : {
            position: 'absolute',
            inset: 0,
            display: 'flex',
            overflow: 'hidden',
            visibility: 'hidden',
            pointerEvents: 'none',
          }
      }
    >
      <Suspense fallback={<LazyEditorFallback />}>
        <SqlEditor
          connId={props.connId}
          isProdConn={props.isProdConn}
          connReadOnly={props.connReadOnly}
          dbType={props.dbType}
          connKey={props.connKey}
          dbName={props.dbName}
          initialSql={(tab as any).sql || ''}
          initialSql2={(tab as any).sql2 || ''}
          initialSplitMode={(tab as any).splitMode || 'none'}
          initialEditorHeight={(tab as any).customEditorHeight}
          theme={props.theme}
          readOnly={props.readOnly}
          onSqlChange={(val) => onPatch(tab.id, { sql: val } as any)}
          onSql2Change={(val) => onPatch(tab.id, { sql2: val } as any)}
          onSplitModeChange={(val) => onPatch(tab.id, { splitMode: val } as any)}
          onEditorHeightChange={(val) => onPatch(tab.id, { customEditorHeight: val } as any)}
        />
      </Suspense>
    </div>
  );
});

/** Rows per batch when importing into an existing table, so progress can be reported. */
const IMPORT_BATCH_SIZE = 500;

/**
 * Has the MCP autostart attempt already been made this run?
 *
 * Module-level rather than a ref because it must survive a remount: StrictMode mounts `App` twice in
 * dev, and a second `mcp_start` answers "already running" — an error object for a non-event.
 */
let mcpAutoStarted = false;

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
          i++;
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

export const App: React.FC = () => {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const fmtNum = (n: number) => n.toLocaleString(locale);

  const [connection, setConnection] = useState<{
    /**
     * Which connection this describes.
     *
     * Carried inside the object rather than only in `activeConnIdState` because the two are set from
     * different places and, on one path, at different times: `selectConnection` sets the id first and
     * the name only after an `await`. The tab-saving effect keys the storage slot off `dbName` but
     * picks the tabs off `activeConnIdState`, so that gap made it write connection A's tabs into
     * connection B's slot — reopening B then restored A's tabs. Pairing them in one value is what
     * lets the effect notice and skip that render. Never write one without the other.
     */
    connId: string;
    dbName: string;
    dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis';
    // Postgres only: the schema every command reads and writes through. Comes from the backend
    // (`current_schema()` on connect, the picker afterwards), never guessed here — it is part of
    // the localStorage scope, so a value the backend disagrees with would key tabs wrongly.
    schema?: string | null;
  } | null>(null);
  // The active connection config (SSH included) for the Terminal to inherit -> a shell on the right host/VM
  const [activeConnConfig, setActiveConnConfig] = useState<DbConnectionConfig | null>(null);
  /** The `conn_id` of the connection on screen. Minted by the backend, caught by `dbHelper` from `connect()`. */
  const [activeConnIdState, setActiveConnIdState] = useState('');
  /**
   * The Connection Manager is open in order to **add** another connection (the rail's `+` button).
   *
   * Different from the old path: "new connection" used to mean `handleDisconnect` — drop the current
   * one and show the manager again. The backend holds several connections now, so adding adds
   * rather than replaces.
   */
  const [addingConn, setAddingConn] = useState(false);
  // Bumped whenever the rail must refetch `list_connections`. A counter, not `openConns.length`:
  // toggling read-only changes what the rail draws without changing how many connections there are.
  const [railReloadKey, setRailReloadKey] = useState(0);
  // Read by the window-level listeners below, which register once: putting the id in their deps
  // would tear them down and re-register on every connection switch.
  const activeConnIdRef = React.useRef(activeConnIdState);
  React.useEffect(() => {
    activeConnIdRef.current = activeConnIdState;
  }, [activeConnIdState]);
  /**
   * Every open connection, with the config it was opened from.
   *
   * The backend deliberately never hands the config back (it carries credentials), but switching
   * between connections needs it to key that connection's tabs (`tabsStorageKey`) and to show the
   * profile name and colour. This is the map of `conn_id -> what only the frontend knows`; which
   * connections are open is still the backend's word (`list_connections`).
   */
  const [openConns, setOpenConns] = useState<
    {
      connId: string;
      config: DbConnectionConfig | null;
      dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis';
      profileName: string;
      /** The colour label, purely decorative. */
      color: string;
      /** The environment, a field of the profile's own — never inferred from `color` (see `utils/connEnv.ts`). */
      env: ConnEnv;
      readOnly?: boolean;
    }[]
  >([]);

  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  /**
   * Tabs of the connection on screen.
   *
   * `tabs` holds every open connection's tabs so switching back to one is instant and its unsaved
   * SQL survives (§4.5). The strip shows one connection at a time — the rail is what switches — so
   * everything downstream renders from this, not from `tabs`. **Every "is this tab already open?"
   * lookup must use this too**: tab ids are unique per connection only (`table_users` exists on all
   * of them), so a match in `tabs` can name a tab belonging to a connection that is not on screen,
   * and selecting it leaves the pane empty instead of opening anything.
   *
   * Declared here, above every handler that reads it, rather than next to the render: it closes over
   * nothing but state declared above, and a `const` used before its line is a runtime TDZ error that
   * `tsc` does not catch.
   *
   * A tab with no `connId` came from a workspace saved before tabs carried one; treat it as the
   * active connection's rather than hiding it, or an upgrading user opens the app to an empty strip.
   */
  const visibleTabs = tabs.filter((tb) => (tb.connId ?? activeConnIdState) === activeConnIdState);

  const [queryCount, setQueryCount] = useState(1);
  const [showAi, setShowAi] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (typeof localStorage !== 'undefined' && localStorage.getItem('tf_theme') as 'dark' | 'light') || 'dark');
  // Read-only mode: refuses every write. Remembered across launches (the tf_* convention) — a safety
  // switch that reset to "writes allowed" on every start would be close to useless.
  const [readOnly, setReadOnly] = useState(() => localStorage.getItem('tf_readonly') === '1');
  // Table tabs with uncommitted edits (reported up by DataGrid). See guardDirty below.
  const [dirtyTabId, setDirtyTabId] = useState<string | null>(null);
  /** Action waiting for the user to agree to discard unsaved edits — see guardDirty. */
  const [discardPrompt, setDiscardPrompt] = useState<(() => void) | null>(null);
  // Query tabs that have been opened -> mounted permanently so their results survive. Mounted
  // lazily rather than mounting all of `tabs`: restoring 10 tabs from localStorage and building 10
  // Monaco instances with them would be wasteful.
  const [mountedQueryTabs, setMountedQueryTabs] = useState<Set<string>>(() => new Set());
  // Tab groups (Chrome-style). Stored alongside the tab list; see restoreTabs.
  const [tabGroups, setTabGroups] = useState<TabGroup[]>([]);
  const [dbReloadKey, setDbReloadKey] = useState(0);

  // Exporting one table (from the Sidebar's context menu) — the same dialog as the Export button under the grid
  const [exportTableTarget, setExportTableTarget] = useState<string | null>(null);

  const [globalImportSqlMode, setGlobalImportSqlMode] = useState<'both' | 'structure' | 'data'>('both');

  const [showGlobalImportModal, setShowGlobalImportModal] = useState(false);
  const [globalImportFileName, setGlobalImportFileName] = useState('');
  const [globalImportTableName, setGlobalImportTableName] = useState('');
  const [globalImportFileType, setGlobalImportFileType] = useState<'csv' | 'json' | 'sql'>('csv');
  const [globalImportPendingRows, setGlobalImportPendingRows] = useState<any[]>([]);
  const [globalImportSqlContent, setGlobalImportSqlContent] = useState('');
  const [globalImportLoading, setGlobalImportLoading] = useState(false);
  const [globalImportTargetTable, setGlobalImportTargetTable] = useState<string | null>(null);
  const [globalImportTab, setGlobalImportTab] = useState<'structure' | 'data'>('structure');
  const [globalImportProgress, setGlobalImportProgress] = useState<ProgressState | null>(null);
  const globalImportCols = React.useMemo(() => collectColumns(globalImportPendingRows), [globalImportPendingRows]);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showAbout, setShowAbout] = useState(false);
  // Reads the real version from tauri.conf.json rather than hardcoding it in JSX, which drifts the
  // first time someone bumps the version. Under plain vite-dev there is no backend -> keep the default.
  const [appVersion, setAppVersion] = useState('0.1.0');
  React.useEffect(() => {
    getVersion().then(setAppVersion).catch(() => { });
  }, []);

  // ONE `onCloseRequested` listener for the whole app; anything that wants to block registers a
  // blocker (uncommitted transaction, running job). With two independent listeners, whichever
  // resolves first calls `destroy()` and kills the other's dialog too — see utils/closeGuard.ts.
  React.useEffect(() => installCloseGuard(), []);

  // Bring the MCP server back up if the user asked for that. Lives here rather than in
  // `McpServerSettingsModal` because the modal is unmounted almost all of the time, and rather than
  // in Rust's `app/setup.rs` because the durable answer is in `localStorage` (see utils/mcpPrefs.ts).
  // Starting the listener shares nothing by itself: `mcp_exposed` is per-run, so an AI client
  // connecting to a freshly autostarted server sees an empty connection list until the user ticks one.
  React.useEffect(() => {
    if (mcpAutoStarted) return;
    // Module-level, not a ref: StrictMode mounts this twice in dev and the second `mcp_start` would
    // come back "already running" — a real error object for a non-event.
    mcpAutoStarted = true;
    const { autoStart, port } = readMcpPrefs();
    if (!autoStart) return;
    void dbHelper.mcpStart(port).catch(() => {
      // A taken port or a backend that is not there (plain `vite-dev`) must not break app boot. The
      // Settings screen reports the real status and its Start button says why.
    });
  }, []);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showDocModal, setShowDocModal] = useState(false);
  const [docQuery] = useState('');
  const [showWhatsNew, setShowWhatsNew] = useState<boolean>(() => {
    const autoShow = localStorage.getItem(WHATS_NEW_AUTO_SHOW_KEY);
    if (autoShow === 'false') return false;
    const seen = localStorage.getItem(WHATS_NEW_STORAGE_KEY);
    return !seen;
  });

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F1') {
        e.preventDefault();
        setShowDocModal(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
  // The profile behind the connection: the id so its name and colour can be written back into
  // tf_connection_profiles, and the name + colour so the connection popover can show and edit them
  // in place. A connection opened without a profile (never saved) has an empty id -> the popover
  // still displays, it just cannot save.
  const [activeProfile, setActiveProfile] = useState<{ id: string; name: string; color: string }>({
    id: '',
    name: '',
    color: '',
  });

  const [showGlobalImportPicker, setShowGlobalImportPicker] = useState(false);

  const handleImportToTableTrigger = (tableName: string) => {
    setGlobalImportTargetTable(tableName);
    setShowGlobalImportPicker(true);
  };

  // Right-click > Export data: opens the same single-table dialog as the Export button under the grid.
  const handleExportTableTrigger = (tableName: string) => {
    setExportTableTarget(tableName);
  };

  // Takes the file from ImportFilePicker (which already checked the extension) and parses it for the preview.
  const handleGlobalFileImport = async (file: File) => {
    setShowGlobalImportPicker(false);
    setGlobalImportTab('structure');
    setGlobalImportFileName(file.name);
    const guessedTableName = file.name.split('.')[0].replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    setGlobalImportTableName(guessedTableName);

    // XLSX is binary -> read an ArrayBuffer and parse it separately, never through FileReader.readAsText.
    if (file.name.toLowerCase().endsWith('.xlsx')) {
      try {
        const buf = await file.arrayBuffer();
        const rows = await parseXlsx(buf);
        if (rows.length === 0) throw new Error(t('dataGrid.errXlsxEmpty'));
        setGlobalImportFileType('json'); // object-shaped rows, sharing the DB-write branch with CSV/JSON
        setGlobalImportPendingRows(rows);
        setShowGlobalImportModal(true);
      } catch (err: any) {
        alert(t('dataGrid.errReadFile', { message: err.message }));
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
          setGlobalImportFileType('json');
          setGlobalImportPendingRows(parsedJson);
          setShowGlobalImportModal(true);
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
          setGlobalImportFileType('csv');
          setGlobalImportPendingRows(rowsToImport);
          setShowGlobalImportModal(true);
        } else if (file.name.endsWith('.sql')) {
          setGlobalImportFileType('sql');
          setGlobalImportSqlContent(text);
          setShowGlobalImportModal(true);
        } else {
          throw new Error(t('dataGrid.errUnsupportedFile'));
        }
      } catch (err: any) {
        alert(t('dataGrid.errReadFile', { message: err.message }));
      }
    };
    reader.readAsText(file);
  };

  /**
   * Exports a whole database. Runs in the **background**: this function only queues a job and
   * returns `true` so the dialog closes at once, while progress, result and errors live in
   * `JobsTray`. Progress used to be dialog state, so closing the dialog lost it and the app sat
   * waiting for the whole export — see docs/background-jobs-plan.md.
   *
   * The result arrives as a `JobResult` rather than another dialog: a modal appearing on its own ten
   * minutes later, while the user is typing a different query, is exactly what background mode
   * exists to get rid of.
   */
  const handleExportDatabase = async (opts: DatabaseExportOptions): Promise<boolean> => {
    // Fixed at submit time: if the user switches connection while the job runs, the job still reads
    // the place it was given. `connId` is already a (server, database) pair, so it doubles as the
    // exclusivity key — see jobs.ts.
    const jobConnId = activeConnIdState;
    const dbType = connection?.dbType || 'sqlite';
    const schema = connection?.schema;
    const dbLabel = connection?.dbName || opts.filename;

    startJob({
      kind: 'dump',
      title: t('jobs.titleExport', { n: dbLabel }),
      db: connection?.dbName || '',
      lockKey: `${jobConnId}|${connection?.dbName || ''}`,
      run: async (ctx) => {
        const report = (p: ProgressState | null) => ctx.report(p);
        const totalTables = opts.tables.length;

        // Data (XLSX/JSON/CSV): the file is built client-side.
        if (opts.format !== 'sql') {
          const sheets: XlsxSheet[] = [];
          for (let i = 0; i < opts.tables.length; i++) {
            ctx.throwIfCancelled();
            const table = opts.tables[i];
            const schemaInfo = await dbHelper.getTableSchema(jobConnId, table);
            const rows = await readTableRows(dumpReaderFor(dbHelper, jobConnId), table, i, totalTables, report);
            const colNames = (schemaInfo.columns || []).map(c => c.name);
            const finalCols = colNames.length ? colNames : (rows[0] ? Object.keys(rows[0]) : []);
            sheets.push({ name: table, colNames: finalCols, rows });
          }
          report({ label: t('app.exportBuilding', { format: opts.format.toUpperCase() }) });
          const file = buildDatabaseFile(sheets, opts.format, opts.filename);
          report({ label: t('app.exportWriting') });
          const saved = await saveExportFile(opts.dir, file.name, file.data, file.mime);
          return {
            message: t('app.exportedSheets', { n: sheets.length, format: opts.format.toUpperCase(), file: file.name }),
            path: saved.path,
            dir: saved.dir,
            viaDownload: saved.savedTo === 'download',
          };
        }

        // SQL: the dump is built in dumpBuilder.ts — shared with Connection Manager's Backup button,
        // so any change to statement order has to be made in exactly ONE place.
        const sqlText = await buildDump({
          dbType,
          tables: opts.tables,
          views: opts.views,
          routines: opts.routines,
          triggers: opts.triggers,
          sqlOptions: opts.sqlOptions,
          // The dump was read from the selected schema, so the header has to name it — without that,
          // re-importing elsewhere puts everything into whatever schema leads that host's search_path.
          schema,
          onProgress: report,
        }, dumpReaderFor(dbHelper, jobConnId));
        ctx.throwIfCancelled();

        const ext = opts.compressGzip ? '.sql.gz' : '.sql';
        const base = opts.filename.replace(/\.(sql|sql\.gz|gz)$/i, '');
        const fileName = base + ext;

        report({ label: opts.compressGzip ? t('app.exportCompressing') : t('app.exportWriting') });
        const payload = opts.compressGzip ? await gzipText(sqlText) : sqlText;
        const saved = await saveExportFile(
          opts.dir,
          fileName,
          payload,
          opts.compressGzip ? 'application/gzip' : 'text/plain;charset=utf-8'
        );

        return {
          message: t('app.exportedSql', { n: opts.tables.length, file: fileName }),
          path: saved.path,
          dir: saved.dir,
          viaDownload: saved.savedTo === 'download',
        };
      },
    });

    return true;
  };

  const extractTableNameFromSql = (sql: string): string | null => {
    const createMatch = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[`"']?([a-zA-Z0-9_]+)[`"']?)/i);
    if (createMatch && createMatch[1]) return createMatch[1];

    const dropMatch = sql.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:[`"']?([a-zA-Z0-9_]+)[`"']?)/i);
    if (dropMatch && dropMatch[1]) return dropMatch[1];

    return null;
  };

  const filterSqlQueries = (sqlText: string, mode: 'both' | 'structure' | 'data'): string => {
    if (mode === 'both') return sqlText;
    // splitStatements: the same splitter the SQL editor and Rust's split_sql_statements use (it
    // knows strings, comments and dollar-quoted blocks). This used to be a third home-made splitter
    // that only counted quotes, so a comment containing ';' was cut in the wrong place.
    const queries = splitStatements(sqlText).map((s) => s.text);
    const filtered = queries.filter(q => {
      const trimmed = q.trim().toUpperCase();
      if (!trimmed) return false;
      const isStructure = trimmed.startsWith('CREATE TABLE') ||
        trimmed.startsWith('DROP TABLE') ||
        trimmed.startsWith('ALTER TABLE') ||
        trimmed.startsWith('CREATE INDEX') ||
        trimmed.startsWith('CREATE UNIQUE INDEX') ||
        trimmed.startsWith('DROP INDEX');
      const isData = trimmed.startsWith('INSERT INTO') ||
        trimmed.startsWith('UPDATE') ||
        trimmed.startsWith('DELETE FROM') ||
        trimmed.startsWith('TRUNCATE TABLE') ||
        trimmed.startsWith('TRUNCATE') ||
        trimmed.startsWith('INSERT');
      if (mode === 'structure') {
        return isStructure || (!isData && !trimmed.startsWith('REPLACE'));
      }
      if (mode === 'data') {
        return isData || (!isStructure && !trimmed.startsWith('CREATE') && !trimmed.startsWith('DROP') && !trimmed.startsWith('ALTER'));
      }
      return true;
    });
    return filtered.join(';\n');
  };

  const confirmGlobalImport = async () => {
    if (!globalImportTargetTable && !globalImportTableName.trim()) {
      alert(t('app.errNoTableName'));
      return;
    }

    setShowGlobalImportModal(false);
    setGlobalImportLoading(true);
    setGlobalImportProgress({
      label: globalImportFileType === 'sql'
        ? t('app.importRunningSql')
        : t('app.importWritingRows', { n: globalImportPendingRows.length }),
    });

    try {
      if (globalImportFileType === 'sql') {
        let filteredSql = filterSqlQueries(globalImportSqlContent, globalImportSqlMode);

        if (globalImportTargetTable) {
          const originalTable = extractTableNameFromSql(globalImportSqlContent);
          if (originalTable && originalTable !== globalImportTargetTable) {
            const escapedOrig = originalTable.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
            const regex = new RegExp(`([\\s\`"'])${escapedOrig}([\\s\`"';(])`, 'gi');
            filteredSql = filteredSql.replace(regex, `$1${globalImportTargetTable}$2`);
          }
        }

        // executeQueryMulti, NOT executeQuery: execute_query sends the whole string to the driver as
        // ONE statement. A multi-statement .sql file fails with a syntax error at the second
        // statement on MySQL/Postgres, while SQLite runs only the first and reports success (silent
        // data loss). executeQueryMulti splits with split_sql_statements and runs them in turn.
        const res = await dbHelper.executeQueryMulti(activeConnIdState, filteredSql);
        if (res.success) {
          alert(t('app.importSqlSuccess'));
          window.dispatchEvent(new CustomEvent('database-restored', { detail: { connId: activeConnIdState } }));
        } else {
          alert(t('app.errImportSql', { message: res.error }));
        }
      } else if (globalImportTargetTable) {
        // An existing table: written in batches so real progress can be reported.
        const table = globalImportTargetTable;
        const total = globalImportPendingRows.length;
        let done = 0;
        let failed: string | null = null;
        for (let i = 0; i < total; i += IMPORT_BATCH_SIZE) {
          const batch = globalImportPendingRows.slice(i, i + IMPORT_BATCH_SIZE);
          const resData = await dbHelper.importTableData(activeConnIdState, table, batch);
          if (!resData.success) {
            failed = resData.error || t('app.errImportFailed');
            break;
          }
          done += batch.length;
          setGlobalImportProgress({
            label: t('app.importWritingTable', { table }),
            current: done,
            total,
            detail: t('app.importRowsDetail', { done: fmtNum(done), total: fmtNum(total) }),
          });
        }
        if (failed) {
          alert(done > 0
            ? t('app.errImportWithProgress', { message: failed, done, total })
            : t('app.errImport', { message: failed }));
        } else {
          alert(t('app.importedRows', { n: done, table }));
        }
        window.dispatchEvent(new CustomEvent('database-restored', { detail: { connId: activeConnIdState } }));
      } else {
        // A new table: the backend creates it and inserts in one call -> indeterminate progress.
        const resData = await dbHelper.importNewTable(globalImportTableName, globalImportPendingRows);
        if (resData.success) {
          alert(t('app.createdAndImported', { table: globalImportTableName }));
          window.dispatchEvent(new CustomEvent('database-restored', { detail: { connId: activeConnIdState } }));
        } else {
          alert(t('app.errImport', { message: resData.error }));
        }
      }
    } catch (err: any) {
      alert(t('common.connectionError', { message: err.message }));
    } finally {
      setGlobalImportProgress(null);
      setGlobalImportLoading(false);
    }
  };

  // Returns true when the import finished -> ImportDatabaseDialog closes itself.
  // targetDb: the destination database, taken from the file or typed by the user; created if absent.
  const handleImportDatabase = async (
    sqlText: string,
    tables: string[],
    targetDb: string,
    continueOnError = false
  ): Promise<boolean> => {
    try {
      const wantDb = targetDb.trim();
      const canManageDb = !!connection && connection.dbType !== 'sqlite';

      // The connection the restore actually runs on, passed explicitly to `restoreBackup`. A local
      // rather than `activeConnIdState`, which is React state and still holds the OLD id inside this
      // closure when the import opens a database of its own — that would also mis-address the
      // `database-restored` event at the end.
      let targetConnId = activeConnIdState;

      if (canManageDb && wantDb && wantDb !== connection?.dbName) {
        const list = await dbHelper.listDatabases(activeConnIdState);
        const exists = (list.databases || []).some(d => d.toLowerCase() === wantDb.toLowerCase());

        if (!exists) {
          const created = await dbHelper.createDatabase(activeConnIdState, { name: wantDb });
          if (!created.success) {
            alert(t('app.errCreateDatabase', { name: wantDb, message: created.error }));
            return false;
          }
        }

        // OPEN the target rather than switching this connection onto it. Switching replaced the pool,
        // so importing into another database refused outright whenever the current one had
        // uncommitted work — and when it succeeded it left every open tab pointing at tables of a
        // database the connection no longer served. Opening leaves the old one intact and gives the
        // import its own connection.
        const opened = await dbHelper.openDatabase(activeConnIdState, wantDb);
        if (!opened.success || !opened.connId) {
          alert(t('sidebar.errOpenDb', { message: opened.error || '' }));
          return false;
        }
        targetConnId = opened.connId;
        // Points the app — and `dbHelper`'s ambient id, which the restore reads — at the new
        // connection, and gives it its own tab list.
        handleDatabaseOpened(opened.connId, opened.database || wantDb, opened.schema);
        invalidateCatalog();
      }

      // The preparation above (creating/opening the target database) runs **inside** the dialog: it
      // has to be able to say "the database could not be created" while the user is still standing
      // there. Only the restore itself goes to the background — it is the long part, and the part
      // nobody needs to watch.
      const restoreConnId = targetConnId;
      startJob({
        kind: 'restore',
        title: t('jobs.titleRestore', { n: wantDb || connection?.dbName || '' }),
        db: wantDb || connection?.dbName || '',
        write: true,
        lockKey: `${restoreConnId}|${wantDb || connection?.dbName || ''}`,
        run: async (ctx) => {
          const toProgress = makeRestoreReporter(t);
          const resData = await dbHelper.restoreBackup(
            sqlText,
            tables,
            (msg) => ctx.report(toProgress(msg)),
            continueOnError,
            restoreConnId,
          );
          if (!resData.success) throw new Error(addExistsHint(resData.error || '', false));

          // A `USE <db>` inside the dump changes this connection's database, so the title-bar label
          // has to follow — but ONLY while the user is still looking at that connection. The job runs
          // in the background, so by the time it finishes they may have moved to another one, and
          // overwriting that connection's label would show the name of a database it never opened.
          if (resData.activeDatabase && activeConnIdRef.current === restoreConnId) {
            const activeDb = resData.activeDatabase;
            setConnection(prev => prev ? { ...prev, dbName: activeDb } : null);
          }
          invalidateCatalog();
          window.dispatchEvent(new CustomEvent('database-restored', { detail: { connId: restoreConnId } }));

          // Skipped statements MUST be reported: a plain "success" while dozens are missing leaves
          // the user believing the database is complete.
          if (resData.failedCount) {
            return {
              message: t('app.importDbPartial', {
                n: resData.statementsCount || 0,
                failed: resData.failedCount,
              }),
              warning: (resData.failedSamples || []).map((f) => `• ${f.error}`).join('\n'),
            };
          }
          return { message: t('app.importDbSuccess', { n: resData.statementsCount || 0 }) };
        },
      });
      return true;
    } catch (e: any) {
      alert(t('app.errImport', { message: e.message }));
      return false;
    }
  };

  /**
   * A table was renamed on `connId` — retitle only THAT connection's tabs for it.
   *
   * `tabs` now holds every open connection's tabs, and table names repeat across connections
   * (`sakila` and `sakila2` both have `film`). Without the id check, renaming `film` on one
   * connection silently relabels the other connection's `film` tab to a table it does not have.
   */
  const handleTableRenamed = (connId: string, oldName: string, newName: string) => {
    setTabs((prev) =>
      prev.map((tb) => {
        if (tb.type === 'table' && tb.name === oldName && (tb.connId ?? connId) === connId) {
          return { ...tb, name: newName, label: newName };
        }
        return tb;
      })
    );
  };

  const handleTableDropped = (tableName: string) => {
    const connId = activeConnIdState;
    setTabs((prev) => {
      // Scoped both ways. Dropping `users` on one connection used to close a tab named `users` on
      // every other one, and when the array happened to empty out it was REPLACED by a single new
      // tab — throwing away every other connection's tabs, unsaved SQL included.
      const remaining = prev.filter(
        (tb) => !(tb.type === 'table' && tb.name === tableName && (tb.connId ?? connId) === connId),
      );
      const mine = remaining.filter((tb) => (tb.connId ?? connId) === connId);
      if (mine.length === 0) {
        return [
          ...remaining,
          {
            id: 'query_1',
            connId,
            type: 'query',
            name: 'SQL Query',
            label: t('app.queryTabLabel', { n: 1 }),
          },
        ];
      }
      return remaining;
    });
  };

  React.useEffect(() => {
    const handleGlobalRename = (e: any) => {
      const { connId, oldName, newName } = e.detail || {};
      handleTableRenamed(connId ?? activeConnIdRef.current, oldName, newName);
    };
    window.addEventListener('table-renamed', handleGlobalRename);
    return () => window.removeEventListener('table-renamed', handleGlobalRename);
    // Deliberately empty: the listener is registered once, and `activeConnIdRef` exists so the handler never needs re-subscribing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    // `dbReloadKey` is one counter for the whole workspace, and only the active connection's
    // components are mounted — so bumping it for a change on another connection would make the
    // panels on screen refetch for something that did not touch them.
    const handleGlobalReload = (e: Event) => {
      const from = (e as CustomEvent<{ connId?: string }>).detail?.connId;
      if (from && from !== activeConnIdRef.current) return;
      setDbReloadKey((prev) => prev + 1);
    };
    window.addEventListener('database-restored', handleGlobalReload);
    return () => window.removeEventListener('database-restored', handleGlobalReload);
  }, []);

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  React.useEffect(() => {

    // The progress-bar style sits on <html> like the theme does; see utils/progressStyle.ts
    applyProgressStyle(getProgressStyle());

    // macOS does not round the window corners itself when decorations = false, so CSS has to match
    // the radius of the vibrancy layer (windowEffects.radius in tauri.conf.json). Windows 11 rounds
    // them on its own and needs none of this.
    const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    document.documentElement.setAttribute('data-os', isMac ? 'macos' : 'other');
  }, []);

  const applyTheme = (nextTheme: 'dark' | 'light') => {
    setTheme(nextTheme);
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('tf_theme', nextTheme);
  };

  const toggleTheme = () => applyTheme(theme === 'dark' ? 'light' : 'dark');

  // Renaming / recolouring / re-labelling a connection from the details popover. What is displayed
  // always changes at once; writing back to the profile happens only when this connection really
  // came from a saved one.
  const handleProfileChange = (patch: { name?: string; color?: string; env?: ConnEnv }) => {
    setActiveProfile((prev) => ({
      ...prev,
      name: patch.name ?? prev.name,
      color: patch.color ?? prev.color,
    }));
    updateProfileDisplay(activeProfile.id, patch);

    if (!activeConnIdState) return;
    setOpenConns((prev) =>
      prev.map((c) =>
        c.connId === activeConnIdState
          ? { ...c, color: patch.color ?? c.color, env: patch.env ?? c.env }
          : c,
      ),
    );
    // Marking something production *now* has to take effect *now*. Waiting until the next connect
    // would leave the guard switched on but guarding nothing for the whole open session.
    if (isProduction(patch.env)) {
      void dbHelper.setConnectionReadOnly(activeConnIdState, true);
      setOpenConns((prev) =>
        prev.map((c) => (c.connId === activeConnIdState ? { ...c, readOnly: true } : c)),
      );
    }
    setRailReloadKey((k) => k + 1);
  };

  // Reopens the session with the very config in use, which helps when the server drops idle
  // connections. Open tabs are kept — only the Rust-side session is rebuilt — but the catalog cache
  // is cleared, because the server's schema may have changed while the connection was gone.
  const handleReconnect = async (): Promise<{ success: boolean; message?: string }> => {
    if (!activeConnConfig) return { success: false };
    const oldId = activeConnIdState;
    await dbHelper.disconnect();
    const res = await dbHelper.connect(activeConnConfig);
    if (!res.success) return { success: false, message: res.message };
    // Reconnect mints a NEW conn_id — the old entry is gone from the registry. Without this the
    // rail would keep drawing a dead connection and, worse, `TxControl` would filter out every
    // `tx-state-changed` event because it is still comparing against the old id.
    const newId = activeConnId();
    setActiveConnIdState(newId);
    setOpenConns((prev) =>
      prev.map((c) => (c.connId === oldId ? { ...c, connId: newId } : c)),
    );
    // The tabs have to move to the new id as well. Remapping only `openConns` left every tab
    // stamped with the dead one, so `visibleTabs` matched none of them: the strip emptied on
    // reconnect and the save effect — which writes the tabs of the active connection — then
    // persisted that empty list over the workspace.
    setTabs((prev) =>
      prev.map((tb) => ((tb.connId ?? oldId) === oldId ? { ...tb, connId: newId } : tb)),
    );
    invalidateCatalog();
    setDbReloadKey((prev) => prev + 1);
    return { success: true };
  };

  const toggleReadOnly = () => {
    const next = !readOnly;
    setReadOnly(next);
    localStorage.setItem('tf_readonly', next ? '1' : '0');
  };

  /**
   * Pushes the global read-only switch down to the backend for a Redis connection.
   *
   * The real lock has to be in Rust: the CLI Console sends free-form command text, so disabling
   * buttons in the WebView does not stop a hand-typed `FLUSHALL`. `RedisBrowser` used to hold this
   * effect; it was deleted when Redis moved to tabs, so the effect landed here.
   *
   * It writes the OR of two sources, not the switch alone: since Phase 0 the backend flag is the
   * CONNECTION's flag — the same one the production label writes — so turning the switch off and
   * writing a plain `false` would unlock writes on a production connection.
   */
  React.useEffect(() => {
    if (connection?.dbType !== 'redis' || !activeConnIdState) return;
    const own = openConns.find((c) => c.connId === activeConnIdState)?.readOnly ?? false;
    void dbHelper.redisSetReadOnly(readOnly || own, activeConnIdState);
  }, [readOnly, connection?.dbType, activeConnIdState, openConns]);

  React.useEffect(() => {
    // Skip the renders where the two disagree — see `connection.connId`. Writing then would put the
    // tabs of the connection named by `activeConnIdState` into the slot named by `dbName`.
    if (connection && connection.connId === activeConnIdState) {
      const storageKey = tabsStorageKey(
        activeConnConfig,
        connection.dbType,
        connection.dbName,
        connection.schema,
      );
      // Only the selected connection's tabs are written, under its own scope key. `tabs` now holds
      // the tabs of EVERY open connection, so writing the whole array to one key would file this
      // connection's tabs under another connection's name. The others need no writing on their
      // behalf: a tab's contents only change while its connection is selected (other connections'
      // tabs are not mounted), and the previous selection already wrote them.
      //
      // Terminal tabs are not saved: a PTY session does not survive a reload.
      // `config` is dropped AT THE SINK, not only by the type filter below.
      //
      // A no-op today: the only tab kind that carries one is `terminal`, and those are already
      // filtered out. It is here because the guarantee "no credential ever reaches localStorage"
      // otherwise rests on a filter that exists for an unrelated reason (a PTY does not survive a
      // reload) - change that filter for its own reason and secrets start being written, silently.
      // A `DbConnectionConfig` holds SSH passwords and private keys, so the sink is where this
      // belongs. CodeQL flags these two writes (alerts 30/31) for a different, spurious path: the
      // config also reaches `tabsStorageKey`, which projects it to `type:host:port` and cannot carry
      // a secret - see `connKey`.
      const persistTabs = tabs
        .filter(tb => tb.type !== 'terminal' && tb.connId === activeConnIdState)
        .map(({ config: _config, ...tb }) => tb as TabInfo);
      const persistActive = persistTabs.some(tab => tab.id === activeTabId) ? activeTabId : (persistTabs[0]?.id ?? null);
      const payload = { tabs: persistTabs, activeTabId: persistActive, queryCount, groups: tabGroups };
      try {
        localStorage.setItem(storageKey, JSON.stringify(payload));
      } catch {
        // Out of quota (long draft SQL x many tabs x many DBs sharing ~5MB with history, profiles
        // and snapshots). Drop the inactive tabs' drafts so the tab list and the active tab's draft
        // still survive, rather than losing this whole save.
        const trimmed = persistTabs.map(tab =>
          tab.id === persistActive ? tab : ({ ...tab, sql: undefined, sql2: undefined } as TabInfo)
        );
        try {
          localStorage.setItem(storageKey, JSON.stringify({ ...payload, tabs: trimmed }));
        } catch (e) {
          console.warn('Không lưu được danh sách tab (localStorage đã đầy):', e);
        }
      }
    }
  }, [tabs, activeTabId, connection, activeConnConfig, activeConnIdState, queryCount, tabGroups]);

  React.useEffect(() => {
    const applyWindowSize = async () => {
      try {
        if (connection) {
          // Connected to a database: widen the window to 1280 x 800px
          await invoke('set_app_window_size', { width: 1280, height: 800 });
        } else {
          // The Connection Manager screen: shrink back to 1060 x 680px
          await invoke('set_app_window_size', { width: 1060, height: 680 });
        }
      } catch (e) {
        console.warn('Lỗi thay đổi kích thước cửa sổ qua Rust:', e);
      }
    };

    applyWindowSize();
  }, [connection]);

  // Restores a database's tabs (with the draft SQL inside them). The new key includes host:port so
  // two servers with a same-named database cannot collide; the old key is only ever READ, once, and
  // only while the new one is empty — so nobody loses the tabs they had open.
  /**
   * A connection with nothing saved gets one empty SQL tab.
   *
   * MERGES like `restoreTabs` does, for the same reason: `tabs` now holds every open connection's
   * tabs, so replacing the array would throw away the other connections' work. The id is per
   * connection (`query_1` on each), which is exactly why the React keys in the render splice the
   * scope in — see the note there.
   */
  /**
   * The first tab of a connection that has no saved tab set.
   *
   * `dbType` is an explicit parameter rather than read from `connection`: every call site is in the
   * middle of switching connections, and `connection` may still be the old one at that moment.
   */
  const openInitialTab = (connId: string, dbType?: string) => {
    // Redis has no "SQL Query" to open. The CLI Console is the one tool tab usable before any key is
    // selected, and an empty workspace tells the user nothing about what to do next.
    if (dbType === 'redis') {
      const tabId = redisToolTabId(connId, 'redis-console');
      const label = redisToolTabLabel('redis-console', t);
      setTabs((prev) => [
        ...prev.filter((tb) => tb.connId !== connId),
        { id: tabId, connId, type: 'redis-console', name: label, label },
      ]);
      setActiveTabId(tabId);
      return;
    }
    const initialTabId = 'query_1';
    setTabs((prev) => [
      ...prev.filter((tb) => tb.connId !== connId),
      { id: initialTabId, connId, type: 'query', name: 'SQL Query', label: t('app.queryTabLabel', { n: 1 }) },
    ]);
    setActiveTabId(initialTabId);
    setQueryCount(2);
  };

  const restoreTabs = (
    connId: string,
    config: DbConnectionConfig | null | undefined,
    dbType: string,
    dbName: string,
    schema?: string | null,
  ): boolean => {
    // Newest key first, then the older spellings (no schema level, then pre-connKey). Only the
    // first is ever written back, so this migrates a workspace forward without duplicating it.
    const saved = tabsStorageKeyCandidates(config, dbType, dbName, schema)
      .map((key) => localStorage.getItem(key))
      .find((v) => v != null);
    if (!saved) return false;
    try {
      const {
        tabs: savedTabs,
        activeTabId: savedActiveId,
        queryCount: savedQueryCount,
        groups: savedGroups,
      } = JSON.parse(saved);
      if (Array.isArray(savedTabs) && savedTabs.length > 0) {
        // Stamp the connection onto every restored tab: what was saved is one connection's tabs, and
        // from here on a tab carries its own connection rather than inheriting the active one.
        const owned: TabInfo[] = savedTabs.map((tb: TabInfo) => ({ ...tb, connId }));
        // MERGE, do not replace. Tabs of other connections stay in state so switching back to them
        // is instant and their unsaved SQL survives — that is the whole point of §4.5. Any tabs
        // already held for *this* connection are dropped first, so a re-restore cannot duplicate.
        setTabs((prev) => [...prev.filter((tb) => tb.connId !== connId), ...owned]);
        // Saves from before groups existed have no such field -> every tab becomes a loose one.
        setTabGroups(Array.isArray(savedGroups) ? savedGroups : []);
        setActiveTabId(savedActiveId || owned[0].id);
        setQueryCount(savedQueryCount || (savedTabs.length + 1));
        return true;
      }
    } catch (e) {
      console.error('Lỗi phục hồi tab history:', e);
    }
    return false;
  };

  // Handle successful database connection
  const handleConnect = (
    dbName: string,
    dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis',
    color?: string,
    config?: DbConnectionConfig,
    profile?: { id: string; name: string; env?: ConnEnv },
    schema?: string | null,
  ) => {
    // Remember which config produced which `conn_id`. The backend deliberately does not hand the
    // config back — it carries credentials — but switching between open connections needs it, both
    // to key that connection's tabs (`tabsStorageKey`) and to label it. Keyed by the id the backend
    // just minted, which `dbHelper` captured from `connect()`.
    const id = activeConnId();
    const env = normalizeEnv(profile?.env);
    setConnection({ connId: id, dbName, dbType, schema: schema ?? null });
    setActiveProfile({ id: profile?.id || '', name: profile?.name || dbName, color: color || '' });
    setActiveConnConfig(config || null);
    setActiveConnIdState(id);
    // Marking a connection production is already the whole statement of intent; making the user also
    // find a menu item is how read-only ends up off on exactly the connection it mattered for.
    if (id && isProduction(env)) {
      void dbHelper.setConnectionReadOnly(id, true);
    }
    if (id) {
      setOpenConns((prev) => [
        ...prev.filter((c) => c.connId !== id),
        { connId: id, config: config || null, dbType, profileName: profile?.name || dbName, color: color || '', env, readOnly: isProduction(env) },
      ]);
    }

    // Switching connection -> clear the table/column cache so completion and hover hold no data from the old DB
    invalidateCatalog();

    // Try to restore tabs from localStorage
    if (restoreTabs(id, config, dbType, dbName, schema)) return;

    // Open an initial SQL Query tab on connect
    openInitialTab(id, dbType);
  };

  /**
   * Opens a connection from a saved profile, picked in the Quick Switcher.
   *
   * It goes through `connectSavedProfile` (shared with Connection Manager) and then `handleConnect`
   * — the **same path** the connection screen takes, not a copy. A second copy of the connect path
   * would have to carry SSH, SSL, IAM and secret merging along with it; the two would drift, and
   * drift here shows up as "this profile connects on that screen but not on this one".
   */
  const handleConnectSavedProfile = async (profile: SavedProfile) => {
    const res = await connectSavedProfile(profile);
    if (!res.success) {
      alert(res.message || t('db.errConnect'));
      return;
    }
    handleConnect(
      res.database || profile.name,
      profile.type,
      profile.color,
      res.config,
      // `env` rides along for the same reason: without it, opening prod from the switcher would not
      // turn read-only on, while opening the very same profile from Connection Manager would.
      { id: profile.id, name: profile.name, env: normalizeEnv(profile.env) },
      res.schema,
    );
  };

  // Asks for confirmation when the open table still has unsaved edits.
  //
  // This flag used to be a global, `window.__gridDirty`, set by DataGrid. It became state because
  // the tab strip needs an "unsaved" dot, and writing a global triggers no render. Only one *table*
  // tab is mounted at a time (see active-panel-container below — query and terminal tabs are
  // mounted permanently), so there is at most one dirty tab.
  // This question cannot use window.confirm: inside the Tauri webview it calls
  // `plugin:dialog|confirm`, a command the dialog plugin does not ship, so the call throws
  // and returns undefined — meaning every attempt to leave a half-edited tab was silently
  // blocked. The app's dialog is asynchronous, so guardDirty takes the ACTION and runs it
  // itself instead of returning true/false the way it used to.
  const guardDirty = (action: () => void) => {
    if (!dirtyTabId) {
      action();
      return;
    }
    // setState given a function reads it as an updater -> wrap it to store the function.
    setDiscardPrompt(() => action);
  };

  // Both tab-moving functions live in utils/tabGroups.ts: they are pure and they are where the
  // "one group stays adjacent" invariant is kept, which is what makes them testable there.
  const handleReorderTabs = (from: number, to: number, groupId: string | undefined) =>
    setTabs((prev) => reorderTabs(prev, from, to, groupId));

  const handleCreateTabGroup = (tabId: string) => {
    const id = `group_${Date.now()}`;
    const color = TAB_GROUP_COLORS[tabGroups.length % TAB_GROUP_COLORS.length];
    setTabGroups((prev) => [...prev, { id, name: t('tabs.defaultGroupName', { n: prev.length + 1 }), color }]);
    setTabs((prev) => moveTabIntoGroup(prev, tabId, id));
  };

  const handleAssignTabGroup = (tabId: string, groupId: string) =>
    setTabs((prev) => moveTabIntoGroup(prev, tabId, groupId));

  const handleRemoveTabFromGroup = (tabId: string) =>
    setTabs((prev) => moveTabIntoGroup(prev, tabId, undefined));

  const handleRenameTabGroup = (groupId: string, name: string) =>
    setTabGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, name } : g)));

  const handleSetTabGroupColor = (groupId: string, color: string) =>
    setTabGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, color } : g)));

  // Collapsing a group that CONTAINS the viewed tab has to switch to another tab first, exactly as
  // Chrome does. Otherwise the render expands the group again (it never hides the tab whose content
  // is on screen) and clicking the group name looks like it does nothing — which is precisely why
  // the collapse button appeared "dead".
  const handleToggleTabGroup = (groupId: string) => {
    const group = tabGroups.find((g) => g.id === groupId);
    if (!group) return;

    const collapsing = !group.collapsed;
    const applyCollapse = () =>
      setTabGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, collapsed: collapsing } : g)));

    if (collapsing && tabs.some((tab) => tab.id === activeTabId && tab.groupId === groupId)) {
      const outside = tabs.filter((tab) => tab.groupId !== groupId);
      // This group is all the window has: collapsing it would leave nothing to display.
      if (outside.length === 0) return;
      guardDirty(() => {
        const at = tabs.findIndex((tab) => tab.id === activeTabId);
        const after = tabs.slice(at + 1).find((tab) => tab.groupId !== groupId);
        const before = tabs.slice(0, at).reverse().find((tab) => tab.groupId !== groupId);
        setActiveTabId((after ?? before ?? outside[0]).id);
        applyCollapse();
      });
      return;
    }

    applyCollapse();
  };

  const handleMoveTabGroup = (groupId: string, targetIndex: number) =>
    setTabs((prev) => moveGroup(prev, groupId, targetIndex));

  const handleCloseTabGroup = (groupId: string) => {
    guardDirty(() => {
      const remaining = tabs.filter((tab) => tab.groupId !== groupId);
      setTabs(remaining);
      if (!remaining.some((tab) => tab.id === activeTabId)) {
        setActiveTabId(remaining[remaining.length - 1]?.id ?? null);
      }
    });
  };

  // Empty groups are dropped. Done centrally here rather than at each tab-closing site: tabs close
  // through a great many paths (the X, middle click, close others, close to the right, close all),
  // and missing one leaves a ghost group behind in the saved state.
  React.useEffect(() => {
    queueMicrotask(() => {
      setTabGroups((prev) => {
        const used = new Set(tabs.map((tab) => tab.groupId).filter(Boolean));
        const next = prev.filter((g) => used.has(g.id));
        return next.length === prev.length ? prev : next;
      });
    });
  }, [tabs]);

  const handleSelectTab = (id: string) => {
    if (id === activeTabId) return;
    guardDirty(() => setActiveTabId(id));
  };

  const handleDisconnect = () => {
    guardDirty(async () => {
      const gone = activeConnId();
      await dbHelper.disconnect();
      const rest = openConns.filter((c) => c.connId !== gone);
      setOpenConns(rest);
      // Drop that connection's tabs too — they are invisible once it is gone, but leaving them in
      // state means a later connection reusing the id would inherit them.
      setTabs((prev) => prev.filter((tb) => tb.connId !== gone));
      // Disconnecting one of several connections leaves the app connected — fall through to
      // whichever is left instead of dropping the user back to the connection manager.
      const next = rest[rest.length - 1];
      if (next) {
        selectConnection(next.connId);
        return;
      }
      setActiveConnIdState('');
      setConnection(null);
      setActiveProfile({ id: '', name: '', color: '' });
      setTabs([]);
      setActiveTabId(null);
      setQueryCount(1);
      setShowSidebar(true);
    });
  };

  const handleNewConnection = () => setAddingConn(true);

  /**
   * Close one connection from the rail.
   *
   * Closing the one on screen falls through to whichever is left rather than dropping the user back
   * to the connection manager — same rule as `handleDisconnect`. Closing one that is NOT on screen
   * touches nothing else: the workspace, its tabs and its transaction all stay where they are, which
   * is the whole reason each connection has its own session.
   */
  const closeConnection = (connId: string) => {
    const isActive = connId === activeConnIdState;
    const finish = async () => {
      // `connId`, not `activeConnIdState`: "Close connection" on a cell that is not the one on
      // screen used to close the one on screen instead — the backend dropped the wrong entry while
      // the cell the user clicked stayed in the rail, looking unclosable.
      await dbHelper.disconnect(connId);
      const rest = openConns.filter((c) => c.connId !== connId);
      setOpenConns(rest);
      setTabs((prev) => prev.filter((tb) => tb.connId !== connId));
      if (!isActive) return;
      const next = rest[rest.length - 1];
      if (next) {
        selectConnection(next.connId);
        return;
      }
      setActiveConnIdState('');
      setConnection(null);
      setActiveProfile({ id: '', name: '', color: '' });
      setTabs([]);
      setActiveTabId(null);
      setQueryCount(1);
      setShowSidebar(true);
    };
    // Only guard when the tabs about to be swapped are the ones with unsaved edits in them.
    if (isActive) guardDirty(finish);
    else void finish();
  };

  /**
   * Flip one connection's read-only flag.
   *
   * The flag is enforced in the backend's SQL funnels, but it is **also** read on the frontend —
   * `QueryTabPanel`'s `connReadOnly` comes from `openConns`, so the editor can refuse a write
   * without a round trip. That mirror exists, so this has to write it: flipping only the backend
   * left the editor refusing every write while the rail already showed the padlock off, and the
   * one instruction the error gave the user did nothing.
   *
   * The value written is the one the **backend returns**, not `!cur.readOnly` — that keeps the
   * mirror a copy of the authority rather than a second opinion about it.
   */
  const toggleConnectionReadOnly = (connId: string) => {
    void (async () => {
      const list = await dbHelper.listConnections().catch(() => []);
      const cur = list.find((c) => c.connId === connId);
      if (!cur) return;
      const now = await dbHelper.setConnectionReadOnly(connId, !cur.readOnly);
      setOpenConns((prev) => prev.map((c) => (c.connId === connId ? { ...c, readOnly: now } : c)));
      // The rail redraws from `list_connections`; bumping this is what makes it refetch.
      setRailReloadKey((k) => k + 1);
    })();
  };

  const closeOtherConnections = (keepId: string) => {
    const doomed = openConns.filter((c) => c.connId !== keepId);
    if (!doomed.length) return;
    const run = async () => {
      for (const c of doomed) await dbHelper.disconnect(c.connId);
      setOpenConns((prev) => prev.filter((c) => c.connId === keepId));
      // Already on the survivor: nothing to reload. Otherwise the workspace has to move to it,
      // because the connection it was showing no longer exists.
      if (keepId !== activeConnIdState) selectConnection(keepId);
    };
    if (keepId !== activeConnIdState) guardDirty(run);
    else void run();
  };

  /**
   * A database picked from the title bar was **opened as another connection**, sharing the server
   * of the one it was picked from (same tunnel, same credentials). Register it and switch to it.
   *
   * It inherits that connection's `config` because it is the same server; only the database differs,
   * and `tabsStorageKey` already keys on `(config, database, schema)` — so the two get separate tab
   * lists without any extra bookkeeping.
   *
   * It also inherits `env` and `readOnly`, and those two must travel together: the backend copies
   * the read-only flag onto the new entry, so leaving `env` behind would draw a padlock with no
   * environment edge — two signals about the same connection disagreeing on screen. Another database
   * on the production server is still the production server.
   */
  const handleDatabaseOpened = (newId: string, dbName: string, schema?: string | null) => {
    const from = openConns.find((c) => c.connId === activeConnIdState);
    setOpenConns((prev) => [
      ...prev.filter((c) => c.connId !== newId),
      {
        connId: newId,
        config: from?.config ? { ...from.config, database: dbName } : null,
        dbType: from?.dbType ?? 'mysql',
        profileName: dbName,
        color: from?.color ?? '',
        env: from?.env ?? 'none',
        readOnly: from?.readOnly,
      },
    ]);
    // `selectConnection` reads `openConns`, which this render has not committed yet — point the
    // workspace at the new connection directly instead of racing the state update.
    setActiveConnId(newId);
    setActiveConnIdState(newId);
    setActiveConnConfig(from?.config ? { ...from.config, database: dbName } : null);
    setConnection((prev) => (prev ? { ...prev, connId: newId, dbName, schema: schema ?? null } : prev));
    invalidateCatalog();
    setDbReloadKey((k) => k + 1);
    if (from && restoreTabs(newId, { ...(from.config as DbConnectionConfig), database: dbName }, from.dbType, dbName, schema)) return;
    openInitialTab(newId, from?.dbType);
  };

  /**
   * Point the whole workspace at another open connection.
   *
   * Phase 2 keeps the "one connection on screen at a time" model: switching swaps the tab list the
   * way changing database already does. Tabs from different connections coexisting is Phase 3
   * (§4.5), and it is the step that also removes the ambient id `setActiveConnId` writes here.
   */
  const selectConnection = (connId: string) => {
    const entry = openConns.find((c) => c.connId === connId);
    if (!entry) return;
    // No `guardDirty` any more: switching no longer throws a tab list away. This connection's tabs
    // stay in `tabs` exactly as they were — unsaved grid edits included — and come back untouched
    // when the user switches back. Asking "discard changes?" for something nothing discards would be
    // a prompt that lies.
    setActiveConnId(connId);
    setActiveConnIdState(connId);
    void (async () => {
      const list = await dbHelper.listConnections().catch(() => []);
      const info = list.find((c) => c.connId === connId);
      if (!info) return;
      setConnection({ connId, dbName: info.db, dbType: entry.dbType, schema: info.schema });
      setActiveConnConfig(entry.config);
      setActiveProfile({ id: '', name: entry.profileName, color: entry.color });
      setDbReloadKey((k) => k + 1);
      // Only load from storage the FIRST time a connection is shown. After that its tabs are
      // already in memory, and re-reading would overwrite whatever the user has typed since.
      if (tabs.some((tb) => tb.connId === connId)) {
        const own = tabs.filter((tb) => tb.connId === connId);
        setActiveTabId(own[own.length - 1]?.id ?? null);
        return;
      }
      if (restoreTabs(connId, entry.config, entry.dbType, info.db, info.schema)) return;
      openInitialTab(connId, entry.dbType);
    })();
  };

  // After a schema change (Postgres only): the backend has already accepted the new schema by the
  // time this is called.
  //
  // Changing schema changes the whole set of tables, so it has to do everything a database change
  // does: clear the catalog cache (completion and hover still hold the old schema's tables), make
  // Sidebar/DataGrid reload, and change the tabs' localStorage key — the open tabs point at tables
  // of the old schema.
  const handleSchemaChanged = (newSchema: string) => {
    const nextConn = connection ? { ...connection, schema: newSchema } : null;
    setConnection(nextConn);
    invalidateCatalog();
    setDbReloadKey((k) => k + 1);

    if (nextConn && restoreTabs(activeConnIdState, activeConnConfig, nextConn.dbType, nextConn.dbName, newSchema)) return;

    openInitialTab(activeConnIdState, nextConn?.dbType);
  };

  // Open a specific table in a new or existing tab
  const handleSelectTable = (
    tableName: string,
    initialViewMode: GridViewMode = 'data',
    initialFilter?: { column: string; value: any },
    // `TableItem.schema` — only the sidebar's Temporary section has one, and only on Postgres. It
    // rides on the tab so a reopened `pg_temp_N` table keeps addressing the same relation.
    tableSchema?: string
  ) => {
    const tabId = `table_${tableName}`;
    const open = () => {
      // `visibleTabs`: a table of the same name open on another connection is a different tab. The
      // global lookup found it, skipped creating this connection's, and selected an id this
      // connection has none of — the empty pane, not an error.
      const exists = visibleTabs.find((tab) => tab.id === tabId);

      if (!exists) {
        const newTab: TabInfo = {
          id: tabId,
          type: 'table',
          name: tableName,
          label: tableName,
          initialViewMode,
          initialFilter,
          tableSchema,
        } as any;
        setTabs([...tabs, { ...newTab, connId: activeConnIdState }]);
      } else {
        setTabs(tabs.map(tab => tab.id === tabId ? { ...tab, initialViewMode, initialFilter, tableSchema } as any : tab));
      }
      setActiveTabId(tabId);
    };

    if (tabId === activeTabId) open();
    else guardDirty(open);
  };

  // Ctrl+Click / F12 on a table name, or clicking an FK link -> open the table tab with a filter.
  // A ref is used so the listener (registered once) always calls the latest handleSelectTable.
  const selectTableRef = React.useRef(handleSelectTable);
  React.useEffect(() => {
    selectTableRef.current = handleSelectTable;
  });
  React.useEffect(() => {
    const handleOpenTableTab = (e: any) => {
      const table = e.detail?.table;
      if (table) selectTableRef.current(table, e.detail?.viewMode || 'data', e.detail?.initialFilter);
    };
    window.addEventListener('open-table-tab', handleOpenTableTab);
    return () => window.removeEventListener('open-table-tab', handleOpenTableTab);
  }, []);

  // ---- Redis tabs ----
  //
  // The three handlers below do for Redis what `handleSelectTable` does for a table: open the tab if
  // it is not there, focus it if it is. Kept separate rather than folded into `handleSelectTable`
  // because the tab kind, the label and the "already open" test all differ, and merging them would
  // produce one function taking a flag to pick a branch.

  /** The db index of the Redis connection being viewed. Taken from the database name (`db3`), not from state of its own. */
  const redisDbIndex = React.useMemo(() => {
    if (connection?.dbType !== 'redis') return 0;
    const n = parseInt((connection.dbName || '').replace(/^db/, ''), 10);
    return Number.isFinite(n) ? n : 0;
  }, [connection?.dbType, connection?.dbName]);

  const handleOpenRedisKey = (key: string) => {
    const tabId = redisKeyTabId(activeConnIdState, key);
    if (!visibleTabs.some((tab) => tab.id === tabId)) {
      setTabs([
        ...tabs,
        {
          id: tabId,
          connId: activeConnIdState,
          type: 'redis-key',
          name: key,
          label: key,
          redisKeyInfo: { keyName: key },
        },
      ]);
    }
    setActiveTabId(tabId);
  };

  const handleOpenRedisTool = React.useCallback((type: RedisTabType) => {
    if (type === 'redis-key') return;
    const tabId = redisToolTabId(activeConnIdState, type);
    if (!visibleTabs.some((tab) => tab.id === tabId)) {
      const label = redisToolTabLabel(type, t);
      setTabs([
        ...tabs,
        { id: tabId, connId: activeConnIdState, type, name: label, label },
      ]);
    }
    setActiveTabId(tabId);
  }, [activeConnIdState, visibleTabs, t, tabs]);

  /**
   * Changes a Redis connection's db index.
   *
   * This is **not** mutating the current connection's state — the backend mints or finds a different
   * `conn_id` for `(server, dbN)` (§2.1) — so what happens here is identical to clicking another
   * connection on `DbRail`: point `connId` at the new id and let `selectConnection` restore that
   * connection's tab set. The old db's tabs stay in state, exactly like another connection's do.
   */
  const handleRedisSelectDb = async (index: number, knownConnId?: string) => {
    let target = knownConnId;
    if (!target) {
      const res = await dbHelper.redisSelectDb(index);
      if (!res.success || !res.connId) {
        alert(res.error || t('redis.errSelectDb'));
        return;
      }
      target = res.connId;
    }
    if (target === activeConnIdState) return;
    const cfg = activeConnConfig;
    const dbName = `db${index}`;
    setOpenConns((prev) => [
      ...prev.filter((c) => c.connId !== target),
      {
        connId: target,
        config: cfg,
        dbType: 'redis',
        profileName: activeProfile.name || dbName,
        color: activeProfile.color || '',
        env: openConns.find((c) => c.connId === activeConnIdState)?.env ?? 'none',
        readOnly,
      },
    ]);
    setActiveConnId(target);
    setActiveConnIdState(target);
    setConnection({ connId: target, dbName, dbType: 'redis', schema: null });
    if (!restoreTabs(target, cfg, 'redis', dbName, null)) {
      // No saved tabs: open the CLI Console as the first one. Redis has no "SQL Query" to open the
      // way `openInitialTab` does, and an empty workspace tells the user nothing about what to do next.
      const tabId = redisToolTabId(target, 'redis-console');
      const label = redisToolTabLabel('redis-console', t);
      setTabs((prev) => [
        ...prev.filter((tb) => tb.connId !== target),
        { id: tabId, connId: target, type: 'redis-console', name: label, label },
      ]);
      setActiveTabId(tabId);
    }
  };

  // Create a new SQL Query tab
  const handleNewQueryTab = React.useCallback(() => {
    if (connection?.dbType === 'redis') {
      handleOpenRedisTool('redis-console');
      return;
    }
    const tabId = `query_${Date.now()}`;
    const newTab: TabInfo = {
      id: tabId,
      type: 'query',
      name: 'SQL Query',
      label: t('app.queryTabLabel', { n: queryCount }),
    };
    setTabs([...tabs, { ...newTab, connId: activeConnIdState }]);
    setActiveTabId(tabId);
    setQueryCount(queryCount + 1);
  }, [connection?.dbType, handleOpenRedisTool, t, queryCount, tabs, activeConnIdState]);

  // Open SQL tab with existing content (e.g. sync script from DB compare dialog)
  const openQueryTabWithSql = React.useCallback((sql: string) => {
    const tabId = `query_${Date.now()}`;
    const newTab = {
      id: tabId,
      type: 'query',
      name: 'SQL Query',
      label: t('app.queryTabLabel', { n: queryCount }),
      sql,
    } as TabInfo;
    setTabs([...tabs, { ...newTab, connId: activeConnIdState }]);
    setActiveTabId(tabId);
    setQueryCount(queryCount + 1);
  }, [t, queryCount, tabs, activeConnIdState]);

  // Close tab
  const handleCloseTab = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const close = () => {
      const tabIndex = tabs.findIndex((tab) => tab.id === id);
      const newTabs = tabs.filter((tab) => tab.id !== id);

      setTabs(newTabs);

      // If closing active tab, switch to another
      if (activeTabId === id) {
        if (newTabs.length > 0) {
          // select next or previous tab
          const nextActiveIndex = Math.min(tabIndex, newTabs.length - 1);
          setActiveTabId(newTabs[nextActiveIndex].id);
        } else {
          setActiveTabId(null);
        }
      }
    };

    // Closing a table tab with edits in progress -> ask for confirmation
    if (id === activeTabId) guardDirty(close);
    else close();
  };

  const handleCloseOthers = (id: string) => {
    const newTabs = tabs.filter((tab) => tab.id === id);
    setTabs(newTabs);
    setActiveTabId(id);
  };

  const handleCloseTabsToRight = (id: string) => {
    const tabIndex = tabs.findIndex((tab) => tab.id === id);
    if (tabIndex !== -1) {
      const newTabs = tabs.slice(0, tabIndex + 1);
      setTabs(newTabs);

      const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);
      if (activeIndex > tabIndex) {
        setActiveTabId(id);
      }
    }
  };

  const handleCloseAll = () => {
    // Only the tabs the user can actually see. Other connections' tabs are held in the same array
    // but are not on screen, so wiping them would be closing something the user never asked about.
    setTabs((prev) => prev.filter((tb) => tb.connId !== activeConnIdState));
    setActiveTabId(null);
  };


  // Insert SQL generated by AI into current query editor
  const handleInsertSql = (sql: string) => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId);

    if (activeTab && activeTab.type === 'query') {
      // Update existing SQL tab
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.id === activeTabId) {
            return { ...tab, sql }; // Update initialSql prop
          }
          return tab;
        })
      );

      // Force remount or change value by passing key to Monaco
      // We can append a timestamp or change tab ID, but simple update is fine.
    } else {
      // Create a new SQL query tab with the generated SQL
      const tabId = `query_${Date.now()}`;
      const newTab: TabInfo = {
        id: tabId,
        type: 'query',
        name: 'SQL Query',
        label: t('app.queryTabLabel', { n: queryCount }),
      };
      // Pre-populate sql property
      (newTab as any).sql = sql;

      setTabs([...tabs, { ...newTab, connId: activeConnIdState }]);
      setActiveTabId(tabId);
      setQueryCount(queryCount + 1);
    }
  };

  const handleRunAiSql = (sql: string) => {
    handleInsertSql(sql);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('execute-active-query'));
    }, 150);
  };

  // The Terminal's config: when the current connection uses SSH, inherit it so the shell opens ON
  // THAT host/VM; otherwise open a local shell.
  const terminalConfig = (): DbConnectionConfig => {
    const c = activeConnConfig;
    if (c?.sshEnabled && c.sshHost) {
      return {
        type: connection?.dbType || 'sqlite',
        sshEnabled: true,
        sshHost: c.sshHost,
        sshPort: c.sshPort,
        sshUser: c.sshUser,
        sshAuthType: c.sshAuthType,
        sshPassword: c.sshPassword,
        sshKeyPath: c.sshKeyPath,
        sshKeyContent: c.sshKeyContent,
        sshPassphrase: c.sshPassphrase,
      };
    }
    return { type: connection?.dbType || 'sqlite' };
  };

  const handleOpenTerminal = () => {
    if (!connection) return;
    const id = `terminal_${Date.now()}`;
    const newTab: TabInfo = {
      id,
      connId: activeConnIdState,
      type: 'terminal',
      name: 'Terminal',
      label: 'Terminal',
      config: terminalConfig(),
      floating: false,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
  };

  const handleOpenRoutineTab = async (name: string, kind: 'procedure' | 'function') => {
    const tabId = `routine_${kind}_${name}`;
    // `visibleTabs`, not `tabs`: ids are unique per connection only, so a procedure of the same name
    // on another connection matched here and the function returned having done nothing but select an
    // id that this connection has no tab for — which renders as an empty pane, not as an error.
    const existing = visibleTabs.find((tb) => tb.id === tabId);
    if (existing) {
      setActiveTabId(tabId);
      return;
    }
    const res = await dbHelper.getObjectDefinition(activeConnIdState, name, kind);
    const sql = res.success && res.sql ? res.sql : '';
    const newTab: TabInfo = {
      id: tabId,
      connId: activeConnIdState,
      type: 'routine',
      name: name,
      label: `${kind === 'procedure' ? 'Proc' : 'Func'}: ${name}`,
      routineInfo: { name, kind, sql },
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
  };

  const handleOpenViewTab = async (name: string) => {
    const tabId = `view_${name}`;
    const existing = visibleTabs.find((tb) => tb.id === tabId);
    if (existing) {
      setActiveTabId(tabId);
      return;
    }
    const res = await dbHelper.getObjectDefinition(activeConnIdState, name, 'view');
    const sql = res.success && res.sql ? res.sql : '';
    const newTab: TabInfo = {
      id: tabId,
      connId: activeConnIdState,
      type: 'view',
      name: name,
      label: `View: ${name}`,
      viewInfo: { name, sql },
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
  };

  const handleOpenErDiagram = () => {
    const tabId = `er_${activeConnIdState}_${connection?.dbName || 'default'}`;
    const existing = visibleTabs.find((tb) => tb.id === tabId);
    if (existing) {
      setActiveTabId(tabId);
      return;
    }
    const label = `ER: ${connection?.dbName || 'Database'}`;
    const newTab: TabInfo = {
      id: tabId,
      connId: activeConnIdState,
      type: 'er',
      name: label,
      label,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
  };

  const handleOpenProcessMonitor = () => {
    const tabId = `process_monitor_${activeConnIdState}`;
    const existing = visibleTabs.find((tb) => tb.id === tabId);
    if (existing) {
      setActiveTabId(tabId);
      return;
    }
    const label = `Processes: ${connection?.dbName || 'Server'}`;
    const newTab: TabInfo = {
      id: tabId,
      connId: activeConnIdState,
      type: 'process-monitor',
      name: label,
      label,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
  };

  const handleOpenSchemaMigration = () => {
    const tabId = `schema_migration_${activeConnIdState}`;
    const existing = visibleTabs.find((tb) => tb.id === tabId);
    if (existing) {
      setActiveTabId(tabId);
      return;
    }
    const label = `Diff: ${connection?.dbName || 'Schema'}`;
    const newTab: TabInfo = {
      id: tabId,
      connId: activeConnIdState,
      type: 'schema-migration',
      name: label,
      label,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
  };

  const handleOpenDbCompare = () => {
    const tabId = `db_compare_${activeConnIdState}`;
    const existing = visibleTabs.find((tb) => tb.id === tabId);
    if (existing) {
      setActiveTabId(tabId);
      return;
    }
    const label = `Compare: ${connection?.dbName || 'Databases'}`;
    const newTab: TabInfo = {
      id: tabId,
      connId: activeConnIdState,
      type: 'db-compare',
      name: label,
      label,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
  };

  const handleOpenDbInfo = (initialTab: 'current' | 'all' = 'current') => {
    const tabId = `db_info_${activeConnIdState}_${initialTab}`;
    const existing = visibleTabs.find((tb) => tb.id === tabId);
    if (existing) {
      setActiveTabId(tabId);
      return;
    }
    const label = initialTab === 'all' ? 'All Databases' : `Db Info: ${connection?.dbName || 'Server'}`;
    const newTab: TabInfo = {
      id: tabId,
      connId: activeConnIdState,
      type: 'db-info',
      name: label,
      label,
      dbInfoTab: initialTab,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
  };

  const handleOpenDataGen = (tableName?: string | null) => {
    const tabId = `data_gen_${activeConnIdState}`;
    const existing = visibleTabs.find((tb) => tb.id === tabId);
    if (existing) {
      if (tableName) {
        setTabs((prev) => prev.map((tb) => (tb.id === tabId ? { ...tb, dataGenTable: tableName } : tb)));
      }
      setActiveTabId(tabId);
      return;
    }
    const label = `Data Gen: ${connection?.dbName || 'Database'}`;
    const newTab: TabInfo = {
      id: tabId,
      connId: activeConnIdState,
      type: 'data-gen',
      name: label,
      label,
      dataGenTable: tableName ?? null,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
  };

  const handleOpenExportDb = () => {
    const tabId = `export_db_${activeConnIdState}`;
    const existing = visibleTabs.find((tb) => tb.id === tabId);
    if (existing) {
      setActiveTabId(tabId);
      return;
    }
    const label = `Export: ${connection?.dbName || 'Database'}`;
    const newTab: TabInfo = {
      id: tabId,
      connId: activeConnIdState,
      type: 'export-db',
      name: label,
      label,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
  };

  const handleOpenImportDb = () => {
    const tabId = `import_db_${activeConnIdState}`;
    const existing = visibleTabs.find((tb) => tb.id === tabId);
    if (existing) {
      setActiveTabId(tabId);
      return;
    }
    const label = `Import: ${connection?.dbName || 'Database'}`;
    const newTab: TabInfo = {
      id: tabId,
      connId: activeConnIdState,
      type: 'import-db',
      name: label,
      label,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
  };

  const handleOpenMcpServer = () => {
    const tabId = 'mcp_server';
    const existing = visibleTabs.find((tb) => tb.id === tabId);
    if (existing) {
      setActiveTabId(tabId);
      return;
    }
    const label = 'MCP Server';
    const newTab: TabInfo = {
      id: tabId,
      connId: activeConnIdState,
      type: 'mcp-server',
      name: label,
      label,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
  };

  /**
   * The tab whose panel is on screen — looked up in `visibleTabs`, not `tabs`.
   *
   * Tab ids are only unique per connection (`query_1` exists on every one), so searching the whole
   * array could return a tab belonging to a connection that is not on screen. Narrowing first makes
   * that impossible rather than unlikely.
   */
  const getActiveTab = () => {
    return visibleTabs.find((tb) => tb.id === activeTabId) || null;
  };

  const activeTab = getActiveTab();

  /** The key of the tab being viewed — the sidebar highlights the matching row. */
  const activeRedisKey =
    activeTab?.type === 'redis-key' ? activeTab.redisKeyInfo?.keyName ?? null : null;
  const activeTable = activeTab?.type === 'table' ? activeTab.name : null;

  /** Updates one tab. Must be stable: QueryTabPanel memoises on its props (see there). */
  const patchTab = React.useCallback((id: string, patch: Partial<TabInfo>) => {
    setTabs(prev => prev.map(tb => (tb.id === id ? { ...tb, ...patch } : tb)));
  }, []);

  // Records a query tab that has just been opened and drops the ones that were closed. It runs on
  // every `tabs` change (that is, on every debounced keystroke) but returns the very same Set when
  // nothing changed, so it causes no extra renders.
  React.useEffect(() => {
    queueMicrotask(() => {
      setMountedQueryTabs(prev => {
        const live = new Set(tabs.filter(tb => tb.type === 'query').map(tb => tb.id));
        const next = new Set<string>();
        for (const id of prev) if (live.has(id)) next.add(id);
        if (activeTabId && live.has(activeTabId)) next.add(activeTabId);
        if (next.size === prev.size && [...next].every(id => prev.has(id))) return prev;
        return next;
      });
    });
  }, [tabs, activeTabId]);

  // The current tab list's scope, used as the prefix of QueryTabPanel's key.
  const tabScope = scopeKey(activeConnConfig, connection?.dbName, connection?.schema);

  // Built into a variable because the title bar sits at two different places in the tree: on the
  // connection screen it goes *inside* .cm-screen so it takes that screen's aurora layer, while in
  // the workspace it stays a direct child of #root as before.
  const titleBar = (
    <TitleBar
      // Safe Mode is stored per server, and only the frontend has the config to derive that key (the
      // backend deliberately never hands the config back, because it carries credentials).
      connKey={connKey(activeConnConfig)}
      hasConnection={!!connection}
      connId={activeConnIdState}
      readOnly={readOnly}
      onToggleReadOnly={toggleReadOnly}
      // version/tls are no longer here: TitleBar reads the real values from get_connection_status,
      // and these fields are only a fallback for the moment before the first ping returns.
      activeConnectionInfo={{
        host: activeConnConfig?.host || 'LOCAL',
        dbType: connection?.dbType?.toUpperCase() || 'MYSQL',
        dbName: connection?.dbName,
      }}
      activeProfileName={activeProfile.name}
      activeProfileColor={activeProfile.color}
      // Read straight from the open connection rather than mirroring into `activeProfile`: the rail,
      // the SQL editor's confirmation and the read-only default all read it from there, and a fourth
      // copy is a fourth thing that can disagree.
      activeProfileEnv={openConns.find((c) => c.connId === activeConnIdState)?.env ?? 'none'}
      // `db` is not in `openConns` (there the database is part of `config`), so it is derived here.
      // The viewed connection prefers `connection.dbName`: after a `USE` inside a restore, the
      // backend is the side that knows the real database, while `config` is only what it was opened
      // with.
      openConns={openConns.map((c) => ({
        ...c,
        env: c.env ?? 'none',
        db:
          (c.connId === activeConnIdState ? connection?.dbName : undefined) ||
          c.config?.database ||
          c.config?.sqlitePath ||
          '',
      }))}
      onSelectConnection={selectConnection}
      onConnectSavedProfile={handleConnectSavedProfile}
      onProfileChange={handleProfileChange}
      theme={theme}
      onThemeChange={applyTheme}
      onReconnect={handleReconnect}
      activeTableName={activeTable}
      onNewConnection={handleNewConnection}
      onDisconnect={handleDisconnect}
      onNewQuery={handleNewQueryTab}
      onExportDatabase={handleOpenExportDb}
      onImportDatabase={handleOpenImportDb}
      onToggleSidebar={() => setShowSidebar(prev => !prev)}
      onToggleTheme={toggleTheme}
      onShowShortcuts={() => setShowShortcuts(true)}
      onShowAbout={() => setShowAbout(true)}
      onShowWhatsNew={() => setShowWhatsNew(true)}
      onOpenCompare={handleOpenDbCompare}
      onToggleTerminal={handleOpenTerminal}
      aiOpen={showAi}
      onToggleAiAssistant={() => setShowAi(prev => !prev)}
      onDatabaseOpened={handleDatabaseOpened}
      onOpenAllDbStats={() => handleOpenDbInfo('all')}
      onOpenDocs={() => setShowDocModal(true)}
    />
  );

  return (
    <>
      {/* Safe Mode asks through this component. Mounted once at the root: `utils/safeMode.ts` has no
          React, so it holds a registered confirmer, and the dialog has to live outside every tab so
          the question still appears wherever the command came from. */}
      <SafeModeGate />
      <McpApprovalGate />

      {/* Adding another connection while one is already open (the rail's `+` button). It reuses
          `ConnectionManager` whole rather than writing a second screen; `handleConnect` already does
          the right thing (push into `openConns`, then move the workspace to the new connection). */}
      {addingConn && connection && (
        <Modal
          title={t('titlebar.newConnection')}
          onClose={() => setAddingConn(false)}
          zIndex={10000}
          width="min(1100px, 94vw)"
        >
          {/* `ModalBody` defaults to padding 16 + gap 14 + its own scrolling: right for a form, wrong
              for a two-panel screen. With those defaults the container grows with its content, so the
              Save/Test/Connect button row is pushed below the fold and has to be scrolled to, while
              the two panels do not scroll independently as they do on the main screen. Pin the height
              and hand scrolling back to them.
              The `style` prop rather than a class: that is ModalBody's API, and its inline style beats
              every CSS rule — see the shortcuts box below, done the same way. */}
          <ModalBody style={{ padding: 0, gap: 0, overflow: 'hidden', height: 'min(74vh, 660px)' }}>
            <ConnectionManager
              connId={activeConnIdState}
              embedded
              onConnect={(...args) => {
                setAddingConn(false);
                handleConnect(...args);
              }}
            />
          </ModalBody>
        </Modal>
      )}

      {!connection ? (
        // The title bar sits inside .cm-screen rather than above it: the aurora layer is that
        // shell's ::before, so it can only cover what the shell contains. Outside it, the title
        // bar's bottom edge is always a visible colour seam.
        <div className="cm-screen">
          {titleBar}
          <ConnectionManager connId={activeConnIdState} onConnect={handleConnect} />
        </div>
      ) : (
        <>
          {titleBar}
          <div className="workspace-container">
            {/* Connection column left of the sidebar. Tied to the sidebar (Ctrl+P is about
                reclaiming space, hiding half of it makes no sense) and only shown from 2
                connections up — with one there is nothing to switch between and the title bar
                already carries its state. It lists what is OPEN, not every database on the
                server; see DbRail.tsx. */}
            {showSidebar && (
              <DbRail
                activeConnId={activeConnIdState}
                onSelect={(c) => selectConnection(c.connId)}
                onClose={closeConnection}
                onCloseOthers={closeOtherConnections}
                onToggleReadOnly={toggleConnectionReadOnly}
                envOf={(id) => openConns.find((c) => c.connId === id)?.env ?? 'none'}
                colorOf={(id) => openConns.find((c) => c.connId === id)?.color ?? ''}
                reloadKey={openConns.length + railReloadKey}
              />
            )}

            {/* Redis shares the sidebar frame but its body is quite different: a key list instead of
                a tree of tables/views/routines. A sibling component rather than a mode inside
                `Sidebar.tsx` — that file is already 2762 lines and not one of them mentions Redis
                (docs/redis-ui-unification-plan.md §3). */}
            {showSidebar && connection.dbType === 'redis' && (
              <RedisSidebarView
                connId={activeConnIdState}
                dbName={connection.dbName}
                dbIndex={redisDbIndex}
                storageScope={connKey(activeConnConfig) || 'redis'}
                readOnly={readOnly}
                activeKey={activeRedisKey}
                onOpenKey={handleOpenRedisKey}
                onOpenTool={handleOpenRedisTool}
                onSelectDb={(idx) => { void handleRedisSelectDb(idx); }}
              />
            )}

            {showSidebar && connection.dbType !== 'redis' && (
              <Sidebar
              connId={activeConnIdState}
                dbName={connection.dbName}
                dbType={connection.dbType}
                readOnly={readOnly}
                onSelectTable={handleSelectTable}
                onNewQuery={handleNewQueryTab}
                onOpenTerminal={handleOpenTerminal}
                terminalConfig={terminalConfig()}
                onDisconnect={handleDisconnect}
                activeTable={activeTable}
                onImportToTable={handleImportToTableTrigger}
                onExportTable={handleExportTableTrigger}
                onExportDatabase={handleOpenExportDb}
                onImportDatabase={handleOpenImportDb}
                onImportNewTable={() => { setGlobalImportTargetTable(null); setShowGlobalImportPicker(true); }}
                onOpenDbInfo={() => handleOpenDbInfo('current')}
                onOpenProcessMonitor={handleOpenProcessMonitor}
                onOpenAllDbStats={() => handleOpenDbInfo('all')}
                onSchemaMigration={handleOpenSchemaMigration}
                onCompareDatabases={handleOpenDbCompare}
                onOpenErDiagram={handleOpenErDiagram}
                onMcpSettings={handleOpenMcpServer}
                onGenerateData={handleOpenDataGen}
                onTableRenamed={(oldName, newName) => handleTableRenamed(activeConnIdState, oldName, newName)}
                onTableDropped={handleTableDropped}
                onDatabaseOpened={handleDatabaseOpened}
                schema={connection.schema}
                onSchemaChanged={handleSchemaChanged}
                onOpenQueryWithSql={openQueryTabWithSql}
                onOpenRoutineTab={handleOpenRoutineTab}
                onOpenViewTab={handleOpenViewTab}
              />
            )}

            <div className="main-workspace-area">
              {/* The AI Copilot toggle moved up to the title bar (TitleBar) — the tab strip now holds
                  only tabs and its own button cluster. */}
              <div style={{ display: 'flex', alignItems: 'center', background: 'var(--win-bg-tab-bar)', borderBottom: '1px solid var(--win-border)', position: 'relative', zIndex: 100 }}>
                <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
                  <TabManager
                    tabs={visibleTabs}
                    activeTabId={activeTabId}
                    dirtyTabId={dirtyTabId}
                    onSelectTab={handleSelectTab}
                    onCloseTab={handleCloseTab}
                    onCloseOthers={handleCloseOthers}
                    onCloseTabsToRight={handleCloseTabsToRight}
                    onCloseAll={handleCloseAll}
                    onReorderTabs={handleReorderTabs}
                    onNewQueryTab={handleNewQueryTab}
                    groups={tabGroups}
                    onCreateGroup={handleCreateTabGroup}
                    onAssignGroup={handleAssignTabGroup}
                    onRemoveFromGroup={handleRemoveTabFromGroup}
                    onRenameGroup={handleRenameTabGroup}
                    onSetGroupColor={handleSetTabGroupColor}
                    onToggleGroup={handleToggleTabGroup}
                    onMoveGroup={handleMoveTabGroup}
                    onCloseGroup={handleCloseTabGroup}
                  />
                </div>
              </div>

              <div className="active-panel-container" style={{ position: 'relative' }}>
                {!activeTab ? (
                  <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--win-text-secondary)', fontSize: '13px' }}>
                    {t('app.emptyWorkspace')}
                  </div>
                ) : activeTab.type === 'terminal' ? (
                  (activeTab as any).floating ? (
                    <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--win-text-secondary)', fontSize: '13px' }}>
                      {t('app.terminalFloating')}
                    </div>
                  ) : null
                ) : activeTab.type === 'query' || REDIS_TOOL_TAB_TYPES.has(activeTab.type) ? (
                  // Query tabs and the six Redis tool tabs are all mounted permanently below (like
                  // the terminal), so nothing is rendered here — rendering would rebuild the tab and
                  // lose its results on every switch.
                  //
                  // Leaving the Redis case out here produces an EMPTY `flex: 1` box next to the real
                  // tab, and since both are `flex: 1` they split the width in half — a blank left side.
                  null
                ) : (
                  <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                    {/* `&& !== 'redis'`: a Redis connection has no `table` tab at all, and saying so
                        here is what narrows `dbType` to the three SQL dialects DataGrid accepts. The
                        Redis branch used to return early, which narrowed the type by itself. */}
                    {activeTab.type === 'table' && connection.dbType !== 'redis' ? (
                      <DataGrid
              connId={activeConnIdState}
                        key={activeTab.id + '_' + ((activeTab as any).initialViewMode || 'data') + '_' + ((activeTab as any).initialFilter ? JSON.stringify((activeTab as any).initialFilter) : '') + '_' + dbReloadKey}
                        tableName={activeTab.name}
                        dbType={connection.dbType}
                        initialViewMode={(activeTab as any).initialViewMode || 'data'}
                        initialFilter={(activeTab as any).initialFilter}
                        tableSchema={(activeTab as any).tableSchema}
                        readOnly={readOnly}
                        // The flag is only set for the mounted tab; DataGrid's cleanup always reports
                        // false, which clears the flag rather than leaving a mark on the wrong tab.
                        onDirtyChange={(dirty) => setDirtyTabId(dirty ? activeTab.id : null)}
                      />
                    ) : activeTab.type === 'routine' ? (
                      <RoutineEditorModal
              connId={activeConnIdState}
                        key={activeTab.id}
                        name={activeTab.routineInfo?.name || activeTab.name}
                        kind={activeTab.routineInfo?.kind || 'procedure'}
                        initialSql={activeTab.routineInfo?.sql || ''}
                        onClose={() => handleCloseTab(activeTab.id)}
                        embedded={true}
                      />
                    ) : activeTab.type === 'view' ? (
                      <ViewEditorModal
              connId={activeConnIdState}
                        key={activeTab.id}
                        name={activeTab.viewInfo?.name || activeTab.name}
                        initialSql={activeTab.viewInfo?.sql || ''}
                        onClose={() => handleCloseTab(activeTab.id)}
                        embedded={true}
                      />
                    ) : activeTab.type === 'redis-key' ? (
                      <RedisKeyTab
                        // connId goes into the key too: the same key name on db0 and on db3 are two
                        // different keys, and React would reuse the instance if the keys matched.
                        key={activeConnIdState + '|' + activeTab.id}
                        connId={activeConnIdState}
                        keyName={activeTab.redisKeyInfo?.keyName || activeTab.name}
                        storageScope={connKey(activeConnConfig) || 'redis'}
                        readOnly={readOnly}
                        onRenamed={(next) => setTabs((prev) => prev.map((tb) => (
                          tb.id === activeTab.id
                            ? { ...tb, name: next, label: next, redisKeyInfo: { keyName: next } }
                            : tb
                        )))}
                        onClose={() => handleCloseTab(activeTab.id)}
                      />
                    ) : activeTab.type === 'er' ? (
                      <React.Suspense fallback={<LazyEditorFallback />}>
                        <ERDiagramTab
                          key={activeConnIdState + '|' + activeTab.id}
                          connId={activeTab.connId || activeConnIdState}
                          dbName={connection?.dbName}
                          schema={connection?.schema ?? undefined}
                          onOpenTable={(tableName) => handleSelectTable(tableName, 'data')}
                        />
                      </React.Suspense>
                    ) : activeTab.type === 'process-monitor' ? (
                      <LiveProcessListPanel
                        key={activeConnIdState + '|' + activeTab.id}
                        connId={activeTab.connId || activeConnIdState}
                        databaseName={connection?.dbName}
                        onClose={() => handleCloseTab(activeTab.id)}
                      />
                    ) : activeTab.type === 'schema-migration' && connection ? (
                      <SchemaMigration
                        key={activeConnIdState + '|' + activeTab.id}
                        dbType={connection.dbType}
                        database={connection.dbName}
                        asTab={true}
                        onClose={() => handleCloseTab(activeTab.id)}
                      />
                    ) : activeTab.type === 'db-compare' && connection ? (
                      <DbCompareDialog
                        key={activeConnIdState + '|' + activeTab.id}
                        connId={activeTab.connId || activeConnIdState}
                        dbType={connection.dbType}
                        currentDb={connection.dbName}
                        asTab={true}
                        onClose={() => handleCloseTab(activeTab.id)}
                        onOpenInSqlEditor={openQueryTabWithSql}
                      />
                    ) : activeTab.type === 'data-gen' && connection ? (
                      <DataGeneratorDialog
                        key={activeConnIdState + '|' + activeTab.id}
                        connId={activeTab.connId || activeConnIdState}
                        dbName={connection.dbName}
                        initialTable={activeTab.dataGenTable}
                        asTab={true}
                        onClose={() => {
                          handleCloseTab(activeTab.id);
                          window.dispatchEvent(new CustomEvent('database-restored', { detail: { connId: activeConnIdState } }));
                        }}
                      />
                    ) : activeTab.type === 'db-info' ? (
                      <DatabaseInfoModal
                        key={activeConnIdState + '|' + activeTab.id}
                        connId={activeTab.connId || activeConnIdState}
                        initialTab={activeTab.dbInfoTab || 'current'}
                        asTab={true}
                        onClose={() => handleCloseTab(activeTab.id)}
                        onSelectTable={(tableName) => handleSelectTable(tableName)}
                        onDatabaseOpened={handleDatabaseOpened}
                      />
                    ) : activeTab.type === 'export-db' ? (
                      <ExportDatabaseDialog
                        key={activeConnIdState + '|' + activeTab.id}
                        connId={activeTab.connId || activeConnIdState}
                        dbName={connection?.dbName || ''}
                        asTab={true}
                        onClose={() => handleCloseTab(activeTab.id)}
                        onSubmit={handleExportDatabase}
                      />
                    ) : activeTab.type === 'import-db' ? (
                      <ImportDatabaseDialog
                        key={activeConnIdState + '|' + activeTab.id}
                        currentDb={connection?.dbName}
                        canManageDatabases={!!connection && connection.dbType !== 'sqlite'}
                        dbType={connection?.dbType}
                        asTab={true}
                        onClose={() => handleCloseTab(activeTab.id)}
                        onSubmit={handleImportDatabase}
                      />
                    ) : activeTab.type === 'mcp-server' ? (
                      <McpServerSettingsModal
                        key={activeTab.id}
                        asTab={true}
                        onClose={() => handleCloseTab(activeTab.id)}
                      />
                    ) : null}
                  </div>
                )}

                {/* Query tabs: mounted permanently (shown/hidden with CSS) so their results survive a
                    tab switch. Only tabs that have actually been opened are mounted — see
                    mountedQueryTabs. */}
                {visibleTabs.filter(qt => qt.type === 'query' && mountedQueryTabs.has(qt.id)).map(qt => (
                  <QueryTabPanel
                    // The scope goes into the key too: a tab id is `query_<timestamp>`, so two
                    // different databases can still collide, and React would then reuse the old
                    // instance.
                    key={tabScope + '|' + qt.id}
                    tab={qt}
                    active={activeTabId === qt.id}
                    dbType={connection?.dbType}
                    connId={qt.connId || activeConnIdState}
          isProdConn={isProduction(openConns.find((c) => c.connId === (qt.connId || activeConnIdState))?.env)}
          connReadOnly={!!openConns.find((c) => c.connId === (qt.connId || activeConnIdState))?.readOnly}
          connKey={connKey(activeConnConfig)}
                    dbName={connection.dbName}
                    theme={theme}
                    readOnly={readOnly}
                    onPatch={patchTab}
                  />
                ))}

                {/* Redis tool tabs: mounted permanently, for the same reason as query and terminal
                    tabs. The Console keeps the log of commands run, Pub/Sub and the Profiler each hold
                    a dedicated socket reading continuously, and the Dashboard keeps a series of
                    measurements over time — unmounting on a tab switch loses all of it, and for
                    Pub/Sub it also means missing messages while the tab is hidden.
                    Hidden with visibility like QueryTabPanel rather than display:none, so grids and
                    charts keep their scroll position. */}
                {visibleTabs
                  .filter((tb) => tb.type.startsWith('redis-') && tb.type !== 'redis-key')
                  .map((tb) => (
                    <div
                      key={activeConnIdState + '|' + tb.id}
                      style={
                        activeTabId === tb.id
                          ? { flex: 1, display: 'flex', overflow: 'hidden' }
                          : {
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            overflow: 'hidden',
                            visibility: 'hidden',
                            pointerEvents: 'none',
                          }
                      }
                    >
                      <RedisToolTab
                        type={tb.type as Exclude<RedisTabType, 'redis-key'>}
                        storageScope={connKey(activeConnConfig) || 'redis'}
                        dbIndex={redisDbIndex}
                        readOnly={readOnly}
                        theme={theme}
                        onSwitchDb={(idx, cid) => { void handleRedisSelectDb(idx, cid); }}
                      />
                    </div>
                  ))}

                {/* Terminal: mounted permanently (shown/hidden with CSS) so the PTY session survives a tab switch */}
                {visibleTabs.filter(tb => tb.type === 'terminal').map(tb => (
                  <TerminalPanel
                    connId={tb.connId || activeConnIdState}
                    key={tb.id}
                    config={((tb as any).config || { type: connection.dbType }) as DbConnectionConfig}
                    profileName={tb.label}
                    floating={!!(tb as any).floating}
                    active={activeTabId === tb.id}
                    onToggleFloat={() => setTabs(prev => prev.map(x => x.id === tb.id ? ({ ...x, floating: !(x as any).floating } as any) : x))}
                    onClose={() => handleCloseTab(tb.id)}
                    // The terminal is a tab here -> the tab already has an X, so drop the duplicate one in the header
                    closable={false}
                  />
                ))}

                {showAi && (
                  <AiAssistant
                    onInsertSql={handleInsertSql}
                    onRunSql={handleRunAiSql}
                    tableNameContext={activeTable}
                    dbType={connection?.dbType}
                  />
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Leaving a half-edited table tab — the pending action lives in discardPrompt. */}
      <ConfirmDialog
        open={!!discardPrompt}
        danger
        title={t('app.confirmDiscardGridTitle')}
        message={t('app.confirmDiscardGridChanges')}
        confirmLabel={t('app.confirmDiscardGridLabel')}
        onConfirm={() => {
          const action = discardPrompt;
          setDiscardPrompt(null);
          action?.();
        }}
        onCancel={() => setDiscardPrompt(null)}
      />

      {/* File picker: states the allowed formats before opening the OS dialog */}
      <ImportFilePicker
        open={showGlobalImportPicker}
        targetTable={globalImportTargetTable}
        onCancel={() => setShowGlobalImportPicker(false)}
        onConfirm={handleGlobalFileImport}
      />

      {/* Progress of importing data into a table (the preview modal has closed) */}
      {globalImportProgress && (
        <div style={{
          position: 'fixed',
          bottom: '16px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 10002,
          width: '420px',
          maxWidth: '90vw',
          display: 'flex',
          background: 'var(--win-bg-card)',
          border: '1px solid var(--win-border-strong, var(--win-border))',
          borderRadius: '6px',
          boxShadow: '0 12px 30px rgba(0,0,0,0.4)',
          padding: '10px 12px'
        }}>
          <ProgressBar progress={globalImportProgress} />
        </div>
      )}

      {/* Export one table — from the Sidebar's context menu, the same dialog as the Export button under the grid */}
      {exportTableTarget && connection && (
        <ExportTableDialog
              connId={activeConnIdState}
          open
          tableName={exportTableTarget}
          dbType={connection.dbType}
          onClose={() => setExportTableTarget(null)}
          onSuccess={(msg) => alert(msg)}
          onError={(msg) => alert(msg)}
        />
      )}

      {/* Global Import Table Modal (Import New Table) */}
      {showGlobalImportModal && (
        <Modal
          title={globalImportTargetTable
            ? t('app.importModalTitleExisting', { table: globalImportTargetTable, file: globalImportFileName })
            : t('app.importModalTitleNew', { file: globalImportFileName })}
          onClose={() => setShowGlobalImportModal(false)}
          width="640px"
          zIndex={9999}
        >
          <ModalBody>
            <div className="form-group">
              <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>
                {globalImportTargetTable ? t('app.importTargetExisting') : t('app.importTargetNew')}
              </label>
              <input
                type="text"
                className="form-input"
                value={globalImportTargetTable || globalImportTableName}
                onChange={(e) => !globalImportTargetTable && setGlobalImportTableName(e.target.value)}
                disabled={!!globalImportTargetTable}
                placeholder={t('createTable.tableNamePlaceholder')}
                style={{ height: '30px', fontSize: '11px', background: globalImportTargetTable ? 'var(--win-bg-hover)' : undefined }}
              />
            </div>

            {globalImportFileType === 'sql' && (
              <div className="form-group">
                <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)', marginBottom: '6px', display: 'block' }}>
                  {t('app.importSqlPick')}
                </label>
                <div style={{ display: 'flex', gap: '16px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="sqlImportMode"
                      checked={globalImportSqlMode === 'both'}
                      onChange={() => setGlobalImportSqlMode('both')}
                    />
                    <span>{t('app.importSqlBoth')}</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="sqlImportMode"
                      checked={globalImportSqlMode === 'structure'}
                      onChange={() => setGlobalImportSqlMode('structure')}
                    />
                    <span>{t('app.importSqlStructure')}</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="sqlImportMode"
                      checked={globalImportSqlMode === 'data'}
                      onChange={() => setGlobalImportSqlMode('data')}
                    />
                    <span>{t('app.importSqlData')}</span>
                  </label>
                </div>
              </div>
            )}

            <div>
              <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
                {globalImportFileType === 'sql' ? (
                  <span>{t('app.importSqlNote')}</span>
                ) : (
                  <span>
                    <Trans
                      i18nKey="app.importSummary"
                      values={{
                        format: globalImportFileType.toUpperCase(),
                        rows: globalImportPendingRows.length,
                        cols: globalImportCols.length,
                      }}
                      components={{ strong: <b /> }}
                    />
                  </span>
                )}
              </span>
            </div>

            {/* Preview tabs: structure (columns + inferred types) | data (the first 10 rows) */}
            {globalImportFileType !== 'sql' && (
              <div style={{ display: 'flex', gap: '4px' }}>
                {([
                  { id: 'structure', label: t('app.importTabStructure', { n: globalImportCols.length }) },
                  { id: 'data', label: t('app.importTabData', { n: globalImportPendingRows.length }) },
                ] as const).map(tabDef => (
                  <button
                    key={tabDef.id}
                    onClick={() => setGlobalImportTab(tabDef.id)}
                    style={{
                      padding: '4px 12px',
                      fontSize: '11px',
                      borderRadius: '4px',
                      border: '1px solid var(--win-border)',
                      cursor: 'pointer',
                      background: globalImportTab === tabDef.id ? 'var(--win-accent)' : 'transparent',
                      color: globalImportTab === tabDef.id ? '#fff' : 'var(--win-text-secondary)',
                      fontWeight: 600
                    }}
                  >
                    {tabDef.label}
                  </button>
                ))}
              </div>
            )}

            {globalImportFileType === 'sql' ? (
              <textarea
                readOnly
                value={globalImportSqlContent.slice(0, 5000)}
                style={{
                  width: '100%',
                  height: '200px',
                  background: 'var(--win-bg-window)',
                  border: '1px solid var(--win-border)',
                  color: 'var(--win-text-primary)',
                  fontFamily: 'monospace',
                  fontSize: '11px',
                  padding: '10px',
                  borderRadius: '4px',
                  resize: 'none'
                }}
              />
            ) : (
              <div style={{
                height: '200px',
                overflow: 'auto',
                border: '1px solid var(--win-border)',
                borderRadius: '4px',
                background: 'var(--win-bg-window)'
              }}>
                {globalImportPendingRows.length === 0 ? null : globalImportTab === 'structure' ? (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                    <thead>
                      <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                        {[t('app.colInFile'), t('app.colInferredType'), t('app.colSampleValue')].map(h => (
                          <th key={h} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderRight: '1px solid var(--win-border)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {globalImportCols.map(col => {
                        const sample = globalImportPendingRows.find(r => r?.[col] !== null && r?.[col] !== undefined && r?.[col] !== '');
                        return (
                          <tr key={col} style={{ borderBottom: '1px solid var(--win-border)' }}>
                            <td style={{ padding: '6px 8px', borderRight: '1px solid var(--win-border)', fontFamily: 'monospace', color: 'var(--win-text-primary)' }}>{col}</td>
                            <td style={{ padding: '6px 8px', borderRight: '1px solid var(--win-border)', color: 'var(--win-text-secondary)' }}>{inferColType(globalImportPendingRows, col)}</td>
                            <td style={{ padding: '6px 8px', color: 'var(--win-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '260px' }}>
                              {sample ? String(sample[col]) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                    <thead>
                      <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                        {globalImportCols.map(col => (
                          <th key={col} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderRight: '1px solid var(--win-border)' }}>
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {globalImportPendingRows.slice(0, 10).map((row, rIdx) => (
                        <tr key={rIdx} style={{ borderBottom: '1px solid var(--win-border)' }}>
                          {globalImportCols.map(col => (
                            <td key={col} style={{ padding: '6px 8px', color: 'var(--win-text-primary)', borderRight: '1px solid var(--win-border)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '160px' }}>
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
            )}
          </ModalBody>

          <ModalFooter>
            <button
              className="btn btn-secondary"
              onClick={() => setShowGlobalImportModal(false)}
            >
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary"
              onClick={confirmGlobalImport}
              disabled={globalImportLoading || (!globalImportTableName.trim() && globalImportFileType !== 'sql')}
              style={{ background: 'var(--win-accent)', color: '#fff', border: 'none' }}
            >
              {globalImportLoading ? t('app.importProcessing') : t('app.importConfirm')}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {/* About Modal */}
      {showAbout && (
        /* Click outside to close — it used to be closable only by the button. */
        <div className="cm-modal-backdrop" onClick={() => setShowAbout(false)}>
          <div className="about-dialog" onClick={(e) => e.stopPropagation()}>
            <button className="about-close" onClick={() => setShowAbout(false)} title={t('common.close')} aria-label={t('common.close')}>
              <X size={15} />
            </button>

            <img className="about-logo" src={appIcon} alt="" />
            <div className="about-name">{t('app.appName')}</div>
            <div className="about-version">
              {t('app.aboutVersion', { version: appVersion })} (Build 2608)
            </div>

            <p className="about-desc">{t('app.aboutDesc')}</p>

            <div className="about-engines">
              <span className="about-engine" style={{ background: '#003B57' }}><SqliteIcon size={13} /> SQLite</span>
              <span className="about-engine" style={{ background: '#336791' }}><PostgresIcon size={13} /> PostgreSQL</span>
              <span className="about-engine" style={{ background: '#00758F' }}><MySqlIcon size={13} /> MySQL</span>
              <span className="about-engine" style={{ background: '#DC382D' }}><RedisIcon size={13} /> Redis</span>
            </div>

            <div className="about-author">
              <Trans i18nKey="app.aboutAuthor" components={{ strong: <strong /> }} />
            </div>
            <div className="about-links">
              <button onClick={() => dbHelper.openUrl('mailto:pthang888@gmail.com')}>Email</button>
              <span className="about-link-sep">·</span>
              <button onClick={() => dbHelper.openUrl('https://www.linkedin.com/in/thangpx/')}>LinkedIn</button>
            </div>

            <div className="about-foot">
              <span className="about-copy">© 2026 MeoMeo · MIT License</span>
              <button className="cm-btn" onClick={() => setShowAbout(false)}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}


      {/* Shortcuts Modal */}
      {showShortcuts && (
        <Modal
          title={t('app.shortcutsTitle')}
          onClose={() => setShowShortcuts(false)}
          width="450px"
          zIndex={9999}
        >
          <ModalBody style={{ gap: '12px', maxHeight: '380px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-accent)', borderBottom: '1px solid var(--win-border)', paddingBottom: '3px' }}>{t('app.shortcutsGeneral')}</span>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutQuickSwitcher')}</span>
                <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + Shift + P</kbd>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutSearchTables')}</span>
                <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + K</kbd>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                <span style={{ color: 'var(--win-text-primary)' }}>{t('titlebar.toggleSidebar')}</span>
                <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + B</kbd>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-accent)', borderBottom: '1px solid var(--win-border)', paddingBottom: '3px' }}>{t('app.shortcutsGrid')}</span>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutOpenFilter')}</span>
                <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + F</kbd>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutAddRow')}</span>
                <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + I</kbd>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutSaveToDb')}</span>
                <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + S</kbd>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutDeleteRow')}</span>
                <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Delete / Backspace</kbd>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutNextPage')}</span>
                <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + ]</kbd>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutPrevPage')}</span>
                <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + [</kbd>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-accent)', borderBottom: '1px solid var(--win-border)', paddingBottom: '3px' }}>{t('app.shortcutsSqlEditor')}</span>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutRunQuery')}</span>
                <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + Enter / F5</kbd>
              </div>
            </div>
          </ModalBody>

          <ModalFooter>
            <button
              className="btn btn-secondary"
              onClick={() => setShowShortcuts(false)}
              style={{ padding: '6px 20px', fontSize: '11px', borderRadius: '4px', cursor: 'pointer' }}
            >
              {t('common.close')}
            </button>
          </ModalFooter>
        </Modal>
      )}

      <DocViewerModal
        isOpen={showDocModal}
        onClose={() => setShowDocModal(false)}
        initialQuery={docQuery}
        initialEngine={connection?.dbType as any}
      />

      <WhatsNewModal
        isOpen={showWhatsNew}
        onClose={() => setShowWhatsNew(false)}
      />
    </>
  );
};

export default App;
