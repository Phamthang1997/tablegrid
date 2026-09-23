import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Check,
  ChevronRight,
  Clock,
  Copy,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  ListFilter,
  Lock,
  Pencil,
  Plug,
  RefreshCw,
  Rows3,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
} from 'lucide-react';

import { Modal, ModalBody } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { dbHelper } from '../utils/dbHelper';
import type { McpAuditEntry, McpStatus, OpenConnection } from '../utils/dbHelper';
import {
  MCP_CLIENTS,
  mcpClient,
  mcpVariant,
  type McpClientId,
  type McpTransport,
} from '../utils/mcpClients';
import { parsePort, readMcpPrefs, setMcpAutoStart, setMcpPort } from '../utils/mcpPrefs';

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

type Tab = 'server' | 'databases' | 'logs';

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

/** Same calendar day in local time - the disk log spans runs, so a bare time can be days old. */
function isToday(d: Date): boolean {
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

interface Props {
  onClose: () => void;
  asTab?: boolean;
}

export function McpServerSettingsModal({ onClose, asTab = false }: Props) {
  const { t, i18n } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>('server');
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [port, setPort] = useState('');
  /**
   * The user typed into the port box and has not started the server with it yet. While set, a
   * refresh must not put the bound port back over what they typed - toggling a share tick refreshes,
   * and losing a half-entered port to an unrelated click reads as the box ignoring input.
   */
  const portDirty = useRef(false);
  const [token, setToken] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [connections, setConnections] = useState<OpenConnection[]>([]);
  const [log, setLog] = useState<McpAuditEntry[]>([]);
  /**
   * Which log is on screen. The two are genuinely different records, not one filtered two ways:
   * memory holds this run and is cleared by the button, the file holds every run and is not.
   */
  const [logSource, setLogSource] = useState<'memory' | 'file'>('memory');
  const [deniedOnly, setDeniedOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [fileLog, setFileLog] = useState<McpAuditEntry[]>([]);
  const [fileInfo, setFileInfo] = useState<{ unreadable: number; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<'token' | 'config' | 'url' | null>(null);
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
      // A running server's port is a fact, so it always wins; a stopped one only fills an untouched box.
      // While stopped the backend reports its DEFAULT port, not the one the user saved, so the saved
      // pref wins there - otherwise the snippet names a port autostart never binds.
      if (s.running) {
        setPort(String(s.port));
        portDirty.current = false;
      } else if (!portDirty.current) {
        setPort(String(readMcpPrefs().port ?? s.port));
      }
      // Redis is out of MCP scope, so listing it here would offer a switch that does nothing.
      setConnections(conns.filter((c) => c.dialect !== 'redis'));
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const loadFileLog = useCallback(async () => {
    try {
      const r = await dbHelper.mcpAuditFileRead();
      // The file is read oldest-first; the memory log is newest-first, and both views read the same way.
      setFileLog([...r.entries].reverse());
      setFileInfo({ unreadable: r.unreadable, error: r.error });
    } catch {
      // The file view says it is empty; the memory log is unaffected.
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
    void loadFileLog();
  }, [refresh, loadFileLog]);

  // This screen is a tab now, so it can stay open while connections come and go elsewhere. Re-read
  // when the window regains focus and when something announces a database change - no polling.
  useEffect(() => {
    const onChange = () => void refresh();
    window.addEventListener('focus', onChange);
    window.addEventListener('database-restored', onChange);
    return () => {
      window.removeEventListener('focus', onChange);
      window.removeEventListener('database-restored', onChange);
    };
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
  const copy = async (what: 'token' | 'config' | 'url', text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      // Saying "Copied" over an empty clipboard would send the user off to paste nothing.
      setError(String(err));
      return;
    }
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

  const running = !!status?.running;
  const portValue = parsePort(port);
  const portInvalid = !running && port !== '' && portValue === undefined;

  const toggleServer = () =>
    run(async () => {
      if (running) {
        await dbHelper.mcpStop();
        return;
      }
      await dbHelper.mcpStart(portValue);
      portDirty.current = false;
      // Remembered only after the start SUCCEEDED, so a port that cannot bind is never the one
      // autostart tries on the next run.
      setMcpPort(portValue);
    });

  const regenerate = () => {
    setConfirmRegenerate(false);
    void run(async () => {
      try {
        setToken(await dbHelper.mcpRegenerateToken());
      } catch (err) {
        // The new token may already be stored even though the restart failed - show what the
        // keyring holds now rather than the old token, which no longer works.
        void dbHelper.mcpGetToken().then(setToken).catch(() => {});
        throw err;
      }
    });
  };

  const toggleAutoStart = () => {
    const on = !autoStart;
    setAutoStart(on);
    setMcpAutoStart(on);
  };

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
  const sharedCount = connections.filter((c) => c.mcpExposed).length;
  const connName = useMemo(() => new Map(connections.map((c) => [c.connId, c.db])), [connections]);

  const shownLog = useMemo(() => {
    const src = logSource === 'file' ? fileLog : log;
    return deniedOnly ? src.filter((e) => !e.ok) : src;
  }, [logSource, fileLog, log, deniedOnly]);
  const deniedCount = log.filter((e) => !e.ok).length;

  // Built from the port the server is ACTUALLY bound to, never from the default constant: a
  // generated snippet naming a port nothing listens on is worse than no snippet at all.
  const endpoint = status?.url || `http://127.0.0.1:${portValue ?? status?.port ?? ''}/mcp`;
  const configSnippet = activeVariant.build({
    url: endpoint,
    token,
    exePath: status?.exePath ?? '',
    port: (running ? status?.port : portValue) ?? status?.port ?? 0,
  });

  /** What a ticked connection can actually reach, named. */
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

  /** What one log row says on its right-hand side. */
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

  const formatAt = (at: string) => {
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return at;
    return isToday(d)
      ? d.toLocaleTimeString(i18n.language)
      : d.toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'medium' });
  };

  const tabButton = (id: Tab, icon: React.ReactNode, label: string, badge?: number, warn = false) => (
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === id}
      className={`mcp-tab-btn ${activeTab === id ? 'active' : ''}`}
      onClick={() => setActiveTab(id)}
    >
      {icon}
      <span>{label}</span>
      {!!badge && <span className={`mcp-tab-badge ${warn ? 'warn' : ''}`}>{badge}</span>}
    </button>
  );

  // ---- Server tab ------------------------------------------------------------------------------

  const serverTab = (
    <div className="mcp-grid">
      <div className="mcp-col">
        <section className="mcp-card">
          <header className="mcp-card-header">
            <span className="mcp-card-title">
              <Server size={13} />
              <span>{t('mcp.serverCard')}</span>
            </span>
          </header>

          <div className="mcp-field">
            <label className="mcp-field-label" htmlFor="mcp-port">
              {t('mcp.port')}
            </label>
            <div className="mcp-field-row">
              <input
                id="mcp-port"
                type="text"
                inputMode="numeric"
                value={port}
                onChange={(e) => {
                  portDirty.current = true;
                  setPort(e.target.value.replace(/[^0-9]/g, '').slice(0, 5));
                }}
                disabled={running || busy}
                aria-invalid={portInvalid}
                className={`form-input mcp-port ${portInvalid ? 'invalid' : ''}`}
              />
              <span className="mcp-hint">{running ? t('mcp.portLocked') : t('mcp.portHint')}</span>
            </div>
            {portInvalid && <p className="mcp-error">{t('mcp.portInvalid')}</p>}
          </div>

          <div className="mcp-field">
            <span className="mcp-field-label">{t('mcp.endpoint')}</span>
            <div className="mcp-field-row">
              <code className={`mcp-endpoint ${running ? '' : 'off'}`}>{endpoint}</code>
              <button
                type="button"
                className="btn btn-secondary mcp-icon-btn"
                disabled={!running}
                title={t('mcp.copyUrl')}
                aria-label={t('mcp.copyUrl')}
                onClick={() => void copy('url', endpoint)}
              >
                {copied === 'url' ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
          </div>

          <div className="mcp-switch-row">
            <button
              type="button"
              role="switch"
              aria-checked={autoStart}
              aria-label={t('mcp.autoStart')}
              className={`cm-switch ${autoStart ? 'on' : ''}`}
              onClick={toggleAutoStart}
            />
            <span className="mcp-switch-text">{t('mcp.autoStart')}</span>
          </div>
        </section>

        <section className="mcp-card">
          <header className="mcp-card-header">
            <span className="mcp-card-title">
              <KeyRound size={13} />
              <span>{t('mcp.token')}</span>
            </span>
            <button
              type="button"
              className="btn btn-secondary mcp-btn-sm"
              disabled={busy}
              title={t('mcp.regenerateWarning')}
              onClick={() => setConfirmRegenerate(true)}
            >
              <RefreshCw size={12} />
              <span>{t('mcp.regenerate')}</span>
            </button>
          </header>
          <div className="mcp-field-row">
            <input
              type={revealed ? 'text' : 'password'}
              readOnly
              aria-label={t('mcp.token')}
              className="form-input mcp-token-input"
              value={token}
            />
            <button
              type="button"
              className="btn btn-secondary mcp-icon-btn"
              onClick={() => setRevealed((r) => !r)}
              title={revealed ? t('mcp.hideToken') : t('mcp.showToken')}
              aria-label={revealed ? t('mcp.hideToken') : t('mcp.showToken')}
            >
              {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <button
              type="button"
              className="btn btn-secondary mcp-icon-btn"
              disabled={!token}
              title={t('mcp.copyToken')}
              aria-label={t('mcp.copyToken')}
              onClick={() => void copy('token', token)}
            >
              {copied === 'token' ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
          <p className="mcp-hint">{t('mcp.tokenInConfigWarning')}</p>
        </section>
      </div>

      <section className="mcp-card mcp-config-card">
        <header className="mcp-card-header">
          <span className="mcp-card-title">
            <Terminal size={13} />
            <span>{t('mcp.config')}</span>
          </span>
        </header>

        <div className="mcp-pick-grid">
          <span className="mcp-field-label">{t('mcp.pickClient')}</span>
          <div className="mcp-seg" role="radiogroup">
            {MCP_CLIENTS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={c.id === activeClient.id}
                className={c.id === activeClient.id ? 'on' : ''}
                onClick={() => pickClient(c.id)}
              >
                {t(c.labelKey)}
              </button>
            ))}
          </div>
          <span className="mcp-field-label">{t('mcp.pickTransport')}</span>
          <div className="mcp-seg" role="radiogroup">
            {(['http', 'stdio'] as const).map((tr) => (
              <button
                key={tr}
                type="button"
                role="radio"
                aria-checked={tr === transport}
                className={tr === transport ? 'on' : ''}
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
          <button
            type="button"
            className="btn btn-secondary mcp-btn-sm mcp-config-copy"
            onClick={() => void copy('config', configSnippet)}
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

        {transport === 'http' && !running && <p className="mcp-warn">{t('mcp.configNotRunning')}</p>}
        <p className="mcp-hint">{t('mcp.configMismatch')}</p>
      </section>
    </div>
  );

  // ---- Databases tab ---------------------------------------------------------------------------

  const policies: { icon: React.ReactNode; title: string; value: string }[] = [
    { icon: <Lock size={13} />, title: t('mcp.readOnlyShort'), value: t('mcp.readOnlyNote') },
    { icon: <Pencil size={13} />, title: t('mcp.writePolicy'), value: t('mcp.writePolicyNote') },
    {
      icon: <Rows3 size={13} />,
      title: t('mcp.rowLimit'),
      value: t('mcp.rowLimitValue', { n: ROW_LIMIT_DEFAULT, max: ROW_LIMIT_MAX }),
    },
    {
      icon: <Clock size={13} />,
      title: t('mcp.timeLimitTitle'),
      value: t('mcp.timeLimitValue', { n: TIMEOUT_CEILING_SECS }),
    },
  ];

  const databasesTab = (
    <>
      <section className="mcp-card">
        <header className="mcp-card-header">
          <span className="mcp-card-title">
            <Database size={13} />
            <span>{t('mcp.shared')}</span>
          </span>
          {connections.length > 0 && (
            <span className="mcp-count">
              {t('mcp.sharedCount', { n: sharedCount, total: connections.length })}
            </span>
          )}
        </header>
        <p className="mcp-hint">
          {t('mcp.sharedHint')} {t('mcp.sharedReach')}
        </p>

        {connections.length === 0 ? (
          <p className="mcp-empty">{t('mcp.sharedEmpty')}</p>
        ) : (
          <ul className="mcp-conn-list">
            {connections.map((c) => (
              <li key={c.connId} className={`mcp-conn-item ${c.mcpExposed ? 'selected' : ''}`}>
                <div className="mcp-conn-main">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={c.mcpExposed}
                    aria-label={t('mcp.shareSwitch', { db: c.db })}
                    disabled={busy}
                    className={`cm-switch ${c.mcpExposed ? 'on' : ''}`}
                    onClick={() => run(() => dbHelper.setConnectionMcpExposed(c.connId, !c.mcpExposed))}
                  />
                  <span className="mcp-conn-db" title={c.db}>
                    {c.db}
                  </span>
                  {c.schema && <span className="mcp-conn-schema">{c.schema}</span>}
                  <span className="mcp-dialect-badge">{c.dialect}</span>
                  {c.readOnly && (
                    <span className="mcp-dialect-badge ro" title={t('mcp.connReadOnlyHint')}>
                      <Lock size={9} />
                      {t('mcp.connReadOnly')}
                    </span>
                  )}
                </div>
                {c.mcpExposed && reachLine(c)}
                {/* Nested under the share switch and only rendered while it is on, because that is
                    the actual relationship: the backend refuses a write tick on a connection nobody
                    shared, and un-sharing clears it. A second top-level switch would read as two
                    independent settings. */}
                {c.mcpExposed && (
                  <label className={`mcp-conn-write ${c.readOnly ? 'disabled' : ''}`}>
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
          <p className="mcp-hint mcp-center">{t('mcp.sharedNone')}</p>
        )}
      </section>

      <section className="mcp-card">
        <header className="mcp-card-header">
          <span className="mcp-card-title">
            <ShieldCheck size={13} />
            <span>{t('mcp.securityPolicies')}</span>
          </span>
        </header>
        <div className="mcp-policy-grid">
          {policies.map((p) => (
            <div key={p.title} className="mcp-policy-item">
              <span className="mcp-policy-item-title">
                {p.icon}
                {p.title}
              </span>
              <span className="mcp-policy-item-value">{p.value}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );

  // ---- Logs tab --------------------------------------------------------------------------------

  const logsTab = (
    <section className="mcp-card mcp-log-card">
      <header className="mcp-card-header">
        <div className="mcp-seg" role="radiogroup">
          <button
            type="button"
            role="radio"
            aria-checked={logSource === 'memory'}
            className={logSource === 'memory' ? 'on' : ''}
            onClick={() => setLogSource('memory')}
          >
            {t('mcp.logSourceSession')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={logSource === 'file'}
            className={logSource === 'file' ? 'on' : ''}
            onClick={() => setLogSource('file')}
          >
            {t('mcp.logSourceFile')}
          </button>
        </div>
        <div className="mcp-toolbar">
          <button
            type="button"
            className={`btn btn-secondary ${deniedOnly ? 'mcp-btn-on' : ''}`}
            aria-pressed={deniedOnly}
            onClick={() => setDeniedOnly((v) => !v)}
          >
            <ListFilter size={12} />
            <span>{t('mcp.logDeniedOnly')}</span>
          </button>
          {logSource === 'file' ? (
            <button type="button" className="btn btn-secondary" onClick={() => void loadFileLog()}>
              <RefreshCw size={12} />
              <span>{t('mcp.refresh')}</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              // Clearing empties the in-memory log only. Offering it over the disk view would promise
              // to erase an audit trail that this button does not touch.
              disabled={log.length === 0 || busy}
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
          )}
        </div>
      </header>
      <p className="mcp-hint">{logSource === 'memory' ? t('mcp.logMemoryOnly') : t('mcp.logFileHint')}</p>
      {logSource === 'file' && !!fileInfo?.unreadable && (
        <p className="mcp-warn">{t('mcp.logUnreadable', { n: fileInfo.unreadable })}</p>
      )}
      {logSource === 'file' && !!fileInfo?.error && <p className="mcp-error">{fileInfo.error}</p>}

      {shownLog.length === 0 ? (
        <p className="mcp-empty">{t('mcp.logEmpty')}</p>
      ) : (
        <ul className="mcp-log">
          {shownLog.map((e) => {
            // `id` restarts at 1 every run, so it is unique only within one. The disk log spans runs
            // and needs the timestamp beside it.
            const key = logSource === 'file' ? `${e.at}#${e.id}` : String(e.id);
            const open = expanded === key;
            const db = e.connId ? connName.get(e.connId) : undefined;
            const hasDetail = !!(e.sql || e.message || e.connId);
            return (
              <li key={key} className={`mcp-log-item ${e.ok ? 'ok' : 'denied'} ${open ? 'open' : ''}`}>
                <button
                  type="button"
                  className="mcp-log-row"
                  aria-expanded={hasDetail ? open : undefined}
                  disabled={!hasDetail}
                  onClick={() => setExpanded(open ? null : key)}
                >
                  <ChevronRight size={12} className="mcp-log-chevron" />
                  <span className="mcp-log-time">{formatAt(e.at)}</span>
                  <span className="mcp-log-tool">{e.tool}</span>
                  <span className="mcp-log-sql">{e.sql ?? e.message ?? ''}</span>
                  <span className={`mcp-log-outcome ${e.ok ? 'ok' : 'denied'}`}>{outcomeLabel(e)}</span>
                </button>
                {open && (
                  <div className="mcp-log-detail">
                    {e.connId && (
                      <div className="mcp-log-meta">
                        <span>{t('mcp.logConnection')}</span>
                        <code>{db ?? e.connId}</code>
                      </div>
                    )}
                    {!e.ok && e.message && <p className="mcp-log-message">{e.message}</p>}
                    {e.sql && <pre className="mcp-log-full-sql">{e.sql}</pre>}
                    {e.sqlTruncated && <p className="mcp-hint">{t('mcp.logSqlTruncated')}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  // ---- Frame -----------------------------------------------------------------------------------

  const statusPill = (
    <span className={`mcp-status-pill ${running ? 'on' : ''}`}>
      <span className="mcp-dot" />
      {running ? t('mcp.statusRunningShort') : t('mcp.statusStopped')}
    </span>
  );

  const controls = (
    <div className="mcp-head-actions">
      {statusPill}
      <button
        type="button"
        className="btn btn-secondary mcp-icon-btn"
        title={t('mcp.refresh')}
        aria-label={t('mcp.refresh')}
        disabled={busy}
        onClick={() => void run(async () => {})}
      >
        <RefreshCw size={13} />
      </button>
      <button
        type="button"
        className={running ? 'btn btn-secondary mcp-power' : 'btn btn-primary mcp-power'}
        onClick={toggleServer}
        disabled={busy || (!running && (portInvalid || port === ''))}
      >
        {running ? t('mcp.stop') : t('mcp.start')}
      </button>
    </div>
  );

  const content = (
    <div className="mcp-container">
      <div className="mcp-tabs-header" role="tablist">
        {tabButton('server', <Server size={13} />, t('mcp.tabServer'))}
        {tabButton('databases', <Database size={13} />, t('mcp.tabDatabases'), sharedCount)}
        {tabButton('logs', <Activity size={13} />, t('mcp.tabLogs'), deniedCount || log.length, deniedCount > 0)}
      </div>

      {error && (
        <p className="mcp-error mcp-error-box" role="alert">
          {error}
        </p>
      )}

      {activeTab === 'server' && serverTab}
      {activeTab === 'databases' && databasesTab}
      {activeTab === 'logs' && logsTab}

      <ConfirmDialog
        open={confirmRegenerate}
        title={t('mcp.regenerateConfirmTitle')}
        message={t('mcp.regenerateWarning')}
        confirmLabel={t('mcp.regenerate')}
        danger
        zIndex={10001}
        onConfirm={regenerate}
        onCancel={() => setConfirmRegenerate(false)}
      />
    </div>
  );

  if (asTab) {
    return (
      <div className="mcp-page">
        <div className="mcp-page-head">
          <div className="mcp-page-title">
            <Plug size={15} />
            <div>
              <h2>{t('mcp.title')}</h2>
              <p>{t('mcp.subtitle')}</p>
            </div>
          </div>
          {controls}
        </div>
        <div className="mcp-page-body">{content}</div>
      </div>
    );
  }

  return (
    <Modal
      title={t('mcp.title')}
      icon={<Plug size={14} />}
      headerExtra={controls}
      onClose={onClose}
      width="880px"
      maxHeight="92vh"
      zIndex={10000}
    >
      <ModalBody>{content}</ModalBody>
    </Modal>
  );
}
