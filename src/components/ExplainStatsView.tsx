import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExplainNode } from '../utils/explainHelper';
import { toTsv } from '../utils/explainAdvisor';
import { ExplainCopyButton, ExplainToolbar } from './ExplainCopyButton';

interface ExplainStatsViewProps {
  rootNode: ExplainNode;
}

function flatten(node: ExplainNode): ExplainNode[] {
  return [node, ...(node.children || []).flatMap(flatten)];
}

interface StatGroup {
  nodeType: string;
  count: number;
  cost: number;
  costPct: number;
}

export const ExplainStatsView: React.FC<ExplainStatsViewProps> = ({ rootNode }) => {
  const { t } = useTranslation();

  const stats = useMemo(() => {
    const all = flatten(rootNode);
    const rootTotalCost = rootNode.cost?.total || 0;

    const groupMap: Record<string, { count: number; cost: number }> = {};
    let aggregatedCost = 0;

    for (const node of all) {
      const type = node.type || 'Unknown';
      const nodeCost = node.selfCost !== undefined ? node.selfCost : (node.cost?.total || 0);

      if (!groupMap[type]) {
        groupMap[type] = { count: 0, cost: 0 };
      }
      groupMap[type].count += 1;
      groupMap[type].cost += nodeCost;
      aggregatedCost += nodeCost;
    }

    const baselineCost = rootTotalCost > 0 ? rootTotalCost : (aggregatedCost > 0 ? aggregatedCost : 1);

    const list: StatGroup[] = Object.entries(groupMap).map(([nodeType, data]) => ({
      nodeType,
      count: data.count,
      cost: data.cost,
      costPct: Math.min(100, Math.max(0, (data.cost / baselineCost) * 100)),
    }));

    // Sort by Cost descending, then Count descending
    list.sort((a, b) => b.cost - a.cost || b.count - a.count);

    return list;
  }, [rootNode]);

  const cellStyle: React.CSSProperties = {
    padding: '8px 12px',
    borderBottom: '1px solid var(--win-border)',
    fontSize: '12px',
    color: 'var(--win-text-primary)',
  };

  const headStyle: React.CSSProperties = {
    padding: '8px 12px',
    textAlign: 'left',
    fontSize: '11px',
    fontWeight: 700,
    color: 'var(--win-text-disabled)',
    textTransform: 'uppercase',
    background: 'var(--win-bg-card)',
    borderBottom: '1px solid var(--win-border)',
    position: 'sticky',
    top: 0,
  };

  const asTsv = () => toTsv(
    [t('explain.colNodeType'), t('explain.colCount'), t('explain.colCost'), t('explain.colCostPct')],
    stats.map(s => [s.nodeType, s.count, s.cost.toFixed(2), `${s.costPct.toFixed(2)}%`]),
  );

  return (
    <div className="explain-view">
      <ExplainToolbar copy={<ExplainCopyButton getText={asTsv} label={t('explain.copyTable')} />} />
      <div className="explain-view-body explain-selectable">
      <div style={{ border: '1px solid var(--win-border)', borderRadius: '6px', overflow: 'hidden', background: 'var(--win-bg-card)' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ ...headStyle, width: '40%' }}>{t('explain.colNodeType', 'Node Type')}</th>
              <th style={{ ...headStyle, textAlign: 'right', width: '15%' }}>{t('explain.colCount', 'Count')}</th>
              <th style={{ ...headStyle, textAlign: 'right', width: '20%' }}>{t('explain.colCost', 'Cost')}</th>
              <th style={{ ...headStyle, width: '25%' }}>{t('explain.colCostPct', 'Cost (%)')}</th>
            </tr>
          </thead>
          <tbody>
            {stats.map(({ nodeType, count, cost, costPct }) => (
              <tr key={nodeType}>
                <td style={{ ...cellStyle, fontWeight: 600 }}>{nodeType}</td>
                <td style={{ ...cellStyle, textAlign: 'right', fontFamily: 'monospace' }}>{count}</td>
                <td style={{ ...cellStyle, textAlign: 'right', fontFamily: 'monospace' }}>{cost.toFixed(2)}</td>
                <td style={cellStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{
                      flex: 1,
                      height: '8px',
                      borderRadius: '4px',
                      background: 'var(--win-border)',
                      overflow: 'hidden'
                    }}>
                      <div style={{
                        width: `${costPct.toFixed(1)}%`,
                        height: '100%',
                        background: costPct > 50 ? 'var(--st-danger, #ef4444)' : costPct > 20 ? 'var(--st-warn, #f59e0b)' : 'var(--win-accent)',
                        borderRadius: '4px',
                        transition: 'width 0.3s ease'
                      }} />
                    </div>
                    <span style={{ fontSize: '11px', fontFamily: 'monospace', width: '48px', textAlign: 'right', color: 'var(--win-text-secondary)' }}>
                      {costPct.toFixed(2)}%
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>
    </div>
  );
};
