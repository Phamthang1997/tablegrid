// The masking UI shared by Export database, Copy database and Export table: a compact section
// (switch + how many columns + "Edit rules…") and the rules dialog it opens, with a preview that
// runs the real `mask_rows` over the first rows of a table. The logic is in utils/masking.ts and
// datagen/mask.rs; this file only edits rules.

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EyeOff, KeyRound, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from '../Modal';
import { dbHelper } from '../../utils/dbHelper';
import {
  activeRules,
  countActiveRules,
  FAKE_GENERATORS,
  MASK_KINDS,
  maskedKeyColumns,
  newMaskKey,
  suggestMaskRule,
  type MaskColumnInfo,
  type MaskKind,
  type MaskRule,
  type MaskRules,
} from '../../utils/masking';
import './masking.css';

function kindLabelKey(kind: MaskKind) {
  switch (kind) {
    case 'keep': return 'masking.kindKeep' as const;
    case 'null': return 'masking.kindNull' as const;
    case 'redact': return 'masking.kindRedact' as const;
    case 'partial': return 'masking.kindPartial' as const;
    case 'emailMask': return 'masking.kindEmailMask' as const;
    case 'hashEmail': return 'masking.kindHashEmail' as const;
    case 'hash': return 'masking.kindHash' as const;
    case 'digits': return 'masking.kindDigits' as const;
    case 'card': return 'masking.kindCard' as const;
    case 'fake': return 'masking.kindFake' as const;
    case 'dateShift': return 'masking.kindDateShift' as const;
  }
}

/** The options a rule starts with when it is picked, so the Rust side never sees a half rule. */
function defaultRule(kind: MaskKind): MaskRule {
  switch (kind) {
    case 'partial': return { kind, options: { keepStart: 1, keepEnd: 1 } };
    case 'hash': return { kind, options: { length: 12 } };
    case 'card': return { kind, options: { keepStart: 1 } };
    case 'fake': return { kind, options: { generator: 'fullName' } };
    case 'dateShift': return { kind, options: { days: 30 } };
    default: return { kind };
  }
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ─── Section inside a dialog ─────────────────────────────────────────────────────────────────

export const MaskingSection: React.FC<{
  connId: string;
  /** Base tables being exported — views carry no rows of their own. */
  tables: string[];
  enabled: boolean;
  onEnabledChange: (on: boolean) => void;
  rules: MaskRules;
  onRulesChange: (rules: MaskRules) => void;
  disabled?: boolean;
  zIndex?: number;
}> = ({ connId, tables, enabled, onEnabledChange, rules, onRulesChange, disabled, zIndex }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const n = countActiveRules(rules, tables);
  return (
    <div className={`mask-section${enabled ? ' on' : ''}`}>
      <label className="mask-toggle">
        <input type="checkbox" checked={enabled} disabled={disabled} onChange={(e) => onEnabledChange(e.target.checked)} />
        <ShieldCheck size={13} />
        <span>{t('masking.toggle')}</span>
      </label>
      {enabled && (
        <>
          <div className="mask-hint">{t('masking.toggleHint')}</div>
          <div className={`mask-summary${n === 0 ? ' warn' : ''}`}>
            <span>{n > 0 ? t('masking.summary', { n }) : t('masking.none')}</span>
            <button type="button" className="btn btn-secondary" disabled={disabled} onClick={() => setOpen(true)}>
              <EyeOff size={12} /> {t('masking.edit')}
            </button>
          </div>
        </>
      )}
      {open && (
        <MaskingRulesDialog
          connId={connId}
          tables={tables}
          rules={rules}
          onChange={onRulesChange}
          onClose={() => setOpen(false)}
          zIndex={(zIndex ?? 10000) + 5}
        />
      )}
    </div>
  );
};

// ─── Rules dialog ────────────────────────────────────────────────────────────────────────────

const OptionInputs: React.FC<{ rule: MaskRule; onChange: (r: MaskRule) => void }> = ({ rule, onChange }) => {
  const { t } = useTranslation();
  const o = rule.options ?? {};
  const set = (k: string, v: unknown) => onChange({ ...rule, options: { ...o, [k]: v } });
  const num = (k: string, label: string, min = 0) => (
    <label className="mask-opt" key={k}>
      <span>{label}</span>
      <input type="number" className="form-input" min={min} value={Number(o[k] ?? 0)} onChange={(e) => set(k, Math.max(min, Number(e.target.value) || 0))} />
    </label>
  );
  const text = (k: string, label: string, placeholder?: string) => (
    <label className="mask-opt wide" key={k}>
      <span>{label}</span>
      <input type="text" className="form-input" value={String(o[k] ?? '')} placeholder={placeholder} onChange={(e) => set(k, e.target.value)} />
    </label>
  );
  switch (rule.kind) {
    case 'partial': return <>{num('keepStart', t('masking.optKeepStart'))}{num('keepEnd', t('masking.optKeepEnd'))}</>;
    case 'emailMask':
      return (
        <label className="mask-opt check">
          <input type="checkbox" checked={!!o.keepDomain} onChange={(e) => set('keepDomain', e.target.checked)} />
          <span>{t('masking.optKeepDomain')}</span>
        </label>
      );
    case 'hashEmail': return text('domain', t('masking.optDomain'), 'example.com');
    case 'hash': return <>{text('prefix', t('masking.optPrefix'))}{num('length', t('masking.optLength'), 4)}</>;
    case 'digits': return num('keepEnd', t('masking.optKeepEnd'));
    case 'card': return num('keepStart', t('masking.optKeepStart'));
    case 'dateShift': return num('days', t('masking.optDays'), 1);
    case 'redact': return text('text', t('masking.optText'), '***');
    case 'fake':
      return (
        <label className="mask-opt wide">
          <span>{t('masking.optGenerator')}</span>
          <select className="form-input" value={String(o.generator ?? 'fullName')} onChange={(e) => set('generator', e.target.value)}>
            {FAKE_GENERATORS.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>
      );
    default: return null;
  }
};

export const MaskingRulesDialog: React.FC<{
  connId: string;
  tables: string[];
  rules: MaskRules;
  onChange: (rules: MaskRules) => void;
  onClose: () => void;
  zIndex?: number;
}> = ({ connId, tables, rules, onChange, onClose, zIndex }) => {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<Record<string, MaskColumnInfo[]> | null>(null);
  const [active, setActive] = useState(tables[0] ?? '');
  const [preview, setPreview] = useState<{ table: string; rows: any[]; masked: any[]; error?: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void dbHelper.getFullCatalog(connId).then((full) => {
      if (cancelled) return;
      const out: Record<string, MaskColumnInfo[]> = {};
      for (const table of tables) {
        const fkCols = new Set((full.foreignKeys[table] ?? []).map((fk: any) => String(fk.column)));
        out[table] = (full.columns[table] ?? []).map((c: any) => ({
          name: String(c.name),
          type: c.type,
          isPrimaryKey: !!c.isPrimaryKey,
          isForeignKey: fkCols.has(String(c.name)),
        }));
      }
      setCatalog(out);
    });
    return () => {
      cancelled = true;
    };
  }, [connId, tables]);

  const cols = catalog?.[active] ?? [];
  const keyCols = useMemo(() => (catalog ? maskedKeyColumns(rules, catalog) : []), [catalog, rules]);
  const tableRules = rules[active] ?? {};

  const setRule = (column: string, rule: MaskRule) => {
    const next: MaskRules = { ...rules, [active]: { ...tableRules, [column]: rule } };
    if (rule.kind === 'keep') delete next[active][column];
    onChange(next);
    setPreview(null);
  };

  const suggest = () => {
    if (!catalog) return;
    const next: MaskRules = { ...rules };
    for (const table of tables) {
      const current = { ...(next[table] ?? {}) };
      // Only columns with no rule yet: a suggestion must never overwrite a choice the user made.
      for (const c of catalog[table] ?? []) {
        if (current[c.name]) continue;
        const r = suggestMaskRule(c);
        if (r) current[c.name] = r;
      }
      if (Object.keys(current).length) next[table] = current;
    }
    onChange(next);
    setPreview(null);
  };

  const clearAll = () => {
    const next: MaskRules = { ...rules };
    for (const table of tables) delete next[table];
    onChange(next);
    setPreview(null);
  };

  const runPreview = async () => {
    const cols2 = activeRules(rules, [active])[active];
    if (!cols2) return;
    setPreviewing(true);
    try {
      const data = await dbHelper.getTableData(connId, active, 1, 5);
      const rows = data.rows || [];
      try {
        const masked = await dbHelper.maskRows(newMaskKey(), cols2, rows.map((r) => ({ ...r })));
        setPreview({ table: active, rows, masked });
      } catch (e) {
        setPreview({ table: active, rows, masked: [], error: String(e) });
      }
    } finally {
      setPreviewing(false);
    }
  };

  const maskedCols = Object.keys(activeRules(rules, [active])[active] ?? {});

  return (
    <Modal title={t('masking.dialogTitle')} icon={<KeyRound size={14} />} onClose={onClose} width="920px" zIndex={zIndex}>
      <ModalBody className="mask-dialog">
        {tables.length === 0 ? (
          <div className="mask-hint">{t('masking.noTables')}</div>
        ) : (
          <div className="mask-layout">
            <div className="mask-tables">
              <div className="mask-tables-head">{t('masking.tables')}</div>
              {tables.map((table) => {
                const n = countActiveRules(rules, [table]);
                return (
                  <button
                    key={table}
                    type="button"
                    className={`mask-table${table === active ? ' on' : ''}`}
                    onClick={() => { setActive(table); setPreview(null); }}
                  >
                    <span className="mask-table-name">{table}</span>
                    {n > 0 && <span className="mask-count">{n}</span>}
                  </button>
                );
              })}
            </div>
            <div className="mask-main">
              {!catalog ? (
                <div className="mask-hint"><Loader2 size={12} className="mask-spin" /> {t('masking.loading')}</div>
              ) : (
                <>
                  <table className="mask-cols">
                    <thead>
                      <tr><th>{t('masking.column')}</th><th>{t('masking.type')}</th><th>{t('masking.rule')}</th><th>{t('masking.options')}</th></tr>
                    </thead>
                    <tbody>
                      {cols.map((c) => {
                        const rule = tableRules[c.name] ?? { kind: 'keep' as MaskKind };
                        return (
                          <tr key={c.name} className={rule.kind !== 'keep' ? 'masked' : undefined}>
                            <td className="mono">
                              {c.name}
                              {(c.isPrimaryKey || c.isForeignKey) && <span className="mask-key">{t('masking.keyColumn')}</span>}
                            </td>
                            <td className="mono dim">{c.type}</td>
                            <td>
                              <select
                                className="form-input"
                                value={rule.kind}
                                onChange={(e) => setRule(c.name, defaultRule(e.target.value as MaskKind))}
                              >
                                {MASK_KINDS.map((k) => <option key={k} value={k}>{t(kindLabelKey(k))}</option>)}
                              </select>
                            </td>
                            <td><div className="mask-opts"><OptionInputs rule={rule} onChange={(r) => setRule(c.name, r)} /></div></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  <div className="mask-preview">
                    <div className="mask-preview-head">
                      <span>{t('masking.previewHint')}</span>
                      <button type="button" className="btn btn-secondary" disabled={previewing || !maskedCols.length} onClick={() => void runPreview()}>
                        {previewing ? <Loader2 size={12} className="mask-spin" /> : null} {t('masking.preview')}
                      </button>
                    </div>
                    {!maskedCols.length && <div className="mask-hint">{t('masking.previewEmpty')}</div>}
                    {preview && preview.table === active && (
                      preview.error ? (
                        <div className="mask-error">{t('masking.failed', { msg: preview.error })}</div>
                      ) : (
                        <div className="mask-preview-grid">
                          <table>
                            <thead>
                              <tr>
                                {maskedCols.map((c) => <th key={c}>{c}</th>)}
                              </tr>
                            </thead>
                            <tbody>
                              {preview.rows.map((row, i) => (
                                // Position IS the identity here: row i of the read and row i of the masked page.
                                // eslint-disable-next-line react/no-array-index-key
                                <tr key={i}>
                                  {maskedCols.map((c) => (
                                    <td key={c}>
                                      <div className="mask-before" title={t('masking.before')}>{cellText(row[c])}</div>
                                      <div className="mask-after" title={t('masking.after')}>{cellText(preview.masked[i]?.[c])}</div>
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        {keyCols.length > 0 && <div className="mask-warn">{t('masking.keyWarning', { n: keyCols.join(', ') })}</div>}
        <div className="mask-hint">{t('masking.notMasked')}</div>
      </ModalBody>
      <ModalFooter>
        <button type="button" className="btn btn-secondary" onClick={suggest} disabled={!catalog}>
          <Sparkles size={12} /> {t('masking.suggest')}
        </button>
        <button type="button" className="btn btn-secondary" onClick={clearAll}>{t('masking.clearAll')}</button>
        <span className="mask-spacer" />
        <button type="button" className="btn btn-primary" onClick={onClose}>{t('common.ok')}</button>
      </ModalFooter>
    </Modal>
  );
};
