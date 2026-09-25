import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Check,
  Columns3,
  Database,
  Dice5,
  Eye,
  Layers,
  Loader,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Table2,
  Wand2,
  X,
} from 'lucide-react';
import { dbHelper } from '../utils/dbHelper';
import {
  GENERATOR_GROUPS,
  estimateRemainingMs,
  formatCount,
  formatDuration,
  formatListInput,
  generatorLabelKey,
  hasBlockingIssue,
  isTextGenerator,
  optionChoiceLabelKey,
  optionFields,
  parseListInput,
  tableSpecFromTarget,
  totalRowsOf,
  validateSpec,
  type GenColumnSpec,
  type GenColumnTarget,
  type GenPreview,
  type GenProgress,
  type GenResult,
  type GenSpec,
  type GenTableSpec,
  type GenTableTarget,
  type GenTargets,
  type OptionField,
} from '../utils/dataGenHelper';
import { Modal, ModalBody } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { ProgressBar } from './ProgressBar';
import { cancelJob, startJob } from '../utils/jobs';
import { withJobConnection } from '../utils/jobConnection';
import { approveJob, connKeyOfConn, type JobApproval } from '../utils/safeMode';

interface DataGeneratorDialogProps {
  /** The target connection. Explicit, because a generation run happens as a background job — see dbHelper.generateData. */
  connId: string;
  /** Server + database the data will be written to — shown in the footer, since this writes. */
  dbName?: string;
  /** Preselect one table (opened from the table context menu). */
  initialTable?: string | null;
  onClose: () => void;
  asTab?: boolean;
}

/** Seed used on open. Random only in the sense of "pick one" — generation itself stays exact. */
const rollSeed = () => {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % 2_000_000_000;
  }
  return Date.now() % 2_000_000_000;
};

const Badge: React.FC<{ children: React.ReactNode; title?: string; variant?: 'pk' | 'fk' | 'ai' | 'nn' }> = ({
  children,
  title,
  variant,
}) => (
  <span className={`dgen-badge${variant ? ` dgen-badge-${variant}` : ''}`} title={title}>
    {children}
  </span>
);

/** One labelled control. */
const Field: React.FC<{ text: string; children: React.ReactNode }> = ({ text, children }) => (
  <div className="dgen-field">
    <span className="dgen-label">{text}</span>
    {children}
  </div>
);

export const DataGeneratorDialog: React.FC<DataGeneratorDialogProps> = ({
  connId,
  dbName,
  initialTable,
  onClose,
  asTab = false,
}) => {
  const { t, i18n } = useTranslation();

  const [targets, setTargets] = useState<GenTargets | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  /**
   * The seed is not a headline setting — it only matters when someone wants the exact same data
   * again — so it lives as a chip next to the preview instead of taking a slot in the top bar.
   */
  const [seed, setSeed] = useState(rollSeed);
  const [defaultRows, setDefaultRows] = useState(1000);
  const [disableConstraints, setDisableConstraints] = useState(true);

  /** Per-table spec, only for the tables the user ticked. */
  const [specs, setSpecs] = useState<Record<string, GenTableSpec>>({});
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [activeColumn, setActiveColumn] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'columns' | 'preview'>('columns');
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [preview, setPreview] = useState<GenPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  /** Bumped by the refresh button. Re-rolling the same seed would be a no-op re-render. */
  const [previewNonce, setPreviewNonce] = useState(0);

  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<GenProgress | null>(null);
  const [result, setResult] = useState<GenResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const startedAtRef = useRef(0);
  /** The current run's job — the footer's Cancel button aims at it. */
  const jobIdRef = useRef<string | null>(null);

  // ---- load targets ----
  useEffect(() => {
    let alive = true;
    dbHelper
      .getGenerationTargets()
      .then((res) => {
        if (!alive) return;
        setTargets(res);
        const preselect = initialTable && res.tables.some((x) => x.table === initialTable) ? initialTable : null;
        const target = preselect ? res.tables.find((x) => x.table === preselect) : undefined;
        if (target) {
          setSpecs({ [target.table]: tableSpecFromTarget(target, 1000) });
          setActiveTable(target.table);
        }
      })
      .catch((err) => {
        if (alive) setLoadError(String(err));
      });
    return () => {
      alive = false;
    };
  }, [initialTable]);

  const tableTargets = useMemo(() => targets?.tables ?? [], [targets]);
  const activeTarget: GenTableTarget | undefined = tableTargets.find((x) => x.table === activeTable);
  const activeSpec: GenTableSpec | undefined = activeTable ? specs[activeTable] : undefined;
  const activeColSpec: GenColumnSpec | undefined = activeSpec?.columns.find((c) => c.column === activeColumn);
  const activeColTarget: GenColumnTarget | undefined = activeTarget?.columns.find((c) => c.name === activeColumn);

  const spec: GenSpec = useMemo(
    () => ({
      seed,
      // Keep the backend's FK-safe order; it also decides which parent is generated first.
      tables: (targets?.order ?? []).map((name) => specs[name]).filter(Boolean) as GenTableSpec[],
      options: { disableConstraints },
    }),
    [seed, specs, targets?.order, disableConstraints],
  );

  const issues = useMemo(() => validateSpec(spec), [spec]);
  const activeTableIssues = useMemo(
    () => issues.filter((i) => i.table === activeTable),
    [issues, activeTable],
  );
  const blocked = hasBlockingIssue(issues);
  const totalRows = totalRowsOf(spec);

  const filteredTables = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return tableTargets;
    return tableTargets.filter((x) => x.table.toLowerCase().includes(needle));
  }, [tableTargets, search]);

  // ---- table selection ----
  const toggleTable = (target: GenTableTarget) => {
    setSpecs((prev) => {
      const next = { ...prev };
      if (next[target.table]) delete next[target.table];
      else next[target.table] = tableSpecFromTarget(target, defaultRows);
      return next;
    });
    setActiveTable(target.table);
    setActiveColumn(null);
  };

  const selectAll = () => {
    setSpecs(() => {
      const next: Record<string, GenTableSpec> = {};
      for (const target of filteredTables) next[target.table] = tableSpecFromTarget(target, defaultRows);
      return next;
    });
  };

  const clearAll = () => {
    setSpecs({});
    setActiveTable(null);
    setActiveColumn(null);
  };

  const applyRowsToAll = () => {
    setSpecs((prev) => {
      const next: Record<string, GenTableSpec> = {};
      for (const [name, table] of Object.entries(prev)) next[name] = { ...table, rows: defaultRows };
      return next;
    });
  };

  const patchTable = (table: string, patch: Partial<GenTableSpec>) => {
    setSpecs((prev) => (prev[table] ? { ...prev, [table]: { ...prev[table], ...patch } } : prev));
  };

  const patchColumn = (table: string, column: string, patch: Partial<GenColumnSpec>) => {
    setSpecs((prev) => {
      const current = prev[table];
      if (!current) return prev;
      return {
        ...prev,
        [table]: {
          ...current,
          columns: current.columns.map((c) => (c.column === column ? { ...c, ...patch } : c)),
        },
      };
    });
  };

  const patchOption = (table: string, column: string, key: string, value: unknown) => {
    setSpecs((prev) => {
      const current = prev[table];
      if (!current) return prev;
      return {
        ...prev,
        [table]: {
          ...current,
          columns: current.columns.map((c) => {
            if (c.column !== column) return c;
            const options = { ...c.options };
            if (value === '' || value === undefined) delete options[key];
            else options[key] = value;
            return { ...c, options };
          }),
        },
      };
    });
  };

  // ---- preview (debounced, backend-driven so it matches the real run) ----
  // The WHOLE spec is sent, not just the previewed table: a foreign key column needs the parent's
  // spec to show the keys the parent is about to get (see `estimate_fk_pool` in data_generator.rs).
  // Sending one table made every FK preview a column of NULLs.
  const previewKey = activeTable ? `${activeTable}|${JSON.stringify(spec)}` : '';
  useEffect(() => {
    if (!activeTable || !activeSpec || running) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      setPreviewBusy(true);
      setPreviewError(null);
      dbHelper
        .previewGeneratedData(spec, activeTable, 50)
        .then((res) => {
          if (alive) setPreview(res);
        })
        .catch((err) => {
          if (!alive) return;
          setPreview(null);
          setPreviewError(String(err));
        })
        .finally(() => {
          if (alive) setPreviewBusy(false);
        });
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // previewKey folds the previewed table + the whole spec (seed and options included) into one
    // dependency, so `spec` itself is not in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, previewNonce, running]);

  // ---- run ----
  /**
   * Generation runs as a **background job** (see utils/jobs.ts): the user closes this dialog and goes
   * off to do something else, and the progress and cancel button are still there in `JobsTray`.
   *
   * The dialog keeps `progress`/`result` of its own so it displays exactly as before **while it is
   * open** — two places reading one run, not two runs. After it closes these `setState` calls become
   * no-ops, and the job is left untouched.
   */
  const run = useCallback(async () => {
    // Safe Mode asks here, while the user is looking at the dialog — never from the job, which may
    // start minutes later from the queue. Declining leaves the dialog as it was.
    let approval: JobApproval;
    try {
      approval = await approveJob('generate_data', connId, t('jobs.approveGenerate', { n: dbName ?? '' }));
    } catch {
      return;
    }
    setRunning(true);
    setRunError(null);
    setResult(null);
    setProgress(null);
    startedAtRef.current = Date.now();
    const rows = totalRows;
    // The job's own connection, once open. The cancel flag on the Rust side is keyed by `conn_id`, so
    // a cancel has to aim at the connection actually generating — which is this one, not `connId`.
    let jobConnId = '';
    jobIdRef.current = startJob({
      kind: 'generate',
      title: t('jobs.titleGenerate', { n: dbName ?? '' }),
      db: dbName ?? '',
      conn: connKeyOfConn(connId),
      write: true,
      lockKey: `${connId}|${dbName ?? ''}`,
      onCancel: () => {
        if (jobConnId) void dbHelper.cancelDataGeneration(jobConnId);
      },
      // A connection of its own: generating on the user's id meant `generate_data` refused outright
      // while they had a manual transaction open, and its session-level `SET`s landed on their
      // connection. On the job's id neither is true.
      run: (ctx) => withJobConnection(connId, [approval], async ({ connId: genConnId }) => {
        try {
          const res = await dbHelper.generateData(spec, (msg) => {
            setProgress(msg);
            ctx.report({
              label: t('dataGen.progress', {
                table: msg.table ?? '',
                done: formatCount(msg.totalDone ?? 0, i18n.language),
                total: formatCount(rows, i18n.language),
              }),
              current: msg.totalDone ?? 0,
              total: rows,
            });
          }, genConnId);
          setResult(res);
          // The row counts changed -> Sidebar/DataGrid reload, even if the dialog closed long ago.
          // The schema did not, so invalidateCatalog is deliberately NOT called.
          window.dispatchEvent(new CustomEvent('database-restored', { detail: { connId } }));
          const inserted = res.inserted ? Object.values(res.inserted).reduce((a, b) => a + b, 0) : 0;
          return {
            message: res.cancelled
              ? t('dataGen.resultCancelled', { n: formatCount(inserted, i18n.language) })
              : t('dataGen.resultDone', {
                  n: formatCount(inserted, i18n.language),
                  time: formatDuration(res.elapsedMs ?? 0, t as never),
                }),
            warning: res.warnings?.length ? res.warnings.join(' · ') : undefined,
          };
        } catch (err) {
          setRunError(String(err));
          throw err;
        } finally {
          setRunning(false);
        }
      }, (id) => { jobConnId = id; }).catch((err) => {
        // Opening the job's connection can fail before the body's own `finally` exists to reset
        // the dialog.
        setRunError(String(err));
        setRunning(false);
        throw err;
      }),
    });
  }, [spec, connId, dbName, totalRows, t, i18n.language]);

  const doneRows = progress?.totalDone ?? 0;
  const remainingMs = running ? estimateRemainingMs(doneRows, totalRows, Date.now() - startedAtRef.current) : null;
  const insertedTotal = result?.inserted ? Object.values(result.inserted).reduce((a, b) => a + b, 0) : 0;
  const selectedCount = Object.keys(specs).length;
  const truncating = Object.values(specs).some((x) => x.mode === 'truncate');

  const renderOptionField = (field: OptionField, colSpec: GenColumnSpec, table: string) => {
    const value = colSpec.options?.[field.key];
    const placeholder = field.placeholderKey ? t(field.placeholderKey as never) : undefined;
    const set = (v: unknown) => patchOption(table, colSpec.column, field.key, v);

    switch (field.kind) {
      case 'bool':
        return (
          <label key={field.key} className="dgen-check">
            <input type="checkbox" checked={value !== false} onChange={(e) => set(e.target.checked)} />
            {t(field.labelKey as never)}
          </label>
        );
      case 'select':
        return (
          <Field key={field.key} text={t(field.labelKey as never)}>
            <select value={String(value ?? field.choices?.[0] ?? '')} onChange={(e) => set(e.target.value)}>
              {(field.choices ?? []).map((choice) => (
                <option key={choice} value={choice}>
                  {t(optionChoiceLabelKey(choice) as never)}
                </option>
              ))}
            </select>
          </Field>
        );
      case 'list':
        return (
          <Field key={field.key} text={t(field.labelKey as never)}>
            <textarea
              placeholder={placeholder}
              value={formatListInput(value as unknown[] | undefined, colSpec.generator === 'weightedList')}
              onChange={(e) => set(parseListInput(e.target.value, colSpec.generator === 'weightedList'))}
            />
          </Field>
        );
      case 'number':
        return (
          <Field key={field.key} text={t(field.labelKey as never)}>
            <input
              type="number"
              value={value === undefined ? '' : String(value)}
              onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </Field>
        );
      default:
        // text / date / sql
        return (
          <Field key={field.key} text={t(field.labelKey as never)}>
            <input
              className={field.kind === 'date' ? undefined : 'dgen-mono'}
              placeholder={placeholder}
              value={String(value ?? '')}
              onChange={(e) => set(e.target.value)}
            />
          </Field>
        );
    }
  };

  const dgenContent = (
    <div className={`dgen${asTab ? ' dgen-as-tab' : ''}`}>
      {/* ---- shared controls & top action bar ---- */}
      <div className="dgen-bar">
        <div className="dgen-bar-group">
          <span className="dgen-label">{t('dataGen.rowsPerTable')}</span>
          <input
            type="number"
            min={1}
            className="dgen-input-rows"
            value={defaultRows}
            disabled={running}
            onChange={(e) => setDefaultRows(Math.max(1, Number(e.target.value) || 0))}
          />
          <button className="btn btn-secondary" disabled={running || !selectedCount} onClick={applyRowsToAll}>
            {t('dataGen.applyToAll')}
          </button>
        </div>
        <div className="dgen-bar-sep" />
        <label className="dgen-check" title={t('dataGen.disableConstraintsHint')}>
          <input
            type="checkbox"
            checked={disableConstraints}
            disabled={running}
            onChange={(e) => setDisableConstraints(e.target.checked)}
          />
          <span>{t('dataGen.disableConstraints')}</span>
          {!!targets?.warnings?.length && (
            <span
              className={disableConstraints ? 'dgen-dim' : 'dgen-cycle-warn-icon'}
              title={targets.warnings.join('\n\n')}
            >
              <AlertTriangle size={12} />
            </span>
          )}
        </label>
        {loadError && (
          <div className="dgen-error-badge" title={loadError}>
            <AlertTriangle size={12} />
            <span className="dgen-error-badge-text">{loadError}</span>
          </div>
        )}
        <div className="dgen-bar-right">
          <div className="dgen-foot-db">
            <Database size={13} /> {dbName ?? ''}
          </div>
          <div className="dgen-bar-sep" />
          <div className="dgen-dim dgen-summary">
            {t('dataGen.summary', { tables: selectedCount, rows: formatCount(totalRows, i18n.language) })}
          </div>
          {running ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => { if (jobIdRef.current) cancelJob(jobIdRef.current); }}
            >
              {t('dataGen.cancelRun')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!selectedCount || blocked}
              onClick={() => setConfirming(true)}
            >
              <Wand2 size={13} /> {t('dataGen.generate')}
            </button>
          )}
        </div>
      </div>

      {/* ---- master-detail layout: unified single block ---- */}
      <div className="dgen-block">
        {/* Left: tables sidebar */}
        <div className="dgen-block-sidebar">
          <div className="dgen-pane-title">
            <span>{t('dataGen.paneTables')}</span>
            <span className="dgen-sidebar-count">({selectedCount}/{tableTargets.length})</span>
          </div>
          <div className="dgen-pane-pad dgen-sidebar-content">
            <div className="dgen-search-box">
              <Search size={12} className="dgen-dim dgen-search-icon" />
              <input
                className="dgen-search-input"
                placeholder={t('dataGen.searchTables')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="dgen-sidebar-actions">
              <button className="btn btn-secondary dgen-flex-1" disabled={running} onClick={selectAll}>
                {t('dataGen.selectAll')}
              </button>
              <button
                className="btn btn-secondary dgen-flex-1"
                disabled={running || !selectedCount}
                onClick={clearAll}
              >
                {t('dataGen.clearAll')}
              </button>
            </div>
            <div className="dgen-table-list">
              {!targets && !loadError && (
                <div className="dgen-hint dgen-loading-hint">
                  <Loader size={12} className="spin dgen-valign-sub" /> {t('dataGen.loading')}
                </div>
              )}
              {targets && !filteredTables.length && (
                <div className="dgen-hint dgen-loading-hint">
                  {t('dataGen.noTables')}
                </div>
              )}
              {filteredTables.map((target) => {
                const picked = !!specs[target.table];
                const tableHasIssue = issues.some((i) => i.table === target.table);
                return (
                  <div
                    key={target.table}
                    className={`dgen-row${activeTable === target.table ? ' on' : ''}`}
                    onClick={() => {
                      setActiveTable(target.table);
                      setActiveColumn(null);
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={picked}
                      disabled={running}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleTable(target)}
                    />
                    <Table2 size={12} className="dgen-dim" />
                    <span className={`dgen-row-name${picked ? '' : ' dgen-dim'}`}>{target.table}</span>
                    {tableHasIssue && (
                      <AlertTriangle size={11} className="dgen-icon-warn" />
                    )}
                    {picked && (
                      <span className="dgen-dim dgen-row-badge">
                        {formatCount(specs[target.table].rows, i18n.language)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="dgen-hint dgen-sidebar-hint">
              <Layers size={11} className="dgen-valign-sub" /> {t('dataGen.insertOrderHint')}
            </div>
          </div>
        </div>

        {/* Right: workspace for active table */}
        <div className="dgen-block-workspace">
          {!activeTarget && (
            <div className="dgen-empty-state">
              <div className="dgen-empty-icon">
                <Table2 size={26} />
              </div>
              <div className="dgen-empty-title">{t('dataGen.pickTableHint')}</div>
              <div className="dgen-empty-desc">{t('dataGen.insertOrderHint')}</div>
              {filteredTables.length > 0 && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={running}
                  onClick={() => toggleTable(filteredTables[0])}
                >
                  <Check size={12} />
                  <span>{t('dataGen.selectThisTable')} ({filteredTables[0].table})</span>
                </button>
              )}
            </div>
          )}
          {activeTarget && !activeSpec && (
            <div className="dgen-pane-pad dgen-p-24 dgen-center-flex">
              <span className="dgen-hint">{t('dataGen.tableNotSelected')}</span>
              <button className="btn btn-primary" disabled={running} onClick={() => toggleTable(activeTarget)}>
                <Check size={13} /> {t('dataGen.selectThisTable')}
              </button>
            </div>
          )}
          {activeTarget && activeSpec && (
            <>
              {/* Workspace header with table name and tabs */}
              <div className="dgen-workspace-header">
                <div className="dgen-workspace-header-left">
                  <div className="dgen-workspace-title">
                    <Table2 size={14} className="dgen-dim" />
                    <span>{activeSpec.table}</span>
                  </div>
                  <span className="dgen-chip dgen-table-chip">
                    {t('dataGen.tableRowsBadge', { n: formatCount(activeSpec.rows, i18n.language) })}
                  </span>
                </div>

                {/* Independent Tab buttons */}
                <div className="dgen-workspace-tabs">
                  <button
                    type="button"
                    className={`dgen-tab-btn${activeTab === 'columns' ? ' active' : ''}`}
                    onClick={() => setActiveTab('columns')}
                  >
                    <Columns3 size={12} />
                    <span>{t('dataGen.tabColumns')}</span>
                  </button>
                  <button
                    type="button"
                    className={`dgen-tab-btn${activeTab === 'preview' ? ' active' : ''}`}
                    onClick={() => setActiveTab('preview')}
                  >
                    <Eye size={12} />
                    <span>{t('dataGen.tabPreview')}</span>
                    {previewBusy && <Loader size={11} className="spin" />}
                  </button>
                </div>
              </div>

              {/* Subbar for Columns tab: rows and mode configuration */}
              {activeTab === 'columns' && (
                <div className="dgen-workspace-subbar">
                  <div className="dgen-field-inline">
                    <span className="dgen-label">{t('dataGen.rows')}</span>
                    <input
                      type="number"
                      min={1}
                      className="dgen-input-table-rows"
                      value={activeSpec.rows}
                      disabled={running}
                      onChange={(e) => patchTable(activeSpec.table, { rows: Math.max(0, Number(e.target.value) || 0) })}
                    />
                  </div>
                  <div className="dgen-bar-sep" />
                  <div className="dgen-field-inline">
                    <span className="dgen-label">{t('dataGen.mode')}</span>
                    <select
                      className="dgen-select-mode"
                      value={activeSpec.mode ?? 'append'}
                      disabled={running}
                      onChange={(e) => patchTable(activeSpec.table, { mode: e.target.value as 'append' | 'truncate' })}
                    >
                      <option value="append">{t('dataGen.modeAppend')}</option>
                      <option value="truncate">{t('dataGen.modeTruncate')}</option>
                    </select>
                  </div>
                  {activeSpec.mode === 'truncate' && (
                    <span className="dgen-subbar-hint">
                      {t('dataGen.confirmNoteTruncate')}
                    </span>
                  )}
                </div>
              )}

              {/* Table configuration issues */}
              {!!activeTableIssues.length && (
                <div className="dgen-workspace-issues">
                  {activeTableIssues.map((issue) => (
                    <div
                      key={`${issue.key}-${issue.column ?? ''}`}
                      className={`dgen-msg ${issue.level === 'error' ? 'error' : 'warn'}`}
                    >
                      <AlertTriangle size={11} />
                      <span>{t(issue.key as never, issue.params ?? {})}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Workspace body */}
              <div className="dgen-workspace-body">
                {activeTab === 'columns' ? (
                  <div className="dgen-cols-wrap">
                    {/* Columns table */}
                    <div className="dgen-cols-table-scroll">
                      <table className="dgen-table">
                        <thead>
                          <tr>
                            <th>{t('dataGen.colColumn')}</th>
                            <th>{t('dataGen.colType')}</th>
                            <th>{t('dataGen.colGenerator')}</th>
                            <th className="dgen-th-center">{t('dataGen.colUnique')}</th>
                            <th className="dgen-th-right">{t('dataGen.colNullPercent')}</th>
                            <th className="dgen-th-options">{t('dataGen.colOptions')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {activeTarget.columns.map((colTarget) => {
                            const colSpec = activeSpec.columns.find((c) => c.column === colTarget.name);
                            if (!colSpec) return null;
                            const hasOpts =
                              optionFields(colSpec.generator).length > 0 ||
                              isTextGenerator(colSpec.generator) ||
                              !!colTarget.fk;
                            const isSelected = activeColumn === colTarget.name;
                            return (
                              <tr
                                key={colTarget.name}
                                className={isSelected ? 'on' : undefined}
                                onClick={() => setActiveColumn(colTarget.name)}
                              >
                                <td>
                                  {colTarget.name}
                                  {colTarget.isPrimaryKey && <Badge variant="pk" title={t('dataGen.badgePkTitle')}>PK</Badge>}
                                  {colTarget.fk && (
                                    <Badge
                                      variant="fk"
                                      title={t('dataGen.badgeFkTitle', {
                                        ref: `${colTarget.fk.refTable}.${colTarget.fk.refColumn}`,
                                      })}
                                    >
                                      FK
                                    </Badge>
                                  )}
                                  {colTarget.autoIncrement && <Badge variant="ai" title={t('dataGen.badgeAutoIncTitle')}>AI</Badge>}
                                  {!colTarget.nullable && <Badge variant="nn" title={t('dataGen.badgeNotNullTitle')}>NN</Badge>}
                                </td>
                                <td className="dgen-mono dgen-dim">{colTarget.type}</td>
                                <td>
                                  <select
                                    className="dgen-select-gen"
                                    value={colSpec.generator}
                                    disabled={running}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => {
                                      patchColumn(activeSpec.table, colTarget.name, {
                                        generator: e.target.value,
                                        options: {},
                                      });
                                      setActiveColumn(colTarget.name);
                                    }}
                                  >
                                    {GENERATOR_GROUPS.map((group) => (
                                      <optgroup key={group.groupKey} label={t(group.groupKey as never)}>
                                        {group.ids.map((id) => (
                                          <option key={id} value={id}>
                                            {t(generatorLabelKey(id) as never)}
                                          </option>
                                        ))}
                                      </optgroup>
                                    ))}
                                  </select>
                                </td>
                                <td className="dgen-td-center">
                                  <input
                                    type="checkbox"
                                    checked={!!colSpec.unique}
                                    disabled={running || colSpec.generator === 'skip'}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) =>
                                      patchColumn(activeSpec.table, colTarget.name, { unique: e.target.checked })
                                    }
                                  />
                                </td>
                                <td className="dgen-td-right">
                                  <input
                                    type="number"
                                    min={0}
                                    max={100}
                                    className="dgen-input-null"
                                    value={colSpec.nullPercent ?? 0}
                                    disabled={running || colSpec.generator === 'skip' || !colTarget.nullable}
                                    title={colTarget.nullable ? undefined : t('dataGen.badgeNotNullTitle')}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) =>
                                      patchColumn(activeSpec.table, colTarget.name, {
                                        nullPercent: Number(e.target.value) || 0,
                                      })
                                    }
                                  />
                                </td>
                                <td className="dgen-td-center">
                                  <button
                                    type="button"
                                    className={`dgen-col-btn${isSelected && drawerOpen ? ' active' : ''}${
                                      hasOpts ? ' has-options' : ''
                                    }`}
                                    title={t('dataGen.colOptions')}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setActiveColumn(colTarget.name);
                                      setDrawerOpen((prev) => (activeColumn === colTarget.name ? !prev : true));
                                    }}
                                  >
                                    <SlidersHorizontal size={11} />
                                    <span>{t('dataGen.colOptions')}</span>
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Inspector Drawer */}
                    {drawerOpen && activeColSpec && activeSpec && (
                      <div className="dgen-drawer">
                        <div className="dgen-drawer-head">
                          <div className="dgen-drawer-title">
                            <SlidersHorizontal size={12} className="dgen-dim" />
                            <span>{activeColSpec.column}</span>
                            <span className="dgen-dim">
                              · {t(generatorLabelKey(activeColSpec.generator) as never)}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="dgen-icon-btn"
                            title={t('dataGen.closeOptions')}
                            onClick={() => setDrawerOpen(false)}
                          >
                            <X size={12} />
                          </button>
                        </div>
                        <div className="dgen-drawer-body">
                          {activeColTarget?.fk && activeColSpec.generator !== 'foreignKey' && (
                            <div className="dgen-msg warn">
                              <AlertTriangle size={11} />
                              {t('dataGen.fkOverriddenHint', {
                                ref: `${activeColTarget.fk.refTable}.${activeColTarget.fk.refColumn}`,
                              })}
                            </div>
                          )}
                          {optionFields(activeColSpec.generator).map((field) =>
                            renderOptionField(field, activeColSpec, activeSpec.table),
                          )}
                          {isTextGenerator(activeColSpec.generator) && (
                            <>
                              <Field text={t('dataGen.prefix')}>
                                <input
                                  value={activeColSpec.prefix ?? ''}
                                  onChange={(e) =>
                                    patchColumn(activeSpec.table, activeColSpec.column, { prefix: e.target.value })
                                  }
                                />
                              </Field>
                              <Field text={t('dataGen.suffix')}>
                                <input
                                  value={activeColSpec.suffix ?? ''}
                                  onChange={(e) =>
                                    patchColumn(activeSpec.table, activeColSpec.column, { suffix: e.target.value })
                                  }
                                />
                              </Field>
                              <Field text={t('dataGen.letterCase')}>
                                <select
                                  value={activeColSpec.case ?? ''}
                                  onChange={(e) =>
                                    patchColumn(activeSpec.table, activeColSpec.column, {
                                      case: (e.target.value || undefined) as GenColumnSpec['case'],
                                    })
                                  }
                                >
                                  <option value="">{t('dataGen.caseNone')}</option>
                                  <option value="upper">{t('dataGen.caseUpper')}</option>
                                  <option value="lower">{t('dataGen.caseLower')}</option>
                                  <option value="title">{t('dataGen.caseTitle')}</option>
                                </select>
                              </Field>
                              <Field text={t('dataGen.emptyPercent')}>
                                <input
                                  type="number"
                                  min={0}
                                  max={100}
                                  value={activeColSpec.emptyPercent ?? 0}
                                  onChange={(e) =>
                                    patchColumn(activeSpec.table, activeColSpec.column, {
                                      emptyPercent: Number(e.target.value) || 0,
                                    })
                                  }
                                />
                              </Field>
                            </>
                          )}
                          {!optionFields(activeColSpec.generator).length &&
                            !isTextGenerator(activeColSpec.generator) &&
                            !activeColTarget?.fk && (
                              <div className="dgen-hint">{t('dataGen.noOptionsForCol')}</div>
                            )}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Live Preview Tab */
                  <div className="dgen-preview-wrap">
                    <div className="dgen-preview-bar">
                      <div className="dgen-preview-bar-left">
                        <span className="dgen-label">{t('dataGen.panePreview')}</span>
                        <span className="dgen-dim">
                          ({formatCount(preview?.data.length ?? 0, i18n.language)} rows)
                        </span>
                        <span className="dgen-chip" title={t('dataGen.seedHint')}>
                          {t('dataGen.seed')} {seed}
                          <button
                            type="button"
                            className="dgen-icon-btn"
                            disabled={running}
                            title={t('dataGen.seedRandomTitle')}
                            onClick={() => setSeed(rollSeed())}
                          >
                            <Dice5 size={12} />
                          </button>
                        </span>
                        <button
                          type="button"
                          className="dgen-icon-btn"
                          disabled={!activeSpec || running}
                          title={t('dataGen.previewHint')}
                          onClick={() => setPreviewNonce((n) => n + 1)}
                        >
                          <RefreshCw size={11} />
                        </button>
                      </div>
                      {previewBusy && <Loader size={12} className="spin" />}
                    </div>
                    <div className="dgen-preview-table-scroll">
                      {previewError && (
                        <div className="dgen-msg error dgen-p-12">
                          <AlertTriangle size={12} /> {previewError}
                        </div>
                      )}
                      {!previewError && (!preview || !preview.data.length) && (
                        <div className="dgen-hint dgen-p-16">
                          {activeSpec ? t('dataGen.previewEmpty') : t('dataGen.pickTableHint')}
                        </div>
                      )}
                      {!previewError && preview && !!preview.data.length && (
                        <table className="dgen-table">
                          <thead>
                            <tr>
                              {preview.columns.map((col) => (
                                <th key={col}>{col}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {preview.data.map((row, rowIdx) => (
                              // oxlint-disable-next-line react/no-array-index-key
                              <tr key={rowIdx} className="dgen-row-static">
                                {preview.columns.map((col) => {
                                  const v = row[col];
                                  return (
                                    <td key={col} className="dgen-mono">
                                      {v === null || v === undefined ? (
                                        <span className="dgen-dim dgen-null-val">
                                          {'NULL'}
                                        </span>
                                      ) : (
                                        String(v)
                                      )}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ---- progress / result ---- */}
      {running && (
        <ProgressBar
          progress={{
            label: t('dataGen.progress', {
              table: progress?.table ?? '',
              done: formatCount(doneRows, i18n.language),
              total: formatCount(totalRows, i18n.language),
            }),
            current: doneRows,
            total: totalRows,
            detail:
              remainingMs === null ? undefined : t('dataGen.eta', { time: formatDuration(remainingMs, t as never) }),
          }}
        />
      )}
      {result && (
        <div className={`dgen-msg ${result.cancelled ? 'warn' : 'ok'}`}>
          <span>
            {result.cancelled
              ? t('dataGen.resultCancelled', { n: formatCount(insertedTotal, i18n.language) })
              : t('dataGen.resultDone', {
                  n: formatCount(insertedTotal, i18n.language),
                  time: formatDuration(result.elapsedMs ?? 0, t as never),
                })}
            {!!result.warnings?.length && <div className="dgen-msg warn">{result.warnings.join(' · ')}</div>}
          </span>
        </div>
      )}
      {runError && (
        <div className="dgen-msg error">
          <AlertTriangle size={12} /> {runError}
        </div>
      )}
    </div>
  );

  const confirmDialog = (
    <ConfirmDialog
      open={confirming}
      title={t('dataGen.confirmTitle')}
      message={
        truncating
          ? t('dataGen.confirmBodyTruncate', {
              rows: formatCount(totalRows, i18n.language),
              tables: selectedCount,
              db: dbName ?? '',
            })
          : t('dataGen.confirmBody', {
              rows: formatCount(totalRows, i18n.language),
              tables: selectedCount,
              db: dbName ?? '',
            })
      }
      note={truncating ? t('dataGen.confirmNoteTruncate') : undefined}
      confirmLabel={t('dataGen.generate')}
      danger={truncating}
      onConfirm={() => {
        setConfirming(false);
        void run();
      }}
      onCancel={() => setConfirming(false)}
    />
  );

  if (asTab) {
    return (
      <div className="dgen-tab-container">
        <div className="dgen-tab-header">
          <div className="dgen-tab-title-wrap">
            <Wand2 size={15} className="dgen-accent-icon" />
            <span className="dgen-tab-title-text">
              {dbName ? t('dataGen.titleWithDb', { db: dbName }) : t('dataGen.title')}
            </span>
          </div>
        </div>
        {dgenContent}
        {confirmDialog}
      </div>
    );
  }

  return (
    <Modal
      title={dbName ? t('dataGen.titleWithDb', { db: dbName }) : t('dataGen.title')}
      icon={<Wand2 size={14} className="title-bar-logo" />}
      onClose={onClose}
      closeDisabled={running}
      width="1180px"
      height="86vh"
      zIndex={10000}
    >
      <ModalBody className="dgen-modal-body">
        {dgenContent}
      </ModalBody>

      {confirmDialog}
    </Modal>
  );
};
