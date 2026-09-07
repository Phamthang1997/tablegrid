//! `get_database_stats` — the overview numbers of the database currently open (Database Info).

use super::cells::{get_mysql_i64_cell, get_pg_i64_cell};
use crate::database::DbKind;
use serde_json::{Value, json};

#[tauri::command]
pub async fn get_database_stats(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let (conn_clone, _db_type) = {
        // `acquire` returns `"Chưa kết nối CSDL"` where it used to be `"Chưa kết nối database"`; both
        // literals already mapped to `backend.notConnected` in `backendErrors.ts`, so the UI is unchanged.
        let ctx = state.connections.acquire(&conn_id)?;
        (ctx.conn().clone(), ctx.server().db_type.clone())
    };

    match &conn_clone.kind {
        DbKind::Sqlite(sqlite_conn) => {
            let conn = sqlite_conn.lock().map_err(|e| e.to_string())?;

            let page_size: i64 = conn.query_row("PRAGMA page_size;", [], |r| r.get(0)).unwrap_or(4096);
            let page_count: i64 = conn.query_row("PRAGMA page_count;", [], |r| r.get(0)).unwrap_or(0);
            let total_size_bytes = page_size * page_count;

            let mut stmt = conn.prepare(
                "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type ASC, name ASC;"
            ).map_err(|e| e.to_string())?;

            let items: Vec<(String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();

            let mut tables = Vec::new();
            let mut total_rows: i64 = 0;
            let mut total_tables_count: usize = 0;

            for (name, obj_type) in items {
                let is_view = obj_type == "view";
                let kind = if is_view { "VIEW" } else { "TABLE" };
                let count = if is_view {
                    0
                } else {
                    let sql = format!("SELECT COUNT(*) FROM \"{}\"", name.replace('"', "\"\""));
                    conn.query_row(&sql, [], |r| r.get(0)).unwrap_or(0).max(0)
                };

                if !is_view {
                    total_tables_count += 1;
                    total_rows += count;
                }

                tables.push(json!({
                    "table_name": name,
                    "schema": "main",
                    "kind": kind,
                    "charset": "UTF-8",
                    "rows": count,
                    "is_exact": !is_view,
                    "data_size_bytes": Value::Null,
                    "index_size_bytes": Value::Null,
                    "total_size_bytes": Value::Null,
                    "engine": if is_view { "" } else { "SQLite" },
                    "collation": Value::Null,
                    "comment": if is_view { "VIEW" } else { "" }
                }));
            }

            Ok(json!({
                "db_name": "SQLite Database",
                "db_type": "sqlite",
                "total_size_bytes": total_size_bytes,
                "total_tables": total_tables_count,
                "total_rows": total_rows,
                "tables": tables
            }))
        }
        DbKind::Postgres(pool) => {
            let db_name: String = sqlx::query_scalar("SELECT current_database()")
                .fetch_one(pool)
                .await
                .unwrap_or_else(|_| "PostgreSQL".into());

            let total_size_bytes: i64 = sqlx::query_scalar("SELECT pg_database_size(current_database())")
                .fetch_one(pool)
                .await
                .unwrap_or(0);

            let rows = sqlx::query(
                r#"
                SELECT
                    n.nspname AS schema_name,
                    c.relname AS table_name,
                    CASE WHEN c.relkind = 'v' THEN 'VIEW' ELSE 'TABLE' END AS kind,
                    GREATEST(COALESCE(c.reltuples::bigint, 0), 0) AS estimated_rows,
                    pg_total_relation_size(c.oid) AS total_size_bytes,
                    pg_relation_size(c.oid) AS data_size_bytes,
                    pg_indexes_size(c.oid) AS index_size_bytes,
                    COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname IN ('public', current_schema())
                  AND c.relkind IN ('r', 'p', 'v')
                ORDER BY pg_total_relation_size(c.oid) DESC, c.relname ASC;
                "#
            )
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;

            use sqlx::Row;
            let mut tables = Vec::new();
            let mut total_rows: i64 = 0;
            let mut total_tables_count: usize = 0;

            for r in &rows {
                let schema_name: String = r.get("schema_name");
                let name: String = r.get("table_name");
                let kind: String = r.get("kind");
                let is_view = kind == "VIEW";
                let count = get_pg_i64_cell(r, "estimated_rows").max(0);
                let total_sz = get_pg_i64_cell(r, "total_size_bytes").max(0);
                let data_sz = get_pg_i64_cell(r, "data_size_bytes").max(0);
                let idx_sz = get_pg_i64_cell(r, "index_size_bytes").max(0);
                let comment: String = r.get("comment");

                if !is_view {
                    total_tables_count += 1;
                    total_rows += count;
                }

                tables.push(json!({
                    "table_name": name,
                    "schema": schema_name,
                    "kind": kind,
                    "charset": Value::Null,
                    "rows": count,
                    "is_exact": false,
                    "data_size_bytes": if is_view { Value::Null } else { json!(data_sz) },
                    "index_size_bytes": if is_view { Value::Null } else { json!(idx_sz) },
                    "total_size_bytes": if is_view { Value::Null } else { json!(total_sz) },
                    "engine": if is_view { "" } else { "PostgreSQL" },
                    "collation": Value::Null,
                    "comment": comment
                }));
            }

            Ok(json!({
                "db_name": db_name,
                "db_type": "postgres",
                "total_size_bytes": total_size_bytes,
                "total_tables": total_tables_count,
                "total_rows": total_rows,
                "tables": tables
            }))
        }
        DbKind::Mysql(pool) => {
            let db_name: String = sqlx::query_scalar("SELECT DATABASE()")
                .fetch_one(pool)
                .await
                .unwrap_or_else(|_| "MySQL".into());

            let rows = sqlx::query(
                r#"
                SELECT
                    TABLE_NAME AS table_name,
                    TABLE_SCHEMA AS schema_name,
                    CASE WHEN TABLE_TYPE = 'VIEW' THEN 'VIEW' ELSE 'TABLE' END AS kind,
                    COALESCE(TABLE_ROWS, 0) AS estimated_rows,
                    COALESCE(DATA_LENGTH, 0) AS data_size_bytes,
                    COALESCE(INDEX_LENGTH, 0) AS index_size_bytes,
                    COALESCE(DATA_LENGTH + INDEX_LENGTH, 0) AS total_size_bytes,
                    COALESCE(ENGINE, '') AS engine,
                    TABLE_COLLATION AS collation,
                    COALESCE(TABLE_COMMENT, '') AS comment
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE()
                ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC, TABLE_NAME ASC;
                "#
            )
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;

            use sqlx::Row;
            let mut tables = Vec::new();
            let mut total_rows: i64 = 0;
            let mut total_size_bytes: i64 = 0;
            let mut total_tables_count: usize = 0;

            for r in &rows {
                let name: String = r.get("table_name");
                let schema_name: String = r.get("schema_name");
                let kind: String = r.get("kind");
                let is_view = kind == "VIEW";
                let count = get_mysql_i64_cell(r, "estimated_rows").max(0);
                let data_sz = get_mysql_i64_cell(r, "data_size_bytes").max(0);
                let idx_sz = get_mysql_i64_cell(r, "index_size_bytes").max(0);
                let total_sz = get_mysql_i64_cell(r, "total_size_bytes").max(0);
                let engine: String = r.get("engine");
                let collation: Option<String> = r.get("collation");
                let comment: String = r.get("comment");
                let charset = collation.as_deref().and_then(|c| c.split('_').next()).map(|s| s.to_string());

                if !is_view {
                    total_tables_count += 1;
                    total_rows += count;
                    total_size_bytes += total_sz;
                }

                tables.push(json!({
                    "table_name": name,
                    "schema": schema_name,
                    "kind": kind,
                    "charset": charset,
                    "rows": count,
                    "is_exact": false,
                    "data_size_bytes": if is_view { Value::Null } else { json!(data_sz) },
                    "index_size_bytes": if is_view { Value::Null } else { json!(idx_sz) },
                    "total_size_bytes": if is_view { Value::Null } else { json!(total_sz) },
                    "engine": engine,
                    "collation": collation,
                    "comment": comment
                }));
            }

            Ok(json!({
                "db_name": db_name,
                "db_type": "mysql",
                "total_size_bytes": total_size_bytes,
                "total_tables": total_tables_count,
                "total_rows": total_rows,
                "tables": tables
            }))
        }
    }
}).await
}
