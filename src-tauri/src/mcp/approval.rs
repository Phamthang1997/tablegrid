//! Defence layer 5: the user approves each write, one request at a time.
//!
//! The shape is the one `src/utils/safeMode.ts` describes and deliberately does NOT build: park the
//! request in Rust, emit an event, wait for a dialog to answer over a channel, then re-enter. Safe
//! Mode could avoid it because every command it guards passes through `dbHelper`'s single local
//! `invoke()` on the frontend — it is already on the UI thread when it has to ask. An MCP request
//! never touches that funnel: it arrives on an axum task, so there is nothing to intercept and the
//! machinery below is the only way to put a human in the path.
//!
//! **Sharing the mechanism, not the policy** (§3.5, decided 2026-09-04). This gate is always on and
//! has no "silent" mode, unlike Safe Mode's three. That is what answers the plan's worry about two
//! policies drifting apart: there is no second policy to drift. Safe Mode's `silent` means "I am the
//! one typing, stop asking me", and no reading of that sentence extends it to a request an outside
//! service made.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use rmcp::ErrorData as McpError;
use serde_json::json;
use tokio::sync::oneshot;

use super::audit::{Denial, Refusal};

/// How long a parked request waits for a human.
///
/// The MCP client is blocked for this whole time, so it is a budget, not a courtesy. 60s is long
/// enough for the user to switch windows and actually READ the statement — which is the entire point
/// of the dialog — and short enough that a client does not decide the server is dead. Deliberately
/// unrelated to `policy::MAX_TIMEOUT` (30s): that one bounds how long a DATABASE may work, and
/// reading is not executing.
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(60);

/// Emitted when a request needs an answer. `McpApprovalGate.tsx` listens for it.
const REQUEST_EVENT: &str = "mcp-approval-request";
/// Emitted when a request stops needing an answer without the user giving one — today only on
/// timeout. Without it the dialog would sit there offering buttons for a request that is already
/// refused, and pressing Approve would appear to do nothing.
const RESOLVED_EVENT: &str = "mcp-approval-resolved";

/// Requests waiting for an answer, by id.
///
/// A map rather than one slot: two AI clients (or one client with two tool calls in flight) can both
/// be parked, and answering one must not resolve the other. The dialog renders them one at a time,
/// but that is a UI decision and not something this layer may assume.
fn pending() -> &'static Mutex<HashMap<String, oneshot::Sender<bool>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, oneshot::Sender<bool>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What the dialog has to show for the user to answer honestly.
pub struct AskFor<'a> {
    pub tool: &'a str,
    pub connection_id: &'a str,
    pub database: &'a str,
    pub dialect: &'a str,
    pub sql: &'a str,
}

/// Park this request until the user answers, or refuse it.
///
/// Returns `Ok(())` only on an explicit approval. Every other ending — declined, timed out, or the
/// answering channel dropped because the window went away — is a refusal, because "nobody said yes"
/// and "somebody said no" have to mean the same thing here.
pub async fn ask(req: AskFor<'_>) -> Result<(), Refusal> {
    let id = crate::state::mint_id().to_string();
    let (tx, rx) = oneshot::channel::<bool>();
    match pending().lock() {
        Ok(mut map) => {
            map.insert(id.clone(), tx);
        }
        // A poisoned lock must not become an approval. Refusing is the same answer the timeout
        // gives, and it needs no human.
        Err(_) => return Err(refuse("TableGrid could not park the request for approval")),
    }

    crate::state::emit(
        REQUEST_EVENT,
        json!({
            "id": id,
            "tool": req.tool,
            "connectionId": req.connection_id,
            "database": req.database,
            "dialect": req.dialect,
            "sql": req.sql,
            "timeoutMs": APPROVAL_TIMEOUT.as_millis() as u64,
        }),
    );

    let outcome = tokio::time::timeout(APPROVAL_TIMEOUT, rx).await;
    // Whatever happened, this id is finished: `respond` must not find it afterwards, and a timed-out
    // request must not leave its sender in the map for the life of the process.
    take(&id);

    match outcome {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err(refuse(
            "the TableGrid user declined this statement. Do not retry it; \
             ask them what they want changed instead.",
        )),
        // The sender was dropped without a decision.
        Ok(Err(_)) => Err(refuse(
            "the approval dialog closed without an answer, so the statement was not run.",
        )),
        Err(_) => {
            crate::state::emit(RESOLVED_EVENT, json!({ "id": id, "reason": "timeout" }));
            Err(refuse(
                "the TableGrid user did not respond within 60 seconds, so the statement was not \
                 run. They may be away from the app - say so rather than retrying immediately.",
            ))
        }
    }
}

/// The user's answer, from the dialog.
///
/// An unknown id is an error and not a silent success: it means the request already timed out or was
/// answered, and the dialog needs to say that instead of implying the write went through.
pub fn respond(id: &str, approved: bool) -> Result<(), String> {
    let tx = take(id).ok_or_else(|| {
        "Yêu cầu này không còn chờ trả lời (đã hết hạn hoặc đã được trả lời).".to_string()
    })?;
    // The receiver is gone only if `ask` already stopped waiting, which `take` above has just ruled
    // out for every ordinary path; ignoring the error keeps the race harmless either way.
    let _ = tx.send(approved);
    Ok(())
}

/// Remove one parked request, whoever gets there first.
fn take(id: &str) -> Option<oneshot::Sender<bool>> {
    match pending().lock() {
        Ok(mut map) => map.remove(id),
        Err(poisoned) => poisoned.into_inner().remove(id),
    }
}

/// Every layer-5 refusal, in English like the rest of the MCP surface: an AI client reads it, not
/// the TableGrid UI, so it never goes through `backendErrors.ts`.
fn refuse(message: &str) -> Refusal {
    Refusal::new(
        Denial::NotApproved,
        McpError::invalid_params(message.to_string(), None),
    )
}
