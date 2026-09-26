//! The two commands behind the host key prompt. See `known_hosts.rs` for why the question is asked
//! AFTER a refused connection instead of during the handshake.

use super::known_hosts::{self, HostKeyChallenge};

/// The key `host:port` presented the last time it was refused, if any. The frontend asks this after
/// a failed connect instead of reading the error text, which has been translated by then.
#[tauri::command]
pub async fn ssh_host_key_challenge(host: String, port: Option<u16>) -> Option<HostKeyChallenge> {
    Box::pin(async move { known_hosts::challenge(&host, port.unwrap_or(22)) }).await
}

/// Record the refused key as trusted. `fingerprint` is the one the user was shown, and must still
/// be the key on file for that host — see `known_hosts::trust`.
#[tauri::command]
pub async fn ssh_trust_host_key(
    host: String,
    port: Option<u16>,
    fingerprint: String,
) -> Result<(), String> {
    Box::pin(async move { known_hosts::trust(&host, port.unwrap_or(22), &fingerprint) }).await
}
