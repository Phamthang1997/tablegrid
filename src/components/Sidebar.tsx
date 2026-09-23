import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, memo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { clampMenu, type MenuRect } from '../utils/menuPosition';
import { dbHelper } from '../utils/dbHelper';
import { isMariaDbVersion } from '../utils/serverFlavor';
import type { TableItem, SchemaInfo, TriggerInfo, CheckConstraintInfo } from '../utils/dbHelper';
import { Search, Table, TerminalSquare, RefreshCw, Layers, Plus, ChevronDown, ChevronRight, Braces, Cog, Key, Sliders, FileCode, Trash2, CheckCircle2, Copy, AlertTriangle, History, Bookmark, Columns3, ArrowDownAZ, Link2, Zap, Code2, Database, Sparkles, GitCompare, ArrowLeftRight, HardDriveDownload, HardDriveUpload, DatabaseZap, Plug, Network, Activity, Timer } from 'lucide-react';
import { CreateTableModal } from './CreateTableModal';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { RoutineEditorModal } from './RoutineEditorModal';
import { ViewEditorModal } from './ViewEditorModal';
import { SequenceManagerModal } from './SequenceManagerModal';
import { CreateRoutineModal } from './CreateRoutineModal';
import { loadHistory, loadSavedQueries, deleteHistoryEntry, deleteSavedQuery, HISTORY_CHANGED_EVENT } from '../utils/queryHistory';
import type { HistoryEntry, SavedQueryEntry } from '../utils/queryHistory';

// Sidebar width: draggable and remembered across sessions. One value for the whole
// app (not per connection) — same `tf_*` convention as tf_lang / tf_history_scope.
const SIDEBAR_WIDTH_KEY = 'tf_sidebar_width';
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_DEFAULT_WIDTH = 240;

const readStoredWidth = (): number => {
  const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, raw));
};

const removeAccents = (str: string) =>
  str
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();

/**
 * Search matcher. Substring by default (accent- and case-insensitive), plus the
 * two TablePlus anchors: `^abc` starts-with, `abc$` ends-with, `^abc$` exact.
 *
 * Deliberately NOT full regex: the box filters on every keystroke, and a
 * half-typed pattern like `foo(` throws — the user would see the list blank out
 * mid-word. Two anchors cover the case that actually hurts (`user` matching a
 * dozen tables when only `users` was wanted) and can never be invalid.
 */
const buildMatcher = (term: string): ((name: string) => boolean) => {
  const raw = removeAccents(term.trim());
  const anchorStart = raw.startsWith('^');
  // `$` alone is a literal, not an anchor — otherwise typing `^` then `$` matches all.
  const anchorEnd = raw.length > 1 && raw.endsWith('$');
  const core = raw.slice(anchorStart ? 1 : 0, anchorEnd ? -1 : undefined);
  if (!core) return () => true;
  return (name: string) => {
    const n = removeAccents(name);
    if (anchorStart && anchorEnd) return n === core;
    if (anchorStart) return n.startsWith(core);
    if (anchorEnd) return n.endsWith(core);
    return n.includes(core);
  };
};

/**
 * Split a name so the END survives truncation: `order_line_item_2023` and
 * `order_line_item_2024` are indistinguishable when only the head is kept.
 * Short names get an empty tail and render exactly as before.
 */
const MIDDLE_ELLIPSIS_MIN_LENGTH = 14;
const MIDDLE_ELLIPSIS_MAX_TAIL = 8;
// Not exported: `react/only-export-components` is an oxlint error, and this file
// already exports the Sidebar component.
const splitObjectName = (name: string): [string, string] => {
  if (name.length < MIDDLE_ELLIPSIS_MIN_LENGTH) return [name, ''];
  const tailLen = Math.min(MIDDLE_ELLIPSIS_MAX_TAIL, Math.floor(name.length / 3));
  return [name.slice(0, name.length - tailLen), name.slice(name.length - tailLen)];
};

/** Object name with middle truncation — the head shrinks and gets the ellipsis. */
const ObjectName: React.FC<{ name: string }> = ({ name }) => {
  const [head, tail] = splitObjectName(name);
  return (
    <span className="sb-name">
      <span className="sb-name-head">{head}</span>
      {tail && <span className="sb-name-tail">{tail}</span>}
    </span>
  );
};

/**
 * The style of one object row.
 *
 * Declared at module level rather than written inline in the JSX: an inline object is created anew on
 * every render, so React sees the `style` prop as changed and rewrites the DOM for every row, even
 * when nothing changed. Only the two things that genuinely depend on state (the background/text
 * colour, and the weight while the row is open) are computed at render time.
 *
 * Do NOT move this to a CSS class: the inline style overrides `.workspace-container
 * .sidebar-item.active` in index.css, so switching to a class would also change the selected row's
 * border and shadow — outside the scope of this change.
 */


/**
 * How many rows of a block are rendered before the user scrolls.
 *
 * ~150 rows is about six screens at 26px, so the sentinel below is never in view on arrival and
 * the list still feels complete. `content-visibility` already stops off-screen rows costing
 * layout and paint; this is about the half it cannot touch — React building the elements and the
 * browser building the DOM nodes, which is paid in full every time the list is rebuilt (a
 * keystroke in the search box, expanding a row, an arrow key).
 */
const CHUNK_SIZE = 150;
/** How far past the last row the sentinel starts growing the list. One chunk is ~3900px, so a
 *  single growth always clears this margin — the observer cannot run away with itself. */
const CHUNK_ROOT_MARGIN = '400px';

/**
 * Renders a long list a chunk at a time, growing as the end comes into view.
 *
 * Deliberately incremental rather than windowed: a row here is NOT a fixed height — an expanded
 * one carries a whole `TableDetailTree` — so a windowing library would have to measure and cache
 * every row's height, and get scroll restoration right on top. Growing forwards needs neither,
 * keeps the DOM in document order (so `scrollIntoView`, focus and find-in-page all still work),
 * and costs one sentinel element.
 *
 * `minCount` is what keeps keyboard navigation honest: ↑ from the first row wraps to the LAST
 * one, which would otherwise not be rendered to scroll to.
 */
function useChunkedList<T>(items: T[], minCount: number) {
  const [count, setCount] = useState(CHUNK_SIZE);
  // Reset when the list itself changes — a new filter must not inherit the old scroll depth.
  // Adjusted during render rather than in an effect, the way `reconcileLayout` does in
  // ERDiagramView: an effect would paint one frame of the previous list first.
  const [seen, setSeen] = useState(items);
  if (seen !== items) {
    setSeen(items);
    setCount(CHUNK_SIZE);
  }

  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setCount((c) => c + CHUNK_SIZE);
      },
      { rootMargin: CHUNK_ROOT_MARGIN }
    );
    io.observe(el);
    observerRef.current = io;
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  const want = Math.max(count, minCount);
  return {
    visible: want >= items.length ? items : items.slice(0, want),
    hasMore: want < items.length,
    sentinelRef,
  };
}

/**
 * Registry key for one row. NUL as the separator, for the reason `EDGE_SEP` gives in
 * erLayoutEngine: a quoted identifier may legally contain a space or a dot, and cannot contain a
 * NUL, so `tables\0a b` can never collide with anything.
 */
const rowKey = (section: ObjectSection, name: string) => `${section}${String.fromCharCode(0)}${name}`;

/**
 * The four segmented tabs at the top of the sidebar. The constant table holds translation KEYS, not
 * translated strings: a hook cannot be called at module level, and `t()` has to receive a literal key
 * (i18next.d.ts type-checks each call site), which is why `as const` is required.
 */
const SEG_TABS = [
  ['items', 'sidebar.tabItems'],
  ['queries', 'sidebar.tabQueries'],
  ['history', 'sidebar.tabHistory'],
  ['tools', 'sidebar.tabTools'],
] as const;

/** The tab ids above, derived so the two can never drift apart. */
type SidebarTab = (typeof SEG_TABS)[number][0];

type CollapsedSections = { tables: boolean; views: boolean; temporary: boolean; functions: boolean; procedures: boolean };

/**
 * The sidebar's own UI state - everything the user *chose*, as opposed to what the backend answered.
 *
 * There is one `Sidebar` for every open connection (`App` renders it once, unkeyed), so all of this
 * used to be shared: picking Tools on one connection left the rail's other connections showing Tools,
 * and an expanded table carried its row open into a connection where that name means another table.
 * It is now saved per `conn_id` and swapped back in when the user returns (`uiByConnRef` below).
 *
 * `tableSchemaMap`/`loadingColumns` belong here rather than beside the fetched lists because they are
 * the CONTENT of the expanded rows: restoring `expandedTables` without them would redraw a row using
 * whichever connection last expanded a table of that name - the stale-columns bug this same change
 * fixes, since nothing ever cleared that map on a connection switch.
 */
type SidebarUiState = {
  /**
   * The `(connection, database, schema)` the three table-bound fields below were built for.
   *
   * `conn_id` alone is not enough: `open_database` mints a new one per database, but the Postgres
   * schema picker changes the whole set of tables UNDER one id, so a table of the same name in the
   * new schema would redraw with the old schema's columns. The other fields are the user's own
   * choices and survive a schema switch - only the object state is scoped this tightly.
   */
  objScope: string;
  activeTab: SidebarTab;
  searchTerms: Record<SidebarTab, string>;
  historyScope: 'database' | 'connection' | 'all';
  historySubTab: 'history' | 'saved';
  collapsed: CollapsedSections;
  expandedTables: Record<string, boolean>;
  tableSchemaMap: Record<string, SchemaInfo>;
  loadingColumns: Record<string, boolean>;
};

/**
 * What a connection's sidebar looks like before the user touches it.
 *
 * Shared by reference across connections on purpose: every setter here spreads into a new object
 * (`setCollapsed(c => ({ ...c }))` and friends), so nothing ever writes into these - and a per-reset
 * clone would only hide a future in-place mutation instead of failing on it.
 *
 * Views, functions and procedures are COLLAPSED by default: most of the time the user is working with
 * the table list, and these three groups only open when needed (they still open on their own while a
 * search is being typed - see isOpen()).
 */
const DEFAULT_SIDEBAR_UI: SidebarUiState = {
  // Never equal to a real scope, so a restore from the defaults always counts as a fresh object list.
  objScope: '',
  activeTab: 'items',
  searchTerms: { items: '', queries: '', history: '', tools: '' },
  historyScope: 'database',
  historySubTab: 'history',
  collapsed: { tables: false, views: true, temporary: false, functions: true, procedures: true },
  expandedTables: {},
  tableSchemaMap: {},
  loadingColumns: {},
};

/**
 * How many connections keep their sidebar state, least-recently-left evicted first.
 *
 * A cap rather than a cleanup on disconnect: there is no 'connection closed' event to listen for, and
 * the only cost of forgetting an entry is that the connection comes back with its defaults.
 */
const SIDEBAR_UI_MEMORY = 12;

type DetailGroup = 'fields' | 'indexes' | 'fks' | 'checks' | 'triggers';

interface GroupNodeProps {
  open: boolean;
  icon: React.ReactNode;
  label: string;
  /** undefined = not known yet (lazy group, never opened) -> no count shown. */
  count?: number;
  onToggle: () => void;
}

/** Header of one group inside an expanded table. The members are rendered by the
 *  caller (only when open) so a closed group costs nothing to build. */
const GroupNode: React.FC<GroupNodeProps> = ({ open, icon, label, count, onToggle }) => (
  <div className="sb-group-row" onClick={onToggle} title={label}>
    <span className="sb-chevron">{open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</span>
    {icon}
    <span className="sb-group-label">{label}</span>
    {count !== undefined && <span className="sb-group-count">{count}</span>}
  </div>
);

/**
 * Detail tree of an expanded table: Fields / Indexes / Foreign Keys / Checks / Triggers.
 *
 * Which groups are open is local state here rather than state in Sidebar: lifting it up
 * would make every row in the list re-compare its props on each group toggle, and
 * React.memo on ObjectItem would stop earning its keep.
 *
 * Fields/Indexes/Foreign Keys come from the `get_table_schema` call already made when the
 * table was expanded. Checks and Triggers are two SEPARATE backend commands, so they only
 * run when the user opens that group — expanding a table still costs exactly one call.
 */
const TableDetailTree: React.FC<{ connId: string; tableName: string; schema: SchemaInfo }> = ({ connId, tableName, schema }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Record<DetailGroup, boolean>>({
    fields: true, indexes: false, fks: false, checks: false, triggers: false,
  });
  // null = not loaded yet (distinct from [] = loaded and the table has none).
  const [checks, setChecks] = useState<CheckConstraintInfo[] | null>(null);
  const [triggers, setTriggers] = useState<TriggerInfo[] | null>(null);
  const [loadingExtra, setLoadingExtra] = useState<{ checks: boolean; triggers: boolean }>({ checks: false, triggers: false });

  const toggle = (g: DetailGroup) => {
    const willOpen = !open[g];
    setOpen((prev) => ({ ...prev, [g]: willOpen }));
    if (!willOpen) return;
    if (g === 'checks' && checks === null && !loadingExtra.checks) {
      setLoadingExtra((p) => ({ ...p, checks: true }));
      dbHelper.getCheckConstraints(connId, tableName)
        .then(setChecks)
        .finally(() => setLoadingExtra((p) => ({ ...p, checks: false })));
    }
    if (g === 'triggers' && triggers === null && !loadingExtra.triggers) {
      setLoadingExtra((p) => ({ ...p, triggers: true }));
      dbHelper.getTableTriggers(connId, tableName)
        .then(setTriggers)
        .finally(() => setLoadingExtra((p) => ({ ...p, triggers: false })));
    }
  };

  const emptyHint = <div className="sb-cols-hint">{t('sidebar.groupEmpty')}</div>;
  const loadingHint = <div className="sb-cols-hint">{t('sidebar.groupLoading')}</div>;

  const detailRow = (key: string, icon: React.ReactNode, name: string, meta: string, title: string) => (
    <div key={key} className="sb-col-row" title={title}>
      <div className="sb-col-left">
        <span className="sb-col-key">{icon}</span>
        <span className="sb-col-name">{name}</span>
      </div>
      {meta && <span className="sb-col-type">{meta}</span>}
    </div>
  );

  return (
    <>
      <GroupNode
        open={open.fields}
        icon={<Columns3 size={12} className="icon-table" />}
        label={t('sidebar.groupFields')}
        count={schema.columns.length}
        onToggle={() => toggle('fields')}
      />
      {open.fields && (
        <div className="sb-group-items">
          {schema.columns.length === 0
            ? <div className="sb-cols-hint">{t('sidebar.noColumns')}</div>
            : schema.columns.map((col) => (
              <div
                key={col.name}
                className="sb-col-row"
                title={`${col.name} (${col.type}) ${col.isPrimaryKey ? '[PK]' : ''}`}
              >
                <div className="sb-col-left">
                  <span className="sb-col-key">
                    {col.isPrimaryKey ? (
                      <Key size={11} color="#f59e0b" className="sb-col-key-icon" />
                    ) : (
                      <span className="sb-col-key-spacer" />
                    )}
                  </span>
                  <span className="sb-col-name">{col.name}</span>
                </div>

                <span className="sb-col-type">{col.type}</span>
              </div>
            ))}
        </div>
      )}

      <GroupNode
        open={open.indexes}
        icon={<ArrowDownAZ size={12} className="icon-table" />}
        label={t('sidebar.groupIndexes')}
        count={schema.indexes.length}
        onToggle={() => toggle('indexes')}
      />
      {open.indexes && (
        <div className="sb-group-items">
          {schema.indexes.length === 0
            ? emptyHint
            : schema.indexes.map((idx) => detailRow(
              idx.name,
              <ArrowDownAZ size={11} className="sb-col-key-icon" />,
              idx.name,
              idx.columns,
              `${idx.name} (${idx.columns})${idx.unique ? ' [UNIQUE]' : ''}`,
            ))}
        </div>
      )}

      <GroupNode
        open={open.fks}
        icon={<Link2 size={12} className="icon-view" />}
        label={t('sidebar.groupForeignKeys')}
        count={schema.foreignKeys.length}
        onToggle={() => toggle('fks')}
      />
      {open.fks && (
        <div className="sb-group-items">
          {schema.foreignKeys.length === 0
            ? emptyHint
            : schema.foreignKeys.map((fk, i) => detailRow(
              `${fk.name || fk.column}_${i}`,
              <Link2 size={11} className="sb-col-key-icon" />,
              fk.name || fk.column,
              `${fk.refTable}.${fk.refColumn}`,
              `${fk.column} -> ${fk.refTable}.${fk.refColumn}`,
            ))}
        </div>
      )}

      <GroupNode
        open={open.checks}
        icon={<CheckCircle2 size={12} color="#22c55e" />}
        label={t('sidebar.groupChecks')}
        count={checks?.length}
        onToggle={() => toggle('checks')}
      />
      {open.checks && (
        <div className="sb-group-items">
          {loadingExtra.checks || checks === null
            ? loadingHint
            : checks.length === 0
              ? emptyHint
              : checks.map((c, i) => detailRow(
                `${c.name}_${i}`,
                <CheckCircle2 size={11} color="#22c55e" className="sb-col-key-icon" />,
                c.name,
                c.expression,
                `${c.name}: ${c.expression}`,
              ))}
        </div>
      )}

      <GroupNode
        open={open.triggers}
        icon={<Zap size={12} color="#f59e0b" />}
        label={t('sidebar.groupTriggers')}
        count={triggers?.length}
        onToggle={() => toggle('triggers')}
      />
      {open.triggers && (
        <div className="sb-group-items">
          {loadingExtra.triggers || triggers === null
            ? loadingHint
            : triggers.length === 0
              ? emptyHint
              : triggers.map((tr, i) => detailRow(
                `${tr.name}_${i}`,
                <Zap size={11} color="#f59e0b" className="sb-col-key-icon" />,
                tr.name,
                `${tr.timing} ${tr.event}`.trim(),
                `${tr.name} (${tr.timing} ${tr.event})`,
              ))}
        </div>
      )}
    </>
  );
};

/**
 * The block a row lives in — also the scope of a selection (see `selection` in Sidebar).
 *
 * `temporary` is the session's own temp tables. It is a third block rather than a flag on the rows
 * of `tables`, because it is a different LIST from a different backend call with its own lifetime:
 * it appears when the session creates a temp table and disappears the moment it owns none.
 */
type ObjectSection = 'tables' | 'views' | 'temporary';

interface ObjectItemProps {
  /** The connection this row belongs to — `TableDetailTree` needs it to read checks and triggers. */
  connId: string;
  item: TableItem;
  /** Block, and position within it: Shift+click needs both to take the range from the anchor. */
  section: ObjectSection;
  index: number;
  isHighlighted: boolean;
  isExpanded: boolean;
  /** undefined = not expanded yet, or still loading. No default object is passed: a fresh object each
   *  render would break the memo of EVERY closed row. */
  schema: SchemaInfo | undefined;
  isLoadingCols: boolean;
  highlightRef: React.RefObject<HTMLDivElement | null>;
  /** Takes the mouse event too: Ctrl/Cmd and Shift decide toggle-one vs take-the-range. */
  onSelect: (name: string, section: ObjectSection, index: number, e: React.MouseEvent) => void;
  /**
   * Hands the row's element to the sidebar's registry.
   *
   * "Which row is open" and "which rows are selected" are NOT props, because they change on every
   * click and a prop would mean rebuilding all 2500 rows to tell two of them apart — measured: the
   * lag disappears entirely once the search box narrows the list to a handful. The sidebar writes
   * the classes straight onto the elements instead (`applyRowClasses`), which is the same trade
   * the ER canvas makes for hover, and this registry is how it finds them in O(1) without building
   * a selector out of a user-supplied table name.
   */
  registerRow: (key: string, el: HTMLDivElement | null) => void;
  onContextMenu: (e: React.MouseEvent, name: string, section: ObjectSection, index: number) => void;
  /** `schema` is `TableItem.schema` — the detail tree has to introspect the same relation the row
   *  came from, which for a Postgres temp row is `pg_temp_N` rather than the current schema. */
  onToggleExpand: (name: string, isExpanded: boolean, e: React.MouseEvent, schema?: string) => void;
  onRequestDrop: (item: TableItem) => void;
}

/**
 * One table/view row in the left list.
 *
 * Memoised because the list redraws in full on every keystroke in the search box and every time a
 * table is expanded or collapsed. For the memo to do anything, EVERY callback passed in here has to
 * keep its identity — see the useCallbacks in Sidebar.
 */
const ObjectItem = memo(function ObjectItem({
  connId,
  item,
  section,
  index,
  isHighlighted,
  isExpanded,
  schema,
  isLoadingCols,
  highlightRef,
  onSelect,
  registerRow,
  onContextMenu,
  onToggleExpand,
  onRequestDrop,
}: ObjectItemProps) {
  // useTranslation inside the row rather than taking `t` as a prop: `t`'s return type will not
  // assign to `string` through a prop, and casting it away loses i18next.d.ts's key checking. The
  // hook also handles redrawing on a language switch by itself.
  const { t } = useTranslation();
  const isView = item.type === 'view';

  return (
    <div className="sidebar-row">
      <div
        ref={(el) => {
          registerRow(rowKey(section, item.name), el);
          // The keyboard highlight stays a prop: it only moves on arrow keys, never on a click,
          // so it is not on the path this registry exists to make cheap.
          if (isHighlighted) highlightRef.current = el;
        }}
        className={`sidebar-item${isHighlighted ? ' is-highlighted' : ''}`}
        tabIndex={0}
        onClick={(e) => onSelect(item.name, section, index, e)}
        onContextMenu={(e) => onContextMenu(e, item.name, section, index)}
        onKeyDown={(e) => {
          if (e.key === 'Delete') {
            e.preventDefault();
            e.stopPropagation();
            onRequestDrop(item);
          }
        }}
        title={t('sidebar.tableItemHint', { name: item.name })}
      >
        {!isView && (
          <span onClick={(e) => onToggleExpand(item.name, isExpanded, e, item.schema)} className="sb-chevron">
            {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        )}

        {/* The icon colour is no longer forced: a hardcoded `#ffffff` disappears on a faint
            background. index.css already carries a per-theme icon colour for the active state. */}
        {isView ? (
          <Layers size={14} className="icon-view" />
        ) : (
          <Columns3 size={14} className="icon-table" />
        )}

        <span className="sb-name-slot">
          <ObjectName name={item.name} />
        </span>
      </div>

      {isExpanded && !isView && (
        <div className="sb-cols-wrap">
          {isLoadingCols ? (
            <div className="sb-cols-hint">{t('sidebar.loadingColumns')}</div>
          ) : !schema ? (
            <div className="sb-cols-hint">{t('sidebar.noColumns')}</div>
          ) : (
            <TableDetailTree connId={connId} tableName={item.name} schema={schema} />
          )}
        </div>
      )}
    </div>
  );
});

interface SidebarProps {
  /** The connection this component acts on. Passed explicitly, never read from the ambient id (§4.1). */
  connId: string;
  dbName: string;
  dbType: 'sqlite' | 'postgres' | 'mysql';
  /** Read-only mode: refuses every write the sidebar can issue (drop/truncate/rename/create). */
  readOnly?: boolean;
  /**
   * `schema` is `TableItem.schema` — passed only for a row from the Temporary block on Postgres,
   * where the relation lives in `pg_temp_N` and every read has to name it. `filter` is unused here
   * but sits between the two because it is `handleSelectTable`'s third parameter in `App.tsx`.
   */
  onSelectTable: (
    name: string,
    viewMode?: 'data' | 'structure' | 'chart' | 'properties',
    filter?: { column: string; value: any },
    schema?: string
  ) => void;
  onNewQuery: () => void;
  onOpenTerminal: () => void;
  terminalConfig?: import('../utils/dbHelper').DbConnectionConfig;
  onDisconnect: () => void;
  activeTable: string | null;
  onImportToTable: (tableName: string) => void;
  onExportTable: (tableName: string) => void;
  onExportDatabase: () => void;
  onImportDatabase: () => void;
  /** Copy this database into another OPEN connection of the same engine. */
  onCopyDatabase?: () => void;
  /** Imports a CSV/JSON/XLSX file into a NEW table (unlike onImportDatabase, which restores a whole dump). */
  onImportNewTable?: () => void;
  onOpenDbInfo?: () => void;
  onOpenProcessMonitor?: () => void;
  onOpenAllDbStats?: () => void;
  onSchemaMigration?: () => void;
  onCompareDatabases?: () => void;
  onOpenErDiagram?: () => void;
  onMcpSettings?: () => void;
  /** Opens the Data Generator. With a table name it opens preselected on that table (from its context menu). */
  onGenerateData?: (tableName?: string) => void;
  onTableRenamed?: (oldName: string, newName: string) => void;
  onTableDropped?: (tableName: string) => void;
  /**
   * A database was **opened as another connection** (`open_database`), not switched to.
   *
   * Switching replaced this connection's pool, so it had to refuse whenever the current database
   * held uncommitted work — a refusal the user could not clear without losing that work, and it
   * silently detached every open tab from the database they were opened against. Opening adds a
   * pool on the same `ServerHandle` (same tunnel, same credentials, no re-auth), so there is nothing
   * to refuse and the old database keeps its tabs and its transaction.
   */
  /** The selected schema (Postgres only). The backend is the source of truth — see App.tsx. */
  schema?: string | null;
  /** After a schema change: App updates state and the localStorage key, and the Sidebar reloads its list. */
  onSchemaChanged?: (name: string) => void;
  onOpenQueryWithSql?: (sql: string) => void;
  onOpenRoutineTab?: (name: string, kind: 'procedure' | 'function') => void;
  onOpenViewTab?: (name: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  connId,
  dbName,
  dbType,
  readOnly = false,
  onSelectTable,
  onNewQuery,
  onOpenTerminal,
  terminalConfig: _terminalConfig,
  onDisconnect: _onDisconnect,
  activeTable,
  onImportToTable,
  onExportTable,
  onExportDatabase,
  onImportDatabase,
  onCopyDatabase,
  onImportNewTable,
  onOpenDbInfo,
  onOpenProcessMonitor,
  onOpenAllDbStats: _onOpenAllDbStats,
  onSchemaMigration,
  onCompareDatabases,
  onOpenErDiagram,
  onMcpSettings,
  onGenerateData,
  onTableRenamed,
  onTableDropped,
  schema,
  onSchemaChanged,
  onOpenQueryWithSql,
  onOpenRoutineTab,
  onOpenViewTab,
}) => {
  const { t } = useTranslation();

  // Refuses writes while read-only is on. Called AT the click site, before any confirmation dialog
  // opens, so the user is told immediately rather than after answering one.
  const blockedByReadOnly = useCallback((): boolean => {
    if (!readOnly) return false;
    alert(t('sidebar.errReadOnly'));
    return true;
  }, [readOnly, t]);

  const [tables, setTables] = useState<TableItem[]>([]);
  /**
   * The temp tables/views this session owns. Reloaded by `fetchTables`, and emptied by the same call
   * when the session owns none — which is what makes the section disappear rather than go stale.
   */
  const [tempTables, setTempTables] = useState<TableItem[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [isMariaDb, setIsMariaDb] = useState(false);
  const [switchingSchema, setSwitchingSchema] = useState(false);
  const [functions, setFunctions] = useState<string[]>([]);
  const [procedures, setProcedures] = useState<string[]>([]);
  const [objDef, setObjDef] = useState<{ name: string; kind: 'view' | 'function' | 'procedure'; sql: string } | null>(null);
  const [showSequencesModal, setShowSequencesModal] = useState<boolean>(false);
  const [showCreateRoutine, setShowCreateRoutine] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState(false);

  // Top 4-tab segmented control (Items | Queries | History | Tools)
  const [activeTab, setActiveTab] = useState<SidebarTab>(DEFAULT_SIDEBAR_UI.activeTab);

  // One search box on screen, but one term PER tab: the four tabs filter unrelated lists (objects,
  // saved queries, history, tools), so a term typed while looking for a table used to narrow the
  // history list too. Keyed by tab, so switching back also restores what was typed there.
  const [searchTerms, setSearchTerms] = useState<Record<SidebarTab, string>>(DEFAULT_SIDEBAR_UI.searchTerms);
  const searchTerm = searchTerms[activeTab];
  const setSearchTerm = (value: string) =>
    setSearchTerms((prev) => ({ ...prev, [activeTab]: value }));
  const [savedQueriesList, setSavedQueriesList] = useState<SavedQueryEntry[]>([]);
  const [historyList, setHistoryList] = useState<HistoryEntry[]>([]);
  const [historyScope, setHistoryScope] = useState<SidebarUiState['historyScope']>(DEFAULT_SIDEBAR_UI.historyScope);
  const [historySubTab, setHistorySubTab] = useState<SidebarUiState['historySubTab']>(DEFAULT_SIDEBAR_UI.historySubTab);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopySql = (e: React.MouseEvent, id: string, sql: string) => {
    e.stopPropagation();
    navigator.clipboard.writeText(sql);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  useEffect(() => {
    const refreshHistoryQueries = () => {
      setSavedQueriesList(loadSavedQueries());
      setHistoryList(loadHistory());
    };
    refreshHistoryQueries();
    window.addEventListener(HISTORY_CHANGED_EVENT, refreshHistoryQueries);
    return () => window.removeEventListener(HISTORY_CHANGED_EVENT, refreshHistoryQueries);
  }, []);

  const getGroupedHistory = () => {
    const list = historyList.filter(entry => {
      if (historyScope === 'database' && dbName && entry.db && entry.db !== dbName) return false;
      if (searchTerm) {
        return entry.sql.toLowerCase().includes(searchTerm.toLowerCase());
      }
      return true;
    });

    const groups: Record<string, HistoryEntry[]> = {};
    for (const item of list) {
      const dateStr = new Date(item.timestamp).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
      if (!groups[dateStr]) groups[dateStr] = [];
      groups[dateStr].push(item);
    }
    return groups;
  };
  const [collapsed, setCollapsed] = useState<CollapsedSections>(DEFAULT_SIDEBAR_UI.collapsed);
  const inputRef = useRef<HTMLInputElement>(null);

  // Table detail tree state (expand/collapse table to see fields/indexes/FKs/checks/triggers)
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>(DEFAULT_SIDEBAR_UI.expandedTables);
  const [tableSchemaMap, setTableSchemaMap] = useState<Record<string, SchemaInfo>>(DEFAULT_SIDEBAR_UI.tableSchemaMap);
  const [loadingColumns, setLoadingColumns] = useState<Record<string, boolean>>(DEFAULT_SIDEBAR_UI.loadingColumns);

  /**
   * Per-connection sidebar state: the outgoing connection's is saved and the incoming one's restored,
   * in the RENDER pass rather than in an effect.
   *
   * An effect would paint one frame of the previous connection's sidebar - its tab, its search text,
   * its expanded rows - before swapping, which is the same reason the ER diagram reconciles its layout
   * during render (`reconcileLayout`). Setting state during a component's own render is what React
   * supports for exactly this: the render is discarded and re-run before anything is committed.
   *
   * Keyed by `conn_id` because that is what the rail switches between, and two connections can point
   * at the same database name. The state is deliberately NOT persisted: a `conn_id` is minted fresh on
   * every connect, so there would be nothing to read it back under.
   */
  const uiByConnRef = useRef(new Map<string, SidebarUiState>());
  const uiConnRef = useRef<string | undefined>(connId);
  // `dbName` as well as `schema`: a restore replaying `USE <db>` moves the database under a live id,
  // which is the one other way the object list changes without a new `conn_id`.
  const objScope = JSON.stringify([connId, dbName, schema ?? '']);
  const objScopeRef = useRef(objScope);
  if (uiConnRef.current !== connId) {
    const leaving = uiConnRef.current;
    if (leaving) {
      // delete-then-set so the Map's insertion order is a least-recently-left order, which is what
      // makes `keys().next()` below the right entry to drop. `objScopeRef` is still the LEAVING
      // connection's here - it is only advanced at the end of this block.
      uiByConnRef.current.delete(leaving);
      uiByConnRef.current.set(leaving, {
        objScope: objScopeRef.current,
        activeTab, searchTerms, historyScope, historySubTab,
        collapsed, expandedTables, tableSchemaMap, loadingColumns,
      });
      while (uiByConnRef.current.size > SIDEBAR_UI_MEMORY) {
        const oldest = uiByConnRef.current.keys().next().value;
        if (oldest === undefined) break;
        uiByConnRef.current.delete(oldest);
      }
    }
    uiConnRef.current = connId;
    objScopeRef.current = objScope;
    const saved = uiByConnRef.current.get(connId);
    const next = saved ?? DEFAULT_SIDEBAR_UI;
    // The schema can have been changed from elsewhere while this connection was off screen, so the
    // restore has to re-check it rather than trust that nothing moved.
    const staleObjects = next.objScope !== objScope;
    setActiveTab(next.activeTab);
    setSearchTerms(next.searchTerms);
    setHistoryScope(next.historyScope);
    setHistorySubTab(next.historySubTab);
    setCollapsed(next.collapsed);
    setExpandedTables(staleObjects ? DEFAULT_SIDEBAR_UI.expandedTables : next.expandedTables);
    setTableSchemaMap(staleObjects ? DEFAULT_SIDEBAR_UI.tableSchemaMap : next.tableSchemaMap);
    setLoadingColumns(staleObjects ? DEFAULT_SIDEBAR_UI.loadingColumns : next.loadingColumns);
  } else if (objScopeRef.current !== objScope) {
    // Same connection, different schema (or database): what the user CHOSE stays - the tab they are
    // on, what they typed, which groups are open - and only the rows bound to the old object list go.
    objScopeRef.current = objScope;
    setExpandedTables(DEFAULT_SIDEBAR_UI.expandedTables);
    setTableSchemaMap(DEFAULT_SIDEBAR_UI.tableSchemaMap);
    setLoadingColumns(DEFAULT_SIDEBAR_UI.loadingColumns);
  }

  // These two maps are only READ, to decide whether the backend needs calling. Read through a ref so
  // toggleTableExpanded keeps its identity; putting them in the deps would change the callback every
  // time a table is expanded -> every row re-renders and React.memo on ObjectItem means nothing.
  const columnsMapRef = useRef(tableSchemaMap);
  const loadingColumnsRef = useRef(loadingColumns);
  useEffect(() => {
    columnsMapRef.current = tableSchemaMap;
    loadingColumnsRef.current = loadingColumns;
  }, [tableSchemaMap, loadingColumns]);

  /**
   * Lands an expanded row's columns on the scope that ASKED for them, which is not necessarily the
   * one on screen: the user can switch connection - or, on Postgres, schema - while the request is in
   * flight, and by then the state hooks belong to a different table list. Writing through them would
   * show one scope's columns under another's table of the same name, and leave the asking one's row
   * spinning for ever.
   */
  const applySchemaResult = useCallback((forConn: string, forScope: string, tableName: string, tableSchema?: SchemaInfo) => {
    if (uiConnRef.current === forConn) {
      // Right connection, but the schema picker may have moved under it - and that reset the two maps
      // already, so there is no spinner left for this answer to clear.
      if (objScopeRef.current !== forScope) return;
      if (tableSchema) setTableSchemaMap(prev => ({ ...prev, [tableName]: tableSchema }));
      setLoadingColumns(prev => ({ ...prev, [tableName]: false }));
      return;
    }
    const saved = uiByConnRef.current.get(forConn);
    // Gone means the connection was closed, or evicted by SIDEBAR_UI_MEMORY; a scope mismatch means
    // its object list has since been replaced. Either way there is nothing for the answer to belong to.
    if (!saved || saved.objScope !== forScope) return;
    // `set` on a key the Map already holds keeps its position, so this cannot disturb the LRU order.
    uiByConnRef.current.set(forConn, {
      ...saved,
      tableSchemaMap: tableSchema ? { ...saved.tableSchemaMap, [tableName]: tableSchema } : saved.tableSchemaMap,
      loadingColumns: { ...saved.loadingColumns, [tableName]: false },
    });
  }, []);

  // isExpanded is passed in by the row itself, so expandedTables need not be read here.
  const toggleTableExpanded = useCallback(async (tableName: string, isExpanded: boolean, e: React.MouseEvent, schemaOverride?: string) => {
    e.stopPropagation();
    const willExpand = !isExpanded;
    setExpandedTables(prev => ({ ...prev, [tableName]: willExpand }));

    if (willExpand && !columnsMapRef.current[tableName] && !loadingColumnsRef.current[tableName]) {
      const forConn = connId;
      const forScope = objScopeRef.current;
      setLoadingColumns(prev => ({ ...prev, [tableName]: true }));
      try {
        const tableSchema = await dbHelper.getTableSchema(forConn, tableName, schemaOverride);
        applySchemaResult(forConn, forScope, tableName, tableSchema);
      } catch (err) {
        console.error(`Failed to fetch schema for ${tableName}:`, err);
        applySchemaResult(forConn, forScope, tableName);
      }
    }
  }, [connId, applySchemaResult]);

  // Drag the right edge to change the sidebar's width.
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(readStoredWidth);
  const [resizing, setResizing] = useState(false);

  // Listens on window rather than on the handle, so the drag continues when the pointer leaves the
  // sidebar; userSelect is turned off so text is not selected while dragging.
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const left = rootRef.current?.getBoundingClientRect().left ?? 0;
      setWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, e.clientX - left)));
    };
    const onUp = () => setResizing(false);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [resizing]);

  // Written on mouse-up, not during the drag (that would be one localStorage write per mousemove).
  useEffect(() => {
    if (resizing) return;
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  }, [resizing, width]);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    tableName: string;
    /** What the menu acts on. 1 entry = the normal menu, more = the bulk menu. */
    names: string[];
    /** `TableItem.schema` of the right-clicked row — only a Temporary row on Postgres has one. */
    schema?: string;
    /** Which block the row came from, so the menu can drop the items a temp table has no use for. */
    section: ObjectSection;
  } | null>(null);

  /**
   * Multi-selection: Ctrl/Cmd+click toggles one row, Shift+click takes the range, Ctrl+A
   * selects the whole block, Esc clears it.
   *
   * A selection lives **inside one block** (tables OR views) and never spans both: the bulk
   * operations differ between the two (a view cannot be truncated, and DROP is a different
   * statement), so a mixed selection could only produce a half-usable menu. Clicking into
   * the other block replaces the selection.
   */
  const [selection, setSelection] = useState<{ section: ObjectSection; names: string[] }>({ section: 'tables', names: [] });

  /**
   * The rows' elements, and the classes the sidebar writes onto them by hand.
   *
   * `active` and `is-on` used to be props (`isActive` / `isSelected`), which meant a click had to
   * rebuild every row in the list so that two of them could change appearance. At 2500 tables that
   * is what the lag was — confirmed by narrowing the list with the search box, where it vanishes.
   * Writing the classes costs the size of the selection instead of the size of the list.
   */
  const rowElsRef = useRef(new Map<string, HTMLDivElement>());
  const markedRowsRef = useRef<HTMLElement[]>([]);

  const registerRow = useCallback((key: string, el: HTMLDivElement | null) => {
    if (el) rowElsRef.current.set(key, el);
    else rowElsRef.current.delete(key);
  }, []);

  /**
   * Both values are ARGUMENTS, never read from a ref.
   *
   * `selectionRef` is filled by a passive `useEffect`, which runs AFTER every `useLayoutEffect` —
   * so reading it from here saw the PREVIOUS render's selection, and a click lit two rows: the new
   * one from `activeTable` and the old one from the stale selection. Anything this function needs
   * has to arrive from the render that is being painted.
   */
  const applyRowClasses = useCallback(
    (sel: { section: ObjectSection; names: string[] }, open: string | null | undefined) => {
    for (const el of markedRowsRef.current) el.classList.remove('active', 'is-on');
    const marked: HTMLElement[] = [];
    const els = rowElsRef.current;

    // A selected row shares its background with the open row; what tells the two apart is the
    // border + shadow `.active` carries in index.css, not the background.
    for (const name of sel.names) {
      const el = els.get(rowKey(sel.section, name));
      if (el) {
        el.classList.add('is-on');
        marked.push(el);
      }
    }

    // Matched by name across all three blocks, exactly as `activeTable === item.name` did.
    if (open) {
      for (const section of ['tables', 'views', 'temporary'] as const) {
        const el = els.get(rowKey(section, open));
        if (el) {
          el.classList.add('active', 'is-on');
          marked.push(el);
        }
      }
    }

    markedRowsRef.current = marked;
    },
    []
  );

  // No dependency array: React owns none of these classes, and the list remounts its rows whenever
  // the filter or the table list changes — a fresh row arrives without them. Same reason the ER
  // canvas re-applies its highlight after every commit.
  useLayoutEffect(() => {
    applyRowClasses(selection, activeTable);
  });
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);
  /** Shift+click anchor: index of the last plain/Ctrl click, -1 = none yet. */
  const anchorRef = useRef(-1);
  /** The VISIBLE list of each block — reassigned every render and read from stable
   *  callbacks (see handleRowSelect), which is why it cannot live in their deps. */
  const sectionListsRef = useRef<Record<ObjectSection, TableItem[]>>({ tables: [], views: [], temporary: [] });

  // The context menu's position after its real size has been measured (so it cannot overflow the window)
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<MenuRect | null>(null);

  useLayoutEffect(() => {
    if (!contextMenu) {
      queueMicrotask(() => setMenuPos(null));
      return;
    }
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    queueMicrotask(() => setMenuPos(clampMenu(contextMenu.x, contextMenu.y, r.width, r.height, window.innerWidth, window.innerHeight)));
  }, [contextMenu]);

  // Context menu for right-clicking the "Tables" section header (Item overview, Show diagram)
  const [tablesHeaderMenu, setTablesHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  const [tablesHeaderMenuPos, setTablesHeaderMenuPos] = useState<MenuRect | null>(null);
  const tablesHeaderMenuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!tablesHeaderMenu) {
      queueMicrotask(() => setTablesHeaderMenuPos(null));
      return;
    }
    const el = tablesHeaderMenuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    queueMicrotask(() =>
      setTablesHeaderMenuPos(
        clampMenu(tablesHeaderMenu.x, tablesHeaderMenu.y, r.width, r.height, window.innerWidth, window.innerHeight)
      )
    );
  }, [tablesHeaderMenu]);

  const [renameState, setRenameState] = useState<{ tableName: string; value: string } | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  // The "+" menu on the Tables heading, and the create-view dialog
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showCreateView, setShowCreateView] = useState(false);
  const [newView, setNewView] = useState({ name: '', sql: '' });
  const [creatingView, setCreatingView] = useState(false);
  const [createViewError, setCreateViewError] = useState<string | null>(null);
  // Truncate Table & Drop Table Modals (matching Images 1 & 2)
  // `names` rather than a single name: one dialog serves both a single object and a whole
  // selection, so the options (RESTART IDENTITY, CASCADE...) cannot end up differing
  // between objects within one run.
  const [truncateModal, setTruncateModal] = useState<{
    names: string[];
    restartIdentity: boolean;
    disableFkCheck: boolean;
    cascade: boolean;
  } | null>(null);

  const [dropModal, setDropModal] = useState<{
    names: string[];
    isView: boolean;
    ignoreFkCheck: boolean;
    cascade: boolean;
    /** `TableItem.schema` of the rows being dropped. A selection never spans two blocks, so one
     *  value covers the whole list. Only a Postgres temp row has one. */
    schema?: string;
  } | null>(null);

  // Database state
  const [_dbList, setDbList] = useState<string[]>([]);
  const [renameDbState, setRenameDbState] = useState<{ oldName: string; value: string } | null>(null);


  const handleRenameDatabase = async () => {
    if (!renameDbState) return;
    if (blockedByReadOnly()) return;
    const { oldName, value } = renameDbState;
    const newName = value.trim();
    if (!newName || newName === oldName) { setRenameDbState(null); return; }
    const res = await dbHelper.renameDatabase(connId, oldName, newName);
    setRenameDbState(null);
    if (res.success) {
      const list = await dbHelper.listDatabases(connId);
      setDbList(list.databases || []);
    } else {
      alert(t('sidebar.errRenameDb', { message: res.error }));
    }
  };

  const fetchTables = async () => {
    setRefreshing(true);
    const list = await dbHelper.getTables(connId);
    setTables(list);
    // The session's temp tables. Always assigned, never merged: an empty answer is the signal that
    // the section must vanish (the user dropped the last one, or the session ended), and skipping
    // the write on `[]` would leave rows behind that no longer exist.
    setTempTables(await dbHelper.getTemporaryTables(connId));
    // Also loads functions and procedures (the database objects)
    const objs = await dbHelper.getDatabaseObjects(connId);
    setFunctions(objs.functions || []);
    setProcedures(objs.procedures || []);
    setRefreshing(false);
  };

  // `fetchTables` now CAPTURES `connId`, so the two effects below must not hold an old render's
  // closure: after a connection switch, a stale handler would load the previous connection's tables.
  // It is also a plain function (new identity every render), so putting it straight into the deps is
  // an endless loop — reading through a ref is the pattern `CLAUDE.md` records for exactly this case.
  const connIdRef = useRef(connId);
  const fetchTablesRef = useRef(fetchTables);
  useEffect(() => {
    connIdRef.current = connId;
    fetchTablesRef.current = fetchTables;
  });

  // The schema list for the picker. Empty on MySQL/SQLite (the backend returns an empty array), so a
  // length check is all it takes to decide whether to show the picker at all.
  //
  // Reloaded on a DATABASE change: a new database has its own set of schemas, and the old list
  // belongs to the previous one. The selected value comes from the `schema` prop (the backend is its
  // source) and is not kept here — two copies would drift apart on the very first database switch.
  useEffect(() => {
    if (dbType !== 'postgres') {
      queueMicrotask(() => setSchemas([]));
      return;
    }
    let alive = true;
    dbHelper.listSchemas(connId).then((res) => {
      if (alive) setSchemas(res.schemas || []);
    });
    return () => {
      alive = false;
    };
    // `dbName` is a trigger: switching database has to re-probe its schemas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, dbType, dbName]);

  // MySQL and MariaDB reach us as the same `dbType`, so the only way to know which server this
  // is is to ask it — see `isMariaDbVersion`. One `SELECT VERSION()` per connection, and only
  // on MySQL: Postgres never needs it and SQLite has no server to ask.
  //
  // `dbName` is deliberately NOT a dep, unlike the schema list above: switching database keeps
  // the same server, so the version cannot change and re-probing would be a wasted round trip.
  //
  // A failed probe leaves this false, i.e. the gated feature stays hidden. That is the right way
  // round: a MariaDB user briefly missing the Sequences section beats a MySQL user opening one
  // whose every write fails.
  useEffect(() => {
    if (dbType !== 'mysql') {
      queueMicrotask(() => setIsMariaDb(false));
      return;
    }
    let alive = true;
    dbHelper.executeQuery(connId, 'SELECT VERSION() AS v').then((res) => {
      if (alive) setIsMariaDb(isMariaDbVersion(res.data?.[0]?.v));
    });
    return () => {
      alive = false;
    };
  }, [connId, dbType]);

  const handleSchemaChange = async (name: string) => {
    if (!name || name === schema || switchingSchema) return;
    setSwitchingSchema(true);
    try {
      // set_current_schema refuses a schema that does not exist — report the backend's own words
      // rather than leaving the picker showing a schema no later query will use.
      const res = await dbHelper.setSchema(connId, name);
      if (res.success) onSchemaChanged?.(res.schema || name);
      else alert(t('sidebar.errSwitchSchema', { message: res.error || '' }));
    } finally {
      setSwitchingSchema(false);
    }
  };

  const handleShowObjectDef = async (name: string, kind: 'view' | 'function' | 'procedure') => {
    if (kind === 'view' && onOpenViewTab) {
      onOpenViewTab(name);
      return;
    }
    if ((kind === 'procedure' || kind === 'function') && onOpenRoutineTab) {
      onOpenRoutineTab(name, kind);
      return;
    }
    const res = await dbHelper.getObjectDefinition(connId, name, kind);
    if (res.success && res.sql) {
      setObjDef({ name, kind, sql: res.sql });
    } else {
      alert(t('sidebar.errObjectDef', { message: res.error || '' }));
    }
  };

  // `schema` is in the deps too: changing schema changes the whole set of tables, exactly as changing database does.
  useEffect(() => {
    fetchTablesRef.current();
    // After a database switch the old selection points at names that no longer exist —
    // clear it, and drop the Shift anchor so no range is taken against the previous list.
    queueMicrotask(() => {
      setSelection({ section: 'tables', names: [] });
      anchorRef.current = -1;
      // Dropped straight away rather than left until `fetchTables` answers: a temp table belongs to
      // one session, so the previous connection's list is wrong the instant the id changes — and
      // showing it for one round trip is showing rows whose every query would fail.
      setTempTables([]);
    });
    // `connId` is in the deps: two connections can point at the SAME database name (`sakila` on two
    // servers), where `dbName` does not change and the sidebar would show the old connection's tables.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, dbName, schema]);

  useEffect(() => {
    // Only reload for changes on the connection this sidebar is showing. A restore on another
    // connection used to make every sidebar refetch its whole object list for nothing. An event
    // without an id is treated as ours, which is how every dispatch looked before they carried one.
    //
    // `connIdRef`, not `connId`: putting the id in the deps would tear the listeners down and
    // re-register them on every connection switch, for a value the handler can simply read.
    const onChanged = (e: Event) => {
      const from = (e as CustomEvent<{ connId?: string }>).detail?.connId;
      if (from && from !== connIdRef.current) return;
      fetchTablesRef.current();
    };
    window.addEventListener('table-renamed', onChanged);
    window.addEventListener('database-restored', onChanged);
    // DDL run from the SQL editor. Without this the object list only caught renames and restores, so
    // a `CREATE TEMP TABLE` typed into a query tab left the Temporary section invisible until the
    // user pressed Refresh — and a `CREATE TABLE` left the new table missing from the list entirely.
    window.addEventListener('schema-changed', onChanged);
    return () => {
      window.removeEventListener('table-renamed', onChanged);
      window.removeEventListener('database-restored', onChanged);
      window.removeEventListener('schema-changed', onChanged);
    };
  }, []);

  // Focuses the search box: Ctrl+K / Cmd+K.
  //
  // `Ctrl+P` was removed from here. It was a `window` listener with `preventDefault`, so it **claimed**
  // Ctrl+P ahead of everything else — including the title menu's "Toggle sidebar" entry, which
  // advertised `Ctrl+P` and never once ran. The key set now follows VS Code, one meaning per key:
  // `Ctrl+Shift+P` opens the Quick Switcher and `Ctrl+B` toggles the sidebar (both in
  // `TitleBar.tsx`), while this box keeps `Ctrl+K`.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const closeMenu = () => {
      setContextMenu(null);
      setTablesHeaderMenu(null);
    };
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, []);

  // Right-clicking a row OUTSIDE the selection drops that selection and the menu speaks
  // only about that row — otherwise the menu would silently act on rows the user cannot
  // see (scrolled away). Right-clicking INSIDE the selection keeps the whole selection.
  const handleTableContextMenu = useCallback((e: React.MouseEvent, tableName: string, section: ObjectSection, index: number) => {
    e.preventDefault();
    const sel = selectionRef.current;
    const inSelection = sel.section === section && sel.names.includes(tableName);
    if (!inSelection) {
      anchorRef.current = index;
      setSelection({ section, names: [tableName] });
    }
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      tableName,
      names: inSelection ? sel.names : [tableName],
      schema: sectionListsRef.current[section][index]?.schema,
      section,
    });
  }, []);

  // App recreates handleSelectTable on every render (App.tsx: a plain function, not a useCallback),
  // so passing it straight down to ObjectItem would break the memo whenever App renders. Read through
  // a ref — the same way App.tsx already does for selectTableRef.
  const onSelectTableRef = useRef(onSelectTable);
  useEffect(() => {
    onSelectTableRef.current = onSelectTable;
  });

  /**
   * Clicking a row. Three branches, matching what every file manager does: Shift = the
   * range from the anchor to here, Ctrl/Cmd = toggle one row, plain click = start a fresh
   * selection AND open the table. The two modifier branches deliberately do NOT open a
   * tab: gathering a group to drop is unusable if every click opens another tab.
   */
  const handleRowSelect = useCallback((name: string, section: ObjectSection, index: number, e: React.MouseEvent) => {
    const list = sectionListsRef.current[section];
    if (e.shiftKey && anchorRef.current >= 0 && selectionRef.current.section === section) {
      const from = Math.min(anchorRef.current, index);
      const to = Math.max(anchorRef.current, index);
      setSelection({ section, names: list.slice(from, to + 1).map((it) => it.name) });
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      anchorRef.current = index;
      setSelection((prev) => {
        if (prev.section !== section) return { section, names: [name] };
        return prev.names.includes(name)
          ? { section, names: prev.names.filter((n) => n !== name) }
          : { section, names: [...prev.names, name] };
      });
      return;
    }
    anchorRef.current = index;
    setSelection({ section, names: [name] });
    // The row, not just its name: a Temporary row carries the `pg_temp_N` schema every read of it
    // has to name (see `TableItem.schema`), and the tab is where that has to arrive.
    onSelectTableRef.current(name, 'data', undefined, list[index]?.schema);
  }, []);

  // blockedByReadOnly reads the readOnly prop and t, so its identity changes every render too.
  const blockedByReadOnlyRef = useRef(blockedByReadOnly);
  useEffect(() => {
    blockedByReadOnlyRef.current = blockedByReadOnly;
  });
  const handleRowRequestDrop = useCallback((item: TableItem) => {
    if (blockedByReadOnlyRef.current()) return;
    // Delete on a row inside the selection drops the whole selection — what is highlighted.
    // `item.temporary` decides the block, not `item.type`: a temp table is also `type: 'table'`, and
    // measuring the selection against the wrong block would drop the permanent tables instead.
    const sel = selectionRef.current;
    const section: ObjectSection = item.temporary ? 'temporary' : item.type === 'view' ? 'views' : 'tables';
    const names = sel.section === section && sel.names.includes(item.name) ? sel.names : [item.name];
    setDropModal({ names, isView: item.type === 'view', ignoreFkCheck: false, cascade: false, schema: item.schema });
  }, []);

  /**
   * Ctrl+A (select the whole block) and Esc (clear), only while focus is inside the
   * sidebar — the listener is on window but filtered by `rootRef.contains`, otherwise it
   * would steal Ctrl+A from the data grid and the SQL editor. Inside the search box Ctrl+A
   * still means select all TEXT.
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || !(e.target instanceof Node) || !root.contains(e.target)) return;
      const inTextField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        if (inTextField) return;
        e.preventDefault();
        const section = selectionRef.current.section;
        setSelection({ section, names: sectionListsRef.current[section].map((it) => it.name) });
        return;
      }
      if (e.key === 'Escape' && !inTextField) {
        setSelection((prev) => (prev.names.length ? { section: prev.section, names: [] } : prev));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleRenameTable = (tableName: string) => {
    if (blockedByReadOnly()) return;
    setRenameState({ tableName, value: tableName });
  };

  const submitRename = async () => {
    if (!renameState) return;
    if (blockedByReadOnly()) return;
    const { tableName, value } = renameState;
    const newName = value.trim();
    if (!newName || newName === tableName) {
      setRenameState(null);
      return;
    }

    try {
      const res = await dbHelper.renameTable(connId, tableName, newName);
      if (res.success) {
        alert(t('sidebar.renameTableSuccess'));
        if (onTableRenamed) onTableRenamed(tableName, newName);
        fetchTables();
      } else {
        alert(t('sidebar.errRenameTable', { message: res.error }));
      }
    } catch (e: any) {
      alert(t('common.connectionError', { message: e.message }));
    } finally {
      setRenameState(null);
    }
  };

  const handleCreateTable = () => {
    if (blockedByReadOnly()) return;
    setIsCreateModalOpen(true);
  };

  // Creating a view: assemble CREATE VIEW <name> AS <SELECT> and run it through execute_query.
  // Identifiers are quoted per dialect, as elsewhere in this file (backticks on MySQL).
  const handleCreateView = async () => {
    if (blockedByReadOnly()) return;
    const name = newView.name.trim();
    const body = newView.sql.trim().replace(/;+\s*$/, '');
    if (!name) { setCreateViewError(t('sidebar.errViewName')); return; }
    if (!body) { setCreateViewError(t('sidebar.errViewSelect')); return; }

    const q = dbType === 'mysql' ? '`' : '"';
    const quoted = `${q}${name.replace(new RegExp(q, 'g'), q + q)}${q}`;

    setCreatingView(true);
    setCreateViewError(null);
    const res = await dbHelper.executeQuery(connId, `CREATE VIEW ${quoted} AS ${body}`);
    setCreatingView(false);

    if (res.success) {
      setShowCreateView(false);
      setNewView({ name: '', sql: '' });
      await fetchTables();
      onSelectTable(name);
    } else {
      setCreateViewError(res.error || t('sidebar.errCreateView'));
    }
  };



  const handleConfirmTruncate = async () => {
    if (!truncateModal) return;
    if (blockedByReadOnly()) return;
    const { names, restartIdentity, disableFkCheck, cascade } = truncateModal;
    setTruncateModal(null);

    try {
      // One call per table: the backend runs the whole statement group of ONE table on a
      // single connection (session-level foreign-key toggles are void if split across
      // several invokes), so batching tables into one call would be the backend's job, not
      // this one's. A failure on one table does not stop the rest — reported in full below.
      const failed: string[] = [];
      for (const name of names) {
        const res = await dbHelper.truncateTable(connId, name, {
          restartIdentity,
          disableFk: disableFkCheck,
          cascade,
        });
        if (!res.success) failed.push(`${name}: ${res.error || ''}`);
      }

      window.dispatchEvent(new CustomEvent('database-restored', { detail: { connId } }));
      fetchTables();

      if (failed.length === 0) {
        alert(names.length > 1
          ? t('sidebar.bulkTruncateDone', { n: names.length, total: names.length })
          : t('sidebar.truncateSuccess'));
      } else if (names.length === 1) {
        alert(t('sidebar.errTruncate', { message: failed[0] }));
      } else {
        const done = t('sidebar.bulkTruncateDone', { n: names.length - failed.length, total: names.length });
        const err = t('sidebar.bulkFailed', { names: failed.join('\n') });
        alert([done, err].join('\n'));
      }
    } catch (e: any) {
      alert(t('common.connectionError', { message: e.message }));
    }
  };

  const handleConfirmDrop = async () => {
    if (!dropModal) return;
    if (blockedByReadOnly()) return;
    const { names, isView, ignoreFkCheck, cascade, schema: dropSchema } = dropModal;
    setDropModal(null);

    const object = isView ? t('sidebar.objectView') : t('sidebar.objectTable');

    try {
      // See the note in handleConfirmTruncate: one call per object, a failure does not stop
      // the rest. onTableDropped fires per dropped object so App closes exactly those tabs.
      const failed: string[] = [];
      for (const name of names) {
        const res = await dbHelper.dropTable(connId, name, { isView, cascade, ignoreFk: ignoreFkCheck, schema: dropSchema });
        if (res.success) onTableDropped?.(name);
        else failed.push(`${name}: ${res.error || ''}`);
      }

      fetchTables();
      setSelection((prev) => ({ section: prev.section, names: [] }));

      if (failed.length === 0) {
        alert(names.length > 1
          ? t('sidebar.bulkDropDone', { n: names.length, total: names.length })
          : t('sidebar.dropSuccess', { object }));
      } else if (names.length === 1) {
        alert(t('sidebar.errDrop', { object, message: failed[0] }));
      } else {
        const done = t('sidebar.bulkDropDone', { n: names.length - failed.length, total: names.length });
        const err = t('sidebar.bulkFailed', { names: failed.join('\n') });
        alert([done, err].join('\n'));
      }
    } catch (e: any) {
      alert(t('common.connectionError', { message: e.message }));
    }
  };

  // Do not name the callback parameter `t` here or in the maps/filters below:
  // `t` is the translation function, and shadowing it hides it from the body.
  const matchesSearch = useMemo(() => buildMatcher(searchTerm), [searchTerm]);

  // Tables and views are split into two groups (they used to share one list, differing only by icon).
  // useMemo: every keystroke in the search box re-renders the Sidebar, and an App render drags the
  // Sidebar along — without the memo, four filtering passes re-run even on unrelated renders.
  const filteredTables = useMemo(
    () => tables.filter((item) => item.type !== 'view' && matchesSearch(item.name)),
    [tables, matchesSearch]
  );
  const filteredViews = useMemo(
    () => tables.filter((item) => item.type === 'view' && matchesSearch(item.name)),
    [tables, matchesSearch]
  );
  const filteredTempTables = useMemo(
    () => tempTables.filter((item) => matchesSearch(item.name)),
    [tempTables, matchesSearch]
  );
  const filteredFunctions = useMemo(() => functions.filter((f) => matchesSearch(f)), [functions, matchesSearch]);
  const filteredProcedures = useMemo(() => procedures.filter((p) => matchesSearch(p)), [procedures, matchesSearch]);

  // While a search is being typed, groups count as open so results are visible (the collapsed state is ignored)
  const isSearching = searchTerm.trim() !== '';
  type SectionKey = 'tables' | 'views' | 'temporary' | 'functions' | 'procedures';
  const isOpen = (key: SectionKey) => isSearching || !collapsed[key];
  const toggleSection = (key: SectionKey) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  // ↑/↓ navigation from inside the search box (which already takes Ctrl+P/Ctrl+K, so quick-open
  // behaviour is what the user expects). Only the items CURRENTLY visible count; otherwise the arrows
  // would walk through rows inside a collapsed group.
  const navItems = [
    ...(isOpen('tables') ? filteredTables : []),
    ...(isOpen('views') ? filteredViews : []),
    ...(isOpen('temporary') ? filteredTempTables : []),
  ];
  const viewNavOffset = isOpen('tables') ? filteredTables.length : 0;
  const tempNavOffset = viewNavOffset + (isOpen('views') ? filteredViews.length : 0);

  // The single source for Shift+click and Ctrl+A. A collapsed block is left empty: Ctrl+A
  // must not select rows nobody can see, and Shift+click indices must match what was drawn.
  useEffect(() => {
    sectionListsRef.current = {
      tables: isOpen('tables') ? filteredTables : [],
      views: isOpen('views') ? filteredViews : [],
      temporary: isOpen('temporary') ? filteredTempTables : [],
    };
  });

  const [highlight, setHighlight] = useState(-1);
  const highlightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    queueMicrotask(() => setHighlight(-1));
    // `searchTerm` is a trigger: reset the highlighted row whenever the text changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm]);

  useEffect(() => {
    if (highlight >= 0) highlightRef.current?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  /**
   * Each block renders a chunk at a time. The `minCount` arguments translate the ↑/↓ highlight,
   * which is an index into the flat nav run across all three blocks, into "this block must render
   * at least this many rows" — otherwise wrapping from the first row to the last has nothing to
   * scroll to.
   */
  const tablesChunk = useChunkedList(
    filteredTables,
    highlight >= 0 && highlight < viewNavOffset ? highlight + 1 : 0
  );
  const viewsChunk = useChunkedList(
    filteredViews,
    highlight >= viewNavOffset && highlight < tempNavOffset ? highlight - viewNavOffset + 1 : 0
  );
  const tempChunk = useChunkedList(
    filteredTempTables,
    highlight >= tempNavOffset ? highlight - tempNavOffset + 1 : 0
  );

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (navItems.length === 0) return;
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      setHighlight((i) => {
        const next = i + dir;
        if (next < 0) return navItems.length - 1;
        if (next >= navItems.length) return 0;
        return next;
      });
      return;
    }
    if (e.key === 'Enter') {
      const target = navItems[highlight] ?? navItems[0];
      if (target) onSelectTable(target.name);
      return;
    }
    if (e.key === 'Escape' && searchTerm) {
      e.preventDefault();
      setSearchTerm('');
    }
  };

  /** `navIndex` is the position in the ↑/↓ run (tables then views), `index` the position
   *  within the BLOCK — two different numbers, and Shift+click needs the second one. */
  const renderObjectItem = useCallback(
    (item: TableItem, navIndex: number, section: ObjectSection, index: number) => {
    const isExpanded = !!expandedTables[item.name];
    return (
      <ObjectItem
        connId={connId}
        key={item.name}
        item={item}
        section={section}
        index={index}
        isHighlighted={navIndex === highlight}
        isExpanded={isExpanded}
        // Passed only while expanded: a fresh default value each render would break the memo of every
        // closed row.
        schema={isExpanded ? tableSchemaMap[item.name] : undefined}
        isLoadingCols={!!loadingColumns[item.name]}
        highlightRef={highlightRef}
        onSelect={handleRowSelect}
        registerRow={registerRow}
        onContextMenu={handleTableContextMenu}
        onToggleExpand={toggleTableExpanded}
        onRequestDrop={handleRowRequestDrop}
      />
    );
    },
    [
      connId,
      expandedTables,
      highlight,
      tableSchemaMap,
      loadingColumns,
      highlightRef,
      handleRowSelect,
      registerRow,
      handleTableContextMenu,
      toggleTableExpanded,
      handleRowRequestDrop,
    ]
  );

  /**
   * The three object lists, as elements.
   *
   * This memo is the difference between a click costing three DOM writes and costing 2500
   * `createElement` calls plus 2500 `React.memo` prop comparisons. `Sidebar` is NOT memoized and
   * `App` hands it several inline arrows plus `terminalConfig()` (a fresh object per render), so
   * every single App render — a job tick, a transaction event, opening a tab — re-runs this
   * component. Without the memo each of those rebuilds the whole list; with it React sees the same
   * element objects and skips the subtree entirely.
   *
   * It is deliberately keyed on `renderObjectItem`, which carries every real dependency in its own
   * list: adding a prop to a row means adding it there, in one place, rather than to three memos.
   */
  const tableRows = useMemo(
    () => tablesChunk.visible.map((item, i) => renderObjectItem(item, i, 'tables', i)),
    [tablesChunk.visible, renderObjectItem]
  );
  const viewRows = useMemo(
    () => viewsChunk.visible.map((item, i) => renderObjectItem(item, viewNavOffset + i, 'views', i)),
    [viewsChunk.visible, viewNavOffset, renderObjectItem]
  );
  const tempRows = useMemo(
    () =>
      tempChunk.visible.map((item, i) => renderObjectItem(item, tempNavOffset + i, 'temporary', i)),
    [tempChunk.visible, tempNavOffset, renderObjectItem]
  );

  // Grouped Tools Configuration
  const toolGroups = useMemo(() => [
    {
      id: 'query',
      title: t('sidebar.toolsGroupQuery'),
      tools: [
        {
          id: 'sqlEditor',
          label: t('sidebar.sqlEditor'),
          icon: Code2,
          colorClass: 'blue',
          onClick: onNewQuery,
          visible: true,
        },
        {
          id: 'terminal',
          label: t('sidebar.terminal'),
          icon: TerminalSquare,
          colorClass: 'emerald',
          onClick: onOpenTerminal,
          visible: true,
        },
      ],
    },
    {
      id: 'schema',
      title: t('sidebar.toolsGroupSchema'),
      tools: [
        {
          id: 'dbInfo',
          label: t('sidebar.databaseInfo'),
          icon: Database,
          colorClass: 'indigo',
          onClick: onOpenDbInfo,
          visible: !!onOpenDbInfo,
        },
        {
          id: 'processMonitor',
          label: t('sidebar.processMonitor', 'Process Monitor'),
          icon: Activity,
          colorClass: 'cyan',
          onClick: onOpenProcessMonitor,
          visible: !!onOpenProcessMonitor,
        },
        {
          id: 'schemaMigration',
          label: t('sidebar.schemaMigration'),
          icon: GitCompare,
          colorClass: 'violet',
          onClick: onSchemaMigration,
          visible: !!onSchemaMigration,
        },
        {
          id: 'compareDatabases',
          label: t('sidebar.compareDatabases'),
          icon: ArrowLeftRight,
          colorClass: 'amber',
          onClick: onCompareDatabases,
          visible: !!onCompareDatabases,
        },
        {
          id: 'erDiagram',
          label: t('sidebar.erDiagram', 'ER Diagram'),
          icon: Network,
          colorClass: 'blue',
          onClick: onOpenErDiagram,
          visible: !!onOpenErDiagram,
        },
        {
          id: 'mcpSettings',
          label: t('mcp.title'),
          icon: Plug,
          colorClass: 'emerald',
          onClick: onMcpSettings,
          visible: !!onMcpSettings,
        },
      ],
    },
    {
      id: 'data',
      title: t('sidebar.toolsGroupData'),
      tools: [
        {
          id: 'generateData',
          label: t('sidebar.generateData'),
          icon: Sparkles,
          colorClass: 'rose',
          onClick: () => {
            if (blockedByReadOnly()) return;
            onGenerateData?.();
          },
          visible: !!onGenerateData,
        },
        {
          id: 'exportDatabase',
          label: t('sidebar.exportDatabase'),
          icon: HardDriveDownload,
          colorClass: 'cyan',
          onClick: onExportDatabase,
          visible: true,
        },
        {
          id: 'importDatabase',
          label: t('sidebar.importDatabase'),
          icon: HardDriveUpload,
          colorClass: 'teal',
          onClick: onImportDatabase,
          visible: true,
        },
        {
          id: 'copyDatabase',
          label: t('sidebar.copyDatabase'),
          icon: DatabaseZap,
          colorClass: 'violet',
          // Read-only refers to THIS connection, which is only the copy's default source; the guard
          // that matters is on the target, and the dialog reads it off `list_connections`.
          onClick: () => onCopyDatabase?.(),
          visible: !!onCopyDatabase,
        },
      ],
    },
  ], [t, onNewQuery, onOpenTerminal, onOpenDbInfo, onOpenProcessMonitor, onSchemaMigration, onCompareDatabases, onOpenErDiagram, onMcpSettings, onGenerateData, onExportDatabase, onImportDatabase, onCopyDatabase, blockedByReadOnly]);

  return (
    <div className="sidebar-navigation" ref={rootRef} style={{ width: `${width}px` }}>
      {/* The drag handle on the right edge */}
      <div
        className={`sidebar-resizer${resizing ? ' is-resizing' : ''}`}
        role="separator"
        aria-orientation="vertical"
        title={t('sidebar.resizeSidebar')}
        onMouseDown={(e) => { e.preventDefault(); setResizing(true); }}
        onDoubleClick={() => setWidth(SIDEBAR_DEFAULT_WIDTH)}
      />

      {/* Top 4-Tab Segmented Control (Items | Queries | History | Tools).
          Style nằm ở .sb-seg-tab trong index.css — trước đây bốn nút mang bốn khối
          inline style giống nhau, nên lỗi màu ở giao diện tối phải sửa bốn chỗ. */}
      <div className="sb-seg">
        {SEG_TABS.map(([id, labelKey]) => (
          <button
            key={id}
            className={`sb-seg-tab${activeTab === id ? ' is-on' : ''}`}
            onClick={() => setActiveTab(id)}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      {/* The schema picker — Postgres only. MySQL treats a schema as a database (and the title bar
          already has a database picker) while SQLite is always `main`, so `list_schemas` returns
          empty on both and this block disappears by itself without a dbType check here. */}
      {schemas.length > 0 && (
        <div className="sidebar-schema-bar">
          <Layers size={13} className="sidebar-schema-icon" />
          <select
            className="form-input sidebar-schema-select"
            value={schema ?? ''}
            disabled={switchingSchema}
            title={t('sidebar.schemaHint')}
            aria-label={t('sidebar.schema')}
            onChange={(e) => handleSchemaChange(e.target.value)}
          >
            {/* Appears only while the backend has reported no schema (the probe failed) — the picker
                must not show a name at random that the backend is not using. */}
            {!schema && <option value="">{t('sidebar.schema')}</option>}
            {schemas.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Top Search Input with Left Search Icon & Right Sliders Icon */}
      <div className="sidebar-search-container" style={{ padding: '4px 8px' }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search
            size={13}
            style={{
              position: 'absolute',
              left: '10px',
              color: 'var(--win-text-disabled)',
              pointerEvents: 'none',
            }}
          />
          <input
            type="text"
            ref={inputRef}
            className="sidebar-search-input"
            placeholder={
              activeTab === 'items' ? "Search for item..." :
                activeTab === 'queries' ? "Search queries..." :
                  activeTab === 'history' ? "Search history..." :
                    "Search tools..."
            }
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            style={{ paddingLeft: '28px', paddingRight: '28px', width: '100%', height: '30px', fontSize: '11.5px' }}
          />
          <span
            title="Filter options"
            style={{
              position: 'absolute',
              right: '10px',
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
            }}
          >
            <Sliders size={13} style={{ color: 'var(--win-text-disabled)' }} />
          </span>
        </div>
      </div>

      <div className="sidebar-list-container" style={{ flex: 1, overflowY: 'auto' }}>
        {/* TAB 1: ITEMS */}
        {activeTab === 'items' && (
          <div style={{ padding: '2px 0' }}>
            {/* 1. Tables Section (At Top) */}
            <div style={{ marginBottom: '6px' }}>
              <div
                className="sidebar-section-title"
                onClick={() => toggleSection('tables')}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu(null);
                  setTablesHeaderMenu({ x: e.clientX, y: e.clientY });
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '5px 8px',
                  margin: '2px 4px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '11px',
                  fontWeight: 700,
                  letterSpacing: '0.5px',
                  color: 'var(--win-text-secondary)',
                  textTransform: 'uppercase',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {isOpen('tables') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Table size={13} style={{ color: 'var(--win-accent, #2563eb)' }} />
                  <span>{t('sidebar.tablesSection')}</span>
                  <span
                    style={{
                      fontSize: '10px',
                      fontWeight: 600,
                      background: 'var(--win-bg-hover, rgba(0,0,0,0.06))',
                      color: 'var(--win-text-disabled)',
                      padding: '1px 6px',
                      borderRadius: '10px',
                      marginLeft: '2px',
                    }}
                  >
                    {filteredTables.length}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '2px', position: 'relative' }} onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className={`sidebar-section-btn accent ${showAddMenu ? 'is-active' : ''}`}
                    title={t('sidebar.createNew')}
                    onClick={() => setShowAddMenu((v) => !v)}
                  >
                    <Plus size={13} />
                  </button>
                  <button
                    type="button"
                    className="sidebar-section-btn"
                    title={t('sidebar.refreshTables')}
                    disabled={refreshing}
                    onClick={fetchTables}
                  >
                    <RefreshCw size={13} className={refreshing ? 'loading-spinner' : undefined} />
                  </button>

                  {showAddMenu && (
                    <>
                      <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onClick={() => setShowAddMenu(false)} />
                      <div className="ws-menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', minWidth: '200px', zIndex: 999 }}>
                        <button className="context-menu-item" onClick={() => { setShowAddMenu(false); handleCreateTable(); }}>
                          <Table size={13} /> {t('sidebar.createTable')}
                        </button>
                        <button className="context-menu-item" onClick={() => { setShowAddMenu(false); setNewView({ name: '', sql: '' }); setCreateViewError(null); setShowCreateView(true); }}>
                          <Layers size={13} /> {t('sidebar.createView')}
                        </button>
                        <button className="context-menu-item" onClick={() => { setShowAddMenu(false); setShowCreateRoutine(true); }}>
                          <Cog size={13} /> Tạo Stored Procedure / Function
                        </button>
                        <button className="context-menu-item" onClick={() => { setShowAddMenu(false); (onImportNewTable ?? onImportDatabase)(); }}>
                          <HardDriveUpload size={13} /> {t('sidebar.importTableFromFile')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {isOpen('tables') && (
                <div className="sidebar-list">
                  {filteredTables.length === 0 ? (
                    <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)', padding: '8px 12px' }}>
                      {t('sidebar.noTables')}
                    </div>
                  ) : (
                    <>
                      {tableRows}
                      {tablesChunk.hasMore && <div ref={tablesChunk.sentinelRef} />}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* 2. Views Section */}
            {filteredViews.length > 0 && (
              <div style={{ marginBottom: '6px' }}>
                <div
                  className="sidebar-section-title"
                  onClick={() => toggleSection('views')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '5px 8px',
                    margin: '2px 4px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    fontWeight: 700,
                    letterSpacing: '0.5px',
                    color: 'var(--win-text-secondary)',
                    textTransform: 'uppercase',
                  }}
                >
                  {isOpen('views') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Layers size={13} style={{ color: '#8b5cf6' }} />
                  <span>{t('sidebar.viewsSection')}</span>
                  <span
                    style={{
                      fontSize: '10px',
                      fontWeight: 600,
                      background: 'var(--win-bg-hover, rgba(0,0,0,0.06))',
                      color: 'var(--win-text-disabled)',
                      padding: '1px 6px',
                      borderRadius: '10px',
                      marginLeft: 'auto',
                    }}
                  >
                    {filteredViews.length}
                  </span>
                </div>
                {isOpen('views') && (
                  <div className="sidebar-list">
                    {viewRows}
                    {viewsChunk.hasMore && <div ref={viewsChunk.sentinelRef} />}
                  </div>
                )}
              </div>
            )}

            {/* 3. Temporary Tables Section.
                Rendered ONLY while the session owns at least one: a temp table exists for the life
                of a connection, so an empty heading would be a permanent reminder of a feature the
                user is not using. `fetchTables` writes `[]` when the last one is dropped, which is
                what makes the block vanish on its own. */}
            {filteredTempTables.length > 0 && (
              <div className="sidebar-group">
                <div className="sidebar-group-head" onClick={() => toggleSection('temporary')}>
                  {isOpen('temporary') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Timer size={13} className="sidebar-group-icon-temp" />
                  <span>{t('sidebar.temporarySection')}</span>
                  <span className="sidebar-group-count">{filteredTempTables.length}</span>
                </div>
                {isOpen('temporary') && (
                  <div className="sidebar-list">
                    {tempRows}
                    {tempChunk.hasMore && <div ref={tempChunk.sentinelRef} />}
                  </div>
                )}
              </div>
            )}

            {/* 4. Functions Section */}
            {filteredFunctions.length > 0 && (
              <div style={{ marginBottom: '6px' }}>
                <div
                  className="sidebar-section-title"
                  onClick={() => toggleSection('functions')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '5px 8px',
                    margin: '2px 4px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    fontWeight: 700,
                    letterSpacing: '0.5px',
                    color: 'var(--win-text-secondary)',
                    textTransform: 'uppercase',
                  }}
                >
                  {isOpen('functions') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Braces size={13} style={{ color: '#f59e0b' }} />
                  <span>{t('sidebar.functionsSection')}</span>
                  <span
                    style={{
                      fontSize: '10px',
                      fontWeight: 600,
                      background: 'var(--win-bg-hover, rgba(0,0,0,0.06))',
                      color: 'var(--win-text-disabled)',
                      padding: '1px 6px',
                      borderRadius: '10px',
                      marginLeft: 'auto',
                    }}
                  >
                    {filteredFunctions.length}
                  </span>
                </div>
                {isOpen('functions') && (
                  <div className="sidebar-list">
                    {filteredFunctions.map((fn) => (
                      <div
                        key={'fn_' + fn}
                        className="sidebar-item"
                        onClick={() => handleShowObjectDef(fn, 'function')}
                        title={t('sidebar.objectDefHint', { name: fn })}
                      >
                        <Braces size={14} className="icon-view" />
                        <ObjectName name={fn} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 4. Procedures Section */}
            {filteredProcedures.length > 0 && (
              <div style={{ marginBottom: '6px' }}>
                <div
                  className="sidebar-section-title"
                  onClick={() => toggleSection('procedures')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '5px 8px',
                    margin: '2px 4px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    fontWeight: 700,
                    letterSpacing: '0.5px',
                    color: 'var(--win-text-secondary)',
                    textTransform: 'uppercase',
                  }}
                >
                  {isOpen('procedures') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Cog size={13} style={{ color: '#06b6d4' }} />
                  <span>{t('sidebar.proceduresSection')}</span>
                  <span
                    style={{
                      fontSize: '10px',
                      fontWeight: 600,
                      background: 'var(--win-bg-hover, rgba(0,0,0,0.06))',
                      color: 'var(--win-text-disabled)',
                      padding: '1px 6px',
                      borderRadius: '10px',
                      marginLeft: 'auto',
                    }}
                  >
                    {filteredProcedures.length}
                  </span>
                </div>
                {isOpen('procedures') && (
                  <div className="sidebar-list">
                    {filteredProcedures.map((pr) => (
                      <div
                        key={'pr_' + pr}
                        className="sidebar-item"
                        onClick={() => handleShowObjectDef(pr, 'procedure')}
                        title={t('sidebar.objectDefHint', { name: pr })}
                      >
                        <Cog size={14} className="icon-view" />
                        <ObjectName name={pr} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 5. Sequences Section — Postgres and MariaDB only. MySQL has no `CREATE SEQUENCE`, and
                both arrive here as `dbType === 'mysql'`, so the distinction comes from the version
                probe above rather than from `dbType`. */}
            {(dbType === 'postgres' || isMariaDb) && (
              <div style={{ marginBottom: '6px' }}>
                <div
                  className="sidebar-section-title"
                  onClick={() => setShowSequencesModal(true)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '5px 8px',
                    margin: '2px 4px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    fontWeight: 700,
                    letterSpacing: '0.5px',
                    color: 'var(--win-text-secondary)',
                    textTransform: 'uppercase',
                  }}
                >
                  <Layers size={13} style={{ color: '#8b5cf6' }} />
                  <span>Quản lý Sequences</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: QUERIES */}
        {activeTab === 'queries' && (
          <div style={{ padding: '4px 8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>
                SAVED QUERIES ({savedQueriesList.length})
              </span>
              <button
                className="btn btn-secondary"
                style={{ fontSize: '10px', padding: '2px 6px' }}
                onClick={() => onNewQuery()}
              >
                + New Query
              </button>
            </div>

            {savedQueriesList.length === 0 ? (
              <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)', padding: '12px 0', textAlign: 'center' }}>
                No saved queries found
              </div>
            ) : (
              savedQueriesList
                .filter(sq => !searchTerm || sq.name.toLowerCase().includes(searchTerm.toLowerCase()) || sq.sql.toLowerCase().includes(searchTerm.toLowerCase()))
                .map(sq => (
                  <div
                    key={sq.id}
                    className="sidebar-item"
                    onClick={() => onOpenQueryWithSql ? onOpenQueryWithSql(sq.sql) : onNewQuery()}
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '6px 8px', borderRadius: '6px', marginBottom: '4px', cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, fontSize: '12px', color: 'var(--win-text-primary)' }}>
                        <FileCode size={13} color="var(--win-accent)" />
                        <span>{sq.name}</span>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteSavedQuery(sq.id);
                          setSavedQueriesList(loadSavedQueries());
                        }}
                        style={{ background: 'transparent', border: 'none', color: 'var(--win-text-disabled)', cursor: 'pointer', padding: '2px' }}
                        title="Delete saved query"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <div style={{ fontFamily: 'var(--win-font-mono)', fontSize: '10.5px', color: 'var(--win-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%', marginTop: '2px' }}>
                      {sq.sql}
                    </div>
                  </div>
                ))
            )}
          </div>
        )}

        {/* TAB 3: HISTORY */}
        {activeTab === 'history' && (
          <div style={{ padding: '4px 8px' }}>
            {/* Sub-tab Switcher: History vs Saved Queries */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--win-border)', marginBottom: '8px', gap: '4px' }}>
              <button
                type="button"
                onClick={() => setHistorySubTab('history')}
                style={{
                  flex: 1,
                  padding: '5px 0',
                  fontSize: '11px',
                  fontWeight: historySubTab === 'history' ? 600 : 400,
                  border: 'none',
                  borderBottom: historySubTab === 'history' ? '2px solid var(--win-accent, #2563eb)' : '2px solid transparent',
                  background: 'transparent',
                  color: historySubTab === 'history' ? 'var(--win-text-primary)' : 'var(--win-text-secondary)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '4px'
                }}
              >
                <History size={12} />
                <span>History ({historyList.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setHistorySubTab('saved')}
                style={{
                  flex: 1,
                  padding: '5px 0',
                  fontSize: '11px',
                  fontWeight: historySubTab === 'saved' ? 600 : 400,
                  border: 'none',
                  borderBottom: historySubTab === 'saved' ? '2px solid var(--win-accent, #2563eb)' : '2px solid transparent',
                  background: 'transparent',
                  color: historySubTab === 'saved' ? 'var(--win-text-primary)' : 'var(--win-text-secondary)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '4px'
                }}
              >
                <Bookmark size={12} />
                <span>Saved SQL ({savedQueriesList.length})</span>
              </button>
            </div>

            {historySubTab === 'history' ? (
              <>
                {/* Scope Filter Pill Buttons (Database | Connection | All) */}
                <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
                  <button
                    type="button"
                    onClick={() => setHistoryScope('database')}
                    style={{
                      flex: 1,
                      padding: '4px 0',
                      fontSize: '11px',
                      borderRadius: '5px',
                      border: '1px solid var(--win-border)',
                      background: historyScope === 'database' ? 'var(--win-accent, #2563eb)' : 'transparent',
                      color: historyScope === 'database' ? '#ffffff' : 'var(--win-text-secondary)',
                      fontWeight: historyScope === 'database' ? 600 : 400,
                      cursor: 'pointer',
                    }}
                  >
                    Database
                  </button>
                  <button
                    type="button"
                    onClick={() => setHistoryScope('connection')}
                    style={{
                      flex: 1,
                      padding: '4px 0',
                      fontSize: '11px',
                      borderRadius: '5px',
                      border: '1px solid var(--win-border)',
                      background: historyScope === 'connection' ? 'var(--win-accent, #2563eb)' : 'transparent',
                      color: historyScope === 'connection' ? '#ffffff' : 'var(--win-text-secondary)',
                      fontWeight: historyScope === 'connection' ? 600 : 400,
                      cursor: 'pointer',
                    }}
                  >
                    Connection
                  </button>
                  <button
                    type="button"
                    onClick={() => setHistoryScope('all')}
                    style={{
                      flex: 1,
                      padding: '4px 0',
                      fontSize: '11px',
                      borderRadius: '5px',
                      border: '1px solid var(--win-border)',
                      background: historyScope === 'all' ? 'var(--win-accent, #2563eb)' : 'transparent',
                      color: historyScope === 'all' ? '#ffffff' : 'var(--win-text-secondary)',
                      fontWeight: historyScope === 'all' ? 600 : 400,
                      cursor: 'pointer',
                    }}
                  >
                    All
                  </button>
                </div>

                {Object.keys(getGroupedHistory()).length === 0 ? (
                  <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)', padding: '16px 0', textAlign: 'center' }}>
                    No execution history found
                  </div>
                ) : (
                  Object.keys(getGroupedHistory()).map(dateStr => {
                    const groupItems = getGroupedHistory()[dateStr];
                    return (
                      <div key={dateStr} style={{ marginBottom: '12px' }}>
                        {/* Date Header Divider */}
                        <div
                          style={{
                            fontSize: '11px',
                            fontWeight: 600,
                            color: 'var(--win-text-secondary)',
                            paddingBottom: '4px',
                            borderBottom: '1px dashed var(--win-border)',
                            marginBottom: '8px',
                          }}
                        >
                          {dateStr}
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {groupItems.map(item => {
                            const timeStr = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                            const isCopied = copiedId === item.id;
                            return (
                              <div
                                key={item.id}
                                style={{
                                  // A card inside a panel -> --win-bg-card (translucent, sitting on
                                  // the panel), not the popover background.
                                  background: 'var(--win-bg-card)',
                                  border: '1px solid var(--win-border)',
                                  borderRadius: '8px',
                                  padding: '8px 10px',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '6px',
                                  boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
                                  transition: 'all 0.15s ease',
                                }}
                                onClick={() => onOpenQueryWithSql ? onOpenQueryWithSql(item.sql) : onNewQuery()}
                              >
                                {/* Card Header Meta (Status, Time, Duration, Copy, Delete) */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px', color: 'var(--win-text-secondary)' }}>
                                    {item.ok !== false ? <CheckCircle2 size={12} color="#22c55e" /> : <AlertTriangle size={12} color="#ef4444" />}
                                    <span style={{ fontWeight: 600, color: 'var(--win-text-primary)' }}>{timeStr}</span>
                                    {item.ms !== undefined && <span style={{ opacity: 0.65, fontSize: '10px' }}>· {item.ms}ms</span>}
                                  </div>

                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
                                    <span
                                      onClick={(e) => handleCopySql(e, item.id, item.sql)}
                                      style={{
                                        color: isCopied ? '#22c55e' : 'var(--win-accent, #2563eb)',
                                        fontWeight: isCopied ? 600 : 400,
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '2px',
                                      }}
                                      title="Copy SQL to clipboard"
                                    >
                                      <Copy size={11} /> {isCopied ? 'Copied!' : 'Copy'}
                                    </span>
                                    <span
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        deleteHistoryEntry(item.id);
                                        setHistoryList(loadHistory());
                                      }}
                                      style={{ color: '#ef4444', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '2px' }}
                                      title="Delete history entry"
                                    >
                                      Delete
                                    </span>
                                  </div>
                                </div>

                                {/* Card Body SQL Snippet */}
                                <div
                                  style={{
                                    fontFamily: 'var(--win-font-mono, monospace)',
                                    fontSize: '11px',
                                    lineHeight: '1.45',
                                    color: 'var(--win-text-primary)',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                    maxHeight: '110px',
                                    overflowY: 'auto',
                                    padding: '2px 0 0 0',
                                  }}
                                >
                                  {item.sql}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
                )}
              </>
            ) : (
              <>
                {/* Saved Queries Sub-Tab Content */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>
                    SAVED QUERIES ({savedQueriesList.length})
                  </span>
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: '10px', padding: '2px 6px' }}
                    onClick={() => onNewQuery()}
                  >
                    + New Query
                  </button>
                </div>

                {savedQueriesList.length === 0 ? (
                  <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)', padding: '12px 0', textAlign: 'center' }}>
                    No saved queries found
                  </div>
                ) : (
                  savedQueriesList
                    .filter(sq => !searchTerm || sq.name.toLowerCase().includes(searchTerm.toLowerCase()) || sq.sql.toLowerCase().includes(searchTerm.toLowerCase()))
                    .map(sq => (
                      <div
                        key={sq.id}
                        className="sidebar-item"
                        onClick={() => onOpenQueryWithSql ? onOpenQueryWithSql(sq.sql) : onNewQuery()}
                        style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '6px 8px', borderRadius: '6px', marginBottom: '4px', cursor: 'pointer' }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, fontSize: '12px', color: 'var(--win-text-primary)' }}>
                            <FileCode size={13} color="var(--win-accent)" />
                            <span>{sq.name}</span>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteSavedQuery(sq.id);
                              setSavedQueriesList(loadSavedQueries());
                            }}
                            style={{ background: 'transparent', border: 'none', color: 'var(--win-text-disabled)', cursor: 'pointer', padding: '2px' }}
                            title="Delete saved query"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                        <div style={{ fontFamily: 'var(--win-font-mono)', fontSize: '10.5px', color: 'var(--win-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%', marginTop: '2px' }}>
                          {sq.sql}
                        </div>
                      </div>
                    ))
                )}
              </>
            )}
          </div>
        )}

        {/* TAB 4: TOOLS */}
        {activeTab === 'tools' && (
          <div className="sb-tools-container">
            {toolGroups.map(group => {
              const visibleTools = group.tools.filter(tool => tool.visible && matchesSearch(tool.label));
              if (visibleTools.length === 0) return null;
              return (
                <div key={group.id} className="sb-tools-group">
                  <div className="sb-tools-header">{group.title}</div>
                  {visibleTools.map(tool => {
                    const IconComponent = tool.icon;
                    return (
                      <div
                        key={tool.id}
                        className="sb-tool-card"
                        onClick={tool.onClick}
                      >
                        <div className={`sb-tool-icon-wrap ${tool.colorClass}`}>
                          <IconComponent size={14} />
                        </div>
                        <span className="sb-tool-label">{tool.label}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* The floating context menu — repositioned to its real size so it cannot overflow */}
      {contextMenu && (() => {
        const isTempRow = contextMenu.section === 'temporary';
        // The row's kind comes from the list it was right-clicked in. A temp table never appears in
        // `tables`, so looking it up there would report `isView === false` by accident rather than
        // on purpose — and would find a PERMANENT table of the same name if one exists.
        const isView = isTempRow
          ? tempTables.find(item => item.name === contextMenu.tableName)?.type === 'view'
          : tables.find(item => item.name === contextMenu.tableName)?.type === 'view';
        const object = isView ? t('sidebar.objectView') : t('sidebar.objectTable');
        const names = contextMenu.names;
        const menuStyle: React.CSSProperties = {
          position: 'fixed',
          top: menuPos ? menuPos.top : contextMenu.y,
          left: menuPos ? menuPos.left : contextMenu.x,
          // Hidden until measured, so the menu is never seen jumping into place
          visibility: menuPos ? 'visible' : 'hidden',
          zIndex: 99999,
          minWidth: '170px',
        };

        /**
         * Menu for a multi-selection. Only what genuinely runs in bulk: opening a tab,
         * renaming, generating data and import/export all need per-table input, so they are
         * absent here — showing them and acting on one table only would be worse than not.
         */
        if (names.length > 1) {
          return (
            <div ref={menuRef} className="ws-menu" style={menuStyle}>
              <div style={{
                padding: '6px 12px',
                fontSize: '10px',
                fontWeight: 600,
                color: 'var(--win-text-secondary)',
                borderBottom: '1px solid var(--win-border)',
                marginBottom: '4px',
              }}>
                {t('sidebar.ctxSelectedCount', { n: names.length })}
              </div>
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  setContextMenu(null);
                  navigator.clipboard?.writeText(names.join(', '));
                }}
                className="sidebar-context-item sb-ctx-item"
              >
                {t('sidebar.ctxCopyNames')}
              </div>
              {!isView && (
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    setContextMenu(null);
                    if (blockedByReadOnly()) return;
                    setTruncateModal({ names, restartIdentity: false, disableFkCheck: false, cascade: false });
                  }}
                  className="sidebar-context-item sb-ctx-item warn"
                >
                  {t('sidebar.ctxTruncateSelected', { n: names.length })}
                </div>
              )}
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  setContextMenu(null);
                  if (blockedByReadOnly()) return;
                  setDropModal({ names, isView, ignoreFkCheck: false, cascade: false, schema: contextMenu.schema });
                }}
                className="sidebar-context-item sb-ctx-item accent"
              >
                {t('sidebar.ctxDropSelected', { n: names.length })}
              </div>
            </div>
          );
        }

        return (
          <div ref={menuRef} className="ws-menu" style={{
            position: 'fixed',
            top: menuPos ? menuPos.top : contextMenu.y,
            left: menuPos ? menuPos.left : contextMenu.x,
            // Hidden until measured, so the menu is never seen jumping into place
            visibility: menuPos ? 'visible' : 'hidden',
            zIndex: 99999,
            minWidth: '170px'
          }}>
            {/* The heading: says which table the menu is acting on */}
            <div style={{
              padding: '6px 12px',
              fontSize: '10px',
              fontWeight: 600,
              color: 'var(--win-text-secondary)',
              borderBottom: '1px solid var(--win-border)',
              marginBottom: '4px',
              maxWidth: '240px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {contextMenu.tableName}
            </div>
            <div
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                onSelectTable(contextMenu.tableName, 'data', undefined, contextMenu.schema);
              }}
              style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
              className="sidebar-context-item"
            >
              {t('sidebar.ctxOpenData')}
            </div>
            <div
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                onSelectTable(contextMenu.tableName, 'structure', undefined, contextMenu.schema);
              }}
              style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
              className="sidebar-context-item"
            >
              {t('sidebar.ctxOpenStructure', { object })}
            </div>
            {/* Opens the table's own tab on the Properties pane rather than a modal, so two tables'
                properties can be compared side by side instead of one covering the screen. */}
            <div
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                onSelectTable(contextMenu.tableName, 'properties', undefined, contextMenu.schema);
              }}
              style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
              className="sidebar-context-item"
            >
              {t('sidebar.ctxProperties')}
            </div>
            {/* Everything below is dropped for a Temporary row. Import/Export/Generate/Rename/
                Truncate all build their SQL in Rust from the CONNECTION's schema, so on Postgres
                they would address `public.<name>` — a different relation, or none. Offering a menu
                item that cannot work is worse than not offering it. Drop is kept, and is the one
                item that carries the row's own schema. */}
            {!isTempRow && (
              <>
            <div style={{ height: '1px', background: 'var(--win-border)', margin: '4px 0' }} />
            <div
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                onImportToTable(contextMenu.tableName);
              }}
              style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer', opacity: isView ? 0.5 : 1, pointerEvents: isView ? 'none' : 'auto' }}
              className="sidebar-context-item"
              title={isView ? t('sidebar.ctxImportDisabled') : undefined}
            >
              {t('sidebar.ctxImport')}
            </div>
            <div
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                onExportTable(contextMenu.tableName);
              }}
              style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}
              className="sidebar-context-item"
            >
              {t('sidebar.ctxExport')}
            </div>
            {/* Generates test data for this table (it writes, so read-only blocks it, and it means
                nothing for a view). */}
            {onGenerateData && !isView && (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  setContextMenu(null);
                  if (blockedByReadOnly()) return;
                  onGenerateData(contextMenu.tableName);
                }}
                style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}
                className="sidebar-context-item"
              >
                {t('sidebar.ctxGenerateData')}
              </div>
            )}
            <div style={{ height: '1px', background: 'var(--win-border)', margin: '4px 0' }} />
            <div
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                handleRenameTable(contextMenu.tableName);
              }}
              style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer', opacity: isView ? 0.5 : 1, pointerEvents: isView ? 'none' : 'auto' }}
              className="sidebar-context-item"
              title={isView ? t('sidebar.ctxRenameDisabled') : undefined}
            >
              {t('sidebar.ctxRename', { object })}
            </div>
            {!isView && (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  setContextMenu(null);
                  if (blockedByReadOnly()) return;
                  setTruncateModal({
                    names: [contextMenu.tableName],
                    restartIdentity: false,
                    disableFkCheck: false,
                    cascade: false,
                  });
                }}
                style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--st-warn)', cursor: 'pointer' }}
                className="sidebar-context-item"
              >
                {t('sidebar.ctxTruncate')}
              </div>
            )}
              </>
            )}
            {isTempRow && <div style={{ height: '1px', background: 'var(--win-border)', margin: '4px 0' }} />}
            <div
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                if (blockedByReadOnly()) return;
                setDropModal({
                  names: [contextMenu.tableName],
                  isView,
                  ignoreFkCheck: false,
                  cascade: false,
                  schema: contextMenu.schema,
                });
              }}
              style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-accent)', cursor: 'pointer' }}
              className="sidebar-context-item"
            >
              {isView ? t('sidebar.ctxDropView') : t('sidebar.ctxDropTable')}
            </div>
          </div>
        );
      })()}

      {tablesHeaderMenu && (
        <div
          ref={tablesHeaderMenuRef}
          className="ws-menu"
          style={{
            position: 'fixed',
            top: tablesHeaderMenuPos ? tablesHeaderMenuPos.top : tablesHeaderMenu.y,
            left: tablesHeaderMenuPos ? tablesHeaderMenuPos.left : tablesHeaderMenu.x,
            visibility: tablesHeaderMenuPos ? 'visible' : 'hidden',
            zIndex: 99999,
            minWidth: '170px',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="sidebar-context-item sidebar-context-item-icon"
            style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}
            onClick={() => {
              setTablesHeaderMenu(null);
              onOpenDbInfo?.();
            }}
          >
            <Table size={13} className="sidebar-context-icon" />
            <span>{t('sidebar.tablesItemOverview')}</span>
          </div>
          <div
            className="sidebar-context-item sidebar-context-item-icon"
            style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}
            onClick={() => {
              setTablesHeaderMenu(null);
              onOpenErDiagram?.();
            }}
          >
            <Network size={13} className="sidebar-context-icon" />
            <span>{t('sidebar.tablesShowDiagram')}</span>
          </div>
        </div>
      )}



      {renameState && (
        <Modal
          title={t('sidebar.renameTableTitle')}
          onClose={() => setRenameState(null)}
          width="380px"
          zIndex={999999}
        >
          <ModalBody style={{ gap: '12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
              <Trans
                i18nKey="sidebar.renameTablePrompt"
                values={{ name: renameState.tableName }}
                components={{ strong: <strong /> }}
              />
            </div>
            <input
              type="text"
              value={renameState.value}
              onChange={(e) => setRenameState({ ...renameState, value: e.target.value })}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  submitRename();
                } else if (e.key === 'Escape') {
                  setRenameState(null);
                }
              }}
              style={{
                fontSize: '11px',
                padding: '4px 8px',
                borderRadius: '4px',
                border: '1px solid var(--win-border)',
                background: 'var(--win-bg-input)',
                color: 'var(--win-text-primary)',
                outline: 'none',
                cursor: 'text'
              }}
            />
          </ModalBody>
          <ModalFooter>
            <button
              className="btn btn-secondary"
              onClick={() => setRenameState(null)}
              style={{ padding: '0 12px' }}
            >
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary"
              onClick={submitRename}
              style={{ padding: '0 12px', background: 'var(--win-accent)', color: '#fff', border: 'none', cursor: 'pointer' }}
            >
              {t('common.save')}
            </button>
          </ModalFooter>
        </Modal>
      )}


      {isCreateModalOpen && (
        <CreateTableModal
          isOpen={isCreateModalOpen}
          onClose={() => setIsCreateModalOpen(false)}
          dbType={dbType}
          onTableCreated={(name) => {
            fetchTables();
            onSelectTable(name, 'structure');
          }}
        />
      )}

      {showCreateView && (
        <Modal
          title={t('sidebar.createViewTitle')}
          onClose={() => setShowCreateView(false)}
          width="520px"
          maxWidth="90vw"
          zIndex={999999}
        >
          <ModalBody style={{ gap: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('sidebar.viewName')}</label>
              <input
                type="text" autoFocus value={newView.name}
                onChange={(e) => setNewView({ ...newView, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Escape') setShowCreateView(false); }}
                placeholder={t('sidebar.viewNamePlaceholder')}
                style={{ fontSize: '11px', padding: '6px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', outline: 'none' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('sidebar.viewSelect')}</label>
              <textarea
                value={newView.sql}
                onChange={(e) => setNewView({ ...newView, sql: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setShowCreateView(false);
                  // Ctrl/Cmd + Enter creates it; a plain Enter still inserts a newline
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleCreateView();
                }}
                placeholder="SELECT * FROM ..."
                rows={7}
                spellCheck={false}
                style={{ fontSize: '11px', padding: '8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', outline: 'none', fontFamily: 'var(--win-font-mono, monospace)', resize: 'vertical', lineHeight: 1.5 }}
              />
              <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>
                <Trans
                  i18nKey="sidebar.viewHint"
                  values={{ name: newView.name.trim() || t('sidebar.viewNamePlaceholder') }}
                  components={{ code: <code /> }}
                />
              </span>
            </div>
            {createViewError && (
              <div style={{ fontSize: '11px', color: 'var(--st-danger, #ef4444)', wordBreak: 'break-word' }}>{createViewError}</div>
            )}
          </ModalBody>
          <ModalFooter>
            <button className="btn btn-secondary" onClick={() => setShowCreateView(false)} style={{ padding: '0 12px' }}>{t('common.cancel')}</button>
            <button
              className="btn btn-primary"
              onClick={handleCreateView}
              disabled={creatingView}
              style={{ padding: '0 12px', background: 'var(--win-accent)', color: '#fff', border: 'none', opacity: creatingView ? 0.6 : 1 }}
            >
              {creatingView ? t('common.creating') : t('sidebar.createViewButton')}
            </button>
          </ModalFooter>
        </Modal>
      )}


      {renameDbState && (
        <Modal
          title={t('sidebar.renameDbTitle')}
          onClose={() => setRenameDbState(null)}
          width="380px"
          zIndex={999999}
        >
          <ModalBody style={{ gap: '12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
              <Trans
                i18nKey="sidebar.renameDbPrompt"
                values={{ name: renameDbState.oldName }}
                components={{ strong: <strong /> }}
              />
            </div>
            <input
              type="text" autoFocus value={renameDbState.value}
              onChange={(e) => setRenameDbState({ ...renameDbState, value: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRenameDatabase(); if (e.key === 'Escape') setRenameDbState(null); }}
              style={{ fontSize: '11px', padding: '6px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', outline: 'none' }}
            />
          </ModalBody>
          <ModalFooter>
            <button className="btn btn-secondary" onClick={() => setRenameDbState(null)} style={{ padding: '0 12px' }}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleRenameDatabase} style={{ padding: '0 12px', background: 'var(--win-accent)', color: '#fff', border: 'none' }}>{t('common.rename')}</button>
          </ModalFooter>
        </Modal>
      )}

      {showSequencesModal && (
        <SequenceManagerModal
          connId={connId}
          dbType={dbType}
          onClose={() => setShowSequencesModal(false)}
        />
      )}

      {objDef && objDef.kind === 'view' && (
        <ViewEditorModal
          connId={connId}
          name={objDef.name}
          initialSql={objDef.sql}
          onClose={() => setObjDef(null)}
          onSaved={() => fetchTables()}
        />
      )}

      {objDef && (objDef.kind === 'procedure' || objDef.kind === 'function') && (
        <RoutineEditorModal
          connId={connId}
          name={objDef.name}
          kind={objDef.kind}
          initialSql={objDef.sql}
          onClose={() => setObjDef(null)}
          onSaved={() => fetchTables()}
        />
      )}
      {showCreateRoutine && (
        <CreateRoutineModal
          connId={connId}
          dbType={dbType}
          onClose={() => setShowCreateRoutine(false)}
          onCreated={() => fetchTables()}
        />
      )}

      {/* 1. Truncate Table Modal (Image 1) */}
      {truncateModal && (
        <Modal
          title={t('sidebar.truncateModalTitle')}
          onClose={() => setTruncateModal(null)}
          width="400px"
          zIndex={999999}
        >
          <ModalBody style={{ gap: '16px', padding: '16px 20px' }}>
            <div>
              <div className="sb-namelist-label">
                {t('sidebar.truncateModalObjects', { n: truncateModal.names.length })}
              </div>
              <div className="sb-namelist-box">{truncateModal.names.join('\n')}</div>
            </div>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={truncateModal.restartIdentity}
                onChange={(e) => setTruncateModal({ ...truncateModal, restartIdentity: e.target.checked })}
                style={{ marginTop: '3px', cursor: 'pointer', width: '15px', height: '15px' }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--win-text-primary)' }}>
                  {t('sidebar.truncateRestartIdentity')}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>
                  {t('sidebar.truncateRestartIdentityHint')}
                </span>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={truncateModal.disableFkCheck}
                onChange={(e) => setTruncateModal({ ...truncateModal, disableFkCheck: e.target.checked })}
                style={{ marginTop: '3px', cursor: 'pointer', width: '15px', height: '15px' }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--win-text-primary)' }}>
                  {t('sidebar.truncateDisableFk')}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>
                  {t('sidebar.truncateDisableFkHint')}
                </span>
              </div>
            </label>

            {/* On Postgres, turning FK checks off is NOT enough to truncate a table another table
                references (that check lives in the catalog, not in a trigger) — only CASCADE gets
                through, and it truncates the child tables as well. The other dialects have no such
                clause. */}
            {dbType === 'postgres' && (
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={truncateModal.cascade}
                  onChange={(e) => setTruncateModal({ ...truncateModal, cascade: e.target.checked })}
                  style={{ marginTop: '3px', cursor: 'pointer', width: '15px', height: '15px' }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--win-text-primary)' }}>
                    {t('sidebar.truncateCascade')}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--st-warn, var(--win-text-disabled))' }}>
                    {t('sidebar.truncateCascadeHint')}
                  </span>
                </div>
              </label>
            )}
          </ModalBody>
          <ModalFooter style={{ padding: '12px 20px', justifyContent: 'flex-end', gap: '8px' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setTruncateModal(null)}
              style={{ minWidth: '80px', padding: '6px 16px', borderRadius: '6px' }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleConfirmTruncate}
              style={{ minWidth: '80px', padding: '6px 16px', borderRadius: '6px', background: 'var(--win-accent, #2563eb)', color: '#fff', border: 'none' }}
            >
              {t('common.ok')}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {/* 2. Delete tables Modal (Image 2) */}
      {dropModal && (
        <Modal
          title={dropModal.isView ? t('sidebar.dropModalTitleView') : t('sidebar.dropModalTitleTable')}
          onClose={() => setDropModal(null)}
          width="400px"
          zIndex={999999}
        >
          <ModalBody style={{ gap: '16px', padding: '16px 20px' }}>
            <div>
              <div className="sb-namelist-label">
                {t('sidebar.dropModalObjects', { n: dropModal.names.length })}
              </div>
              <div className="sb-namelist-box">{dropModal.names.join('\n')}</div>
            </div>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={dropModal.ignoreFkCheck}
                onChange={(e) => setDropModal({ ...dropModal, ignoreFkCheck: e.target.checked })}
                style={{ marginTop: '3px', cursor: 'pointer', width: '15px', height: '15px' }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--win-text-primary)' }}>
                  {t('sidebar.dropIgnoreFk')}
                </span>
              </div>
            </label>

            {/* Only Postgres really executes CASCADE (SQLite errors on the syntax, MySQL swallows the
                keyword), so it is shown on Postgres alone — and the backend refuses it on the other
                dialects too. */}
            {dbType === 'postgres' && (
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={dropModal.cascade}
                  onChange={(e) => setDropModal({ ...dropModal, cascade: e.target.checked })}
                  style={{ marginTop: '3px', cursor: 'pointer', width: '15px', height: '15px' }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--win-text-primary)' }}>
                    {t('sidebar.dropCascade')}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>
                    {t('sidebar.dropCascadeHint')}
                  </span>
                </div>
              </label>
            )}
          </ModalBody>
          <ModalFooter style={{ padding: '12px 20px', justifyContent: 'flex-end', gap: '8px' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setDropModal(null)}
              style={{ minWidth: '80px', padding: '6px 16px', borderRadius: '6px' }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleConfirmDrop}
              style={{ minWidth: '80px', padding: '6px 16px', borderRadius: '6px', background: 'var(--win-accent, #2563eb)', color: '#fff', border: 'none' }}
            >
              {t('common.ok')}
            </button>
          </ModalFooter>
        </Modal>
      )}

    </div>
  );
};
