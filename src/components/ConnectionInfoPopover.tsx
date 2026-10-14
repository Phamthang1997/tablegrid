import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { ConnectionStatus } from '../utils/dbHelper';
import { CONN_ENVS, envLabelKey, normalizeEnv, type ConnEnv } from '../utils/connEnv';

/**
 * The connection details panel, opened by clicking the status cluster in the middle of the title bar.
 *
 * Not built from Modal.tsx: this is a popover anchored to the status cluster rather than a dialog in
 * the middle of the screen, and it does not block what is behind it. It still renders through a
 * portal, because the title bar lives in a branch with backdrop-filter — a position: fixed element
 * inside that can only cover the title bar itself (see the note in Modal.tsx).
 */

interface ConnectionInfoPopoverProps {
  /** The position, precomputed from the status cluster's getBoundingClientRect. */
  anchor: { top: number; left: number };
  status: ConnectionStatus | null;
  /** The connected profile's name and colour (empty when the connection came from no profile). */
  profileName: string;
  profileColor: string;
  /** The connected profile's environment. A field of its own, never inferred from the colour. */
  profileEnv: ConnEnv;
  /** Changing name/colour/environment writes straight into the profile in localStorage (App.tsx does it). */
  onProfileChange: (patch: { name?: string; color?: string; env?: ConnEnv }) => void;
  onDisconnect: () => void;
  onReconnect: () => Promise<{ success: boolean; message?: string }>;
  onEdit: () => void;
  onClose: () => void;
}

// The connection label palette. An empty string means no colour; it sits second to match the design's
// order (green first, then the white "no colour" swatch).
const TAG_COLORS = [
  { value: '#86efac', labelKey: 'connInfo.colorGreen' },
  { value: '', labelKey: 'connInfo.colorNone' },
  { value: '#a5b4fc', labelKey: 'connInfo.colorBlue' },
  { value: '#fde68a', labelKey: 'connInfo.colorYellow' },
  { value: '#fca5a5', labelKey: 'connInfo.colorRed' },
] as const;

const DRIVER_LABELS: Record<string, string> = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  sqlite: 'SQLite',
  redis: 'Redis',
};

const rowLabelStyle: React.CSSProperties = {
  fontSize: '11.5px',
  color: 'var(--win-text-secondary)',
  textAlign: 'right',
  whiteSpace: 'nowrap',
};

const rowValueStyle: React.CSSProperties = {
  fontSize: '11.5px',
  color: 'var(--win-text-primary)',
  fontFamily: 'var(--win-font-mono)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const cardStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '6px 12px',
  padding: '10px 12px',
  borderRadius: '8px',
  background: 'var(--win-bg-tab-bar)',
  border: '1px solid var(--win-border)',
};

const InfoRow: React.FC<{ label: string; value: string; title?: string }> = ({
  label,
  value,
  title,
}) => (
  <>
    <span style={rowLabelStyle}>{`${label}:`}</span>
    <span style={rowValueStyle} title={title || value}>{value}</span>
  </>
);

export const ConnectionInfoPopover: React.FC<ConnectionInfoPopoverProps> = ({
  anchor,
  status,
  profileName,
  profileColor,
  profileEnv,
  onProfileChange,
  onDisconnect,
  onReconnect,
  onEdit,
  onClose,
}) => {
  const { t } = useTranslation();
  const [name, setName] = useState(profileName);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const commitName = () => {
    const next = name.trim();
    if (next && next !== profileName) onProfileChange({ name: next });
  };

  const handleReconnect = async () => {
    setReconnecting(true);
    setReconnectError(null);
    const res = await onReconnect();
    setReconnecting(false);
    if (res.success) onClose();
    else setReconnectError(res.message || '');
  };

  const unknown = t('connInfo.unknown');
  const driverLabel = status?.dbType
    ? `${DRIVER_LABELS[status.dbType] || status.dbType} ${status.serverVersion}`.trim()
    : unknown;
  const hostLabel = status?.host
    ? status.port
      ? `${status.host}:${status.port}`
      : status.host
    : unknown;

  return createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 99998 }} onClick={onClose} />
      <div
        className="conn-info-popover"
        style={{
          position: 'fixed',
          top: `${anchor.top}px`,
          left: `${anchor.left}px`,
          width: '320px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          // --win-bg-popover, NOT --win-bg-modal: that variable was never declared in index.css, so it
          // always fell back to #ffffff, making this card white in the dark theme and every
          // --win-text-secondary label inside it nearly invisible.
          background: 'var(--win-bg-popover)',
          border: '1px solid var(--win-border-strong)',
          borderRadius: '12px',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.35)',
          padding: '14px',
          zIndex: 99999,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* The connection's name and label colour */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input
            type="text"
            className="form-input"
            value={name}
            placeholder={t('connInfo.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            style={{ flex: 1, minWidth: 0, height: '28px', fontSize: '12px', padding: '0 8px', borderRadius: '6px' }}
          />
          <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
            {TAG_COLORS.map((c) => (
              <button
                key={c.labelKey}
                type="button"
                onClick={() => onProfileChange({ color: c.value })}
                title={t(c.labelKey)}
                aria-label={t(c.labelKey)}
                aria-pressed={profileColor === c.value}
                style={{
                  width: '20px',
                  height: '20px',
                  padding: 0,
                  borderRadius: '5px',
                  cursor: 'pointer',
                  // The "no colour" swatch takes the popover’s own background, so it reads as empty rather than white.
                  background: c.value || 'var(--win-bg-popover)',
                  border:
                    profileColor === c.value
                      ? '2px solid var(--win-accent)'
                      : '1px solid var(--win-border-strong)',
                }}
              />
            ))}
          </div>
        </div>

        {/* The environment. Directly below the name and colour, because together they are "what this
            connection is" — but in a field of its own: the colour above is purely decorative, while
            this one turns read-only on and demands a two-step confirmation. */}
        <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)', flexShrink: 0 }}>
            {t('connEnv.label')}
          </span>
          <select
            className="form-input"
            value={profileEnv}
            onChange={(e) => onProfileChange({ env: normalizeEnv(e.target.value) })}
            style={{ flex: 1, minWidth: 0, height: '28px', fontSize: '12px', padding: '0 6px', borderRadius: '6px' }}
          >
            {CONN_ENVS.map((env) => (
              <option key={env} value={env}>{t(envLabelKey(env))}</option>
            ))}
          </select>
        </div>

        {/* The server */}
        <div style={cardStyle}>
          <InfoRow label={t('connInfo.server')} value={hostLabel} />
          <InfoRow label={t('connInfo.host')} value={status?.host || unknown} />
        </div>

        {/* The current session */}
        <div style={cardStyle}>
          <InfoRow label={t('connInfo.driver')} value={driverLabel} />
          <InfoRow label={t('connInfo.db')} value={status?.database || unknown} />
          <InfoRow label={t('connInfo.user')} value={status?.user || '—'} />
          <InfoRow
            label={t('connInfo.cipher')}
            value={status?.cipher || t('connInfo.notEncrypted')}
            title={status?.tlsVersion ? `${status.tlsVersion} · ${status.cipher}` : undefined}
          />
          <InfoRow label={t('connInfo.latency')} value={`${status?.latencyMs ?? 0} ms`} />
        </div>

        {reconnectError !== null && (
          <div style={{ fontSize: '11px', color: 'var(--st-danger, #ef4444)' }}>
            {t('connInfo.reconnectFailed', { message: reconnectError })}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <button className="btn btn-secondary" onClick={onDisconnect} disabled={reconnecting}>
            {t('connInfo.disconnect')}
          </button>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-secondary" onClick={handleReconnect} disabled={reconnecting}>
              {reconnecting ? t('connInfo.reconnecting') : t('connInfo.reconnect')}
            </button>
            <button
              className="btn btn-primary"
              onClick={onEdit}
              disabled={reconnecting}
              title={t('connInfo.editTitle')}
            >
              {t('connInfo.edit')}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
};
