// Opening a connection from a saved profile — the SHARED path.
//
// It exists because the Quick Switcher needs exactly what Connection Manager already does: read the
// profile, fetch the secrets from the OS store, merge them into the config, call `dbHelper.connect`.
// Rewriting that in the switcher would build a **second copy** of the connect path, and that path
// carries SSH, SSL, IAM and secret merging — two copies drift, and drift here shows up as "this
// profile connects on that screen but not on this one".
//
// Only "build a config from a profile" lives here. Building a config from the **form's state** is
// still Connection Manager's and needs no sharing: a saved profile *already has* a config, it merely
// lacks the secrets.

import { dbHelper } from './dbHelper';
import { SECRET_FIELDS, mergeSecrets } from './secretFields';
import { refreshVaultStatus } from './vault';
import i18n from '../i18n';
import type { SavedProfile } from '../components/ConnectionManager';
import type { DbConnectionConfig } from './dbHelper';

const PROFILES_KEY = 'tf_connection_profiles';
const SECRET_FIELD_LIST: string[] = [...SECRET_FIELDS];

/**
 * The saved profiles, read straight from localStorage.
 *
 * Not through Connection Manager's state: that component only mounts on the connection screen, while
 * the switcher opens from the title bar once the workspace is up. What is in localStorage is the
 * secret-stripped version (`persistProfiles`), so a config here always lacks its password — which is
 * the intent; see `configWithSecrets`.
 */
export function loadSavedProfiles(): SavedProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * A profile's config with its secrets read back from the OS secret store.
 *
 * A failure to read the store does **not** break the connect: it returns the bare config plus a
 * `warning`, so the caller still tries (a profile without a password is perfectly valid — SQLite, or a
 * server that trusts the socket) and shows the driver's real error if there is one, rather than
 * blocking on a keychain error.
 */
export async function configWithSecrets(
  profile: SavedProfile,
): Promise<{ config: DbConnectionConfig; warning?: string }> {
  try {
    const secrets = await dbHelper.getSecrets(profile.id, SECRET_FIELD_LIST);
    return { config: mergeSecrets(profile.config, secrets) as DbConnectionConfig };
  } catch (e: any) {
    // One reason the store can refuse is a master password that locked itself while the app was
    // idle. ASK the backend rather than reading the message — the text is translated at the
    // `dbHelper` boundary, so matching it would break on the first language switch — and a locked
    // answer puts the lock screen back up on its own.
    void refreshVaultStatus();
    return {
      config: profile.config as DbConnectionConfig,
      warning: i18n.t('connection.errReadSecrets', { message: e?.message || String(e) }),
    };
  }
}

/**
 * Opens a connection from a saved profile. Returns exactly what `App.handleConnect` needs.
 *
 * The `config` is returned rather than kept here: App has to store it in `openConns` to key the tabs
 * (`scopeKey`) and for the Terminal to inherit — but it carries credentials, so nothing on this path
 * ever writes it to disk (only `persistProfiles` writes a profile, and it strips the secrets first).
 */
export async function connectSavedProfile(profile: SavedProfile): Promise<{
  success: boolean;
  message?: string;
  database?: string;
  schema?: string | null;
  config?: DbConnectionConfig;
}> {
  const { config, warning } = await configWithSecrets(profile);
  const res = await dbHelper.connect(config);
  if (!res.success) {
    // A keychain error, when there is one, travels with the connection error: alone it says nothing,
    // but when a connect fails it usually IS the cause, and hiding it leaves the user guessing.
    return { success: false, message: warning ? `${res.message}\n\n${warning}` : res.message };
  }
  return { success: true, database: res.database, schema: res.schema, config };
}
