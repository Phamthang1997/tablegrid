import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Activity,
  RefreshCw,
  Search,
  AlertTriangle,
  Flame,
  Clock,
  User,
  X,
  Copy,
  Check,
  Ban,
  Radio,
  ShieldAlert,
  FileCode2,
  Database,
  Zap,
} from 'lucide-react';
import { dbHelper } from '../utils/dbHelper';
import {
  type ProcessItem,
  type ProcessListSummary,
  formatProcessDuration,
  getDurationSeverity,
  isQueryActive,
} from '../utils/processMonitorTypes';

export interface LiveProcessListPanelProps {
  connId: string;
  databaseName?: string;
  embedded?: boolean;
  onClose?: () => void;
  /** Optional custom invocation function */
  invokeCommand?: (cmd: string, args: Record<string, unknown>) => Promise<any>;
}

type AutoRefreshInterval = 0 | 1000 | 3000 | 5000 | 10000;
type FilterTab = 'all' | 'active' | 'slow' | 'blocked';
type SortField = 'id' | 'user' | 'db' | 'time_seconds' | 'state';
type SortOrder = 'asc' | 'desc';

export const LiveProcessListPanel: React.FC<LiveProcessListPanelProps> = ({
  connId,
  databaseName,
  embedded = false,
  onClose: _onClose,
  invokeCommand,
}) => {
  const [data, setData] = useState<ProcessListSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<AutoRefreshInterval>(3000);
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedProcess, setSelectedProcess] = useState<ProcessItem | null>(null);
  const [copiedQuery, setCopiedQuery] = useState<boolean>(false);
  const [actionPending, setActionPending] = useState<string | null>(null);

  // Sorting state
  const [sortField, setSortField] = useState<SortField>('time_seconds');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  // Confirmation state for killing
  const [confirmTarget, setConfirmTarget] = useState<{
    process: ProcessItem;
    action: 'cancel_query' | 'kill_connection';
  } | null>(null);

  const timerRef = useRef<number | null>(null);

  // Fetch processlist from backend
  const fetchProcesses = useCallback(
    async (isBackground = false) => {
      if (!isBackground) setLoading(true);
      setError(null);
      try {
        const res = invokeCommand
          ? await invokeCommand('get_process_list', { connId })
          : await dbHelper.getProcessList(connId);
        setData(res);
      } catch (err: any) {
        setError(err?.message || String(err));
      } finally {
        if (!isBackground) setLoading(false);
      }
    },
    [connId, invokeCommand]
  );

  // Initial load
  useEffect(() => {
    let isMounted = true;
    const load = async () => {
      try {
        const res = invokeCommand
          ? await invokeCommand('get_process_list', { connId })
          : await dbHelper.getProcessList(connId);
        if (isMounted) {
          setData(res);
          setLoading(false);
        }
      } catch (err: any) {
        if (isMounted) {
          setError(err?.message || String(err));
          setLoading(false);
        }
      }
    };
    void load();

    return () => {
      isMounted = false;
    };
  }, [connId, invokeCommand]);

  // Auto-refresh interval loop
  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (autoRefreshInterval > 0) {
      timerRef.current = window.setInterval(() => {
        void fetchProcesses(true);
      }, autoRefreshInterval);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [autoRefreshInterval, fetchProcesses]);

  // Handle killing query or session
  const executeKill = async () => {
    if (!confirmTarget) return;
    const { process, action } = confirmTarget;
    setActionPending(process.id);
    try {
      if (invokeCommand) {
        const cmd = action === 'cancel_query' ? 'kill_process_query' : 'kill_process_connection';
        await invokeCommand(cmd, { connId, processId: process.id });
      } else if (action === 'cancel_query') {
        await dbHelper.killProcessQuery(process.id, connId);
      } else {
        await dbHelper.killProcessConnection(process.id, connId);
      }
      setConfirmTarget(null);
      await fetchProcesses(false);
    } catch (err: any) {
      setError(err?.message || `Failed to ${action}: ${String(err)}`);
    } finally {
      setActionPending(null);
    }
  };

  // Copy query to clipboard
  const handleCopyQuery = (queryText: string) => {
    void navigator.clipboard.writeText(queryText);
    setCopiedQuery(true);
    setTimeout(() => setCopiedQuery(false), 1800);
  };

  // Toggle sorting
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  // Derived real-time metrics
  const metrics = useMemo(() => {
    if (!data?.processes) {
      return {
        total: data?.total_connections ?? 0,
        active: data?.active_queries ?? 0,
        blocked: data?.blocked_queries ?? 0,
        longest: data?.longest_running_seconds ?? 0,
      };
    }
    const total = data.processes.length;
    let active = 0;
    let blocked = 0;
    let longest = 0;

    for (const p of data.processes) {
      if (isQueryActive(p)) {
        active++;
        if (p.time_seconds > longest) {
          longest = p.time_seconds;
        }
      }
      if (p.is_blocked || p.blocked_by) {
        blocked++;
      }
    }
    return { total, active, blocked, longest };
  }, [data]);

  // Filter and sort items
  const filteredProcesses = useMemo(() => {
    if (!data?.processes) return [];
    let list = [...data.processes];

    // Tab filter
    if (filterTab === 'active') {
      list = list.filter(isQueryActive);
    } else if (filterTab === 'slow') {
      list = list.filter((p) => isQueryActive(p) && p.time_seconds >= 5);
    } else if (filterTab === 'blocked') {
      list = list.filter((p) => p.is_blocked || !!p.blocked_by);
    }

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (p) =>
          p.id.toLowerCase().includes(q) ||
          p.user.toLowerCase().includes(q) ||
          p.db.toLowerCase().includes(q) ||
          p.host.toLowerCase().includes(q) ||
          p.info.toLowerCase().includes(q) ||
          p.state.toLowerCase().includes(q)
      );
    }

    // Sorting
    list.sort((a, b) => {
      const valA: any = a[sortField];
      const valB: any = b[sortField];

      if (typeof valA === 'number') {
        return sortOrder === 'asc' ? valA - valB : valB - valA;
      }
      return sortOrder === 'asc'
        ? String(valA).localeCompare(String(valB))
        : String(valB).localeCompare(String(valA));
    });

    return list;
  }, [data, filterTab, searchQuery, sortField, sortOrder]);

  return (
    <div className={`pm-container ${embedded ? 'pm-embedded' : 'pm-tab-panel'}`}>
      {/* Top Control Bar */}
      <div className="pm-header-bar">
        <div className="pm-header-left">
          {!embedded && (
            <div className="pm-header-title">
              <Activity size={16} className="pm-title-icon" />
              <span>Live Processlist &amp; Query Monitor</span>
              {databaseName && (
                <span className="pm-db-chip" title="Active Database">
                  <Database size={11} />
                  <span>{databaseName}</span>
                </span>
              )}
            </div>
          )}
          <div className={`pm-live-indicator ${autoRefreshInterval > 0 ? 'active' : ''}`}>
            <div className="pm-live-dot" />
            <span>{autoRefreshInterval > 0 ? 'Streaming Live' : 'Paused'}</span>
          </div>
          <button
            className="pm-btn"
            onClick={() => void fetchProcesses(false)}
            disabled={loading}
            title="Refresh process list immediately"
          >
            <RefreshCw size={13} className={loading ? 'pm-loading-spinner' : ''} />
            <span>Refresh</span>
          </button>
        </div>

        <div className="pm-controls-right">
          <div className="pm-interval-group">
            <span className="pm-interval-label">Auto-refresh:</span>
            <button
              className={`pm-btn ${autoRefreshInterval === 0 ? 'active' : ''}`}
              onClick={() => setAutoRefreshInterval(0)}
            >
              Off
            </button>
            <button
              className={`pm-btn ${autoRefreshInterval === 1000 ? 'active' : ''}`}
              onClick={() => setAutoRefreshInterval(1000)}
            >
              1s
            </button>
            <button
              className={`pm-btn ${autoRefreshInterval === 3000 ? 'active' : ''}`}
              onClick={() => setAutoRefreshInterval(3000)}
            >
              3s
            </button>
            <button
              className={`pm-btn ${autoRefreshInterval === 5000 ? 'active' : ''}`}
              onClick={() => setAutoRefreshInterval(5000)}
            >
              5s
            </button>
            <button
              className={`pm-btn ${autoRefreshInterval === 10000 ? 'active' : ''}`}
              onClick={() => setAutoRefreshInterval(10000)}
            >
              10s
            </button>
          </div>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="pm-metrics-grid">
        <div className="pm-metric-card">
          <div className="pm-metric-content">
            <span className="pm-metric-title">Total Sessions</span>
            <span className="pm-metric-value">{metrics.total}</span>
          </div>
          <div className="pm-metric-icon-wrap">
            <User size={17} />
          </div>
        </div>

        <div className="pm-metric-card accent">
          <div className="pm-metric-content">
            <span className="pm-metric-title">Active Queries</span>
            <span className="pm-metric-value">{metrics.active}</span>
          </div>
          <div className="pm-metric-icon-wrap">
            <Flame size={17} />
          </div>
        </div>

        <div className={`pm-metric-card ${metrics.blocked > 0 ? 'danger' : 'success'}`}>
          <div className="pm-metric-content">
            <span className="pm-metric-title">Blocked / Locks</span>
            <span className="pm-metric-value">{metrics.blocked}</span>
          </div>
          <div className="pm-metric-icon-wrap">
            <AlertTriangle size={17} />
          </div>
        </div>

        <div className="pm-metric-card">
          <div className="pm-metric-content">
            <span className="pm-metric-title">Longest Running</span>
            <span className="pm-metric-value">
              {metrics.active > 0 && metrics.longest > 0
                ? formatProcessDuration(metrics.longest)
                : '—'}
            </span>
          </div>
          <div className="pm-metric-icon-wrap">
            <Clock size={17} />
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="pm-filter-bar">
        <div className="pm-search-input-wrap">
          <Search size={13} className="pm-search-icon" />
          <input
            type="text"
            className="pm-search-input"
            placeholder="Filter by query text, user, PID, database..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              className="pm-search-clear"
              onClick={() => setSearchQuery('')}
              title="Clear filter"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <div className="pm-filter-toggles">
          <button
            className={`pm-btn ${filterTab === 'all' ? 'active' : ''}`}
            onClick={() => setFilterTab('all')}
          >
            All ({metrics.total})
          </button>
          <button
            className={`pm-btn ${filterTab === 'active' ? 'active' : ''}`}
            onClick={() => setFilterTab('active')}
          >
            Active Only ({metrics.active})
          </button>
          <button
            className={`pm-btn ${filterTab === 'slow' ? 'active' : ''}`}
            onClick={() => setFilterTab('slow')}
          >
            Slow (&gt;5s)
          </button>
          <button
            className={`pm-btn ${filterTab === 'blocked' ? 'active' : ''}`}
            onClick={() => setFilterTab('blocked')}
          >
            Blocked ({metrics.blocked})
          </button>
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <div className="pm-badge pm-badge-blocked">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      {/* Main Table */}
      <div className="pm-table-container">
        <table className="pm-table">
          <thead>
            <tr>
              <th className="sortable" onClick={() => handleSort('id')}>
                PID / ID {sortField === 'id' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th className="sortable" onClick={() => handleSort('user')}>
                User {sortField === 'user' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th>Host</th>
              <th className="sortable" onClick={() => handleSort('db')}>
                Database {sortField === 'db' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th className="sortable" onClick={() => handleSort('state')}>
                State {sortField === 'state' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th className="sortable" onClick={() => handleSort('time_seconds')}>
                Duration {sortField === 'time_seconds' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th>Query Text</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredProcesses.map((proc) => {
              const isSelected = selectedProcess?.id === proc.id;
              const isAct = isQueryActive(proc);
              const severity = getDurationSeverity(proc.time_seconds, proc.state, isAct);
              const isBlocked = proc.is_blocked || !!proc.blocked_by;
              const isPending = actionPending === proc.id;
              const hasQuery = proc.info && proc.info.trim().length > 0 && proc.info.trim() !== '--';

              return (
                <tr
                  key={proc.id}
                  className={`pm-row ${isSelected ? 'selected' : ''} ${isBlocked ? 'blocked-row' : ''}`}
                  onClick={() => setSelectedProcess(proc)}
                >
                  <td className="pm-id-cell">{proc.id}</td>
                  <td>{proc.user || '—'}</td>
                  <td>{proc.host || 'local'}</td>
                  <td>{proc.db || '—'}</td>
                  <td>
                    {isBlocked ? (
                      <span className="pm-badge pm-badge-blocked">
                        <AlertTriangle size={10} /> Blocked {proc.blocked_by ? `#${proc.blocked_by}` : ''}
                      </span>
                    ) : isAct ? (
                      <span className="pm-badge pm-badge-active">
                        <Zap size={10} /> {proc.state || 'Active'}
                      </span>
                    ) : (
                      <span className="pm-badge pm-badge-idle">
                        {proc.state || proc.command || 'Idle'}
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`pm-duration-cell ${isAct ? severity : 'idle'}`}>
                      {formatProcessDuration(proc.time_seconds)}
                    </span>
                  </td>
                  <td className="pm-query-cell" title={proc.info || 'Session is idle'}>
                    {hasQuery ? (
                      <span className="pm-query-text">{proc.info}</span>
                    ) : (
                      <span className="pm-dim-dash">—</span>
                    )}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="pm-actions-cell">
                      {isAct ? (
                        <button
                          className="pm-btn pm-btn-warning pm-btn-sm"
                          disabled={isPending}
                          onClick={() => setConfirmTarget({ process: proc, action: 'cancel_query' })}
                          title="Cancel running query without closing session"
                        >
                          <Ban size={11} />
                          <span>Cancel</span>
                        </button>
                      ) : null}
                      <button
                        className="pm-btn pm-btn-danger pm-btn-sm"
                        disabled={isPending}
                        onClick={() => setConfirmTarget({ process: proc, action: 'kill_connection' })}
                        title="Force disconnect entire session"
                      >
                        <ShieldAlert size={11} />
                        <span>Kill</span>
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filteredProcesses.length === 0 && !loading && (
              <tr>
                <td colSpan={8}>
                  <div className="pm-center-state">
                    <Radio size={26} />
                    <span>No matching active processes found.</span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Selected Query Detail Inspector */}
      {selectedProcess && (
        <div className="pm-detail-drawer">
          <div className="pm-detail-header">
            <div className="pm-detail-title">
              <FileCode2 size={15} />
              <span>Process Inspector: Session #{selectedProcess.id}</span>
              {selectedProcess.wait_event && (
                <span className="pm-badge pm-badge-warning">
                  Wait Event: {selectedProcess.wait_event}
                </span>
              )}
            </div>
            <div className="pm-actions-cell">
              <button
                className="pm-btn pm-btn-sm"
                onClick={() => handleCopyQuery(selectedProcess.info)}
                title="Copy full query text to clipboard"
              >
                {copiedQuery ? <Check size={12} /> : <Copy size={12} />}
                <span>{copiedQuery ? 'Copied' : 'Copy Query'}</span>
              </button>
              <button
                className="pm-btn pm-btn-icon-only"
                onClick={() => setSelectedProcess(null)}
                title="Close Inspector"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="pm-detail-grid">
            <div>
              <div className="pm-detail-field-label">User / Client</div>
              <div className="pm-detail-field-value">
                {selectedProcess.user} @ {selectedProcess.host}
              </div>
            </div>
            <div>
              <div className="pm-detail-field-label">Database</div>
              <div className="pm-detail-field-value">{selectedProcess.db || 'N/A'}</div>
            </div>
            <div>
              <div className="pm-detail-field-label">Command / State</div>
              <div className="pm-detail-field-value">
                {selectedProcess.command} ({selectedProcess.state})
              </div>
            </div>
            <div>
              <div className="pm-detail-field-label">Execution Time</div>
              <div className="pm-detail-field-value">
                {formatProcessDuration(selectedProcess.time_seconds)} ({selectedProcess.time_seconds}s)
              </div>
            </div>
          </div>

          <div className="pm-query-box">
            {selectedProcess.info || '-- No active query statement (Session is idle) --'}
          </div>
        </div>
      )}

      {/* Kill Confirmation Modal overlay */}
      {confirmTarget && (
        <div className="pm-confirm-dialog">
          <div className="pm-confirm-title">
            <AlertTriangle size={15} />
            <span>
              Confirm {confirmTarget.action === 'cancel_query' ? 'Query Cancel' : 'Session Termination'}
            </span>
          </div>
          <div className="pm-confirm-desc">
            Are you sure you want to{' '}
            <strong>
              {confirmTarget.action === 'cancel_query'
                ? `cancel the currently running query on PID #${confirmTarget.process.id}`
                : `terminate the entire database connection #${confirmTarget.process.id} for user '${confirmTarget.process.user}'`}
            </strong>
            ?
            {confirmTarget.action === 'kill_connection' && (
              <div>Any uncommitted transaction in this session will be immediately rolled back.</div>
            )}
          </div>
          <div className="pm-confirm-actions">
            <button
              className="pm-btn pm-btn-sm"
              onClick={() => setConfirmTarget(null)}
              disabled={actionPending !== null}
            >
              Cancel
            </button>
            <button
              className={`pm-btn pm-btn-sm ${confirmTarget.action === 'kill_connection' ? 'pm-btn-danger' : 'pm-btn-warning'}`}
              onClick={() => void executeKill()}
              disabled={actionPending !== null}
            >
              {actionPending !== null ? (
                <RefreshCw size={11} className="pm-loading-spinner" />
              ) : (
                <ShieldAlert size={11} />
              )}
              <span>
                Confirm {confirmTarget.action === 'cancel_query' ? 'Cancel Query' : 'Kill Session'}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
