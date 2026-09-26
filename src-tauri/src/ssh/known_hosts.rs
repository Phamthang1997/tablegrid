//! Host key verification for every SSH connection the app opens (tunnel and terminal alike):
//! trust on first use, then refuse a key that changed — what OpenSSH does.
//!
//! Two files are consulted, both in OpenSSH's `known_hosts` format:
//! - the app's own `known_hosts` in the app data dir, the only one this module ever WRITES;
//! - the user's `~/.ssh/known_hosts`, read only, so a server already trusted with `ssh` is not asked
//!   about again. A changed key there is still a refusal, but the app cannot fix it for the user
//!   (`ssh-keygen -R` is theirs to run), which is why a challenge says which file knew the host.
//!
//! The handshake cannot stop and ask: `check_server_key` answers inside the key exchange. So a key
//! that is not trusted makes the connection fail, the presented key is parked here as a
//! [`HostKeyChallenge`], and the frontend — which knows the host and port it asked for — reads it
//! back with `ssh_host_key_challenge`, shows the fingerprint, and on "trust" calls
//! `ssh_trust_host_key` and connects again. The frontend never sends key material: trusting means
//! "the key you just showed me", identified by its fingerprint, so a key can only become trusted
//! after the server itself presented it.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use russh::keys::{
    Error as KeyError, HashAlg, PublicKey, check_known_hosts_path,
    known_hosts::learn_known_hosts_path,
};
use serde::Serialize;

const FILE_NAME: &str = "known_hosts";

static DIR: OnceLock<PathBuf> = OnceLock::new();
/// Host id -> what the server presented the last time its key was refused.
static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
/// Serializes writes to the app's file (a trust and a replace racing would each keep their own view).
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Called once from `app/setup.rs`, like the vault: a Tauri path can only be asked of the app handle.
pub fn init(dir: PathBuf) {
    let _ = DIR.set(dir);
}

fn app_file() -> Option<PathBuf> {
    DIR.get().map(|d| d.join(FILE_NAME))
}

fn openssh_file() -> Option<PathBuf> {
    std::env::home_dir().map(|h| h.join(".ssh").join("known_hosts"))
}

fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// OpenSSH lowercases host names before matching, and so do we — `DB.example.com` and
/// `db.example.com` are one host.
fn norm_host(host: &str) -> String {
    host.trim().to_ascii_lowercase()
}

/// The key the pending map is indexed by. Same spelling as a `known_hosts` line, for readability.
fn host_id(host: &str, port: u16) -> String {
    if port == 22 {
        norm_host(host)
    } else {
        format!("[{}]:{}", norm_host(host), port)
    }
}

pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Unknown,
    /// The key differs from the one recorded in the app's file — the user may replace it.
    Changed,
    /// The key differs from the one recorded in `~/.ssh/known_hosts` — the app will not edit that
    /// file, so the answer is `ssh-keygen -R`.
    ChangedOpenSsh,
}

struct Pending {
    status: Status,
    key: PublicKey,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyChallenge {
    host: String,
    port: u16,
    /// `unknown` | `changed` | `changedOpenSsh`
    status: &'static str,
    algorithm: String,
    fingerprint: String,
}

/// What one file says about a presented key.
enum Answer {
    Match,
    Changed,
    NoEntry,
}

fn ask(path: &PathBuf, host: &str, port: u16, key: &PublicKey) -> Answer {
    match check_known_hosts_path(host, port, key, path) {
        Ok(true) => Answer::Match,
        Err(KeyError::KeyChanged { .. }) => Answer::Changed,
        // No entry, no file, or a line russh cannot parse (a key type it does not know, a
        // `@cert-authority` marker). An unreadable file gives no information either way, and the
        // fallback is a question to the user rather than a silent yes.
        _ => Answer::NoEntry,
    }
}

/// The handshake's verdict. Returns `true` when the key is trusted; otherwise parks the key as a
/// challenge and returns `false`, which makes russh fail the connection with `UnknownKey`.
pub fn check(host: &str, port: u16, key: &PublicKey) -> bool {
    let h = norm_host(host);
    let app = app_file().map(|p| ask(&p, &h, port, key));
    let openssh = openssh_file().map(|p| ask(&p, &h, port, key));
    // A mismatch anywhere wins over a match elsewhere: an attacker's key recorded in one file must
    // not launder a changed key in the other.
    let status = match (app, openssh) {
        (_, Some(Answer::Changed)) => Some(Status::ChangedOpenSsh),
        (Some(Answer::Changed), _) => Some(Status::Changed),
        (Some(Answer::Match), _) | (_, Some(Answer::Match)) => None,
        _ => Some(Status::Unknown),
    };
    let mut map = pending().lock().unwrap_or_else(|e| e.into_inner());
    match status {
        None => {
            map.remove(&host_id(host, port));
            true
        }
        Some(status) => {
            map.insert(
                host_id(host, port),
                Pending {
                    status,
                    key: key.clone(),
                },
            );
            false
        }
    }
}

/// Forget a stale challenge before a new attempt, so a failure that never reached the key exchange
/// (network down, DNS) cannot be mistaken for a refusal of the key an earlier attempt was shown.
pub fn clear_pending(host: &str, port: u16) {
    pending()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&host_id(host, port));
}

pub fn pending_status(host: &str, port: u16) -> Option<Status> {
    pending()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&host_id(host, port))
        .map(|p| p.status)
}

pub fn challenge(host: &str, port: u16) -> Option<HostKeyChallenge> {
    let map = pending().lock().unwrap_or_else(|e| e.into_inner());
    map.get(&host_id(host, port)).map(|p| HostKeyChallenge {
        host: host.trim().to_string(),
        port,
        status: match p.status {
            Status::Unknown => "unknown",
            Status::Changed => "changed",
            Status::ChangedOpenSsh => "changedOpenSsh",
        },
        algorithm: p.key.algorithm().as_str().to_string(),
        fingerprint: fingerprint(&p.key),
    })
}

/// Trust the key the server presented last, which must be the one whose fingerprint the user saw.
/// For a changed key this REPLACES the app's entry: russh reports `KeyChanged` as soon as any line
/// for the host disagrees, so appending the new key beside the old one would refuse it forever.
pub fn trust(host: &str, port: u16, expected_fingerprint: &str) -> Result<(), String> {
    let id = host_id(host, port);
    let pending_entry = {
        let map = pending().lock().unwrap_or_else(|e| e.into_inner());
        map.get(&id).map(|p| (p.status, p.key.clone()))
    };
    let Some((status, key)) = pending_entry else {
        return Err("Không có khoá máy chủ SSH nào đang chờ xác nhận".to_string());
    };
    if fingerprint(&key) != expected_fingerprint {
        return Err("Khoá máy chủ SSH đã đổi trong lúc chờ xác nhận, hãy kết nối lại".to_string());
    }
    if status == Status::ChangedOpenSsh {
        return Err(format!(
            "Khoá máy chủ SSH đã lưu trong ~/.ssh/known_hosts, hãy chạy: ssh-keygen -R \"{}\"",
            id
        ));
    }
    let path = app_file().ok_or("Chưa xác định được thư mục dữ liệu của ứng dụng.")?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if status == Status::Changed {
        remove_host_lines(&path, &id).map_err(|e| format!("Lỗi ghi known_hosts: {}", e))?;
    }
    learn_known_hosts_path(&norm_host(host), port, &key, &path)
        .map_err(|e| format!("Lỗi ghi known_hosts: {}", e))?;
    pending()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    Ok(())
}

/// Rewrites the app's file without the lines for `id`. Written to a `.tmp` and renamed, so a crash
/// halfway leaves the old file rather than half of it. Only the app's own file is ever rewritten,
/// and it holds only plain (never hashed) host names, which is why an exact field match is enough.
fn remove_host_lines(path: &PathBuf, id: &str) -> std::io::Result<()> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let kept = keep_other_hosts(&text, id);
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(kept.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

fn keep_other_hosts(text: &str, id: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let hosts = line.split(' ').next().unwrap_or("");
        if hosts.split(',').any(|h| h == id) {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB6xZGPT84amsNmL3vbDAFkYAJWqTEZtLiPkx+AlX5oR";
    const KEY_B: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINQDJFEAXOciIhbIbNVBxQ+VCeOq7f1EOz8tAjWEjpX/";

    fn key(s: &str) -> PublicKey {
        PublicKey::from_openssh(s).unwrap()
    }

    #[test]
    fn a_file_answers_match_changed_or_nothing() {
        let dir = std::env::temp_dir().join(format!("tg-known-hosts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(FILE_NAME);
        assert!(matches!(
            ask(&path, "db.example", 2222, &key(KEY_A)),
            Answer::NoEntry
        ));

        learn_known_hosts_path("db.example", 2222, &key(KEY_A), &path).unwrap();
        assert!(matches!(
            ask(&path, "db.example", 2222, &key(KEY_A)),
            Answer::Match
        ));
        assert!(matches!(
            ask(&path, "db.example", 2222, &key(KEY_B)),
            Answer::Changed
        ));
        // Another port is another host.
        assert!(matches!(
            ask(&path, "db.example", 22, &key(KEY_B)),
            Answer::NoEntry
        ));

        // Replacing drops the old line, so the new key is a match rather than still "changed".
        remove_host_lines(&path, &host_id("db.example", 2222)).unwrap();
        learn_known_hosts_path("db.example", 2222, &key(KEY_B), &path).unwrap();
        assert!(matches!(
            ask(&path, "db.example", 2222, &key(KEY_B)),
            Answer::Match
        ));
        assert!(matches!(
            ask(&path, "db.example", 2222, &key(KEY_A)),
            Answer::Changed
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The private halves of KEY_A / KEY_B: throwaway keys made for this test and nothing else.
    const PRIV_A: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAesWRj0/OGprDZi972wwBZGACVqkxGbS4j5MfgJV+aEQAAAIhthILwbYSC
8AAAAAtzc2gtZWQyNTUxOQAAACAesWRj0/OGprDZi972wwBZGACVqkxGbS4j5MfgJV+aEQ
AAAEAd3qgevrM+Pw8X1GL9qasqbyL+3tDJuFy4FFg7AWyMsB6xZGPT84amsNmL3vbDAFkY
AJWqTEZtLiPkx+AlX5oRAAAAAAECAwQF
-----END OPENSSH PRIVATE KEY-----";
    const PRIV_B: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACDUAyRRAFznIiIWyGzVQcUPlQnjqu39RDs/LQI1hI6V/wAAAIjEf4p5xH+K
eQAAAAtzc2gtZWQyNTUxOQAAACDUAyRRAFznIiIWyGzVQcUPlQnjqu39RDs/LQI1hI6V/w
AAAEBzDFPXdCvgNfw2d/NO8GCiKsz0sTAudF/Y/ndL03ubutQDJFEAXOciIhbIbNVBxQ+V
CeOq7f1EOz8tAjWEjpX/AAAAAAECAwQF
-----END OPENSSH PRIVATE KEY-----";

    /// A server that accepts any password — the host key is the only thing under test.
    struct OpenDoor;
    impl russh::server::Handler for OpenDoor {
        type Error = russh::Error;
        async fn auth_password(
            &mut self,
            _: &str,
            _: &str,
        ) -> Result<russh::server::Auth, Self::Error> {
            Ok(russh::server::Auth::Accept)
        }
    }

    /// Serves SSH on `listener` with `private_key` as the host key until the task is aborted.
    fn serve(listener: tokio::net::TcpListener, private_key: &str) -> tokio::task::JoinHandle<()> {
        let config = std::sync::Arc::new(russh::server::Config {
            keys: vec![russh::keys::decode_secret_key(private_key, None).unwrap()],
            ..Default::default()
        });
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let config = config.clone();
                tokio::spawn(async move {
                    if let Ok(session) = russh::server::run_stream(config, stream, OpenDoor).await {
                        let _ = session.await;
                    }
                });
            }
        })
    }

    /// The whole flow against a real handshake: refused on first sight, trusted, accepted, then
    /// refused again when the same host:port presents another key, and accepted once that is
    /// replaced. The app file lives in a temp dir; `~/.ssh/known_hosts` is read as usual, and a
    /// random localhost port is not in anyone's.
    #[tokio::test]
    async fn a_real_handshake_is_refused_trusted_and_refused_again_on_a_new_key() {
        let dir = std::env::temp_dir().join(format!("tg-known-hosts-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        init(dir.clone());

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = serde_json::json!({
            "sshHost": "127.0.0.1", "sshPort": port, "sshUser": "tg", "sshPassword": "x",
        });
        let server = serve(listener, PRIV_A);

        let err = crate::ssh::connect_and_auth(&config).await.err().unwrap();
        assert!(err.contains("chưa được tin cậy"), "{err}");
        let ch = challenge("127.0.0.1", port).unwrap();
        assert_eq!(ch.status, "unknown");
        assert_eq!(ch.fingerprint, fingerprint(&key(KEY_A)));

        // Trusting a fingerprint other than the one shown is refused.
        assert!(trust("127.0.0.1", port, "SHA256:nope").is_err());
        trust("127.0.0.1", port, &ch.fingerprint).unwrap();
        assert!(crate::ssh::connect_and_auth(&config).await.is_ok());
        assert!(challenge("127.0.0.1", port).is_none());

        // Same host and port, another key.
        server.abort();
        let _ = server.await;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .unwrap();
        let server = serve(listener, PRIV_B);
        let err = crate::ssh::connect_and_auth(&config).await.err().unwrap();
        assert!(err.contains("đã thay đổi"), "{err}");
        let ch = challenge("127.0.0.1", port).unwrap();
        assert_eq!(ch.status, "changed");
        assert_eq!(ch.fingerprint, fingerprint(&key(KEY_B)));

        trust("127.0.0.1", port, &ch.fingerprint).unwrap();
        assert!(crate::ssh::connect_and_auth(&config).await.is_ok());
        // The old key is gone from the file, not kept beside the new one.
        let text = std::fs::read_to_string(dir.join(FILE_NAME)).unwrap();
        // (Non-blank lines: russh's `learn` starts an empty file with a newline.)
        let entries: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(entries.len(), 1, "{text}");
        assert!(
            entries[0].starts_with(&format!("[127.0.0.1]:{port} ssh-ed25519 ")),
            "{text}"
        );

        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fingerprints_are_openssh_sha256() {
        assert!(fingerprint(&key(KEY_A)).starts_with("SHA256:"));
        assert_ne!(fingerprint(&key(KEY_A)), fingerprint(&key(KEY_B)));
    }

    #[test]
    fn host_ids_follow_known_hosts_spelling() {
        assert_eq!(host_id(" DB.Example.com ", 22), "db.example.com");
        assert_eq!(host_id("10.0.0.5", 2222), "[10.0.0.5]:2222");
    }

    #[test]
    fn removing_a_host_keeps_every_other_line() {
        let text = "a.example ssh-ed25519 AAAA\n[b.example]:2222 ssh-ed25519 BBBB\n# comment\nb.example ssh-rsa CCCC\n";
        assert_eq!(
            keep_other_hosts(text, "[b.example]:2222"),
            "a.example ssh-ed25519 AAAA\n# comment\nb.example ssh-rsa CCCC\n"
        );
        // A line naming several hosts goes too: it would still answer for the one being replaced.
        assert_eq!(
            keep_other_hosts("x,a.example ssh-ed25519 AAAA\n", "a.example"),
            ""
        );
    }
}
