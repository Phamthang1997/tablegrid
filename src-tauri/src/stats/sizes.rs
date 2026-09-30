//! `get_all_databases_sizes` — phase 2 of the dashboard: the expensive part (scanning every table).

use super::cells::get_mysql_i64_cell;
use super::probe::{pg_count_tables_rows, pg_count_tables_rows_remote, sqlite_table_names};
use super::system_dbs::{is_system_db, system_db_sql_list};
use crate::database::DbKind;

/// One database's probe result: its name, and either `(tables, rows)` or why the probe failed.
///
/// Named because the tuple is nested three deep inline, which is what `clippy::type_complexity`
/// objects to — and it is right: the shape says nothing about which number is which.
type ProbedDatabase = (String, Result<(i64, i64), String>);
use serde_json::{Value, json};

// Phase 2 (see the note on `get_all_databases_stats`): the numbers that require opening or
// scanning every table. Each database carries ONLY the fields this phase actually knows,
// the rest are null, so the frontend can merge onto phase 1 without erasing what it has.
#[tauri::command]
pub async fn get_all_databases_sizes(
    conn_id: String,
    include_system: Option<bool>,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let include_system = include_system.unwrap_or(false);

        let (conn_clone, config, tunnel_port) = {
            let ctx = state.connections.acquire(&conn_id)?;
            (
                ctx.conn().clone(),
                ctx.server().config(),
                ctx.server().ssh_tunnel.as_ref().map(|t| t.local_port),
            )
        };

        match &conn_clone.kind {
            DbKind::DuckDb(_) => Err(crate::database::DUCK_UNSUPPORTED.to_string()),
            DbKind::Sqlite(sqlite_conn) => {
                let conn = sqlite_conn.lock().map_err(|e| e.to_string())?;

                let schemas: Vec<String> = {
                    let mut stmt = conn
                        .prepare("PRAGMA database_list;")
                        .map_err(|e| e.to_string())?;
                    stmt.query_map([], |r| r.get::<_, String>(1))
                        .map_err(|e| e.to_string())?
                        .filter_map(|r| r.ok())
                        .collect()
                };

                let mut databases = Vec::new();
                for schema in schemas {
                    let q = schema.replace('"', "\"\"");
                    let names = sqlite_table_names(&conn, &q);
                    let mut total_rows: i64 = 0;
                    for name in &names {
                        let sql = format!(
                            "SELECT COUNT(*) FROM \"{}\".\"{}\"",
                            q,
                            name.replace('"', "\"\"")
                        );
                        total_rows += conn
                            .query_row(&sql, [], |r| r.get::<_, i64>(0))
                            .unwrap_or(0)
                            .max(0);
                    }
                    databases.push(json!({
                        // The frontend matches rows on `schema_name` first, `db_name` second —
                        // SQLite shows the file path as the name, so only `schema_name` matches.
                        "db_name": Value::Null,
                        "schema_name": schema,
                        "total_tables": names.len(),
                        "total_rows": total_rows,
                        "data_size_bytes": Value::Null,
                        "index_size_bytes": Value::Null,
                        "total_size_bytes": Value::Null,
                        "error": Value::Null
                    }));
                }

                Ok(json!({ "databases": databases }))
            }
            DbKind::Postgres(pool) => {
                let current_db: String = sqlx::query_scalar("SELECT current_database()")
                    .fetch_one(pool)
                    .await
                    .unwrap_or_default();

                let names: Vec<String> = sqlx::query_scalar(
                    r#"
                SELECT d.datname
                FROM pg_database d
                WHERE d.datistemplate = false
                  AND d.datallowconn = true
                  AND has_database_privilege(d.datname, 'CONNECT')
                "#,
                )
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;

                let mut databases = Vec::new();

                // The open database: reuse the current pool, don't open another connection.
                match pg_count_tables_rows(pool).await {
                    Ok((t, rw)) => databases.push(json!({
                        "db_name": current_db.clone(), "schema_name": Value::Null,
                        "total_tables": t, "total_rows": rw,
                        "data_size_bytes": Value::Null, "index_size_bytes": Value::Null,
                        "total_size_bytes": Value::Null, "error": Value::Null
                    })),
                    Err(e) => databases.push(json!({
                        "db_name": current_db.clone(), "schema_name": Value::Null,
                        "total_tables": Value::Null, "total_rows": Value::Null,
                        "data_size_bytes": Value::Null, "index_size_bytes": Value::Null,
                        "total_size_bytes": Value::Null, "error": e
                    })),
                }

                let mut url_conf = config.clone();
                if let (Some(obj), Some(port)) = (url_conf.as_object_mut(), tunnel_port) {
                    obj.insert("host".to_string(), json!("127.0.0.1"));
                    obj.insert("port".to_string(), json!(port));
                }

                let targets: Vec<(String, String)> = names
                    .iter()
                    .filter(|n| {
                        **n != current_db
                            && (include_system || !is_system_db("postgres", n.as_str()))
                    })
                    .map(|n| {
                        (
                            n.clone(),
                            crate::database::build_pg_url(&url_conf, Some(n.as_str())),
                        )
                    })
                    .collect();

                // Each database means a fresh connection, so run them with bounded concurrency
                // instead of serially: 20 databases × ~200ms of handshake is 4s of pure waiting.
                use futures_util::StreamExt;
                let results: Vec<ProbedDatabase> =
                    futures_util::stream::iter(targets)
                        .map(|(name, url)| async move {
                            (name, pg_count_tables_rows_remote(&url).await)
                        })
                        .buffer_unordered(4)
                        .collect()
                        .await;

                for (name, res) in results {
                    let (t, rw, err) = match res {
                        Ok((t, rw)) => (Some(t), Some(rw), None),
                        Err(e) => (None, None, Some(e)),
                    };
                    databases.push(json!({
                        "db_name": name, "schema_name": Value::Null,
                        "total_tables": t, "total_rows": rw,
                        "data_size_bytes": Value::Null, "index_size_bytes": Value::Null,
                        "total_size_bytes": Value::Null, "error": err
                    }));
                }

                Ok(json!({ "databases": databases }))
            }
            DbKind::Mysql(pool) => {
                // ONE connection for both statements: `SET SESSION` only affects the session that
                // runs the query after it, and the pool hands out a different one each call.
                let mut c = pool.acquire().await.map_err(|e| e.to_string())?;

                // MySQL 8: read the statistics already cached in `mysql.table_stats` instead of
                // measuring every table again. The server default is 86400, but plenty of setups
                // lower it to 0 to keep the numbers fresh — and then the query below opens as many
                // tables as the server has. MySQL 5.7 / MariaDB have no such variable, so an error
                // here is expected and ignored.
                let _ = sqlx::query("SET SESSION information_schema_stats_expiry = 86400")
                    .execute(&mut *c)
                    .await;

                // Skip system schemas entirely while the UI hides them: performance_schema + sys +
                // mysql add up to a few hundred tables, i.e. a few hundred table opens for rows
                // the user cannot even see.
                let filter = if include_system {
                    String::new()
                } else {
                    format!("AND TABLE_SCHEMA NOT IN ({})", system_db_sql_list("mysql"))
                };
                let sql = format!(
                    r#"
                SELECT
                    TABLE_SCHEMA AS db_name,
                    COUNT(*) AS total_tables,
                    COALESCE(SUM(TABLE_ROWS), 0) AS total_rows,
                    COALESCE(SUM(DATA_LENGTH), 0) AS data_size_bytes,
                    COALESCE(SUM(INDEX_LENGTH), 0) AS index_size_bytes,
                    COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS total_size_bytes
                FROM information_schema.TABLES
                WHERE TABLE_TYPE = 'BASE TABLE' {}
                GROUP BY TABLE_SCHEMA;
                "#,
                    filter
                );

                let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
                    .fetch_all(&mut *c)
                    .await
                    .map_err(|e| e.to_string())?;

                use sqlx::Row;
                let mut databases = Vec::new();
                for r in &rows {
                    let name: String = r.get("db_name");
                    databases.push(json!({
                        "db_name": name,
                        "schema_name": Value::Null,
                        "total_tables": get_mysql_i64_cell(r, "total_tables").max(0),
                        "total_rows": get_mysql_i64_cell(r, "total_rows").max(0),
                        "data_size_bytes": get_mysql_i64_cell(r, "data_size_bytes").max(0),
                        "index_size_bytes": get_mysql_i64_cell(r, "index_size_bytes").max(0),
                        "total_size_bytes": get_mysql_i64_cell(r, "total_size_bytes").max(0),
                        "error": Value::Null
                    }));
                }

                Ok(json!({ "databases": databases }))
            }
        }
    })
    .await
}
