import React from 'react';
import { useTranslation } from 'react-i18next';
import { Lightbulb, Table, Info } from 'lucide-react';
import type { IndexSuggestion } from '../utils/explainAdvisor';
import { SUGGEST_MIN_ROWS } from '../utils/explainAdvisor';
import { ExplainCopyButton, ExplainToolbar } from './ExplainCopyButton';

interface ExplainIndexViewProps {
  suggestions: IndexSuggestion[];
}

/**
 * Index candidates for the plan's full scans. Every card shows the predicates its columns came
 * from, so the suggestion can be checked against the query rather than taken on trust — and the
 * caveat says plainly that the only proof is the next EXPLAIN, which the Compare tab then reads.
 */
export const ExplainIndexView: React.FC<ExplainIndexViewProps> = ({ suggestions }) => {
  const { t, i18n } = useTranslation();
  const allSql = () => suggestions.map(s => s.sql).join('\n');

  return (
    <div className="explain-view">
      <ExplainToolbar
        copy={suggestions.length > 0
          ? <ExplainCopyButton getText={allSql} label={t('explain.indexCopyAll')} />
          : null}
      >
        <span className="explain-toolbar-note">
          <Info size={12} />
          {t('explain.indexCaveat')}
        </span>
      </ExplainToolbar>

      <div className="explain-view-body explain-selectable">
        {suggestions.length === 0 ? (
          <div className="explain-empty">
            <Lightbulb size={22} />
            <div className="explain-empty-title">{t('explain.indexEmpty')}</div>
            <div className="explain-empty-hint">
              {t('explain.indexEmptyHint', { n: SUGGEST_MIN_ROWS.toLocaleString(i18n.language) })}
            </div>
          </div>
        ) : (
          <div className="explain-index-list">
            {suggestions.map(s => (
              <div key={s.sql} className="explain-index-card">
                <div className="explain-index-head">
                  <Table size={14} />
                  <strong>{s.table}</strong>
                  {s.alias && <span className="explain-index-alias">({s.alias})</span>}
                  <span className="explain-index-rows">
                    {t('explain.indexRows', { n: s.rows.toLocaleString(i18n.language) })}
                  </span>
                  <span className="explain-index-copy">
                    <ExplainCopyButton getText={() => s.sql} label={t('explain.indexCopy')} />
                  </span>
                </div>

                <div className="explain-index-cols">
                  {s.columns.map(c => (
                    <span key={c.name} className={`explain-index-col is-${c.kind}`}>
                      {c.name}
                      <em>{c.kind === 'range' ? t('explain.indexKindRange') : t('explain.indexKindEq')}</em>
                    </span>
                  ))}
                </div>

                <pre className="explain-index-sql">{s.sql}</pre>

                <div className="explain-index-why">
                  <span>{t('explain.indexFrom')}</span>
                  {s.predicates.map(p => <code key={p}>{p}</code>)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
