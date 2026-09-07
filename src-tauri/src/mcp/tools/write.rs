//! The one tool that changes data, and the only place in `mcp/` a human is asked a question.
//!
//! Order matters and is not interchangeable. Permission first (`resolve_write`), shape second
//! (`ensure_single_write`), human last (`approval::ask`) - so a request that was never going to run
//! is refused without disturbing anybody. Asking first would let any AI client raise a dialog on a
//! connection it has no write permission for, which is a way to make the user press Approve out of
//! habit.
//!
//! Like the read tools this goes through `execute_raw_sql_pooled`, never the routed funnel: an
//! outside party's statement must not be able to join the transaction the user is holding.

use std::time::Instant;

use rmcp::model::CallToolResult;
use serde_json::json;

use super::{app_state, json_result, passthrough};
use crate::database::{execute_raw_sql_pooled, with_timeout};
use crate::mcp::approval::{self, AskFor};
use crate::mcp::audit::Refusal;
use crate::mcp::policy;

/// Run ONE statement that changes data, after the user approves it.
pub async fn mutate(connection_id: Option<&str>, sql: &str) -> Result<CallToolResult, Refusal> {
    let state = app_state()?;
    let (target, conn_id) = policy::resolve_write(&state, connection_id)?;
    policy::ensure_single_write(sql)?;

    approval::ask(AskFor {
        tool: "tablegrid_mutate",
        connection_id: &conn_id,
        database: &target.database,
        dialect: target.dialect,
        sql,
    })
    .await?;

    // Asked again AFTER the dialog, and this is not paranoia about a race: the user had 60 seconds
    // in which switching TableGrid to manual-commit mode is an entirely ordinary thing to do, and
    // running now would issue `BEGIN` on a session they own. `resolve_write` checked it a minute ago,
    // which is a different question from whether it holds at the moment of writing.
    policy::reject_if_manual(&conn_id)?;

    let started = Instant::now();
    with_timeout(
        Some(target.timeout),
        execute_raw_sql_pooled(&target.conn, sql.to_string()),
    )
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
