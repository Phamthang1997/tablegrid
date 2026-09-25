import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertTriangle, Ban, Bell, CheckCircle2, FolderOpen, Loader2, X } from 'lucide-react';
import {
  activeJobs,
  cancelJob,
  clearFinishedJobs,
  listJobs,
  onJobSettled,
  subscribeJobs,
  type JobRecord,
} from '../utils/jobs';
import {
  JOB_NOTIFY_CHANGED_EVENT,
  appIsInBackground,
  getJobNotifyEnabled,
  jobNotification,
  setJobNotifyEnabled,
  shouldNotifyJob,
  showNotification,
} from '../utils/jobNotify';
import {
  clearJobHistory,
  listJobHistory,
  removeJobHistoryEntry,
  subscribeJobHistory,
  type JobHistoryEntry,
} from '../utils/jobHistory';
import { CLOSE_PRIORITY_JOBS, forceClose, registerCloseBlocker } from '../utils/closeGuard';
import { openInFileManager } from '../utils/fileSave';
import { ProgressBar } from './ProgressBar';
import { Modal, ModalBody, ModalFooter } from './Modal';

/** The same width as `.jobs-pop` in index.css — used to anchor the popover so it cannot overflow the screen. */
const POP_WIDTH = 380;

/**
 * Background jobs: a **bell** button on the title bar, with the list in a popover **anchored right
 * below it** — not a dialog in the middle of the screen. A job running in the background is a
 * notification, not an action needing the whole screen; and opening it must not cover what the user
 * is doing.
 *
 * The anchoring (`top`/`left` + portal + backdrop) follows `SafeModeControl`, the title bar's other
 * popover: `right` + `position: fixed` leaves the blur layer offset from its own content.
 *
 * This component holds **no** progress: it reads from `utils/jobs.ts` through `useSyncExternalStore`,
 * so closing the popover (or unmounting the button entirely) loses no job. That is the whole point of
 * that module.
 */
export const JobsTray: React.FC = () => {
  const { t } = useTranslation();
  const jobs = useSyncExternalStore(subscribeJobs, listJobs);
  const history = useSyncExternalStore(subscribeJobHistory, listJobHistory);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const [askOnClose, setAskOnClose] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const active = jobs.filter((j) => j.state === 'running' || j.state === 'queued');
  const finished = jobs.filter((j) => j.state !== 'running' && j.state !== 'queued');
  // A job of this session is already shown above with its live row; the history lists the rest —
  // what earlier sessions did, plus this session's rows the user cleared from the list.
  const shownIds = new Set(jobs.map((j) => j.id));
  const earlier = history.filter((h) => !shownIds.has(h.id));

  // An OS notification when a job finishes while the user is in another window. Registered here
  // because this component is mounted for the whole life of the app (it returns null while empty,
  // after its hooks), and it is the one place with `t` to word the outcome. `t` goes through a ref
  // so a language switch does not re-register.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const [notifyOn, setNotifyOn] = useState(getJobNotifyEnabled);
  const [notifyTestError, setNotifyTestError] = useState<string | null>(null);
  useEffect(() => {
    const sync = () => setNotifyOn(getJobNotifyEnabled());
    window.addEventListener(JOB_NOTIFY_CHANGED_EVENT, sync);
    const off = onJobSettled((rec) => {
      if (!shouldNotifyJob(rec, { enabled: getJobNotifyEnabled(), background: appIsInBackground() })) return;
      const { title, body } = jobNotification(rec, tRef.current);
      void showNotification(title, body);
    });
    return () => {
      off();
      window.removeEventListener(JOB_NOTIFY_CHANGED_EVENT, sync);
    };
  }, []);

  // Closing the app with a job running = a half-loaded restore that cannot be resumed. Ask first.
  // A blocker rather than a listener of its own — see `closeGuard.ts`.
  useEffect(() => registerCloseBlocker(CLOSE_PRIORITY_JOBS, () => {
    if (activeJobs().length === 0) return false;
    setAskOnClose(true);
    return true;
  }), []);

  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAnchor(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [anchor]);

  // With no job ever queued and nothing remembered, it takes no space on the title bar. Once the
  // history holds something the bell stays, because "did last night's backup finish?" is asked
  // precisely when nothing is running.
  if (jobs.length === 0 && history.length === 0) return null;

  const failed = finished.some((j) => j.state === 'error');
  const capsuleTitle = active.length
    ? t('jobs.trayRunning', { n: active.length })
    : failed
      ? t('jobs.trayFailed')
      : t('jobs.trayIdle');

  // Anchored to the button's right and then clamped, so the whole popover is visible however close to an edge the button sits.
  const open = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const maxLeft = Math.max(10, window.innerWidth - POP_WIDTH - 10);
    setAnchor({ top: rect.bottom + 6, left: Math.min(maxLeft, Math.max(10, rect.right - POP_WIDTH)) });
  };

  return (
    <>
      {/* Wrapped in `.tb-capsule` like `TxControl`: that class holds the title bar's 34px height and
          centring, while `.tb-capsule-btn` alone only shapes the button. */}
      <div className="tb-capsule" style={{ flexShrink: 0 }}>
        <button
          ref={btnRef}
          className={`tb-capsule-btn ${active.length ? 'is-active-accent' : ''} ${!active.length && failed ? 'is-active-warn' : ''}`}
          onClick={() => (anchor ? setAnchor(null) : open())}
          title={capsuleTitle}
          aria-label={capsuleTitle}
        >
          {/* A bell is the notification symbol; the count of running jobs is the badge beside it — read
              the way every notification tray is read, rather than an icon that changes shape by state. */}
          <Bell size={13} />
          {active.length > 0 && <span className="jobs-badge">{active.length}</span>}
        </button>
      </div>

      {anchor &&
        createPortal(
          <>
            {/* `.jobs-backdrop`/`.jobs-pop` SHARE a rule with Safe Mode's `.sm-backdrop`/`.sm-pop` (one
                combined selector in index.css, not a copy) — so the title bar's popover shape is edited
                in one place and both follow. `.sm-pop-title` is that shape's heading row. */}
            <div className="jobs-backdrop" onClick={() => setAnchor(null)} />
            {/* Only `top`/`left` are inline — they are measured at render; the shape lives in .jobs-pop. */}
            <div className="jobs-pop" style={{ top: anchor.top, left: anchor.left }} role="dialog">
              <div className="jobs-pop-head">
                <div className="sm-pop-title">{t('jobs.panelTitle')}</div>
                <button
                  type="button"
                  className="jobs-pop-clear"
                  disabled={finished.length === 0}
                  onClick={clearFinishedJobs}
                >
                  {t('jobs.clearFinished')}
                </button>
              </div>
              <div className="jobs-list">
                {jobs.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
                {jobs.length === 0 && earlier.length > 0 && (
                  <div className="jobs-row-note jobs-empty">{t('jobs.nothingRunning')}</div>
                )}
                {earlier.length > 0 && (
                  <>
                    <div className="jobs-history-head">
                      <span>{t('jobs.historyTitle')}</span>
                      <button type="button" className="jobs-pop-clear" onClick={clearJobHistory}>
                        {t('jobs.clearHistory')}
                      </button>
                    </div>
                    {earlier.map((entry) => (
                      <HistoryRow key={entry.id} entry={entry} />
                    ))}
                  </>
                )}
              </div>
              <div className="jobs-notify-toggle">
                <label>
                  <input
                    type="checkbox"
                    checked={notifyOn}
                    onChange={(e) => setJobNotifyEnabled(e.target.checked)}
                  />
                  <span>{t('jobs.notifyToggle')}</span>
                </label>
                {/* Sends one now, whatever the focus: the only way to check the OS side without
                    starting a job and switching away — and it says why when it fails. */}
                <button
                  type="button"
                  className="jobs-pop-clear"
                  onClick={async () => {
                    const reason = await showNotification(t('jobs.panelTitle'), t('jobs.notifyTestBody'));
                    setNotifyTestError(reason);
                  }}
                >
                  {t('jobs.notifyTest')}
                </button>
              </div>
              {notifyTestError && <div className="jobs-row-error jobs-notify-error">{notifyTestError}</div>}
            </div>
          </>,
          document.body,
        )}

      {askOnClose && (
        <Modal title={t('jobs.closeTitle')} onClose={() => setAskOnClose(false)} zIndex={100001} width="440px">
          <ModalBody>
            <div style={{ fontSize: '12px', lineHeight: 1.5 }}>
              {t('jobs.closeMessage', { n: activeJobs().length })}
            </div>
          </ModalBody>
          <ModalFooter>
            <button type="button" className="btn btn-secondary" onClick={() => setAskOnClose(false)}>
              {t('jobs.keepOpen')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setAskOnClose(false);
                // Closed directly: going through `close()` again would ask the very question just answered.
                forceClose();
              }}
            >
              {t('jobs.closeAnyway')}
            </button>
          </ModalFooter>
        </Modal>
      )}
    </>
  );
};

const STATE_KEY: Record<JobRecord['state'], string> = {
  queued: 'jobs.stateQueued',
  running: 'jobs.stateRunning',
  done: 'jobs.stateDone',
  error: 'jobs.stateError',
  cancelled: 'jobs.stateCancelled',
};

/**
 * One job from an earlier session (or cleared from this one). Read-only: there is nothing left to
 * cancel, only to read — when it ended, how, and where its file went.
 */
const HistoryRow: React.FC<{ entry: JobHistoryEntry }> = ({ entry }) => {
  const { t, i18n } = useTranslation();
  const icon = entry.state === 'done' ? (
    <CheckCircle2 size={13} className="jobs-icon-ok" />
  ) : entry.state === 'error' ? (
    <AlertTriangle size={13} className="jobs-icon-error" />
  ) : (
    <Ban size={13} className="jobs-icon-muted" />
  );
  const endedAt = new Date(entry.endedAt).toLocaleString(i18n.language);
  const took = entry.startedAt !== null ? formatTook(entry.endedAt - entry.startedAt, t) : '';

  return (
    <div className="jobs-row jobs-row-history">
      <div className="jobs-row-icon">{icon}</div>
      <div className="jobs-row-body">
        <div className="jobs-row-head">
          <span className="jobs-row-title">{entry.title}</span>
          <span className="jobs-row-state">{t(STATE_KEY[entry.state] as 'jobs.stateDone')}</span>
        </div>
        <div className="jobs-row-note">{took ? t('jobs.historyWhenTook', { when: endedAt, took }) : endedAt}</div>
        {entry.error && <div className="jobs-row-error">{entry.error}</div>}
        {entry.message && (
          <div className="jobs-row-result">
            {entry.message}
            {entry.warning && <div className="jobs-row-warn">{entry.warning}</div>}
          </div>
        )}
      </div>
      <div className="jobs-row-actions">
        {entry.dir && (
          <button
            type="button"
            className="btn btn-secondary"
            title={entry.path || entry.dir}
            onClick={() => void openInFileManager(entry.dir!)}
          >
            <FolderOpen size={12} />
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary"
          title={t('jobs.removeHistoryEntry')}
          aria-label={t('jobs.removeHistoryEntry')}
          onClick={() => removeJobHistoryEntry(entry.id)}
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
};

/** "42 s" / "3 min 5 s" / "1 h 20 min" — how long a finished job ran. */
function formatTook(ms: number, t: TFunction): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t('jobs.tookSeconds', { s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('jobs.tookMinutes', { m, s: s % 60 });
  return t('jobs.tookHours', { h: Math.floor(m / 60), m: m % 60 });
}

const JobRow: React.FC<{ job: JobRecord }> = ({ job }) => {
  const { t } = useTranslation();
  const running = job.state === 'running';
  const queued = job.state === 'queued';

  // The status label is a literal key looked up in the table above, never a concatenated one — `t()` is
  // type-checked against `en.ts`'s key tree.
  const stateLabel = t(STATE_KEY[job.state] as 'jobs.stateQueued');

  const icon = running ? (
    <Loader2 size={13} className="loading-spinner" />
  ) : job.state === 'done' ? (
    <CheckCircle2 size={13} className="jobs-icon-ok" />
  ) : job.state === 'error' ? (
    <AlertTriangle size={13} className="jobs-icon-error" />
  ) : job.state === 'cancelled' ? (
    <Ban size={13} className="jobs-icon-muted" />
  ) : (
    <Bell size={13} className="jobs-icon-muted" />
  );

  return (
    <div className="jobs-row">
      <div className="jobs-row-icon">{icon}</div>
      <div className="jobs-row-body">
        <div className="jobs-row-head">
          <span className="jobs-row-title">{job.title}</span>
          <span className="jobs-row-state">
            {job.cancelRequested && running ? t('jobs.cancelling') : stateLabel}
          </span>
        </div>

        {/* Waiting because another job is writing to the same database — say so, rather than sitting silently at 0%. */}
        {queued && <div className="jobs-row-note">{t('jobs.waitingTurn')}</div>}

        {running && job.progress && (
          <ProgressBar progress={{ ...job.progress, label: job.progress.label || job.title }} />
        )}

        {job.error && <div className="jobs-row-error">{job.error}</div>}

        {job.result && (
          <div className="jobs-row-result">
            {job.result.message}
            {job.result.warning && <div className="jobs-row-warn">{job.result.warning}</div>}
          </div>
        )}
      </div>

      <div className="jobs-row-actions">
        {(running || queued) && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={job.cancelRequested}
            onClick={() => cancelJob(job.id)}
          >
            {t('jobs.cancel')}
          </button>
        )}
        {job.result?.dir && (
          <button
            type="button"
            className="btn btn-secondary"
            // Opens the DIRECTORY, not the file: `openInFileManager` calls `open_url`, so passing a file
            // path makes the OS open the .sql in its default application — not what anyone means by
            // "open folder". The file path goes into the tooltip.
            title={job.result.path || job.result.dir}
            onClick={() => void openInFileManager(job.result!.dir!)}
          >
            <FolderOpen size={12} />
          </button>
        )}
      </div>
    </div>
  );
};
