//! `get_table_schema` — the columns / indexes / foreign keys of ONE table, for the structure editor.
//!
//! The body lives in `database/introspect.rs`, which the MCP server shares. See that file for why
//! it may not sit next to a `#[tauri::command]`.

use serde_json::Value;

use crate::database::introspect::get_table_schema_inner;

#[tauri::command]
pub async fn get_table_schema(
    conn_id: String,
    name: String,
    // See `get_table_data`: the sidebar's Temporary section names the `pg_temp_N` schema its rows
    // came from, so the structure view introspects the same relation the list did.
    schema_override: Option<String>,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        get_table_schema_inner(&state, conn_id, name, schema_override).await
    })
    .await
}
