import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Table, Terminal, TerminalSquare, X, Plus, Trash2, XCircle, ArrowRight, ChevronDown, Cog, Braces, Layers, Pencil, Key, Activity, Timer, Radio, BarChart3, GitCompare, ArrowLeftRight, Wand2, Database, Download, Upload, Plug } from 'lucide-react';
import { TAB_GROUP_COLORS, type TabGroup } from '../utils/tabGroups';

/** Stable empty default for the `groups` prop: a fresh `[]` each render breaks memoisation downstream. */
const NO_GROUPS: TabGroup[] = [];

export interface TabInfo {
  id: string;
  /**
   * The connection this tab runs on.
   *
   * The tab↔connection binding used to be **external**: the whole tab list sat under one localStorage
   * key belonging to the open connection, and switching connection replaced the list wholesale. Now
   * several connections' tabs live in state together, so each tab has to carry its own connection —
   * the strip filters on this, and every component inside a tab receives this `connId` rather than
   * "the selected connection".
   *
   * Optional: saves in localStorage from before this field existed do not have it, and it is assigned
   * at restore time (see `restoreTabs`).
   */
  connId?: string;
  /**
   * The seven `redis-*` kinds are a Redis connection's tabs — the same strip, the same drag and drop,
   * the same colour groups as the SQL tabs (`docs/redis-ui-unification-plan.md` §2.2).
   *
   * None of them carries a `dbIndex`: a `conn_id` **is** a `(server, db index)` pair (§2.1), so the
   * db index lives in `connId` above. Adding it here would rebuild exactly the shared state Phase 0
   * had just removed.
   */
  type:
    | 'table'
    | 'query'
    | 'terminal'
    | 'routine'
    | 'view'
    | 'er'
    | 'process-monitor'
    | 'schema-migration'
    | 'db-compare'
    | 'data-gen'
    | 'db-info'
    | 'export-db'
    | 'import-db'
    | 'copy-db'
    | 'mcp-server'
    | 'redis-key'
    | 'redis-console'
    | 'redis-dashboard'
    | 'redis-slowlog'
    | 'redis-pubsub'
    | 'redis-profiler'
    | 'redis-analysis';
  name: string; // Table name or unique query title
  label: string;
  routineInfo?: { name: string; kind: 'procedure' | 'function'; sql: string };
  viewInfo?: { name: string; sql: string };
  dataGenTable?: string | null;
  dbInfoTab?: 'current' | 'all';
  /**
   * A `redis-key` tab. `keyType` is only there to draw the badge before the value has loaded — the
   * source of truth is the actual key read, because the type may have changed (the key deleted and
   * recreated) between sessions.
   */
  redisKeyInfo?: { keyName: string; keyType?: string };
  config?: any;       // the connection config for a terminal tab
  floating?: boolean; // terminal: currently in floating-window mode
  /** The group holding this tab. Empty = a loose tab. See TabGroup. */
  groupId?: string;
}


/**
 * The icon for each kind of Redis tab in the tab-list dropdown.
 *
 * The strip itself deliberately draws NO icons (see `renderTab`) — only the dropdown does, so this
 * table is used there alone.
 */
const REDIS_TAB_ICON: Record<string, React.FC<{ size?: number; style?: React.CSSProperties }>> = {
  'redis-key': Key,
  'redis-console': Terminal,
  'redis-dashboard': Activity,
  'redis-slowlog': Timer,
  'redis-pubsub': Radio,
  'redis-profiler': Activity,
  'redis-analysis': BarChart3,
};

interface TabManagerProps {
  tabs: TabInfo[];
  activeTabId: string | null;
  /** A tab with uncommitted edits -> a dot is shown in place of the close button. */
  dirtyTabId?: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string, e?: React.MouseEvent) => void;
  onCloseOthers?: (id: string) => void;
  onCloseTabsToRight?: (id: string) => void;
  onCloseAll?: () => void;
  /**
   * Reordering tabs by drag. The indices are into the `tabs` array; `groupId` is the group whose area
   * the pointer was inside when it was dropped (undefined = outside every group).
   */
  onReorderTabs?: (from: number, to: number, groupId: string | undefined) => void;
  onNewQueryTab: () => void;

  // ---- tab group ----
  groups?: TabGroup[];
  onCreateGroup?: (tabId: string) => void;
  onAssignGroup?: (tabId: string, groupId: string) => void;
  onRemoveFromGroup?: (tabId: string) => void;
  onRenameGroup?: (groupId: string, name: string) => void;
  onSetGroupColor?: (groupId: string, color: string) => void;
  onToggleGroup?: (groupId: string) => void;
  /** Dragging a group's chip -> move the whole group to where the tab at `targetIndex` sits. */
  onMoveGroup?: (groupId: string, targetIndex: number) => void;
  onCloseGroup?: (groupId: string) => void;
}

export const TabManager: React.FC<TabManagerProps> = ({
  tabs,
  activeTabId,
  dirtyTabId,
  onSelectTab,
  onCloseTab,
  onCloseOthers,
  onCloseTabsToRight,
  onCloseAll,
  onReorderTabs,
  onNewQueryTab,
  groups = NO_GROUPS,
  onCreateGroup,
  onAssignGroup,
  onRemoveFromGroup,
  onRenameGroup,
  onSetGroupColor,
  onToggleGroup,
  onMoveGroup,
  onCloseGroup,
}) => {
  const { t } = useTranslation();
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    tabId: string;
  }>({
    visible: false,
    x: 0,
    y: 0,
    tabId: '',
  });

  const [showListDropdown, setShowListDropdown] = useState(false);

  // Renaming a group is edited in place on the chip (double-click, or from the context menu) rather
  // than in a dialog — a group name is a short label, and building a whole Modal for it costs more
  // than it gives.
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const commitRename = () => {
    if (!renamingGroupId) return;
    const name = renameDraft.trim();
    if (name) onRenameGroup?.(renamingGroupId, name);
    setRenamingGroupId(null);
  };

  const itemsRef = useRef<HTMLDivElement>(null);
  // The drag state: `from` is the tab being held, `to` is where it will land, and `dx` is how far it
  // has travelled from the press point — the tab is translated by exactly dx, so it follows the
  // pointer. This is what shows which tab is being held: merely fading it is nearly invisible on an
  // inactive tab, which is already grey text on a transparent background.
  const [drag, setDrag] = useState<
    { from: number; to: number; dx: number; toGroup: string | undefined } | null
  >(null);
  // Dragging a whole group by its chip. Kept apart from `drag` (dragging one tab) because the two
  // gestures work in different units: one moves a tab, the other moves an entire run.
  const [groupDrag, setGroupDrag] = useState<{ groupId: string; to: number; dx: number } | null>(null);
  // After a drag, pointerup still produces a click -> that click is ignored, or every tab drop would
  // also switch to that tab (and every group-chip drop would also collapse or expand it).
  const skipClickRef = useRef(false);

  // Horizontal scrolling from a vertical wheel: the strip is overflow-x with its scrollbar hidden, so
  // once it overflows there is no way to scroll it other than the tab-list dropdown.
  // addEventListener has to be called by hand with passive: false — React's onWheel handler is
  // attached at the root as passive, which makes preventDefault() inside it do nothing.
  useEffect(() => {
    const el = itemsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Shift+wheel is already the browser's horizontal scroll; leave it alone.
      if (e.shiftKey || e.deltaY === 0) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // A freshly selected tab may be off screen (opened from the sidebar, from F12…).
  // Looked up by data-tab-id rather than el.children[i]: since groups exist, a direct child of the
  // strip may be a .tab-group cluster wrapping several tabs, so child indices no longer match indices
  // in the `tabs` array.
  useEffect(() => {
    if (!activeTabId) return;
    const node = itemsRef.current?.querySelector<HTMLElement>(
      `[data-tab-id="${CSS.escape(activeTabId)}"]`,
    );
    node?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // `tabs` is a trigger: the strip re-renders, so the active node has to be scrolled back into view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, tabs]);

  /**
   * The index (into the `tabs` array) of the tab under coordinate x; past either end it clamps to the
   * first or last visible tab.
   *
   * The real index is read from data-tab-index rather than taken from a node's position in the list: a
   * collapsed group hides its tabs, so the node order is no longer contiguous.
   */
  const indexAtX = (x: number, fallback: number): number => {
    const el = itemsRef.current;
    if (!el) return fallback;
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('.tab-item'));
    if (nodes.length === 0) return fallback;
    const realIndex = (node: HTMLElement) => Number(node.dataset.tabIndex ?? fallback);
    for (const node of nodes) {
      if (x < node.getBoundingClientRect().right) return realIndex(node);
    }
    return realIndex(nodes[nodes.length - 1]);
  };

  /**
   * The group whose area coordinate x falls inside, or undefined when outside every group.
   *
   * Decided from the geometry of the .tab-group cluster itself rather than inferred from the two
   * neighbouring tabs: inferring from neighbours makes a drop on the group's EDGE fail to join it,
   * and the right edge is the most natural gesture for appending a tab to a group. Measuring the area
   * is also the only way to drop into a collapsed group — there the group is just its chip, with no
   * tabs to be neighbours.
   */
  const groupAtX = (x: number): string | undefined => {
    const el = itemsRef.current;
    if (!el) return undefined;
    for (const node of Array.from(el.querySelectorAll<HTMLElement>('.tab-group'))) {
      const rect = node.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right) return node.dataset.groupId;
    }
    return undefined;
  };

  // Drag and drop with pointer events rather than HTML5 drag-and-drop: a Tauri window has OS-level
  // drag-drop enabled, which swallows drag events inside the webview on Windows. Pointer events do
  // not depend on it.
  const handleTabPointerDown = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0 || !onReorderTabs) return;
    const startX = e.clientX;
    const startGroup = tabs[index]?.groupId;
    let moved = false;
    let to = index;
    let toGroup = startGroup;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      // A 4px threshold, so a slightly shaky click is not read as a drag.
      if (!moved && Math.abs(dx) < 4) return;
      moved = true;
      to = indexAtX(ev.clientX, index);
      toGroup = groupAtX(ev.clientX);
      setDrag({ from: index, to, dx, toGroup });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setDrag(null);
      if (!moved) return;
      skipClickRef.current = true;
      // A group change counts as a change even when the index does not: dropping a loose tab exactly
      // on a neighbouring group's edge keeps its position but must still join the group.
      if (to !== index || toGroup !== startGroup) onReorderTabs(index, to, toGroup);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const handleGroupPointerDown = (e: React.PointerEvent, groupId: string) => {
    if (e.button !== 0 || !onMoveGroup) return;
    const startX = e.clientX;
    let moved = false;
    let to = -1;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 4) return;
      moved = true;
      to = indexAtX(ev.clientX, -1);
      setGroupDrag({ groupId, to, dx });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setGroupDrag(null);
      if (!moved) return;
      // Blocks the click that follows pointerup, or finishing a group drag would also collapse it.
      skipClickRef.current = true;
      if (to >= 0) onMoveGroup(groupId, to);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  useEffect(() => {
    const closeAll = () => {
      // `prev` is returned UNCHANGED when the menu is already hidden, which is almost always.
      // Spreading it unconditionally built a new object on every click anywhere in the app, and a
      // new object is never `Object.is`-equal, so React could not bail out: every click in the SQL
      // editor, the grid or the sidebar re-rendered the whole tab strip for nothing (measured at
      // 0.5ms a click, the most expensive thing left in those commits). `setShowListDropdown(false)`
      // needs no such guard — React already bails out on an identical primitive.
      setContextMenu((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      setShowListDropdown(false);
    };
    window.addEventListener('click', closeAll);
    window.addEventListener('contextmenu', closeAll);
    return () => {
      window.removeEventListener('click', closeAll);
      window.removeEventListener('contextmenu', closeAll);
    };
  }, []);

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Bounds check to keep the context menu on screen. The groups section makes the menu grow with
    // however many groups exist, so the estimate has to add for them rather than assume a fixed 150 —
    // a menu overflowing the bottom of the screen leaves its last entry unreachable.
    const ctxTabGroupId = tabs.find((tb) => tb.id === tabId)?.groupId;
    const menuWidth = 180;
    const menuHeight = 150 + 30 + groups.length * 26 + (ctxTabGroupId ? 120 : 0);
    let x = e.clientX;
    let y = e.clientY;
    
    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 10;
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 10;
    }
    
    setContextMenu({
      visible: true,
      x,
      y,
      tabId,
    });
  };

  // Cuts the tab array into runs of consecutive same-group tabs. It relies entirely on the "one group
  // stays adjacent" invariant described in TabGroup; a groupId pointing at a deleted group counts as a
  // loose tab, so no extra cleanup is needed here.
  const segments: { group: TabGroup | null; items: { tab: TabInfo; index: number }[] }[] = [];
  tabs.forEach((tab, index) => {
    const group = (tab.groupId ? groups.find((g) => g.id === tab.groupId) : null) ?? null;
    const last = segments[segments.length - 1];
    if (last && (last.group?.id ?? null) === (group?.id ?? null)) {
      last.items.push({ tab, index });
    } else {
      segments.push({ group, items: [{ tab, index }] });
    }
  });

  const renderTab = ({ tab, index }: { tab: TabInfo; index: number }) => {
    const isActive = tab.id === activeTabId;
    const isDirty = tab.id === dirtyTabId;
    // The drop indicator: dragging left puts the line before the target tab, dragging right puts it
    // after — exactly where the tab lands once spliced. It applies to dragging one tab and a whole
    // group alike; for a group the reference point is its FIRST tab.
    const groupStart = groupDrag
      ? tabs.findIndex((it) => it.groupId === groupDrag.groupId)
      : -1;
    const dropSide =
      drag && drag.from !== drag.to && drag.to === index
        ? (drag.to < drag.from ? 'tab-drop-before' : 'tab-drop-after')
        : groupDrag && groupDrag.to === index && tab.groupId !== groupDrag.groupId
          ? (index < groupStart ? 'tab-drop-before' : 'tab-drop-after')
          : '';
    const isDragging = drag?.from === index;
    const classes = [
      'tab-item',
      isActive ? 'active' : '',
      isDirty ? 'dirty' : '',
      isDragging ? 'tab-dragging' : '',
      dropSide,
    ].filter(Boolean).join(' ');
    return (
      <div
        key={tab.id}
        className={classes}
        // These two data attributes are the only way the drag code knows which node belongs to which
        // tab: the strip's direct children stopped being 1:1 with the `tabs` array once group clusters
        // and collapsed groups existed.
        data-tab-id={tab.id}
        data-tab-index={index}
        // Moved by transform only, never touching layout: the other tabs stay put so the drop
        // indicator does not jump with them, and the strip's scrollWidth does not change midway when
        // dragging past its edge.
        style={isDragging ? { transform: `translateX(${drag!.dx}px)` } : undefined}
        onPointerDown={(e) => handleTabPointerDown(e, index)}
        onClick={() => {
          if (skipClickRef.current) {
            skipClickRef.current = false;
            return;
          }
          onSelectTab(tab.id);
        }}
        // Middle click closes a tab. mousedown is blocked because the middle button opens the
        // browser's autoscroll mode before auxclick even fires.
        onMouseDown={(e) => {
          if (e.button === 1) e.preventDefault();
        }}
        onAuxClick={(e) => {
          if (e.button !== 1) return;
          e.preventDefault();
          onCloseTab(tab.id, e);
        }}
        onContextMenu={(e) => handleContextMenu(e, tab.id)}
      >
        {/* No per-kind icon: tabs are distinguished by colour alone (a lighter background and bolder
            text for the one being viewed), and the title already says whether it is a table or a
            query. The dropdown's tab list still keeps its icons. */}
        <span className="tab-title" title={tab.label}>
          {tab.label}
        </span>
        {isDirty && (
          <span
            className="tab-dirty-dot"
            title={t('tabs.unsavedChanges')}
            aria-label={t('tabs.unsavedChanges')}
          />
        )}
        <button
          className="tab-close-btn"
          onClick={(e) => onCloseTab(tab.id, e)}
        >
          <X size={10} style={{ flexShrink: 0 }} />
        </button>
      </div>
    );
  };

  const renderGroup = (group: TabGroup, items: { tab: TabInfo; index: number }[]) => {
    // The group holding the viewed tab is always expanded, even when marked collapsed: hiding the very
    // tab whose content is on screen is an unreadable state.
    const holdsActive = items.some((it) => it.tab.id === activeTabId);
    const collapsed = !!group.collapsed && !holdsActive;
    const renaming = renamingGroupId === group.id;
    const isDragging = groupDrag?.groupId === group.id;
    return (
      <div
        key={group.id}
        // data-group-id: groupAtX() measures this cluster's area to know which group a tab is being
        // dropped into, so the id has to be readable from the DOM.
        data-group-id={group.id}
        className={[
          'tab-group',
          collapsed ? 'collapsed' : '',
          // Lit while the pointer is inside the group's area and the dragged tab would land here —
          // otherwise nothing says which group a release would join.
          drag && drag.toGroup === group.id ? 'drop-target' : '',
          isDragging ? 'tab-group-dragging' : '',
        ].filter(Boolean).join(' ')}
        style={{
          ['--tab-group-color' as string]: group.color,
          ...(isDragging ? { transform: `translateX(${groupDrag!.dx}px)` } : null),
        } as React.CSSProperties}
      >
        <div
          className="tab-group-chip"
          // Dragging the chip moves the whole group. Clicking it (without dragging) collapses or expands.
          onPointerDown={(e) => handleGroupPointerDown(e, group.id)}
          onClick={() => {
            if (skipClickRef.current) {
              skipClickRef.current = false;
              return;
            }
            if (!renaming) onToggleGroup?.(group.id);
          }}
          onDoubleClick={() => {
            setRenamingGroupId(group.id);
            setRenameDraft(group.name);
          }}
          title={group.name}
        >
          <span className="tab-group-dot" />
          {renaming ? (
            <input
              type="text"
              className="tab-group-rename"
              value={renameDraft}
              autoFocus
              onChange={(e) => setRenameDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenamingGroupId(null);
              }}
            />
          ) : (
            <span className="tab-group-name">{group.name}</span>
          )}
          {collapsed && <span className="tab-group-count">{items.length}</span>}
        </div>
        {!collapsed && items.map(renderTab)}
      </div>
    );
  };

  // The tab whose context menu is open, and its group when it has one. The loop variable is named
  // `tb` rather than `t`: `t` here is the translation function, and shadowing it loses i18n for the
  // whole file.
  const ctxTab = tabs.find((tb) => tb.id === contextMenu.tabId);
  const ctxGroup = (ctxTab?.groupId ? groups.find((g) => g.id === ctxTab.groupId) : null) ?? null;

  return (
    <div className="tab-bar">
      <div className="tab-bar-items" ref={itemsRef}>
        {segments.map((seg, i) =>
          seg.group ? renderGroup(seg.group, seg.items) : (
            <React.Fragment key={`plain_${i}`}>{seg.items.map(renderTab)}</React.Fragment>
          ),
        )}
      </div>

      <div className="tab-bar-controls">
        <button className="tab-new-btn" onClick={onNewQueryTab} title={t('tabs.newQueryTab')}>
          <Plus size={14} />
        </button>
        {tabs.length > 0 && (
          <button 
            className="tab-list-dropdown-btn" 
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setShowListDropdown((prev) => !prev);
            }}
            title={t('tabs.listOpenTabs')}
          >
            <ChevronDown size={14} />
          </button>
        )}
      </div>

      {showListDropdown && (
        <div className="tab-list-dropdown" onClick={(e) => e.stopPropagation()}>
          <div className="tab-list-dropdown-header">
            <span>{t('tabs.openTabs', { n: tabs.length })}</span>
            <button onClick={() => setShowListDropdown(false)}>×</button>
          </div>
          <div className="tab-list-dropdown-body">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              return (
                <div 
                  key={tab.id} 
                  className={`tab-list-dropdown-item ${isActive ? 'active' : ''}`}
                  onClick={() => {
                    onSelectTab(tab.id);
                    setShowListDropdown(false);
                  }}
                >
                  {tab.type === 'table' ? (
                    <Table size={12} className="tab-icon-table" style={{ marginRight: '6px' }} />
                  ) : tab.type === 'terminal' ? (
                    <TerminalSquare size={12} style={{ color: 'var(--win-accent)', marginRight: '6px' }} />
                  ) : tab.type === 'routine' ? (
                    tab.routineInfo?.kind === 'procedure' ? (
                      <Cog size={12} style={{ color: '#06b6d4', marginRight: '6px' }} />
                    ) : (
                      <Braces size={12} style={{ color: '#f59e0b', marginRight: '6px' }} />
                    )
                  ) : tab.type === 'view' ? (
                    <Layers size={12} style={{ color: '#8b5cf6', marginRight: '6px' }} />
                  ) : tab.type === 'process-monitor' ? (
                    <Activity size={12} style={{ color: '#06b6d4', marginRight: '6px' }} />
                  ) : tab.type === 'schema-migration' ? (
                    <GitCompare size={12} style={{ color: '#8b5cf6', marginRight: '6px' }} />
                  ) : tab.type === 'db-compare' ? (
                    <ArrowLeftRight size={12} style={{ color: '#f59e0b', marginRight: '6px' }} />
                  ) : tab.type === 'data-gen' ? (
                    <Wand2 size={12} style={{ color: '#ec4899', marginRight: '6px' }} />
                  ) : tab.type === 'db-info' ? (
                    <Database size={12} style={{ color: '#3b82f6', marginRight: '6px' }} />
                  ) : tab.type === 'export-db' ? (
                    <Download size={12} style={{ color: '#06b6d4', marginRight: '6px' }} />
                  ) : tab.type === 'import-db' ? (
                    <Upload size={12} style={{ color: '#10b981', marginRight: '6px' }} />
                  ) : tab.type === 'mcp-server' ? (
                    <Plug size={12} style={{ color: '#10b981', marginRight: '6px' }} />
                  ) : tab.type.startsWith('redis-') ? (
                    (() => {
                      const RedisIcon = REDIS_TAB_ICON[tab.type] ?? Key;
                      return <RedisIcon size={12} style={{ color: '#DC382D', marginRight: '6px' }} />;
                    })()
                  ) : (
                    <Terminal size={12} style={{ color: 'var(--win-accent)', marginRight: '6px' }} />
                  )}
                  <span className="tab-list-dropdown-title" title={tab.label}>{tab.label}</span>
                  <button 
                    className="tab-list-dropdown-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                  >
                    <X size={10} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* The context menu renders THROUGH A PORTAL into <body>, not in place inside .tab-bar. The menu
          is position: fixed with the viewport's clientX/clientY, but .tab-bar has backdrop-filter (see
          the selector group at the top of index.css) and that property creates a new containing block
          for fixed children — inside it, the coordinates are measured from the strip's corner, putting
          the menu exactly one title-bar height too low and one sidebar width too far right. The same
          trap recorded in Modal.tsx.

          The opposite holds for .tab-list-dropdown (the tab list, the ⌄ button), which is NOT
          portalled: it is position: absolute anchored to .tab-bar itself, which is what it wants. */}
      {contextMenu.visible && createPortal(
        <div
          className="tab-context-menu"
          style={{
            top: contextMenu.y,
            left: contextMenu.x,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="tab-context-menu-item"
            onClick={() => {
              onCloseTab(contextMenu.tabId);
              setContextMenu((prev) => ({ ...prev, visible: false }));
            }}
          >
            <X size={13} style={{ flexShrink: 0 }} />
            <span>{t('tabs.closeThis')}</span>
          </div>
          {onCloseOthers && (
            <div
              className="tab-context-menu-item"
              onClick={() => {
                onCloseOthers(contextMenu.tabId);
                setContextMenu((prev) => ({ ...prev, visible: false }));
              }}
            >
              <XCircle size={13} style={{ flexShrink: 0 }} />
              <span>{t('tabs.closeOthers')}</span>
            </div>
          )}
          {onCloseTabsToRight && (
            <div
              className="tab-context-menu-item"
              onClick={() => {
                onCloseTabsToRight(contextMenu.tabId);
                setContextMenu((prev) => ({ ...prev, visible: false }));
              }}
            >
              <ArrowRight size={13} style={{ flexShrink: 0 }} />
              <span>{t('tabs.closeToRight')}</span>
            </div>
          )}
          {onCreateGroup && (
            <>
              <div className="tab-context-menu-divider" />
              <div
                className="tab-context-menu-item"
                onClick={() => {
                  onCreateGroup(contextMenu.tabId);
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                }}
              >
                <Layers size={13} style={{ flexShrink: 0 }} />
                <span>{t('tabs.newGroup')}</span>
              </div>

              {/* Move to another group. The tab's current group is excluded from the list: picking it
                  would change nothing while still looking like an action. */}
              {groups
                .filter((g) => g.id !== ctxGroup?.id)
                .map((g) => (
                  <div
                    key={g.id}
                    className="tab-context-menu-item"
                    onClick={() => {
                      onAssignGroup?.(contextMenu.tabId, g.id);
                      setContextMenu((prev) => ({ ...prev, visible: false }));
                    }}
                  >
                    <span
                      className="tab-group-dot"
                      style={{ ['--tab-group-color' as string]: g.color } as React.CSSProperties}
                    />
                    <span>{g.name}</span>
                  </div>
                ))}

              {ctxGroup && (
                <>
                  <div
                    className="tab-context-menu-item"
                    onClick={() => {
                      onRemoveFromGroup?.(contextMenu.tabId);
                      setContextMenu((prev) => ({ ...prev, visible: false }));
                    }}
                  >
                    <XCircle size={13} style={{ flexShrink: 0 }} />
                    <span>{t('tabs.removeFromGroup')}</span>
                  </div>
                  <div
                    className="tab-context-menu-item"
                    onClick={() => {
                      setRenamingGroupId(ctxGroup.id);
                      setRenameDraft(ctxGroup.name);
                      setContextMenu((prev) => ({ ...prev, visible: false }));
                    }}
                  >
                    <Pencil size={13} style={{ flexShrink: 0 }} />
                    <span>{t('tabs.renameGroup')}</span>
                  </div>
                  <div className="tab-context-menu-colors">
                    {TAB_GROUP_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className={`tab-group-swatch ${ctxGroup.color === color ? 'active' : ''}`}
                        style={{ background: color }}
                        title={t('tabs.groupColor')}
                        aria-label={t('tabs.groupColor')}
                        onClick={() => {
                          onSetGroupColor?.(ctxGroup.id, color);
                          setContextMenu((prev) => ({ ...prev, visible: false }));
                        }}
                      />
                    ))}
                  </div>
                  <div
                    className="tab-context-menu-item"
                    onClick={() => {
                      onCloseGroup?.(ctxGroup.id);
                      setContextMenu((prev) => ({ ...prev, visible: false }));
                    }}
                  >
                    <XCircle size={13} style={{ flexShrink: 0 }} />
                    <span>{t('tabs.closeGroup')}</span>
                  </div>
                </>
              )}
            </>
          )}
          {onCloseAll && (
            <>
              <div className="tab-context-menu-divider" />
              <div
                className="tab-context-menu-item close-all"
                onClick={() => {
                  onCloseAll();
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                }}
                style={{ color: 'var(--st-danger)' }}
              >
                <Trash2 size={13} style={{ flexShrink: 0 }} />
                <span>{t('tabs.closeAll')}</span>
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
};

