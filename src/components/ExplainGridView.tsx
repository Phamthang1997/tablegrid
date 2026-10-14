import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExplainNode } from '../utils/explainHelper';
import { planFieldText } from '../utils/explainHelper';
import { Table as TableIcon } from 'lucide-react';
import { toTsv } from '../utils/explainAdvisor';
import { ExplainCopyButton, ExplainToolbar } from './ExplainCopyButton';

interface ExplainGridViewProps {
  rootNode: ExplainNode;
}

// Surfaced as their own columns, so they are not repeated from `details`.
const HOISTED_KEYS = new Set(['table', 'table_name', 'TABLE']);

function flatten(node: ExplainNode): ExplainNode[] {
  return [node, ...(node.children || []).flatMap(flatten)];
}

export const ExplainGridView: React.FC<ExplainGridViewProps> = ({ rootNode }) => {
  const { t } = useTranslation();

  const { nodes, columns } = useMemo(() => {
    const all = flatten(rootNode);
    // Column order follows the order the driver reported the fields in, which for a tabular
    // EXPLAIN is the server's own column order.
    const seen: string[] = [];
    for (const node of all) {
      for (const [key, value] of Object.entries(node.details || {})) {
        if (HOISTED_KEYS.has(key) || seen.includes(key)) continue;
        if (planFieldText(value) === null) continue;
        seen.push(key);
      }
    }
    return { nodes: all, columns: seen };
  }, [rootNode]);

  const cellStyle: React.CSSProperties = {
    padding: '6px 10px',
    borderBottom: '1px solid var(--win-border)',
    fontSize: '11.5px',
    color: 'var(--win-text-primary)',
    whiteSpace: 'nowrap',
    maxWidth: '280px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };

  const headStyle: React.CSSProperties = {
    padding: '8px 10px',
    textAlign: 'left',
    fontSize: '11px',
    fontWeight: 700,
    color: 'var(--win-text-disabled)',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
    background: 'var(--win-bg-card)',
    borderBottom: '1px solid var(--win-border)',
    position: 'sticky',
    top: 0,
  };

  // The same cells as the table, one row per operator — pastes into a spreadsheet as-is.
  const asTsv = () => toTsv(
    [t('explain.colOperation'), t('explain.colTable'), ...columns],
    nodes.map(node => [node.type, node.table, ...columns.map(key => planFieldText(node.details?.[key]) ?? '')]),
  );

  return (
    <div className="explain-view">
      <ExplainToolbar copy={<ExplainCopyButton getText={asTsv} label={t('explain.copyTable')} />} />
      <div className="explain-view-body explain-selectable">
      <div style={{ border: '1px solid var(--win-border)', borderRadius: '6px', overflow: 'hidden', background: 'var(--win-bg-card)' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={headStyle}>{t('explain.colOperation')}</th>
              <th style={headStyle}>{t('explain.colTable')}</th>
              {columns.map(key => (
                // Raw driver field names (select_type, possible_keys, key_len…) — data, not prose.
                <th key={key} style={headStyle}>{key}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {nodes.map(node => (
              <tr key={node.id}>
                <td style={{ ...cellStyle, fontWeight: 600 }} title={node.type}>{node.type}</td>
                <td style={{ ...cellStyle, color: 'var(--win-text-secondary)' }} title={node.table || ''}>
                  {node.table ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                      <TableIcon size={12} />
                      <span>{node.table}</span>
                    </span>
                  ) : (
                    <span style={{ opacity: 0.4 }}>—</span>
                  )}
                </td>
                {columns.map(key => {
                  const text = planFieldText(node.details?.[key]) ?? '';
                  return (
                    <td key={key} style={cellStyle} title={text}>
                      {text || <span style={{ opacity: 0.4 }}>—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>
    </div>
  );
};
