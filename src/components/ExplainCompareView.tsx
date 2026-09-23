import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Pin, PinOff, TrendingDown, TrendingUp, Minus, Plus, X, Equal } from 'lucide-react';
import type { ExplainResult } from '../utils/explainHelper';
import type { AccessVerdict, TableAccess } from '../utils/explainAdvisor';
import { comparePlans, toTsv } from '../utils/explainAdvisor';
import { flagLabelKey } from './explainLabels';
import { ExplainCopyButton, ExplainToolbar } from './ExplainCopyButton';

interface ExplainCompareViewProps {
  before: ExplainResult;
  after: ExplainResult;
  /** true: `before` is a plan the user pinned; false: it is simply the previous EXPLAIN. */
  pinned: boolean;
  onUnpin: () => void;
}

function verdictKey(v: AccessVerdict) {
  switch (v) {
    case 'better': return 'explain.verdictBetter' as const;
    case 'worse': return 'explain.verdictWorse' as const;
    case 'same': return 'explain.verdictSame' as const;
    case 'added': return 'explain.verdictAdded' as const;
    case 'removed': return 'explain.verdictRemoved' as const;
  }
}

const VERDICT_ICON = {
  better: TrendingDown,
  worse: TrendingUp,
  same: Equal,
  added: Plus,
  removed: X,
} as const;

// The SQL behind a plan, one line, for the "what was compared" header. The EXPLAIN prefix is the
// same on both sides and says nothing.
function oneLine(sql: string | undefined): string {
  return (sql || '').replace(/^\s*explain\b(\s*\([^)]*\)|\s+format\s*=\s*\w+|\s+analyze)*/i, '').replace(/\s+/g, ' ').trim();
}

export const ExplainCompareView: React.FC<ExplainCompareViewProps> = ({ before, after, pinned, onUnpin }) => {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const cmp = useMemo(() => comparePlans(before, after), [before, after]);

  const fmt = (n: number | undefined, digits = 2) =>
    n === undefined ? '—' : n.toLocaleString(locale, { maximumFractionDigits: n >= 1000 ? 0 : digits });

  const describe = (a: TableAccess | undefined) => {
    if (!a) return '—';
    const parts = [a.operator];
    if (a.index) parts.push(`[${a.index}]`);
    if (a.rows !== undefined) parts.push(`${fmt(a.rows, 0)} ${t('explain.colRows').toLowerCase()}`);
    if (a.selfCost) parts.push(`${t('explain.colCost')} ${fmt(a.selfCost)}`);
    return parts.join(' · ');
  };

  const asTsv = () => toTsv(
    [t('explain.colTable'), t('explain.colBefore'), t('explain.colAfter'), t('explain.colChange')],
    [
      [t('explain.totalCost'), fmt(cmp.costBefore), fmt(cmp.costAfter),
        cmp.costDeltaPct === undefined ? '' : `${cmp.costDeltaPct > 0 ? '+' : ''}${cmp.costDeltaPct.toFixed(1)}%`],
      ...cmp.tables.map(d => [d.table, describe(d.before), describe(d.after), t(verdictKey(d.verdict))]),
    ],
  );

  const delta = cmp.costDeltaPct;
  const deltaClass = delta === undefined || Math.abs(delta) < 5 ? 'is-same' : delta < 0 ? 'is-better' : 'is-worse';

  return (
    <div className="explain-view">
      <ExplainToolbar copy={<ExplainCopyButton getText={asTsv} label={t('explain.copyTable')} />}>
        <span className="explain-toolbar-note">
          {pinned ? <Pin size={12} /> : null}
          {pinned ? t('explain.compareAgainstPinned') : t('explain.compareAgainstPrevious')}
        </span>
        {pinned && (
          <button type="button" className="btn btn-secondary explain-copy-btn" onClick={onUnpin}>
            <PinOff size={13} />
            <span>{t('explain.unpinPlan')}</span>
          </button>
        )}
      </ExplainToolbar>

      <div className="explain-view-body explain-selectable">
        {/* What was compared: the two statements, so a comparison across two different queries
            is visibly that rather than read as a before/after of one. */}
        <div className="explain-cmp-sql">
          <div><span>{t('explain.colBefore')}</span><code title={oneLine(before.sourceSql)}>{oneLine(before.sourceSql) || '—'}</code></div>
          <div><span>{t('explain.colAfter')}</span><code title={oneLine(after.sourceSql)}>{oneLine(after.sourceSql) || '—'}</code></div>
        </div>

        {cmp.identical && <div className="explain-cmp-identical">{t('explain.compareIdentical')}</div>}

        <div className="explain-cmp-cards">
          <div className={`explain-cmp-card ${deltaClass}`}>
            <div className="explain-cmp-label">{t('explain.totalCost')}</div>
            <div className="explain-cmp-values">
              <span>{fmt(cmp.costBefore)}</span>
              <ArrowRight size={14} />
              <strong>{fmt(cmp.costAfter)}</strong>
            </div>
            {delta !== undefined
              ? <div className="explain-cmp-delta">{delta > 0 ? '+' : ''}{delta.toFixed(1)}%</div>
              : <div className="explain-cmp-delta is-muted">{t('explain.compareNoCost')}</div>}
          </div>

          {cmp.timeBefore !== undefined && cmp.timeAfter !== undefined && (
            <div className={`explain-cmp-card ${cmp.timeAfter < cmp.timeBefore * 0.95 ? 'is-better' : cmp.timeAfter > cmp.timeBefore * 1.05 ? 'is-worse' : 'is-same'}`}>
              <div className="explain-cmp-label">{t('explain.compareTime')}</div>
              <div className="explain-cmp-values">
                <span>{cmp.timeBefore.toFixed(2)} ms</span>
                <ArrowRight size={14} />
                <strong>{cmp.timeAfter.toFixed(2)} ms</strong>
              </div>
            </div>
          )}

          {cmp.flags.length > 0 && (
            <div className="explain-cmp-card explain-cmp-flags">
              <div className="explain-cmp-label">{t('explain.compareFlags')}</div>
              {cmp.flags.map(f => (
                <div key={f.flag} className={`explain-cmp-flag ${f.after < f.before ? 'is-better' : 'is-worse'}`}>
                  {f.after < f.before ? <Minus size={12} /> : <Plus size={12} />}
                  <span>{t(flagLabelKey(f.flag))}</span>
                  <em>{f.before} → {f.after}</em>
                </div>
              ))}
            </div>
          )}
        </div>

        {cmp.tables.length > 0 && (
          <table className="explain-cmp-table">
            <thead>
              <tr>
                <th>{t('explain.colTable')}</th>
                <th>{t('explain.colBefore')}</th>
                <th>{t('explain.colAfter')}</th>
                <th>{t('explain.colChange')}</th>
              </tr>
            </thead>
            <tbody>
              {cmp.tables.map(d => {
                const Icon = VERDICT_ICON[d.verdict];
                return (
                  <tr key={d.table}>
                    <td className="explain-cmp-table-name">{d.table}</td>
                    <td>{describe(d.before)}</td>
                    <td>{describe(d.after)}</td>
                    <td>
                      <span className={`explain-verdict is-${d.verdict}`}>
                        <Icon size={12} />
                        {t(verdictKey(d.verdict))}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
