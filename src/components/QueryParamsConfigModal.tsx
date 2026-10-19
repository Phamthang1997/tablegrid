import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, Check } from 'lucide-react';
import { QUERY_PARAM_PATTERNS, type QueryParamsConfig } from '../utils/queryParamHelper';
import { Modal, ModalBody, ModalFooter } from './Modal';

interface QueryParamsConfigModalProps {
  initialConfig: QueryParamsConfig;
  onSave: (newConfig: QueryParamsConfig) => void;
  onClose: () => void;
}

export const QueryParamsConfigModal: React.FC<QueryParamsConfigModalProps> = ({
  initialConfig,
  onSave,
  onClose
}) => {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(initialConfig.enabled);
  const [patternIndex, setPatternIndex] = useState(initialConfig.patternIndex);

  const handleSave = () => {
    onSave({ enabled, patternIndex });
    onClose();
  };

  return (
    <Modal
      title={t('queryParams.configTitle')}
      icon={<Settings size={14} style={{ color: 'var(--win-accent)', flexShrink: 0 }} />}
      onClose={onClose}
      width="440px"
      zIndex={10000}
    >
      <ModalBody>
        {/* Enable Checkbox */}
        <div style={{
          background: 'var(--win-bg-code)',
          padding: '12px',
          borderRadius: '6px',
          border: '1px solid var(--win-border)'
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', fontSize: '12px', color: 'var(--win-text-primary)', fontWeight: 600 }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              style={{ width: '15px', height: '15px', accentColor: 'var(--win-accent)' }}
            />
            <span>{t('queryParams.enable')}</span>
          </label>
          <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)', marginTop: '4px', marginLeft: '25px' }}>
            {t('queryParams.enableHint')}
          </div>
        </div>

        {/* Patterns list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
            {t('queryParams.regexLabel')}
          </div>
          {QUERY_PARAM_PATTERNS.map((p) => (
            <label
              key={p.id}
              onClick={() => setPatternIndex(p.id)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px',
                padding: '10px 12px',
                borderRadius: '6px',
                border: patternIndex === p.id ? '1px solid var(--win-accent)' : '1px solid var(--win-border)',
                background: patternIndex === p.id ? 'rgba(0, 102, 204, 0.08)' : 'var(--win-bg-window)',
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              <input
                type="radio"
                name="paramPattern"
                checked={patternIndex === p.id}
                onChange={() => setPatternIndex(p.id)}
                style={{ marginTop: '2px', accentColor: 'var(--win-accent)' }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                  <code style={{ background: 'var(--win-bg-hover)', padding: '2px 6px', borderRadius: '3px', fontFamily: 'var(--win-font-mono)' }}>
                    {p.label}
                  </code>
                </div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'var(--win-font-mono)' }}>
                  {t('queryParams.example', { example: p.example })}
                </div>
              </div>
            </label>
          ))}
        </div>
      </ModalBody>

      <ModalFooter>
        <button className="btn btn-secondary" onClick={onClose} style={{ padding: '6px 16px' }}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-primary" onClick={handleSave} style={{ padding: '6px 16px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Check size={14} />
          <span>{t('queryParams.saveSettings')}</span>
        </button>
      </ModalFooter>
    </Modal>
  );
};
