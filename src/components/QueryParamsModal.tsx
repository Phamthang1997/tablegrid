import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import { positionalParamIndex } from '../utils/queryParamHelper';
import type { QueryParamType, TypedParamValue } from '../utils/queryParamHelper';
import { Modal, ModalBody, ModalFooter } from './Modal';

interface QueryParamsModalProps {
  params: string[];
  sqlPreview: string;
  onSubmit: (valuesMap: Record<string, TypedParamValue>) => void;
  onClose: () => void;
}

const PARAM_TYPES: { value: QueryParamType; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'null', label: 'NULL' },
];

export const QueryParamsModal: React.FC<QueryParamsModalProps> = ({
  params,
  sqlPreview,
  onSubmit,
  onClose
}) => {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, TypedParamValue>>({});

  // `p` is the stable map key (`?#1` for positional). Only the label is localized.
  const paramLabel = (name: string) => {
    const n = positionalParamIndex(name);
    return n === null ? name : t('queryParams.positionalParam', { n });
  };

  useEffect(() => {
    queueMicrotask(() => {
      const stored = localStorage.getItem('sql_query_param_values');
      let lastValues: Record<string, TypedParamValue> = {};
      if (stored) {
        try { lastValues = JSON.parse(stored); } catch { lastValues = {}; }
      }
      const initial: Record<string, TypedParamValue> = {};
      params.forEach(p => {
        const prev = lastValues[p];
        // Backward compatibility: upgrade legacy raw string to {value, type:'auto'}
        if (typeof prev === 'string') {
          initial[p] = { value: prev, type: 'auto' };
        } else if (prev && typeof prev === 'object') {
          initial[p] = { value: prev.value ?? '', type: prev.type ?? 'auto' };
        } else {
          initial[p] = { value: '', type: 'auto' };
        }
      });
      setValues(initial);
    });
  }, [params]);

  const handleChangeValue = (paramName: string, value: string) => {
    setValues(prev => ({ ...prev, [paramName]: { value, type: prev[paramName]?.type ?? 'auto' } }));
  };

  const handleChangeType = (paramName: string, type: QueryParamType) => {
    setValues(prev => ({ ...prev, [paramName]: { value: prev[paramName]?.value ?? '', type } }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Save last used parameter values to localStorage
    const stored = localStorage.getItem('sql_query_param_values');
    let lastValues: Record<string, TypedParamValue> = {};
    if (stored) {
      try { lastValues = JSON.parse(stored); } catch { lastValues = {}; }
    }
    const updated = { ...lastValues, ...values };
    localStorage.setItem('sql_query_param_values', JSON.stringify(updated));

    onSubmit(values);
  };

  return (
    <Modal
      title={t('queryParams.title')}
      icon={<Play size={14} style={{ color: 'var(--win-accent)', fill: 'var(--win-accent)', flexShrink: 0 }} />}
      onClose={onClose}
      width="460px"
      maxWidth="90vw"
      maxHeight="85vh"
      zIndex={10000}
    >
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
      >
        <ModalBody>
        {/* SQL Preview Snippet */}
        <div style={{
          background: 'var(--win-bg-window)',
          padding: '8px 12px',
          borderRadius: '4px',
          border: '1px solid var(--win-border)',
          fontSize: '11px',
          fontFamily: 'var(--win-font-mono)',
          color: 'var(--win-text-secondary)',
          maxHeight: '70px',
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all'
        }}>
          {sqlPreview}
        </div>

        {/* Parameter Input Fields */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px'
        }}>
          {params.map((p, idx) => (
            <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--win-text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <code style={{ background: 'var(--win-bg-hover)', padding: '1px 5px', borderRadius: '3px', fontFamily: 'var(--win-font-mono)', color: 'var(--win-accent)' }}>
                  {paramLabel(p)}
                </code>
              </label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="text"
                  autoFocus={idx === 0}
                  value={values[p]?.value ?? ''}
                  onChange={(e) => handleChangeValue(p, e.target.value)}
                  disabled={values[p]?.type === 'null'}
                  placeholder={values[p]?.type === 'null' ? 'NULL' : t('queryParams.valuePlaceholder', { name: paramLabel(p) })}
                  style={{
                    flex: 1,
                    background: 'var(--win-bg-window)',
                    border: '1px solid var(--win-border)',
                    color: 'var(--win-text-primary)',
                    borderRadius: '4px',
                    padding: '6px 10px',
                    fontSize: '12px',
                    fontFamily: 'var(--win-font-mono)',
                    outline: 'none',
                    opacity: values[p]?.type === 'null' ? 0.5 : 1
                  }}
                />
                <select
                  value={values[p]?.type ?? 'auto'}
                  onChange={(e) => handleChangeType(p, e.target.value as QueryParamType)}
                  title={t('queryParams.typeTitle')}
                  style={{
                    background: 'var(--win-bg-window)',
                    border: '1px solid var(--win-border)',
                    color: 'var(--win-text-primary)',
                    borderRadius: '4px',
                    padding: '6px 8px',
                    fontSize: '11.5px',
                    outline: 'none',
                    cursor: 'pointer'
                  }}
                >
                  {PARAM_TYPES.map(pt => (
                    <option key={pt.value} value={pt.value}>{pt.label}</option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
        </ModalBody>

        {/* Action Buttons */}
        <ModalFooter>
          <button type="button" className="btn btn-secondary" onClick={onClose} style={{ padding: '6px 16px' }}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" style={{ padding: '6px 16px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            {/* currentColor so the icon follows `.btn:disabled`'s text colour — see SqlEditor's Run button. */}
            <Play size={12} fill="currentColor" />
            <span>{t('queryParams.run')}</span>
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
};
