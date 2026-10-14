// Keyspace export / import dialog by prefix.
//
// Core logic resides in `utils/redisTransfer.ts`; this file provides the two-tab modal UI.


//
// Both transfer modes share unified file format within a single dialog.


import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AlertTriangle, Download, Save, Square, Upload } from 'lucide-react';
import { activeConnId, dbHelper } from '../../utils/dbHelper';
import { approveJob, connKeyOfConn, openJobDoor, type JobApproval } from '../../utils/safeMode';
import { cancelJob, startJob, type JobProgress } from '../../utils/jobs';
import { pickSaveFilePath, saveExportFileAtPath } from '../../utils/fileSave';
import {
  EXPORT_KEY_CAP,
  applyRedisImport,
  buildRedisExport,
  countByType,
  parseRedisExport,
  prefixPattern,
  suggestExportFileName,
  type ParsedExport,
  type RedisDumpEntry,
  type TransferProgress,
} from '../../utils/redisTransfer';
import { Modal, ModalBody, ModalFooter } from '../Modal';

/** Supported key type filters matching the key browser list. */
const TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream'];

/** Error list threshold before truncating with "...and N more". */
const FAILED_SHOWN = 8;

interface RedisTransferDialogProps {
  open: boolean;
  /** Initial active tab. Context menu on key tree branches opens directly to `export`. */
  initialTab?: 'export' | 'import';
  /** Pre-filled key prefix (from selected tree branch or search filter). */
  initialPrefix: string;
  initialTypeFilter: string;
  dbIndex: number;
  readOnly: boolean;
  onClose: () => void;
  /** Import completed callback -> triggers key list refresh. */
  onImported: () => void;
  onError: (msg: string) => void;
}

export const RedisTransferDialog: React.FC<RedisTransferDialogProps> = ({
  open,
  initialTab = 'export',
  initialPrefix,
  initialTypeFilter,
  dbIndex,
  readOnly,
  onClose,
  onImported,
  onError,
}) => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'export' | 'import'>(initialTab);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // The run is a job (`jobs.ts`); Stop cancels it, and the loops read `ctx.cancelled()` directly.
  const jobIdRef = useRef<string | null>(null);

  // ---- Export ----
  const [prefix, setPrefix] = useState(initialPrefix);
  const [typeFilter, setTypeFilter] = useState(initialTypeFilter);
  const [exported, setExported] = useState<{
    keys: number; missing: number; filtered: number; capped: boolean; stopped: boolean;
  } | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  // ---- Import ----
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedExport | null>(null);
  const [replace, setReplace] = useState(false);
  const [imported, setImported] = useState<{
    restored: number; skipped: number; failed: { key: string; error: string }[]; stopped: boolean;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setTab(initialTab);
      setPrefix(initialPrefix);
      setTypeFilter(initialTypeFilter);
      setExported(null);
      setSavedPath(null);
      setFileName('');
      setParsed(null);
      setReplace(false);
      setImported(null);
      setProgress(null);
      setRunError(null);
      setRunning(false);
    });
  }, [open, initialTab, initialPrefix, initialTypeFilter]);

  const pattern = useMemo(() => prefixPattern(prefix), [prefix]);

  /** What the tray shows for a transfer's progress — the same words as the dialog's status line. */
  const jobProgress = useCallback((p: TransferProgress): JobProgress => ({
    label: p.phase === 'dump'
      ? t('redis.transferDumping', { n: p.done.toLocaleString() })
      : p.phase === 'restore'
        ? t('redis.transferRestoring', { done: p.done.toLocaleString(), total: (p.total ?? 0).toLocaleString() })
        : t('redis.transferScanning', { n: p.done.toLocaleString() }),
    current: p.total ? p.done : undefined,
    total: p.total,
  }), [t]);

  /**
   * Export as a **background job**. The file is chosen FIRST and written by the job itself: the
   * export used to live in this dialog's state until the user pressed Save, so closing the dialog —
   * or just switching tabs of the app — threw away a scan of 100k keys. The dialog still shows the
   * run while it is open (one run, read from two places, like the Data Generator); closing it
   * leaves the job running in the tray.
   *
   * The connection id is fixed here: `redis_*` commands otherwise take the ambient id, and a job
   * that outlives this dialog must not follow the user to another server.
   */
  const runExport = useCallback(async () => {
    const name = suggestExportFileName(dbIndex, prefix, new Date().toISOString());
    const path = await pickSaveFilePath(name, 'ndjson', t('redis.transferFileFilter'));
    if (!path) return;
    const connId = activeConnId();
    const pat = pattern;
    const types = typeFilter || undefined;
    setRunning(true);
    setRunError(null);
    setExported(null);
    setSavedPath(null);
    setProgress(null);
    jobIdRef.current = startJob({
      kind: 'redis-transfer',
      title: t('jobs.titleRedisExport', { n: `db${dbIndex} ${pat}` }),
      db: `db${dbIndex}`,
      conn: connKeyOfConn(connId),
      lockKey: `${connId}|db${dbIndex}`,
      run: async (ctx) => {
        try {
          const res = await buildRedisExport(
            {
              pattern: pat,
              db: dbIndex,
              typeFilter: types,
              // `createdAt` timestamp fixed at export initiation for deterministic testing.
              createdAt: new Date().toISOString(),
              onProgress: (p) => {
                setProgress(p);
                ctx.report(jobProgress(p));
              },
              // A stopped export still writes what it has: the file then carries no footer, and
              // `parseRedisExport` reports it as truncated rather than passing it off as complete.
              shouldStop: () => ctx.cancelled(),
            },
            {
              scan: (p, cursor, count) => dbHelper.redisScanKeys(p, cursor, count, undefined, connId),
              dump: (keys) => dbHelper.redisDumpKeys(keys, connId),
            },
          );
          setExported({
            keys: res.keys,
            missing: res.missing.length,
            filtered: res.filtered,
            capped: res.capped,
            stopped: res.stopped,
          });
          if (res.keys === 0) return { message: t('redis.transferExportEmpty') };
          await saveExportFileAtPath(path, res.text, 'application/x-ndjson');
          setSavedPath(path);
          const notes = [
            res.missing.length > 0 ? t('redis.transferMissing', { n: res.missing.length.toLocaleString() }) : '',
            res.capped ? t('redis.transferCapped', { n: EXPORT_KEY_CAP.toLocaleString() }) : '',
            res.stopped ? t('redis.transferStopped') : '',
          ].filter(Boolean);
          return {
            message: t('redis.transferSaved', { path }),
            path,
            dir: path.replace(/[\\/][^\\/]*$/, ''),
            warning: notes.length ? notes.join('\n') : undefined,
          };
        } catch (e: any) {
          setRunError(String(e?.message ?? e));
          throw e;
        } finally {
          setRunning(false);
          setProgress(null);
        }
      },
    });
  }, [pattern, dbIndex, prefix, typeFilter, t, jobProgress]);

  const pickFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] || null;
    e.target.value = '';
    if (!picked) return;
    setFileName(picked.name);
    setParsed(null);
    setImported(null);
    try {
      const text = await picked.text();
      setParsed(parseRedisExport(text));
    } catch (err: any) {
      onError(t('redis.transferReadFileErr', { message: String(err?.message ?? err) }));
    }
  }, [onError, t]);

  /**
   * Import as a **background job**, asked about ONCE, now (`approveJob`) — not when the job reaches
   * the front of the queue. The batches then pass through the door opened for the job's duration.
   * There is no private connection here: Redis has no manual-transaction session to leak into, so
   * what a job needs is only an id that stays put, which `connId` fixed at submit already is.
   */
  const runImport = useCallback(async () => {
    if (!parsed) return;
    const connId = activeConnId();
    const detail = t(
      replace ? 'redis.transferApproveReplace' : 'redis.transferApprove',
      { n: parsed.entries.length.toLocaleString(), db: dbIndex },
    );
    let approval: JobApproval;
    try {
      approval = await approveJob('redis_restore_keys', connId, detail);
    } catch {
      return;
    }
    const entries = parsed.entries as RedisDumpEntry[];
    const rep = replace;
    setRunning(true);
    setRunError(null);
    setImported(null);
    setProgress(null);
    jobIdRef.current = startJob({
      kind: 'redis-transfer',
      title: t('jobs.titleRedisImport', { n: `db${dbIndex}` }),
      db: `db${dbIndex}`,
      conn: connKeyOfConn(connId),
      write: true,
      lockKey: `${connId}|db${dbIndex}`,
      run: async (ctx) => {
        const closeDoor = openJobDoor(approval, connId);
        try {
          const res = await applyRedisImport(
            entries,
            { restore: (batch, r) => dbHelper.redisRestoreKeys(batch, r, connId) },
            {
              replace: rep,
              onProgress: (p) => {
                setProgress(p);
                ctx.report(jobProgress(p));
              },
              shouldStop: () => ctx.cancelled(),
            },
          );
          setImported(res);
          // Invokes callback even on abort: keys already restored are persisted in database.
          if (res.restored > 0) onImported();
          return {
            message: t('redis.transferImportDone', {
              restored: res.restored.toLocaleString(),
              skipped: res.skipped.toLocaleString(),
              failed: res.failed.length.toLocaleString(),
            }),
            warning: res.failed.length
              ? res.failed.slice(0, FAILED_SHOWN).map((f) => `${f.key} — ${f.error}`).join('\n')
              : undefined,
          };
        } catch (e: any) {
          setRunError(String(e?.message ?? e));
          throw e;
        } finally {
          closeDoor();
          setRunning(false);
          setProgress(null);
        }
      },
    });
  }, [parsed, replace, dbIndex, t, onImported, jobProgress]);

  /** Stop = cancel the job; the loops read `ctx.cancelled()` between batches. */
  const stop = () => {
    if (jobIdRef.current) cancelJob(jobIdRef.current);
  };

  if (!open) return null;

  const n = (v: number) => v.toLocaleString();
  const byType = parsed ? countByType(parsed.entries) : [];
  const validFile = !!parsed?.header;

  return (
    <Modal
      title={t('redis.transferTitle')}
      icon={<Upload size={14} />}
      onClose={onClose}
      width="560px"
      zIndex={10000}
    >
      <ModalBody style={{ gap: '10px' }}>
        <div className="redis-transfer-tabs">
          <button
            className={`btn btn-secondary redis-value-btn wide${tab === 'export' ? ' active' : ''}`}
            onClick={() => setTab('export')}
            disabled={running}
          >
            <Download size={11} /> {t('redis.transferTabExport')}
          </button>
          <button
            className={`btn btn-secondary redis-value-btn wide${tab === 'import' ? ' active' : ''}`}
            onClick={() => setTab('import')}
            disabled={running}
          >
            <Upload size={11} /> {t('redis.transferTabImport')}
          </button>
        </div>

        {/* DUMP/RESTORE trade-offs: payload contains RDB version footer; importable into equal or newer Redis versions only. */}
        <div className="redis-dialog-warn">
          <AlertTriangle size={12} className="redis-dialog-warn-icon" />
          <span>{t('redis.transferVersionNote')}</span>
        </div>

        {tab === 'export' ? (
          <>
            <label className="redis-dialog-label">{t('redis.transferPrefix')}</label>
            <input
              type="text"
              className="form-input redis-dialog-input"
              value={prefix}
              disabled={running}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder={t('redis.transferPrefixPlaceholder')}
              spellCheck={false}
            />
            {/* Displays exact glob pattern sent to SCAN with special characters escaped */}
            <div className="redis-dialog-label">
              <Trans
                i18nKey="redis.transferPatternPreview"
                values={{ pattern }}
                components={{ code: <b className="redis-dialog-code" /> }}
              />
            </div>

            <label className="redis-dialog-label">{t('redis.transferType')}</label>
            <select
              value={typeFilter}
              disabled={running}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="redis-dialog-select"
            >
              <option value="">{t('redis.allTypes')}</option>
              {TYPES.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
            </select>

            {running && (
              <div className="redis-dialog-status">
                {progress?.phase === 'dump'
                  ? t('redis.transferDumping', { n: n(progress.done) })
                  : t('redis.transferScanning', { n: n(progress?.done ?? 0) })}
              </div>
            )}

            {exported && (
              <div className={`redis-dialog-status ${exported.keys > 0 ? 'ok' : 'cancelled'}`}>
                <div>
                  {exported.keys > 0
                    ? t('redis.transferExportDone', { n: n(exported.keys) })
                    : t('redis.transferExportEmpty')}
                </div>
                {exported.filtered > 0 && (
                  <div>{t('redis.transferFiltered', { n: n(exported.filtered) })}</div>
                )}
                {exported.missing > 0 && (
                  <div>{t('redis.transferMissing', { n: n(exported.missing) })}</div>
                )}
                {exported.capped && (
                  <div>{t('redis.transferCapped', { n: n(EXPORT_KEY_CAP) })}</div>
                )}
                {exported.stopped && <div>{t('redis.transferStopped')}</div>}
              </div>
            )}

            {savedPath && (
              <div className="redis-dialog-status ok">
                {t('redis.transferSaved', { path: savedPath })}
              </div>
            )}
          </>
        ) : (
          <>
            <label className="redis-dialog-label">{t('redis.transferFile')}</label>
            <div className="redis-transfer-file">
              <label className="btn btn-secondary redis-value-btn wide">
                {t('redis.transferPickFile')}
                <input
                  type="file"
                  accept=".ndjson,.jsonl,.json"
                  onChange={pickFile}
                  disabled={running}
                  className="redis-transfer-file-input"
                />
              </label>
              <span className="redis-dialog-label">{fileName || t('redis.transferFileNone')}</span>
            </div>

            {parsed && !validFile && (
              <div className="redis-dialog-warn">
                <AlertTriangle size={12} className="redis-dialog-warn-icon" />
                <span>{t('redis.transferFileBad')}</span>
              </div>
            )}

            {parsed && validFile && (
              <>
                <div className="redis-dialog-status">
                  <div>
                    {t('redis.transferFileSummary', {
                      n: n(parsed.entries.length),
                      db: parsed.header?.db ?? 0,
                      pattern: parsed.header?.pattern ?? '*',
                    })}
                  </div>
                  {byType.length > 0 && (
                    <div>{byType.map((b) => `${b.type} ${n(b.n)}`).join(' · ')}</div>
                  )}
                </div>

                {/* Missing footer indicates interrupted export or truncated file; keys remain importable */}
                {parsed.truncated && (
                  <div className="redis-dialog-warn">
                    <AlertTriangle size={12} className="redis-dialog-warn-icon" />
                    <span>{t('redis.transferFileTruncated')}</span>
                  </div>
                )}
                {parsed.declaredKeys != null && parsed.declaredKeys !== parsed.entries.length && (
                  <div className="redis-dialog-warn">
                    <AlertTriangle size={12} className="redis-dialog-warn-icon" />
                    <span>
                      {t('redis.transferDeclaredMismatch', {
                        declared: n(parsed.declaredKeys),
                        n: n(parsed.entries.length),
                      })}
                    </span>
                  </div>
                )}
                {parsed.badLines.length > 0 && (
                  <div className="redis-dialog-warn">
                    <AlertTriangle size={12} className="redis-dialog-warn-icon" />
                    <span>
                      {t('redis.transferFileBadLines', {
                        n: n(parsed.badLines.length),
                        lines: parsed.badLines.slice(0, 5).join(', '),
                      })}
                    </span>
                  </div>
                )}

                <label className="redis-dialog-label block">
                  <input
                    type="checkbox"
                    checked={replace}
                    disabled={running || readOnly}
                    onChange={(e) => setReplace(e.target.checked)}
                  />
                  <span>{t('redis.transferReplace')}</span>
                </label>
                <div className="redis-dialog-label">{t('redis.transferReplaceHint')}</div>
              </>
            )}

            {running && (
              <div className="redis-dialog-status">
                {t('redis.transferRestoring', {
                  done: n(progress?.done ?? 0),
                  total: n(progress?.total ?? 0),
                })}
              </div>
            )}

            {imported && (
              <div className={`redis-dialog-status ${imported.failed.length ? 'cancelled' : 'ok'}`}>
                <div>
                  {t('redis.transferImportDone', {
                    restored: n(imported.restored),
                    skipped: n(imported.skipped),
                    failed: n(imported.failed.length),
                  })}
                </div>
                {imported.stopped && <div>{t('redis.transferStoppedImport')}</div>}
                {imported.failed.length > 0 && (
                  <div className="redis-mono-box redis-transfer-failed">
                    {imported.failed.slice(0, FAILED_SHOWN).map((f) => (
                      <div key={f.key}>{`${f.key} — ${f.error}`}</div>
                    ))}
                    {imported.failed.length > FAILED_SHOWN && (
                      <div>{t('redis.transferFailedMore', {
                        n: n(imported.failed.length - FAILED_SHOWN),
                      })}</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {runError && (
          <div className="redis-dialog-warn">
            <AlertTriangle size={12} className="redis-dialog-warn-icon" />
            <span>{runError}</span>
          </div>
        )}
      </ModalBody>

      <ModalFooter>
        {/* Close is offered while running too: the run is a background job and carries on in the tray. */}
        <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
        {running ? (
          <button className="btn btn-secondary redis-value-save danger" onClick={stop}>
            <Square size={10} /> {t('redis.transferStop')}
          </button>
        ) : (
          <>
            {tab === 'export' ? (
              <button className="btn btn-primary redis-value-save" onClick={runExport}>
                <Save size={11} /> {t('redis.transferRunExport')}
              </button>
            ) : (
              <button
                className="btn btn-primary redis-value-save"
                onClick={runImport}
                // Read-only check: enforced in backend; disabled in UI to prevent failing requests.
                
                disabled={readOnly || !validFile || parsed.entries.length === 0}
                title={readOnly ? t('redis.errReadOnly') : undefined}
              >
                <Upload size={11} /> {t('redis.transferRunImport')}
              </button>
            )}
          </>
        )}
      </ModalFooter>
    </Modal>
  );
};
