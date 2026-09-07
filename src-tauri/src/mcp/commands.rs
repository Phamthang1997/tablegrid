//! The Tauri commands behind the MCP settings screen.
//!
//! Language note, and it is the opposite of the rest of this directory: these messages surface in
//! the TableGrid UI, so they follow the repo rule - Vietnamese literals, translated at the dbHelper
//! boundary by `src/utils/backendErrors.ts`. The errors in `http.rs` and `tools/` are read by an AI
//! client instead, so those are English and never go through that table. Registering these strings
//! in `backendErrors.ts` happens together with the Settings UI (Bước 3 of the plan).

use super::approval;
use super::audit_file;
use super::auth;
use super::server::{DEFAULT_PORT, McpStatus};

#[tauri::command]
pub async fn mcp_status() -> Result<McpStatus, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        Ok(state.mcp.status())
    })
    .await
}

#[tauri::command]
pub async fn mcp_start(port: Option<u16>) -> Result<McpStatus, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        state.mcp.start(port.unwrap_or(DEFAULT_PORT)).await
    })
    .await
}

#[tauri::command]
pub async fn mcp_stop() -> Result<McpStatus, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        Ok(state.mcp.stop().await)
    })
    .await
}

#[tauri::command]
pub async fn mcp_get_token() -> Result<String, String> {
    Box::pin(async move { auth::load_or_create() }).await
}

/// Mints a new token, and restarts the server if it was running.
///
/// The restart is not a nicety: the guard compares against the token read at startup, so without it
/// the new token would not work until the next restart while the OLD one still would - the exact
/// opposite of what the button promises. Clients configured with the old token are cut off either
/// way, which is why the UI has to say so before calling this.
#[tauri::command]
pub async fn mcp_regenerate_token() -> Result<String, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let was = state.mcp.status();
        let token = auth::regenerate()?;
        if was.running {
            state.mcp.stop().await;
            state.mcp.start(was.port).await?;
        }
        Ok(token)
    })
    .await
}

/// The requests AI clients have made this run, newest first.
///
/// In memory only, and the Settings screen says so - see `audit.rs`. The UI reads this once on open
/// and then follows the `mcp-request` event, rather than polling.
#[tauri::command]
pub async fn mcp_audit_log() -> Result<Vec<serde_json::Value>, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        Ok(state.mcp.audit.snapshot())
    })
    .await
}

#[tauri::command]
pub async fn mcp_audit_clear() -> Result<(), String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        state.mcp.audit.clear();
        Ok(())
    })
    .await
}

/// The answer to one parked write request, from `McpApprovalGate.tsx`.
///
/// Deliberately NOT idempotent: replying to an id that is no longer pending is an error, because
/// the only way to get there is a request that already timed out - and a dialog that silently
/// succeeded would tell the user their approval went through when nothing ran.
#[tauri::command]
pub async fn mcp_approval_respond(request_id: String, approved: bool) -> Result<(), String> {
    Box::pin(async move { approval::respond(&request_id, approved) }).await
}

/// The audit log kept on DISK: every run, not just this one.
///
/// Returns `{ entries, unreadable, error }`. `unreadable` counts lines that failed to decrypt,
/// which is the tamper signal rather than a bug - each line is bound to the one before it, so a
/// removed or reordered line makes the rest fail. It is reported next to the entries instead of
/// swallowed, because a log that quietly shows fewer rows is worse than no log.
#[tauri::command]
pub async fn mcp_audit_file_read() -> Result<serde_json::Value, String> {
    Box::pin(async move {
        let (entries, unreadable) = audit_file::read_all()?;
        Ok(serde_json::json!({
            "entries": entries,
            "unreadable": unreadable,
            "error": audit_file::last_error(),
        }))
    })
    .await
}
