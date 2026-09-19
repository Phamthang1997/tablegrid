//! Master Password: an encrypted vault that replaces the OS keyring as the home of a connection
//! profile's secrets.
//!
//! # Why, when the OS keyring already exists
//!
//! `secret_store.rs` keeps DB passwords and SSH private keys out of localStorage, which was the
//! real hole. What it does not do is keep them from the machine: a Windows Credential Manager entry
//! is readable by **anything running as this user**, no prompt, no trace. That is the boundary of
//! what an OS keyring can offer, and for a shared machine — or for a laptop whose disk image ends
//! up somewhere it should not — it is not enough.
//!
//! A master password buys exactly one thing, and it is worth being precise about it: the secrets
//! are now sealed under a key that exists **nowhere on disk**, so possession of the files is not
//! possession of the credentials.
//!
//! # What it does NOT buy
//!
//! Stated here rather than implied, the same way `mcp/audit_file.rs` states its own limits:
//!
//! - Once unlocked, the derived key sits in this process's memory. Anything that can read this
//!   process — a debugger running as the same user — can take it. A local app cannot hide a key
//!   from its own user; what it can do is not leave that key lying on disk.
//! - With "remember on this device" on, the derived key is parked in the OS keyring, and on THAT
//!   machine the protection is back to exactly what the keyring gives. The vault file carried
//!   anywhere else is still useless without the password. That trade is the user's to make, and the
//!   settings screen says so.
//! - Only the six `SECRET_FIELDS` are in here. Host, port, user and database still live in
//!   localStorage in the clear; the vault hides the credentials, not the topology.
//! - Forgetting the password loses the secrets. There is no recovery path, by construction — one
//!   that worked would be a second way in.
//!
//! # Shape on disk
//!
//! One JSON file, `vault.json`, in the app data dir:
//!
//! ```text
//! { version, kdf, salt, mCost, tCost, pCost, check, relock, entries: { "<profile>:<field>": … } }
//! ```
//!
//! `check` is a known constant sealed under the same key: it is what makes "wrong password"
//! distinguishable from "file corrupt", which otherwise both surface as one AEAD failure and read
//! to the user as "your password is wrong" when it is not.
//!
//! Every value is `base64(nonce ‖ ciphertext ‖ tag)`, and the **AAD of an entry is its own account
//! key** — so a sealed blob moved from one profile or field to another no longer opens. Without
//! that, swapping two entries in the file is undetectable and a profile silently connects with a
//! different password than it is showing.
//!
//! The whole file is rewritten on every change, unlike the append-only audit log: it holds a
//! handful of entries, and rewriting is what lets a delete actually remove bytes.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use aes_gcm::aead::{Aead, Generate, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::secret_store::{keyring_delete, keyring_get, keyring_set};

const FILE_NAME: &str = "vault.json";
const TMP_NAME: &str = "vault.json.tmp";

/// Argon2id cost. 64 MiB × 3 passes is the OWASP-ish middle ground: ~0.2s on a desktop, which is
/// unnoticeable once per launch and expensive enough that guessing at scale is not free. It is
/// written INTO the file rather than assumed, so raising it later still opens an old vault.
const M_COST: u32 = 64 * 1024;
const T_COST: u32 = 3;
const P_COST: u32 = 1;

/// Sealed under the vault key and checked before anything else, so a wrong password is reported as
/// a wrong password.
const CHECK_PLAINTEXT: &[u8] = b"tablegrid-vault-v1";
const CHECK_AAD: &[u8] = b"check";

/// Where the device key lives when "remember on this device" is on. `__vault__` is a non-profile
/// name, so `secret_store`'s `is_internal()` keeps it on the keyring and it can never be routed
/// into the very vault it unlocks.
const DEVICE_PROFILE: &str = "__vault__";
const DEVICE_FIELD: &str = "device-key";

const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;

/// The app data dir, parked by `app/setup.rs` — the only place allowed to ask Tauri for a path.
static DIR: OnceLock<PathBuf> = OnceLock::new();

/// The derived key while the vault is open. `None` is the locked state, and locking overwrites the
/// bytes rather than merely dropping the handle.
static KEY: Mutex<Option<Zeroizing<[u8; KEY_LEN]>>> = Mutex::new(None);

/// Whether a vault file exists. Cached because `secret_get` asks on every single read and this
/// module is the only thing that ever creates or removes the file.
static ENABLED: AtomicBool = AtomicBool::new(false);

/// The file, as it sits on disk. Field names are camelCase so the JSON reads the way the rest of
/// the app's payloads do.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultFile {
    version: u32,
    kdf: String,
    salt: String,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    check: String,
    /// Set when the vault was locked on purpose — by the idle timer or by "Lock now" — and cleared
    /// by the next unlock that went through the password.
    ///
    /// This is what lets "remember on this device" and "lock after idle" coexist. Without it, the
    /// device key in the OS keyring made every lock walk-around-able by restarting the app, and the
    /// only honest response was to refuse the idle setting whenever the key was remembered. With
    /// it, `remember` means "do not ask at startup" and a deliberate lock still means "ask", which
    /// is what both settings say they do.
    ///
    /// `#[serde(default)]` because a vault written before this field existed must still open.
    #[serde(default)]
    relock: bool,
    entries: BTreeMap<String, String>,
}

/// What the UI needs to decide which screen to show.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    /// A vault file exists, i.e. the master password is turned on.
    pub enabled: bool,
    /// The key is in memory, i.e. secrets are readable right now.
    pub unlocked: bool,
    /// The derived key is parked in the OS keyring, so launching does not ask.
    pub remembered: bool,
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

/// Learn where the file lives and, when the device key is present, open the vault before the first
/// frame so a "remember on this device" user never sees the lock screen.
///
/// A failure here is deliberately silent: it leaves the vault locked, which the UI already knows
/// how to show. The app must not fail to start because a vault file could not be read.
pub fn init(dir: PathBuf) {
    let _ = DIR.set(dir);
    ENABLED.store(file_path().is_some_and(|p| p.exists()), Ordering::Relaxed);
    if !is_enabled() {
        return;
    }
    // Auto-unlock happens ONLY here, at startup, and only when the last lock was not a deliberate
    // one — `relock` is what carries that across a restart. Without the check, the idle lock would
    // be undone by quitting and reopening the app.
    if let Ok(Some(encoded)) = keyring_get(DEVICE_PROFILE, DEVICE_FIELD)
        && let Ok(bytes) = B64.decode(encoded.as_bytes())
        && let Ok(key) = <[u8; KEY_LEN]>::try_from(bytes.as_slice())
        && let Ok(file) = load()
        && !file.relock
        && verify(&file, &key).is_ok()
    {
        store_key(key);
    }
}

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

pub fn is_unlocked() -> bool {
    with_key(|k| k.is_some())
}

/// True when the vault is on but shut — the one state in which a secret read must fail loudly
/// rather than answer "nothing stored", which would read to the user as a lost password.
pub fn is_locked() -> bool {
    is_enabled() && !is_unlocked()
}

pub fn locked_error() -> String {
    "Kho bí mật đang khoá. Hãy mở khoá bằng mật khẩu chính.".to_string()
}

// ---------------------------------------------------------------------------------------------
// The secret API `secret_store` routes into
// ---------------------------------------------------------------------------------------------

pub fn get(profile_id: &str, field: &str) -> Result<Option<String>, String> {
    let account = account(profile_id, field);
    let file = load()?;
    let Some(sealed) = file.entries.get(&account) else {
        return Ok(None);
    };
    let plain = with_unlocked(|key| open(key, account.as_bytes(), sealed))?;
    String::from_utf8(plain)
        .map(Some)
        .map_err(|_| format!("Bí mật '{field}' trong kho không phải văn bản hợp lệ."))
}

pub fn set(profile_id: &str, field: &str, value: &str) -> Result<(), String> {
    let account = account(profile_id, field);
    let sealed = with_unlocked(|key| seal(key, account.as_bytes(), value.as_bytes()))?;
    let mut file = load()?;
    file.entries.insert(account, sealed);
    save(&file)
}

pub fn delete(profile_id: &str, field: &str) -> Result<(), String> {
    let mut file = load()?;
    if file.entries.remove(&account(profile_id, field)).is_none() {
        return Ok(());
    }
    save(&file)
}

fn account(profile_id: &str, field: &str) -> String {
    format!("{profile_id}:{field}")
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn vault_status() -> VaultStatus {
    VaultStatus {
        enabled: is_enabled(),
        unlocked: is_unlocked(),
        remembered: matches!(keyring_get(DEVICE_PROFILE, DEVICE_FIELD), Ok(Some(_))),
    }
}

/// Turn the master password on and move every existing secret into the vault.
///
/// `profile_ids` × `fields` is the list to migrate, and it comes from the frontend because only
/// localStorage knows which profiles exist — this module has never seen a profile id it was not
/// handed. A field that is not in the keyring is simply not there; nothing fails over it.
///
/// **The keyring copy is deleted after the move.** Leaving it would make the master password a
/// decoration: the old, unprotected copy would still answer.
#[tauri::command]
pub async fn vault_enable(
    password: String,
    remember: bool,
    profile_ids: Vec<String>,
    fields: Vec<String>,
) -> Result<VaultStatus, String> {
    Box::pin(async move {
        if is_enabled() {
            return Err("Mật khẩu chính đã được bật.".to_string());
        }
        if password.trim().is_empty() {
            return Err("Mật khẩu chính không được để trống.".to_string());
        }

        let salt = random_salt()?;
        let key = derive_off_thread(password, salt).await?;

        let mut file = VaultFile {
            version: 1,
            kdf: "argon2id".to_string(),
            salt: B64.encode(salt),
            m_cost: M_COST,
            t_cost: T_COST,
            p_cost: P_COST,
            check: seal(&key, CHECK_AAD, CHECK_PLAINTEXT)?,
            relock: false,
            entries: BTreeMap::new(),
        };

        // Read everything out of the keyring FIRST and only then delete: a failure half way leaves
        // the keyring intact, so the worst case is a vault that also holds a copy, never a secret
        // that exists in neither place.
        let mut moved: Vec<String> = Vec::new();
        for profile_id in &profile_ids {
            for field in &fields {
                if let Some(value) = keyring_get(profile_id, field)? {
                    let account = account(profile_id, field);
                    file.entries.insert(
                        account.clone(),
                        seal(&key, account.as_bytes(), value.as_bytes())?,
                    );
                    moved.push(account);
                }
            }
        }

        save_at(file_path().ok_or_else(no_dir)?, &file)?;
        ENABLED.store(true, Ordering::Relaxed);
        store_key(*key);

        for account in moved {
            if let Some((profile_id, field)) = account.split_once(':') {
                keyring_delete(profile_id, field)?;
            }
        }

        set_remember_inner(remember)?;
        Ok(vault_status())
    })
    .await
}

/// Open the vault for this run. A wrong password is told apart from a damaged file by `check`.
#[tauri::command]
pub async fn vault_unlock(password: String, remember: bool) -> Result<VaultStatus, String> {
    Box::pin(async move {
        let file = load()?;
        let salt = decode_salt(&file)?;
        let key =
            derive_off_thread_with(password, salt, file.m_cost, file.t_cost, file.p_cost).await?;
        verify(&file, &key)?;
        store_key(*key);
        // The password has now been given, so the deliberate lock is answered and a restart may
        // auto-unlock again. Cleared here and nowhere else: this is the only path that proves the
        // user knows the password.
        set_relock(false)?;
        set_remember_inner(remember)?;
        Ok(vault_status())
    })
    .await
}

/// Shut the vault: the key is overwritten in memory and every secret read fails until the password
/// is entered again.
///
/// Deliberately does **not** consult the device key afterwards: a lock the app could undo by
/// itself, one second later, would not be a lock. `relock` carries that same refusal across a
/// restart, which is what lets "remember on this device" and "lock after idle" both mean what they
/// say — remember skips the prompt at STARTUP, a deliberate lock still demands the password.
///
/// **Failing to write the flag falls back to deleting the device key.** Fail closed: the cost is
/// one extra prompt and re-ticking "remember", against a lock that silently does not hold.
#[tauri::command]
pub fn vault_lock() -> VaultStatus {
    clear_key();
    if set_relock(true).is_err() {
        let _ = keyring_delete(DEVICE_PROFILE, DEVICE_FIELD);
    }
    vault_status()
}

/// Writes the `relock` flag, skipping the file write when it already says that.
fn set_relock(value: bool) -> Result<(), String> {
    let mut file = load()?;
    if file.relock == value {
        return Ok(());
    }
    file.relock = value;
    save(&file)
}

/// Turn the master password off, putting every secret back into the OS keyring.
///
/// Needs the password even when the vault is already open: this downgrades the protection of every
/// stored credential, which is exactly the action someone at a borrowed unlocked machine would take.
#[tauri::command]
pub async fn vault_disable(password: String) -> Result<VaultStatus, String> {
    Box::pin(async move {
        let file = load()?;
        let salt = decode_salt(&file)?;
        let key =
            derive_off_thread_with(password, salt, file.m_cost, file.t_cost, file.p_cost).await?;
        verify(&file, &key)?;

        // Same order as `vault_enable`, for the same reason: write the destination before removing
        // the source, so an interruption duplicates a secret rather than losing it.
        for (account, sealed) in &file.entries {
            let Some((profile_id, field)) = account.split_once(':') else {
                continue;
            };
            let plain = open(&key, account.as_bytes(), sealed)?;
            let value = String::from_utf8(plain)
                .map_err(|_| format!("Bí mật '{field}' trong kho không phải văn bản hợp lệ."))?;
            keyring_set(profile_id, field, &value)?;
        }

        set_remember_inner(false)?;
        std::fs::remove_file(file_path().ok_or_else(no_dir)?)
            .map_err(|e| format!("Không xoá được tệp kho bí mật: {e}"))?;
        ENABLED.store(false, Ordering::Relaxed);
        clear_key();
        Ok(vault_status())
    })
    .await
}

/// Re-seal every entry under a key derived from the new password, with a fresh salt.
#[tauri::command]
pub async fn vault_change_password(
    old_password: String,
    new_password: String,
) -> Result<VaultStatus, String> {
    Box::pin(async move {
        if new_password.trim().is_empty() {
            return Err("Mật khẩu chính không được để trống.".to_string());
        }
        let file = load()?;
        let old_salt = decode_salt(&file)?;
        let old_key = derive_off_thread_with(
            old_password,
            old_salt,
            file.m_cost,
            file.t_cost,
            file.p_cost,
        )
        .await?;
        verify(&file, &old_key)?;

        let salt = random_salt()?;
        let new_key = derive_off_thread(new_password, salt).await?;

        let mut entries = BTreeMap::new();
        for (account, sealed) in &file.entries {
            let plain = open(&old_key, account.as_bytes(), sealed)?;
            entries.insert(account.clone(), seal(&new_key, account.as_bytes(), &plain)?);
        }

        let next = VaultFile {
            version: 1,
            kdf: "argon2id".to_string(),
            salt: B64.encode(salt),
            m_cost: M_COST,
            t_cost: T_COST,
            p_cost: P_COST,
            check: seal(&new_key, CHECK_AAD, CHECK_PLAINTEXT)?,
            relock: false,
            entries,
        };
        save(&next)?;
        store_key(*new_key);
        // The parked key is now wrong. Re-park the new one only if it was there before, so changing
        // the password never silently turns "remember" on.
        if matches!(keyring_get(DEVICE_PROFILE, DEVICE_FIELD), Ok(Some(_))) {
            set_remember_inner(true)?;
        }
        Ok(vault_status())
    })
    .await
}

/// Park the derived key on this machine, or remove it. Requires the vault to be open, because there
/// is no key to park otherwise.
#[tauri::command]
pub fn vault_set_remember(remember: bool) -> Result<VaultStatus, String> {
    set_remember_inner(remember)?;
    Ok(vault_status())
}

/// Throw the vault away, secrets and all — the answer to a forgotten password.
///
/// Profiles survive (they live in localStorage and hold no secrets); every password, passphrase and
/// private key in them does not, and has to be typed again. The confirmation for this belongs in
/// the UI, which is the only layer that can say it in the user's language.
#[tauri::command]
pub fn vault_reset() -> Result<VaultStatus, String> {
    let path = file_path().ok_or_else(no_dir)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Không xoá được tệp kho bí mật: {e}"))?;
    }
    let _ = keyring_delete(DEVICE_PROFILE, DEVICE_FIELD);
    ENABLED.store(false, Ordering::Relaxed);
    clear_key();
    Ok(vault_status())
}

// ---------------------------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------------------------

fn with_key<T>(f: impl FnOnce(&Option<Zeroizing<[u8; KEY_LEN]>>) -> T) -> T {
    let guard = match KEY.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    f(&guard)
}

/// Runs `f` with the open vault's key, or reports the vault as locked. Every secret path goes
/// through here, so there is exactly one place that can forget the check.
fn with_unlocked<T>(f: impl FnOnce(&[u8; KEY_LEN]) -> Result<T, String>) -> Result<T, String> {
    with_key(|slot| match slot {
        Some(key) => f(key),
        None => Err(locked_error()),
    })
}

fn store_key(key: [u8; KEY_LEN]) {
    let mut guard = match KEY.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    *guard = Some(Zeroizing::new(key));
}

fn clear_key() {
    let mut guard = match KEY.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    // `Zeroizing` wipes the bytes as it drops, which is the whole reason the key is wrapped in it.
    *guard = None;
}

fn set_remember_inner(remember: bool) -> Result<(), String> {
    if !remember {
        return keyring_delete(DEVICE_PROFILE, DEVICE_FIELD);
    }
    let encoded = with_unlocked(|key| Ok(B64.encode(key)))?;
    keyring_set(DEVICE_PROFILE, DEVICE_FIELD, &encoded)
}

/// Argon2id is memory-hard and therefore SLOW on purpose (~0.2s). A Tauri command that is not
/// `async` runs on the main thread, so deriving there would freeze the window; this hands it to the
/// blocking pool and keeps the UI painting.
async fn derive_off_thread(
    password: String,
    salt: [u8; SALT_LEN],
) -> Result<Zeroizing<[u8; KEY_LEN]>, String> {
    derive_off_thread_with(password, salt, M_COST, T_COST, P_COST).await
}

async fn derive_off_thread_with(
    password: String,
    salt: [u8; SALT_LEN],
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<Zeroizing<[u8; KEY_LEN]>, String> {
    tauri::async_runtime::spawn_blocking(move || derive(&password, &salt, m_cost, t_cost, p_cost))
        .await
        .map_err(|e| format!("Không dẫn xuất được khoá từ mật khẩu chính: {e}"))?
}

fn derive(
    password: &str,
    salt: &[u8; SALT_LEN],
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<Zeroizing<[u8; KEY_LEN]>, String> {
    let params = Params::new(m_cost, t_cost, p_cost, Some(KEY_LEN))
        .map_err(|e| format!("Tham số Argon2 không hợp lệ: {e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|e| format!("Không dẫn xuất được khoá từ mật khẩu chính: {e}"))?;
    Ok(out)
}

/// `check` opens ⇔ the password was right. Told apart from a damaged file so the message can be
/// the true one; both are AEAD failures and guessing between them is how "wrong password" ends up
/// on screen for a truncated file.
fn verify(file: &VaultFile, key: &[u8; KEY_LEN]) -> Result<(), String> {
    match open(key, CHECK_AAD, &file.check) {
        Ok(plain) if plain == CHECK_PLAINTEXT => Ok(()),
        Ok(_) => Err("Tệp kho bí mật đã hỏng.".to_string()),
        Err(_) => Err("Mật khẩu chính không đúng.".to_string()),
    }
}

// ---------------------------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------------------------

fn cipher(key: &[u8; KEY_LEN]) -> Result<Aes256Gcm, String> {
    Aes256Gcm::new_from_slice(key).map_err(|e| format!("Khoá kho bí mật không hợp lệ: {e}"))
}

fn seal(key: &[u8; KEY_LEN], aad: &[u8], plaintext: &[u8]) -> Result<String, String> {
    let nonce = Nonce::<aes_gcm::aead::consts::U12>::try_generate()
        .map_err(|e| format!("Không sinh được nonce cho kho bí mật: {e}"))?;
    let sealed = cipher(key)?
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|e| format!("Không mã hoá được bí mật: {e}"))?;

    let mut record = Vec::with_capacity(NONCE_LEN + sealed.len());
    record.extend_from_slice(&nonce);
    record.extend_from_slice(&sealed);
    Ok(B64.encode(&record))
}

fn open(key: &[u8; KEY_LEN], aad: &[u8], encoded: &str) -> Result<Vec<u8>, String> {
    let record = B64
        .decode(encoded.as_bytes())
        .map_err(|e| format!("Bản ghi trong kho bí mật không đọc được: {e}"))?;
    if record.len() <= NONCE_LEN {
        return Err("Bản ghi trong kho bí mật quá ngắn.".to_string());
    }
    let (nonce_bytes, sealed) = record.split_at(NONCE_LEN);
    let nonce = Nonce::<aes_gcm::aead::consts::U12>::try_from(nonce_bytes)
        .map_err(|_| "Nonce trong kho bí mật sai độ dài.".to_string())?;
    cipher(key)?
        .decrypt(&nonce, Payload { msg: sealed, aad })
        .map_err(|_| "Không giải mã được bí mật trong kho.".to_string())
}

/// 16 random bytes from the OS CSPRNG. Taken from `aes-gcm`'s own generator rather than adding
/// `getrandom` as a direct dependency: it is the same source, and a key's worth of entropy
/// truncated to a salt is still a salt — a salt only has to be unique, not secret.
fn random_salt() -> Result<[u8; SALT_LEN], String> {
    let key = Key::<Aes256Gcm>::try_generate()
        .map_err(|e| format!("Không sinh được muối cho kho bí mật: {e}"))?;
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&key[..SALT_LEN]);
    Ok(salt)
}

fn decode_salt(file: &VaultFile) -> Result<[u8; SALT_LEN], String> {
    let bytes = B64
        .decode(file.salt.as_bytes())
        .map_err(|e| format!("Muối trong kho bí mật không đọc được: {e}"))?;
    <[u8; SALT_LEN]>::try_from(bytes.as_slice())
        .map_err(|_| "Muối trong kho bí mật sai độ dài.".to_string())
}

// ---------------------------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------------------------

fn file_path() -> Option<PathBuf> {
    DIR.get().map(|dir| dir.join(FILE_NAME))
}

fn no_dir() -> String {
    "Chưa xác định được thư mục dữ liệu của ứng dụng.".to_string()
}

fn load() -> Result<VaultFile, String> {
    let path = file_path().ok_or_else(no_dir)?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Không đọc được tệp kho bí mật: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("Tệp kho bí mật đã hỏng: {e}"))
}

fn save(file: &VaultFile) -> Result<(), String> {
    save_at(file_path().ok_or_else(no_dir)?, file)
}

/// Write beside the real file and rename over it. A crash mid-write would otherwise leave a
/// truncated vault, i.e. every stored credential gone — and `rename` is the one filesystem
/// operation that replaces a file without ever exposing a half-written one.
fn save_at(path: PathBuf, file: &VaultFile) -> Result<(), String> {
    let text =
        serde_json::to_string(file).map_err(|e| format!("Không dựng được tệp kho bí mật: {e}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Không tạo được thư mục kho bí mật: {e}"))?;
    }
    let tmp = path.with_file_name(TMP_NAME);
    std::fs::write(&tmp, text).map_err(|e| format!("Không ghi được tệp kho bí mật: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Không ghi được tệp kho bí mật: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_from(byte: u8) -> [u8; KEY_LEN] {
        [byte; KEY_LEN]
    }

    #[test]
    fn a_sealed_value_opens_with_the_same_key_and_aad() {
        let key = key_from(7);
        let sealed = seal(&key, b"p1:password", b"hunter2").unwrap();
        assert_eq!(open(&key, b"p1:password", &sealed).unwrap(), b"hunter2");
    }

    #[test]
    fn a_sealed_value_does_not_open_under_another_key() {
        let sealed = seal(&key_from(7), b"p1:password", b"hunter2").unwrap();
        assert!(open(&key_from(8), b"p1:password", &sealed).is_err());
    }

    /// The property the AAD exists for: an entry moved to another profile or field stops opening,
    /// so swapping two blobs in the file cannot silently swap two passwords.
    #[test]
    fn a_sealed_value_does_not_open_under_another_account() {
        let key = key_from(7);
        let sealed = seal(&key, b"p1:password", b"hunter2").unwrap();
        assert!(open(&key, b"p2:password", &sealed).is_err());
        assert!(open(&key, b"p1:sshPassword", &sealed).is_err());
    }

    #[test]
    fn a_tampered_record_does_not_open() {
        let key = key_from(7);
        let sealed = seal(&key, b"p1:password", b"hunter2").unwrap();
        let mut bytes = B64.decode(sealed.as_bytes()).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        assert!(open(&key, b"p1:password", &B64.encode(&bytes)).is_err());
    }

    #[test]
    fn salts_differ_between_vaults() {
        assert_ne!(random_salt().unwrap(), random_salt().unwrap());
    }

    /// The same password and salt must always give the same key, or an existing vault stops opening
    /// after a restart.
    #[test]
    fn derivation_is_deterministic_and_password_dependent() {
        // The smallest legal cost, so the test is about the wiring rather than about waiting.
        let salt = [3u8; SALT_LEN];
        let a = derive("hunter2", &salt, Params::MIN_M_COST, 1, 1).unwrap();
        let b = derive("hunter2", &salt, Params::MIN_M_COST, 1, 1).unwrap();
        let c = derive("hunter3", &salt, Params::MIN_M_COST, 1, 1).unwrap();
        assert_eq!(a.as_ref(), b.as_ref());
        assert_ne!(a.as_ref(), c.as_ref());
    }

    #[test]
    fn a_different_salt_gives_a_different_key() {
        let a = derive("hunter2", &[1u8; SALT_LEN], Params::MIN_M_COST, 1, 1).unwrap();
        let b = derive("hunter2", &[2u8; SALT_LEN], Params::MIN_M_COST, 1, 1).unwrap();
        assert_ne!(a.as_ref(), b.as_ref());
    }

    /// A wrong password and a damaged file are two different messages, and the file is what tells
    /// them apart.
    #[test]
    fn verify_separates_a_wrong_password_from_a_damaged_file() {
        let key = key_from(7);
        let good = VaultFile {
            version: 1,
            kdf: "argon2id".to_string(),
            salt: B64.encode([0u8; SALT_LEN]),
            m_cost: M_COST,
            t_cost: T_COST,
            p_cost: P_COST,
            check: seal(&key, CHECK_AAD, CHECK_PLAINTEXT).unwrap(),
            relock: false,
            entries: BTreeMap::new(),
        };
        assert!(verify(&good, &key).is_ok());
        assert_eq!(
            verify(&good, &key_from(8)).unwrap_err(),
            "Mật khẩu chính không đúng."
        );

        let damaged = VaultFile {
            check: seal(&key, CHECK_AAD, b"something else").unwrap(),
            ..good
        };
        assert_eq!(
            verify(&damaged, &key).unwrap_err(),
            "Tệp kho bí mật đã hỏng."
        );
    }

    /// A vault written before `relock` existed must still open, and must not be treated as locked
    /// out — `#[serde(default)]` is what guarantees that, and it is one `false` away from locking
    /// every upgrading user's "remember on this device" out on the next restart.
    #[test]
    fn a_vault_file_without_relock_still_parses() {
        let json = r#"{
            "version": 1, "kdf": "argon2id", "salt": "AAAA",
            "mCost": 65536, "tCost": 3, "pCost": 1,
            "check": "AAAA", "entries": {}
        }"#;
        let file: VaultFile = serde_json::from_str(json).unwrap();
        assert!(!file.relock);
    }

    #[test]
    fn relock_round_trips_through_the_file() {
        let file = VaultFile {
            version: 1,
            kdf: "argon2id".to_string(),
            salt: B64.encode([0u8; SALT_LEN]),
            m_cost: M_COST,
            t_cost: T_COST,
            p_cost: P_COST,
            check: seal(&key_from(7), CHECK_AAD, CHECK_PLAINTEXT).unwrap(),
            relock: true,
            entries: BTreeMap::new(),
        };
        let text = serde_json::to_string(&file).unwrap();
        // camelCase on the wire, like every other payload the app writes.
        assert!(text.contains("\"relock\":true"));
        let back: VaultFile = serde_json::from_str(&text).unwrap();
        assert!(back.relock);
    }

    #[test]
    fn an_account_key_joins_profile_and_field() {
        assert_eq!(
            account("profile_1", "sshPassphrase"),
            "profile_1:sshPassphrase"
        );
    }
}
