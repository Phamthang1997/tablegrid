import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AlertTriangle, Undo2 } from 'lucide-react';
import { dbHelper, TX_EVENT, TX_ISOLATION_LEVELS, type TxStatus } from '../utils/dbHelper';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { CLOSE_PRIORITY_TX, registerCloseBlocker } from '../utils/closeGuard';

interface TxControlProps {
  /** 'sqlite' | 'postgres' | 'mysql' — decides which isolation levels are listed. */
  dbType: string;
  /** Hidden entirely while nothing is connected. */
  connected: boolean;
  /**
   * Connection this control is showing. Every session is per connection now, and the backend emits
   * one `tx-state-changed` per connection — without filtering on this, a second connection's event
   * would overwrite the first one's display.
   */
  connId: string;
}

/**
 * The manual-transaction control: ONE button on the title bar, with every action inside the
 * "pending changes" dialog.
 *
 * A transaction here belongs to the **connection**, not to a tab — so claiming that two tabs have two
 * transactions would be a lie. That is why the button sits on the title bar rather than in each tab's
 * toolbar.
 *
 * The frontend NEVER infers the state: everything shown here comes from the `tx-state-changed` event
 * Rust emits after each statement — including a `COMMIT` the user typed in the SQL Editor, and a DDL
 * statement MySQL commits by itself. See `src-tauri/src/tx_session.rs`.
 */
export const TxControl: React.FC<TxControlProps> = ({ dbType, connected, connId }) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<TxStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spName, setSpName] = useState('');
  // Elapsed duration in seconds for open transaction
  const [totalSec, setTotalSec] = useState(0);
  const [askOnClose, setAskOnClose] = useState(false);
  // Handler close window registered once; reads status via ref to avoid re-binding
  const statusRef = useRef<TxStatus | null>(null);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const refresh = useCallback(async () => {
    try {
      setStatus(await dbHelper.txStatus());
    } catch {
      /* not connected -> preserve */
    }
  }, []);

  useEffect(() => {
    if (!connected) {
      queueMicrotask(() => {
        setStatus(null);
        setOpen(false);
      });
      return;
    }
    queueMicrotask(() => void refresh());
    const un = listen<TxStatus>(TX_EVENT, (e) => {
      // Drop events belonging to another connection. `connId` is absent only on a backend older
      // than this window (tauri dev keeps the last binary that built), so treat a missing one as
      // "mine" rather than showing nothing at all.
      if (e.payload.connId && e.payload.connId !== connId) return;
      setStatus(e.payload);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [connected, connId, refresh]);

  // Client-side timer: computes elapsed duration from transaction start
  useEffect(() => {
    if (!status?.open) {
      queueMicrotask(() => setTotalSec(0));
      return;
    }
    const openedAt = Date.now() - status.sinceMs;
    const update = () => {
      const elapsedMs = Date.now() - openedAt;
      setTotalSec(Math.max(0, Math.floor(elapsedMs / 1000)));
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [status?.open, status?.sinceMs]);

  // Prevent data loss on uncommitted transactions during app close
  useEffect(() => registerCloseBlocker(CLOSE_PRIORITY_TX, async () => {
    let pending = false;
    try {
      pending = await dbHelper.txAnyPending();
    } catch {
      const s = statusRef.current;
      pending = !!s?.open && s.statements > 0;
    }
    if (!pending) return false;
    setAskOnClose(true);
    return true;
  }), []);

  if (!connected || !status) return null;

  const elapsed =
    totalSec < 60
      ? t('tx.elapsedSec', { n: totalSec })
      : t('tx.elapsedMin', { n: Math.floor(totalSec / 60), b: totalSec % 60 });
  // A soft 5-minute mark: a long transaction holds locks and swells the undo log / WAL.
  const isLong = status.open && totalSec >= 300;
  const levels = TX_ISOLATION_LEVELS[dbType] || [];
  const isSqlite = dbType === 'sqlite';

  // The button is a SWITCH, not a dropdown: the dialog opens only when there is something to decide.
  //   Auto                  -> click: switch to manual
  //   Manual, nothing yet   -> click: switch back to auto
  //   Manual, N statements  -> click: open the dialog (the mode does not change — the backend refuses
  //                           a mode change while changes are uncommitted, so changing it here would
  //                           only produce an error)
  const hasPending = status.statements > 0;
  const summaryTitle = hasPending
    ? `${t('tx.clickToReview', { n: status.statements })} · ${
        status.aborted ? t('tx.aborted') : t('tx.longOpen', { n: elapsed })
      }`
    : status.autocommit
      ? `${t('tx.clickToManual')} — ${t('tx.manualDesc')}`
      : `${t('tx.clickToAuto')} — ${t('tx.autoDesc')}`;

  const handleButton = () => {
    setError(null);
    if (hasPending) {
      setOpen(true);
      return;
    }
    void run(() => dbHelper.txSetAutocommit(!status.autocommit));
  };

  /**
   * `refetch` is for the operations that change the rows the user is looking at — Commit, Discard,
   * `ROLLBACK TO`. Without it the grid keeps showing the value that was just rolled back, which
   * reads as "Discard did not roll anything back" even though the backend did. `database-restored`
   * is the event `DataGrid` and `Sidebar` already listen to, so this needs no new channel.
   *
   * Mode / isolation / savepoint do NOT refetch: they change no row, and reloading the grid there
   * would be a round trip for nothing.
   */
  const run = async (
    fn: () => Promise<TxStatus>,
    closeAfter = false,
    refetch = false,
  ) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await fn());
      if (refetch) window.dispatchEvent(new CustomEvent('database-restored', { detail: { connId } }));
      if (closeAfter) setOpen(false);
    } catch (err) {
      // The message was already translated at the dbHelper boundary (backendErrors.ts).
      setError(String(err));
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  // `pendingSql` can be absent when the running backend is OLDER than this window (tauri dev keeps the
  // last binary that built when Rust fails to compile). Say so plainly rather than showing an
  // unexplained empty box — and read it defensively so no TypeError blows up mid-render.
  const pendingList = Array.isArray(status.pendingSql) ? status.pendingSql : null;

  // Identical statements are collapsed into one entry, keeping the order of the FIRST run and carrying
  // how many times it ran.
  //
  // The count has to be shown: four `UPDATE … SET first_name = 'X'` give the same result as one, while
  // four `SET n = n + 1` do not — and the text alone cannot tell the two apart. The server executed all
  // four and Rollback is undoing all four, so dropping the number misstates what is happening.
  const groupedPending = (pendingList ?? []).reduce<{ sql: string; times: number }[]>((acc, sql) => {
    const hit = acc.find((g) => g.sql === sql);
    if (hit) hit.times += 1;
    else acc.push({ sql, times: 1 });
    return acc;
  }, []);

  return (
    <>
      {/* ONE button on the title bar. The previous version laid out mode + counter + Commit + Rollback
          as four loose items, taking ~330px and squeezing the centre status capsule (flex:1) down to a
          circle. Every action lives in the dialog.

          `tb-capsule-btn` keeps the bar's default shape — no colour, weight or gap is overridden here;
          spacing goes on the child elements. */}
      <div className="tb-capsule" style={{ flexShrink: 0 }}>
        <button
          type="button"
          className="tb-capsule-btn"
          onClick={handleButton}
          disabled={busy}
          title={summaryTitle}
          // `totalSec` ensures re-render every second for elapsed tooltip.
          data-tick={totalSec}
        >
          {hasPending && (
            <span
              aria-hidden
              style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                marginRight: '6px',
                background: status.aborted ? 'var(--st-danger, #ef4444)' : '#f59e0b',
                flexShrink: 0,
              }}
            />
          )}
          <span>{status.autocommit ? t('tx.autoShort') : t('tx.manualShort')}</span>
          {hasPending && <span style={{ marginLeft: '5px' }}>{`· ${status.statements}`}</span>}
        </button>
      </div>

      {open && (
        <Modal
          title={t('tx.pendingTitle')}
          onClose={busy ? undefined : () => setOpen(false)}
          closeDisabled={busy}
          width="760px"
          maxWidth="92%"
          maxHeight="82vh"
          zIndex={99999}
        >
          <ModalBody style={{ padding: 0, gap: 0, flex: 1, minHeight: 0 }}>
            {/* The settings row: mode and isolation level. The dialog's original design had only the
                SQL and two buttons, but the auto-commit switch and the isolation level needed a home —
                here they sit with the very thing they govern. */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                flexWrap: 'wrap',
                padding: '10px 14px',
                borderBottom: '1px solid var(--win-border)',
              }}
            >
              <div style={{ display: 'flex', gap: '6px' }}>
                {[true, false].map((auto) => (
                  <button
                    key={String(auto)}
                    type="button"
                    className={`btn ${status.autocommit === auto ? 'btn-primary' : 'btn-secondary'}`}
                    // Switching back to auto with changes uncommitted is refused by the backend — so it
                    // is blocked here with a reason, rather than letting the click return an error line.
                    disabled={busy || (auto && hasPending)}
                    title={auto && hasPending ? t('tx.autoBlocked') : auto ? t('tx.autoDesc') : t('tx.manualDesc')}
                    onClick={() => void run(() => dbHelper.txSetAutocommit(auto))}
                  >
                    {auto ? t('tx.auto') : t('tx.manual')}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' }}>
                <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
                  {isSqlite ? t('tx.lockMode') : t('tx.isolation')}
                </span>
                <select
                  className="input"
                  style={{ width: '190px' }}
                  value={status.isolation || ''}
                  disabled={busy}
                  title={t('tx.isolationHint')}
                  onChange={(e) => void run(() => dbHelper.txSetIsolation(e.target.value || null))}
                >
                  <option value="">{t('tx.isolationDefault')}</option>
                  {levels.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
                {!isSqlite && (
                  <label
                    style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px' }}
                    title={t('tx.readOnlyHint')}
                  >
                    <input
                      type="checkbox"
                      checked={status.readOnly}
                      disabled={busy}
                      onChange={(e) => void run(() => dbHelper.txSetIsolation(status.isolation, e.target.checked))}
                    />
                    <span>{t('tx.readOnly')}</span>
                  </label>
                )}
              </div>
            </div>

            {/* The pending statements. A monospaced <pre> rather than Monaco: DataGrid's SQL preview
                dialog (`commitPreview`) already does exactly this, and a Monaco instance built inside
                Modal's portal has too many ways to fail silently (measuring at mount, a theme not yet
                defined) — and failing that way leaves the user looking at a blank box. */}
            <div
              style={{
                flex: 1,
                minHeight: '260px',
                overflow: 'auto',
                padding: '12px 14px',
                background: 'var(--win-bg-window)',
                fontFamily: 'var(--win-font-mono)',
                fontSize: '12px',
                color: 'var(--win-text-primary)',
              }}
            >
              {pendingList === null ? (
                <div style={{ color: 'var(--st-danger, #ef4444)', fontFamily: 'var(--win-font-sans)', lineHeight: 1.5 }}>
                  {t('tx.staleBackend')}
                </div>
              ) : pendingList.length === 0 ? (
                <div style={{ color: 'var(--win-text-secondary)', fontFamily: 'var(--win-font-sans)', lineHeight: 1.5 }}>
                  {status.open ? t('tx.pendingEmpty') : t(status.autocommit ? 'tx.autoDesc' : 'tx.manualDesc')}
                </div>
              ) : (
                groupedPending.map((g, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      gap: '10px',
                      padding: '4px 0 8px',
                      borderBottom: idx < groupedPending.length - 1 ? '1px dashed var(--win-border)' : 'none',
                      marginBottom: idx < groupedPending.length - 1 ? '8px' : 0,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        flexShrink: 0,
                        minWidth: '18px',
                        textAlign: 'right',
                        color: 'var(--win-text-disabled)',
                        userSelect: 'none',
                      }}
                    >
                      {idx + 1}
                    </span>
                    <pre style={{ margin: 0, flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {g.sql.trimEnd().endsWith(';') ? g.sql : `${g.sql};`}
                    </pre>
                    {g.times > 1 && (
                      <span
                        title={t('tx.ranTimes', { n: g.times })}
                        style={{
                          flexShrink: 0,
                          alignSelf: 'flex-start',
                          padding: '1px 7px',
                          borderRadius: '10px',
                          background: 'var(--win-bg-tab-bar)',
                          border: '1px solid var(--win-border)',
                          color: 'var(--win-text-secondary)',
                          fontSize: '11px',
                        }}
                      >
                        {`×${g.times}`}
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Warnings and savepoints: shown only when there is something to say, never holding space permanently. */}
            {(status.aborted || status.implicitCommit || isLong || status.sqlTruncated) && (
              <div
                style={{
                  padding: '10px 14px',
                  borderTop: '1px solid var(--win-border)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  fontSize: '11.5px',
                  lineHeight: 1.45,
                }}
              >
                {status.aborted && (
                  <div style={{ display: 'flex', gap: '6px', color: 'var(--st-danger, #ef4444)' }}>
                    <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: '1px' }} />
                    <span>{t('tx.abortedHint')}</span>
                  </div>
                )}
                {status.implicitCommit && (
                  <div style={{ color: 'var(--win-text-secondary)' }}>{t('tx.implicitNotice')}</div>
                )}
                {isLong && (
                  <div style={{ color: 'var(--st-danger, #ef4444)' }}>{t('tx.longOpen', { n: elapsed })}</div>
                )}
                {status.sqlTruncated && (
                  <div style={{ color: 'var(--win-text-secondary)' }}>
                    {t('tx.pendingTruncated', { n: status.pendingSql.length, b: status.statements })}
                  </div>
                )}
              </div>
            )}

            {status.open && (
              <div
                style={{
                  padding: '10px 14px',
                  borderTop: '1px solid var(--win-border)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
                  {t('tx.savepoints')}
                </span>
                <input
                  type="text"
                  className="input"
                  style={{ width: '160px' }}
                  placeholder={t('tx.savepointPlaceholder')}
                  value={spName}
                  disabled={busy}
                  onChange={(e) => setSpName(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || !spName.trim()}
                  onClick={() =>
                    void run(async () => {
                      const s = await dbHelper.txSavepoint(spName.trim());
                      setSpName('');
                      return s;
                    })
                  }
                >
                  {t('tx.savepointAdd')}
                </button>
                {status.savepoints.map((sp) => (
                  <button
                    key={sp}
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    title={t('tx.savepointRollback')}
                    onClick={() => void run(() => dbHelper.txRollbackTo(sp), false, true)}
                  >
                    <Undo2 size={12} />
                    <span>{sp}</span>
                  </button>
                ))}
              </div>
            )}

            {error && (
              <div
                style={{
                  padding: '10px 14px',
                  borderTop: '1px solid var(--win-border)',
                  fontSize: '11.5px',
                  lineHeight: 1.45,
                  color: 'var(--st-danger, #ef4444)',
                }}
              >
                {error}
              </div>
            )}
          </ModalBody>

          <ModalFooter style={{ justifyContent: 'space-between' }}>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !status.open}
              onClick={() => void run(() => dbHelper.txRollback(), true, true)}
            >
              {t('tx.discard')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !status.open || status.aborted}
              onClick={() => void run(() => dbHelper.txCommit(), true, true)}
            >
              {t('tx.commit')}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {askOnClose && (
        <Modal
          title={t('tx.closeTitle')}
          onClose={busy ? undefined : () => setAskOnClose(false)}
          closeDisabled={busy}
          zIndex={100001}
          width="440px"
        >
          <ModalBody>
            <div style={{ fontSize: '12px', lineHeight: 1.5 }}>
              {t('tx.closeMessage', { n: status.statements })}
            </div>
            {error && (
              <div style={{ fontSize: '11px', lineHeight: 1.45, color: 'var(--st-danger, #ef4444)' }}>{error}</div>
            )}
          </ModalBody>
          <ModalFooter>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setAskOnClose(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={async () => {
                await run(() => dbHelper.txRollback());
                // The transaction is closed -> this close() passes the guard above.
                void getCurrentWindow().close();
              }}
            >
              {t('tx.closeRollback')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                try {
                  setBusy(true);
                  setError(null);
                  setStatus(await dbHelper.txCommit());
                  void getCurrentWindow().close();
                } catch (err) {
                  // A failed commit does NOT close: closing anyway would throw away the very thing that just failed.
                  setError(String(err));
                  void refresh();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('tx.closeCommit')}
            </button>
          </ModalFooter>
        </Modal>
      )}
    </>
  );
};
