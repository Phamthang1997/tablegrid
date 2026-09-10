import React, { useState, useRef, useEffect, useCallback } from 'react';
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
} from 'lucide-react';
import type {
  ERDetailLevel,
  ERExportFormat,
  ERTool,
  ERViewport,
  ERViewportSubscribe,
} from './erTypes';

interface ERToolbarProps {
  tool: ERTool;
  tableCount: number;
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
  onExport: (format: ERExportFormat) => void;
}

/** Long enough that a table name is typed before the canvas flies anywhere. */
const SEARCH_DEBOUNCE_MS = 220;

const ERToolbarInner: React.FC<ERToolbarProps> = ({
  tool,
  tableCount,
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
  onExport,
}) => {
  const { t } = useTranslation();
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [copiedStatus, setCopiedStatus] = useState<string | null>(null);

  // The query lives here rather than in the canvas: every keystroke would otherwise re-render
  // the diagram, and the canvas only ever needs the settled value to fly to a match.
  const [query, setQuery] = useState('');
  const debounceRef = useRef<number | null>(null);

  const exportMenuRef = useRef<HTMLDivElement>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const zoomLabelRef = useRef<HTMLSpanElement>(null);

  const writeZoom = useCallback((vp: ERViewport) => {
    const el = zoomLabelRef.current;
    if (el) el.textContent = `${Math.round(vp.zoom * 100)}%`;
  }, []);
  useEffect(() => subscribeViewport(writeZoom), [subscribeViewport, writeZoom]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
      if (filterMenuRef.current && !filterMenuRef.current.contains(e.target as Node)) {
        setShowFilterMenu(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, []);

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

  const handleExportAction = (format: ERExportFormat) => {
    setShowExportMenu(false);
    onExport(format);
    if (format === 'clipboard' || format === 'mermaid') {
      setCopiedStatus(format);
      setTimeout(() => setCopiedStatus(null), 2500);
    }
  };

  return (
    <div className="er-toolbar-container">
      {/* Tools. A switch, not a menu: the two modes are the whole interaction model. */}
      <div className="er-btn-group er-tool-group">
        <button
          type="button"
          className={`er-toolbar-icon-btn ${tool === 'select' ? 'active' : ''}`}
          onClick={() => onToolChange('select')}
          title={t('er.toolSelectHint')}
          aria-label={t('er.toolSelect')}
        >
          <MousePointer2 size={13} />
        </button>
        <button
          type="button"
          className={`er-toolbar-icon-btn ${tool === 'hand' ? 'active' : ''}`}
          onClick={() => onToolChange('hand')}
          title={t('er.toolHandHint')}
          aria-label={t('er.toolHand')}
        >
          <Hand size={13} />
        </button>
      </div>

      <div className="er-toolbar-divider" />

      <span className="er-stat-pill">{t('er.statTables', { n: tableCount })}</span>
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
          className="er-toolbar-icon-btn"
          onClick={onFitView}
          title={t('er.fitView')}
        >
          <Maximize2 size={12} />
        </button>
        <button
          type="button"
          className="er-toolbar-icon-btn"
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
            <button
              type="button"
              className="er-menu-item"
              onClick={() => handleExportAction('mermaid')}
            >
              {copiedStatus === 'mermaid' ? (
                <Check size={13} className="er-green" />
              ) : (
                <FileCode size={13} />
              )}
              <span>
                {copiedStatus === 'mermaid' ? t('er.exportMermaidDone') : t('er.exportMermaid')}
              </span>
            </button>
            <button
              type="button"
              className="er-menu-item"
              onClick={() => handleExportAction('dbml')}
            >
              <FileCode size={13} />
              <span>{t('er.exportDbml')}</span>
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
