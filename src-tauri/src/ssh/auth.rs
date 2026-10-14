//! SSH connect and AUTHENTICATE — a single path, shared by the port-forwarding tunnel
//! (`ssh/tunnel.rs`) and the terminal panel (`terminal/ssh.rs`).

use std::sync::Arc;

use russh::client::{self, Handle};
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg, decode_secret_key, load_secret_key};
use serde_json::Value;

/// Handler for the SSH client. It carries the host it dialled because the key check is by host:
/// `known_hosts.rs` decides, and a refusal is parked there for the frontend to ask about.
pub struct SshHandler {
    host: String,
    port: u16,
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        // A certificate is checked by the host key inside it. No CA is configured anywhere in the
        // app, so the certificate's signature proves nothing to us, while the key is still what the
        // server signs the exchange with — pinning it is the same trust-on-first-use as a bare key.
        let trusted =
            super::known_hosts::check(&self.host, self.port, &server_public_key.public_key());
        async move { Ok(trusted) }
    }
}

/// Connect over SSH and authenticate (password or private key), returning a Handle ready to open channels.
/// Shared by the tunnel (forwarding the DB port) and the terminal (PTY/shell for reading logs).
/// `config` carries the ssh* fields from the frontend.
pub async fn connect_and_auth(config: &Value) -> Result<Handle<SshHandler>, String> {
    let ssh_host = config
        .get("sshHost")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or("Thiếu địa chỉ máy chủ SSH")?;
    let ssh_port = config.get("sshPort").and_then(|v| v.as_u64()).unwrap_or(22) as u16;
    let ssh_user = config
        .get("sshUser")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("root");
    let auth_type = config
        .get("sshAuthType")
        .and_then(|v| v.as_str())
        .unwrap_or("password");

    // 1. SSH connection
    let ssh_config = Arc::new(client::Config::default());
    super::known_hosts::clear_pending(ssh_host, ssh_port);
    let handler = SshHandler {
        host: ssh_host.to_string(),
        port: ssh_port,
    };
    let mut handle = client::connect(ssh_config, (ssh_host, ssh_port), handler)
        .await
        .map_err(|e| match e {
            // Worded per case rather than passing russh's "Unknown server key" through: the user
            // needs to know whether this is a first visit or a key that CHANGED.
            russh::Error::UnknownKey => {
                match super::known_hosts::pending_status(ssh_host, ssh_port) {
                    Some(super::known_hosts::Status::Unknown) | None => format!(
                        "Khoá máy chủ SSH của {}:{} chưa được tin cậy",
                        ssh_host, ssh_port
                    ),
                    Some(_) => format!(
                        "Khoá máy chủ SSH của {}:{} đã thay đổi — có thể có kẻ đang chặn kết nối",
                        ssh_host, ssh_port
                    ),
                }
            }
            e => format!("Lỗi kết nối SSH tới {}:{}: {}", ssh_host, ssh_port, e),
        })?;

    // 2. Authentication (password or private key)
    let auth_result = match auth_type {
        "key" => {
            let passphrase = config
                .get("sshPassphrase")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());
            let key: PrivateKey = if let Some(content) = config
                .get("sshKeyContent")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
            {
                decode_secret_key(content, passphrase)
                    .map_err(|e| format!("Lỗi đọc nội dung private key: {}", e))?
            } else if let Some(path) = config
                .get("sshKeyPath")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
            {
                load_secret_key(path, passphrase)
                    .map_err(|e| format!("Lỗi đọc file private key '{}': {}", path, e))?
            } else {
                return Err("Thiếu private key cho xác thực SSH bằng khóa".to_string());
            };
            let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), None);
            handle
                .authenticate_publickey(ssh_user, key_with_alg)
                .await
                .map_err(|e| format!("Lỗi xác thực SSH bằng khóa: {}", e))?
        }
        _ => {
            let password = config
                .get("sshPassword")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            handle
                .authenticate_password(ssh_user, password)
                .await
                .map_err(|e| format!("Lỗi xác thực SSH bằng mật khẩu: {}", e))?
        }
    };

    if !auth_result.success() {
        return Err("Xác thực SSH thất bại: sai tài khoản, mật khẩu hoặc khóa.".to_string());
    }
    Ok(handle)
}
