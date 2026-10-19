import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { BarChart3, Check, Database, Lock, Plus, Search, Trash2, X } from 'lucide-react';
import { PostgresIcon, MySqlIcon, RedisIcon, SqliteIcon, DuckDbIcon } from './DbIcons';
import { isFileDb } from '../utils/dbCaps';
import { dbHelper } from '../utils/dbHelper';
import type { DbConnectionConfig } from '../utils/dbHelper';
import { loadSavedProfiles } from '../utils/connectProfile';
import type { SavedProfile } from './ConnectionManager';
import { scopeKey } from '../utils/connKey';
import { envLabelKey, normalizeEnv, type ConnEnv } from '../utils/connEnv';

/**
 * The Quick Switcher: changing **connection** or **database** straight from the title bar.
 *
 * It replaces the old inline popup in `TitleBar.tsx`, which listed only the current server's databases
 * — reaching another connection meant going back to the Connection Manager screen. With N connections
 * × N databases (§4.3 of `docs/multi-connection-plan.md`) that was the slowest point of the daily
 * workflow.
 *
 * Two tabs rather than one merged list: a flat list mixing "connections" with "databases" makes two
 * things with **different consequences** look alike — picking a connection changes the whole
 * workspace, picking a database opens another connection on the same server. Tabs separate them
 * without needing a caption.
 *
 * Every style lives in `index.css` (`.qs-*`), none inline: the old block had ~40 style objects spread
 * through its JSX, so changing one spacing meant editing many places, and none of them followed the
 * theme.
 */

const DIALECT_ICON: Record<string, React.FC<{ size?: number }>> = {
  sqlite: SqliteIcon,
  postgres: PostgresIcon,
  mysql: MySqlIcon,
  redis: RedisIcon,
  duckdb: DuckDbIcon,
};

/**
 * The file name of a SQLite path.
 *
 * A full path (`C:\laragon\data\sqllite\chinook.db`) fills the whole sub-line of a 340px popover, and
 * the part worth reading — the file name — is at the end, i.e. the part that gets cut. The full path
 * stays in the tooltip.
 */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** An open connection, joining the backend registry with what only the frontend knows (label, environment). */
export interface SwitcherConn {
  connId: string;
  db: string;
  dbType: 'sqlite' | 'postgres' | 'mysql' | 'duckdb' | 'redis';
  profileName: string;
  color: string;
  env: ConnEnv;
  readOnly?: boolean;
  config: DbConnectionConfig | null;
}

interface QuickSwitcherPopoverProps {
  /** The position, precomputed from the database button's getBoundingClientRect. */
  anchor: { top: number; left: number };
  /** The connection being viewed — its row shows a tick and is not clickable. */
  activeConnId: string;
  /** The database being viewed, so it can be marked in the Databases tab. */
  activeDbName?: string;
  openConns: SwitcherConn[];
  onSelectConnection: (connId: string) => void;
  onConnectSavedProfile: (profile: SavedProfile) => void;
  onOpenDatabase: (name: string) => void;
  onCreateDatabase: () => void;
  onDropDatabase: (name: string) => void;
  onNewConnection: () => void;
  onOpenAllDbStats: () => void;
  onClose: () => void;
}

export const QuickSwitcherPopover: React.FC<QuickSwitcherPopoverProps> = ({
  anchor,
  activeConnId,
  activeDbName,
  openConns,
  onSelectConnection,
  onConnectSavedProfile,
  onOpenDatabase,
  onCreateDatabase,
  onDropDatabase,
  onNewConnection,
  onOpenAllDbStats,
  onClose,
}) => {
  const { t } = useTranslation();
  // The Connections tab opens first: it is the new thing this popup exists to do, and the database
  // list is still one click away with its count right on the tab.
  const [tab, setTab] = useState<'conns' | 'dbs'>('conns');
  const [filter, setFilter] = useState('');
  const [dbList, setDbList] = useState<string[]>([]);
  const [dbLoading, setDbLoading] = useState(true);
  /**
   * Each connection's latency, measured once when the popup opens.
   *
   * Not repeated on a timer: this dialog lives for a few seconds, and a `SELECT 1` every few seconds
   * against *every* connection is constant noise sent to servers the user is not even looking at. This
   * number answers "is that other connection alive, and how fast" at the moment it opens, which is
   * exactly when it matters.
   */
  const [pings, setPings] = useState<Map<string, { ok: boolean; latencyMs: number }>>(new Map());
  const searchRef = useRef<HTMLInputElement>(null);

  // Read once on open. The profiles are in localStorage so there is nothing to wait for; the database
  // list is a real query against the connection being viewed.
  const savedProfiles = useMemo(() => loadSavedProfiles(), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await dbHelper.listDatabases(activeConnId);
        if (alive) setDbList(res.databases || []);
      } catch {
        /* a server that refuses to list -> an empty list, not a blocking error */
      } finally {
        if (alive) setDbLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeConnId]);

  // Run alongside the database list rather than after it: the two calls are independent, and pinging
  // a distant server can take longer than a local `listDatabases`.
  useEffect(() => {
    let alive = true;
    dbHelper
      .pingConnections()
      .then((m) => {
        if (alive) setPings(m);
      })
      .catch(() => {
        /* a failed ping just leaves the rows without a number, not a blocking error */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const q = filter.toLowerCase().trim();

  /**
   * Saved profiles that are **not** open, compared by `scopeKey` — server plus database, not server
   * alone.
   *
   * `connKey` by itself would treat a profile pointing at `test` as "already open" while `sakila` is
   * open on the same server, so clicking it would do nothing and leave the user wondering why.
   */
  const openScopes = useMemo(
    () => new Set(openConns.map((c) => scopeKey(c.config, c.config?.database ?? c.db))),
    [openConns],
  );

  const conns = openConns.filter((c) => {
    if (!q) return true;
    return (
      c.db.toLowerCase().includes(q) ||
      c.profileName.toLowerCase().includes(q) ||
      (c.config?.host || '').toLowerCase().includes(q)
    );
  });

  /**
   * The unopened profiles — **before** the search box filters them.
   *
   * Kept apart from the displayed list because the tab's number has to mean "how many things are in
   * this tab", not "how many match what is being typed". The tab used to count `openConns +
   * savedProfiles` raw, i.e. counting the already-open profiles a second time: 2 connections + 4
   * profiles showed **6** on the tab while the list below it showed 2 + 2.
   */
  const unopened = savedProfiles.filter(
    (p) => !openScopes.has(scopeKey(p.config as DbConnectionConfig, p.config?.database)),
  );

  const profiles = unopened.filter((p) => {
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      (p.config?.host || '').toLowerCase().includes(q) ||
      (p.group || '').toLowerCase().includes(q)
    );
  });

  const dbs = dbList.filter((d) => d.toLowerCase().includes(q));

  /**
   * The logo tile, reusing Connection Manager's `cm-badge` rather than a plain icon.
   *
   * Not for the sake of matching: a per-dialect background gives each row a colour anchor, so scanning
   * the list identifies the engine before any text is read — exactly what a connection list needs.
   */
  const renderBadge = (dialect: string) => {
    const Icon = DIALECT_ICON[dialect];
    return (
      <span className={`cm-badge sm ${dialect}`}>
        {Icon ? <Icon size={13} /> : <Database size={13} />}
      </span>
    );
  };

  return createPortal(
    <>
      <div className="qs-backdrop" onClick={onClose} />
      <div className="qs-pop" style={{ top: anchor.top, left: anchor.left }} role="dialog">
        {/* Header Segmented Tabs */}
        <div className="qs-header">
          <div className="qs-seg" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'conns'}
              className={`qs-seg-btn${tab === 'conns' ? ' is-on' : ''}`}
              onClick={() => setTab('conns')}
            >
              <span>{t('quickSwitcher.tabConnections')}</span>
              <span className="qs-tab-count">{openConns.length + unopened.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'dbs'}
              className={`qs-seg-btn${tab === 'dbs' ? ' is-on' : ''}`}
              onClick={() => setTab('dbs')}
            >
              <span>{t('quickSwitcher.tabDatabases')}</span>
              <span className="qs-tab-count">{dbLoading ? '…' : dbList.length}</span>
            </button>
          </div>
        </div>

        {/* Integrated Search Box */}
        <div className="qs-search">
          <div className="qs-search-box">
            <Search size={13} className="qs-search-icon" />
            <input
              ref={searchRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={
                tab === 'conns' ? t('quickSwitcher.searchConnections') : t('quickSwitcher.searchDatabases')
              }
            />
            {filter && (
              <button
                type="button"
                className="qs-search-clear"
                onClick={() => {
                  setFilter('');
                  searchRef.current?.focus();
                }}
                title={t('common.clear')}
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        <div className="qs-list">
          {tab === 'conns' ? (
            <>
              <div className="qs-group">{t('quickSwitcher.groupOpen', { n: conns.length })}</div>
              {conns.length === 0 && <div className="qs-empty">{t('quickSwitcher.noMatch')}</div>}
              {conns.map((c) => {
                const isActive = c.connId === activeConnId;
                const env = normalizeEnv(c.env);
                const sub = isFileDb(c.dbType) ? fileName(c.db) : c.db;
                const ping = pings.get(c.connId);
                return (
                  <button
                    type="button"
                    key={c.connId}
                    className={`qs-row${isActive ? ' is-on' : ''}`}
                    onClick={() => {
                      if (!isActive) onSelectConnection(c.connId);
                      onClose();
                    }}
                    title={[
                      c.profileName,
                      c.db,
                      c.config?.host,
                      env !== 'none' ? t(envLabelKey(env)) : '',
                      ping && !ping.ok ? t('quickSwitcher.pingFailed') : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  >
                    {renderBadge(c.dbType)}
                    <span className="qs-label">
                      <span className="qs-name">{c.profileName}</span>
                      <span className="qs-sub">{sub}</span>
                    </span>
                    {/* With no number yet, NO space is reserved: a column of figures blinking into
                        existence a few hundred ms later makes the whole list jump. A failed ping shows
                        a red dash — a dead connection is information, not missing data. */}
                    {ping && (
                      <span className={`qs-ping${ping.ok ? '' : ' is-dead'}`}>
                        {ping.ok ? t('quickSwitcher.ms', { n: ping.latencyMs }) : '—'}
                      </span>
                    )}
                    {env !== 'none' && (
                      <span className={`qs-env-chip qs-env-${env}`}>{t(envLabelKey(env))}</span>
                    )}
                    {c.readOnly && (
                      <span className="qs-ro" title={t('app.readOnlyOn')}>
                        <Lock size={11} strokeWidth={2.4} />
                      </span>
                    )}
                    {isActive && <Check size={14} className="qs-check-on" />}
                  </button>
                );
              })}

              <div className="qs-group">{t('quickSwitcher.groupSaved', { n: profiles.length })}</div>
              {profiles.length === 0 && (
                <div className="qs-empty">{t('quickSwitcher.allProfilesOpen')}</div>
              )}
              {profiles.map((p) => {
                const env = normalizeEnv(p.env);
                const raw =
                  p.config?.database || p.config?.sqlitePath || p.config?.host || p.type;
                return (
                  <button
                    type="button"
                    key={p.id}
                    className="qs-row"
                    onClick={() => {
                      onConnectSavedProfile(p);
                      onClose();
                    }}
                    title={[p.name, raw, p.config?.host, env !== 'none' ? t(envLabelKey(env)) : '']
                      .filter(Boolean)
                      .join(' · ')}
                  >
                    {renderBadge(p.type)}
                    <span className="qs-label">
                      <span className="qs-name">{p.name}</span>
                      <span className="qs-sub">{isFileDb(p.type) ? fileName(raw) : raw}</span>
                    </span>
                    {env !== 'none' ? (
                      <span className={`qs-env-chip qs-env-${env}`}>{t(envLabelKey(env))}</span>
                    ) : (
                      p.group && <span className="qs-group-chip">{p.group}</span>
                    )}
                  </button>
                );
              })}
            </>
          ) : (
            <>
              {dbLoading ? (
                <div className="qs-empty">{t('quickSwitcher.loadingDatabases')}</div>
              ) : dbs.length === 0 ? (
                <div className="qs-empty">{t('quickSwitcher.noDatabases')}</div>
              ) : (
                dbs.map((db) => {
                  const isActive = db === activeDbName;
                  return (
                    <div key={db} className={`qs-row qs-row-db${isActive ? ' is-on' : ''}`}>
                      <button
                        type="button"
                        className="qs-row-main"
                        onClick={() => {
                          if (!isActive) onOpenDatabase(db);
                          onClose();
                        }}
                      >
                        <span className="qs-db-dot" aria-hidden />
                        <span className="qs-label">
                          <span className="qs-name">{db}</span>
                        </span>
                        {isActive && <Check size={14} className="qs-check-on" />}
                      </button>
                      {/* The database being viewed cannot be dropped: the server would refuse while a
                          connection to it is open, so offering the button invites a certain error. */}
                      {!isActive && (
                        <button
                          type="button"
                          className="qs-drop"
                          title={t('quickSwitcher.dropDatabase', { name: db })}
                          onClick={() => {
                            onDropDatabase(db);
                            onClose();
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>

        <div className="qs-footer">
          {tab === 'conns' ? (
            <button
              type="button"
              className="qs-foot-btn accent"
              onClick={() => {
                onClose();
                onNewConnection();
              }}
            >
              <Plus size={13} />
              <span>{t('quickSwitcher.newConnection')}</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                className="qs-foot-btn accent"
                onClick={() => {
                  onClose();
                  onCreateDatabase();
                }}
              >
                <Plus size={13} />
                <span>{t('quickSwitcher.createDatabase')}</span>
              </button>
              <button
                type="button"
                className="qs-foot-btn"
                onClick={() => {
                  onClose();
                  onOpenAllDbStats();
                }}
              >
                <BarChart3 size={13} />
                <span>{t('quickSwitcher.allDbStats')}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
};
