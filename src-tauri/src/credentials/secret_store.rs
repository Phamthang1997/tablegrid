// The secret store for connection profiles: DB passwords, SSH password/passphrase/private key,
// AWS secret key... kept out of localStorage.
//
// Why: the webview's localStorage sits on disk as ordinary files (Windows:
// EBWebView\Default\Local Storage\leveldb) and is NOT encrypted — any process running as the
// same user can read both DB passwords and SSH private keys. CodeQL is right to flag
// js/clear-text-storage-of-sensitive-data.
//
// The frontend only stores the non-sensitive part of the config; each secret is its own entry,
// identified by "<profile_id>:<field_name>".
//
// # Two backing stores, one API
//
// This file is the single funnel every secret read and write passes through, which is what lets the
// master password be a swap underneath rather than a change that reaches the frontend:
//
//   - **No master password** (the default): the OS credential store — Windows Credential Manager,
//     macOS Keychain, Secret Service. Readable by anything running as this user.
//   - **Master password on**: `vault.rs`, an encrypted file whose key exists only in memory.
//
// `is_internal()` is the one exception, and it is load-bearing. The app's OWN keys — the MCP bearer
// token and audit-log key (`__mcp__`), the vault's device key (`__vault__`) — always stay on the
// keyring. Two reasons: `audit_file::init` reads its key during `app/setup.rs`, i.e. long before
// anyone could have typed a master password, and the vault's device key cannot live inside the vault
// it unlocks. These are not user credentials; they are app-internal material.

use keyring::Entry;
use serde::{Deserialize, Serialize};

use super::vault;

// The service name shown in Windows Credential Manager / Keychain.
const SERVICE: &str = "TableGrid";

#[derive(Debug, Serialize, Deserialize)]
pub struct SecretRef {
    /// Connection profile id (the key in localStorage).
    pub profile_id: String,
    /// Name of the secret field, e.g. "password", "sshPassphrase".
    pub field: String,
}

impl SecretRef {
    // The account key in the store: profile + field combined so each secret is its own entry.
    // Separate entries rather than one bundled JSON so a long private key cannot hit Windows
    // Credential Manager's size limit (2560 bytes per entry).
    fn account(&self) -> String {
        format!("{}:{}", self.profile_id, self.field)
    }

    fn entry(&self) -> Result<Entry, String> {
        Entry::new(SERVICE, &self.account())
            .map_err(|e| format!("Không mở được kho bí mật của hệ điều hành: {}", e))
    }
}

/// App-internal material, never routed into the vault. See the module comment.
fn is_internal(profile_id: &str) -> bool {
    profile_id.starts_with("__")
}

/// Which store answers for this profile.
fn use_vault(profile_id: &str) -> bool {
    !is_internal(profile_id) && vault::is_enabled()
}

/// Write one secret. An empty value means delete.
#[tauri::command]
pub fn secret_set(profile_id: String, field: String, value: String) -> Result<(), String> {
    if value.is_empty() {
        return secret_delete(profile_id, field);
    }
    if use_vault(&profile_id) {
        return vault::set(&profile_id, &field, &value);
    }
    keyring_set(&profile_id, &field, &value)
}

/// Read one secret. Returns None when nothing was ever stored.
#[tauri::command]
pub fn secret_get(profile_id: String, field: String) -> Result<Option<String>, String> {
    if use_vault(&profile_id) {
        return vault::get(&profile_id, &field);
    }
    keyring_get(&profile_id, &field)
}

/// Delete one secret. Not being there counts as success.
#[tauri::command]
pub fn secret_delete(profile_id: String, field: String) -> Result<(), String> {
    if use_vault(&profile_id) {
        return vault::delete(&profile_id, &field);
    }
    keyring_delete(&profile_id, &field)
}

/// Read several secrets of one profile in a single call (used when loading the form / when connecting).
/// A field that does not exist simply does not appear in the returned map.
///
/// A locked vault fails here rather than answering with an empty map: "no secrets stored" and
/// "cannot see the secrets right now" are different things, and returning the first for the second
/// makes a connection attempt fail with a wrong-password error from the database instead of a lock
/// screen from the app.
#[tauri::command]
pub fn secret_get_many(
    profile_id: String,
    fields: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    if use_vault(&profile_id) && vault::is_locked() {
        return Err(vault::locked_error());
    }
    let mut out = std::collections::HashMap::new();
    for field in fields {
        if let Some(v) = secret_get(profile_id.clone(), field.clone())? {
            out.insert(field, v);
        }
    }
    Ok(out)
}

/// Write several secrets of one profile in a single call (used when saving a profile / migrating).
#[tauri::command]
pub fn secret_set_many(
    profile_id: String,
    values: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    if use_vault(&profile_id) && vault::is_locked() {
        return Err(vault::locked_error());
    }
    for (field, value) in values {
        secret_set(profile_id.clone(), field, value)?;
    }
    Ok(())
}

/// Delete every secret of one profile (when that profile is deleted).
#[tauri::command]
pub fn secret_delete_many(profile_id: String, fields: Vec<String>) -> Result<(), String> {
    if use_vault(&profile_id) && vault::is_locked() {
        return Err(vault::locked_error());
    }
    for field in fields {
        secret_delete(profile_id.clone(), field)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The OS keyring, reachable directly.
//
// `vault.rs` calls these to migrate secrets in and out, and must not go through the routing above —
// which would send it straight back into the vault it is migrating away from.
// ---------------------------------------------------------------------------------------------

pub fn keyring_set(profile_id: &str, field: &str, value: &str) -> Result<(), String> {
    let r = SecretRef {
        profile_id: profile_id.to_string(),
        field: field.to_string(),
    };
    r.entry()?.set_password(value).map_err(|e| {
        format!(
            "Không lưu được '{}' vào kho bí mật: {}. Bí mật quá dài (private key lớn) có thể vượt giới hạn của kho HĐH.",
            field, e
        )
    })
}

pub fn keyring_get(profile_id: &str, field: &str) -> Result<Option<String>, String> {
    let r = SecretRef {
        profile_id: profile_id.to_string(),
        field: field.to_string(),
    };
    match r.entry()?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => {
            // Fallback to legacy service "TableNova" for smooth migration
            match Entry::new("TableNova", &r.account()) {
                Ok(legacy) => match legacy.get_password() {
                    Ok(v) => Ok(Some(v)),
                    _ => Ok(None),
                },
                _ => Ok(None),
            }
        }
        Err(e) => Err(format!("Không đọc được '{}' từ kho bí mật: {}", field, e)),
    }
}

pub fn keyring_delete(profile_id: &str, field: &str) -> Result<(), String> {
    let r = SecretRef {
        profile_id: profile_id.to_string(),
        field: field.to_string(),
    };
    match r.entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Không xoá được '{}' khỏi kho bí mật: {}", field, e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rule the MCP audit key and the vault's own device key depend on. Getting this wrong
    /// deadlocks the design: the key that opens the vault would be stored inside it.
    #[test]
    fn app_internal_names_are_recognised() {
        assert!(is_internal("__mcp__"));
        assert!(is_internal("__vault__"));
        assert!(!is_internal("profile_2f9c1e8a-0b1d-4c3e-9a77-2b6f0d5e1234"));
    }

    /// With no vault file, everything goes to the keyring — including a normal profile.
    #[test]
    fn without_a_vault_every_profile_uses_the_keyring() {
        assert!(!vault::is_enabled());
        assert!(!use_vault("profile_1"));
        assert!(!use_vault("__mcp__"));
    }
}
