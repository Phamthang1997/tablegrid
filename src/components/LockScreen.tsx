import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { KeyRound, Lock, Minus, Square, X } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { resetVault, unlockVault } from '../utils/vault';

/**
 * The master-password gate.
 *
 * **An overlay, not an early return.** `App` keeps every query tab mounted so a run's results
 * survive a tab switch, and an idle lock that unmounted the tree would throw all of that away —
 * editor content, results, scroll positions — to protect credentials that are already sealed in the
 * backend. So this covers the window and the app carries on underneath: what a lock stops is
 * reading secrets, not the session the user already has.
 *
 * It carries its own drag strip and window buttons because it covers the real title bar, and an app
 * you cannot move, minimise or close is not a locked app, it is a stuck one.
 */
export const LockScreen: React.FC = () => {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askReset, setAskReset] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      await unlockVault(password, remember);
      // Only on success: a wrong password should leave the field alone so the user can fix a typo
      // rather than retype the whole thing.
      setPassword('');
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  const doReset = async () => {
    setAskReset(false);
    setBusy(true);
    try {
      await resetVault();
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vault-lock">
      <div className="vault-lock-bar">
        <div className="vault-lock-bar-title">
          <Lock size={12} />
          <span>{t('vault.appLocked')}</span>
        </div>
        <div className="vault-lock-bar-btns">
          <button
            className="title-bar-btn"
            onClick={() => void getCurrentWindow().minimize()}
            title={t('titlebar.minimize')}
            aria-label={t('titlebar.minimize')}
          >
            <Minus size={13} />
          </button>
          <button
            className="title-bar-btn"
            onClick={() => void getCurrentWindow().toggleMaximize()}
            title={t('titlebar.maximize')}
            aria-label={t('titlebar.maximize')}
          >
            <Square size={11} />
          </button>
          <button
            className="title-bar-btn close"
            onClick={() => void getCurrentWindow().close()}
            title={t('titlebar.closeWindow')}
            aria-label={t('titlebar.closeWindow')}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      <div className="vault-lock-card">
        <div className="vault-lock-icon">
          <KeyRound size={22} />
        </div>
        <h2 className="vault-lock-title">{t('vault.unlockTitle')}</h2>
        <p className="vault-lock-sub">{t('vault.unlockSubtitle')}</p>

        <input
          ref={inputRef}
          type="password"
          value={password}
          disabled={busy}
          placeholder={t('vault.masterPassword')}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />

        <label className="vault-lock-remember">
          <input
            type="checkbox"
            checked={remember}
            disabled={busy}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>{t('vault.rememberDevice')}</span>
        </label>
        <p className="vault-lock-hint">{t('vault.rememberDeviceHint')}</p>

        {error && <div className="vault-lock-error">{error}</div>}

        <button
          className="btn btn-primary vault-lock-submit"
          onClick={() => void submit()}
          disabled={busy || !password}
        >
          {busy ? t('vault.unlocking') : t('vault.unlock')}
        </button>

        <button className="vault-lock-forgot" onClick={() => setAskReset(true)} disabled={busy}>
          {t('vault.forgot')}
        </button>
      </div>

      <ConfirmDialog
        open={askReset}
        title={t('vault.resetTitle')}
        message={t('vault.resetMessage')}
        note={t('vault.resetNote')}
        confirmLabel={t('vault.resetConfirm')}
        danger
        // A typed confirmation rather than a plain OK: this is the one action in the app that
        // destroys data no backup can return, and the profiles it leaves behind make the loss easy
        // to underestimate — the connections are all still listed, they simply no longer work.
        requireText={t('vault.resetTypeWord')}
        zIndex={2000010}
        onConfirm={() => void doReset()}
        onCancel={() => setAskReset(false)}
      />
    </div>
  );
};
