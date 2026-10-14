import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExplainNode } from '../utils/explainHelper';
import { planOutline } from '../utils/explainAdvisor';
import { ChevronDown, ChevronRight, Table } from 'lucide-react';
import { ExplainCopyButton, ExplainToolbar } from './ExplainCopyButton';

interface ExplainTreeViewProps {
  rootNode: ExplainNode;
}

// Cumulative-cost tier for the cost column. Colours come from the status tokens so both themes
// get their own shade.
function costTier(total: number): string {
  if (total > 1000) return 'var(--st-danger, #ef4444)';
  if (total > 100) return 'var(--st-warn, #f59e0b)';
  return 'var(--st-ok, #10b981)';
}

export const ExplainTreeView: React.FC<ExplainTreeViewProps> = ({ rootNode }) => {
  const { t, i18n } = useTranslation();

  // The tree as an indented outline — the shape `EXPLAIN FORMAT=TREE` prints, so it reads the
  // same pasted into a ticket or a chat.
  const asText = () => planOutline(rootNode, node => {
    const parts = [node.type];
    if (node.table && !node.type.includes(node.table)) parts.push(`on ${node.table}`);
    if (node.indexName) parts.push(`using ${node.indexName}`);
    const extra: string[] = [];
    if (node.cost) extra.push(`cost=${node.cost.start.toFixed(2)}..${node.cost.total.toFixed(2)}`);
    if (node.rows !== undefined) extra.push(`rows=${node.rows}`);
    return extra.length > 0 ? `${parts.join(' ')}  (${extra.join(' ')})` : parts.join(' ');
  });

  return (
    <div className="explain-view">
      <ExplainToolbar copy={<ExplainCopyButton getText={asText} label={t('explain.copyTree')} />} />
      <div className="explain-view-body explain-selectable">
        {/* Table Header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 140px 120px 140px 140px',
          padding: '8px 12px',
          background: 'var(--win-bg-card)',
          border: '1px solid var(--win-border)',
          borderRadius: '6px 6px 0 0',
          fontSize: '11px',
          fontWeight: 700,
          color: 'var(--win-text-disabled)',
          textTransform: 'uppercase',
          userSelect: 'none',
        }}>
          <div>{t('explain.colOperation')}</div>
          <div>{t('explain.colTable')}</div>
          <div>{t('explain.colIndex')}</div>
          <div>{t('explain.colCost')}</div>
          <div>{t('explain.colRows')}</div>
        </div>

        {/* Tree Rows */}
        <div style={{
          border: '1px solid var(--win-border)',
          borderTop: 'none',
          borderRadius: '0 0 6px 6px',
          background: 'var(--win-bg-card)'
        }}>
          <TreeNodeRow node={rootNode} level={0} locale={i18n.language} />
        </div>
      </div>
    </div>
  );
};

const TreeNodeRow: React.FC<{ node: ExplainNode; level: number; locale: string }> = ({ node, level, locale }) => {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children && node.children.length > 0;
  const costColor = costTier(node.cost?.total || 0);

  return (
    <>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 140px 120px 140px 140px',
        padding: '8px 12px',
        borderBottom: '1px solid var(--win-border)',
        fontSize: '12px',
        alignItems: 'center',
        background: 'transparent',
        transition: 'background 0.1s ease'
      }}>
        {/* Operation with Indentation & Collapse Toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', paddingLeft: `${level * 20}px` }}>
          {hasChildren ? (
            <button
              onClick={() => setExpanded(!expanded)}
              style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : (
            <div style={{ width: '14px' }} />
          )}
          <span style={{ fontWeight: 600, color: 'var(--win-text-primary)' }}>
            {node.type}
          </span>
        </div>

        {/* Table */}
        <div style={{ color: 'var(--win-text-secondary)', fontSize: '11.5px', display: 'flex', alignItems: 'center', gap: '4px' }}>
          {node.table ? (
            <>
              <Table size={12} />
              <span>{node.table}</span>
            </>
          ) : (
            <span style={{ opacity: 0.4 }}>—</span>
          )}
        </div>

        {/* Index */}
        <div style={{ color: 'var(--win-accent)', fontSize: '11.5px' }}>
          {node.indexName || <span style={{ opacity: 0.4, color: 'var(--win-text-disabled)' }}>—</span>}
        </div>

        {/* Cost */}
        <div style={{ fontSize: '11.5px', color: costColor, fontWeight: 600 }}>
          {node.cost ? `${node.cost.start.toFixed(1)} .. ${node.cost.total.toFixed(1)}` : '—'}
        </div>

        {/* Rows */}
        <div style={{ fontSize: '11.5px', color: 'var(--win-text-primary)' }}>
          {node.rows !== undefined ? node.rows.toLocaleString(locale) : '—'}
        </div>
      </div>

      {/* Render Sub-nodes */}
      {hasChildren && expanded && (
        node.children!.map(child => (
          <TreeNodeRow key={child.id} node={child} level={level + 1} locale={locale} />
        ))
      )}
    </>
  );
};
