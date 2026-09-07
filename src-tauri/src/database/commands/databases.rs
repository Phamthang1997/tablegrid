//! The database and schema level: listing, opening, creating, dropping, renaming — and a database's character set.

use crate::database::introspect::list_databases_inner;
use serde_json::{Value, json};
use sqlx::{MySqlPool, PgPool, Row};

use crate::database::{
    DbConnection, DbKind, all_string_values, apply_ssh_tunnel, build_mysql_url, build_pg_url,
    execute_raw_sql_generic, rows_of, sql_str,
};

use super::connection::probe_pg_schema;

// The timeout for the list-databases command (the "Load list" button on the connection form).
// sqlx defaults to 30s — far too long for a probe, and the user assumes the app has hung.
// 10s is enough even for a distant server while still failing early.
const LIST_DB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

// A minimal pool just to run one list-databases statement (1 connection, a short timeout).
async fn open_list_pool_pg(url: &str) -> Result<PgPool, String> {
    sqlx::pool::PoolOptions::<sqlx::Postgres>::new()
        .max_connections(1)
        .acquire_timeout(LIST_DB_TIMEOUT)
        .connect(url)
        .await
        .map_err(|e| e.to_string())
}

async fn open_list_pool_mysql(url: &str) -> Result<MySqlPool, String> {
    sqlx::pool::PoolOptions::<sqlx::MySql>::new()
        .max_connections(1)
        .acquire_timeout(LIST_DB_TIMEOUT)
        .connect(url)
        .await
        .map_err(|e| e.to_string())
}

// An error of the "database does not exist" kind (MySQL 1049, Postgres 3D000) is worth
// retrying against the system DB; a network/authentication error only costs another timeout to retry.
fn is_unknown_database_err(err: &str) -> bool {
    err.contains("atabase")
}

#[tauri::command]
pub async fn get_databases_list(config: Value) -> Result<Value, String> {
    Box::pin(async move {
    let db_type = config.get("dbType").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let mut databases = Vec::new();

    match db_type.as_str() {
        "postgres" => {
            // Keep the tunnel alive for the whole listing operation (when SSH is on)
            let (conn_config, _tunnel) = apply_ssh_tunnel(&config, 5432).await?;
            // Prefer the database currently typed in (a user with restricted privileges — a managed
            // cloud Postgres, say — usually only has access to their own DB). If that name
            // does not exist (half-typed), fall back to the "postgres" system DB.
            let pool = match open_list_pool_pg(&build_pg_url(&conn_config, None)).await {
                Ok(p) => p,
                Err(first) if is_unknown_database_err(&first) => {
                    open_list_pool_pg(&build_pg_url(&conn_config, Some("postgres")))
                        .await
                        .map_err(|_| first)?
                }
                Err(first) => return Err(first),
            };
            let rows = sqlx::query("SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true")
                .fetch_all(&pool)
                .await
                .map_err(|e| e.to_string())?;

            for r in rows {
                if let Ok(name) = r.try_get::<String, _>("datname") {
                    databases.push(name);
                }
            }
        }
        "mysql" => {
            let (conn_config, _tunnel) = apply_ssh_tunnel(&config, 3306).await?;
            let pool = match open_list_pool_mysql(&build_mysql_url(&conn_config, None)).await {
                Ok(p) => p,
                Err(first) if is_unknown_database_err(&first) => {
                    open_list_pool_mysql(&build_mysql_url(&conn_config, Some("mysql")))
                        .await
                        .map_err(|_| first)?
                }
                Err(first) => return Err(first),
            };
            let rows = sqlx::query("SHOW DATABASES")
                .fetch_all(&pool)
                .await
                .map_err(|e| e.to_string())?;

            for r in rows {
                if let Ok(name) = r.try_get::<String, _>(0) {
                    databases.push(name);
                }
            }
        }
        _ => return Err("Hệ quản trị CSDL không được hỗ trợ".to_string()),
    }

    databases.sort();
    Ok(json!({ "success": true, "databases": databases }))
}).await
}

// List the databases using the CURRENT CONNECTION (for the switcher inside the workspace)
#[tauri::command]
pub async fn list_databases(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        list_databases_inner(&state, conn_id).await
    })
    .await
}

/// Open another database on the SAME server as a **new connection** (§4.3).
///
/// The only way to reach another database now. It replaced `switch_database`, which *replaced* the
/// pool under a live `conn_id`: that had to refuse whenever the connection held uncommitted work,
/// and when it succeeded it left every open tab pointing at tables of a database the connection no
/// longer served. Opening *adds* a pool, so it touches nothing that already exists — there is
/// nothing to refuse, and a transaction open on the current database keeps running while the user
/// works in another one.
///
/// The `Arc<ServerHandle>` is shared, which is the point: the SSH tunnel, the credentials and the
/// IAM token are the server's, not this database's. No re-auth, and the tunnel stays up as long as
/// any connection on that server is open — the last one closing drops the last `Arc` and with it the
/// forwarded port.
///
/// Idempotent: asking for a database that is already open hands back the connection that has it,
/// rather than minting a second pool for the same place.
#[tauri::command]
pub async fn open_database(conn_id: String, name: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let (server, db_type, tunnel_port, inherit_read_only) = {
            let ctx = state.connections.acquire(&conn_id)?;
            (
                ctx.server_arc(),
                ctx.server().db_type.clone(),
                ctx.server().ssh_tunnel.as_ref().map(|t| t.local_port),
                state.connections.is_read_only(&conn_id),
            )
        };

        if db_type == "sqlite" {
            return Err("SQLite không hỗ trợ nhiều database trên một kết nối".to_string());
        }

        if let Some(existing) = state.connections.find(&server.id, &name)? {
            let ctx = state.connections.acquire(&existing)?;
            return Ok(json!({
                "success": true, "database": name,
                "schema": ctx.raw_schema(), "connId": &*existing,
            }));
        }

        // The config used to build the URL: with a tunnel it points at 127.0.0.1:<local_port>
        let mut url_conf = server.config();
        if let Some(port) = tunnel_port
            && let Some(obj) = url_conf.as_object_mut()
        {
            obj.insert("host".to_string(), json!("127.0.0.1"));
            obj.insert("port".to_string(), json!(port));
        }

        let new_id = crate::state::mint_id();
        let kind = match db_type.as_str() {
            "postgres" => {
                let url = build_pg_url(&url_conf, Some(name.as_str()));
                DbKind::Postgres(PgPool::connect(&url).await.map_err(|e| e.to_string())?)
            }
            "mysql" => {
                let url = build_mysql_url(&url_conf, Some(name.as_str()));
                DbKind::Mysql(MySqlPool::connect(&url).await.map_err(|e| e.to_string())?)
            }
            _ => return Err("Hệ quản trị CSDL không được hỗ trợ".to_string()),
        };
        let conn = DbConnection::session(new_id.clone(), kind);

        // Each database has its own schemas, so probe rather than inherit the one selected elsewhere.
        let schema = probe_pg_schema(&conn).await;
        state.connections.insert(
            new_id.clone(),
            // Inherits the read-only flag of the connection it was opened FROM: those two are the same
            // server, and someone who marked production read-only means every database on it.
            crate::state::ConnEntry {
                read_only: inherit_read_only,
                // Deliberately NOT inherited - see `ConnEntry::mcp_exposed`.
                mcp_exposed: false,
                mcp_write: false,
                server,
                db: name.clone(),
                conn: crate::state::LiveConn::Sql(conn),
                current_schema: schema.clone(),
            },
        )?;
        Ok(json!({ "success": true, "database": name, "schema": schema, "connId": &*new_id }))
    })
    .await
}

// `switch_database` has been deleted.
//
// It swapped the pool in place under a live `conn_id`. That is why it had to refuse whenever the connection still
// had uncommitted changes, and when it succeeded every open tab still pointed at tables of the old database with
// nobody saying so. `open_database` has neither problem: it adds a pool on the same
// `Arc<ServerHandle>` (same tunnel, same credentials, no re-authentication) and mints a new conn_id,
// so the old database keeps both its tabs and its transaction. All three former call sites — the picker on the
// title bar, the Sidebar, the statistics popup — and the import flow's "switch to the target database" step have
// moved to it.

/// Schemas available on the current Postgres connection, for the Sidebar picker.
///
/// Empty on MySQL (its schema *is* the database — `list_databases` already covers that) and on
/// SQLite, which is how the frontend decides whether to show the picker at all.
#[tauri::command]
pub async fn list_schemas(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let (conn_type, current) = {
            let ctx = state.connections.acquire(&conn_id)?;
            let ct = ctx.conn().clone();
            (ct, ctx.raw_schema().map(str::to_string))
        };

        if !matches!(conn_type.kind, DbKind::Postgres(_)) {
            return Ok(json!({ "success": true, "schemas": [], "current": Value::Null }));
        }

        let results = execute_raw_sql_generic(
            &conn_type,
            "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' \
         AND nspname <> 'information_schema' ORDER BY nspname"
                .to_string(),
        )
        .await?;
        let schemas = all_string_values(&results);
        Ok(json!({ "success": true, "schemas": schemas, "current": current }))
    })
    .await
}

/// Selects the schema every later command works in. The Sidebar picker's backing command.
///
/// The name is verified against `pg_namespace` first: accepting one that does not exist would
/// leave every query filtering on a schema that is not there, i.e. the same empty sidebar this
/// feature exists to fix, with nothing on screen to explain it.
#[tauri::command]
pub async fn set_current_schema(conn_id: String, name: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let conn_type = {
            let ctx = state.connections.acquire(&conn_id)?;
            ctx.conn().clone()
        };
        if !matches!(conn_type.kind, DbKind::Postgres(_)) {
            return Err("Chỉ PostgreSQL mới hỗ trợ chọn schema".to_string());
        }

        let schema = name.trim().to_string();
        if schema.is_empty() {
            return Err("Thiếu tên schema".to_string());
        }

        let found = execute_raw_sql_generic(
            &conn_type,
            format!(
                "SELECT nspname FROM pg_namespace WHERE nspname = '{}' LIMIT 1",
                sql_str(&schema)
            ),
        )
        .await?;
        if rows_of(&found).is_empty() {
            return Err(format!("Schema '{}' không tồn tại", schema));
        }

        {
            let id = state.connections.acquire(&conn_id)?.id().clone();
            state.connections.set_schema(&id, Some(schema.clone()))?;
        }
        Ok(json!({ "success": true, "schema": schema }))
    })
    .await
}

// Create a new database (using the current connection). encoding/collation are optional.
#[tauri::command]
pub async fn create_database(conn_id: String, payload: Value) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };

    let name = payload.get("name").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).ok_or("Thiếu tên database")?;
    let encoding = payload.get("encoding").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty());
    let collation = payload.get("collation").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty());

    let sql = match &conn_type.kind {
        DbKind::Mysql(_) => {
            let mut s = format!("CREATE DATABASE `{}`", name);
            if let Some(e) = encoding { s.push_str(&format!(" CHARACTER SET {}", e)); }
            if let Some(c) = collation { s.push_str(&format!(" COLLATE {}", c)); }
            s
        }
        DbKind::Postgres(_) => {
            let mut s = format!("CREATE DATABASE \"{}\"", name);
            let mut opts: Vec<String> = Vec::new();
            if let Some(e) = encoding { opts.push(format!("ENCODING '{}'", e.replace('\'', "''"))); }
            if let Some(c) = collation { opts.push(format!("LC_COLLATE '{}'", c.replace('\'', "''"))); }
            if !opts.is_empty() {
                // TEMPLATE template0 is needed when the LC_* settings differ from the default template
                s.push_str(&format!(" WITH {} TEMPLATE template0", opts.join(" ")));
            }
            s
        }
        DbKind::Sqlite(_) => return Err("SQLite không hỗ trợ tạo database (mỗi tệp là một database)".to_string()),
    };

    execute_raw_sql_generic(&conn_type, sql).await?;
    Ok(json!({ "success": true }))
}).await
}

// Drop a database (using the current connection). The connected database cannot be dropped.
#[tauri::command]
pub async fn drop_database(conn_id: String, name: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let conn_type = {
            let ctx = state.connections.acquire(&conn_id)?;
            ctx.conn().clone()
        };

        let sql = match &conn_type.kind {
            DbKind::Mysql(_) => format!("DROP DATABASE `{}`", name),
            DbKind::Postgres(_) => format!("DROP DATABASE \"{}\"", name),
            DbKind::Sqlite(_) => return Err("SQLite không hỗ trợ xóa database".to_string()),
        };
        execute_raw_sql_generic(&conn_type, sql).await?;
        Ok(json!({ "success": true }))
    })
    .await
}

// Rename a database. PostgreSQL only (and the currently connected DB cannot be renamed).
#[tauri::command]
pub async fn rename_database(
    conn_id: String,
    old_name: String,
    new_name: String,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let conn_type = {
            let ctx = state.connections.acquire(&conn_id)?;
            ctx.conn().clone()
        };

        let sql = match &conn_type.kind {
            // PG has a direct rename statement (the currently connected DB cannot be renamed)
            DbKind::Postgres(_) => {
                format!("ALTER DATABASE \"{}\" RENAME TO \"{}\"", old_name, new_name)
            }
            DbKind::Mysql(_) => return Err("MySQL không hỗ trợ đổi tên database.".to_string()),
            DbKind::Sqlite(_) => return Err("SQLite không hỗ trợ đổi tên database.".to_string()),
        };
        execute_raw_sql_generic(&conn_type, sql).await?;
        Ok(json!({ "success": true }))
    })
    .await
}

// The supported encodings/collations per DBMS (used by the create-database dialog)
#[tauri::command]
pub async fn get_db_charsets(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };

    // Extract the values of one column from an execute_raw_sql_generic result
    fn col_values(results: &[Value], col: &str) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(data) = results.first().and_then(|r| r.get("data")).and_then(|v| v.as_array()) {
            for row in data {
                if let Some(v) = row.as_object().and_then(|o| o.get(col)).and_then(|v| v.as_str()) {
                    out.push(v.to_string());
                }
            }
        }
        out
    }

    match &conn_type.kind {
        DbKind::Mysql(_) => {
            let cs_res = execute_raw_sql_generic(&conn_type, "SHOW CHARACTER SET".to_string()).await?;
            let mut encodings = col_values(&cs_res, "Charset");
            encodings.sort();

            let coll_res = execute_raw_sql_generic(&conn_type, "SHOW COLLATION".to_string()).await?;
            // Group the collations by charset so the UI can filter them by the chosen encoding
            let mut by_enc: serde_json::Map<String, Value> = serde_json::Map::new();
            if let Some(data) = coll_res.first().and_then(|r| r.get("data")).and_then(|v| v.as_array()) {
                for row in data {
                    if let Some(o) = row.as_object() {
                        let collation = o.get("Collation").and_then(|v| v.as_str());
                        let charset = o.get("Charset").and_then(|v| v.as_str());
                        if let (Some(c), Some(cs)) = (collation, charset) {
                            let entry = by_enc.entry(cs.to_string()).or_insert_with(|| json!([]));
                            if let Some(arr) = entry.as_array_mut() { arr.push(json!(c)); }
                        }
                    }
                }
            }
            Ok(json!({ "success": true, "encodings": encodings, "collationsByEncoding": by_enc }))
        }
        DbKind::Postgres(_) => {
            let enc_res = execute_raw_sql_generic(&conn_type,
                "SELECT DISTINCT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE encoding >= 0 ORDER BY 1".to_string()).await?;
            let mut encodings = col_values(&enc_res, "enc");
            if !encodings.iter().any(|e| e == "UTF8") { encodings.insert(0, "UTF8".to_string()); }

            let coll_res = execute_raw_sql_generic(&conn_type,
                "SELECT DISTINCT datcollate AS c FROM pg_database WHERE datcollate IS NOT NULL ORDER BY 1".to_string()).await?;
            let collations = col_values(&coll_res, "c");
            Ok(json!({ "success": true, "encodings": encodings, "collations": collations }))
        }
        DbKind::Sqlite(_) => {
            Ok(json!({ "success": true, "encodings": [], "collations": [] }))
        }
    }
}).await
}
