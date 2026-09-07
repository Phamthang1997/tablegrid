//! Opening / closing / listing connections, and a connection's read-only flag.

use std::sync::{Arc, Mutex};

use rusqlite::Connection as SqliteConnection;
use serde_json::{Value, json};
use sqlx::{MySqlPool, PgPool};

use crate::database::{
    DbConnection, DbKind, apply_iam_password, apply_ssh_tunnel, build_mysql_url, build_pg_url,
    cell, execute_raw_sql_generic, is_iam, rows_of, spawn_iam_refresh,
};
use crate::ssh::SshTunnel;

/// The schema a fresh Postgres connection lands in — i.e. the first existing entry of its
/// `search_path`. This is what the plan's §4.1 calls the default for the Sidebar picker, and it
/// costs no extra UI. Returns `None` for MySQL/SQLite, and on any failure: a probe that cannot
/// run must not stop the connection from opening, it just leaves the `public` default in place.
pub(super) async fn probe_pg_schema(conn: &DbConnection) -> Option<String> {
    if !matches!(conn.kind, DbKind::Postgres(_)) {
        return None;
    }
    let res = execute_raw_sql_generic(conn, "SELECT current_schema() AS s".to_string())
        .await
        .ok()?;
    let rows = rows_of(&res);
    // `cell` yields "" for a NULL, which is what current_schema() returns when no entry of
    // search_path exists — same handling either way.
    let name = cell(rows.first()?, "s").trim().to_string();
    if name.is_empty() { None } else { Some(name) }
}

/// Refuse writes on one connection, or allow them again.
///
/// Per connection, because the point is holding production open next to dev: one rail cell refuses,
/// the one beside it does not. Enforced in the SQL funnels (`reject_if_read_only`), so it holds for
/// statements the user types as well as for everything the UI issues.
#[tauri::command]
pub async fn set_connection_read_only(conn_id: String, enabled: bool) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        state.connections.set_read_only(&conn_id, enabled)?;
        Ok(json!({ "success": true, "readOnly": enabled }))
    })
    .await
}

/// Show one connection to the built-in MCP server, or hide it again.
///
/// Separate from `set_connection_read_only` even though the shape is identical: they answer two
/// different questions ("may this be written to" vs "may an AI client see it at all"), and a
/// connection can sensibly be read-only AND hidden, or writable AND shared. Default is hidden -
/// see `ConnEntry::mcp_exposed`.
#[tauri::command]
pub async fn set_connection_mcp_exposed(conn_id: String, enabled: bool) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        state.connections.set_mcp_exposed(&conn_id, enabled)?;
        Ok(json!({ "success": true, "mcpExposed": enabled }))
    })
    .await
}

/// Let an AI client ask to WRITE on one connection, or stop letting it.
///
/// A third tick rather than a mode of the two above, and the distinction is the whole point:
/// `read_only` says what the CONNECTION may do, `mcp_exposed` says whether an AI may see it, and
/// this says whether an AI may propose changing it. Sharing a connection so a model can read the
/// schema must not carry write access with it - see `ConnEntry::mcp_write`.
#[tauri::command]
pub async fn set_connection_mcp_write(conn_id: String, enabled: bool) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        state.connections.set_mcp_write(&conn_id, enabled)?;
        Ok(json!({ "success": true, "mcpWrite": enabled }))
    })
    .await
}

/// Every connection currently open, for the left rail (§4.2c).
///
/// Deliberately takes no `conn_id`: it is a question about the whole app, not about one connection —
/// the same exception `tx_any_pending` is.
#[tauri::command]
pub async fn list_connections() -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        Ok(json!({ "connections": state.connections.list()? }))
    })
    .await
}

/// The command that found the rule the other 110 now follow: it reads the state through
/// `require_state()` instead of taking a `tauri::State<'_, _>` parameter, which is what keeps its
/// future `'static` and therefore spawnable. This is the largest function in the app — SSH
/// tunnelling, rustls handshakes, pool creation and schema probing, across three dialects — so it
/// was the first whose state machine outgrew the main thread's 1MB Windows stack, and the release
/// binary died at launch. `app` stays because `spawn_iam_refresh` needs it; an `AppHandle` is owned
/// and `'static`, so it costs the future nothing.
#[tauri::command]
pub async fn connect_db(app: tauri::AppHandle, config: Value) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let db_type = config
            .get("dbType")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // Opening the same SQLite file twice would be two `rusqlite::Connection`s on one file, i.e.
        // `SQLITE_BUSY` as soon as both write. Hand back the connection that is already open instead.
        // Postgres/MySQL are deliberately not deduplicated — see `ConnRegistry::find_sqlite`.
        if db_type == "sqlite"
            && let Some(path) = config.get("filePath").and_then(|v| v.as_str())
            && let Some(existing) = state.connections.find_sqlite(path)?
        {
            let ctx = state.connections.acquire(&existing)?;
            return Ok(json!({
                "success": true,
                "schema": ctx.raw_schema(),
                "connId": &*existing,
            }));
        }

        let mut ssh_tunnel: Option<SshTunnel> = None;

        // Minted before the pool is built so the handle can carry its own id from the moment it exists —
        // there is never a window where a `DbConnection` is alive without knowing which connection it is.
        let conn_id = crate::state::mint_id();

        let kind = match db_type.as_str() {
            "sqlite" => {
                let path = config
                    .get("filePath")
                    .and_then(|v| v.as_str())
                    .ok_or("Thiếu đường dẫn tệp SQLite")?;
                let conn = SqliteConnection::open(path).map_err(|e| e.to_string())?;
                DbKind::Sqlite(Arc::new(Mutex::new(conn)))
            }
            "postgres" => {
                let (mut conn_config, tunnel) = apply_ssh_tunnel(&config, 5432).await?;
                ssh_tunnel = tunnel;
                apply_iam_password(&config, &mut conn_config, 5432)?;
                let url = build_pg_url(&conn_config, None);
                let pool = PgPool::connect(&url).await.map_err(|e| e.to_string())?;
                DbKind::Postgres(pool)
            }
            "mysql" => {
                let (mut conn_config, tunnel) = apply_ssh_tunnel(&config, 3306).await?;
                ssh_tunnel = tunnel;
                apply_iam_password(&config, &mut conn_config, 3306)?;
                let url = build_mysql_url(&conn_config, None);
                let pool = MySqlPool::connect(&url).await.map_err(|e| e.to_string())?;
                DbKind::Mysql(pool)
            }
            _ => return Err("Hệ quản trị CSDL không được hỗ trợ".to_string()),
        };
        let conn = DbConnection::session(conn_id.clone(), kind);

        // Probed before the registry is locked: this awaits, and no guard may be held across it.
        let schema = probe_pg_schema(&conn).await;

        // `connect_db` means "a new server session": it mints both the server id and the conn_id, and replaces the whole
        // registry because Phase 1 keeps at most one connection. REUSING an existing `Arc<ServerHandle>` is
        // `open_database`'s job in Phase 3, not this command's.
        {
            // The connection's database name; on SQLite it is the file path.
            let db_name = if db_type == "sqlite" {
                config
                    .get("filePath")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            } else {
                config
                    .get("database")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let server = std::sync::Arc::new(crate::state::ServerHandle::new(
                crate::state::mint_id(),
                db_type.clone(),
                config.clone(),
                // `ServerHandle` OWNS the tunnel. `SshTunnel` is not `Clone` and its `Drop` closes the port,
                // so exactly one side holds it — and this is the right side: when the server's last `ConnEntry` is
                // dropped the last `Arc` goes with it and the port closes on its own, with no hand-written refcount.
                ssh_tunnel.take(),
            ));
            // Nothing is dropped here any more: connecting ADDS a connection, it no longer replaces the
            // one before it. That is the whole of Phase 2 in one line — and it is also why nothing
            // resets a transaction session here. Each connection owns its own session now, so an open
            // transaction on connection A is none of connection B's business; A's session ends when A
            // is disconnected (`disconnect_db`).
            state.connections.insert(
                conn_id.clone(),
                crate::state::ConnEntry {
                    // A new connection starts writable; the UI turns this on for a production label.
                    read_only: false,
                    // Never exposed to an AI client until the user says so, per connection.
                    mcp_exposed: false,
                    mcp_write: false,
                    server,
                    db: db_name,
                    conn: crate::state::LiveConn::Sql(conn),
                    current_schema: schema.clone(),
                },
            )?;
        }

        // An IAM connection: run the periodic token refresh task (a token only lives 15 minutes)
        if is_iam(&config) && (db_type == "postgres" || db_type == "mysql") {
            spawn_iam_refresh(app, db_type, config, conn_id.clone());
        }

        // The frontend keys its per-connection localStorage on the effective schema, so it has to
        // learn it from here rather than from its own picker state — on the first connect the user
        // has not touched the picker yet. See the plan §5.0.
        //
        // `connId` is additive and unused by the frontend for now: ids are minted here and handed out,
        // never derived from the config (multi-connection-plan §4.3). Phase 1d is what starts sending it
        // back down as a command argument.
        Ok(json!({ "success": true, "schema": schema, "connId": &*conn_id }))
    })
    .await
}

#[tauri::command]
pub async fn disconnect_db(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;

        // Take the entry out first, then roll back its manual transaction while its pool is still alive:
        // dropping a pool with a transaction open leaves the server holding its locks until it notices
        // the socket died. Dropping `entry` afterwards releases the last `Arc<ServerHandle>` of that
        // server, and because `ServerHandle` owns the `SshTunnel`, its `Drop` closes the forwarded port —
        // no manual tunnel teardown.
        //
        // An unknown id is not an error: disconnecting something already gone is the state the caller
        // wanted. `reset(None)` still runs so the state machine itself is cleared.
        let entry = state.connections.remove(&conn_id)?;
        crate::tx::reset(entry.as_ref().and_then(|e| e.conn.sql())).await;
        drop(entry);
        Ok(json!({ "success": true }))
    })
    .await
}
