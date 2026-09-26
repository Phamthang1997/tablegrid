import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Columns3,
  Copy,
  Database,
  Download,
  FileCode,
  Hash,
  Loader,
  Play,
  Search,
  CheckCircle2,
  Table as TableIcon,
  Plus,
  X,
  ArrowRight,
  CheckSquare,
  Square,
  MinusSquare,
  Eye,
} from 'lucide-react';
import { dbHelper } from '../utils/dbHelper';
import {
  filterTableDiffs,
  formatCell,
  hasRunnableSql,
  joinSyncSql,
  statusLabelKey,
  statusTone,
  syncSqlFileName,
  type CompareSide,
  type DataCompareResult,
  type DataOverviewResult,
  type DiffStatus,
  type SchemaCompareResult,
  type TableDiff,
} from '../utils/compareHelper';
import { Modal, ModalBody } from './Modal';

export interface DbCompareDialogProps {
  /** The connection this dialog reads its database list from. */
  connId: string;
  dbType: string;
  currentDb?: string;
  onClose: () => void;
  onOpenInSqlEditor?: (sql: string) => void;
  asTab?: boolean;
}

const TONE_COLOR: Record<string, string> = {
  ok: 'var(--st-ok)',
  warn: 'var(--st-warn)',
  danger: 'var(--st-danger)',
  muted: 'var(--win-text-secondary)',
};

const label: React.CSSProperties = { fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' };
const input: React.CSSProperties = {
  background: 'var(--win-bg-window)',
  border: '1px solid var(--win-border)',
  color: 'var(--win-text-primary)',
  borderRadius: '5px',
  padding: '5px 8px',
  fontSize: '11.5px',
  outline: 'none',
  width: '100%',
};
const mono: React.CSSProperties = { fontFamily: 'var(--win-font-mono)', fontSize: '11px' };

const Badge: React.FC<{ tone: string; children: React.ReactNode }> = ({ tone, children }) => (
  <span
    style={{
      fontSize: '10px',
      fontWeight: 600,
      color: TONE_COLOR[tone] || 'var(--win-text-secondary)',
      border: `1px solid ${TONE_COLOR[tone] || 'var(--win-border)'}`,
      borderRadius: '4px',
      padding: '1px 6px',
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </span>
);

/** Helper to generate pseudo-DDL string for side-by-side comparison */
function generateTableDdl(tb: TableDiff, side: 'source' | 'target'): string {
  const isSource = side === 'source';
  if (tb.kind === 'view') {
    return `-- View: ${tb.name}\nCREATE VIEW \`${tb.name}\` AS SELECT * FROM ...;`;
  }

  const lines: string[] = [];
  lines.push(`CREATE TABLE \`${tb.name}\` (`);

  const colLines: string[] = [];
  tb.columns.forEach((it) => {
    const col = isSource ? it.source : it.target;
    if (col) {
      let line = `  \`${col.name}\` ${col.type}`;
      if (!col.nullable) line += ' NOT NULL';
      if (col.autoIncrement) line += ' AUTO_INCREMENT';
      if (col.default !== null && col.default !== undefined && col.default !== '') {
        line += ` DEFAULT ${col.default}`;
      }
      if (col.comment) line += ` COMMENT '${col.comment}'`;
      colLines.push(line);
    }
  });

  const pk = isSource ? tb.primaryKey.source : tb.primaryKey.target;
  if (pk && pk.length > 0) {
    colLines.push(`  PRIMARY KEY (\`${pk.join('`, `')}\`)`);
  }

  tb.indexes.forEach((it) => {
    const idx = isSource ? it.source : it.target;
    if (idx) {
      colLines.push(`  ${idx.unique ? 'UNIQUE ' : ''}KEY \`${idx.name}\` (\`${idx.columns.join('`, `')}\`)`);
    }
  });

  tb.foreignKeys.forEach((it) => {
    const fk = isSource ? it.source : it.target;
    if (fk) {
      let line = `  CONSTRAINT \`${fk.name}\` FOREIGN KEY (\`${fk.columns.join('`, `')}\`) REFERENCES \`${fk.refTable}\` (\`${fk.refColumns.join('`, `')}\`)`;
      if (fk.onDelete) line += ` ON DELETE ${fk.onDelete}`;
      if (fk.onUpdate) line += ` ON UPDATE ${fk.onUpdate}`;
      colLines.push(line);
    }
  });

  lines.push(colLines.join(',\n'));
  lines.push(`);`);

  return lines.join('\n');
}

/** Diff Progress Bar Component */
const DiffProgressBar: React.FC<{
  summary: SchemaCompareResult['summary'];
}> = ({ summary }) => {
  const { t } = useTranslation();
  const totalTables =
    summary.tablesOnlySource + summary.tablesOnlyTarget + summary.tablesDifferent + summary.tablesIdentical;

  if (totalTables === 0) return null;

  const diffCount = summary.tablesOnlySource + summary.tablesOnlyTarget + summary.tablesDifferent;
  const pSource = (summary.tablesOnlySource / totalTables) * 100;
  const pTarget = (summary.tablesOnlyTarget / totalTables) * 100;
  const pDiff = (summary.tablesDifferent / totalTables) * 100;
  const pIdentical = (summary.tablesIdentical / totalTables) * 100;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: '220px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px' }}>
        <span style={{ fontWeight: 600, color: diffCount > 0 ? 'var(--win-status-modified-border)' : 'var(--st-ok)' }}>
          {diffCount > 0 ? `${diffCount}/${totalTables} ${t('compare.diffTablesLabel', { defaultValue: 'bảng khác biệt' })}` : t('compare.identicalSchema')}
        </span>
        <span style={{ color: 'var(--win-text-disabled)', fontSize: '10.5px' }}>
          {summary.tablesDifferent > 0 && `${summary.tablesDifferent} cần sửa `}
          {summary.tablesOnlySource > 0 && `${summary.tablesOnlySource} tạo mới `}
          {summary.tablesOnlyTarget > 0 && `${summary.tablesOnlyTarget} xoá `}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          height: '6px',
          borderRadius: '3px',
          overflow: 'hidden',
          background: 'var(--win-border)',
          width: '100%',
        }}
      >
        {pDiff > 0 && (
          <div
            style={{ width: `${pDiff}%`, background: 'var(--win-status-modified-border)' }}
            title={t('compare.summaryDifferent', { n: summary.tablesDifferent })}
          />
        )}
        {pSource > 0 && (
          <div
            style={{ width: `${pSource}%`, background: 'var(--win-status-added-border)' }}
            title={t('compare.summaryOnlySource', { n: summary.tablesOnlySource })}
          />
        )}
        {pTarget > 0 && (
          <div
            style={{ width: `${pTarget}%`, background: 'var(--win-status-deleted-border)' }}
            title={t('compare.summaryOnlyTarget', { n: summary.tablesOnlyTarget })}
          />
        )}
        {pIdentical > 0 && (
          <div
            style={{ width: `${pIdentical}%`, background: 'var(--win-bg-active)' }}
            title={t('compare.summaryIdentical', { n: summary.tablesIdentical })}
          />
        )}
      </div>
    </div>
  );
};

export const DbCompareDialog: React.FC<DbCompareDialogProps> = ({
  connId,
  dbType,
  currentDb,
  onClose,
  onOpenInSqlEditor,
  asTab = false,
}) => {
  const { t, i18n } = useTranslation();
  const isSqlite = dbType === 'sqlite';
  const isPostgres = dbType === 'postgres';

  const [mode, setMode] = useState<'structure' | 'data'>('structure');
  const [source, setSource] = useState<CompareSide>({ database: currentDb || '', schema: isPostgres ? 'public' : '' });
  const [target, setTarget] = useState<CompareSide>({ database: '', schema: isPostgres ? 'public' : '' });
  const [databases, setDatabases] = useState<string[]>([]);
  const [includeDrops, setIncludeDrops] = useState(false);

  const [busy, setBusy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const [schemaResult, setSchemaResult] = useState<SchemaCompareResult | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<Set<DiffStatus>>(new Set());
  const [bottomTab, setBottomTab] = useState<'ddl' | 'sql'>('ddl');

  const toggleStatus = (s: DiffStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  // Tree expanded & checked states (Navicat style)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    different: true,
    onlySource: true,
    onlyTarget: true,
    identical: false,
  });
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});
  const [checkedTables, setCheckedTables] = useState<Set<string>>(new Set());

  const [overview, setOverview] = useState<DataOverviewResult | null>(null);
  const [dataTable, setDataTable] = useState<string | null>(null);
  const [, setKeyText] = useState('');
  const [rowLimit] = useState(20000);
  const [dataResult, setDataResult] = useState<DataCompareResult | null>(null);
  const [dataTab, setDataTab] = useState<'rows' | 'sql'>('rows');
  const [checkedDataTables, setCheckedDataTables] = useState<Set<string>>(new Set());
  const [showBottomPane, setShowBottomPane] = useState(false);

  // Load available databases
  useEffect(() => {
    if (isSqlite) return;
    let alive = true;
    dbHelper.listDatabases(connId).then((res) => {
      if (alive && res.success) setDatabases(res.databases);
    });
    return () => {
      alive = false;
    };
  }, [connId, isSqlite]);

  const sideReady = isSqlite
    ? !!source.filePath?.trim() && !!target.filePath?.trim()
    : !!target.database?.trim();

  const swap = () => {
    setSource(target);
    setTarget(source);
    setSchemaResult(null);
    setOverview(null);
    setDataResult(null);
    setSelectedTable(null);
    setDataTable(null);
  };

  const runSchemaCompare = useCallback(async () => {
    setError(null);
    setNotice('');
    setBusy(t('compare.busySchema'));
    try {
      const res = await dbHelper.compareSchemas(source, target, includeDrops);
      setSchemaResult(res);
      const diffTb = res.tables.find((x) => x.status !== 'identical') ?? res.tables[0] ?? null;
      setSelectedTable(diffTb?.name ?? null);

      // Select all non-identical tables by default
      const checked = new Set<string>();
      res.tables.forEach((tbl) => {
        if (tbl.status !== 'identical') checked.add(tbl.name);
      });
      setCheckedTables(checked);
      setBottomTab('ddl');
    } catch (err: any) {
      setSchemaResult(null);
      setError(t('compare.errRun', { message: String(err) }));
    } finally {
      setBusy('');
    }
  }, [source, target, includeDrops, t]);

  const runOverview = useCallback(async () => {
    setError(null);
    setNotice('');
    setBusy(t('compare.busyOverview'));
    try {
      const res = await dbHelper.compareDataOverview(source, target);
      setOverview(res);
      setCheckedDataTables(new Set(res.tables.map((tbl) => tbl.name)));
      setDataTable(null);
      setDataResult(null);
    } catch (err: any) {
      setOverview(null);
      setError(t('compare.errRun', { message: String(err) }));
    } finally {
      setBusy('');
    }
  }, [source, target, t]);

  const toggleDataTableChecked = (tableName: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setCheckedDataTables((prev) => {
      const next = new Set(prev);
      if (next.has(tableName)) next.delete(tableName);
      else next.add(tableName);
      return next;
    });
  };

  const toggleAllDataTablesChecked = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!overview) return;
    const allNames = overview.tables.map((tbl) => tbl.name);
    const allChecked = allNames.every((n) => checkedDataTables.has(n));
    if (allChecked) {
      setCheckedDataTables(new Set());
    } else {
      setCheckedDataTables(new Set(allNames));
    }
  };

  const runDataCompare = useCallback(
    async (table: string, keys: string[]) => {
      setError(null);
      setNotice('');
      setBusy(t('compare.busyData', { name: table }));
      try {
        const res = await dbHelper.compareTableData(source, target, table, {
          keyColumns: keys.length ? keys : undefined,
          limit: rowLimit,
          includeDrops,
        });
        setDataResult(res);
        setKeyText(res.keyColumns.join(', '));
        setDataTab('rows');
      } catch (err: any) {
        setDataResult(null);
        setError(t('compare.errRun', { message: String(err) }));
      } finally {
        setBusy('');
      }
    },
    [source, target, rowLimit, includeDrops, t],
  );

  const openTableData = (table: string, pk: string[]) => {
    setDataTable(table);
    setKeyText(pk.join(', '));
    setDataResult(null);
    void runDataCompare(table, pk);
  };

  const currentSql = mode === 'structure' ? schemaResult?.syncSql : dataResult?.syncSql;
  const sqlText = useMemo(() => (currentSql ? joinSyncSql(currentSql) : ''), [currentSql]);

  const copySql = async () => {
    await navigator.clipboard.writeText(sqlText);
    setNotice(t('compare.copied'));
  };

  const downloadSql = () => {
    const name = syncSqlFileName(mode === 'structure' ? 'schema' : 'data', target.database || target.filePath || '');
    const blob = new Blob([sqlText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const filteredTables = useMemo(
    () => (schemaResult ? filterTableDiffs(schemaResult.tables, { statuses: statusFilter, search }) : []),
    [schemaResult, statusFilter, search],
  );
  const selectedTableObj = schemaResult?.tables.find((x) => x.name === selectedTable) ?? null;

  // Group tables by operation status (Navicat style)
  const groupedTables = useMemo(() => {
    const groups = {
      different: [] as TableDiff[],
      onlySource: [] as TableDiff[],
      onlyTarget: [] as TableDiff[],
      identical: [] as TableDiff[],
    };
    filteredTables.forEach((tb) => {
      groups[tb.status].push(tb);
    });
    return groups;
  }, [filteredTables]);

  const toggleGroupExpand = (grpKey: string) => {
    setExpandedGroups((prev) => ({ ...prev, [grpKey]: !prev[grpKey] }));
  };

  const toggleTableExpand = (tableName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedTables((prev) => ({ ...prev, [tableName]: !prev[tableName] }));
  };

  const toggleTableChecked = (tableName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCheckedTables((prev) => {
      const next = new Set(prev);
      if (next.has(tableName)) next.delete(tableName);
      else next.add(tableName);
      return next;
    });
  };

  const toggleAllCheckedInGroup = (grpTables: TableDiff[], e: React.MouseEvent) => {
    e.stopPropagation();
    const allChecked = grpTables.every((tbl) => checkedTables.has(tbl.name));
    setCheckedTables((prev) => {
      const next = new Set(prev);
      grpTables.forEach((tbl) => {
        if (allChecked) next.delete(tbl.name);
        else next.add(tbl.name);
      });
      return next;
    });
  };

  const num = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString(i18n.language));

  // ---- Database Connection Banner ----
  const sideCard = (which: 'source' | 'target') => {
    const value = which === 'source' ? source : target;
    const setValue = which === 'source' ? setSource : setTarget;
    const patch = (p: Partial<CompareSide>) => {
      setValue({ ...value, ...p });
      setSchemaResult(null);
      setOverview(null);
      setDataResult(null);
    };

    const isSrc = which === 'source';

    return (
      <div className="db-compare-side-box">
        <div className="db-compare-side-header">
          <span className={`db-compare-side-tag ${isSrc ? 'source-tag' : 'target-tag'}`}>
            <Database size={12} />
            <span>{isSrc ? t('compare.sourceLabel') : t('compare.targetLabel')}</span>
          </span>
          <span className="db-compare-side-hint">
            {isSrc ? t('compare.sourceHint') : t('compare.targetHint')}
          </span>
        </div>

        {isSqlite ? (
          <input
            type="text"
            className="db-compare-input"
            value={value.filePath || ''}
            placeholder={t('compare.sqlitePathPlaceholder')}
            onChange={(e) => patch({ filePath: e.target.value })}
          />
        ) : (
          <div style={{ display: 'flex', gap: '6px', width: '100%', alignItems: 'center' }}>
            <div className="db-compare-select-wrap">
              <select
                className="db-compare-select"
                value={value.database || ''}
                onChange={(e) => patch({ database: e.target.value })}
              >
                <option value="">{t('compare.currentDatabase')}</option>
                {databases.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} className="db-compare-select-chevron" />
            </div>
            {isPostgres && (
              <input
                type="text"
                className="db-compare-input"
                style={{ width: '110px', flex: 'none' }}
                value={value.schema || ''}
                placeholder={t('compare.schemaPlaceholder')}
                onChange={(e) => patch({ schema: e.target.value })}
              />
            )}
          </div>
        )}
      </div>
    );
  };

  // ---- DDL Side-by-Side Comparison Code Pane ----
  const ddlPane = useMemo(() => {
    if (!selectedTableObj) {
      return (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--win-text-disabled)', fontSize: '12px' }}>
          {t('compare.pickTable', { defaultValue: 'Chọn một bảng trong danh sách để xem so sánh DDL' })}
        </div>
      );
    }

    const sourceDdl = generateTableDdl(selectedTableObj, 'source');
    const targetDdl = generateTableDdl(selectedTableObj, 'target');

    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', flex: 1, minHeight: 0 }}>
        {/* Source DDL Box */}
        <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--win-border)', borderRadius: '6px', overflow: 'hidden', background: 'var(--win-bg-card)' }}>
          <div style={{ padding: '6px 10px', background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)', fontSize: '11px', fontWeight: 600, color: 'var(--win-accent)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Database size={12} />
            <span>Nguồn (A): {selectedTableObj.name}</span>
          </div>
          <pre style={{ flex: 1, margin: 0, padding: '10px', overflow: 'auto', ...mono, color: 'var(--win-text-primary)', lineHeight: '1.5', fontSize: '11px' }}>
            {sourceDdl}
          </pre>
        </div>

        {/* Target DDL Box */}
        <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--win-border)', borderRadius: '6px', overflow: 'hidden', background: 'var(--win-bg-card)' }}>
          <div style={{ padding: '6px 10px', background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)', fontSize: '11px', fontWeight: 600, color: 'var(--win-accent-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Database size={12} />
            <span>Đích (B): {selectedTableObj.name}</span>
          </div>
          <pre style={{ flex: 1, margin: 0, padding: '10px', overflow: 'auto', ...mono, color: 'var(--win-text-primary)', lineHeight: '1.5', fontSize: '11px' }}>
            {targetDdl}
          </pre>
        </div>
      </div>
    );
  }, [selectedTableObj, t]);

  const sqlPane = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
        <span style={{ ...label, fontSize: '12px' }}>{t('compare.syncSqlTitle')}</span>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button className="btn btn-secondary" onClick={copySql} disabled={!sqlText} style={{ padding: '4px 10px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Copy size={12} /> {t('compare.copySql')}
          </button>
          <button className="btn btn-secondary" onClick={downloadSql} disabled={!sqlText} style={{ padding: '4px 10px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Download size={12} /> {t('compare.downloadSql')}
          </button>
          {onOpenInSqlEditor && (
            <button
              className="btn btn-primary"
              onClick={() => {
                onOpenInSqlEditor(sqlText);
                onClose();
              }}
              disabled={!sqlText || !hasRunnableSql(currentSql || [])}
              title={t('compare.openInEditorTitle')}
              style={{ padding: '4px 12px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
            >
              <FileCode size={12} /> {t('compare.openInEditor')}
            </button>
          )}
        </div>
      </div>
      <textarea
        readOnly
        value={sqlText || t('compare.sqlEmpty')}
        style={{
          flex: 1,
          minHeight: '140px',
          width: '100%',
          background: 'var(--win-bg-card)',
          border: '1px solid var(--win-border)',
          color: 'var(--win-text-primary)',
          fontFamily: 'var(--win-font-mono)',
          fontSize: '11.5px',
          lineHeight: '1.5',
          padding: '10px',
          borderRadius: '6px',
          resize: 'none',
          outline: 'none',
        }}
      />
    </div>
  );

  // ---- Navicat / dbForge Style Tree Grid Section ----
  const renderTreeGroup = (
    grpKey: 'different' | 'onlySource' | 'onlyTarget' | 'identical',
    grpTitle: string,
    grpIcon: React.ReactNode,
    grpTables: TableDiff[],
  ) => {
    if (grpTables.length === 0) return null;
    const isExpanded = expandedGroups[grpKey] ?? true;
    const allChecked = grpTables.every((tbl) => checkedTables.has(tbl.name));
    const someChecked = grpTables.some((tbl) => checkedTables.has(tbl.name));

    return (
      <div key={grpKey} style={{ display: 'flex', flexDirection: 'column' }}>
        {/* Section Header Row */}
        <div
          onClick={() => toggleGroupExpand(grpKey)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 10px',
            background: 'var(--win-bg-card)',
            borderBottom: '1px solid var(--win-border)',
            cursor: 'pointer',
            fontSize: '11.5px',
            fontWeight: 600,
            userSelect: 'none',
          }}
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}

          {/* Group Checkbox */}
          <span onClick={(e) => toggleAllCheckedInGroup(grpTables, e)} style={{ display: 'flex', alignItems: 'center', color: 'var(--win-accent)' }}>
            {allChecked ? <CheckSquare size={14} /> : someChecked ? <MinusSquare size={14} /> : <Square size={14} style={{ color: 'var(--win-text-disabled)' }} />}
          </span>

          <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1 }}>
            {grpIcon}
            <span>{grpTitle}</span>
            <span style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)', fontWeight: 400 }}>
              ({grpTables.filter((tbl) => checkedTables.has(tbl.name)).length} of {grpTables.length} selected)
            </span>
          </span>
        </div>

        {/* Group Child Table Rows */}
        {isExpanded &&
          grpTables.map((tb) => {
            const isSel = selectedTable === tb.name;
            const isTbExpanded = expandedTables[tb.name] ?? false;
            const isChecked = checkedTables.has(tb.name);

            const nonIdenticalCols = tb.columns.filter((c) => c.status !== 'identical');
            const nonIdenticalIdxs = tb.indexes.filter((i) => i.status !== 'identical');
            const nonIdenticalFks = tb.foreignKeys.filter((f) => f.status !== 'identical');
            const hasChildren = nonIdenticalCols.length > 0 || nonIdenticalIdxs.length > 0 || nonIdenticalFks.length > 0;

            return (
              <React.Fragment key={tb.name}>
                {/* Table Row */}
                <div
                  onClick={() => {
                    setSelectedTable(tb.name);
                    setShowBottomPane(true);
                  }}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '24px 24px 28px 1fr 50px 1fr',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '5px 12px',
                    borderBottom: '1px solid var(--win-border)',
                    background: isSel ? 'var(--win-bg-active)' : 'transparent',
                    cursor: 'pointer',
                    fontSize: '11.5px',
                    transition: 'background 0.1s ease',
                  }}
                >
                  {/* Expand Chevron for child columns */}
                  <span onClick={(e) => hasChildren && toggleTableExpand(tb.name, e)} style={{ opacity: hasChildren ? 1 : 0.2 }}>
                    {isTbExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </span>

                  {/* Table Checkbox */}
                  <span onClick={(e) => toggleTableChecked(tb.name, e)} style={{ color: isChecked ? 'var(--win-accent)' : 'var(--win-text-disabled)' }}>
                    {isChecked ? <CheckSquare size={13} /> : <Square size={13} />}
                  </span>

                  {/* Table / View Icon (Column 3 - 28px) */}
                  <span style={{ color: tb.kind === 'view' ? '#8b5cf6' : 'var(--win-accent)', display: 'flex', alignItems: 'center' }}>
                    {tb.kind === 'view' ? <Eye size={14} /> : <TableIcon size={14} />}
                  </span>

                  {/* Source Object Name + VIEW Badge (Column 4 - 1fr) */}
                  <span style={{ fontWeight: 500, color: 'var(--win-text-primary)', wordBreak: 'break-all', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span>{tb.status === 'onlyTarget' ? '—' : tb.name}</span>
                    {tb.kind === 'view' && (
                      <span style={{ fontSize: '9px', background: 'rgba(139, 92, 246, 0.15)', color: '#8b5cf6', padding: '1px 5px', borderRadius: '3px', fontWeight: 600, border: '1px solid rgba(139, 92, 246, 0.3)', flexShrink: 0 }}>
                        VIEW
                      </span>
                    )}
                  </span>

                  {/* Operation Icon (Navicat style) */}
                  <span style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                    {tb.status === 'onlySource' && <span title="Create Table"><Plus size={14} style={{ color: 'var(--st-ok)' }} /></span>}
                    {tb.status === 'onlyTarget' && <span title="Drop Table"><X size={14} style={{ color: 'var(--st-danger)' }} /></span>}
                    {tb.status === 'different' && <span title="Modify Table"><ArrowRight size={14} style={{ color: 'var(--st-warn)' }} /></span>}
                    {tb.status === 'identical' && <span style={{ color: 'var(--win-text-disabled)', fontSize: '12px' }}>=</span>}
                  </span>

                  {/* Target Object Name + VIEW Badge (Column 6 - 1fr) */}
                  <span style={{ color: tb.status === 'onlySource' ? 'var(--win-text-disabled)' : 'var(--win-text-primary)', wordBreak: 'break-all', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span>{tb.status === 'onlySource' ? '—' : tb.name}</span>
                    {tb.kind === 'view' && (
                      <span style={{ fontSize: '9px', background: 'rgba(139, 92, 246, 0.15)', color: '#8b5cf6', padding: '1px 5px', borderRadius: '3px', fontWeight: 600, border: '1px solid rgba(139, 92, 246, 0.3)', flexShrink: 0 }}>
                        VIEW
                      </span>
                    )}
                  </span>
                </div>

                {/* Nested Child Columns / Indexes Rows (Navicat style) */}
                {isTbExpanded && (
                  <>
                    {nonIdenticalCols.map((c) => (
                      <div
                        key={c.name}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '24px 24px 28px 1fr 50px 1fr',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '4px 12px 4px 44px',
                          borderBottom: '1px solid var(--win-border)',
                          background: 'var(--win-bg-subtle)',
                          fontSize: '10.5px',
                          color: 'var(--win-text-secondary)',
                        }}
                      >
                        <span />
                        <span style={{ color: 'var(--win-text-disabled)' }}>
                          <Square size={12} />
                        </span>
                        <Columns3 size={12} style={{ color: 'var(--win-text-disabled)' }} />
                        <span style={{ ...mono }}>{c.source ? `${c.name} (${c.source.type})` : '—'}</span>
                        <span style={{ display: 'flex', justifyContent: 'center' }}>
                          {c.status === 'onlySource' ? (
                            <Plus size={12} style={{ color: 'var(--st-ok)' }} />
                          ) : c.status === 'onlyTarget' ? (
                            <X size={12} style={{ color: 'var(--st-danger)' }} />
                          ) : (
                            <span style={{ color: 'var(--st-warn)' }}>~</span>
                          )}
                        </span>
                        <span style={{ ...mono }}>{c.target ? `${c.name} (${c.target.type})` : '—'}</span>
                      </div>
                    ))}

                    {nonIdenticalIdxs.map((idx) => (
                      <div
                        key={idx.name}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '24px 24px 28px 1fr 50px 1fr',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '4px 12px 4px 44px',
                          borderBottom: '1px solid var(--win-border)',
                          background: 'var(--win-bg-subtle)',
                          fontSize: '10.5px',
                          color: 'var(--win-text-secondary)',
                        }}
                      >
                        <span />
                        <span style={{ color: 'var(--win-text-disabled)' }}>
                          <Square size={12} />
                        </span>
                        <Hash size={12} style={{ color: 'var(--win-text-disabled)' }} />
                        <span style={{ ...mono }}>{idx.source ? `${idx.name}` : '—'}</span>
                        <span style={{ display: 'flex', justifyContent: 'center' }}>
                          {idx.status === 'onlySource' ? <Plus size={12} style={{ color: 'var(--st-ok)' }} /> : <X size={12} style={{ color: 'var(--st-danger)' }} />}
                        </span>
                        <span style={{ ...mono }}>{idx.target ? `${idx.name}` : '—'}</span>
                      </div>
                    ))}
                  </>
                )}
              </React.Fragment>
            );
          })}
      </div>
    );
  };

  // ---- Tab CẤU TRÚC ----
  const structurePane = (
    <>
      {schemaResult && schemaResult.identical && (
        <div style={{ fontSize: '12px', color: 'var(--st-ok)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <CheckCircle2 size={14} /> {t('compare.identicalSchema')}
        </div>
      )}

      {!schemaResult && !busy && (
        <div className="db-compare-empty">
          <div className="db-compare-empty-icon">
            <ArrowLeftRight size={24} />
          </div>
          <span className="db-compare-empty-title">
            {t('compare.emptyTitleStructure', 'So sánh cấu trúc 2 Database')}
          </span>
          <span className="db-compare-empty-desc">
            {t('compare.emptyHintStructure')}
          </span>
        </div>
      )}

      {schemaResult && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '10px', minHeight: 0 }}>
          {/* Search & Filter Bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ position: 'relative', width: '260px' }}>
              <input
                type="text"
                style={{ ...input, paddingRight: '26px' }}
                placeholder={t('compare.searchTables')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Search size={12} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', color: 'var(--win-text-secondary)', pointerEvents: 'none' }} />
            </div>

            <div style={{ display: 'flex', gap: '4px' }}>
              <button
                type="button"
                onClick={() => setStatusFilter(new Set())}
                className={`btn ${statusFilter.size === 0 ? 'btn-primary' : 'btn-secondary'}`}
                style={{ padding: '3px 9px', fontSize: '10.5px' }}
              >
                Tất cả ({schemaResult.tables.length})
              </button>
              {(['different', 'onlySource', 'onlyTarget', 'identical'] as DiffStatus[]).map((s) => {
                const count = schemaResult.tables.filter((tbl) => tbl.status === s).length;
                if (count === 0 && !statusFilter.has(s)) return null;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleStatus(s)}
                    className={`btn ${statusFilter.has(s) ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ padding: '3px 9px', fontSize: '10.5px' }}
                  >
                    {t(statusLabelKey(s) as never)} ({count})
                  </button>
                );
              })}
            </div>
          </div>

          {/* Navicat / dbForge Style Top Object Tree Grid Panel */}
          <div style={{ flex: showBottomPane ? 1 : 2, minHeight: '220px', border: '1px solid var(--win-border)', borderRadius: '6px', overflowY: 'auto', background: 'var(--win-bg-card)', transition: 'all 0.2s ease' }}>
            {/* Header Columns */}
            <div style={{ display: 'grid', gridTemplateColumns: '24px 24px 28px 1fr 50px 1fr', gap: '6px', padding: '6px 12px', borderBottom: '1px solid var(--win-border)', background: 'var(--win-bg-popover)', ...label, position: 'sticky', top: 0, zIndex: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <span />
              <span />
              <span />
              <span>Source Object (Nguồn A)</span>
              <span style={{ textAlign: 'center' }}>Op</span>
              <span>Target Object (Đích B)</span>
            </div>

            {renderTreeGroup('different', 'Objects to be modified', <ArrowRight size={14} style={{ color: 'var(--st-warn)' }} />, groupedTables.different)}
            {renderTreeGroup('onlySource', 'Objects to be created (Only in Source)', <Plus size={14} style={{ color: 'var(--st-ok)' }} />, groupedTables.onlySource)}
            {renderTreeGroup('onlyTarget', 'Objects to be deleted (Only in Target)', <X size={14} style={{ color: 'var(--st-danger)' }} />, groupedTables.onlyTarget)}
            {renderTreeGroup('identical', 'Identical objects', <CheckCircle2 size={14} style={{ color: 'var(--win-text-disabled)' }} />, groupedTables.identical)}
          </div>

          {/* Bottom Pane: DDL Comparison / Deployment Script Tabs (Collapsible) */}
          <div style={{ flex: showBottomPane ? 1 : '0 0 auto', display: 'flex', flexDirection: 'column', gap: '6px', minHeight: showBottomPane ? '200px' : 'auto' }}>
            <div style={{ display: 'flex', gap: '6px', borderBottom: showBottomPane ? '1px solid var(--win-border)' : 'none', paddingBottom: showBottomPane ? '6px' : '0', alignItems: 'center' }}>
              <button className={`btn ${bottomTab === 'ddl' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setBottomTab('ddl'); setShowBottomPane(true); }} style={{ padding: '3px 12px', fontSize: '11px' }}>
                So sánh DDL (DDL Comparison)
              </button>
              <button className={`btn ${bottomTab === 'sql' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setBottomTab('sql'); setShowBottomPane(true); }} style={{ padding: '3px 12px', fontSize: '11px' }}>
                Script SQL đồng bộ (Deployment Script)
              </button>

              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowBottomPane(!showBottomPane)}
                style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
                title={showBottomPane ? 'Thu gọn phần chi tiết' : 'Mở rộng phần chi tiết'}
              >
                {showBottomPane ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
                <span>{showBottomPane ? 'Ẩn chi tiết' : 'Hiện chi tiết DDL'}</span>
              </button>
            </div>

            {showBottomPane && (bottomTab === 'ddl' ? ddlPane : sqlPane)}
          </div>
        </div>
      )}
    </>
  );

  // ---- Tab DỮ LIỆU ----
  const dataPane = (
    <>
      {!overview && !busy && !dataResult && (
        <div className="db-compare-empty">
          <div className="db-compare-empty-icon">
            <TableIcon size={24} />
          </div>
          <span className="db-compare-empty-title">
            {t('compare.emptyTitleData', 'So sánh dữ liệu các bảng (Data Diff)')}
          </span>
          <span className="db-compare-empty-desc">
            {t('compare.emptyHintData')}
          </span>
        </div>
      )}

      {overview && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '10px', minHeight: 0 }}>
          {/* Search & Overview Header Bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ position: 'relative', width: '260px' }}>
              <input
                type="text"
                style={{ ...input, paddingRight: '26px' }}
                placeholder={t('compare.searchTables')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Search size={12} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', color: 'var(--win-text-secondary)', pointerEvents: 'none' }} />
            </div>

            <div style={{ marginLeft: 'auto', ...label, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>{t('compare.overviewHeader', { n: overview.tables.length })}</span>
              <Badge tone="warn">{t('compare.overviewDiffTables', { n: overview.tablesWithDifference })}</Badge>
            </div>
          </div>

          {/* Top Panel: Tree Grid of Data Overview (Identical Layout to Structure Compare) */}
          <div style={{ flex: showBottomPane ? 1 : 2, minHeight: '200px', border: '1px solid var(--win-border)', borderRadius: '6px', overflowY: 'auto', background: 'var(--win-bg-card)', transition: 'all 0.2s ease' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '24px 24px 28px 1fr 50px 1fr 100px', gap: '6px', padding: '6px 12px', borderBottom: '1px solid var(--win-border)', background: 'var(--win-bg-popover)', ...label, position: 'sticky', top: 0, zIndex: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <span />
              <span onClick={toggleAllDataTablesChecked} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                {overview.tables.length > 0 && overview.tables.every((tbl) => checkedDataTables.has(tbl.name)) ? (
                  <CheckSquare size={13} style={{ color: 'var(--win-accent)' }} />
                ) : overview.tables.some((tbl) => checkedDataTables.has(tbl.name)) ? (
                  <MinusSquare size={13} style={{ color: 'var(--win-accent)' }} />
                ) : (
                  <Square size={13} style={{ color: 'var(--win-text-disabled)' }} />
                )}
              </span>
              <span />
              <span>Source Table & Rows (Nguồn A)</span>
              <span style={{ textAlign: 'center' }}>Op</span>
              <span>Target Table & Rows (Đích B)</span>
              <span style={{ textAlign: 'right' }}>Hành động</span>
            </div>

            {overview.tables
              .filter((row) => !search || row.name.toLowerCase().includes(search.toLowerCase()))
              .map((row) => {
                const bg =
                  row.status === 'onlySource'
                    ? 'var(--win-status-added)'
                    : row.status === 'onlyTarget'
                      ? 'var(--win-status-deleted)'
                      : row.status === 'differentCount'
                        ? 'var(--win-status-modified)'
                        : 'transparent';
                const borderLeft =
                  row.status === 'onlySource'
                    ? '3px solid var(--win-status-added-border)'
                    : row.status === 'onlyTarget'
                      ? '3px solid var(--win-status-deleted-border)'
                      : row.status === 'differentCount'
                        ? '3px solid var(--win-status-modified-border)'
                        : '3px solid transparent';

                const isSelectedData = dataTable === row.name;

                return (
                  <div
                    key={row.name}
                    onClick={() => {
                      setShowBottomPane(true);
                      openTableData(row.name, row.primaryKey || []);
                    }}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '24px 24px 28px 1fr 50px 1fr 100px',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '5px 12px',
                      borderBottom: '1px solid var(--win-border)',
                      background: isSelectedData ? 'var(--win-bg-active)' : bg,
                      borderLeft: borderLeft,
                      cursor: 'pointer',
                      fontSize: '11.5px',
                      transition: 'background 0.1s ease',
                    }}
                  >
                    <span />
                    <span onClick={(e) => toggleDataTableChecked(row.name, e)} style={{ cursor: 'pointer', color: checkedDataTables.has(row.name) ? 'var(--win-accent)' : 'var(--win-text-disabled)', display: 'flex', alignItems: 'center' }}>
                      {checkedDataTables.has(row.name) ? <CheckSquare size={13} /> : <Square size={13} />}
                    </span>
                    <span style={{ color: 'var(--win-accent)', display: 'flex', alignItems: 'center' }}>
                      <TableIcon size={14} />
                    </span>

                    {/* Source Name + Rows */}
                    <span style={{ fontWeight: 600, color: 'var(--win-text-primary)', wordBreak: 'break-all', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span>{row.status === 'onlyTarget' ? '—' : row.name}</span>
                      {row.sourceRows !== null && (
                        <span style={{ ...mono, fontSize: '10.5px', color: 'var(--win-text-secondary)', fontWeight: 400 }}>
                          ({num(row.sourceRows)} dòng)
                        </span>
                      )}
                    </span>

                    {/* Operation Icon */}
                    <span style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                      {row.status === 'onlySource' && <span title="Only in Source"><Plus size={14} style={{ color: 'var(--st-ok)' }} /></span>}
                      {row.status === 'onlyTarget' && <span title="Only in Target"><X size={14} style={{ color: 'var(--st-danger)' }} /></span>}
                      {row.status === 'differentCount' && <span title="Different Count"><ArrowRight size={14} style={{ color: 'var(--st-warn)' }} /></span>}
                      {row.status === 'sameCount' && <span style={{ color: 'var(--win-text-disabled)', fontSize: '12px' }}>=</span>}
                    </span>

                    {/* Target Name + Rows */}
                    <span style={{ fontWeight: 600, color: row.status === 'onlySource' ? 'var(--win-text-disabled)' : 'var(--win-text-primary)', wordBreak: 'break-all', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span>{row.status === 'onlySource' ? '—' : row.name}</span>
                      {row.targetRows !== null && (
                        <span style={{ ...mono, fontSize: '10.5px', color: 'var(--win-text-secondary)', fontWeight: 400 }}>
                          ({num(row.targetRows)} dòng)
                        </span>
                      )}
                    </span>

                    {/* Action Button */}
                    <span style={{ textAlign: 'right' }}>
                      <button
                        className={`btn ${isSelectedData ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ padding: '2px 8px', height: '22px', fontSize: '10px' }}
                        title={row.comparable ? undefined : t('compare.noKeyHint')}
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowBottomPane(true);
                          openTableData(row.name, row.primaryKey || []);
                        }}
                      >
                        {t('compare.compareThisTable')}
                      </button>
                    </span>
                  </div>
                );
              })}
          </div>

          {/* Bottom Panel: Detailed Data Diff / Data Sync SQL (Collapsible) */}
          <div style={{ flex: showBottomPane ? 1 : '0 0 auto', display: 'flex', flexDirection: 'column', gap: '6px', minHeight: showBottomPane ? '200px' : 'auto' }}>
            <div style={{ display: 'flex', gap: '6px', borderBottom: showBottomPane ? '1px solid var(--win-border)' : 'none', paddingBottom: showBottomPane ? '6px' : '0', alignItems: 'center' }}>
              <span style={{ ...label, fontSize: '11.5px', marginRight: '6px' }}>
                Chi tiết dữ liệu so sánh: {dataTable ? <strong style={{ color: 'var(--win-accent)' }}>{dataTable}</strong> : '(Chọn một bảng phía trên)'}
              </span>
              {dataResult && (
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button className={`btn ${dataTab === 'rows' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setDataTab('rows'); setShowBottomPane(true); }} style={{ padding: '3px 10px', fontSize: '11px' }}>
                    {t('compare.tabRows')}
                  </button>
                  <button className={`btn ${dataTab === 'sql' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setDataTab('sql'); setShowBottomPane(true); }} style={{ padding: '3px 10px', fontSize: '11px' }}>
                    {t('compare.tabSyncSql')}
                  </button>
                </div>
              )}

              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowBottomPane(!showBottomPane)}
                style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
                title={showBottomPane ? 'Thu gọn phần chi tiết' : 'Mở rộng phần chi tiết'}
              >
                {showBottomPane ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
                <span>{showBottomPane ? 'Ẩn chi tiết' : 'Hiện chi tiết Dữ liệu'}</span>
              </button>
            </div>

            {showBottomPane && !dataTable && (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--win-text-disabled)', fontSize: '12px' }}>
                {t('compare.pickTable', { defaultValue: 'Bấm "So sánh" ở bất kỳ bảng nào trên danh sách để xem dữ liệu chênh lệch chi tiết' })}
              </div>
            )}

            {showBottomPane && dataTable && dataResult && dataTab === 'sql' && sqlPane}

            {showBottomPane && dataTable && dataResult && dataTab === 'rows' && (
              <div style={{ flex: 1, overflow: 'auto', border: '1px solid var(--win-border)', borderRadius: '6px', background: 'var(--win-bg-card)' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>{t('compare.colStatus')}</th>
                      <th style={thStyle}>{t('compare.colKey')}</th>
                      <th style={thStyle}>{t('compare.colSide')}</th>
                      {dataResult.columns.map((c) => (
                        <th key={c} style={thStyle}>
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dataResult.rows.map((row, ri) => {
                      const cells = (which: 'source' | 'target') => {
                        const data = which === 'source' ? row.source : row.target;
                        return (
                          <tr key={`${ri}-${which}`}>
                            {which === 'source' && (
                              <>
                                <td style={tdStyle} rowSpan={row.status === 'different' ? 2 : 1}>
                                  <Badge tone={statusTone(row.status)}>{t(statusLabelKey(row.status) as never)}</Badge>
                                </td>
                                <td style={{ ...tdStyle, ...mono }} rowSpan={row.status === 'different' ? 2 : 1}>
                                  {row.key.map((k) => formatCell(k)).join(' / ')}
                                </td>
                              </>
                            )}
                            <td style={{ ...tdStyle, fontWeight: 600 }}>
                              {which === 'source' ? t('compare.sideA') : t('compare.sideB')}
                            </td>
                            {dataResult.columns.map((c) => (
                              <td
                                key={c}
                                style={{
                                  ...tdStyle,
                                  ...mono,
                                  background: row.changedColumns.includes(c) ? 'var(--win-status-modified)' : undefined,
                                  color: data ? 'var(--win-text-primary)' : 'var(--win-text-disabled)',
                                }}
                              >
                                {data ? formatCell(data[c]) : '—'}
                              </td>
                            ))}
                          </tr>
                        );
                      };
                      if (row.status === 'onlySource') return cells('source');
                      if (row.status === 'onlyTarget') return cells('target');
                      return (
                        <React.Fragment key={ri}>
                          {cells('source')}
                          {cells('target')}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );

  const content = (
    <>
      {/* Unified Pipeline Control Card (DataGrip/Navicat Style) */}
      <div className="db-compare-unified-card">
        {/* Top: Pipeline Direction Row */}
        <div className="db-compare-pipeline-row">
          {sideCard('source')}

          <div className="db-compare-pipeline-bridge">
            <button
              type="button"
              className="db-compare-swap-circle-btn"
              onClick={swap}
              title={t('compare.swapSides')}
            >
              <ArrowLeftRight size={15} />
            </button>
            <span className="db-compare-bridge-label">A ➔ B</span>
          </div>

          {sideCard('target')}
        </div>

        {/* Bottom: Integrated Actions Toolbar Strip */}
        <div className="db-compare-actions-strip">
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              type="button"
              className={`btn ${mode === 'structure' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setMode('structure')}
              style={{ padding: '4px 12px', fontSize: '11px', height: '28px' }}
            >
              {t('compare.tabStructure')}
            </button>
            <button
              type="button"
              className={`btn ${mode === 'data' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setMode('data')}
              style={{ padding: '4px 12px', fontSize: '11px', height: '28px' }}
            >
              {t('compare.tabData')}
            </button>
          </div>

          <label className="db-compare-check-item">
            <input type="checkbox" checked={includeDrops} onChange={(e) => setIncludeDrops(e.target.checked)} />
            <span>{t('compare.includeDrops')}</span>
          </label>

          {mode === 'structure' && schemaResult && (
            <DiffProgressBar summary={schemaResult.summary} />
          )}

          <button
            type="button"
            className="btn btn-primary"
            disabled={!!busy || !sideReady}
            onClick={() => (mode === 'structure' ? runSchemaCompare() : runOverview())}
            title={sideReady ? undefined : t('compare.pickSidesFirst')}
            style={{ marginLeft: 'auto', padding: '5px 16px', fontSize: '11.5px', height: '28px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            {busy ? <Loader size={13} className="loading-spinner" /> : <Play size={13} fill="currentColor" />}
            <span>{mode === 'structure' ? t('compare.runStructure') : t('compare.runOverview')}</span>
          </button>
        </div>
      </div>

      {busy && (
        <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', display: 'flex', alignItems: 'center', gap: '6px', padding: '0 4px' }}>
          <Loader size={12} className="loading-spinner" />
          {busy}
        </div>
      )}
      {notice && !busy && <div style={{ fontSize: '11px', color: 'var(--st-ok)', padding: '0 4px' }}>{notice}</div>}
      {error && (
        <div style={{ fontSize: '11px', color: 'var(--st-danger)', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '6px', padding: '8px 12px' }}>
          {error}
        </div>
      )}

      {mode === 'structure' ? structurePane : dataPane}
    </>
  );

  if (asTab) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', width: '100%', padding: '16px 20px', gap: '12px', overflowY: 'auto', boxSizing: 'border-box', background: 'var(--win-bg-window)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          <ArrowLeftRight size={16} style={{ color: 'var(--win-accent)' }} />
          <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
            {t('compare.title')}
          </span>
          {currentDb && (
            <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: 'var(--win-bg-hover)', border: '1px solid var(--win-border)', color: 'var(--win-text-secondary)' }}>
              {currentDb}
            </span>
          )}
        </div>
        {content}
      </div>
    );
  }

  return (
    <Modal
      title={t('compare.title')}
      icon={<ArrowLeftRight size={15} style={{ color: 'var(--win-accent)', flexShrink: 0 }} />}
      onClose={onClose}
      width="1240px"
      maxWidth="96vw"
      height="90vh"
      zIndex={10000}
    >
      <ModalBody style={{ padding: '14px 18px', gap: '12px', flex: 1 }}>
        {content}
      </ModalBody>
    </Modal>
  );
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  fontSize: '10.5px',
  fontWeight: 600,
  color: 'var(--win-text-secondary)',
  padding: '6px 10px',
  borderBottom: '1px solid var(--win-border)',
  borderRight: '1px solid var(--win-border)',
  position: 'sticky',
  top: 0,
  background: 'var(--win-bg-card)',
  whiteSpace: 'nowrap',
  zIndex: 1,
};

const tdStyle: React.CSSProperties = {
  fontSize: '11px',
  padding: '4px 10px',
  borderBottom: '1px solid var(--win-border)',
  borderRight: '1px solid var(--win-border)',
  maxWidth: '240px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  verticalAlign: 'top',
};
