// Database Info's Index tab: unused, duplicate and covered indexes, and the space dropping them
// would give back. Facts from `get_index_facts` (stats/index_usage.rs), judgement from
// utils/indexAnalysis.ts. Nothing is dropped from here: a DROP is opened in a SQL tab to be read.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CircleCheck, FileCode, Loader2, RefreshCw } from 'lucide-react';
import { dbHelper } from '../../utils/dbHelper';
import { analyzeIndexes, type IndexFacts, type IndexFinding, type IndexIssue } from '../../utils/indexAnalysis';
import './diagnostics.css';

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Counters younger than a week cannot tell "unused" from "used weekly". */
function isYoung(when: string | null): boolean {
  if (!when) return false;
  const t = Date.parse(when.replace(' ', 'T'));
  return Number.isFinite(t) && Date.now() - t < 7 * 24 * 3600 * 1000;
}

type Filter = 'all' | IndexIssue;

const hasDrop = (f: IndexFinding): boolean => f.dropSql !== null;

export const IndexHealthPanel: React.FC<{
  connId: string;
  /** Opens SQL in a new query tab (App's `openQueryTabWithSql`). */
  onOpenSql?: (sql: string) => void;
}> = ({ connId, onOpenSql }) => {
  const { t, i18n } = useTranslation();
  const [facts, setFacts] = useState<IndexFacts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setFacts(await dbHelper.getIndexFacts(connId));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [connId]);

  useEffect(() => {
    // set-state-in-effect: async IPC on mount, which is the case the rule cannot cover.
    // eslint-disable-next-line react/set-state-in-effect
    void load();
  }, [load]);

  const report = useMemo(() => (facts ? analyzeIndexes(facts) : null), [facts]);
  const count = (k: IndexIssue) => report?.findings.filter((f) => f.issues.includes(k)).length ?? 0;
  const shown = report ? report.findings.filter((f) => filter === 'all' || f.issues.includes(filter)) : [];

  const issueText = (f: IndexFinding, k: IndexIssue) => {
    switch (k) {
      case 'duplicate': return t('indexHealth.whyDuplicate', { other: f.duplicateOf ?? '' });
      case 'redundant': return t('indexHealth.whyRedundant', { other: f.coveredBy ?? '' });
      case 'unused': return t('indexHealth.whyUnused');
      case 'invalid': return t('indexHealth.whyInvalid');
    }
  };
  const issueLabel = (k: IndexIssue) => {
    switch (k) {
      case 'duplicate': return t('indexHealth.duplicate');
      case 'redundant': return t('indexHealth.redundant');
      case 'unused': return t('indexHealth.unused');
      case 'invalid': return t('indexHealth.invalid');
    }
  };

  const script = (list: IndexFinding[]) =>
    [`-- ${t('indexHealth.scriptHeader')}`, '', ...list.filter((f) => f.dropSql).map((f) => `-- ${f.table}.${f.index}: ${f.issues.map((k) => issueText(f, k)).join('; ')}\n${f.dropSql}`)].join('\n');

  const since = facts?.statsReset
    ? t('indexHealth.statsSince', { when: facts.statsReset })
    : facts?.serverStarted
      ? t('indexHealth.statsSinceStart', { when: facts.serverStarted })
      : null;
  const young = isYoung(facts?.statsReset ?? facts?.serverStarted ?? null);

  return (
    <div className="ih-root">
      <div className="ih-head">
        <div className="ih-cards">
          <div className="ih-card"><span>{t('indexHealth.total')}</span><b>{report?.totalIndexes ?? '—'}</b></div>
          <div className="ih-card warn"><span>{t('indexHealth.unused')}</span><b>{facts?.usageAvailable ? count('unused') : '—'}</b></div>
          <div className="ih-card warn"><span>{t('indexHealth.duplicate')}</span><b>{report ? count('duplicate') : '—'}</b></div>
          <div className="ih-card warn"><span>{t('indexHealth.redundant')}</span><b>{report ? count('redundant') : '—'}</b></div>
          <div className="ih-card accent">
            <span>{t('indexHealth.reclaimable')}</span>
            <b>{report ? report.reclaimableBytes == null ? t('indexHealth.unknownSize') : fmtBytes(report.reclaimableBytes) : '—'}</b>
          </div>
        </div>
        <button type="button" className="btn btn-secondary ih-refresh" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={12} className={loading ? 'diag-spin' : ''} /> {t('indexHealth.refresh')}
        </button>
      </div>

      {error && <div className="lt-banner error"><AlertTriangle size={13} /> {error}</div>}
      {facts && !facts.usageAvailable && <div className="lt-banner">{t('indexHealth.noUsage')}</div>}
      {facts?.usageAvailable && since && (
        <div className={`lt-banner${young ? ' warn' : ''}`}>
          {since} {young && t('indexHealth.statsYoung')}
        </div>
      )}

      {!facts && !error && <div className="lt-empty"><Loader2 size={14} className="diag-spin" /> {t('indexHealth.loading')}</div>}

      {report && report.findings.length === 0 && <div className="lt-empty ok"><CircleCheck size={15} /> {t('indexHealth.none')}</div>}

      {report && report.findings.length > 0 && (
        <>
          <div className="ih-toolbar">
            {(['all', 'unused', 'duplicate', 'redundant', 'invalid'] as const)
              .filter((k) => k === 'all' || count(k) > 0)
              .map((k) => (
                <button key={k} type="button" className={`ih-chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>
                  {k === 'all' ? t('indexHealth.all') : issueLabel(k)} {k === 'all' ? report.findings.length : count(k)}
                </button>
              ))}
            <span className="lt-spacer" />
            {onOpenSql && shown.some(hasDrop) && (
              <button type="button" className="btn btn-secondary" onClick={() => onOpenSql(script(shown))}>
                <FileCode size={12} /> {t('indexHealth.openAll')}
              </button>
            )}
          </div>
          <div className="ih-table-wrap">
            <table className="ih-table">
              <thead>
                <tr>
                  <th>{t('indexHealth.colTable')}</th>
                  <th>{t('indexHealth.colIndex')}</th>
                  <th>{t('indexHealth.colColumns')}</th>
                  <th>{t('indexHealth.colIssue')}</th>
                  <th className="num">{t('indexHealth.colSize')}</th>
                  <th className="num">{t('indexHealth.colScans')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((f) => (
                  <tr key={`${f.table}.${f.index}`}>
                    <td className="mono">{f.table}</td>
                    <td className="mono">{f.index}</td>
                    <td className="mono dim">{f.columns.join(', ')}</td>
                    <td>
                      {f.issues.map((k) => (
                        <div key={k} className={`ih-issue ${k}`}>{issueText(f, k)}</div>
                      ))}
                      {f.backsForeignKey && (
                        <div className="ih-issue fk">
                          <AlertTriangle size={11} /> {facts?.dialect === 'mysql' ? t('indexHealth.fkWarnMysql') : t('indexHealth.fkWarn')}
                        </div>
                      )}
                    </td>
                    <td className="num">{fmtBytes(f.sizeBytes)}</td>
                    <td className="num">{f.scans == null ? '—' : f.scans.toLocaleString(i18n.language)}</td>
                    <td>
                      {onOpenSql && f.dropSql && (
                        <button type="button" className="btn btn-secondary ih-drop" title={t('indexHealth.openDropTitle')} onClick={() => onOpenSql(script([f]))}>
                          {t('indexHealth.openDrop')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};
