import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { dbHelper } from '../utils/dbHelper';
import {
  VECTOR_INDEX_SQL,
  VECTOR_METRICS,
  buildKnnSql,
  declaredDim,
  indexFor,
  parseVectorText,
  planUsesIndex,
  recallOf,
  parseTuning,
  EF_SEARCH_MAX,
  PROBES_MAX,
  regclassName,
  toVectorText,
  vectorKindOf,
  vectorStats,
  type Recall,
  type VectorIndex,
  type VectorMetric,
} from '../utils/pgvector';

/**
 * pgvector tools opened from DataGrid's cell menu: a vector's shape (dimensions, norm, components)
 * and a k-NN playground over the table. All parsing and SQL building is in `utils/pgvector.ts`.
 */

const copyText = (text: string) => {
  navigator.clipboard.writeText(text).catch(() => {});
};

const COMPONENTS_SHOWN = 64;
const COMPONENTS_MAX = 4096;

// ─── Inspector ───────────────────────────────────────────────────────────────────────────

export const VectorInspectorDialog: React.FC<{
  column: string;
  colType: string;
  value: string;
  onSearch?: () => void;
  onClose: () => void;
}> = ({ column, colType, value, onSearch, onClose }) => {
  const { t, i18n } = useTranslation();
  const parsed = useMemo(() => parseVectorText(value), [value]);
  const stats = useMemo(() => (parsed ? vectorStats(parsed) : null), [parsed]);
  const [showAll, setShowAll] = useState(false);
  const num = (n: number) => n.toLocaleString(i18n.language, { maximumFractionDigits: 6 });
  const declared = declaredDim(colType);

  const components = useMemo(() => {
    if (!parsed) return [];
    const all = parsed.indices.map((idx, k) => ({ idx, v: parsed.values[k] }));
    return showAll ? all.slice(0, COMPONENTS_MAX) : all.slice(0, COMPONENTS_SHOWN);
  }, [parsed, showAll]);
  const peak = stats ? Math.max(Math.abs(stats.min), Math.abs(stats.max)) || 1 : 1;
  const listed = parsed ? parsed.indices.length : 0;

  return (
    <Modal
      title={<>{t('pgvector.inspectTitle')} — <span className="vec-title-col">{column}</span></>}
      onClose={onClose}
      width="480px"
      maxWidth="92%"
      zIndex={99998}
    >
      <ModalBody>
        {!parsed || !stats ? (
          <div className="gt-editor-msg">{t('pgvector.notParsed')}</div>
        ) : (
          <>
            <dl className="gt-stats" style={{ margin: 0 }}>
              <dt>{t('pgvector.type')}</dt><dd>{colType}</dd>
              <dt>{t('pgvector.dims')}</dt>
              <dd>{declared !== null && declared !== stats.dim
                ? t('pgvector.dimsDeclared', { n: num(stats.dim), declared: num(declared) })
                : num(stats.dim)}</dd>
              {parsed.sparse && <><dt>{t('pgvector.nonZero')}</dt><dd>{num(stats.nonZero)}</dd></>}
              <dt>{t('pgvector.norm')}</dt><dd onClick={() => copyText(String(stats.norm))}>{num(stats.norm)}</dd>
              <div className="gt-stats-sep" />
              <dt>{t('pgvector.min')}</dt><dd>{num(stats.min)}</dd>
              <dt>{t('pgvector.max')}</dt><dd>{num(stats.max)}</dd>
              <dt>{t('pgvector.mean')}</dt><dd>{num(stats.mean)}</dd>
            </dl>
            {stats.dim > 0 && Math.abs(stats.norm - 1) < 1e-3 && <div className="gt-note">{t('pgvector.unitHint')}</div>}

            <div className="gt-toolbar">
              <span className="vec-section">{t('pgvector.components')}</span>
              <span className="gt-spacer" />
              {listed > components.length && (
                <>
                  <span className="gt-note">{t('pgvector.showFirst', { shown: num(components.length), n: num(listed) })}</span>
                  {!showAll && (
                    <button className="btn btn-secondary" onClick={() => setShowAll(true)}>{t('pgvector.showAll')}</button>
                  )}
                </>
              )}
            </div>
            <div className="vec-components">
              {components.map(({ idx, v }) => (
                <div key={idx} className="vec-comp">
                  <span className="vec-comp-idx">{parsed.sparse ? idx + 1 : idx}</span>
                  <span className="vec-comp-bar">
                    <span
                      className={v < 0 ? 'neg' : 'pos'}
                      // Half the track per sign, so a negative value grows left of the centre line.
                      style={{ width: `${(Math.abs(v) / peak) * 50}%` }}
                    />
                  </span>
                  <span className="vec-comp-val">{v}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <button className="btn btn-secondary" onClick={() => copyText(value)}>{t('common.copy')}</button>
        {onSearch && parsed && (
          <button className="btn btn-secondary" onClick={onSearch}>{t('pgvector.ctxSearch')}</button>
        )}
        <button className="btn btn-primary" onClick={onClose}>{t('common.close')}</button>
      </ModalFooter>
    </Modal>
  );
};

// ─── k-NN playground ─────────────────────────────────────────────────────────────────────

const METRIC_LABEL_KEY = {
  cosine: 'pgvector.metricCosine',
  l2: 'pgvector.metricL2',
  ip: 'pgvector.metricIp',
  l1: 'pgvector.metricL1',
} as const;

/** Wall time of a call, in ms. Outside the component: the clock is not something a render may read. */
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await fn();
  return [value, Math.round(performance.now() - started)];
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

export const VectorSearchDialog: React.FC<{
  connId: string;
  table: string;
  /** Set for a session-temporary table; otherwise the connection's current schema is used. */
  tableSchema?: string;
  vectorColumns: { name: string; type: string }[];
  initialColumn: string;
  initialVector?: string;
  onClose: () => void;
}> = ({ connId, table, tableSchema, vectorColumns, initialColumn, initialVector, onClose }) => {
  const { t, i18n } = useTranslation();
  const [column, setColumn] = useState(initialColumn);
  const [metric, setMetric] = useState<VectorMetric>('cosine');
  const [k, setK] = useState(10);
  const [text, setText] = useState(initialVector ?? '');
  const [schema, setSchema] = useState<string | null | undefined>(tableSchema);
  const [indexes, setIndexes] = useState<VectorIndex[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The SQL and parameter a result came from, so the exact comparison asks the same question even
  // after the form has been edited.
  const [result, setResult] = useState<{ columns: string[]; data: any[]; ms: number; sql: string; param: string; exactSql: string; tuning: string | null } | null>(null);
  // Text of the ef_search / probes box: empty keeps the server's value.
  const [tuningText, setTuningText] = useState('');
  const [recall, setRecall] = useState<{ r: Recall; ms: number } | null>(null);
  const [plan, setPlan] = useState<string | null>(null);

  const colType = vectorColumns.find((c) => c.name === column)?.type ?? '';
  const kind = vectorKindOf(colType) ?? 'vector';

  // The schema and the table's vector indexes are read once, on open. `schema === undefined`
  // means "not resolved yet"; null means "unqualified" (no schema reported).
  useEffect(() => {
    let alive = true;
    (async () => {
      let sch = tableSchema;
      if (!sch) {
        const res = await dbHelper.listSchemas(connId);
        sch = res.current ?? undefined;
      }
      if (!alive) return;
      setSchema(sch ?? null);
      const res = await dbHelper.executeQuery(connId, VECTOR_INDEX_SQL, [regclassName(sch, table)]);
      if (alive) setIndexes(res.success ? (res.data as VectorIndex[]) : []);
    })();
    return () => { alive = false; };
  }, [connId, table, tableSchema]);

  const parsed = useMemo(() => parseVectorText(text), [text]);
  const declared = declaredDim(colType);
  const problem = !text.trim()
    ? null
    : !parsed
      ? t('pgvector.badVector')
      : declared !== null && parsed.dim !== declared
        ? t('pgvector.dimMismatch', { declared, n: parsed.dim })
        : null;
  const zeroCosine = !!parsed && metric === 'cosine' && vectorStats(parsed).norm === 0;
  const sql = buildKnnSql({ schema, table, column, kind, metric, k });
  const param = parsed ? toVectorText(parsed, kind) : '';

  const served = indexes ? indexFor(indexes, column, kind, metric) : null;
  // The knob that matters is the one of the index serving this search: ef_search for HNSW, probes
  // for IVFFlat. With no index there is nothing approximate to tune.
  const tuningKind = served?.method === 'hnsw' ? 'efSearch' : served?.method === 'ivfflat' ? 'probes' : null;
  const tuning = tuningKind ? parseTuning(tuningText, tuningKind === 'efSearch' ? EF_SEARCH_MAX : PROBES_MAX) : { bad: false };
  const settings = tuningKind && tuning.value !== undefined ? { [tuningKind]: tuning.value } : {};
  const tuningLabel = tuningKind && tuning.value !== undefined
    ? `${tuningKind === 'efSearch' ? 'hnsw.ef_search' : 'ivfflat.probes'} = ${tuning.value}`
    : null;
  const ready = !!parsed && !problem && !tuning.bad && schema !== undefined && !busy;
  const otherMetrics = indexes
    ? VECTOR_METRICS.filter((m) => m.id !== metric && indexFor(indexes, column, kind, m.id)).map((m) => t(METRIC_LABEL_KEY[m.id]))
    : [];

  const run = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    setPlan(null);
    setRecall(null);
    const [res, ms] = await timed(() => dbHelper.vectorSearch(connId, sql, [param], settings));
    setBusy(false);
    if (!res.success) { setError(res.error ?? ''); setResult(null); return; }
    const exactSql = buildKnnSql({ schema, table, column, kind, metric, k, exact: true });
    setResult({ columns: res.columns ?? [], data: res.data ?? [], ms, sql, param, exactSql, tuning: tuningLabel });
  };

  /** The same query as a full scan: the ground truth an approximate index is measured against. */
  const compareExact = async () => {
    if (!result || busy) return;
    setBusy(true);
    setError(null);
    const [res, ms] = await timed(() => dbHelper.executeQuery(connId, result.exactSql, [result.param]));
    setBusy(false);
    if (!res.success) { setError(res.error ?? ''); return; }
    setRecall({ r: recallOf(result.columns, result.data, res.data ?? []), ms });
  };

  const explain = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const res = await dbHelper.vectorSearch(connId, `EXPLAIN ${sql}`, [param], settings);
    setBusy(false);
    if (!res.success) { setError(res.error ?? ''); return; }
    const col = res.columns?.[0] ?? 'QUERY PLAN';
    setPlan((res.data ?? []).map((r) => String(r[col])).join('\n'));
  };

  const scoreIsSimilarity = metric === 'ip';
  const planHitsIndex = plan !== null && !!served && planUsesIndex(plan, served.name);

  return (
    <Modal
      title={t('pgvector.searchTitle', { table })}
      onClose={onClose}
      closeDisabled={busy}
      width="880px"
      maxWidth="94vw"
      height="80vh"
      zIndex={99998}
    >
      <ModalBody style={{ flex: 1 }}>
        <div className="vec-form">
          <label>
            <span>{t('pgvector.column')}</span>
            <select className="form-input" value={column} onChange={(e) => { setColumn(e.target.value); setResult(null); setPlan(null); setRecall(null); }}>
              {vectorColumns.map((c) => <option key={c.name} value={c.name}>{t('pgvector.optionLabel', { name: c.name, type: c.type })}</option>)}
            </select>
          </label>
          <label>
            <span>{t('pgvector.metric')}</span>
            <select className="form-input" value={metric} onChange={(e) => { setMetric(e.target.value as VectorMetric); setResult(null); setPlan(null); setRecall(null); }}>
              {VECTOR_METRICS.map((m) => <option key={m.id} value={m.id}>{t(METRIC_LABEL_KEY[m.id])}</option>)}
            </select>
          </label>
          <label className="vec-form-k">
            <span>{t('pgvector.k')}</span>
            <input
              type="number"
              className="form-input"
              min={1}
              max={1000}
              value={k}
              onChange={(e) => setK(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))}
            />
          </label>
          {tuningKind && (
            <label className="vec-form-k" title={t('pgvector.tuningNote')}>
              <span>{tuningKind === 'efSearch' ? t('pgvector.efSearch') : t('pgvector.probes')}</span>
              <input
                type="text"
                inputMode="numeric"
                className="form-input"
                value={tuningText}
                // pgvector's defaults: 40 candidates for HNSW, 1 list for IVFFlat.
                placeholder={t('pgvector.tuningDefault', { n: tuningKind === 'efSearch' ? 40 : 1 })}
                onChange={(e) => setTuningText(e.target.value)}
              />
            </label>
          )}
        </div>
        {tuning.bad && <div className="gt-editor-msg">{t('pgvector.tuningBad')}</div>}

        <label className="vec-query">
          <span>{t('pgvector.queryVector')}</span>
          <textarea
            className="gt-editor vec-query-input"
            value={text}
            placeholder={t('pgvector.queryPlaceholder')}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void run(); } }}
          />
        </label>
        {problem && <div className="gt-editor-msg">{problem}</div>}
        {zeroCosine && <div className="vec-warn">{t('pgvector.zeroCosine')}</div>}

        <div className={served ? 'vec-index ok' : 'vec-index warn'}>
          {indexes === null
            ? t('pgvector.indexLoading')
            : served
              ? t('pgvector.indexServes', { method: served.method.toUpperCase(), name: served.name })
              : t('pgvector.indexNone')}
          {indexes !== null && !served && otherMetrics.length > 0 && (
            <> {t('pgvector.indexOther', { metrics: otherMetrics.join(', ') })}</>
          )}
        </div>

        <details className="vec-sql">
          <summary>{t('pgvector.sqlSummary')}</summary>
          <pre>{sql}</pre>
          <div className="gt-note">{t('pgvector.sqlNote')}</div>
        </details>

        {error && <div className="gt-editor-msg">{error}</div>}

        {plan !== null && (
          <div className="vec-plan">
            {served && (
              <div className={planHitsIndex ? 'vec-index ok' : 'vec-index warn'}>
                {planHitsIndex ? t('pgvector.planUsesIndex') : t('pgvector.planNoIndex')}
              </div>
            )}
            <pre>{plan}</pre>
          </div>
        )}

        {result && (
          <>
            <div className="gt-toolbar">
              <span className="gt-note">
                {t('pgvector.resultCount', { n: result.data.length.toLocaleString(i18n.language), ms: result.ms.toLocaleString(i18n.language) })}
                {result.tuning && <> · <code className="vec-tuning">{result.tuning}</code></>}
                {' · '}
                {scoreIsSimilarity ? t('pgvector.similarityHint') : t('pgvector.distanceHint')}
              </span>
              <span className="gt-spacer" />
              {result.data.length > 0 && (
                <button className="btn btn-secondary" onClick={compareExact} disabled={busy} title={t('pgvector.compareExactHint')}>
                  {t('pgvector.compareExact')}
                </button>
              )}
            </div>
            {recall && (
              <div className={recall.r.missed.length === 0 ? 'vec-index ok' : 'vec-index warn'}>
                {recall.r.missed.length === 0
                  ? t('pgvector.recallAll', { found: recall.r.found, total: recall.r.total, ms: recall.ms.toLocaleString(i18n.language) })
                  : t('pgvector.recallSome', {
                      found: recall.r.found,
                      total: recall.r.total,
                      pct: Math.round((100 * recall.r.found) / Math.max(1, recall.r.total)),
                      ms: recall.ms.toLocaleString(i18n.language),
                    })}
              </div>
            )}
            {result.data.length === 0 ? (
              <div className="gt-note">{t('pgvector.noRows', { col: column })}</div>
            ) : (
              <div className="gt-transpose vec-results">
                <table>
                  <thead>
                    {/* Keyed by position: a result can repeat a column name (see CLAUDE.md). */}
                    <tr>{result.columns.map((c, i) => <th key={i} className={i === 0 ? 'vec-score' : undefined}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {result.data.map((row, ri) => (
                      <tr key={ri}>
                        {result.columns.map((c, ci) => (
                          <td key={ci} className={ci === 0 ? 'vec-score' : undefined} title={ci === 0 ? undefined : String(row[c] ?? '')}>
                            {ci === 0 && typeof row[c] === 'number'
                              ? row[c].toLocaleString(i18n.language, { maximumFractionDigits: 6 })
                              : cellText(row[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <button className="btn btn-secondary" onClick={() => copyText(sql)}>{t('pgvector.copySql')}</button>
        <span style={{ flex: 1 }} />
        <button className="btn btn-secondary" onClick={explain} disabled={!ready}>{t('pgvector.explain')}</button>
        <button className="btn btn-primary" onClick={run} disabled={!ready} title={t('pgvector.runHint')}>{t('pgvector.run')}</button>
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>{t('common.close')}</button>
      </ModalFooter>
    </Modal>
  );
};

