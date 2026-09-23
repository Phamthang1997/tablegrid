import React, { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { ExplainResult } from '../utils/explainHelper';
import { suggestIndexes } from '../utils/explainAdvisor';
import { ExplainDiagramView } from './ExplainDiagramView';
import { ExplainGridView } from './ExplainGridView';
import { ExplainTreeView } from './ExplainTreeView';
import { ExplainStatsView } from './ExplainStatsView';
import { ExplainRawView } from './ExplainRawView';
import { ExplainIndexView } from './ExplainIndexView';
import { ExplainCompareView } from './ExplainCompareView';
import {
  Network, GitFork, FileText, Clock, Zap, Grid3x3, BarChart3, GitCompareArrows, Lightbulb, Pin, PinOff,
} from 'lucide-react';

type ViewMode = 'diagram' | 'plan' | 'tree' | 'stats' | 'raw' | 'compare' | 'index';

type TabLabelKey =
  | 'explain.tabDiagram' | 'explain.tabPlan' | 'explain.tabTree' | 'explain.tabStats' | 'explain.tabRaw'
  | 'explain.tabCompare' | 'explain.tabIndex';

const VIEW_TABS: { mode: ViewMode; labelKey: TabLabelKey; Icon: typeof Network }[] = [
  { mode: 'diagram', labelKey: 'explain.tabDiagram', Icon: Network },
  { mode: 'plan', labelKey: 'explain.tabPlan', Icon: Grid3x3 },
  { mode: 'tree', labelKey: 'explain.tabTree', Icon: GitFork },
  { mode: 'stats', labelKey: 'explain.tabStats', Icon: BarChart3 },
  { mode: 'raw', labelKey: 'explain.tabRaw', Icon: FileText },
  { mode: 'index', labelKey: 'explain.tabIndex', Icon: Lightbulb },
  { mode: 'compare', labelKey: 'explain.tabCompare', Icon: GitCompareArrows },
];

interface ExplainViewerProps {
  explainResult: ExplainResult;
  /** Dialect, for the quoting of suggested CREATE INDEX statements. */
  dbType: string;
  /** The plan to compare against: a pinned one, or else the pane's previous EXPLAIN. */
  baseline?: ExplainResult | null;
  /** Whether `baseline` was pinned by the user (it then survives further runs). */
  baselinePinned?: boolean;
  onPinCurrent?: () => void;
  onUnpin?: () => void;
  /** Re-runs the plan as FORMAT=JSON, the only MySQL variant that reports cost. */
  onRequestJsonPlan?: () => void;
}

export const ExplainViewer: React.FC<ExplainViewerProps> = ({
  explainResult, dbType, baseline, baselinePinned = false, onPinCurrent, onUnpin, onRequestJsonPlan,
}) => {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<ViewMode>('diagram');

  const { rawText, rootNode, planningTimeMs, executionTimeMs } = explainResult;
  const suggestions = useMemo(
    () => suggestIndexes(rootNode, explainResult.sourceSql || '', dbType),
    [rootNode, explainResult.sourceSql, dbType],
  );

  // Nothing to compare while the baseline IS this plan (it was just pinned).
  const comparable = !!baseline && baseline !== explainResult;
  const currentIsPinned = baselinePinned && baseline === explainResult;
  // A tab that disappears (no baseline any more) must not leave the pane blank.
  const mode: ViewMode = viewMode === 'compare' && !comparable ? 'diagram' : viewMode;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden' }}>
      {/* Header Bar with View Switcher & Timings */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '10px',
        padding: '6px 12px',
        background: 'var(--win-bg-card)',
        borderBottom: '1px solid var(--win-border)'
      }}>
        {/* View Switcher Segmented Control */}
        <div style={{
          display: 'flex',
          background: 'var(--win-bg-window)',
          padding: '2px',
          borderRadius: '6px',
          border: '1px solid var(--win-border)',
          flexWrap: 'wrap',
        }}>
          {VIEW_TABS.filter(tab => tab.mode !== 'compare' || comparable).map(({ mode: m, labelKey, Icon }) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              style={{
                padding: '3px 10px',
                fontSize: '11px',
                fontWeight: 600,
                border: 'none',
                borderRadius: '4px',
                background: mode === m ? 'var(--win-accent)' : 'transparent',
                color: mode === m ? '#fff' : 'var(--win-text-secondary)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'all 0.12s ease'
              }}
            >
              <Icon size={12} />
              <span>{t(labelKey)}</span>
              {m === 'index' && suggestions.length > 0 && (
                <span className={`explain-tab-count${mode === m ? ' is-active' : ''}`}>{suggestions.length}</span>
              )}
            </button>
          ))}
        </div>

        {/* Timings summary + baseline pin */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '11px', color: 'var(--win-text-secondary)' }}>
          {planningTimeMs !== undefined && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Clock size={12} />
              <span><Trans i18nKey="explain.planningTime" values={{ ms: planningTimeMs.toFixed(2) }} components={{ strong: <strong /> }} /></span>
            </div>
          )}
          {executionTimeMs !== undefined && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--st-ok)' }}>
              <Zap size={12} />
              <span><Trans i18nKey="explain.executionTime" values={{ ms: executionTimeMs.toFixed(2) }} components={{ strong: <strong /> }} /></span>
            </div>
          )}
          {onPinCurrent && (
            <button
              type="button"
              className={`btn btn-secondary explain-copy-btn${currentIsPinned ? ' is-on' : ''}`}
              onClick={currentIsPinned ? onUnpin : onPinCurrent}
              title={currentIsPinned ? t('explain.unpinPlanTitle') : t('explain.pinPlanTitle')}
            >
              {currentIsPinned ? <PinOff size={13} /> : <Pin size={13} />}
              <span>{currentIsPinned ? t('explain.unpinPlan') : t('explain.pinPlan')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Content Area */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {mode === 'diagram' && (
          rootNode
            ? (
              <ExplainDiagramView
                result={explainResult}
                onRequestJsonPlan={onRequestJsonPlan}
                indexSuggestionCount={suggestions.length}
                onShowIndexSuggestions={() => setViewMode('index')}
              />
            )
            : <ExplainRawView rawText={rawText} />
        )}
        {mode === 'plan' && (
          rootNode ? <ExplainGridView rootNode={rootNode} /> : <ExplainRawView rawText={rawText} />
        )}
        {mode === 'tree' && (
          rootNode ? <ExplainTreeView rootNode={rootNode} /> : <ExplainRawView rawText={rawText} />
        )}
        {mode === 'stats' && (
          rootNode ? <ExplainStatsView rootNode={rootNode} /> : <ExplainRawView rawText={rawText} />
        )}
        {mode === 'raw' && (
          <ExplainRawView rawText={rawText} />
        )}
        {mode === 'index' && <ExplainIndexView suggestions={suggestions} />}
        {mode === 'compare' && comparable && (
          <ExplainCompareView
            before={baseline!}
            after={explainResult}
            pinned={baselinePinned}
            onUnpin={() => onUnpin?.()}
          />
        )}
      </div>
    </div>
  );
};
