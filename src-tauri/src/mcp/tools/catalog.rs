//! The four introspection tools: what connections exist, and what is inside one.
//!
//! These reuse the very bodies the TableGrid UI calls, through the `*_inner` entry points that take
//! an `&AppState` instead of a `tauri::State`. That is the point - schema introspection is a pile of
//! dialect-specific SQL, and a second copy written for AI clients would answer a different question
//! from the sidebar within a release or two.
//!
//! Reusing them is only safe because `policy::resolve` has already refused a connection in manual
//! commit mode: these bodies go through the ROUTED funnel, which would otherwise open the user's
//! transaction for them. See `policy::reject_if_manual`.

use crate::mcp::audit::Refusal;
use rmcp::model::CallToolResult;

use super::{app_state, json_result, passthrough};
use crate::database::with_timeout;
use crate::mcp::policy;

// Every body below runs under `target.timeout`, i.e. `policy::mcp_timeout()` - the same ceiling
// `data.rs` applies. These three used to call `policy::resolve()` and throw the `Target` away, so
// introspection was the one MCP path with no time limit at all. That was accepted at V1 on the
// grounds that a catalog query is bounded by its nature rather than by the data, which is true right
// up until a server with thousands of tables makes it false - and an AI client has no Stop button
// either way. Closing it costs one wrapper per body, so the argument for leaving it open was thin.

/// Every connection the user shared, and nothing else - the filtering happens in the registry so no
/// tool can forget it.
pub async fn list_connections() -> Result<CallToolResult, Refusal> {
    let state = app_state()?;
    let connections = state.connections.list_mcp_exposed().map_err(passthrough)?;
    json_result(&serde_json::json!({ "connections": connections }))
}

pub async fn list_databases(connection_id: Option<&str>) -> Result<CallToolResult, Refusal> {
    let state = app_state()?;
    let (target, conn_id) = policy::resolve(&state, connection_id)?;
    let out = with_timeout(
        Some(target.timeout),
        crate::database::introspect::list_databases_inner(&state, conn_id.clone()),
    )
    .await
    .map_err(passthrough)?;
    json_result(&out)
}

pub async fn list_tables(connection_id: Option<&str>) -> Result<CallToolResult, Refusal> {
    let state = app_state()?;
    let (target, conn_id) = policy::resolve(&state, connection_id)?;
    let out = with_timeout(
        Some(target.timeout),
        crate::database::introspect::get_tables_inner(&state, conn_id.clone()),
    )
    .await
    .map_err(passthrough)?;
    json_result(&out)
}

pub async fn describe_table(
    connection_id: Option<&str>,
    table_name: &str,
) -> Result<CallToolResult, Refusal> {
    let state = app_state()?;
    let (target, conn_id) = policy::resolve(&state, connection_id)?;
    let out = with_timeout(
        Some(target.timeout),
        // `None` for the schema override: an MCP client names a table, never a `pg_temp_N` it
        // could not see anyway — its reads go through a pooled connection by design.
        crate::database::introspect::get_table_schema_inner(
            &state,
            conn_id.clone(),
            table_name.to_string(),
            None,
        ),
    )
    .await
    .map_err(passthrough)?;
    json_result(&out)
}
