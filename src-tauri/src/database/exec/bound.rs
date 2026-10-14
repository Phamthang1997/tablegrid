//! Funnel 2: one statement with parameters bound at the driver level (an EXPLAIN with `:param`, …).

use std::sync::{Arc, Mutex};

use rusqlite::Connection as SqliteConnection;
use serde_json::{Value, json};
use sqlx::{Column, Row, ValueRef};

use super::super::conn::{DbConnection, DbKind};
use super::super::decode::{
    bind_mysql_params, bind_pg_params, decode_mysql_cell, decode_pg_cell, json_to_sqlite_value,
};
use super::super::read_only::reject_if_read_only;
use super::super::rows::uniquify_columns;

// Like execute_raw_sql_generic but binds the parameters at the driver level (a parameterized query).
// For ONE statement only (e.g. EXPLAIN <query with :param>) — it does not split multiple statements.
// The SQL passed in must already use native placeholders (`?` for SQLite/MySQL, `$1..$n` for Postgres).
pub(crate) async fn run_bound_query(
    conn: &DbConnection,
    sql: String,
    params: &[Value],
) -> Result<Vec<Value>, String> {
    reject_if_read_only(conn, &sql)?;
    if crate::tx::should_route(conn, &sql) {
        return crate::tx::run_bound(conn, sql, params).await;
    }
    match &conn.kind {
        DbKind::Sqlite(conn_arc) => sqlite_bound(conn_arc, &sql, params),
        DbKind::Postgres(pool) => {
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            pg_bound(&mut conn, &sql, params).await
        }
        DbKind::Mysql(pool) => {
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            mysql_bound(&mut conn, &sql, params).await
        }
        DbKind::DuckDb(arc) => super::super::duck::duck_query(arc, &sql, params).await,
    }
}

// Split out of `run_bound_query` for the same reason as `pg_raw`/`mysql_raw`: the pinned
// transaction session runs the identical body on its own connection.

pub(crate) fn sqlite_bound(
    conn_arc: &Arc<Mutex<SqliteConnection>>,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Value>, String> {
    let conn = conn_arc.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let col_count = stmt.column_count();
    let mut columns = Vec::new();
    for i in 0..col_count {
        columns.push(stmt.column_name(i).map_err(|e| e.to_string())?.to_string());
    }
    uniquify_columns(&mut columns);
    let sqlite_params: Vec<rusqlite::types::Value> =
        params.iter().map(json_to_sqlite_value).collect();
    let mut rows_json = Vec::new();
    let mut rows = stmt
        .query(rusqlite::params_from_iter(sqlite_params.iter()))
        .map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut map = serde_json::Map::new();
        for i in 0..col_count {
            let val: Value = match row.get_ref(i) {
                Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                Ok(rusqlite::types::ValueRef::Integer(n)) => json!(n),
                Ok(rusqlite::types::ValueRef::Real(r)) => json!(r),
                Ok(rusqlite::types::ValueRef::Text(t)) => json!(String::from_utf8_lossy(t)),
                Ok(rusqlite::types::ValueRef::Blob(b)) => json!(b),
                _ => Value::Null,
            };
            map.insert(columns[i].clone(), val);
        }
        rows_json.push(Value::Object(map));
    }
    Ok(vec![json!({ "columns": columns, "data": rows_json })])
}

pub(crate) async fn pg_bound(
    conn: &mut sqlx::PgConnection,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Value>, String> {
    let query = bind_pg_params(sqlx::query(sqlx::AssertSqlSafe(sql.to_string())), params);
    let rows = query
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
    }
    Ok(vec![json!({ "columns": columns, "data": rows_json })])
}

pub(crate) async fn mysql_bound(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Value>, String> {
    let query = bind_mysql_params(sqlx::query(sqlx::AssertSqlSafe(sql.to_string())), params);
    let rows = query
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
            // By index, not name — see decode_mysql_cell!.
            for (i, col_name) in columns.iter().enumerate() {
                let val: Value = decode_mysql_cell!(&r, i);
                map.insert(col_name.clone(), val);
            }
            rows_json.push(Value::Object(map));
        }
    }
    Ok(vec![json!({ "columns": columns, "data": rows_json })])
}
