//! Funnel 1: run raw SQL with no parameters. The path almost every command in the app takes.

use std::sync::{Arc, Mutex};

use rusqlite::Connection as SqliteConnection;
use serde_json::{Value, json};
use sqlx::{Column, Executor, Row, SqlSafeStr, Statement, ValueRef};

use super::super::conn::{DbConnection, DbKind};
use super::super::decode::{decode_mysql_cell, decode_pg_cell};
use super::super::read_only::reject_if_read_only;
use super::super::rows::uniquify_columns;

// Utility: executes raw SQL statements across all databases and maps to standard outputs
// MySQL reports 1295 "This command is not supported in the prepared statement protocol yet" for
// CREATE/DROP TRIGGER, PROCEDURE, FUNCTION, EVENT... Those statements have to be sent over the text protocol
// (sqlx::raw_sql) instead of sqlx::query.
pub(crate) fn is_mysql_unprepared_error(err_text: &str) -> bool {
    err_text.contains("1295")
        || err_text.contains("not supported in the prepared statement protocol")
}

/// Funnel 1, the routed door: what every command in the app calls.
///
/// Three questions in order — may this connection be written to, does this statement belong to a
/// manual transaction session, and only then, run it.
pub(crate) async fn execute_raw_sql_generic(
    conn: &DbConnection,
    sql: String,
) -> Result<Vec<Value>, String> {
    reject_if_read_only(conn, &sql)?;
    // Manual transaction mode: the statement must run on the connection the transaction was opened
    // on, otherwise it neither sees nor joins the uncommitted work. See tx/.
    if crate::tx::should_route(conn, &sql) {
        return crate::tx::run_raw(conn, sql).await;
    }
    execute_raw_sql_pooled(conn, sql).await
}

/// The same funnel with the routing question removed: always a pooled connection.
///
/// This exists for the MCP server (`docs/mcp-server-plan.md` §2.2) and should not be reached for
/// anything the user typed. `should_route()` answers `true` whenever the connection is in manual
/// mode — *before* it looks at who sent the statement — so an AI client reading through the routed
/// door would issue `BEGIN` on the user's session and light up a transaction they never opened. A
/// third party's read must not be able to do that.
///
/// The read-only check is repeated here rather than left to the caller: it is one comparison, and
/// making it the caller's job is how a door ends up unguarded.
///
/// Two consequences, both deliberate and both documented for users. On Postgres and MySQL a caller
/// coming through here sees only COMMITTED state — the same semantics `compare/` needs, and the
/// reason it reads through a pool too. On SQLite there is no difference at all: `DbKind::Sqlite` is
/// a single shared handle, so it observes the open transaction either way, and a second handle on
/// one file is the `SQLITE_BUSY` that `find_sqlite()` exists to prevent.
pub(crate) async fn execute_raw_sql_pooled(
    conn: &DbConnection,
    sql: String,
) -> Result<Vec<Value>, String> {
    reject_if_read_only(conn, &sql)?;
    match &conn.kind {
        DbKind::Sqlite(conn_arc) => sqlite_raw(conn_arc, &sql),
        DbKind::Postgres(pool) => {
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            pg_raw(&mut conn, &sql).await
        }
        DbKind::Mysql(pool) => {
            // Take a single connection out of the pool to run the statement, so SET FOREIGN_KEY_CHECKS holds for the whole session
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            mysql_raw(&mut conn, &sql).await
        }
    }
}

// The three functions below are the row-building bodies that used to sit inline in
// `execute_raw_sql_generic`. They are split out so the SAME code runs whether the connection came
// from the pool or from the pinned manual-transaction session (tx/) — duplicating them
// would mean duplicating the two rules that every row-building site in this file must follow:
// `uniquify_columns` before any row is assembled, and cell decoding BY INDEX.

pub(crate) fn sqlite_raw(
    conn_arc: &Arc<Mutex<SqliteConnection>>,
    sql: &str,
) -> Result<Vec<Value>, String> {
    let conn = conn_arc.lock().map_err(|e| e.to_string())?;
    sqlite_raw_on(&conn, sql)
}

/// The body of `sqlite_raw`, on a connection the caller has ALREADY locked.
///
/// Split out for `mcp/exec.rs`, which has to set a pragma, run the statement and restore the pragma
/// inside one hold of the lock - taking it a second time here would open the window it closes.
pub(crate) fn sqlite_raw_on(conn: &SqliteConnection, sql: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let col_count = stmt.column_count();
    let mut columns = Vec::new();
    for i in 0..col_count {
        columns.push(stmt.column_name(i).map_err(|e| e.to_string())?.to_string());
    }
    uniquify_columns(&mut columns);

    let mut rows_json = Vec::new();
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
    Ok(vec![json!({ "columns": columns, "data": rows_json })])
}

pub(crate) async fn pg_raw(conn: &mut sqlx::PgConnection, sql: &str) -> Result<Vec<Value>, String> {
    let mut results = Vec::new();
    if sql.to_uppercase().trim().starts_with("USE ")
        || sql.to_uppercase().trim().starts_with("CREATE DATABASE")
    {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(results);
    }
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    let mut rows_json = Vec::new();
    let mut columns = Vec::new();
    if !rows.is_empty() {
        for col in rows[0].columns() {
            columns.push(col.name().to_string());
        }
        uniquify_columns(&mut columns);
        for r in rows {
            let mut map = serde_json::Map::new();
            // By index, not name — see decode_pg_cell!.
            for (i, col_name) in columns.iter().enumerate() {
                let val: Value = decode_pg_cell!(&r, i);
                map.insert(col_name.clone(), val);
            }
            rows_json.push(Value::Object(map));
        }
    } else {
        // Prepare on THIS connection, not on the pool: inside a manual transaction a second
        // connection would block on the locks this one holds.
        if let Ok(stmt) = (&mut *conn)
            .prepare(sqlx::AssertSqlSafe(sql.to_string()).into_sql_str())
            .await
        {
            for col in stmt.columns() {
                columns.push(col.name().to_string());
            }
            uniquify_columns(&mut columns);
        }
    }
    results.push(json!({ "columns": columns, "data": rows_json }));
    Ok(results)
}

pub(crate) async fn mysql_raw(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
) -> Result<Vec<Value>, String> {
    let mut results = Vec::new();
    if sql.to_uppercase().trim().starts_with("USE ")
        || sql.to_uppercase().trim().starts_with("CREATE DATABASE")
    {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(results);
    }
    let rows = match sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_all(&mut *conn)
        .await
    {
        Ok(r) => r,
        Err(e) if is_mysql_unprepared_error(&e.to_string()) => {
            // MySQL refuses to prepare some statements (CREATE/DROP TRIGGER, PROCEDURE,
            // FUNCTION, EVENT...) -> rerun them over the text protocol.
            sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string()))
                .execute(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
            Vec::new()
        }
        Err(e) => return Err(e.to_string()),
    };
    let mut rows_json = Vec::new();
    let mut columns = Vec::new();
    if !rows.is_empty() {
        for col in rows[0].columns() {
            columns.push(col.name().to_string());
        }
        uniquify_columns(&mut columns);
        for r in rows {
            let mut map = serde_json::Map::new();
            // By index, not name — see decode_mysql_cell!.
            for (i, col_name) in columns.iter().enumerate() {
                let val: Value = decode_mysql_cell!(&r, i);
                map.insert(col_name.clone(), val);
            }
            rows_json.push(Value::Object(map));
        }
    } else {
        // Same reason as the Postgres branch: prepare on this connection.
        if let Ok(stmt) = (&mut *conn)
            .prepare(sqlx::AssertSqlSafe(sql.to_string()).into_sql_str())
            .await
        {
            for col in stmt.columns() {
                columns.push(col.name().to_string());
            }
            uniquify_columns(&mut columns);
        }
    }
    results.push(json!({ "columns": columns, "data": rows_json }));
    Ok(results)
}
