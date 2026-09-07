//! `get_table_data` — reads one page of a table's data for the grid.

use serde_json::{Value, json};

use crate::database::{
    DbKind, execute_raw_sql_generic, qualified, sql_str, stmt_timeout, uniquify_columns,
    with_timeout,
};

use super::catalog::{estimate_row_count, exact_row_count};

/// A cursor value, exactly as the database spelled it.
///
/// Only a number or a string can be a cursor. Anything else (NULL, a BLOB arriving as a byte array,
/// a composite) has no usable `>` boundary here, and returning `None` is what makes the frontend
/// fall back to `OFFSET` for that view instead of paging on a value it cannot compare.
fn scalar_to_cursor(v: &Value) -> Option<String> {
    match v {
        // `Number::to_string` keeps every digit of an i64 — the whole reason the cursor is minted
        // here and not read off the row on the frontend (see `next_cursor`).
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// One page of a table, plus how many rows there are in total.
///
/// Paging is by cursor when the frontend names a `seek_column` (a single-column primary key) and
/// hands back the `nextCursor` of the previous page, and by `OFFSET` otherwise — a filter or a sort
/// on another column is not a reason to fall back, but a table without a single-column key is.
///
/// `count_mode` is `"skip"` | `"auto"` | `"exact"`, and **anything else — including absent — means
/// `"exact"`**. That default is load-bearing, not a formality: the export paths (`dumpBuilder`,
/// `ExportTableDialog`) page until `rows.length >= totalCount`, so an *under*estimate there would
/// end the loop early and write a truncated dump with no error. Only the grid's status line, which
/// can afford a `~`, opts into the other two modes.
#[tauri::command]
pub async fn get_table_data(
    conn_id: String,
    name: String,
    page: u32,
    limit: u32,
    sort_by: Option<String>,
    sort_dir: Option<String>,
    filter: Option<String>,
    count_mode: Option<String>,
    seek_column: Option<String>,
    cursor: Option<String>,
    // The schema to read from, overriding the connection's current one. Only the sidebar's
    // Temporary section sends it, and only on Postgres, where a session-temporary table lives in
    // `pg_temp_N` — qualifying it with the connection's schema would look for it in `public` and
    // report a table the user is looking at as non-existent.
    schema_override: Option<String>,
) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let (conn_type, schema, limit_dur) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        let sch = match schema_override.as_deref() {
            Some(s) if !s.is_empty() => Some(s.to_string()),
            _ => ctx.raw_schema().map(str::to_string),
        };
        (ct, sch, stmt_timeout(&ctx.server().config()))
    };

    let is_mysql = matches!(&conn_type.kind, DbKind::Mysql(_));
    // The identifier quoting character per dialect: MySQL uses backticks, the others double quotes
    let q = if is_mysql { '`' } else { '"' };
    // The grid reads through this command, so it has to name the same schema the sidebar listed
    // from — otherwise a table outside `public` lists fine and then fails to open.
    let table_ref = qualified(&conn_type, &schema, &name);

    // WHERE: the frontend has already built the filter clause in the right dialect, so it is spliced in raw after WHERE
    let filter_body = filter.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty());
    let where_clause = match filter_body {
        Some(f) => format!(" WHERE {}", f),
        None => String::new(),
    };

    // strip any quoting characters already present so the syntax cannot break, then quote it ourselves
    let safe_ident = |s: &str| s.replace(['`', '"'], "");
    let seek_col = seek_column
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(&safe_ident);

    // ORDER BY: the column the user picked, and failing that the seek column (a single-column primary key) the
    // frontend sends down. Keyset pagination is only correct when the order is deterministic, so even the "unsorted"
    // mode has to take `ORDER BY <pk>` — which also fixes a silent pre-existing bug: `LIMIT/OFFSET` without an
    // `ORDER BY` lets the server return the same row on two different pages.
    let sort_col = sort_by
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(safe_ident)
        .or_else(|| seek_col.clone());
    let desc = matches!(sort_dir.as_deref(), Some(d) if d.eq_ignore_ascii_case("desc"));
    let dir = if desc { "DESC" } else { "ASC" };
    let order_clause = match &sort_col {
        Some(col) => format!(" ORDER BY {q}{col}{q} {dir}"),
        None => String::new(),
    };

    // Keyset ("seek") pagination. A cursor only means anything for the exact column it was taken from, so it is only
    // used when the order in force IS that seek column: sorting by another column makes the frontend stop sending
    // `seek_column`, and this condition is the second line of defence.
    let seek_active = seek_col.as_ref().filter(|c| sort_col.as_deref() == Some(c.as_str()));
    let seek_clause = match (seek_active, cursor.as_deref().filter(|s| !s.is_empty())) {
        (Some(col), Some(v)) => {
            let op = if desc { "<" } else { ">" };
            let lit = sql_str(v);
            // Always a string literal, even for a numeric key: the COLUMN's type decides the comparison, so
            // `id > '500'` still compares numerically. Inferring the type from the value would make a `varchar` key
            // holding digits compare as a number while `ORDER BY` compares it as a string — two different orders, and the
            // next page silently skips rows.
            Some(format!("{q}{col}{q} {op} '{lit}'"))
        }
        _ => None,
    };

    // The page's WHERE = filter + cursor. The filter MUST be parenthesised: `a = 1 OR b = 2` joined straight
    // with AND becomes `a = 1 OR (b = 2 AND pk > …)`, i.e. a filter nothing like what the user asked for.
    let row_where = match (filter_body, &seek_clause) {
        (Some(f), Some(seek)) => format!(" WHERE ({f}) AND {seek}"),
        (Some(f), None) => format!(" WHERE {f}"),
        (None, Some(seek)) => format!(" WHERE {seek}"),
        (None, None) => String::new(),
    };

    // The cursor REPLACES the offset, it is not added to it: that is the whole point of this phase — a deep page no
    // longer has to read and throw away the first n rows.
    let offset = if seek_clause.is_some() { 0 } else { (page.saturating_sub(1)) * limit };
    // Read ONE row more than the page needs: whether a next page exists is then a fact about the
    // rows, not a division of a row count that may be an estimate — and it costs nothing.
    let fetch_limit = limit.saturating_add(1);
    let sql = format!(
        "SELECT * FROM {table_ref}{row_where}{order_clause} LIMIT {fetch_limit} OFFSET {offset}",
        table_ref = table_ref, row_where = row_where, order_clause = order_clause, fetch_limit = fetch_limit, offset = offset
    );
    // The count is over the whole filtered set, so it uses `where_clause` (without the cursor) — otherwise
    // every page would report a smaller total than the last.
    let count_sql = format!(
        "SELECT COUNT(*) FROM {table_ref}{where_clause}",
        table_ref = table_ref, where_clause = where_clause
    );

    let mut rows_json = Vec::new();
    let mut columns = Vec::new();

    match &conn_type.kind {
        DbKind::Sqlite(conn_arc) => {
            let conn = conn_arc.lock().map_err(|e| e.to_string())?;

            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let col_count = stmt.column_count();
            for i in 0..col_count {
                columns.push(stmt.column_name(i).map_err(|e| e.to_string())?.to_string());
            }
            uniquify_columns(&mut columns);

            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let mut map = serde_json::Map::new();
                for i in 0..col_count {
                    let col_name = columns[i].clone();
                    let val: Value = match row.get_ref(i) {
                        Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                        Ok(rusqlite::types::ValueRef::Integer(n)) => json!(n),
                        Ok(rusqlite::types::ValueRef::Real(r)) => json!(r),
                        Ok(rusqlite::types::ValueRef::Text(t)) => json!(String::from_utf8_lossy(t)),
                        Ok(rusqlite::types::ValueRef::Blob(b)) => json!(b),
                        _ => Value::Null,
                    };
                    map.insert(col_name, val);
                }
                rows_json.push(Value::Object(map));
            }
        }
        _ => {
            let result = with_timeout(limit_dur, execute_raw_sql_generic(&conn_type, sql.clone())).await?;
            if let Some(first_res) = result.first() {
                if let Some(data) = first_res.get("data").and_then(|v| v.as_array()) {
                    rows_json = data.clone();
                }
                if let Some(cols) = first_res.get("columns").and_then(|v| v.as_array()) {
                    columns = cols.iter().filter_map(|c| c.as_str().map(|s| s.to_string())).collect();
                }
            }
        }
    }

    // The extra row read above never reaches the frontend — it only answers "is there a next page".
    let has_more = rows_json.len() > limit as usize;
    rows_json.truncate(limit as usize);

    // The cursor for the next page: the seek column's value on the LAST row of this page (after the extra probe row
    // has been trimmed), as an exact string. It has to be taken in Rust rather than read off the JSON row by the frontend: an
    // i64 key above 2^53 (a snowflake id) loses its last digits going through JS's `JSON.parse`, and a cursor
    // off by one makes the next page skip a row — no error, no trace.
    let next_cursor = if has_more {
        seek_active
            .and_then(|col| rows_json.last()?.get(col.as_str()))
            .and_then(scalar_to_cursor)
    } else {
        None
    };

    // Counting is the expensive half of this command: it re-scans the whole table (or the whole
    // filter) while the page itself touches `limit` rows. Paging, sorting and resizing a page
    // cannot change the answer, so the grid asks for it only when the table, the filter or the
    // data itself changed — see `gridPaging.ts`.
    let mode = count_mode.as_deref().unwrap_or("exact");
    let (total_count, count_exact) = if mode == "skip" {
        (None, None)
    } else {
        // An estimate cannot answer a WHERE clause, so a filtered view is always counted for real.
        let approx = if mode == "auto" && where_clause.is_empty() {
            estimate_row_count(&conn_type, &schema, &name).await
        } else {
            None
        };
        match approx {
            Some(n) => (Some(n), Some(false)),
            // A count that runs out of time returns `None`, not an error: the data rows are already there, and the UI
            // knows how to show "total unknown" (phase 2). Killing the whole page over the number in the status bar
            // would turn an inconvenience into an incident.
            None => match limit_dur {
                None => (exact_row_count(&conn_type, &count_sql).await, Some(true)),
                Some(d) => (
                    tokio::time::timeout(d, exact_row_count(&conn_type, &count_sql))
                        .await
                        .unwrap_or(None),
                    Some(true),
                ),
            },
        }
    };

    Ok(json!({
        "success": true,
        "data": rows_json,
        "columns": columns,
        // `null`, not 0: "not counted" and "no rows" must not look the same on the frontend.
        "totalCount": total_count,
        "countExact": count_exact,
        "hasMore": has_more,
        // Pass it straight back on the next call to get the following page. `null` = seeking is not possible (there is no next
        // page, or the key is neither a number nor a string) and the frontend goes back to page numbers.
        "nextCursor": next_cursor
    }))
}).await
}
