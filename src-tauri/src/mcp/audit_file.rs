//! The audit log on disk, encrypted, so a record of what an AI client did outlives the app run.
//!
//! The in-memory log in `audit.rs` answers "what happened just now" and dies with the process. That
//! is the wrong lifetime for the only record of a third party writing to a live database: the
//! question "what did it change last Tuesday" is exactly the one asked after something goes wrong,
//! which is never during the same run.
//!
//! # Why encrypted, and what that does and does not buy
//!
//! The entries carry the SQL verbatim, and SQL carries data — an `INSERT` names the values, a
//! `WHERE` names the person. Plaintext on disk means that content is readable by every backup agent,
//! cloud-sync folder, desktop search indexer and support-bundle collector on the machine, none of
//! which knew it was handling database contents. Encryption is what keeps this file from quietly
//! turning the audit trail into a second copy of the data.
//!
//! It is honest about its threat model:
//!
//! - The key lives in the OS keyring under the same `__mcp__` name as the bearer token, so anything
//!   running **as this user** can decrypt the file. That is not a hole to fix, it is the boundary: a
//!   local app cannot hide a key from its own user. What it stops is the file travelling somewhere
//!   the keyring did not.
//! - Each line is bound to the one before it (the previous line's tag is the AAD), so removing,
//!   reordering or splicing lines makes every following line fail to decrypt. **Truncating the tail
//!   is still undetectable** — nothing here can prove a line that was deleted ever existed. Say so
//!   rather than implying the file is tamper-proof.
//! - Line count, file size and write timing are not hidden. Someone watching the file learns HOW
//!   MUCH happened, just not what.
//!
//! # Shape
//!
//! One line per entry, `base64(nonce ‖ ciphertext ‖ tag)`, appended. Per-line rather than one
//! encrypted blob because a log is append-only: re-encrypting the whole file on every request would
//! be quadratic, and a crash mid-rewrite would lose the entire history rather than one line.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::mpsc::{Sender, channel};

use aes_gcm::aead::{Aead, Generate, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;

use super::audit::Entry;
use crate::credentials::secret_store::{secret_get, secret_set};

/// Keyring coordinates. `__mcp__` is the same non-profile name `auth.rs` uses; the field differs, so
/// the token and this key are two secrets rather than one reused for two jobs.
const PROFILE: &str = "__mcp__";
const FIELD: &str = "audit-key";

const FILE_NAME: &str = "mcp-audit.log";
/// The previous file, kept through exactly one rotation.
const ROLLED_NAME: &str = "mcp-audit.1.log";

/// Rotate past this size. Entries are capped at ~2KB of SQL, so this is on the order of a thousand
/// requests — enough to answer "what happened last week" without the file becoming a thing that has
/// to be managed.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// The writer thread's inbox. `None` until `init` runs, which is also what makes this a no-op in
/// `cargo test --lib` and in the `--mcp-stdio` proxy: neither calls `init`, and neither should write
/// to the user's log.
static TX: OnceLock<Sender<String>> = OnceLock::new();
/// Where the file lives, for the read command.
static DIR: OnceLock<PathBuf> = OnceLock::new();

/// Start the writer. Called once from `app/setup.rs`, the only place allowed to know a Tauri path.
///
/// Failing to start is deliberately quiet in the app's face: a missing audit FILE must not stop the
/// app or the MCP server, and the in-memory log still works. It is reported through `last_error` so
/// the settings screen can say the file is not being written instead of showing an empty list that
/// looks like "nothing happened".
pub fn init(dir: PathBuf) {
    if TX.get().is_some() {
        return;
    }
    let _ = DIR.set(dir.clone());

    let key = match load_or_create_key() {
        Ok(k) => k,
        Err(e) => return set_error(format!("Không lấy được khoá mã hoá nhật ký MCP: {e}")),
    };
    let cipher = match Aes256Gcm::new_from_slice(&key) {
        Ok(c) => c,
        Err(e) => return set_error(format!("Khoá mã hoá nhật ký MCP không hợp lệ: {e}")),
    };

    let (tx, rx) = channel::<String>();
    if TX.set(tx).is_err() {
        return;
    }

    // A dedicated thread, not `spawn_blocking` per entry: the chain binds each line to the previous
    // one, so the ORDER of writes is part of the format. Tasks on a pool have no order.
    std::thread::spawn(move || {
        let path = dir.join(FILE_NAME);
        // Recovered from the file rather than started at zero, or the first line written after a
        // restart would fail to verify against the last line of the previous run.
        let mut prev_tag = last_tag(&path).unwrap_or([0u8; TAG_LEN]);
        while let Ok(line) = rx.recv() {
            match write_line(&path, &cipher, &line, &prev_tag) {
                Ok(tag) => prev_tag = tag,
                Err(e) => set_error(e),
            }
            if rotate_if_needed(&path) {
                prev_tag = [0u8; TAG_LEN];
            }
        }
    });
}

/// Record one entry. Cheap and non-blocking: serialise, hand to the writer thread, return.
///
/// Dropping the entry when the channel is full or gone is the right failure: an audit log that can
/// stall the request it is recording would turn a disk problem into a hung AI client.
pub fn append(entry: &Entry) {
    let Some(tx) = TX.get() else { return };
    if let Ok(line) = serde_json::to_string(entry) {
        let _ = tx.send(line);
    }
}

/// Every entry the file holds, oldest first, plus what could not be read.
///
/// Returns the entries as JSON values so the UI receives exactly the shape `mcp_audit_log` already
/// gives it. `unreadable` is not an error: a line that fails to decrypt is precisely what the chain
/// exists to reveal, and hiding it behind an empty list would defeat the point.
pub fn read_all() -> Result<(Vec<serde_json::Value>, usize), String> {
    let Some(dir) = DIR.get() else {
        return Ok((Vec::new(), 0));
    };
    let key = load_or_create_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| format!("Khoá mã hoá nhật ký MCP không hợp lệ: {e}"))?;

    let mut out = Vec::new();
    let mut unreadable = 0usize;
    // The rolled file first, so the result reads oldest-to-newest across the rotation.
    for path in [dir.join(ROLLED_NAME), dir.join(FILE_NAME)] {
        let Ok(file) = File::open(&path) else {
            continue;
        };
        let mut prev_tag = [0u8; TAG_LEN];
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            match decrypt_line(&cipher, &line, &prev_tag) {
                Ok((value, tag)) => {
                    out.push(value);
                    prev_tag = tag;
                }
                Err(_) => {
                    // The chain is broken from here on, so every later line in THIS file will fail
                    // too. Counting them all is the honest answer: it says how much is unaccounted
                    // for rather than stopping at the first casualty.
                    unreadable += 1;
                }
            }
        }
    }
    Ok((out, unreadable))
}

/// The last thing that went wrong while writing, for the settings screen.
pub fn last_error() -> Option<String> {
    match ERROR.lock() {
        Ok(g) => g.clone(),
        Err(p) => p.into_inner().clone(),
    }
}

static ERROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn set_error(message: String) {
    let mut g = match ERROR.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    *g = Some(message);
}

/// The 32-byte key, minting and storing one on first use.
///
/// Base64 in the keyring because the store holds strings — the same reason `redisTransfer` base64s a
/// DUMP payload rather than inventing a byte channel.
fn load_or_create_key() -> Result<Vec<u8>, String> {
    if let Some(existing) = secret_get(PROFILE.to_string(), FIELD.to_string())?
        && !existing.is_empty()
        && let Ok(bytes) = B64.decode(existing.as_bytes())
        && bytes.len() == 32
    {
        return Ok(bytes);
    }
    let key = aes_gcm::Key::<Aes256Gcm>::try_generate()
        .map_err(|e| format!("Không sinh được khoá mã hoá: {e}"))?;
    let bytes = key.to_vec();
    secret_set(PROFILE.to_string(), FIELD.to_string(), B64.encode(&bytes))?;
    Ok(bytes)
}

/// Encrypt one line and append it. Returns its tag, which binds the next line.
fn write_line(
    path: &Path,
    cipher: &Aes256Gcm,
    plaintext: &str,
    prev_tag: &[u8; TAG_LEN],
) -> Result<[u8; TAG_LEN], String> {
    let nonce = Nonce::<aes_gcm::aead::consts::U12>::try_generate()
        .map_err(|e| format!("Không ghi được nhật ký MCP: {e}"))?;
    let sealed = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext.as_bytes(),
                aad: prev_tag,
            },
        )
        .map_err(|e| format!("Không ghi được nhật ký MCP: {e}"))?;

    let mut record = Vec::with_capacity(NONCE_LEN + sealed.len());
    record.extend_from_slice(&nonce);
    record.extend_from_slice(&sealed);

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Không ghi được nhật ký MCP: {e}"))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Không ghi được nhật ký MCP: {e}"))?;
    writeln!(file, "{}", B64.encode(&record))
        .map_err(|e| format!("Không ghi được nhật ký MCP: {e}"))?;

    Ok(tag_of(&sealed))
}

/// Decrypt one line, returning its JSON and its tag.
fn decrypt_line(
    cipher: &Aes256Gcm,
    line: &str,
    prev_tag: &[u8; TAG_LEN],
) -> Result<(serde_json::Value, [u8; TAG_LEN]), String> {
    let record = B64
        .decode(line.trim().as_bytes())
        .map_err(|e| e.to_string())?;
    if record.len() < NONCE_LEN + TAG_LEN {
        return Err("dòng quá ngắn".to_string());
    }
    let (nonce_bytes, sealed) = record.split_at(NONCE_LEN);
    let nonce = Nonce::<aes_gcm::aead::consts::U12>::try_from(nonce_bytes)
        .map_err(|_| "nonce sai độ dài".to_string())?;
    let plain = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: sealed,
                aad: prev_tag,
            },
        )
        .map_err(|e| e.to_string())?;
    let value = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
    Ok((value, tag_of(sealed)))
}

/// The authentication tag: the last 16 bytes of an AES-GCM ciphertext (postfix tag).
fn tag_of(sealed: &[u8]) -> [u8; TAG_LEN] {
    let mut tag = [0u8; TAG_LEN];
    if sealed.len() >= TAG_LEN {
        tag.copy_from_slice(&sealed[sealed.len() - TAG_LEN..]);
    }
    tag
}

/// The tag of the last line already in the file, so a restart continues the chain.
///
/// Reads the whole file to find its last line. That is fine at 4MB and once per run, and the
/// alternative — seeking backwards over a base64 line of unknown length — is fiddly for no gain.
fn last_tag(path: &Path) -> Option<[u8; TAG_LEN]> {
    let file = File::open(path).ok()?;
    // `.last()`, not `.next_back()`: `Lines` reads forward off a file handle and is not a
    // DoubleEndedIterator, so there is nothing to walk back over.
    let last = BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|l| !l.trim().is_empty())
        .last()?;
    let record = B64.decode(last.trim().as_bytes()).ok()?;
    (record.len() >= NONCE_LEN + TAG_LEN).then(|| tag_of(&record[NONCE_LEN..]))
}

/// Roll the file over once it is large enough. Returns whether it rolled, because the chain restarts
/// with the new file.
fn rotate_if_needed(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < MAX_BYTES {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    // One generation only. Two would need a policy for how long an audit trail is kept, which is a
    // question for whoever deploys this rather than a number to guess here.
    std::fs::rename(path, parent.join(ROLLED_NAME)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A cipher under a FRESH random key.
    ///
    /// Not a constant, and not for style: a literal 32-byte array here is what CodeQL reports as a
    /// hard-coded cryptographic value (PR #35), and it is right to - nothing at the call site
    /// distinguishes a test key from a real one. None of these tests depends on the key's VALUE,
    /// so generating one says that outright instead of leaving a reader to work it out.
    fn cipher() -> Aes256Gcm {
        let key = aes_gcm::Key::<Aes256Gcm>::try_generate().expect("the OS RNG answers");
        Aes256Gcm::new(&key)
    }

    #[test]
    fn a_line_round_trips_through_the_chain() {
        let dir = std::env::temp_dir().join(format!("tg-audit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.log");
        let c = cipher();

        let zero = [0u8; TAG_LEN];
        let tag1 = write_line(&path, &c, r#"{"id":1}"#, &zero).unwrap();
        let tag2 = write_line(&path, &c, r#"{"id":2}"#, &tag1).unwrap();
        assert_ne!(tag1, tag2);

        let lines: Vec<String> = BufReader::new(File::open(&path).unwrap())
            .lines()
            .map_while(Result::ok)
            .collect();
        assert_eq!(lines.len(), 2);
        // Nothing readable is left in the file itself.
        assert!(!lines[0].contains("id"), "line is not plaintext");

        let (v1, t1) = decrypt_line(&c, &lines[0], &zero).unwrap();
        assert_eq!(v1["id"], 1);
        let (v2, _) = decrypt_line(&c, &lines[1], &t1).unwrap();
        assert_eq!(v2["id"], 2);

        // The recovered tag has to be the one the writer reported, or a restart breaks the chain.
        assert_eq!(last_tag(&path), Some(tag2));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_a_line_breaks_every_line_after_it() {
        // The whole point of chaining: an audit trail somebody edited must not read as intact.
        let dir = std::env::temp_dir().join(format!("tg-audit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.log");
        let c = cipher();

        let zero = [0u8; TAG_LEN];
        let tag1 = write_line(&path, &c, r#"{"id":1}"#, &zero).unwrap();
        write_line(&path, &c, r#"{"id":2}"#, &tag1).unwrap();

        let lines: Vec<String> = BufReader::new(File::open(&path).unwrap())
            .lines()
            .map_while(Result::ok)
            .collect();
        // Line 2 read as if line 1 had never existed - i.e. line 1 deleted.
        assert!(decrypt_line(&c, &lines[1], &zero).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_wrong_key_reads_nothing() {
        let dir = std::env::temp_dir().join(format!("tg-audit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.log");
        let zero = [0u8; TAG_LEN];
        write_line(&path, &cipher(), r#"{"id":1}"#, &zero).unwrap();

        // A second generated key. Two random 256-bit keys differ, and saying "a different key"
        // this way needs no second literal for CodeQL to flag.
        let other = cipher();
        let line = BufReader::new(File::open(&path).unwrap())
            .lines()
            .next()
            .unwrap()
            .unwrap();
        assert!(decrypt_line(&other, &line, &zero).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
