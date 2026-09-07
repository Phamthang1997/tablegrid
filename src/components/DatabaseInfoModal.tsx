import React, { useState, useEffect, useMemo, useRef, useDeferredValue } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { dbHelper, type DatabaseStats, type AllDatabasesStats, type AllDatabasesSizeItem } from '../utils/dbHelper';
import { RefreshCw, HardDrive, Hash, Table, Search, ExternalLink, ShieldCheck, Database, Server, ScanSearch, Lock, Layers, Eye, Braces, Cog, ChevronRight, ChevronDown, Columns3 } from 'lucide-react';
import { Modal, ModalFooter } from './Modal';

type InfoTab = 'current' | 'all';
/** The object group being viewed in the "Current database" tab. */
type ObjKind = 'all' | 'table' | 'view' | 'function' | 'procedure';

/**
 * Caches the "all databases" tab per connection, so reopening the modal shows numbers at
 * once instead of re-running the most expensive query in the dialog. The TTL is short
 * because these are live figures (and "refresh" always bypasses the cache); keying on
 * `connId` keeps another server's numbers out.
 */
const ALL_STATS_TTL_MS = 60_000;
const allStatsCache = new Map<string, { at: number; stats: AllDatabasesStats }>();

/**
 * How many table rows are rendered before the list is capped. A row is ~10 elements with a
 * button, so a 2000-table database would otherwise build ~20k DOM nodes on every render of
 * this dialog. Above the cap the user gets a count and a "show all" escape hatch — the
 * search box narrows the list far below it anyway.
 */
const TABLE_ROW_CAP = 500;

/**
 * Merges phase 2's numbers onto phase 1's result. Rows match on `schema_name` first, then
 * `db_name`; every field is written only when phase 2 actually has a number (`??`), so a
 * null can never overwrite what phase 1 already knew.
 */
const mergeSizes = (base: AllDatabasesStats, items: AllDatabasesSizeItem[]): AllDatabasesStats => {
  const byKey = new Map<string, AllDatabasesSizeItem>();
  for (const it of items) {
    const k = it.schema_name || it.db_name;
    if (k) byKey.set(k, it);
  }

  return {
    ...base,
    metrics_pending: false,
    databases: base.databases.map((d) => {
      const m = byKey.get(d.schema_name || d.db_name);
      if (!m) {
        // An empty database is absent from phase 2's per-table aggregate (MySQL GROUP BY
        // over information_schema.TABLES), yet its numbers are known: zero. A database
        // phase 2 skipped (a hidden system schema) keeps its nulls and renders as "-".
        if (d.total_tables === 0) {
          return {
            ...d,
            total_rows: d.total_rows ?? 0,
            data_size_bytes: d.data_size_bytes ?? 0,
            index_size_bytes: d.index_size_bytes ?? 0,
            total_size_bytes: d.total_size_bytes ?? 0,
          };
        }
        return d;
      }
      return {
        ...d,
        total_tables: m.total_tables ?? d.total_tables,
        total_rows: m.total_rows ?? d.total_rows,
        data_size_bytes: m.data_size_bytes ?? d.data_size_bytes,
        index_size_bytes: m.index_size_bytes ?? d.index_size_bytes,
        total_size_bytes: m.total_size_bytes ?? d.total_size_bytes,
        error: m.error ?? d.error,
      };
    }),
  };
};

interface DatabaseInfoModalProps {
  /** The connection this component acts on. Passed explicitly, never read from the ambient id (§4.1). */
  connId: string;
  isOpen?: boolean;
  onClose: () => void;
  onSelectTable: (tableName: string) => void;
  /** Which tab opens with the modal ('all' when entered from the "Statistics for all databases" menu). */
  initialTab?: InfoTab;
  /** Called after a successful database switch, so App reloads the table tree and the tabs. */
  /** See the note of the same name in `Sidebar.tsx`: it opens another connection rather than swapping the pool in place. */
  onDatabaseOpened?: (connId: string, name: string, schema?: string | null) => void;
  asTab?: boolean;
}

export const DatabaseInfoModal: React.FC<DatabaseInfoModalProps> = ({
  connId,
  isOpen = true,
  onClose,
  onSelectTable,
  initialTab = 'current',
  onDatabaseOpened,
  asTab = false,
}) => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<InfoTab>(initialTab);
  const [stats, setStats] = useState<DatabaseStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  /**
   * The list filters on the deferred value, the input renders the live one: on a database
   * with a couple of thousand tables, filtering + reconciling every row on each keystroke is
   * what makes typing feel stuck. React keeps the input responsive and lets the heavy list
   * lag a frame behind instead.
   */
  const deferredSearch = useDeferredValue(searchTerm);
  /** "Show all" was pressed, so `TABLE_ROW_CAP` no longer applies. */
  const [showAllTables, setShowAllTables] = useState(false);
  const [sortBy, setSortBy] = useState<'size_desc' | 'rows_desc' | 'name_asc'>('size_desc');
  const [exactCounts, setExactCounts] = useState<Record<string, number>>({});
  const [countingTable, setCountingTable] = useState<string | null>(null);

  // The current database's views, functions and procedures (sharing the Sidebar's source)
  const [objects, setObjects] = useState<{ views: string[]; functions: string[]; procedures: string[] } | null>(null);
  const [objKind, setObjKind] = useState<ObjKind>('table');
  const [expandedObj, setExpandedObj] = useState<string | null>(null);
  const [objDefs, setObjDefs] = useState<Record<string, string>>({});
  const [loadingDef, setLoadingDef] = useState<string | null>(null);
  const [selectedTableName, setSelectedTableName] = useState<string | null>(null);

  // Tab "all Database"
  const [allStats, setAllStats] = useState<AllDatabasesStats | null>(null);
  const [allLoading, setAllLoading] = useState(false);
  const [allError, setAllError] = useState<string | null>(null);
  const [allSearch, setAllSearch] = useState('');
  const [allSortBy, setAllSortBy] = useState<'size_desc' | 'tables_desc' | 'rows_desc' | 'name_asc'>('size_desc');
  const [showSystemDbs, setShowSystemDbs] = useState(false);
  const [switchingDb, setSwitchingDb] = useState<string | null>(null);
  /** Phase 2 (sizes / row counts) is running in the background — the list is already up. */
  const [metricsLoading, setMetricsLoading] = useState(false);
  /**
   * Token of the current "all databases" load. Phase 2 runs in the background, so it can
   * land after the modal was closed or refresh was pressed; a stale result must be dropped
   * rather than merged.
   */
  const allReqRef = useRef(0);

  const fetchStats = async () => {
    setLoading(true);
    setError(null);
    const [res, objs] = await Promise.all([dbHelper.getDatabaseStats(connId), dbHelper.getDatabaseObjects(connId)]);
    setLoading(false);
    setObjects({ views: objs.views, functions: objs.functions, procedures: objs.procedures });
    if (res.success && res.stats) {
      setStats(res.stats);
    } else {
      setError(res.error || t('dbInfo.errStats'));
    }
  };

  // The SQL definition of a view, function or procedure: loaded on first expansion and then kept.
  const toggleObjectDef = async (name: string, kind: 'view' | 'function' | 'procedure') => {
    const key = `${kind}:${name}`;
    if (expandedObj === key) {
      setExpandedObj(null);
      return;
    }
    setExpandedObj(key);
    if (objDefs[key] !== undefined) return;
    setLoadingDef(key);
    const res = await dbHelper.getObjectDefinition(connId, name, kind);
    setLoadingDef(null);
    setObjDefs((prev) => ({
      ...prev,
      [key]: res.success && res.sql ? res.sql : (res.error || t('dbInfo.errDefinition')),
    }));
  };

  // Phase 2: sizes / row counts. Runs after the list is on screen and blocks nothing.
  const fetchMetrics = async (req: number, base: AllDatabasesStats, includeSystem: boolean) => {
    setMetricsLoading(true);
    const res = await dbHelper.getAllDatabasesSizes(connId, includeSystem);
    if (req !== allReqRef.current) return;
    setMetricsLoading(false);
    if (res.success && res.items) {
      const merged = mergeSizes(base, res.items);
      setAllStats(merged);
      allStatsCache.set(connId, { at: Date.now(), stats: merged });
    } else {
      setAllError(res.error || t('dbInfo.errAllStats'));
    }
  };

  const fetchAllStats = async (force = false) => {
    // Bumping the token cancels an in-flight phase 2, so its flag has to go down with it.
    const req = ++allReqRef.current;
    setMetricsLoading(false);

    if (!force) {
      const hit = allStatsCache.get(connId);
      if (hit && Date.now() - hit.at < ALL_STATS_TTL_MS) {
        setAllStats(hit.stats);
        setAllError(null);
        if (hit.stats.metrics_pending && !hit.stats.metrics_manual) {
          fetchMetrics(req, hit.stats, showSystemDbs);
        }
        return;
      }
    }

    setAllLoading(true);
    setAllError(null);
    const res = await dbHelper.getAllDatabasesStats(connId);
    if (req !== allReqRef.current) return;
    setAllLoading(false);
    if (res.success && res.stats) {
      setAllStats(res.stats);
      allStatsCache.set(connId, { at: Date.now(), stats: res.stats });
      // Postgres needs a connection per database to count, so it waits for "deep scan".
      if (res.stats.metrics_pending && !res.stats.metrics_manual) {
        fetchMetrics(req, res.stats, showSystemDbs);
      }
    } else {
      setAllError(res.error || t('dbInfo.errAllStats'));
    }
  };

  // Reopening the modal always loads the requested tab; closing it clears state so the next
  // open cannot show figures of a database that has since changed. The "all databases" tab
  // is the exception: it reads `allStatsCache` (60s TTL, keyed by connId), so reopening
  // within a minute is instant instead of re-running the dialog's most expensive query.
  useEffect(() => {
    if (!isOpen) {
      // Phase 2 may still be running: bump the token so its result gets dropped.
      allReqRef.current++;
      setMetricsLoading(false);
      setStats(null);
      setAllStats(null);
      setExactCounts({});
      setError(null);
      setAllError(null);
      setObjects(null);
      setObjKind('table');
      setExpandedObj(null);
      setObjDefs({});
      setShowAllTables(false);
      return;
    }
    setTab(initialTab);
    if (initialTab === 'all') fetchAllStats();
    else fetchStats();
    // fetchStats/fetchAllStats close over `t`, whose identity changes on every
    // language switch. Listing them here would refetch the whole statistics set
    // just because the UI language changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialTab]);

  // Switching tabs loads only when that tab has no data yet, so flipping back and forth costs no calls.
  const selectTab = (next: InfoTab) => {
    setTab(next);
    if (next === 'current' && !stats && !loading) fetchStats();
    if (next === 'all' && !allStats && !allLoading) fetchAllStats();
  };

  // Ticking "show system DBs" after phase 2 already ran: those schemas were skipped to save
  // a few hundred table opens, so their numbers have to be fetched now.
  const handleToggleSystemDbs = (checked: boolean) => {
    setShowSystemDbs(checked);
    // A still-true `metrics_pending` means phase 2 has not finished (on Postgres it is
    // waiting for "deep scan") — let that path handle it instead of racing a second one.
    if (!checked || !allStats || allStats.metrics_pending || metricsLoading) return;
    if (allStats.databases.some((d) => d.is_system && (d.total_rows === null || d.total_tables === null))) {
      fetchMetrics(allReqRef.current, allStats, true);
    }
  };

  const handleSwitchDatabase = async (name: string) => {
    if (allStats && name === allStats.current_db) return;
    setSwitchingDb(name);
    const res = await dbHelper.openDatabase(connId, name);
    setSwitchingDb(null);
    if (res.success && res.connId) {
      onDatabaseOpened?.(res.connId, res.database || name, res.schema);
      onClose();
    } else {
      setAllError(t('dbInfo.errOpenDb', { message: res.error || '' }));
    }
  };

  const handleFetchExactCount = async (tableName: string) => {
    setCountingTable(tableName);
    const res = await dbHelper.getExactTableRowCount(connId, tableName);
    setCountingTable(null);
    if (res.success && res.exact_rows !== undefined) {
      setExactCounts((prev) => ({ ...prev, [tableName]: Math.max(0, res.exact_rows!) }));
    }
  };

  const formatBytes = (bytes: number | null | undefined): string => {
    if (bytes === null || bytes === undefined || isNaN(bytes)) return '-';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const allGridItems = useMemo(() => {
    if (!stats?.tables) return [];
    const items = [...stats.tables];
    const existingNames = new Set(items.map((i) => i.table_name.toLowerCase()));

    // Include views from objects.views if any weren't returned by stats.tables
    if (objects?.views) {
      for (const vName of objects.views) {
        if (!existingNames.has(vName.toLowerCase())) {
          items.push({
            table_name: vName,
            schema: stats.db_name,
            kind: 'VIEW',
            charset: null,
            rows: 0,
            is_exact: true,
            data_size_bytes: null,
            index_size_bytes: null,
            total_size_bytes: null,
            engine: '',
            collation: null,
            comment: 'VIEW',
          });
        }
      }
    }
    return items;
  }, [stats, objects]);

  const filteredTables = useMemo(() => {
    let list = allGridItems;
    if (objKind === 'table') {
      list = list.filter((i) => !i.kind || i.kind === 'TABLE');
    } else if (objKind === 'view') {
      list = list.filter((i) => i.kind === 'VIEW');
    }
    const q = deferredSearch.toLowerCase().trim();
    if (q) {
      list = list.filter((tbl) => tbl.table_name.toLowerCase().includes(q));
    }

    return [...list].sort((a, b) => {
      if (sortBy === 'size_desc') {
        const sizeA = a.total_size_bytes ?? 0;
        const sizeB = b.total_size_bytes ?? 0;
        return sizeB - sizeA;
      }
      if (sortBy === 'rows_desc') {
        const rowsA = Math.max(0, exactCounts[a.table_name] ?? a.rows);
        const rowsB = Math.max(0, exactCounts[b.table_name] ?? b.rows);
        return rowsB - rowsA;
      }
      return a.table_name.localeCompare(b.table_name);
    });
  }, [allGridItems, objKind, deferredSearch, sortBy, exactCounts]);

  // The functions/procedures of the selected group (sharing the table search box).
  const currentObjects = useMemo(() => {
    if (!objects || objKind === 'table' || objKind === 'view' || objKind === 'all') return [];
    const src = objKind === 'function' ? objects.functions : objects.procedures;
    const q = deferredSearch.toLowerCase().trim();
    return [...src].filter((n) => n.toLowerCase().includes(q)).sort((a, b) => a.localeCompare(b));
  }, [objects, objKind, deferredSearch]);

  // Only the rows actually rendered. Everything else (counts, the notice) reads
  // `filteredTables`, so capping never changes what the dialog claims to have found.
  const visibleTables = useMemo(
    () => (showAllTables ? filteredTables : filteredTables.slice(0, TABLE_ROW_CAP)),
    [filteredTables, showAllTables]
  );

  const objectCounts = useMemo(
    () => ({
      view: objects?.views.length ?? 0,
      function: objects?.functions.length ?? 0,
      procedure: objects?.procedures.length ?? 0,
    }),
    [objects]
  );

  // The set of databases under consideration, filtered only by "system DBs". Every total (the heading
  // and the tab name included) counts over this set so none of them disagree; the search box only
  // filters rows within the table.
  const scopedDatabases = useMemo(
    () => (allStats?.databases || []).filter((d) => showSystemDbs || !d.is_system),
    [allStats, showSystemDbs]
  );

  // The list shown in the table: that set, plus the search, plus the sort.
  const visibleDatabases = useMemo(() => {
    const list = scopedDatabases.filter((d) =>
      d.db_name.toLowerCase().includes(allSearch.toLowerCase().trim())
    );

    // Always tie-break by name: before phase 2 lands every numeric key is equal, and an
    // alphabetical list reads better than whatever incidental order the server returned.
    return [...list].sort((a, b) => {
      if (allSortBy === 'size_desc' && a.total_size_bytes !== b.total_size_bytes)
        return (b.total_size_bytes ?? 0) - (a.total_size_bytes ?? 0);
      if (allSortBy === 'tables_desc' && a.total_tables !== b.total_tables)
        return (b.total_tables ?? -1) - (a.total_tables ?? -1);
      if (allSortBy === 'rows_desc' && a.total_rows !== b.total_rows)
        return (b.total_rows ?? -1) - (a.total_rows ?? -1);
      return a.db_name.localeCompare(b.db_name);
    });
  }, [scopedDatabases, allSearch, allSortBy]);

  // The totals over the databases under consideration (they follow the "system DBs" filter, not the search).
  const serverSummary = useMemo(() => {
    let size = 0;
    let tables = 0;
    let rows = 0;
    let hasUnknown = false;
    for (const d of scopedDatabases) {
      size += d.total_size_bytes ?? 0;
      if (d.total_tables === null || d.total_rows === null) hasUnknown = true;
      tables += d.total_tables ?? 0;
      rows += d.total_rows ?? 0;
    }
    return { size, tables, rows, count: scopedDatabases.length, hasUnknown };
  }, [scopedDatabases]);

  const systemDbCount = useMemo(
    () => (allStats?.databases || []).filter((d) => d.is_system).length,
    [allStats]
  );

  // A background phase 2 counts as "loading" too: the refresh button spins and stays
  // disabled, which is the only cue that the "…" cells are about to get numbers.
  const busy = tab === 'all' ? allLoading || metricsLoading : loading;

  /** A number cell of the "all databases" tab: "…" while phase 2 runs, "-" if unmeasurable. */
  const metricCell = (v: number | null, render: (n: number) => string) =>
    v === null ? (metricsLoading ? '…' : '-') : render(v);

  if (!isOpen && !asTab) return null;

  const headerTitle = tab === 'all' ? (
    <Trans
      i18nKey="dbInfo.titleAll"
      values={{ n: allStats ? scopedDatabases.length : '...' }}
      components={{ accent: <span style={{ color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono, monospace)', fontWeight: 600 }} /> }}
    />
  ) : (
    <Trans
      i18nKey="dbInfo.titleCurrent"
      values={{ name: stats?.db_name || '...' }}
      components={{ accent: <span style={{ color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono, monospace)', fontWeight: 600 }} /> }}
    />
  );

  const modalBodyContent = (
    <>
      {/* Segmented tabs: the current database ↔ every database on the server.
          The Refresh button sits on this row rather than in the title bar, so the header is exactly
          as tall as every other dialog's (see `Modal.tsx`). */}
      <div className="dbi-tab-bar">
          {([
            {
              key: 'current' as const,
              icon: <Database size={13} />,
              label: stats?.db_name ? t('dbInfo.tabCurrentNamed', { name: stats.db_name }) : t('dbInfo.tabCurrent'),
            },
            {
              key: 'all' as const,
              icon: <Server size={13} />,
              label: allStats ? t('dbInfo.tabAllCount', { n: scopedDatabases.length }) : t('dbInfo.tabAll'),
            },
            // Not named `t` — that is the translation function.
          ]).map((item) => (
            <button
              key={item.key}
              onClick={() => selectTab(item.key)}
              className="dbi-tab-btn"
              style={{
                fontWeight: tab === item.key ? 600 : 500,
                color: tab === item.key ? 'var(--win-accent)' : 'var(--win-text-secondary)',
                borderBottom: `2px solid ${tab === item.key ? 'var(--win-accent)' : 'transparent'}`,
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
          <button
            className="btn btn-secondary dbi-refresh-btn"
            onClick={() => (tab === 'all' ? fetchAllStats(true) : fetchStats())}
            disabled={busy}
            title={t('dbInfo.refreshTitle')}
          >
            <RefreshCw size={12} className={busy ? 'loading-spinner' : ''} />
            <span>{busy ? t('dbInfo.loading') : t('dbInfo.refresh')}</span>
          </button>
        </div>

        {/* Content Body */}
        <div className="dbi-body">
          {tab === 'current' && (<>
          {error && (
            <div style={{ padding: '12px 16px', background: 'var(--win-status-deleted)', border: '1px solid var(--win-status-deleted-border)', borderRadius: '6px', color: 'var(--win-status-deleted-border)', fontSize: '13px' }}>
              {error}
            </div>
          )}

          {/* Overview Cards (Compact single-line) */}
          <div className="dbi-metrics-row">
            {/* Card 1: Total Size */}
            <div className="dbi-metric-card">
              <div className="dbi-metric-icon-wrap dbi-metric-icon-size">
                <HardDrive size={13} />
              </div>
              <div className="dbi-metric-info">
                <span className="dbi-metric-title">{t('dbInfo.cardSize')}:</span>
                <span className="dbi-metric-val">{formatBytes(stats?.total_size_bytes)}</span>
              </div>
            </div>

            {/* Card 2: Total Rows */}
            <div className="dbi-metric-card">
              <div className="dbi-metric-icon-wrap dbi-metric-icon-rows">
                <Hash size={13} />
              </div>
              <div className="dbi-metric-info">
                <span className="dbi-metric-title">{t('dbInfo.cardRows')}:</span>
                <span className="dbi-metric-val">
                  {stats?.total_rows !== undefined ? Math.max(0, stats.total_rows).toLocaleString() : '-'}
                </span>
              </div>
            </div>

            {/* Card 3: Total Tables */}
            <div className="dbi-metric-card">
              <div className="dbi-metric-icon-wrap dbi-metric-icon-tables">
                <Table size={13} />
              </div>
              <div className="dbi-metric-info">
                <span className="dbi-metric-title">{t('dbInfo.cardTables')}:</span>
                <span className="dbi-metric-val">{stats?.total_tables ?? 0}</span>
              </div>
            </div>

            {/* Card 4: views / functions / procedures */}
            <div
              className="dbi-metric-card"
              title={t('dbInfo.otherBreakdown', {
                views: objectCounts.view,
                functions: objectCounts.function,
                procedures: objectCounts.procedure,
              })}
            >
              <div className="dbi-metric-icon-wrap dbi-metric-icon-other">
                <Layers size={13} />
              </div>
              <div className="dbi-metric-info">
                <span className="dbi-metric-title">{t('dbInfo.cardOther')}:</span>
                <span className="dbi-metric-val">
                  {objectCounts.view + objectCounts.function + objectCounts.procedure}
                </span>
                <span className="dbi-metric-sub">
                  ({objectCounts.view}v · {objectCounts.function}f · {objectCounts.procedure}p)
                </span>
              </div>
            </div>
          </div>

          {/* Unified Controls: Filter Pills (Left) + Search & Sorting (Right) */}
          <div className="dbi-toolbar-row">
            <div className="dbi-filter-bar">
              {([
                { key: 'all' as const, icon: <Layers size={12} />, label: t('dbInfo.kindAll'), count: allGridItems.length },
                { key: 'table' as const, icon: <Table size={12} />, label: t('dbInfo.kindTable'), count: stats?.total_tables ?? 0 },
                { key: 'view' as const, icon: <Eye size={12} />, label: t('dbInfo.kindView'), count: objectCounts.view },
                { key: 'function' as const, icon: <Braces size={12} />, label: t('dbInfo.kindFunction'), count: objectCounts.function },
                { key: 'procedure' as const, icon: <Cog size={12} />, label: t('dbInfo.kindProcedure'), count: objectCounts.procedure },
              ]).map((k) => (
                <button
                  key={k.key}
                  type="button"
                  className={`dbi-pill-btn ${objKind === k.key ? 'is-active' : ''}`}
                  onClick={() => { setObjKind(k.key); setExpandedObj(null); }}
                >
                  {k.icon}
                  <span>{k.label}</span>
                  <span className="dbi-pill-count">{k.count}</span>
                </button>
              ))}
            </div>

            <div className="dbi-toolbar-right">
              <div className="dbi-search-box">
                <Search size={13} className="dbi-search-icon" />
                <input
                  type="text"
                  placeholder={objKind === 'function' || objKind === 'procedure' ? t('dbInfo.searchObjects') : t('dbInfo.searchTables')}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="dbi-search-input"
                />
              </div>

              {(objKind === 'all' || objKind === 'table' || objKind === 'view') && (
                <select
                  value={sortBy}
                  onChange={(e: any) => setSortBy(e.target.value)}
                  className="dbi-sort-select"
                >
                  <option value="size_desc">{t('dbInfo.sortSizeDesc')}</option>
                  <option value="rows_desc">{t('dbInfo.sortRowsDesc')}</option>
                  <option value="name_asc">{t('dbInfo.sortNameAsc')}</option>
                </select>
              )}
            </div>
          </div>

          {/* Table List Data Grid (Image 2 style) */}
          <div className="dbi-grid-wrap">
            {objKind === 'function' || objKind === 'procedure' ? (
              /* Routines: only a name and a definition; click to toggle definition */
              <table className="dbi-grid-table">
                <thead>
                  <tr className="dbi-grid-tr-head">
                    <th className="dbi-grid-th">
                      {objKind === 'function' ? t('dbInfo.colFunctionName') : t('dbInfo.colProcedureName')}
                    </th>
                    <th className="dbi-grid-th is-center dbi-actions-col">{t('dbInfo.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={2} className="dbi-grid-empty">
                        <div className="dbi-grid-loading">
                          <RefreshCw size={16} className="loading-spinner" />
                          <span>{t('dbInfo.loadingObjects')}</span>
                        </div>
                      </td>
                    </tr>
                  ) : currentObjects.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="dbi-grid-empty">
                        {objKind === 'function' ? t('dbInfo.noFunctions') : t('dbInfo.noProcedures')}
                      </td>
                    </tr>
                  ) : (
                    currentObjects.map((name) => {
                      const key = `${objKind}:${name}`;
                      const isExpanded = expandedObj === key;
                      const isLoadingDef = loadingDef === key;

                      return (
                        <React.Fragment key={key}>
                          <tr className="dbi-grid-tr">
                            <td className="dbi-grid-td is-name">
                              <div className="dbi-grid-name-cell">
                                {objKind === 'function' ? <Braces size={13} /> : <Cog size={13} />}
                                <span>{name}</span>
                              </div>
                            </td>
                            <td className="dbi-grid-td is-center">
                              <button
                                type="button"
                                className="dbi-exact-btn"
                                onClick={() => toggleObjectDef(name, objKind)}
                              >
                                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                <span>{t('dbInfo.definition')}</span>
                              </button>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr>
                              <td colSpan={2} className="dbi-def-cell">
                                <pre className="dbi-def-pre">
                                  {isLoadingDef ? t('dbInfo.loadingDefinition') : objDefs[key]}
                                </pre>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            ) : (
              <table className="dbi-grid-table">
                <thead>
                  <tr className="dbi-grid-tr-head">
                    <th className="dbi-grid-th dbi-grid-th-index">#</th>
                    <th className="dbi-grid-th">{t('dbInfo.colName')}</th>
                    <th className="dbi-grid-th">{t('dbInfo.colSchema')}</th>
                    <th className="dbi-grid-th">{t('dbInfo.colKind')}</th>
                    <th className="dbi-grid-th">{t('dbInfo.colCharset')}</th>
                    <th className="dbi-grid-th">{t('dbInfo.colCollation')}</th>
                    <th className="dbi-grid-th">{t('dbInfo.colEngine')}</th>
                    <th className="dbi-grid-th is-right">{t('dbInfo.colEstimatedRow')}</th>
                    <th className="dbi-grid-th is-right">{t('dbInfo.colTotalSize')}</th>
                    <th className="dbi-grid-th is-right">{t('dbInfo.colDataSize')}</th>
                    <th className="dbi-grid-th is-right">{t('dbInfo.colIndexSize')}</th>
                    <th className="dbi-grid-th">{t('dbInfo.colComment')}</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={12} className="dbi-grid-empty">
                        <div className="dbi-grid-loading">
                          <RefreshCw size={16} className="loading-spinner" />
                          <span>{t('dbInfo.loadingStats')}</span>
                        </div>
                      </td>
                    </tr>
                  ) : filteredTables.length === 0 ? (
                    <tr>
                      <td colSpan={12} className="dbi-grid-empty">
                        {t('dbInfo.noTableMatch')}
                      </td>
                    </tr>
                  ) : (
                    visibleTables.map((row, idx) => {
                      const isExact = exactCounts[row.table_name] !== undefined || row.is_exact;
                      const rawRows = exactCounts[row.table_name] ?? row.rows;
                      const displayRows = Math.max(0, rawRows);
                      const isCounting = countingTable === row.table_name;
                      const isView = row.kind === 'VIEW';
                      const schemaName = row.schema || stats?.db_name || '-';
                      const kind = isView ? 'VIEW' : 'TABLE';
                      const collation = row.collation || (isView ? '' : '-');
                      const charset = row.charset || (row.collation ? row.collation.split('_')[0] : (isView ? '' : '-'));
                      const engine = row.engine || (isView ? '' : '-');
                      const isSelected = selectedTableName === row.table_name;
                      const comment = row.comment || (isView ? 'VIEW' : '');

                      return (
                        <tr
                          key={row.table_name}
                          className={`dbi-grid-tr ${isSelected ? 'is-selected' : ''}`}
                          onClick={() => setSelectedTableName(row.table_name)}
                          onDoubleClick={() => {
                            onSelectTable(row.table_name);
                            onClose();
                          }}
                          title={t('sidebar.tableItemHint', { name: row.table_name })}
                        >
                          <td className="dbi-grid-td is-index">{idx + 1}</td>
                          <td className="dbi-grid-td is-name">
                            <div className="dbi-grid-name-cell">
                              {isView ? (
                                <Layers size={13} className="dbi-grid-icon-view" />
                              ) : (
                                <Columns3 size={13} className="dbi-grid-icon-table" />
                              )}
                              <span>{row.table_name}</span>
                            </div>
                          </td>
                          <td className="dbi-grid-td">{schemaName}</td>
                          <td className="dbi-grid-td">{kind}</td>
                          <td className={`dbi-grid-td ${!charset ? 'is-muted' : ''}`}>{charset || ''}</td>
                          <td className={`dbi-grid-td ${!collation ? 'is-muted' : ''}`}>{collation || ''}</td>
                          <td className={`dbi-grid-td ${!engine ? 'is-muted' : ''}`}>{engine || ''}</td>
                          <td className="dbi-grid-td is-right">
                            <div className="dbi-grid-count-wrap">
                              {!isView && !isExact && (
                                <span className="dbi-grid-approx">~</span>
                              )}
                              <span>{displayRows.toLocaleString()}</span>
                              {!isView && !isExact && (
                                <button
                                  type="button"
                                  className="dbi-exact-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleFetchExactCount(row.table_name);
                                  }}
                                  disabled={isCounting}
                                  title={t('dbInfo.exactCountTitle')}
                                >
                                  <RefreshCw size={10} className={isCounting ? 'loading-spinner' : ''} />
                                </button>
                              )}
                              {!isView && isExact && (
                                <span title={t('dbInfo.exactRowsTitle')} className="dbi-grid-name-cell">
                                  <ShieldCheck size={12} className="dbi-exact-icon" />
                                </span>
                              )}
                            </div>
                          </td>
                          <td className={`dbi-grid-td is-right ${row.total_size_bytes === null ? 'is-muted' : ''}`}>
                            {row.total_size_bytes !== null ? formatBytes(row.total_size_bytes) : '--'}
                          </td>
                          <td className={`dbi-grid-td is-right ${row.data_size_bytes === null ? 'is-muted' : ''}`}>
                            {row.data_size_bytes !== null ? formatBytes(row.data_size_bytes) : '--'}
                          </td>
                          <td className={`dbi-grid-td is-right ${row.index_size_bytes === null ? 'is-muted' : ''}`}>
                            {row.index_size_bytes !== null ? formatBytes(row.index_size_bytes) : '--'}
                          </td>
                          <td className={`dbi-grid-td ${!comment ? 'is-muted' : ''}`}>
                            {comment || ''}
                          </td>
                        </tr>
                      );
                    })
                  )}
                  {visibleTables.length < filteredTables.length && (
                    <tr>
                      <td colSpan={12} className="dbi-grid-cap-notice">
                        <span>{t('dbInfo.rowCapNotice', { n: visibleTables.length, total: filteredTables.length })}</span>
                        <button
                          type="button"
                          className="btn btn-secondary dbi-grid-cap-btn"
                          onClick={() => setShowAllTables(true)}
                        >
                          {t('dbInfo.showAllRows')}
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
          </>)}

          {tab === 'all' && (<>
          {allError && (
            <div style={{ padding: '12px 16px', background: 'var(--win-status-deleted)', border: '1px solid var(--win-status-deleted-border)', borderRadius: '6px', color: 'var(--win-status-deleted-border)', fontSize: '13px' }}>
              {allError}
            </div>
          )}

          {/* Server Summary Cards (Compact single-line) */}
          <div className="dbi-server-metrics-row">
            <div className="dbi-metric-card">
              <div className="dbi-metric-icon-wrap dbi-metric-icon-size">
                <HardDrive size={13} />
              </div>
              <div className="dbi-metric-info">
                <span className="dbi-metric-title">{t('dbInfo.cardServerSize')}:</span>
                <span className="dbi-metric-val">{metricsLoading ? '…' : formatBytes(serverSummary.size)}</span>
              </div>
            </div>

            <div className="dbi-metric-card">
              <div className="dbi-metric-icon-wrap dbi-metric-icon-tables">
                <Server size={13} />
              </div>
              <div className="dbi-metric-info">
                <span className="dbi-metric-title">{t('dbInfo.cardDbCount')}:</span>
                <span className="dbi-metric-val">{serverSummary.count}</span>
                {systemDbCount > 0 && (
                  <span className="dbi-metric-sub">
                    ({showSystemDbs ? t('dbInfo.includingSystemDbs', { n: systemDbCount }) : t('dbInfo.hidingSystemDbs', { n: systemDbCount })})
                  </span>
                )}
              </div>
            </div>

            <div className="dbi-metric-card">
              <div className="dbi-metric-icon-wrap dbi-metric-icon-rows">
                <Hash size={13} />
              </div>
              <div className="dbi-metric-info">
                <span className="dbi-metric-title">{t('dbInfo.cardTablesRows')}:</span>
                <span className="dbi-metric-val">
                  {serverSummary.tables.toLocaleString()}
                  <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--win-text-secondary)' }}>
                    {' / '}
                    {metricsLoading
                      ? '…'
                      : `${allStats?.rows_are_exact === false ? '~' : ''}${serverSummary.rows.toLocaleString()}`}
                  </span>
                </span>
              </div>
            </div>
          </div>

          {/* Postgres: the table and row counts can only be read from the connected database itself */}
          {allStats?.metrics_manual && allStats.metrics_pending && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', background: 'var(--win-bg-window)', border: '1px dashed var(--win-border)', borderRadius: '6px', fontSize: '11px', color: 'var(--win-text-secondary)' }}>
              <ScanSearch size={14} style={{ color: 'var(--win-accent)', flexShrink: 0 }} />
              <span style={{ flex: 1 }}>
                {t('dbInfo.pgScanNote')}
              </span>
              <button
                onClick={() => fetchMetrics(allReqRef.current, allStats, showSystemDbs)}
                disabled={busy}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '5px', flexShrink: 0,
                  fontSize: '11px', fontWeight: 500, color: '#ffffff', background: 'var(--win-accent)',
                  border: 'none', padding: '4px 10px', borderRadius: '5px',
                  cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1,
                }}
              >
                <ScanSearch size={12} />
                <span>{busy ? t('dbInfo.scanning') : t('dbInfo.deepScan')}</span>
              </button>
            </div>
          )}

          {/* Search & Sorting Bar */}
          <div className="dbi-toolbar-row">
            <div className="dbi-search-box">
              <Search size={13} className="dbi-search-icon" />
              <input
                type="text"
                placeholder={t('dbInfo.searchDatabases')}
                value={allSearch}
                onChange={(e) => setAllSearch(e.target.value)}
                className="dbi-search-input"
              />
            </div>

            <div className="dbi-toolbar-right">
              <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--win-text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
                <input type="checkbox" checked={showSystemDbs} onChange={(e) => handleToggleSystemDbs(e.target.checked)} />
                <span>{t('dbInfo.showSystemDbs')}</span>
              </label>
              <select
                value={allSortBy}
                onChange={(e: any) => setAllSortBy(e.target.value)}
                className="dbi-sort-select"
              >
                <option value="size_desc">{t('dbInfo.sortSizeDesc')}</option>
                <option value="tables_desc">{t('dbInfo.sortTablesDesc')}</option>
                <option value="rows_desc">{t('dbInfo.sortRowsDesc')}</option>
                <option value="name_asc">{t('dbInfo.sortDbNameAsc')}</option>
              </select>
            </div>
          </div>

          {/* Database Comparison Grid */}
          <div style={{ flex: 1, border: '1px solid var(--win-border)', borderRadius: '8px', overflow: 'hidden', background: 'var(--win-bg-window)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ overflowX: 'auto', flex: 1 }}>
              {/* table-layout fixed: columns take their preset proportions rather than letting the
                  browser resize them (a stretchable bar would swallow the space and wrap the numeric
                  columns). minWidth makes a narrow window scroll horizontally instead of crushing
                  them. */}
              <table style={{ width: '100%', minWidth: '860px', tableLayout: 'fixed', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
                <thead>
                  <tr style={{ background: 'var(--win-bg-tab-bar)', borderBottom: '1px solid var(--win-border)', color: 'var(--win-text-secondary)', fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
                    <th style={{ padding: '12px 16px', width: '17%' }}>Database</th>
                    <th style={{ padding: '12px 16px', width: '20%' }}>{t('dbInfo.colSizeShare')}</th>
                    <th style={{ padding: '12px 16px', width: '12%', textAlign: 'right' }}>{t('dbInfo.colSize')}</th>
                    <th style={{ padding: '12px 16px', width: '10%', textAlign: 'right' }}>{t('dbInfo.colTables')}</th>
                    <th style={{ padding: '12px 16px', width: '13%', textAlign: 'right' }}>{t('dbInfo.colRows')}</th>
                    <th style={{ padding: '12px 16px', width: '13%' }}>{t('dbInfo.colEncoding')}</th>
                    <th style={{ padding: '12px 16px', width: '15%', textAlign: 'center' }}>{t('dbInfo.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {allLoading ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--win-text-secondary)' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '10px', fontSize: '13px', fontWeight: 500 }}>
                          <RefreshCw size={18} className="loading-spinner" style={{ color: 'var(--win-accent)' }} />
                          <span>{t('dbInfo.loadingAllStats')}</span>
                        </div>
                      </td>
                    </tr>
                  ) : visibleDatabases.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: '40px', color: 'var(--win-text-disabled)' }}>
                        {t('dbInfo.noDbMatch')}
                      </td>
                    </tr>
                  ) : (
                    visibleDatabases.map((d) => {
                      const size = d.total_size_bytes ?? 0;
                      const pct = serverSummary.size > 0 ? (size / serverSummary.size) * 100 : 0;
                      const isSwitching = switchingDb === d.db_name;

                      return (
                        <tr
                          key={d.schema_name || d.db_name}
                          className={d.is_current ? 'stat-row is-current' : 'stat-row'}
                        >
                          <td style={{ padding: '10px 16px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                              <span
                                title={d.db_name}
                                style={{ fontFamily: 'var(--win-font-mono, monospace)', fontWeight: 600, color: d.is_system ? 'var(--win-text-secondary)' : 'var(--win-accent)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              >
                                {d.db_name}
                              </span>
                              {d.is_current && (
                                <span style={{ fontSize: '10px', fontWeight: 600, padding: '1px 6px', borderRadius: '4px', background: 'var(--win-status-added)', color: 'var(--win-status-added-border)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                                  {t('dbInfo.inUse')}
                                </span>
                              )}
                              {d.is_system && (
                                <span title={t('dbInfo.systemDbTitle')} style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '10px', fontWeight: 600, padding: '1px 6px', borderRadius: '4px', background: 'var(--win-bg-tab-bar)', border: '1px solid var(--win-border)', color: 'var(--win-text-secondary)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                                  <Lock size={9} /> {t('dbInfo.system')}
                                </span>
                              )}
                              {d.error && (
                                <span title={d.error} style={{ fontSize: '10px', color: 'var(--st-danger, #ef4444)' }}>⚠</span>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: '10px 16px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <div style={{ flex: 1, minWidth: '80px', height: '6px', borderRadius: '3px', background: 'var(--win-bg-tab-bar)', overflow: 'hidden' }}>
                                <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', borderRadius: '3px', background: d.is_system ? 'var(--win-text-disabled)' : 'var(--win-accent)' }} />
                              </div>
                              <span style={{ fontFamily: 'var(--win-font-mono, monospace)', fontSize: '11px', color: 'var(--win-text-secondary)', width: '46px', textAlign: 'right', flexShrink: 0, whiteSpace: 'nowrap' }}>
                                {metricCell(d.total_size_bytes, () => `${pct.toFixed(1)}%`)}
                              </span>
                            </div>
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--win-font-mono, monospace)', fontWeight: 600, color: 'var(--win-text-primary)', whiteSpace: 'nowrap' }}>
                            {metricCell(d.total_size_bytes, formatBytes)}
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--win-font-mono, monospace)', color: 'var(--win-text-secondary)', whiteSpace: 'nowrap' }}>
                            {metricCell(d.total_tables, (n) => n.toLocaleString())}
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--win-font-mono, monospace)', color: 'var(--win-text-secondary)', whiteSpace: 'nowrap' }}>
                            {metricCell(
                              d.total_rows,
                              (n) => `${allStats?.rows_are_exact ? '' : '~'}${n.toLocaleString()}`
                            )}
                          </td>
                          <td style={{ padding: '10px 16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            <span title={d.collation || undefined} style={{ padding: '2px 8px', fontSize: '11px', fontWeight: 500, background: 'var(--win-bg-tab-bar)', borderRadius: '4px', border: '1px solid var(--win-border)', color: 'var(--win-text-secondary)' }}>
                              {d.charset || '-'}
                            </span>
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                            {allStats?.db_type === 'sqlite' || d.is_current ? (
                              <span style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>—</span>
                            ) : (
                              <button
                                onClick={() => handleSwitchDatabase(d.db_name)}
                                disabled={isSwitching || switchingDb !== null}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: '5px',
                                  fontSize: '11px',
                                  fontWeight: 500,
                                  color: '#ffffff',
                                  background: 'var(--win-accent)',
                                  border: 'none',
                                  padding: '5px 12px',
                                  borderRadius: '4px',
                                  cursor: switchingDb !== null ? 'default' : 'pointer',
                                  opacity: switchingDb !== null && !isSwitching ? 0.5 : 1,
                                  whiteSpace: 'nowrap',
                                  flexShrink: 0,
                                }}
                              >
                                <span>{isSwitching ? t('dbInfo.switching') : t('dbInfo.switchDb')}</span>
                                {!isSwitching && <ExternalLink size={12} />}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
          </>)}
        </div>
    </>
  );

  const footerContent = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 18px', borderTop: '1px solid var(--win-border)', background: 'var(--win-bg-card)', flexShrink: 0, fontSize: '12px', color: 'var(--win-text-secondary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--win-status-added-border, #10b981)' }} />
        <span>{t('dbInfo.catalogNote')}</span>
      </div>
      {onClose && (
        <button className="btn btn-secondary" onClick={onClose} style={{ padding: '0 20px' }}>
          {t('common.close')}
        </button>
      )}
    </div>
  );

  if (asTab) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', width: '100%', overflow: 'hidden', background: 'var(--win-bg-window)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 18px', borderBottom: '1px solid var(--win-border)', background: 'var(--win-bg-card)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {tab === 'all'
              ? <Server size={15} style={{ color: 'var(--win-accent)' }} />
              : <HardDrive size={15} style={{ color: 'var(--win-accent)' }} />}
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
              {headerTitle}
            </span>
            <span
              title={t('dbInfo.dbTypeLabel')}
              style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--win-accent)', background: 'var(--win-accent-glow)', border: '1px solid var(--win-border)', padding: '1px 8px', borderRadius: '4px', letterSpacing: '0.05em' }}
            >
              {(tab === 'all' ? allStats?.db_type : stats?.db_type) || '-'}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {modalBodyContent}
        </div>
        {footerContent}
      </div>
    );
  }

  return (
    <Modal
      title={headerTitle}
      icon={tab === 'all'
        ? <Server size={14} style={{ color: 'var(--win-accent)', flexShrink: 0 }} />
        : <HardDrive size={14} style={{ color: 'var(--win-accent)', flexShrink: 0 }} />}
      onClose={onClose}
      width="1100px"
      maxWidth="95%"
      height="85vh"
      zIndex={9999}
      cardStyle={{ color: 'var(--win-text-primary)', fontFamily: 'var(--win-font-sans, system-ui, sans-serif)' }}
      headerExtra={
        <span
          title={t('dbInfo.dbTypeLabel')}
          style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--win-accent)', background: 'var(--win-accent-glow)', border: '1px solid var(--win-border)', padding: '1px 8px', borderRadius: '4px', letterSpacing: '0.05em' }}
        >
          {(tab === 'all' ? allStats?.db_type : stats?.db_type) || '-'}
        </span>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {modalBodyContent}
      </div>
      <ModalFooter style={{ justifyContent: 'space-between', fontSize: '12px', color: 'var(--win-text-secondary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--win-status-added-border, #10b981)' }} />
          <span>{t('dbInfo.catalogNote')}</span>
        </div>
        <button className="btn btn-secondary" onClick={onClose} style={{ padding: '0 20px' }}>
          {t('common.close')}
        </button>
      </ModalFooter>
    </Modal>
  );
};
