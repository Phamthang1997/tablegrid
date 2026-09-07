import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Copy,
  Plug,
  RefreshCw,
  Trash2,
  Server,
  Database,
  Activity,
  Eye,
  EyeOff,
  ShieldCheck,
  Zap,
  Terminal,
} from 'lucide-react';

import { Modal, ModalBody } from './Modal';
import { dbHelper } from '../utils/dbHelper';
import type { McpAuditEntry, McpStatus, OpenConnection } from '../utils/dbHelper';
import {
  MCP_CLIENTS,
  mcpClient,
  mcpVariant,
  type McpClientId,
  type McpTransport,
} from '../utils/mcpClients';
import { readMcpPrefs, setMcpAutoStart, setMcpPort } from '../utils/mcpPrefs';

/** Mirrors `policy::DEFAULT_ROW_LIMIT` / `MAX_ROW_LIMIT`. Shown, not configurable in this build. */
const ROW_LIMIT_DEFAULT = 100;
const ROW_LIMIT_MAX = 1000;

/**
 * Mirrors `policy::MAX_TIMEOUT`, in seconds.
 *
 * Worth stating in the dialog rather than leaving as a surprise: an AI's heavy query being cut at 30s
 * looks like a bug from the client side, and the user is the only one who can see why. A lower
 * per-server statement timeout still wins - this is the ceiling, not the value.
 */
const TIMEOUT_CEILING_SECS = 30;

/** How many rows the list keeps. The log itself is capped in `mcp/audit.rs`, not here. */
const LOG_VIEW_CAP = 200;

/**
 * Remembers the picked client so re-opening this dialog does not land on someone else's client.
 *
 * `tf_mcp_client` is global on purpose: which AI client the user runs is not a property of any
 * connection, so it takes no `connKey`/`scopeKey` scope.
 */
const CLIENT_KEY = 'tf_mcp_client';

/** Which transport the user last picked. Global for the same reason `tf_mcp_client` is. */
const TRANSPORT_KEY = 'tf_mcp_transport';

/**
 * System databases, so the reach line can put the user's own first.
 *
 * **Hand-synced with `src-tauri/src/stats/system_dbs.rs`**, which owns the same two lists for the
 * dashboard - it is `pub(super)`, so there is no way to read it from here without widening it or
 * changing a command's shape for a display detail. Both lists have been stable for a decade, and the
 * cost of drift is a miscounted line rather than a wrong query.
 *
 * They are counted but NOT hidden: `mysql` holds the user table, so "the AI can read it" is exactly
 * the kind of thing this line exists to say out loud.
 */
const SYSTEM_DBS: Record<string, string[]> = {
  mysql: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  postgres: ['postgres', 'template0', 'template1'],
};

function readClient(): McpClientId {
  try {
    const saved = localStorage.getItem(CLIENT_KEY);
    if (saved) return mcpClient(saved).id;
  } catch {
    // A blocked localStorage must not cost the user the whole dialog.
  }
  return MCP_CLIENTS[0].id;
}

/**
 * The stored transport, or `null` to mean "use whatever this client's default is".
 *
 * `null` rather than a hardcoded fallback: the two transports are not equally reliable per client, so
 * the answer lives in `defaultTransport` and not here.
 */
function readTransport(): McpTransport | null {
  try {
    const saved = localStorage.getItem(TRANSPORT_KEY); // 'tf_mcp_transport'
    if (saved === 'http' || saved === 'stdio') return saved;
  } catch {
    // As above.
  }
  return null;
}

interface Props {
  onClose: () => void;
  asTab?: boolean;
}

export function McpServerSettingsModal({ onClose, asTab = false }: Props) {
  const { t, i18n } = useTranslation();
  const [activeTab, setActiveTab] = useState<'server' | 'databases' | 'logs'>('server');
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [port, setPort] = useState('');
  const [token, setToken] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [connections, setConnections] = useState<OpenConnection[]>([]);
  const [log, setLog] = useState<McpAuditEntry[]>([]);
  /**
   * Which log is on screen. The two are genuinely different records, not one filtered two ways:
   * memory holds this run and is cleared by the button, the file holds every run and is not.
   */
  const [logSource, setLogSource] = useState<'memory' | 'file'>('memory');
  const [fileLog, setFileLog] = useState<McpAuditEntry[]>([]);
  const [fileInfo, setFileInfo] = useState<{ unreadable: number; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<'token' | 'config' | null>(null);
  const [clientId, setClientId] = useState<McpClientId>(readClient);
  const [transport, setTransport] = useState<McpTransport>(
    () => readTransport() ?? mcpClient(readClient()).defaultTransport,
  );
  const [autoStart, setAutoStart] = useState(() => readMcpPrefs().autoStart);
  /** Databases each ticked connection can actually reach, keyed by `connId`. See `reachLine`. */
  const [reach, setReach] = useState<Record<string, string[]>>({});

  const refresh = useCallback(async () => {
    try {
      const [s, conns] = await Promise.all([dbHelper.mcpStatus(), dbHelper.listConnections()]);
      setStatus(s);
      setPort(String(s.port));
      // Redis is out of MCP scope, so listing it here would offer a switch that does nothing.
      setConnections(conns.filter((c) => c.dialect !== 'redis'));
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    // set-state-in-effect: the rule's alternatives - derive during render, initialise state directly -
    // cannot reach the backend. Status, token and log all come from `invoke()`, so the first paint has
    // nothing to show and an effect is the only place the call can live.
    // eslint-disable-next-line react/set-state-in-effect
    void refresh();
    void dbHelper.mcpGetToken().then(setToken).catch(() => {});
    void dbHelper.mcpAuditLog().then(setLog).catch(() => {});
    // The disk log is read once on open too: it is what answers "what happened before today",
    // and finding out only after clicking a tab makes the tab look empty.
    void dbHelper
      .mcpAuditFileRead()
      .then((r) => {
        setFileLog(r.entries);
        setFileInfo({ unreadable: r.unreadable, error: r.error });
      })
      .catch(() => {});
  }, [refresh]);

  // Probe what each ticked connection reaches. One query per newly ticked connection, never for an
  // unticked one, and never twice for the same `connId` - `reach` is the memo. A failure stays absent
  // rather than showing a wrong number.
  useEffect(() => {
    for (const c of connections) {
      if (!c.mcpExposed || reach[c.connId]) continue;
      void dbHelper
        .listDatabases(c.connId)
        .then((res) => {
          if (res.success) setReach((prev) => ({ ...prev, [c.connId]: res.databases }));
        })
        .catch(() => {});
    }
    // `reach` is deliberately not a dependency: it is written by this effect, and listing it would
    // re-run on every write. The `reach[c.connId]` guard above is what stops the repeat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections]);

  // The log is born in Rust and arrives by event. Polling would show a request seconds after it
  // ran, which on a security screen is the wrong side of "did something just happen".
  useEffect(() => {
    const un = listen<McpAuditEntry>('mcp-request', (e) => {
      setLog((prev) => [e.payload, ...prev].slice(0, LOG_VIEW_CAP));
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const copyTimer = useRef<number | undefined>(undefined);
  const copy = (what: 'token' | 'config', text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(what);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1500);
  };
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleServer = () =>
    run(async () => {
      if (status?.running) {
        await dbHelper.mcpStop();
        return;
      }
      const wanted = Number(port) || undefined;
      await dbHelper.mcpStart(wanted);
      // Remembered only after the start SUCCEEDED, so a port that cannot bind is never the one
      // autostart tries on the next run.
      setMcpPort(wanted);
    });

  const toggleAutoStart = (on: boolean) => {
    setAutoStart(on);
    setMcpAutoStart(on);
  };

  const running = !!status?.running;
  const shownLog = logSource === 'file' ? fileLog : log;
  const sharedCount = connections.filter((c) => c.mcpExposed).length;

  const pickClient = (id: McpClientId) => {
    setClientId(id);
    // Re-arm the new client's proven default rather than carrying the previous choice across: the two
    // transports are not equally reliable per client, which is what `defaultTransport` encodes.
    setTransport(mcpClient(id).defaultTransport);
    try {
      localStorage.setItem(CLIENT_KEY, id); // 'tf_mcp_client' - global, see the constant above.
      localStorage.removeItem(TRANSPORT_KEY);
    } catch {
      // Losing the preference is not worth failing the click over.
    }
  };

  const pickTransport = (next: McpTransport) => {
    setTransport(next);
    try {
      localStorage.setItem(TRANSPORT_KEY, next); // 'tf_mcp_transport'
    } catch {
      // As above.
    }
  };

  const activeClient = mcpClient(clientId);
  const activeVariant = mcpVariant(clientId, transport);

  /**
   * What a ticked connection can actually reach, named.
   */
  const reachLine = (c: OpenConnection) => {
    const dbs = reach[c.connId];
    if (!dbs || dbs.length === 0) return null;

    const sys = new Set(SYSTEM_DBS[c.dialect] ?? []);
    const own = dbs.filter((d) => !sys.has(d.toLowerCase()));
    const sysCount = dbs.length - own.length;
    const sysNote = sysCount > 0 ? ` ${t('mcp.reachSystem', { n: sysCount })}` : '';

    if (own.length <= 1) {
      return (
        <p className="mcp-reach ok">
          {t('mcp.reachOne')}
          {sysNote}
        </p>
      );
    }
    return (
      <p className="mcp-reach">
        {t('mcp.reachMany', { n: own.length, list: own.join(', ') })}
        {sysNote}
      </p>
    );
  };

  // Built from the port the server is ACTUALLY bound to, never from the default constant: a
  // generated snippet naming a port nothing listens on is worse than no snippet at all.
  const endpoint = status?.url || `http://127.0.0.1:${port}/mcp`;
  const configSnippet = activeVariant.build({
    url: endpoint,
    token,
    exePath: status?.exePath ?? '',
    port: Number(port) || status?.port || 0,
  });

  /**
   * What one log row says on its right-hand side.
   */
  const outcomeLabel = (e: McpAuditEntry): string => {
    if (e.ok) return `${e.ms} ms`;
    switch (e.denial) {
      case 'badOrigin':
        return t('mcp.denialBadOrigin');
      case 'badToken':
        return t('mcp.denialBadToken');
      case 'notShared':
        return t('mcp.denialNotShared');
      case 'notReadOnly':
        return t('mcp.denialNotReadOnly');
      case 'manualTransaction':
        return t('mcp.denialManualTransaction');
      case 'writeNotAllowed':
        return t('mcp.denialWriteNotAllowed');
      case 'notApproved':
        return t('mcp.denialNotApproved');
      case 'failed':
        return t('mcp.denialFailed');
      default:
        return e.layer ? t('mcp.logDenied', { n: e.layer }) : t('mcp.logFailed');
    }
  };

  const content = (
    <div className="mcp-container">
      {/* Top 3-Tab Navigator */}
      <div className="mcp-tabs-header">
            <button
              type="button"
              className={`mcp-tab-btn ${activeTab === 'server' ? 'active' : ''}`}
              onClick={() => setActiveTab('server')}
            >
              <Server size={13} />
              <span>{t('mcp.tabServer')}</span>
            </button>
            <button
              type="button"
              className={`mcp-tab-btn ${activeTab === 'databases' ? 'active' : ''}`}
              onClick={() => setActiveTab('databases')}
            >
              <Database size={13} />
              <span>{t('mcp.tabDatabases')}</span>
              {sharedCount > 0 && <span className="mcp-tab-badge">{sharedCount}</span>}
            </button>
            <button
              type="button"
              className={`mcp-tab-btn ${activeTab === 'logs' ? 'active' : ''}`}
              onClick={() => setActiveTab('logs')}
            >
              <Activity size={13} />
              <span>{t('mcp.tabLogs')}</span>
              {log.length > 0 && <span className="mcp-tab-badge">{log.length}</span>}
            </button>
          </div>

          {error && <p className="mcp-error">{error}</p>}

          {/* TAB 1: Server & AI Clients */}
          {activeTab === 'server' && (
            <div className="mcp-tab-content">
              {/* Server Control Card */}
              <div className="mcp-card">
                <div className="mcp-card-header">
                  <span className="mcp-card-title">
                    <Zap size={13} />
                    <span>Trạng thái Máy chủ</span>
                  </span>
                </div>
                <div className="mcp-row">
                  <span className={running ? 'mcp-dot on' : 'mcp-dot'} />
                  <span className="mcp-status-badge">
                    {running ? (
                      <>
                        <span>Đang chạy tại</span>
                        <code>{status?.url || endpoint}</code>
                      </>
                    ) : (
                      <span>{t('mcp.statusStopped')}</span>
                    )}
                  </span>
                  <div className="mcp-spacer" />
                  <div className="mcp-port-box">
                    <span>{t('mcp.port')}:</span>
                    <input
                      type="text"
                      value={port}
                      onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))}
                      disabled={running || busy}
                      aria-label={t('mcp.port')}
                      title={t('mcp.portHint')}
                      className="form-input mcp-port"
                    />
                  </div>
                  <button
                    type="button"
                    className={running ? 'btn btn-secondary' : 'btn btn-primary'}
                    onClick={toggleServer}
                    disabled={busy}
                  >
                    {running ? t('mcp.stop') : t('mcp.start')}
                  </button>
                </div>
                <label className="mcp-check">
                  <input
                    type="checkbox"
                    checked={autoStart}
                    disabled={busy}
                    onChange={(e) => toggleAutoStart(e.target.checked)}
                  />
                  <span>{t('mcp.autoStart')}</span>
                </label>
              </div>

              {/* Security Access Token Card */}
              <div className="mcp-card">
                <div className="mcp-card-header">
                  <span className="mcp-card-title">
                    <ShieldCheck size={13} />
                    <span>{t('mcp.token')}</span>
                  </span>
                </div>
                <div className="mcp-token-row">
                  <input
                    type={revealed ? 'text' : 'password'}
                    readOnly
                    className="form-input mcp-token-input"
                    value={token}
                    onFocus={() => setRevealed(true)}
                    onBlur={() => setRevealed(false)}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setRevealed(!revealed)}
                    title={revealed ? 'Ẩn mã token' : 'Hiển thị mã token'}
                  >
                    {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => copy('token', token)}
                  >
                    {copied === 'token' ? <Check size={13} /> : <Copy size={13} />}
                    <span>{copied === 'token' ? t('mcp.tokenCopied') : t('mcp.copyToken')}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    title={t('mcp.regenerateWarning')}
                    onClick={() => run(async () => setToken(await dbHelper.mcpRegenerateToken()))}
                  >
                    <RefreshCw size={13} />
                    <span>{t('mcp.regenerate')}</span>
                  </button>
                </div>
                <p className="mcp-hint">{t('mcp.tokenInConfigWarning')}</p>
              </div>

              {/* AI Client Configuration Card */}
              <div className="mcp-card">
                <div className="mcp-card-header">
                  <span className="mcp-card-title">
                    <Terminal size={13} />
                    <span>{t('mcp.config')}</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => copy('config', configSnippet)}
                  >
                    {copied === 'config' ? <Check size={12} /> : <Copy size={12} />}
                    <span>
                      {copied === 'config'
                        ? t('mcp.tokenCopied')
                        : activeVariant.isCommand
                          ? t('mcp.copyCommand')
                          : t('mcp.copyConfig')}
                    </span>
                  </button>
                </div>

                <div className="mcp-pick-row">
                  <span className="mcp-pick-label">{t('mcp.pickClient')}:</span>
                  <div className="mcp-client-tabs">
                    {MCP_CLIENTS.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`mcp-client-tab ${c.id === activeClient.id ? 'active' : ''}`}
                        onClick={() => pickClient(c.id)}
                      >
                        {t(c.labelKey)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mcp-pick-row">
                  <span className="mcp-pick-label">{t('mcp.pickTransport')}:</span>
                  <div className="mcp-client-tabs">
                    {(['http', 'stdio'] as const).map((tr) => (
                      <button
                        key={tr}
                        type="button"
                        className={`mcp-client-tab ${tr === transport ? 'active' : ''}`}
                        onClick={() => pickTransport(tr)}
                      >
                        {tr === 'http' ? t('mcp.transportHttp') : t('mcp.transportStdio')}
                      </button>
                    ))}
                  </div>
                </div>

                <p className="mcp-hint">{t(activeVariant.targetKey)}</p>

                <div className="mcp-config-box">
                  <pre className="mcp-config">{configSnippet}</pre>
                </div>

                <p className="mcp-warn">{t('mcp.configMismatch')}</p>
              </div>
            </div>
          )}

          {/* TAB 2: Shared Databases & Security Policies */}
          {activeTab === 'databases' && (
            <div className="mcp-tab-content">
              {/* Connections Card */}
              <div className="mcp-card">
                <div className="mcp-card-header">
                  <span className="mcp-card-title">
                    <Database size={13} />
                    <span>{t('mcp.shared')}</span>
                  </span>
                  {connections.length > 0 && (
                    <span className="mcp-hint">
                      {sharedCount}/{connections.length} kết nối đang mở
                    </span>
                  )}
                </div>
                <p className="mcp-hint">{t('mcp.sharedHint')} {t('mcp.sharedReach')}</p>

                {connections.length === 0 ? (
                  <p className="mcp-empty">{t('mcp.sharedEmpty')}</p>
                ) : (
                  <ul className="mcp-conn-list">
                    {connections.map((c) => (
                      <li
                        key={c.connId}
                        className={`mcp-conn-item ${c.mcpExposed ? 'selected' : ''}`}
                      >
                        <label className="mcp-conn-label">
                          <input
                            type="checkbox"
                            checked={c.mcpExposed}
                            disabled={busy}
                            onChange={(e) =>
                              run(() => dbHelper.setConnectionMcpExposed(c.connId, e.target.checked))
                            }
                          />
                          <span className="mcp-conn-db">{c.db}</span>
                          <span className="mcp-dialect-badge">{c.dialect}</span>
                        </label>
                        {c.mcpExposed && reachLine(c)}
                        {/* Nested under the share tick and only rendered while it is on, because
                            that is the actual relationship: the backend refuses a write tick on a
                            connection nobody shared, and un-sharing clears it. A second top-level
                            checkbox would read as two independent settings and invite the question
                            "is it shared if only the write box is ticked?". */}
                        {c.mcpExposed && (
                          <label className="mcp-conn-write">
                            <input
                              type="checkbox"
                              checked={c.mcpWrite}
                              disabled={busy || c.readOnly}
                              onChange={(e) =>
                                run(() => dbHelper.setConnectionMcpWrite(c.connId, e.target.checked))
                              }
                            />
                            <span>{t('mcp.writeTick')}</span>
                          </label>
                        )}
                        {c.mcpExposed && c.mcpWrite && (
                          <p className="mcp-conn-write-hint">{t('mcp.writeTickHint')}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {connections.length > 0 && sharedCount === 0 && (
                  <p className="mcp-empty">{t('mcp.sharedNone')}</p>
                )}
              </div>

              {/* Security Policy Card */}
              <div className="mcp-card">
                <div className="mcp-card-header">
                  <span className="mcp-card-title">
                    <ShieldCheck size={13} />
                    <span>{t('mcp.securityPolicies')}</span>
                  </span>
                </div>
                <div className="mcp-policy-grid">
                  <div className="mcp-policy-item">
                    <span className="mcp-policy-item-title">{t('mcp.readOnlyShort')}</span>
                    <span className="mcp-policy-item-value">{t('mcp.readOnlyNote')}</span>
                  </div>
                  <div className="mcp-policy-item">
                    <span className="mcp-policy-item-title">{t('mcp.rowLimit')}</span>
                    <span className="mcp-policy-item-value">
                      {ROW_LIMIT_DEFAULT} rows ({ROW_LIMIT_MAX} max)
                    </span>
                  </div>
                  <div className="mcp-policy-item">
                    <span className="mcp-policy-item-title">Query Timeout</span>
                    <span className="mcp-policy-item-value">
                      {TIMEOUT_CEILING_SECS}s ceiling per request
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: Audit Logs */}
          {activeTab === 'logs' && (
            <div className="mcp-tab-content">
              <div className="mcp-card">
                <div className="mcp-card-header">
                  <span className="mcp-card-title">
                    <Activity size={13} />
                    <span>{t('mcp.log')} ({shownLog.length})</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setLogSource(logSource === 'memory' ? 'file' : 'memory')}
                  >
                    <span>{logSource === 'memory' ? t('mcp.logSourceFile') : t('mcp.logSourceSession')}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    // Clearing empties the in-memory log only. Offering it over the disk view would
                    // promise to erase an audit trail that this button does not touch.
                    disabled={logSource === 'file' || log.length === 0}
                    onClick={() =>
                      run(async () => {
                        await dbHelper.mcpAuditClear();
                        setLog([]);
                      })
                    }
                  >
                    <Trash2 size={12} />
                    <span>{t('mcp.logClear')}</span>
                  </button>
                </div>
                <p className="mcp-hint">
                  {logSource === 'memory' ? t('mcp.logMemoryOnly') : t('mcp.logFileHint')}
                </p>
                {logSource === 'file' && !!fileInfo?.unreadable && (
                  <p className="mcp-reach">{t('mcp.logUnreadable', { n: fileInfo.unreadable })}</p>
                )}
                {logSource === 'file' && !!fileInfo?.error && (
                  <p className="mcp-reach">{fileInfo.error}</p>
                )}

                <div className="mcp-log-container">
                  {shownLog.length === 0 ? (
                    <p className="mcp-empty">{t('mcp.logEmpty')}</p>
                  ) : (
                    <ul className="mcp-log">
                      {shownLog.map((e) => (
                        <li
                          // `id` restarts at 1 every run, so it is unique only within one. The
                          // disk log spans runs and needs the timestamp beside it.
                          key={logSource === 'file' ? `${e.at}#${e.id}` : e.id}
                          className={`mcp-log-item ${e.ok ? 'ok' : 'denied'}`}
                        >
                          <span className="mcp-log-time">
                            {new Date(e.at).toLocaleTimeString(i18n.language)}
                          </span>
                          <span className="mcp-log-tool">{e.tool}</span>
                          {e.sql && (
                            <span className="mcp-log-sql" title={e.sql}>
                              {e.sql}
                            </span>
                          )}
                          <span className={`mcp-log-outcome ${e.ok ? 'ok' : 'denied'}`}>
                            {outcomeLabel(e)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
  );

  if (asTab) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', width: '100%', overflow: 'hidden', background: 'var(--win-bg-window)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 18px', borderBottom: '1px solid var(--win-border)', background: 'var(--win-bg-card)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Plug size={15} style={{ color: 'var(--win-accent)' }} />
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
              {t('mcp.title')}
            </span>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
          {content}
        </div>
      </div>
    );
  }

  return (
    <Modal
      title={t('mcp.title')}
      icon={<Plug size={14} />}
      onClose={onClose}
      width="820px"
      maxHeight="92vh"
      zIndex={10000}
    >
      <ModalBody>
        {content}
      </ModalBody>
    </Modal>
  );
}

