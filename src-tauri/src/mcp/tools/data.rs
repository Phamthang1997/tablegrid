//! The two tools that return rows: a table preview, and a read query.
//!
//! Both run through `exec::run_read`, never the routed funnel - see `policy` for why a third party's
//! read must not be able to open the user's transaction, and `exec` for why the database itself has to
//! be the one refusing writes.

use std::time::Instant;

use crate::mcp::audit::Refusal;
use rmcp::model::CallToolResult;
use serde_json::{Value, json};

use super::{app_state, json_result, passthrough};
use crate::database::qualified;
use crate::mcp::exec::run_read;
use crate::mcp::policy;

/// First N rows of a table.
///
/// The SQL is ours, so the limit goes into the statement and the database does the work - the
/// opposite of `query` below, and the reason the two are separate tools rather than one with a flag.
pub async fn preview_table(
    connection_id: Option<&str>,
    table_name: &str,
    limit: Option<usize>,
) -> Result<CallToolResult, Refusal> {
    let state = app_state()?;
    let (target, _) = policy::resolve(&state, connection_id)?;
    let limit = policy::row_limit(limit);

    // `qualified` quotes the identifier and, on Postgres, prefixes the schema the user is actually
    // looking at. A table name off the wire reaches SQL through here and nowhere else.
    let table = qualified(&target.conn, &target.schema, table_name);
    let sql = format!("SELECT * FROM {table} LIMIT {limit}");

    let started = Instant::now();
    let results = run_read(&target.conn, sql, target.timeout)
        .await
        .map_err(passthrough)?;
    // The database already applied the limit, so nothing here was cut off after the fact.
    json_result(&shape(results, limit, started, false))
}

/// One read statement, written by the caller.
pub async fn query(
    connection_id: Option<&str>,
    sql: &str,
    limit: Option<usize>,
) -> Result<CallToolResult, Refusal> {
    let state = app_state()?;
    let (target, _) = policy::resolve(&state, connection_id)?;
    policy::ensure_single_read(sql)?;
    let limit = policy::row_limit(limit);

    let started = Instant::now();
    let results = run_read(&target.conn, sql.to_string(), target.timeout)
        .await
        .map_err(passthrough)?;
    json_result(&shape(results, limit, started, true))
}

/// Turns the funnel's `{columns, data:[{col: val}]}` into the wire shape.
///
/// **Rows are arrays, not objects.** `SELECT *` across a few joins returns repeated column names -
/// five `last_update` in one sakila query - and a JSON object would keep exactly one of them with no
/// error anywhere. The funnel has already run `uniquify_columns`, so projecting each row in
/// `columns` order is both safe and lossless.
///
/// `truncated` is not optional. An AI concluding "there are 4 failing orders" from a silently cut
/// result is worse than any error this could return.
fn shape(results: Vec<Value>, limit: usize, started: Instant, cut_here: bool) -> Value {
    let first = results.into_iter().next().unwrap_or_else(|| json!({}));
    let columns: Vec<String> = first
        .get("columns")
        .and_then(Value::as_array)
        .map(|c| {
            c.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let data = first
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let total = data.len();
    let rows: Vec<Value> = data
        .iter()
        .take(limit)
        .map(|row| {
            Value::Array(
                columns
                    .iter()
                    .map(|c| row.get(c).cloned().unwrap_or(Value::Null))
                    .collect(),
            )
        })
        .collect();

    json!({
        "columns": columns,
        "rows": rows,
        "row_count": rows.len(),
        // A statement that returns nothing to cut (`SELECT` with zero rows, or a `SHOW` the driver
        // reports as empty) is never "truncated".
        "truncated": cut_here && total > limit,
        "execution_time_ms": started.elapsed().as_millis(),
    })
}
