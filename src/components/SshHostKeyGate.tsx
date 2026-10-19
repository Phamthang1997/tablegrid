import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AlertTriangle, KeyRound } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { dbHelper } from '../utils/dbHelper';
import { knownHostsId, setHostKeyConfirmer, type HostKeyChallenge } from '../utils/sshHostKeys';

/**
 * The SSH host key prompt: shown when a server's key is not trusted yet, or has changed. Mounted
 * once at the root of each window (the main one and the standalone terminal), like `SafeModeGate`.
 *
 * Trusting saves the key HERE, before answering, so a write that fails is shown next to the
 * fingerprint and the user can retry or cancel — `sshHostKeys.ts` only reconnects once it is saved.
 */
export const SshHostKeyGate: React.FC = () => {
  const { t } = useTranslation();
  const [pending, setPending] = useState<{
    challenge: HostKeyChallenge;
    resolve: (trusted: boolean) => void;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHostKeyConfirmer(
      (challenge) =>
        new Promise<boolean>((resolve) => {
          setError(null);
          setPending((prev) => {
            // Two connects to two refused hosts: the older question is the one no longer in front of
            // the user, and declining is the safe answer to it.
            prev?.resolve(false);
            return { challenge, resolve };
          });
        })
    );
    return () => setHostKeyConfirmer(null);
  }, []);

  if (!pending) return null;
  const { challenge, resolve } = pending;
  const hostLabel = `${challenge.host}:${challenge.port}`;
  const changed = challenge.status !== 'unknown';
  const fixedOutside = challenge.status === 'changedOpenSsh';

  const answer = (trusted: boolean) => {
    resolve(trusted);
    setPending(null);
    setSaving(false);
  };

  const trust = async () => {
    setSaving(true);
    setError(null);
    try {
      await dbHelper.sshTrustHostKey(challenge.host, challenge.port, challenge.fingerprint);
      answer(true);
    } catch (e) {
      setSaving(false);
      setError(String(e));
    }
  };

  const bodyKey = fixedOutside
    ? 'sshHostKey.bodyChangedOpenSsh'
    : changed
      ? 'sshHostKey.bodyChanged'
      : 'sshHostKey.bodyUnknown';

  return (
    <Modal
      title={changed ? t('sshHostKey.titleChanged') : t('sshHostKey.titleUnknown')}
      icon={
        changed ? (
          <AlertTriangle size={14} className="shk-icon-danger" />
        ) : (
          <KeyRound size={14} className="shk-icon" />
        )
      }
      onClose={() => answer(false)}
      closeDisabled={saving}
      // A changed key must be answered on purpose, not dismissed by a stray click beside the card.
      closeOnBackdrop={!changed}
      width="480px"
      maxWidth="92%"
      zIndex={100001}
    >
      <ModalBody>
        <div className={changed ? 'shk-body shk-body-danger' : 'shk-body'}>
          <Trans
            i18nKey={bodyKey}
            values={{ a: hostLabel, b: knownHostsId(challenge.host, challenge.port) }}
            components={{ strong: <strong />, code: <code /> }}
          />
        </div>
        <div className="shk-key">
          <div className="shk-label">{t('sshHostKey.keyType')}</div>
          <div className="shk-value">{challenge.algorithm}</div>
          <div className="shk-label">{t('sshHostKey.fingerprint')}</div>
          <div className="shk-value shk-fp">{challenge.fingerprint}</div>
        </div>
        {!fixedOutside && <div className="shk-note">{t('sshHostKey.savedTo')}</div>}
        {error && <div className="shk-error">{t('sshHostKey.trustFailed', { a: error })}</div>}
      </ModalBody>
      <ModalFooter>
        {fixedOutside ? (
          <button type="button" className="btn btn-primary" onClick={() => answer(false)}>
            {t('sshHostKey.close')}
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-secondary" onClick={() => answer(false)} disabled={saving}>
              {t('sshHostKey.cancel')}
            </button>
            <button
              type="button"
              className={changed ? 'btn btn-primary shk-btn-danger' : 'btn btn-primary'}
              onClick={() => void trust()}
              disabled={saving}
            >
              {changed ? t('sshHostKey.replace') : t('sshHostKey.trust')}
            </button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
};
