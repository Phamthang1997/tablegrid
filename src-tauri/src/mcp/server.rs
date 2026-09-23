//! Lifecycle of the one MCP server this app runs: bind, serve, stop.
//!
//! The server lives as long as the PROCESS, not as long as a window. It answers a request perfectly
//! well while the window is minimised, and tying it to the window would make "why did my AI client
//! stop working" a question about which app was focused.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::{auth, http};

/// The port the docs and the 1-click config snippets name.
///
/// It never shifts on its own when taken. An auto-shifted port silently invalidates the snippet the
/// user already pasted into their AI client, with nothing anywhere to say so - see the plan, 5.2.
/// A clear error and a Settings field is the honest version of the same feature.
pub const DEFAULT_PORT: u16 = 45124;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    /// The port actually bound while running; the default otherwise, so the UI has something to show.
    pub port: u16,
    /// What goes into an AI client config. Empty while stopped, so no one can copy a dead URL.
    pub url: String,
    /// This executable, for the `--mcp-stdio` client config.
    ///
    /// Reported even while stopped - unlike `url`, it is not a live endpoint that could be copied
    /// dead, and a client configured this way starts the proxy on demand rather than needing the
    /// server up at copy time. Empty only if the OS refuses to say, in which case the dialog falls
    /// back to naming the flag without a path.
    pub exe_path: String,
}

impl McpStatus {
    fn stopped(port: u16) -> Self {
        McpStatus {
            running: false,
            port,
            url: String::new(),
            exe_path: exe_path(),
        }
    }

    fn running(port: u16) -> Self {
        McpStatus {
            running: true,
            port,
            url: format!("http://127.0.0.1:{port}{}", http::MOUNT_PATH),
            exe_path: exe_path(),
        }
    }
}

/// The path of this binary, with forward slashes.
///
/// JSON config files are where this ends up, and a Windows backslash has to be escaped there - a path
/// the user pastes wrongly is a support question, while forward slashes work on every platform and in
/// every client that takes a `command`.
fn exe_path() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

struct Running {
    port: u16,
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

/// Held in `AppState`. One per app: a second listener would mean two servers racing for one port.
#[derive(Default)]
pub struct McpServer {
    inner: Mutex<Option<Running>>,
    /// What AI clients have asked for. Lives with the server rather than beside it in `AppState`:
    /// both are MCP, and one field is one place to look.
    pub audit: super::audit::Audit,
}

impl McpServer {
    pub fn status(&self) -> McpStatus {
        match self.lock().as_ref() {
            Some(r) => McpStatus::running(r.port),
            None => McpStatus::stopped(DEFAULT_PORT),
        }
    }

    /// Binds and starts serving. Errors rather than silently picking another port.
    pub async fn start(&self, port: u16) -> Result<McpStatus, String> {
        if self.lock().is_some() {
            return Err("MCP Server đang chạy rồi".to_string());
        }

        // Read the token ONCE here, not per request: the guard compares against this copy, and a
        // token regenerated behind the server's back only takes effect on restart anyway.
        let token: Arc<str> = auth::load_or_create()?.into();

        // 127.0.0.1 explicitly, never 0.0.0.0 - defence layer 1, and the one line where getting it
        // wrong exposes every open connection to the local network.
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let listener = TcpListener::bind(addr).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                format!("Cổng {port} đang bị tiến trình khác dùng — đổi cổng trong Cài đặt")
            } else {
                format!("Không mở được MCP Server: {e}")
            }
        })?;

        let cancel = CancellationToken::new();
        let router = http::router(port, token, cancel.child_token());

        let shutdown = cancel.clone();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move { shutdown.cancelled().await })
                .await;
        });

        // The slot is claimed only now, after the bind succeeded. Two starts racing would both have
        // passed the check above, but only one of them holds a listener - the loser is turned away
        // here and its listener drops with the task it never spawned.
        let mut guard = self.lock();
        if guard.is_some() {
            cancel.cancel();
            task.abort();
            return Err("MCP Server đang chạy rồi".to_string());
        }
        *guard = Some(Running { port, cancel, task });
        Ok(McpStatus::running(port))
    }

    /// Stops the server and waits for the task to actually finish.
    ///
    /// Waiting matters: the caller's next move is usually to start again on the same port, and a
    /// listener that has not dropped yet answers that with "address in use".
    pub async fn stop(&self) -> McpStatus {
        // Take the entry OUT under the lock, then await outside it. A std::sync::Mutex guard must
        // never be held across an await (CODING_STANDARDS.md 6.3).
        let running = self.lock().take();
        // Parked writes first: they belong to clients this stop is cutting off.
        super::approval::refuse_all();
        if let Some(r) = running {
            r.cancel.cancel();
            let _ = r.task.await;
            return McpStatus::stopped(r.port);
        }
        McpStatus::stopped(DEFAULT_PORT)
    }

    /// A poisoned lock here would mean a panic while swapping the handle; the state is still
    /// readable and refusing to answer would strand the server with no way to stop it.
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Running>> {
        match self.inner.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        }
    }
}
