//! The one tool that changes data, and the only place in `mcp/` a human is asked a question.
//!
//! Order matters and is not interchangeable. Permission first (`resolve_write`), shape second
//! (`ensure_single_write`), human last (`approval::ask`) - so a request that was never going to run
//! is refused without disturbing anybody. Asking first would let any AI client raise a dialog on a
//! connection it has no write permission for, which is a way to make the user press Approve out of
//! habit.
//!
//! Like the read tools this goes through `exec` (pooled), never the routed funnel: an
//! outside party's statement must not be able to join the transaction the user is holding.

use std::time::Instant;

use rmcp::model::CallToolResult;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::{app_state, json_result, passthrough};
use crate::mcp::approval::{self, AskFor};
use crate::mcp::audit::Refusal;
use crate::mcp::exec::run_write;
use crate::mcp::policy;

/// Run ONE statement that changes data, after the user approves it.
pub async fn mutate(
    connection_id: Option<&str>,
    sql: &str,
    ct: CancellationToken,
) -> Result<CallToolResult, Refusal> {
    let state = app_state()?;
    let (target, conn_id) = policy::resolve_write(&state, connection_id)?;
    policy::ensure_single_write(sql)?;

    approval::ask(
        AskFor {
            tool: "tablegrid_mutate",
            connection_id: &conn_id,
            database: &target.database,
            dialect: target.dialect,
            sql,
        },
        &ct,
    )
    .await?;

    // The client may have given up in the instant the user clicked Approve. Nobody would receive the
    // result, and the model - believing its call failed - may send the same write again.
    if ct.is_cancelled() {
        return Err(crate::mcp::audit::Refusal::new(
            crate::mcp::audit::Denial::NotApproved,
            rmcp::ErrorData::invalid_params(
                "the request was cancelled, so the statement was not run.".to_string(),
                None,
            ),
        ));
    }

    // Asked again AFTER the dialog, and this is not paranoia about a race: the user had 60 seconds
    // in which switching TableGrid to manual-commit mode is an entirely ordinary thing to do, and
    // running now would issue `BEGIN` on a session they own. `resolve_write` checked it a minute ago,
    // which is a different question from whether it holds at the moment of writing.
    policy::reject_if_manual(&conn_id)?;

    let started = Instant::now();
    run_write(&target.conn, sql.to_string(), target.timeout)
        .await
        .map_err(passthrough)?;

    json_result(&json!({
        "executed": true,
        "execution_time_ms": started.elapsed().as_millis(),
        // Said rather than left to be inferred. The funnel this shares with every read returns
        // `{columns, data}` and no affected count, so reporting one would mean inventing it - and an
        // AI that believes "3 rows updated" when the WHERE matched none draws a wrong conclusion and
        // then acts on it. The honest answer names the way to find out.
        "affected_rows": "not reported by TableGrid - run a SELECT to confirm what changed",
        // The user approved this statement and it ran outside any transaction they can see, so there
        // is no Rollback button waiting for them. The model should not offer to undo it.
        "committed": true,
    }))
}
