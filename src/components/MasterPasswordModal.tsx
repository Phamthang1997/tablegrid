import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { SECRET_FIELDS } from '../utils/secretFields';
import { loadSavedProfiles } from '../utils/connectProfile';
import {
  changeVaultPassword,
  disableVault,
  enableVault,
  getAutoLockMinutes,
  isVaultLocked,
  lockVault,
  setAutoLockMinutes,
  setVaultRemember,
  subscribeVault,
  vaultSnapshot,
} from '../utils/vault';

/**
 * Turning the master password on and off, changing it, and the two settings around it.
 *
 * One dialog for all four because they are one decision seen from different sides — and because the
 * honest statement of what this protects has to sit next to every one of them, not only next to the
 * switch that turns it on.
 */
export const MasterPasswordModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();
  const status = useSyncExternalStore(subscribeVault, vaultSnapshot);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [remember, setRemember] = useState(status.remembered);
  const [autoLock, setAutoLock] = useState(getAutoLockMinutes());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [askDisable, setAskDisable] = useState(false);

  // Locking closes this dialog, and this is the one place where the overlay's "keep everything
  // mounted" rule is exactly wrong. That rule exists so a lock cannot throw away the user's WORK —
  // editor content, query results, scroll positions. What it must not preserve is the three
  // password fields above: leaving them mounted means a lock, including an idle one that fires
  // while the dialog sits open, puts a half-typed master password back on screen the moment it is
  // lifted. Unmounting drops that state with the component.
  //
  // An effect rather than a click handler on "Lock now", because the idle timer is the case that
  // matters: nobody is there to close the dialog first.
  useEffect(() => {
    if (isVaultLocked(status)) onClose();
  }, [status, onClose]);

  // `() => unknown` rather than a promise-typed callback: every caller hands over an async vault
  // call, and `await` on its result is what runs it — the looser type costs nothing and keeps the
  // signature out of the way.
  const run = async (fn: () => unknown, message: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      setPassword('');
      setConfirm('');
      setOldPassword('');
      setDone(message);
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  const mismatch = password !== '' && confirm !== '' && password !== confirm;

  const handleEnable = () => {
    if (mismatch || !password) return;
    // The profile ids come from localStorage because that is the only place that knows which
    // profiles exist — `vault.rs` has never seen an id it was not handed.
    const ids = loadSavedProfiles().map((p) => p.id);
    void run(
      () => enableVault(password, remember, ids, [...SECRET_FIELDS]),
      t('vault.enabledOk'),
    );
  };

  const handleChange = () => {
    if (mismatch || !password || !oldPassword) return;
    void run(() => changeVaultPassword(oldPassword, password), t('vault.changedOk'));
  };

  const handleDisable = () => {
    setAskDisable(false);
    if (!oldPassword) return;
    void run(() => disableVault(oldPassword), t('vault.disabledOk'));
  };

  const handleRemember = (next: boolean) => {
    setRemember(next);
    void run(() => setVaultRemember(next), next ? t('vault.rememberOnOk') : t('vault.rememberOffOk'));
  };

  const handleAutoLock = (minutes: number) => {
    setAutoLock(minutes);
    setAutoLockMinutes(minutes);
  };

  return (
    <Modal
      title={t('vault.title')}
      icon={<KeyRound size={14} />}
      onClose={onClose}
      closeDisabled={busy}
      width="min(560px, 94vw)"
      zIndex={10000}
    >
      <ModalBody>
        <div className="vault-note">
          <ShieldCheck size={14} />
          <div>
            <p>{t('vault.explain')}</p>
            {/* Stated up front rather than buried: a security feature that is believed to do more
                than it does is worse than none, because it changes what the user risks. */}
            <p className="vault-note-limit">{t('vault.limits')}</p>
          </div>
        </div>

        {!status.enabled ? (
          <>
            <label className="vault-field">
              <span>{t('vault.newPassword')}</span>
              <input
                type="password"
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="vault-field">
              <span>{t('vault.confirmPassword')}</span>
              <input
                type="password"
                value={confirm}
                disabled={busy}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            {mismatch && <div className="vault-error">{t('vault.mismatch')}</div>}
            <label className="vault-check">
              <input
                type="checkbox"
                checked={remember}
                disabled={busy}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>{t('vault.rememberDevice')}</span>
            </label>
            <p className="vault-hint">{t('vault.rememberDeviceHint')}</p>
            <div className="vault-warn">{t('vault.noRecovery')}</div>
          </>
        ) : (
          <>
            <div className="vault-on">{t('vault.currentlyOn')}</div>

            <label className="vault-check">
              <input
                type="checkbox"
                checked={status.remembered}
                disabled={busy}
                onChange={(e) => handleRemember(e.target.checked)}
              />
              <span>{t('vault.rememberDevice')}</span>
            </label>
            <p className="vault-hint">{t('vault.rememberDeviceHint')}</p>

            <label className="vault-field">
              <span>{t('vault.autoLock')}</span>
              <select
                value={autoLock}
                disabled={busy}
                onChange={(e) => handleAutoLock(Number(e.target.value))}
              >
                <option value={0}>{t('vault.autoLockNever')}</option>
                <option value={5}>{t('vault.autoLockMinutes', { n: 5 })}</option>
                <option value={15}>{t('vault.autoLockMinutes', { n: 15 })}</option>
                <option value={30}>{t('vault.autoLockMinutes', { n: 30 })}</option>
                <option value={60}>{t('vault.autoLockMinutes', { n: 60 })}</option>
              </select>
            </label>
            {/* This used to be disabled whenever the key was remembered, because restarting the app
                walked straight past an idle lock. `vault.rs`'s `relock` flag closed that hole, so
                the two settings now compose: remember skips the prompt at STARTUP, a lock still
                demands the password — including after a restart. */}
            <p className="vault-hint">{t('vault.autoLockHint')}</p>

            <div className="vault-sep" />

            <label className="vault-field">
              <span>{t('vault.currentPassword')}</span>
              <input
                type="password"
                value={oldPassword}
                disabled={busy}
                onChange={(e) => setOldPassword(e.target.value)}
              />
            </label>
            <label className="vault-field">
              <span>{t('vault.newPassword')}</span>
              <input
                type="password"
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="vault-field">
              <span>{t('vault.confirmPassword')}</span>
              <input
                type="password"
                value={confirm}
                disabled={busy}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            {mismatch && <div className="vault-error">{t('vault.mismatch')}</div>}
          </>
        )}

        {error && <div className="vault-error">{error}</div>}
        {done && <div className="vault-ok">{done}</div>}
      </ModalBody>

      <ModalFooter>
        {status.enabled ? (
          <>
            <button
              className="btn btn-secondary"
              disabled={busy || !oldPassword}
              onClick={() => setAskDisable(true)}
            >
              {t('vault.disable')}
            </button>
            <button className="btn btn-secondary" disabled={busy} onClick={() => void lockVault()}>
              {t('vault.lockNow')}
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || !oldPassword || !password || mismatch}
              onClick={handleChange}
            >
              {t('vault.change')}
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-secondary" disabled={busy} onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || !password || mismatch}
              onClick={handleEnable}
            >
              {t('vault.enable')}
            </button>
          </>
        )}
      </ModalFooter>

      <ConfirmDialog
        open={askDisable}
        title={t('vault.disableTitle')}
        message={t('vault.disableMessage')}
        note={t('vault.disableNote')}
        confirmLabel={t('vault.disable')}
        danger
        zIndex={10001}
        onConfirm={handleDisable}
        onCancel={() => setAskDisable(false)}
      />
    </Modal>
  );
};
