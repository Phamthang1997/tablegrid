// The master password, as the frontend sees it: three booleans and an idle timer.
//
// The store lives OUTSIDE React, the same shape as `queryHistory.ts`, `safeMode.ts` and `jobs.ts`,
// and for the same reason those do: the lock state is asked about by components that are not each
// other's ancestors (the lock overlay at the root, the settings dialog inside Connection Manager,
// the error path inside `persistProfiles`), and threading it through props would mean lifting it
// into `App` where every change re-renders every tab.
//
// **No key, no password and no secret ever passes through here.** The backend answers with
// `{ enabled, unlocked, remembered }` and nothing else; this module's whole job is to remember the
// latest answer and to ask again after anything that could have changed it.

import { dbHelper, type VaultStatus } from './dbHelper';

/** Minutes of inactivity before the vault locks itself. `0` = never. */
const AUTO_LOCK_KEY = 'tf_vault_autolock_minutes';

/** How often the idle watcher wakes up. Coarse on purpose — this is a timeout, not a stopwatch. */
const IDLE_TICK_MS = 15_000;

const UNKNOWN: VaultStatus = { enabled: false, unlocked: false, remembered: false };

let current: VaultStatus = UNKNOWN;
const listeners = new Set<() => void>();

function emit(next: VaultStatus): VaultStatus {
  // A NEW object every time: `useSyncExternalStore` compares by reference, so mutating `current` in
  // place would leave every subscriber showing the previous state.
  current = next;
  for (const fn of listeners) fn();
  return next;
}

export function subscribeVault(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function vaultSnapshot(): VaultStatus {
  return current;
}

/**
 * The one state that hides the app: the vault exists but is shut.
 *
 * Derived rather than stored, so "enabled" and "locked" can never drift apart — and asked of the
 * BACKEND's answer rather than of an error message, because backend errors are translated at the
 * `dbHelper` boundary and matching their text would break on the first language switch.
 */
export function isVaultLocked(status: VaultStatus = current): boolean {
  return status.enabled && !status.unlocked;
}

/** Re-asks the backend. Every vault call below already does this with the answer it gets back. */
export async function refreshVaultStatus(): Promise<VaultStatus> {
  try {
    return emit(await dbHelper.vaultStatus());
  } catch {
    // A backend that cannot answer must not lock the user out of an app whose vault may not even
    // exist. Staying on the last known answer is the safe failure here: the secret calls themselves
    // still refuse while locked, so nothing is exposed by not showing the overlay.
    return current;
  }
}

export async function unlockVault(password: string, remember: boolean): Promise<VaultStatus> {
  return emit(await dbHelper.vaultUnlock(password, remember));
}

export async function lockVault(): Promise<VaultStatus> {
  return emit(await dbHelper.vaultLock());
}

export async function enableVault(
  password: string,
  remember: boolean,
  profileIds: string[],
  fields: string[],
): Promise<VaultStatus> {
  return emit(await dbHelper.vaultEnable(password, remember, profileIds, fields));
}

export async function disableVault(password: string): Promise<VaultStatus> {
  const next = emit(await dbHelper.vaultDisable(password));
  setAutoLockMinutes(0);
  return next;
}

export async function changeVaultPassword(
  oldPassword: string,
  newPassword: string,
): Promise<VaultStatus> {
  return emit(await dbHelper.vaultChangePassword(oldPassword, newPassword));
}

export async function setVaultRemember(remember: boolean): Promise<VaultStatus> {
  return emit(await dbHelper.vaultSetRemember(remember));
}

export async function resetVault(): Promise<VaultStatus> {
  const next = emit(await dbHelper.vaultReset());
  setAutoLockMinutes(0);
  return next;
}

// ---------------------------------------------------------------------------------------------
// Auto-lock
// ---------------------------------------------------------------------------------------------

/**
 * Minutes of idle time before locking, or 0 for never.
 *
 * Works alongside "remember on this device" because the backend records a `relock` flag when the
 * vault is locked on purpose, so a restart does not undo an idle lock (`credentials/vault.rs`).
 * Before that flag existed this setting had to be refused whenever the key was remembered — the
 * lock was real until someone quit and reopened the app.
 */
export function getAutoLockMinutes(): number {
  const raw = Number(localStorage.getItem(AUTO_LOCK_KEY));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export function setAutoLockMinutes(minutes: number): void {
  try {
    if (minutes > 0) localStorage.setItem(AUTO_LOCK_KEY, String(Math.floor(minutes)));
    else localStorage.removeItem(AUTO_LOCK_KEY);
  } catch {
    /* a full or blocked localStorage costs the setting, not the app */
  }
}

let lastActivity = Date.now();
let idleTimer: ReturnType<typeof setInterval> | null = null;

function markActive() {
  lastActivity = Date.now();
}

/**
 * Starts watching for idleness. Idempotent, and returns a stopper.
 *
 * Locking here **does not touch the open database connections**: dropping them would discard a
 * manual transaction's uncommitted work (`tx/`) and kill whatever `jobs.ts` is running in the
 * background, which is losing the user's data in the name of protecting it. What the lock protects
 * is the credentials — the overlay covers the window and the vault stops answering.
 */
export function startVaultIdleWatch(): () => void {
  if (idleTimer) return () => {};

  const events = ['pointerdown', 'keydown', 'wheel', 'focus'] as const;
  // Capturing, so activity inside a dialog or the Monaco editor still counts — neither bubbles a
  // pointer event all the way to `window` in every case.
  for (const name of events) window.addEventListener(name, markActive, true);

  idleTimer = setInterval(() => {
    const minutes = getAutoLockMinutes();
    if (minutes <= 0) return;
    const status = vaultSnapshot();
    if (!status.enabled || !status.unlocked) return;
    if (Date.now() - lastActivity < minutes * 60_000) return;
    void lockVault();
  }, IDLE_TICK_MS);

  return () => {
    for (const name of events) window.removeEventListener(name, markActive, true);
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
  };
}
