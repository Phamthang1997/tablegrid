import React, { useState, useEffect, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  Minus, Square, X, Plus, Unplug, FileCode, HardDriveDownload, HardDriveUpload,
  PanelLeft, SunMoon, RotateCw, Info, Keyboard, Check, Database,
  GitBranch, PanelBottom, Bot, ChevronRight, ChevronLeft, BookOpen, Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { SUPPORTED_LANGUAGES, currentLanguage } from '../i18n';
import { DbConnectionStatusPill } from './DbConnectionStatusPill';
import { TxControl } from './TxControl';
import { SafeModeControl } from './SafeModeControl';
import { JobsTray } from './JobsTray';
import { ConnectionInfoPopover } from './ConnectionInfoPopover';
import { QuickSwitcherPopover, type SwitcherConn } from './QuickSwitcherPopover';
import type { SavedProfile } from './ConnectionManager';
import { dbHelper } from '../utils/dbHelper';
import type { ConnectionStatus } from '../utils/dbHelper';
import type { ConnEnv } from '../utils/connEnv';
import { CreateDatabaseModal } from './CreateDatabaseModal';
import { ConfirmDialog } from './ConfirmDialog';

/** Stable empty default for the `openConns` prop: a fresh `[]` each render breaks memoisation downstream. */
const NO_CONNS: SwitcherConn[] = [];

interface TitleBarProps {
  hasConnection: boolean;
  /** The connection on screen — `TxControl` filters `tx-state-changed` events on this id. */
  connId?: string;
  /** The viewed connection's `connKey(config)` — Safe Mode is stored per server. See SafeModeControl.tsx. */
  connKey?: string;
  readOnly?: boolean;
  onToggleReadOnly?: () => void;
  activeConnectionInfo?: {
    host?: string;
    dbType?: string;
    dbName?: string;
    version?: string;
    tls?: string;
  };
  /** The connected profile's name and colour, shown and editable in the connection popover. */
  activeProfileName?: string;
  activeProfileColor?: string;
  /** The viewed connection's environment. A field of the profile's own, never inferred from the colour. */
  activeProfileEnv?: ConnEnv;
  onProfileChange?: (patch: { name?: string; color?: string; env?: ConnEnv }) => void;
  theme?: 'dark' | 'light';
  onThemeChange?: (theme: 'dark' | 'light') => void;
  onReconnect?: () => Promise<{ success: boolean; message?: string }>;
  activeTableName?: string | null;
  onNewConnection?: () => void;
  onDisconnect?: () => void;
  onNewQuery?: () => void;
  onExportDatabase?: () => void;
  onImportDatabase?: () => void;
  onToggleSidebar?: () => void;
  onToggleTheme?: () => void;
  onShowShortcuts?: () => void;
  onShowAbout?: () => void;
  onShowWhatsNew?: () => void;
  onToggleTerminal?: () => void;
  /** The AI Copilot panel is open -> the button takes the accent colour. */
  aiOpen?: boolean;
  onToggleAiAssistant?: () => void;
  /** The user picked another database -> the backend has opened it as a NEW connection (`open_database`). */
  onDatabaseOpened?: (connId: string, dbName: string, schema?: string | null) => void;
  /**
   * The open connections, for the Quick Switcher. Passed in rather than read from `list_connections`
   * here: the label, the environment and the config are known only to App (the backend never returns
   * a config, because it carries credentials).
   */
  openConns?: SwitcherConn[];
  onSelectConnection?: (connId: string) => void;
  onConnectSavedProfile?: (profile: SavedProfile) => void;
  onOpenAllDbStats?: () => void;
  onOpenDocs?: () => void;
  onOpenCompare?: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  hasConnection,
  connId,
  connKey = '',
  readOnly = false,
  onToggleReadOnly,
  activeConnectionInfo,
  activeProfileName = '',
  activeProfileColor = '',
  activeProfileEnv = 'none',
  onProfileChange,
  theme: _theme = 'dark',
  onThemeChange: _onThemeChange,
  onReconnect,
  activeTableName,
  onNewConnection,
  onDisconnect,
  onNewQuery,
  onExportDatabase,
  onImportDatabase,
  onToggleSidebar,
  onToggleTheme,
  onShowShortcuts,
  onShowAbout,
  onShowWhatsNew,
  onToggleTerminal,
  aiOpen = false,
  onToggleAiAssistant,
  onDatabaseOpened,
  openConns = NO_CONNS,
  onSelectConnection,
  onConnectSavedProfile,
  onOpenAllDbStats,
  onOpenDocs,
  onOpenCompare,
}) => {
  const { t, i18n } = useTranslation();
  // Cascading menu: the root panel only lists category names; the items of a
  // category live in a submenu that opens to the right on hover.
  const [menuOpen, setMenuOpen] = useState(false);
  const [openCategory, setOpenCategory] = useState<string | null>(null);

  // Database Switcher Popover state
  const [showDbPopover, setShowDbPopover] = useState(false);
  const [dbPopoverPos, setDbPopoverPos] = useState<{ top: number; left: number } | null>(null);
  /** The database button — the popover's anchor, needed even when opened with Ctrl+P, where there is no mouse event. */
  const dbBtnRef = useRef<HTMLButtonElement>(null);
  const [showCreateDbModal, setShowCreateDbModal] = useState(false);
  /** Database awaiting drop confirmation — see handleDropDb. */
  const [dropDbTarget, setDropDbTarget] = useState<string | null>(null);

  // Connection details popover state
  const [showConnPopover, setShowConnPopover] = useState(false);
  const [connPopoverPos, setConnPopoverPos] = useState<{ top: number; left: number } | null>(null);

  // The session's status is asked for here rather than in DbConnectionStatusPill, because both the
  // text in the middle of the title bar and the details popover read one source — the version and TLS
  // in that text used to be hardcoded in App.tsx.
  const [connStatus, setConnStatus] = useState<ConnectionStatus | null>(null);

  useEffect(() => {
    if (!hasConnection) {
      setConnStatus(null);
      return;
    }
    let alive = true;
    const refresh = async () => {
      // Nothing here is visible while the window is minimised or hidden, and this is not a free
      // tick: every one is an IPC round trip plus a `SELECT 1` against the user's database, ten
      // times a minute, for as long as the app is left open. The rest of the cluster is already
      // cached per connection in Rust (`probe_session_info`) for the same reason.
      if (document.hidden) return;
      try {
        const info = await dbHelper.getConnectionStatus();
        if (alive && info.isConnected) setConnStatus(info);
      } catch {
        // A failed ping keeps the previous figures rather than blanking the status cluster.
      }
    };
    refresh();
    const timer = setInterval(refresh, 6000);
    // Coming back to the window must not show a reading up to six seconds stale.
    document.addEventListener('visibilitychange', refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [hasConnection]);

  const handleOpenConnPopover = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!hasConnection) return;
    if (showConnPopover) {
      setShowConnPopover(false);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    // Anchored to the middle of the status cluster and clamped to the screen, so the popover cannot overflow.
    const width = 320;
    const left = Math.min(
      Math.max(10, rect.left + rect.width / 2 - width / 2),
      Math.max(10, window.innerWidth - width - 10),
    );
    setConnPopoverPos({ top: rect.bottom + 6, left });
    setShowConnPopover(true);
  };

  // The database list is loaded by `QuickSwitcherPopover` itself when it opens — no longer prefetched
  // here: doing that made the popup appear only after the query returned, so a click was followed by
  // a wait before anything showed.
  //
  // The position comes from the button's ref rather than `e.currentTarget`: `Ctrl+Shift+P` also opens
  // this popover, and a keyboard has no mouse event to read coordinates from.
  const openDbPopover = () => {
    if (!hasConnection) return;
    const rect = dbBtnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDbPopoverPos({ top: rect.bottom + 6, left: Math.max(10, rect.left - 100) });
    setShowDbPopover(true);
  };

  const handleOpenDbPopover = () => openDbPopover();

  /**
   * The navigation shortcuts, following VS Code's conventions — where the user's reflexes already are.
   *
   *   `Ctrl+Shift+P` → Quick Switcher (VS Code: the Command Palette)
   *   `Ctrl+B`       → toggle the sidebar
   *   `Ctrl+K`       → focus the Sidebar's search box (unchanged; see `Sidebar.tsx`)
   *
   * Plain `Ctrl+P` is deliberately left empty. It used to carry **two** meanings and neither was what
   * the user saw: the menu advertised it as "toggle sidebar" while the Sidebar's listener claimed it
   * first to focus the search box. Now each key has exactly one meaning, and the menu label says what
   * will actually happen.
   *
   * With Shift held, `e.key` for P is `'P'` — so it has to be `toLowerCase()`d before comparing.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'p' && e.shiftKey) {
        e.preventDefault();
        if (showDbPopover) setShowDbPopover(false);
        else openDbPopover();
      } else if (k === 'b' && !e.shiftKey) {
        e.preventDefault();
        onToggleSidebar?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // `openDbPopover` reads `hasConnection` and a ref; the ref is stable, so these are all the real deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDbPopover, hasConnection, onToggleSidebar]);

  const handleSwitchDb = async (name: string) => {
    if (name === activeConnectionInfo?.dbName) return;
    // Picking a database OPENS it as another connection rather than switching this one onto it.
    // Switching replaced the pool, so it had to refuse whenever the current database had
    // uncommitted work — a refusal the user could not clear without losing that work. Opening adds
    // a pool on the same `ServerHandle` (same tunnel, same credentials, no re-auth), so there is
    // nothing to refuse and the transaction on the old database keeps running.
    const res = await dbHelper.openDatabase(connId || '', name);
    if (res.success && res.connId) {
      onDatabaseOpened?.(res.connId, res.database || name, res.schema);
    } else {
      alert(t('sidebar.errOpenDb', { message: res.error || '' }));
    }
  };

  /**
   * Opens the drop-database confirmation.
   *
   * Deliberately NOT `window.confirm`: inside the Tauri webview it is replaced by a call to
   * `plugin:dialog|confirm`, and dialog 2.7.2 only ships `message`/`open`/`save` — the call
   * throws "Command not found" and the user sees nothing at all. `alert()` still works
   * because it maps to `message`. Use the app's ConfirmDialog, like every other delete.
   */
  const handleDropDb = (name: string) => {
    if (readOnly) {
      alert(t('sidebar.errReadOnly'));
      return;
    }
    if (name === activeConnectionInfo?.dbName) {
      alert(t('sidebar.errDropCurrentDb'));
      return;
    }
    setDropDbTarget(name);
  };

  const confirmDropDb = async () => {
    const name = dropDbTarget;
    setDropDbTarget(null);
    if (!name) return;
    const res = await dbHelper.dropDatabase(name);
    if (!res.success) alert(t('sidebar.errDropDb', { message: res.error || '' }));
  };

  // The dialog itself reports its own failure, so there is nothing to do here but close and
  // (unless the user unticked it) open what was just created.
  const handleDbCreated = (name: string, open: boolean) => {
    setShowCreateDbModal(false);
    if (open) handleSwitchDb(name);
  };

  // The text in the middle of the title bar. It prefers the session's real figures and falls back to
  // activeConnectionInfo before the first ping returns. Postgres reports a version like
  // "16.2 (Debian 16.2-1...)", so only the first token is taken, or the rest pushes everything out.
  const statusLine = React.useMemo(() => {
    const host = connStatus?.host || activeConnectionInfo?.host || 'LOCAL';
    const driver = (connStatus?.dbType || activeConnectionInfo?.dbType || '').toUpperCase();
    const version = (connStatus?.serverVersion || activeConnectionInfo?.version || '').split(' ')[0];
    const tls = connStatus?.tlsVersion || activeConnectionInfo?.tls || '';
    const db = connStatus?.database || activeConnectionInfo?.dbName || '';
    const tail = [[driver, version].filter(Boolean).join(' '), tls, db, activeTableName]
      .filter(Boolean)
      .join(' : ');
    return tail ? `${host} | ${tail}` : host;
  }, [connStatus, activeConnectionInfo, activeTableName]);

  useEffect(() => {
    const closeDropdown = () => {
      setMenuOpen(false);
      setOpenCategory(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDropdown();
    };
    window.addEventListener('click', closeDropdown);
    window.addEventListener('contextmenu', closeDropdown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', closeDropdown);
      window.removeEventListener('contextmenu', closeDropdown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const handleMinimize = async () => {
    try {
      const appWindow = getCurrentWindow();
      await appWindow.minimize();
    } catch (error) {
      console.error('Failed to minimize window:', error);
    }
  };

  const handleMaximize = async () => {
    try {
      const appWindow = getCurrentWindow();
      await appWindow.toggleMaximize();
    } catch (error) {
      console.error('Failed to toggle maximize window:', error);
    }
  };

  const handleClose = async () => {
    try {
      const appWindow = getCurrentWindow();
      await appWindow.close();
    } catch (error) {
      console.error('Failed to close window:', error);
    }
  };

  interface MenuItem {
    label: string;
    Icon: LucideIcon;
    onClick?: () => void;
    danger?: boolean;
    disabled?: boolean;
    shortcut?: string;
    separatorBefore?: boolean;
    checked?: boolean;
  }

  const activeLang = currentLanguage();

  const menuCategories: { title: string; items: MenuItem[] }[] = [
    {
      title: t('titlebar.menuConnection'),
      items: [
        { label: t('titlebar.newConnection'), Icon: Plus, onClick: onNewConnection },
        { label: t('titlebar.disconnect'), Icon: Unplug, onClick: onDisconnect, danger: true, disabled: !hasConnection, separatorBefore: true },
      ],
    },
    {
      title: t('titlebar.menuDatabase'),
      items: [
        { label: t('titlebar.newQuery'), Icon: FileCode, onClick: onNewQuery, shortcut: 'Ctrl+T', disabled: !hasConnection },
        { label: t('titlebar.exportDatabase'), Icon: HardDriveDownload, onClick: onExportDatabase, disabled: !hasConnection, separatorBefore: true },
        { label: t('titlebar.importDatabase'), Icon: HardDriveUpload, onClick: onImportDatabase, disabled: !hasConnection },
      ],
    },
    {
      title: t('titlebar.menuView'),
      items: [
        // `Ctrl+B` rather than `Ctrl+P`: the old label was never true, because the Sidebar's listener
        // claimed Ctrl+P first to focus its search box. This label now has a real binding behind it.
        { label: t('titlebar.toggleSidebar'), Icon: PanelLeft, onClick: onToggleSidebar, shortcut: 'Ctrl+B', disabled: !hasConnection },
        { label: t('titlebar.toggleTheme'), Icon: SunMoon, onClick: onToggleTheme },
        { label: t('titlebar.reload'), Icon: RotateCw, onClick: () => window.location.reload(), separatorBefore: true },
      ],
    },
    {
      title: `${t('language.label')} / 言語`,
      items: SUPPORTED_LANGUAGES.map((lang) => ({
        label: `${lang.flag} ${t(lang.labelKey)}`,
        Icon: Check,
        checked: lang.code === activeLang,
        onClick: () => { i18n.changeLanguage(lang.code); },
      })),
    },
    {
      title: t('titlebar.menuHelp'),
      items: [
        { label: t('docs.title'), Icon: BookOpen, onClick: onOpenDocs, shortcut: 'F1' },
        { label: t('titlebar.shortcuts'), Icon: Keyboard, onClick: onShowShortcuts },
        { label: t('titlebar.whatsNew'), Icon: Sparkles, onClick: onShowWhatsNew },
        { label: t('titlebar.about'), Icon: Info, onClick: onShowAbout, separatorBefore: true },
      ],
    },
  ];

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  /**
   * One button of the toolbar cluster. `offline` = still shown while nothing is connected; App.tsx
   * renders ConnectionManager exactly when `!hasConnection`, so this flag is also "does this button
   * mean anything on the connection manager screen" — every button that acts on a database is hidden
   * there outright rather than shown greyed out.
   */
  interface Tool {
    key: string;
    offline?: boolean;
    el: React.ReactNode;
  }

  // The toolbar clusters are built by logical group.
  // A separator appears only between functional groups, never between individual buttons.
  const renderCapsuleGroups = (groups: Tool[][]) => {
    const visibleGroups = groups
      .map(grp => grp.filter(tool => hasConnection || tool.offline))
      .filter(grp => grp.length > 0);

    if (visibleGroups.length === 0) return null;

    return (
      <div className="tb-capsule">
        {visibleGroups.map((grp, grpIdx) => (
          <React.Fragment key={grpIdx}>
            {grpIdx > 0 && <div className="tb-capsule-divider" />}
            <div className="tb-capsule-group">
              {grp.map(tool => (
                <React.Fragment key={tool.key}>{tool.el}</React.Fragment>
              ))}
            </div>
          </React.Fragment>
        ))}
      </div>
    );
  };

  // On the connection screen the sidebar runs to the very top of the window, so the title bar's left
  // corner is no longer the bar's own — the ⋮ button moves to the right cluster. The menu therefore
  // has to open the other way: anchored to the right edge with submenus opening leftwards, or it
  // overflows the screen.
  const menuOnRight = !hasConnection;

  const menuTool: Tool = {
    key: 'menu',
    offline: true,
    el: (
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <button
          className={`tb-capsule-btn ${menuOpen ? 'active' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen(prev => !prev);
            setOpenCategory(null);
          }}
          title={t('titlebar.menu')}
        >
          <span style={{ fontSize: '14px', fontWeight: 700, lineHeight: 1 }}>⋮</span>
        </button>

        {menuOpen && (
          <div
            className={`title-bar-dropdown tb-menu-root ${menuOnRight ? 'tb-menu-flip' : ''}`}
            style={{ top: '42px' }}
            onClick={(e) => e.stopPropagation()}
          >
            {menuCategories.map(cat => (
              <div
                key={cat.title}
                className={`tb-menu-cat ${openCategory === cat.title ? 'open' : ''}`}
                onMouseEnter={() => setOpenCategory(cat.title)}
                onClick={() => setOpenCategory(cat.title)}
              >
                <span className="tb-menu-cat-label">{cat.title}</span>
                {menuOnRight
                  ? <ChevronLeft size={13} className="tb-menu-cat-arrow" />
                  : <ChevronRight size={13} className="tb-menu-cat-arrow" />}

                {openCategory === cat.title && (
                  <div className="title-bar-dropdown tb-menu-sub">
                    {cat.items.map(item => (
                      <React.Fragment key={item.label}>
                        {item.separatorBefore && <div className="title-bar-dropdown-sep" />}
                        <div
                          className={`title-bar-dropdown-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (item.disabled) return;
                            if (item.onClick) item.onClick();
                            setMenuOpen(false);
                            setOpenCategory(null);
                          }}
                        >
                          {item.checked === undefined ? (
                            <item.Icon size={14} className="title-bar-dropdown-icon" />
                          ) : (
                            <span className="title-bar-dropdown-icon" style={{ width: '14px', display: 'inline-flex' }}>
                              {item.checked && <Check size={14} />}
                            </span>
                          )}
                          <span className="title-bar-dropdown-label">{item.label}</span>
                          {item.shortcut && <span className="title-bar-dropdown-shortcut">{item.shortcut}</span>}
                        </div>
                      </React.Fragment>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    ),
  };

  const leftToolGroups: Tool[][] = [
    // Group 1: navigation and the main menu
    [
      {
        key: 'sidebar',
        el: (
          <button className="tb-capsule-btn" onClick={onToggleSidebar} title={t('titlebar.toggleSidebar')}>
            <PanelLeft size={14} />
          </button>
        ),
      },
      ...(menuOnRight ? [] : [menuTool]),
    ],
    // Group 2: connection management and safety modes
    [
      {
        key: 'new-connection',
        el: (
          <button className="tb-capsule-btn" onClick={onNewConnection} title={t('titlebar.newConnection')}>
            <Unplug size={14} />
          </button>
        ),
      },
      {
        key: 'disconnect',
        el: (
          <button className="tb-capsule-btn" onClick={onDisconnect} disabled={!hasConnection} title={t('titlebar.disconnect')}>
            <X size={14} />
          </button>
        ),
      },
      {
        // Read-only is the strictest step of the same "how far does this connection protect me" scale,
        // so it lives inside the Safe Mode menu rather than as a switch of its own: two buttons side by
        // side made the user combine two places to work out what a DELETE would do. See
        // SafeModeControl.tsx.
        key: 'safe-mode',
        el: (
          <SafeModeControl
            connected={hasConnection}
            connKey={connKey}
            readOnly={readOnly}
            onToggleReadOnly={onToggleReadOnly}
            connId={connId}
            dbType={(connStatus?.dbType || activeConnectionInfo?.dbType || '').toLowerCase()}
          />
        ),
      },
    ],
    // Group 3: database tools and the query editor
    [
      {
        key: 'databases',
        el: (
          <button
            ref={dbBtnRef}
            className="tb-capsule-btn"
            onClick={handleOpenDbPopover}
            disabled={!hasConnection}
            title={`${t('titlebar.menuDatabase')} (Ctrl+Shift+P)`}
          >
            <Database size={13} />
          </button>
        ),
      },
      {
        key: 'sql',
        el: (
          <button
            className="tb-capsule-btn tb-capsule-btn-sql"
            onClick={onNewQuery}
            disabled={!hasConnection}
            title={t('titlebar.newQuery')}
          >
            <FileCode size={13} />
            <span>{t('titlebar.sqlButton')}</span>
          </button>
        ),
      },
    ],
  ];

  const rightToolGroups: Tool[][] = [
    // Group 1: the main working tools (Docs, Compare, Terminal, AI Copilot)
    [
      ...(menuOnRight ? [menuTool] : []),
      {
        key: 'docs',
        offline: true,
        el: (
          <button
            className="tb-capsule-btn tb-capsule-btn-docs"
            onClick={onOpenDocs}
            title={t('docs.title') + ' (F1)'}
          >
            <BookOpen size={13} style={{ color: 'var(--win-accent)' }} />
            <span>Docs</span>
          </button>
        ),
      },
      {
        key: 'compare',
        el: (
          <button
            className="tb-capsule-btn"
            disabled={!hasConnection}
            onClick={onOpenCompare}
            title={t('titlebar.schemaCompare')}
          >
            <GitBranch size={13} />
          </button>
        ),
      },
      {
        key: 'terminal',
        el: (
          <button className="tb-capsule-btn" onClick={onToggleTerminal} title={t('titlebar.toggleTerminal')}>
            <PanelBottom size={14} />
          </button>
        ),
      },
      {
        key: 'ai',
        el: (
          <button
            className={`tb-capsule-btn ${aiOpen ? 'is-active-accent' : ''}`}
            onClick={onToggleAiAssistant}
            title={t('app.toggleAiCopilot')}
          >
            <Bot size={14} />
          </button>
        ),
      },
    ],
    // Group 2: system utilities (Shortcuts and Reload)
    [
      {
        key: 'shortcuts',
        offline: true,
        el: (
          <button className="tb-capsule-btn" onClick={onShowShortcuts} title={t('titlebar.shortcuts')}>
            <Keyboard size={13} />
          </button>
        ),
      },
      {
        key: 'reload',
        offline: true,
        el: (
          <button className="tb-capsule-btn" onClick={() => window.location.reload()} title={t('titlebar.reload')}>
            <RotateCw size={13} />
          </button>
        ),
      },
    ],
  ];

  return (
    <div className={`title-bar ${hasConnection ? '' : 'title-bar-flat'}`} style={{ gap: '8px' }}>
      <div className="title-bar-left" style={{ gap: '6px' }}>
        {isMac && (
          <div className="mac-traffic-lights" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginRight: '6px' }}>
            <button className="mac-traffic-btn mac-close" onClick={handleClose} title={t('titlebar.closeWindow')} />
            <button className="mac-traffic-btn mac-minimize" onClick={handleMinimize} title={t('titlebar.minimize')} />
            <button className="mac-traffic-btn mac-maximize" onClick={handleMaximize} title={t('titlebar.maximize')} />
          </div>
        )}

        {renderCapsuleGroups(leftToolGroups)}
      </div>

      {/* Center Status Capsule: Merged Connection Info + Speed Status Pill into 1 single capsule */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0, justifyContent: 'center' }}>
        {hasConnection && (
          <button
            type="button"
            className="tb-status-capsule"
            style={{ margin: 0, gap: '10px', justifyContent: 'center', maxWidth: '750px', padding: '0 14px' }}
            onClick={handleOpenConnPopover}
            title={t('connInfo.openTitle')}
          >
            {activeProfileColor && (
              <span
                aria-hidden
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: activeProfileColor,
                  flexShrink: 0,
                }}
              />
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {statusLine}
            </span>
            <div style={{ height: '12px', width: '1px', background: 'var(--win-border)', opacity: 0.6, flexShrink: 0 }} />
            <DbConnectionStatusPill status={connStatus} />
          </button>
        )}
      </div>

      {/* Right Section: Unified Right Toolbar Capsule + Window Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, ...({ WebkitAppRegion: 'no-drag' } as any) }}>
        {/* A transaction belongs to a connection, so the control lives here rather than in each tab's
            toolbar. See TxControl.tsx. */}
        {/* Background jobs: placed here for the same reason as TxControl. See JobsTray.tsx. */}
        <JobsTray />
        <TxControl
          connected={hasConnection}
          connId={connId || ""}
          dbType={(connStatus?.dbType || activeConnectionInfo?.dbType || "").toLowerCase()}
        />
        {renderCapsuleGroups(rightToolGroups)}

        {!isMac && (
          <div className="title-bar-right" style={{ marginLeft: '4px' }}>
            <button className="title-bar-btn" onClick={handleMinimize} title={t('titlebar.minimize')} aria-label={t('titlebar.minimize')}>
              <Minus size={13} />
            </button>
            <button className="title-bar-btn" onClick={handleMaximize} title={t('titlebar.maximize')} aria-label={t('titlebar.maximize')}>
              <Square size={11} />
            </button>
            <button className="title-bar-btn close" onClick={handleClose} title={t('titlebar.closeWindow')} aria-label={t('titlebar.closeWindow')}>
              <X size={13} />
            </button>
          </div>
        )}
      </div>

      {showConnPopover && connPopoverPos && hasConnection && (
        <ConnectionInfoPopover
          anchor={connPopoverPos}
          status={connStatus}
          profileName={activeProfileName}
          profileColor={activeProfileColor}
          profileEnv={activeProfileEnv}
          onProfileChange={(patch) => onProfileChange?.(patch)}
          onDisconnect={() => {
            setShowConnPopover(false);
            onDisconnect?.();
          }}
          onReconnect={async () => (onReconnect ? onReconnect() : { success: false })}
          onEdit={() => {
            setShowConnPopover(false);
            onNewConnection?.();
          }}
          onClose={() => setShowConnPopover(false)}
        />
      )}

      {showDbPopover && dbPopoverPos && (
        <QuickSwitcherPopover
          anchor={dbPopoverPos}
          activeConnId={connId || ''}
          activeDbName={activeConnectionInfo?.dbName}
          openConns={openConns}
          onSelectConnection={(id) => onSelectConnection?.(id)}
          onConnectSavedProfile={(p) => onConnectSavedProfile?.(p)}
          onOpenDatabase={handleSwitchDb}
          onCreateDatabase={() => setShowCreateDbModal(true)}
          onDropDatabase={handleDropDb}
          onNewConnection={() => onNewConnection?.()}
          onOpenAllDbStats={() => onOpenAllDbStats?.()}
          onClose={() => setShowDbPopover(false)}
        />
      )}

      {showCreateDbModal && (
        <CreateDatabaseModal
          connId={connId || ''}
          dbType={(connStatus?.dbType || activeConnectionInfo?.dbType || '').toLowerCase()}
          onCreated={handleDbCreated}
          onClose={() => setShowCreateDbModal(false)}
        />
      )}

      {/* Drop-database confirmation. requireText: the name must be typed — dropping a
          database loses every table and row, and the trash icon sits right next to the
          selected row, which makes a misclick easy. */}
      <ConfirmDialog
        open={!!dropDbTarget}
        danger
        title={t('sidebar.confirmDropDbTitle')}
        message={<Trans i18nKey="sidebar.confirmDropDbMessage" values={{ name: dropDbTarget || '' }} />}
        note={t('sidebar.confirmIrreversible')}
        requireText={dropDbTarget || undefined}
        confirmLabel={t('sidebar.dropDatabase')}
        onConfirm={confirmDropDb}
        onCancel={() => setDropDbTarget(null)}
      />
    </div>
  );
};

