// An OS notification when a background job finishes while the user is looking elsewhere.
//
// The tray already says when a job is done — but only to someone looking at the title bar. A 20-
// minute restore is exactly what people start and then switch to another window for, and "it
// finished (or failed) ten minutes ago" is the thing they had no way to learn without coming back to
// check. So: notify only when the window is NOT focused; when it is, the tray is enough and a toast
// on top would be noise.
//
// What to show is decided in pure functions (`shouldNotifyJob`, `jobNotification`), so the rules are
// tested without a webview. The backend side is `notify_os` in `app/notify.rs`, called directly the
// way `fileSave.ts` calls its commands.

import { invoke } from '@tauri-apps/api/core';
import type { TFunction } from 'i18next';
import type { JobRecord } from './jobs';

const PREF_KEY = 'tf_job_notify';
export const JOB_NOTIFY_CHANGED_EVENT = 'job-notify-changed';

/** On unless turned off: the point is to reach someone who is not watching, so it cannot be opt-in. */
export function getJobNotifyEnabled(): boolean {
  try {
    return typeof localStorage === 'undefined' || localStorage.getItem(PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setJobNotifyEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, 'off');
  } catch {
    /* blocked storage: the setting just does not persist */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(JOB_NOTIFY_CHANGED_EVENT));
}

/** The window is minimised, hidden behind another app, or simply not the one with focus. */
export function appIsInBackground(): boolean {
  if (typeof document === 'undefined') return false;
  return document.hidden || !document.hasFocus();
}

/**
 * Whether a job that just settled deserves a notification.
 *
 * Done and failed do; cancelled does not — the user pressed Cancel, so they already know. A job
 * cancelled while still queued never ran (`startedAt` is null) and is not news either.
 */
export function shouldNotifyJob(
  rec: Pick<JobRecord, 'state' | 'startedAt'>,
  opts: { enabled: boolean; background: boolean },
): boolean {
  if (!opts.enabled || !opts.background) return false;
  if (rec.startedAt === null) return false;
  return rec.state === 'done' || rec.state === 'error';
}

/** Longest body a toast gets. Windows cuts at a few lines anyway; a driver error can be a whole statement. */
export const NOTIFY_BODY_MAX = 240;

/**
 * Title and body for a settled job. The job's title is already translated (see `jobs.ts`); `t`
 * words the outcome. A warning is mentioned rather than pasted, because a restore's warning is a
 * list of failed statements that would not fit in a toast and belongs in the tray.
 */
export function jobNotification(
  rec: Pick<JobRecord, 'title' | 'state' | 'result' | 'error'>,
  t: TFunction,
): { title: string; body: string } {
  const clip = (s: string) => (s.length > NOTIFY_BODY_MAX ? `${s.slice(0, NOTIFY_BODY_MAX)}…` : s);
  if (rec.state === 'error') {
    return { title: rec.title, body: clip(t('jobs.notifyFailed', { message: rec.error || '' })) };
  }
  const message = rec.result?.message || t('jobs.stateDone');
  const body = rec.result?.warning ? `${message}\n${t('jobs.notifyHasWarning')}` : message;
  return { title: rec.title, body: clip(body) };
}

/**
 * Shows it, through `notify_os` (`app/notify.rs` — why not the notification plugin is explained
 * there). Never throws: a notification the OS refuses must not turn a finished job into an error.
 * Resolves to the reason when it failed, `null` when the OS accepted it; the reason is also logged,
 * since a notification that silently never appears is exactly how the plugin this replaced failed.
 */
export async function showNotification(title: string, body: string): Promise<string | null> {
  try {
    await invoke('notify_os', { title, body });
    return null;
  } catch (err) {
    const reason = String(err);
    console.warn('[job-notify] notification failed:', reason);
    return reason;
  }
}
