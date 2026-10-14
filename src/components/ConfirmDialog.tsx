import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from './Modal';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** The main body — describing the action about to happen. */
  message: React.ReactNode;
  /** The small line below, e.g. "This cannot be undone." */
  note?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** A red confirm button (a destructive action). */
  danger?: boolean;
  /** The icon and button tone: 'danger' (the default when danger), 'success' or 'info'. */
  tone?: 'danger' | 'success' | 'info';
  /** When present: the user has to type this string exactly before the confirm button works. */
  requireText?: string;
  /** Blocks confirming while the caller's own input in `message` is not usable yet — the master
   *  password dialog puts a password field there, and an empty one must not confirm. It gates the
   *  Enter shortcut too, not only the button, or Enter would walk straight past it. */
  confirmDisabled?: boolean;
  /** Override the stacking order. The default sits above the 9999/10000 dialogs, but a
   *  caller opened from a modal that raised itself higher (Sidebar, SequenceManagerModal
   *  use 999999) must pass a bigger value or the confirmation renders behind it. */
  zIndex?: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The in-app confirmation box for destructive actions (Drop / Truncate / Flush…), replacing
 * window.confirm() so it matches the rest of the dialogs.
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  note,
  confirmLabel,
  cancelLabel,
  danger = false,
  tone,
  requireText,
  confirmDisabled = false,
  zIndex = 10001,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');

  useEffect(() => {
    queueMicrotask(() => {
      if (open) setTyped('');
    });
  }, [open]);

  const ready = (!requireText || typed.trim() === requireText) && !confirmDisabled;

  // Escape is already handled by Modal; all that is needed here is Enter for a quick confirm, and only
  // when no typed confirmation is required.
  useEffect(() => {
    if (!open || requireText || confirmDisabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onConfirm, requireText, confirmDisabled]);

  if (!open) return null;

  const kind = tone || (danger ? 'danger' : 'info');
  const accent = kind === 'danger'
    ? 'var(--st-danger, #e5484d)'
    : kind === 'success'
      ? 'var(--st-ok, #10b981)'
      : 'var(--win-accent)';
  const Icon = kind === 'danger' ? AlertTriangle : kind === 'success' ? CheckCircle2 : Info;

  return (
    <Modal
      title={title}
      icon={<Icon size={14} style={{ color: accent, flexShrink: 0 }} />}
      onClose={onCancel}
      showClose={false}
      width="420px"
      maxWidth="92vw"
      zIndex={zIndex}
    >
      <ModalBody style={{ gap: '10px' }}>
        <div style={{ fontSize: '11px', color: 'var(--win-text-primary)', lineHeight: 1.6 }}>{message}</div>
        {note && (
          <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>{note}</div>
        )}
        {requireText && (
          <div>
            <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)', display: 'block', marginBottom: '6px' }}>
              <Trans
                i18nKey="confirmDialog.typeToConfirm"
                values={{ text: requireText }}
                components={{ code: <b style={{ color: 'var(--win-text-primary)', fontFamily: 'monospace' }} /> }}
              />
            </label>
            <input
              type="text"
              className="form-input"
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && ready) onConfirm(); }}
              style={{ height: '30px', fontSize: '11px', width: '100%' }}
            />
          </div>
        )}
      </ModalBody>

      <ModalFooter>
        <button className="btn btn-secondary" onClick={onCancel}>{cancelLabel ?? t('common.cancel')}</button>
        <button
          className="btn btn-primary"
          onClick={onConfirm}
          disabled={!ready}
          style={{
            background: ready ? accent : 'var(--win-bg-hover)',
            color: ready ? '#fff' : 'var(--win-text-disabled)',
            border: 'none',
            cursor: ready ? 'pointer' : 'not-allowed'
          }}
        >
          {confirmLabel ?? t('common.confirm')}
        </button>
      </ModalFooter>
    </Modal>
  );
};
