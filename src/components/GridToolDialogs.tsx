import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ModalBody, ModalFooter } from './Modal';
import {
  buildTransposedTsv,
  cellText,
  computeColumnStats,
  textMetrics,
  transposeRows,
  tryFormatJson,
} from '../utils/gridTools';

/**
 * The three tools the grids' context menus open: column statistics, the transposed row view and
 * the value editor. Shared by `DataGrid` and `SqlEditor`'s result grid; each takes rows and
 * callbacks, never a grid, so neither grid's row model leaks into the other (see CLAUDE.md on why
 * the two grids are not merged).
 */

const copyText = (text: string) => {
  navigator.clipboard.writeText(text).catch(() => {});
};

function formatBytes(n: number, locale: string): string {
  if (n < 1024) return `${n.toLocaleString(locale)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} KB`;
  return `${(n / 1024 / 1024).toLocaleString(locale, { maximumFractionDigits: 2 })} MB`;
}

// ─── Column statistics ───────────────────────────────────────────────────────────────────

export const ColumnStatsDialog: React.FC<{
  column: string;
  values: unknown[];
  /** Already translated: what the values are ("12 selected rows", "rows on this page"). */
  scope: string;
  /** Extra caveat, e.g. that a server-paged grid only counted one page. */
  note?: string;
  onClose: () => void;
}> = ({ column, values, scope, note, onClose }) => {
  const { t, i18n } = useTranslation();
  const stats = useMemo(() => computeColumnStats(values), [values]);
  const [copied, setCopied] = useState<string | null>(null);
  const lang = i18n.language;

  const num = (n: number) => n.toLocaleString(lang, { maximumFractionDigits: 6 });
  // What goes to the clipboard is the plain number, not the localized one — "1.234,5" pasted into
  // a SQL statement is a syntax error.
  const raw = (n: number) => String(Number(n.toPrecision(15)));

  const rows: { label: string; shown: string; copy: string }[] = [
    { label: t('gridTools.statsCount'), shown: num(stats.count), copy: String(stats.count) },
    { label: t('gridTools.statsNulls'), shown: num(stats.nulls), copy: String(stats.nulls) },
    { label: t('gridTools.statsEmpty'), shown: num(stats.empty), copy: String(stats.empty) },
    { label: t('gridTools.statsDistinct'), shown: num(stats.distinct), copy: String(stats.distinct) },
  ];
  const valueRows: { label: string; shown: string; copy: string }[] = [];
  if (stats.numeric) {
    const n = stats.numeric;
    valueRows.push(
      { label: t('gridTools.statsSum'), shown: num(n.sum), copy: raw(n.sum) },
      { label: t('gridTools.statsAvg'), shown: num(n.avg), copy: raw(n.avg) },
      { label: t('gridTools.statsMin'), shown: num(n.min), copy: raw(n.min) },
      { label: t('gridTools.statsMax'), shown: num(n.max), copy: raw(n.max) },
    );
  } else if (stats.minText !== null && stats.maxText !== null) {
    const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…` : s);
    valueRows.push(
      { label: t('gridTools.statsMin'), shown: clip(stats.minText), copy: stats.minText },
      { label: t('gridTools.statsMax'), shown: clip(stats.maxText), copy: stats.maxText },
    );
  }
  if (stats.minLength !== null && stats.maxLength !== null) {
    valueRows.push(
      { label: t('gridTools.statsMinLen'), shown: t('gridTools.statsChars', { n: num(stats.minLength) }), copy: String(stats.minLength) },
      { label: t('gridTools.statsMaxLen'), shown: t('gridTools.statsChars', { n: num(stats.maxLength) }), copy: String(stats.maxLength) },
    );
  }

  const cell = (r: { label: string; shown: string; copy: string }) => (
    <React.Fragment key={r.label}>
      <dt>{r.label}</dt>
      <dd
        title={t('gridTools.statsClickToCopy')}
        onClick={() => {
          copyText(r.copy);
          setCopied(r.label);
        }}
      >
        {r.shown}
        {copied === r.label && <span className="gt-note">{t('gridTools.copiedSuffix')}</span>}
      </dd>
    </React.Fragment>
  );

  return (
    <Modal
      title={<>{t('gridTools.statsTitle')} — <span style={{ color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{column}</span></>}
      onClose={onClose}
      width="420px"
      maxWidth="92%"
      zIndex={99998}
    >
      <ModalBody>
        <div className="gt-note">{t('gridTools.statsScope', { scope })}</div>
        <dl className="gt-stats" style={{ margin: 0 }}>
          {rows.map(cell)}
          {valueRows.length > 0 && <div className="gt-stats-sep" />}
          {valueRows.map(cell)}
        </dl>
        {stats.numeric?.approximate && <div className="gt-note">{t('gridTools.statsApprox')}</div>}
        {!stats.numeric && stats.count > stats.nulls + stats.empty && (
          <div className="gt-note">{t('gridTools.statsNotNumeric')}</div>
        )}
        {note && <div className="gt-note">{note}</div>}
      </ModalBody>
      <ModalFooter>
        <button className="btn btn-primary" onClick={onClose}>{t('common.close')}</button>
      </ModalFooter>
    </Modal>
  );
};

// ─── Transposed rows ─────────────────────────────────────────────────────────────────────

/** More columns than this is a table nobody reads sideways; the rest are counted, not dropped silently. */
const TRANSPOSE_MAX_ROWS = 50;

export const TransposeDialog: React.FC<{
  columns: string[];
  rows: Record<string, unknown>[];
  onClose: () => void;
}> = ({ columns, rows, onClose }) => {
  const { t } = useTranslation();
  const shown = useMemo(
    () => (rows.length > TRANSPOSE_MAX_ROWS ? rows.slice(0, TRANSPOSE_MAX_ROWS) : rows),
    [rows],
  );
  const fields = useMemo(() => transposeRows(columns, shown), [columns, shown]);
  const [diffOnly, setDiffOnly] = useState(false);
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const visible = fields.filter((f) => (!diffOnly || f.differs) && (!q || f.column.toLowerCase().includes(q)));
  const headers = [t('gridTools.transposeColumn'), ...shown.map((_, i) => t('gridTools.transposeRow', { n: i + 1 }))];

  return (
    <Modal
      title={t('gridTools.transposeTitle', { n: shown.length })}
      onClose={onClose}
      width="880px"
      maxWidth="94%"
      height="75vh"
      zIndex={99998}
    >
      <ModalBody style={{ gap: 10 }}>
        <div className="gt-toolbar">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('gridTools.transposeFilter')}
            style={{ width: 200 }}
            autoFocus
          />
          {shown.length > 1 && (
            <label>
              <input type="checkbox" checked={diffOnly} onChange={(e) => setDiffOnly(e.target.checked)} />
              {t('gridTools.transposeDiffOnly')}
            </label>
          )}
          <span className="gt-spacer" />
          {rows.length > shown.length && (
            <span className="gt-note">{t('gridTools.transposeCapped', { shown: shown.length, n: rows.length })}</span>
          )}
        </div>
        <div className="gt-transpose">
          <table>
            <thead>
              <tr>
                {/* Keyed by position: headers are labels, and two rows may share nothing unique. */}
                {headers.map((h, i) => <th key={i}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {visible.map((f, fi) => (
                // By position as well: a result can repeat a column name (see uniquify_columns).
                <tr key={fi} className={f.differs ? 'is-diff' : undefined}>
                  <th>{f.column}</th>
                  {f.values.map((v, vi) => {
                    const text = cellText(v);
                    return (
                      <td key={vi}>
                        {text === null ? <span className="gt-null">{t('gridTools.null')}</span> : text.length > 2000 ? `${text.slice(0, 2000)}…` : text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ModalBody>
      <ModalFooter>
        <button className="btn btn-secondary" onClick={() => copyText(buildTransposedTsv(headers, visible))}>
          {t('gridTools.copyTsv')}
        </button>
        <button className="btn btn-primary" onClick={onClose}>{t('common.close')}</button>
      </ModalFooter>
    </Modal>
  );
};

// ─── Value editor ────────────────────────────────────────────────────────────────────────

/**
 * A real editor for one long value — the LOB/JSON case the single-line cell input cannot handle
 * and Quick Look (read-only, no formatting) only displayed. `onApply` absent means read-only:
 * the grid decides editability, this dialog never guesses it.
 *
 * Applying writes into the grid's pending-edit buffer, exactly like an inline edit: nothing
 * reaches the database until the grid's own Save, with its SQL preview.
 */
export const ValueEditorDialog: React.FC<{
  column: string;
  value: unknown;
  onApply?: (text: string) => void;
  /** Already translated: why `onApply` is absent, when it is. */
  readOnlyReason?: string;
  onClose: () => void;
}> = ({ column, value, onApply, readOnlyReason, onClose }) => {
  const { t, i18n } = useTranslation();
  const initial = useMemo(() => {
    const text = cellText(value);
    if (text === null) return '';
    // A JSON cell opens formatted: the one-line form is why this dialog was opened. Formatting
    // alone does not count as an edit (see `dirty`), so looking at a value never marks it changed.
    return tryFormatJson(text) ?? text;
  }, [value]);
  const isNull = cellText(value) === null;
  const [text, setText] = useState(initial);
  const [wrap, setWrap] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const metrics = textMetrics(text);
  const isJson = tryFormatJson(text) !== null;

  // Compared against the ORIGINAL text, not the formatted one: re-indenting a JSON value and
  // applying it would otherwise write a byte-different value the user never meant to change.
  const originalText = cellText(value) ?? '';
  const minifiedEqual = (a: string, b: string) => {
    const fa = tryFormatJson(a, 0);
    const fb = tryFormatJson(b, 0);
    return fa !== null && fa === fb;
  };
  const dirty = text !== initial && text !== originalText && !minifiedEqual(text, originalText);

  const apply = () => {
    if (!onApply || !dirty) return;
    onApply(text);
    onClose();
  };

  return (
    <Modal
      title={<>{t('gridTools.editorTitle')} — <span style={{ color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{column}</span></>}
      onClose={onClose}
      width="820px"
      maxWidth="94%"
      height="72vh"
      zIndex={99998}
    >
      <ModalBody style={{ gap: 8 }}>
        <div className="gt-toolbar">
          <button
            className="btn btn-secondary"
            disabled={!isJson}
            onClick={() => {
              const f = tryFormatJson(text);
              if (f === null) setError(t('gridTools.editorNotJson'));
              else { setText(f); setError(null); }
            }}
          >
            {t('gridTools.formatJson')}
          </button>
          <button
            className="btn btn-secondary"
            disabled={!isJson}
            onClick={() => {
              const f = tryFormatJson(text, 0);
              if (f !== null) { setText(f); setError(null); }
            }}
          >
            {t('gridTools.minifyJson')}
          </button>
          <label>
            <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
            {t('gridTools.wrap')}
          </label>
          <span className="gt-spacer" />
          <span className="gt-note">
            {t('gridTools.metrics', {
              chars: metrics.chars.toLocaleString(i18n.language),
              lines: metrics.lines.toLocaleString(i18n.language),
              bytes: formatBytes(metrics.bytes, i18n.language),
            })}
          </span>
        </div>
        <textarea
          className={`gt-editor${wrap ? '' : ' no-wrap'}`}
          value={text}
          readOnly={!onApply}
          spellCheck={false}
          placeholder={isNull ? t('gridTools.null') : undefined}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              apply();
            }
          }}
          autoFocus
        />
        {error && <div className="gt-editor-msg">{error}</div>}
        {isNull && <div className="gt-note">{t('gridTools.editorIsNull')}</div>}
        {!onApply && readOnlyReason && <div className="gt-note">{readOnlyReason}</div>}
        {onApply && <div className="gt-note">{t('gridTools.editorApplyNote')}</div>}
      </ModalBody>
      <ModalFooter>
        <button className="btn btn-secondary" onClick={() => copyText(text)}>{t('common.copy')}</button>
        <button className="btn btn-secondary" onClick={onClose}>{onApply ? t('common.cancel') : t('common.close')}</button>
        {onApply && (
          <button className="btn btn-primary" onClick={apply} disabled={!dirty} title={t('gridTools.applyHint')}>
            {t('gridTools.apply')}
          </button>
        )}
      </ModalFooter>
    </Modal>
  );
};
