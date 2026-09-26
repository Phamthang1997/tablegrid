import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Crosshair,
  Wand2,
  Search,
  Download,
  Filter,
  Layers,
  Copy,
  FileCode,
  Hand,
  MousePointer2,
  Image as ImageIcon,
  Check,
  ChevronDown,
  Table2,
  Waypoints,
} from 'lucide-react';
import type {
  ERDetailLevel,
  ERTable,
  ERExportFormat,
  ERExportOutcome,
  ERTool,
  ERViewport,
  ERViewportSubscribe,
} from './erTypes';

interface ERToolbarProps {
  tool: ERTool;
  tableCount: number;
  /** Every table the coarse filters allow — the rows the picker offers, hidden ones included. */
  pickableTables: ERTable[];
  hiddenTables: Set<string>;
  relationCount: number;
  detailLevel: ERDetailLevel;
  showViews: boolean;
  showIsolated: boolean;
  showMinimap: boolean;
  hasSelection: boolean;
  /** Live viewport feed, so the zoom readout tracks a pinch without re-rendering the toolbar. */
  subscribeViewport: ERViewportSubscribe;
  onToolChange: (tool: ERTool) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitView: () => void;
  onFitSelection: () => void;
  onResetView: () => void;
  onAutoLayout: () => void;
  onSearch: (query: string) => void;
  onDetailLevelChange: (level: ERDetailLevel) => void;
  onToggleViews: () => void;
  onToggleIsolated: () => void;
  onToggleMinimap: () => void;
  onToggleTable: (name: string) => void;
  onShowAllTables: () => void;
  onHideAllTables: () => void;
  onInvertTables: () => void;
  onShowRelatedTables: () => void;
  /** The picker was closed after a change — the canvas uses it to bring the survivors into view. */
  onTablesApplied: () => void;
  onExport: (format: ERExportFormat) => Promise<ERExportOutcome | void> | void;
}

/** Long enough that a table name is typed before the canvas flies anywhere. */
const SEARCH_DEBOUNCE_MS = 220;

const ERToolbarInner: React.FC<ERToolbarProps> = ({
  tool,
  tableCount,
  pickableTables,
  hiddenTables,
  relationCount,
  detailLevel,
  showViews,
  showIsolated,
  showMinimap,
  hasSelection,
  subscribeViewport,
  onToolChange,
  onZoomIn,
  onZoomOut,
  onFitView,
  onFitSelection,
  onResetView,
  onAutoLayout,
  onSearch,
  onDetailLevelChange,
  onToggleViews,
  onToggleIsolated,
  onToggleMinimap,
  onToggleTable,
  onShowAllTables,
  onHideAllTables,
  onInvertTables,
  onShowRelatedTables,
  onTablesApplied,
  onExport,
}) => {
  const { t } = useTranslation();
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [showTableMenu, setShowTableMenu] = useState(false);
  // The picker list can run to hundreds of rows, so it carries its own filter box. It is NOT the
  // toolbar search next to it: that one flies the canvas to a match, this one narrows a list.
  const [tableFilter, setTableFilter] = useState('');
  const [copiedStatus, setCopiedStatus] = useState<string | null>(null);

  // The query lives here rather than in the canvas: every keystroke would otherwise re-render
  // the diagram, and the canvas only ever needs the settled value to fly to a match.
  const [query, setQuery] = useState('');
  const debounceRef = useRef<number | null>(null);

  const exportMenuRef = useRef<HTMLDivElement>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const tableMenuRef = useRef<HTMLDivElement>(null);
  const zoomLabelRef = useRef<HTMLSpanElement>(null);

  const writeZoom = useCallback((vp: ERViewport) => {
    const el = zoomLabelRef.current;
    if (el) el.textContent = `${Math.round(vp.zoom * 100)}%`;
  }, []);
  useEffect(() => subscribeViewport(writeZoom), [subscribeViewport, writeZoom]);

  /** The one way the picker closes, so no path can shut it without telling the canvas. */
  const closeTableMenu = useCallback(() => {
    setShowTableMenu(false);
    onTablesApplied();
  }, [onTablesApplied]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
      if (filterMenuRef.current && !filterMenuRef.current.contains(e.target as Node)) {
        setShowFilterMenu(false);
      }
      if (tableMenuRef.current && !tableMenuRef.current.contains(e.target as Node)) {
        closeTableMenu();
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [closeTableMenu]);

  useEffect(
    () => () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    },
    []
  );

  const handleQueryChange = (next: string) => {
    setQuery(next);
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      onSearch(next);
    }, SEARCH_DEBOUNCE_MS);
  };

  const pickerRows = useMemo(() => {
    const needle = tableFilter.trim().toLowerCase();
    if (!needle) return pickableTables;
    return pickableTables.filter((table) => table.name.toLowerCase().includes(needle));
  }, [pickableTables, tableFilter]);

  // `23/23` is a fraction that says nothing — it only earns its slash once something is hidden,
  // and until then the button reads like the `22 relations` pill beside it.
  const isFiltered = hiddenTables.size > 0;
  const tableCountLabel = isFiltered ? `${tableCount}/${pickableTables.length}` : pickableTables.length;

  const handleExportAction = async (format: ERExportFormat) => {
    const copies = format === 'clipboard' || format === 'mermaid' || format === 'mermaid-selection';
    // A copy keeps the menu open: its "copied" confirmation is drawn IN the menu, and closing it
    // first meant nobody ever saw it. A save opens a file dialog, so the menu goes.
    if (!copies) {
      setShowExportMenu(false);
      onExport(format);
      return;
    }
    const outcome = await onExport(format);
    setCopiedStatus(outcome && outcome.tooLarge ? `${format}:large` : format);
    setTimeout(() => setCopiedStatus(null), outcome && outcome.tooLarge ? 6000 : 2500);
  };

  // One Mermaid menu row: the label, then the confirmation once copied, and a warning when the
  // text is past what Mermaid renders by default.
  const mermaidRow = (format: 'mermaid' | 'mermaid-selection', label: string) => {
    const done = copiedStatus === format || copiedStatus === `${format}:large`;
    const large = copiedStatus === `${format}:large`;
    return (
      <button type="button" className="er-menu-item" onClick={() => handleExportAction(format)}>
        {done ? <Check size={13} className="er-green" /> : <FileCode size={13} />}
        <span>
          {done ? t('er.exportMermaidDone') : label}
          {large && <span className="er-menu-item-warn">{t('er.exportMermaidTooLarge')}</span>}
        </span>
      </button>
    );
  };

  return (
    <div className="er-toolbar-container">
      {/* Tools. A switch, not a menu: the two modes are the whole interaction model. */}
      <div className="er-tool-group">
        <button
          type="button"
          className={`er-toolbar-icon-btn er-tool-btn ${tool === 'select' ? 'active' : ''}`}
          onClick={() => onToolChange('select')}
          title={t('er.toolSelectHint')}
          aria-label={t('er.toolSelect')}
        >
          <MousePointer2 size={13} />
        </button>
        <button
          type="button"
          className={`er-toolbar-icon-btn er-tool-btn ${tool === 'hand' ? 'active' : ''}`}
          onClick={() => onToolChange('hand')}
          title={t('er.toolHandHint')}
          aria-label={t('er.toolHand')}
        >
          <Hand size={13} />
        </button>
      </div>

      <div className="er-toolbar-divider" />

      {/* The picker replaces the old `23 tables` pill rather than sitting next to it: the pill
          said how many tables there are and this button says the same thing plus how many of
          them are on screen, so keeping both would have printed the count twice in one row. */}
      <div className="er-popover-wrap" ref={tableMenuRef}>
        <button
          type="button"
          className={`er-toolbar-btn er-picker-trigger ${showTableMenu ? 'active' : ''}`}
          onClick={() => (showTableMenu ? closeTableMenu() : setShowTableMenu(true))}
          title={t('er.tablesHint')}
          aria-label={t('er.tables')}
        >
          <Table2 size={12} />
          {/* Number first, word second, and the number is a <b> while the word is a <span>: the
              narrow-canvas rule strips `.er-toolbar-btn > span`, so the count is what survives. */}
          <b className={`er-count-badge ${isFiltered ? 'is-filtered' : ''}`}>{tableCountLabel}</b>
          <span>{t('er.tablesUnit')}</span>
        </button>

        {showTableMenu && (
          <div className="er-popover-menu er-table-picker">
            <div className="er-popover-header">{t('er.tablesHeader')}</div>

            <div className="er-picker-search">
              <Search size={12} className="er-search-icon" />
              <input
                type="text"
                className="er-search-input"
                placeholder={t('er.tablesFilterPlaceholder')}
                value={tableFilter}
                onChange={(e) => setTableFilter(e.target.value)}
              />
            </div>

            <div className="er-picker-actions">
              <button type="button" className="er-picker-action" onClick={onShowAllTables}>
                {t('er.tablesAll')}
              </button>
              <button type="button" className="er-picker-action" onClick={onHideAllTables}>
                {t('er.tablesNone')}
              </button>
              <button type="button" className="er-picker-action" onClick={onInvertTables}>
                {t('er.tablesInvert')}
              </button>
            </div>

            <button
              type="button"
              className="er-menu-item"
              onClick={onShowRelatedTables}
              title={t('er.tablesRelatedHint')}
            >
              <Waypoints size={13} />
              <span>{t('er.tablesRelated')}</span>
            </button>

            <div className="er-picker-list">
              {pickerRows.map((table) => (
                <label className="er-filter-item" key={table.name}>
                  <input
                    type="checkbox"
                    checked={!hiddenTables.has(table.name)}
                    onChange={() => onToggleTable(table.name)}
                  />
                  <span className="er-picker-name">{table.name}</span>
                  {table.kind === 'view' && (
                    <span className="er-picker-kind">{t('er.tablesKindView')}</span>
                  )}
                </label>
              ))}
              {pickerRows.length === 0 && (
                <div className="er-picker-empty">{t('er.tablesNoMatch')}</div>
              )}
            </div>
          </div>
        )}
      </div>
      <span className="er-stat-pill">{t('er.statRelations', { n: relationCount })}</span>

      <div className="er-search-box">
        <Search size={12} className="er-search-icon" />
        <input
          type="text"
          className="er-search-input"
          placeholder={t('er.searchPlaceholder')}
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
        />
      </div>

      <div className="er-toolbar-divider" />

      <button
        type="button"
        className={`er-toolbar-btn ${detailLevel === 'full' ? 'active' : ''}`}
        onClick={() => onDetailLevelChange('full')}
        title={t('er.levelFullHint')}
      >
        {t('er.levelFull')}
      </button>
      <button
        type="button"
        className={`er-toolbar-btn ${detailLevel === 'keys_only' ? 'active' : ''}`}
        onClick={() => onDetailLevelChange('keys_only')}
        title={t('er.levelKeysHint')}
      >
        {t('er.levelKeys')}
      </button>
      <button
        type="button"
        className={`er-toolbar-btn ${detailLevel === 'compact' ? 'active' : ''}`}
        onClick={() => onDetailLevelChange('compact')}
        title={t('er.levelCompactHint')}
      >
        {t('er.levelCompact')}
      </button>

      <div className="er-toolbar-divider" />

      <button
        type="button"
        className="er-toolbar-btn"
        onClick={onAutoLayout}
        title={t('er.autoLayoutHint')}
        aria-label={t('er.autoLayout')}
      >
        <Wand2 size={12} />
        <span>{t('er.autoLayout')}</span>
      </button>

      <div className="er-btn-group">
        <button
          type="button"
          className="er-toolbar-icon-btn"
          onClick={onZoomOut}
          title={t('er.zoomOut')}
        >
          <ZoomOut size={12} />
        </button>
        <span
          className="er-zoom-label"
          ref={zoomLabelRef}
          onClick={onResetView}
          title={t('er.zoomReset')}
        />
        <button
          type="button"
          className="er-toolbar-icon-btn"
          onClick={onZoomIn}
          title={t('er.zoomIn')}
        >
          <ZoomIn size={12} />
        </button>
        <button
          type="button"
          className="er-toolbar-icon-btn er-btn-optional"
          onClick={onFitView}
          title={t('er.fitView')}
        >
          <Maximize2 size={12} />
        </button>
        <button
          type="button"
          className="er-toolbar-icon-btn er-btn-optional"
          onClick={onFitSelection}
          disabled={!hasSelection}
          title={t('er.fitSelection')}
        >
          <Crosshair size={12} />
        </button>
      </div>

      <div className="er-toolbar-divider" />

      <div className="er-popover-wrap" ref={filterMenuRef}>
        <button
          type="button"
          className={`er-toolbar-btn ${showFilterMenu ? 'active' : ''}`}
          onClick={() => setShowFilterMenu(!showFilterMenu)}
          title={t('er.filtersHint')}
          aria-label={t('er.filters')}
        >
          <Filter size={12} />
          <span>{t('er.filters')}</span>
        </button>

        {showFilterMenu && (
          <div className="er-popover-menu">
            <div className="er-popover-header">{t('er.filtersHeader')}</div>
            <label className="er-filter-item">
              <input type="checkbox" checked={showViews} onChange={onToggleViews} />
              <span>{t('er.showViews')}</span>
            </label>
            <label className="er-filter-item">
              <input type="checkbox" checked={showIsolated} onChange={onToggleIsolated} />
              <span>{t('er.showIsolated')}</span>
            </label>
            <label className="er-filter-item">
              <input type="checkbox" checked={showMinimap} onChange={onToggleMinimap} />
              <span>{t('er.showMinimap')}</span>
            </label>
          </div>
        )}
      </div>

      <div className="er-popover-wrap" ref={exportMenuRef}>
        <button
          type="button"
          className="er-toolbar-btn primary"
          onClick={() => setShowExportMenu(!showExportMenu)}
          title={t('er.exportHint')}
          aria-label={t('er.exportLabel')}
        >
          <Download size={13} />
          <span>{t('er.exportLabel')}</span>
          <ChevronDown size={12} />
        </button>

        {showExportMenu && (
          <div className="er-popover-menu right-aligned">
            <div className="er-popover-header">{t('er.exportVisualHeader')}</div>
            <button type="button" className="er-menu-item" onClick={() => handleExportAction('png')}>
              <ImageIcon size={13} />
              <span>{t('er.exportPng')}</span>
            </button>
            <button
              type="button"
              className="er-menu-item"
              onClick={() => handleExportAction('clipboard')}
            >
              {copiedStatus === 'clipboard' ? (
                <Check size={13} className="er-green" />
              ) : (
                <Copy size={13} />
              )}
              <span>
                {copiedStatus === 'clipboard'
                  ? t('er.exportClipboardDone')
                  : t('er.exportClipboard')}
              </span>
            </button>
            <button type="button" className="er-menu-item" onClick={() => handleExportAction('svg')}>
              <Layers size={13} />
              <span>{t('er.exportSvg')}</span>
            </button>

            <div className="er-menu-divider" />
            <div className="er-popover-header">{t('er.exportCodeHeader')}</div>
            {mermaidRow('mermaid', t('er.exportMermaid'))}
            {hasSelection && mermaidRow('mermaid-selection', t('er.exportMermaidSelection'))}
            <button
              type="button"
              className="er-menu-item"
              onClick={() => handleExportAction('dbml')}
            >
              <FileCode size={13} />
              <span>{t('er.exportDbml')}</span>
            </button>
            <button type="button" className="er-menu-item" onClick={() => handleExportAction('markdown')}>
              <FileCode size={13} />
              <span>{t('er.exportMarkdownDoc')}</span>
            </button>
            <button type="button" className="er-menu-item" onClick={() => handleExportAction('sql')}>
              <FileCode size={13} />
              <span>{t('er.exportSql')}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export const ERToolbar = React.memo(ERToolbarInner);
