//! `get_all_databases_stats` — phase 1 of the dashboard: reads the data dictionary, returns almost instantly.

use super::cells::{get_mysql_i64_cell, get_pg_i64_cell};
use super::probe::{pg_count_tables_rows, sqlite_table_names};
use super::system_dbs::is_system_db;
use crate::database::DbKind;
use serde_json::{Value, json};
use std::collections::HashMap;

// Deliberately split into two phases:
//  - `get_all_databases_stats` (phase 1) reads the data dictionary only — database names,
//    charset, plus whatever size one cheap query yields — so it returns almost instantly.
//  - `get_all_databases_sizes` (phase 2) does the expensive part: on MySQL the
//    DATA_LENGTH/INDEX_LENGTH/TABLE_ROWS columns are *dynamic statistics*, so the server
//    opens EVERY table to gather them (5.7 on every query, 8.0 whenever the
//    `mysql.table_stats` cache has expired per `information_schema_stats_expiry`) — a few
//    thousand tables means tens of seconds; SQLite has to COUNT(*) each table; Postgres
//    has to open a connection to each database.
// The frontend draws the list from phase 1 and fills in phase 2's numbers as they land.
#[tauri::command]
pub async fn get_all_databases_stats(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let conn_clone = {
            let ctx = state.connections.acquire(&conn_id)?;
            ctx.conn().clone()
        };

        match &conn_clone.kind {
            DbKind::DuckDb(_) => Err(crate::database::DUCK_UNSUPPORTED.to_string()),
            DbKind::Sqlite(sqlite_conn) => {
                // SQLite: "every database" = the main database + the ATTACHed ones.
                let conn = sqlite_conn.lock().map_err(|e| e.to_string())?;

                let entries: Vec<(String, Option<String>)> = {
                    let mut stmt = conn
                        .prepare("PRAGMA database_list;")
                        .map_err(|e| e.to_string())?;
                    let rows: Vec<(String, Option<String>)> = stmt
                        .query_map([], |r| {
                            Ok((r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?))
                        })
                        .map_err(|e| e.to_string())?
                        .filter_map(|r| r.ok())
                        .collect();
                    rows
                };

                let mut databases = Vec::new();

                for (schema, file) in entries {
                    let q = schema.replace('"', "\"\"");
                    let page_size: i64 = conn
                        .query_row(&format!("PRAGMA \"{}\".page_size;", q), [], |r| r.get(0))
                        .unwrap_or(0);
                    let page_count: i64 = conn
                        .query_row(&format!("PRAGMA \"{}\".page_count;", q), [], |r| r.get(0))
                        .unwrap_or(0);

                    // Table count only (reads sqlite_master); COUNT(*) per table is phase 2.
                    let table_count = sqlite_table_names(&conn, &q).len();

                    // The display name prefers the file path; a temporary/in-memory database has no file.
                    let display_name = file
                        .filter(|f| !f.is_empty())
                        .unwrap_or_else(|| schema.clone());
                    let is_current = schema == "main";

                    databases.push(json!({
                        "db_name": display_name,
                        "schema_name": schema,
                        "is_system": false,
                        "is_current": is_current,
                        "total_tables": table_count,
                        "total_rows": Value::Null,
                        "data_size_bytes": Value::Null,
                        "index_size_bytes": Value::Null,
                        "total_size_bytes": page_size * page_count,
                        "charset": "UTF-8",
                        "collation": Value::Null,
                        "error": Value::Null
                    }));
                }

                Ok(json!({
                    "db_type": "sqlite",
                    "current_db": "main",
                    "metrics_pending": !databases.is_empty(),
                    "metrics_manual": false,
                    "rows_are_exact": true,
                    "databases": databases
                }))
            }
            DbKind::Postgres(pool) => {
                let current_db: String = sqlx::query_scalar("SELECT current_database()")
                    .fetch_one(pool)
                    .await
                    .unwrap_or_default();

                // pg_database_size() errors out when the user has no CONNECT privilege, so filter first.
                let rows = sqlx::query(
                    r#"
                SELECT
                    d.datname AS db_name,
                    pg_database_size(d.datname) AS total_size_bytes,
                    pg_encoding_to_char(d.encoding) AS charset,
                    d.datcollate AS collation
                FROM pg_database d
                WHERE d.datistemplate = false
                  AND d.datallowconn = true
                  AND has_database_privilege(d.datname, 'CONNECT')
                ORDER BY pg_database_size(d.datname) DESC;
                "#,
                )
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;

                use sqlx::Row;
                let mut databases = Vec::new();
                let mut pending = false;

                for r in &rows {
                    let name: String = r.get("db_name");
                    let is_current = name == current_db;
                    let charset: Option<String> = r.try_get("charset").ok();
                    let collation: Option<String> = r.try_get("collation").ok();

                    // The connected database's table/row counts come for free here (pg_class only
                    // sees the current database); every other database is phase 2's job.
                    let (tables, total_rows, err) = if is_current {
                        match pg_count_tables_rows(pool).await {
                            Ok((t, rw)) => (Some(t), Some(rw), None),
                            Err(e) => (None, None, Some(e)),
                        }
                    } else {
                        pending = true;
                        (None, None, None)
                    };

                    databases.push(json!({
                        "db_name": name.clone(),
                        "schema_name": Value::Null,
                        "is_system": is_system_db("postgres", &name),
                        "is_current": is_current,
                        "total_tables": tables,
                        "total_rows": total_rows,
                        "data_size_bytes": Value::Null,
                        "index_size_bytes": Value::Null,
                        "total_size_bytes": get_pg_i64_cell(r, "total_size_bytes").max(0),
                        "charset": charset,
                        "collation": collation,
                        "error": err
                    }));
                }

                Ok(json!({
                    "db_type": "postgres",
                    "current_db": current_db,
                    "metrics_pending": pending,
                    // Counting tables/rows of another Postgres database needs a NEW connection to
                    // it, so phase 2 never starts on its own: the user presses "deep scan".
                    "metrics_manual": true,
                    "rows_are_exact": false,
                    "databases": databases
                }))
            }
            DbKind::Mysql(pool) => {
                let current_db: String = sqlx::query_scalar("SELECT COALESCE(DATABASE(), '')")
                    .fetch_one(pool)
                    .await
                    .unwrap_or_default();

                // Two CHEAP queries: SCHEMATA and the table count. Deliberately selects nothing
                // from the dynamic-statistics family — asking for table names alone lets MySQL
                // answer from the data dictionary without opening a single table.
                let schemas = sqlx::query(
                    r#"
                SELECT
                    s.SCHEMA_NAME AS db_name,
                    s.DEFAULT_CHARACTER_SET_NAME AS charset,
                    s.DEFAULT_COLLATION_NAME AS collation
                FROM information_schema.SCHEMATA s
                ORDER BY s.SCHEMA_NAME ASC;
                "#,
                )
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;

                let count_rows = sqlx::query(
                    r#"
                SELECT TABLE_SCHEMA AS db_name, COUNT(*) AS total_tables
                FROM information_schema.TABLES
                WHERE TABLE_TYPE = 'BASE TABLE'
                GROUP BY TABLE_SCHEMA;
                "#,
                )
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;

                use sqlx::Row;
                let mut counts: HashMap<String, i64> = HashMap::new();
                for r in &count_rows {
                    let name: String = r.get("db_name");
                    counts.insert(name, get_mysql_i64_cell(r, "total_tables").max(0));
                }

                let mut databases = Vec::new();
                for r in &schemas {
                    let name: String = r.get("db_name");
                    let charset: Option<String> = r.try_get("charset").ok();
                    let collation: Option<String> = r.try_get("collation").ok();

                    databases.push(json!({
                        "db_name": name.clone(),
                        "schema_name": Value::Null,
                        "is_system": is_system_db("mysql", &name),
                        "is_current": name == current_db,
                        "total_tables": counts.get(&name).copied().unwrap_or(0),
                        "total_rows": Value::Null,
                        "data_size_bytes": Value::Null,
                        "index_size_bytes": Value::Null,
                        "total_size_bytes": Value::Null,
                        "charset": charset,
                        "collation": collation,
                        "error": Value::Null
                    }));
                }

                Ok(json!({
                    "db_type": "mysql",
                    "current_db": current_db,
                    "metrics_pending": !databases.is_empty(),
                    "metrics_manual": false,
                    "rows_are_exact": false,
                    "databases": databases
                }))
            }
        }
    })
    .await
}
