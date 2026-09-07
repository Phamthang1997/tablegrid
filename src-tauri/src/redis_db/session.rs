//! The lifecycle of one Redis connection: connect / disconnect / change db index / the read-only flag.
//!
//! One `conn_id` = one `(server, db index)`. Changing the db index OPENS ANOTHER CONNECTION, it does not change
//! shared state — that is what keeps two key tabs on two dbs from reading each other's data.

use std::sync::Arc;

use serde_json::{Value, json};

use crate::redis_db::caps::probe_caps;
use crate::redis_db::conn::make_conn;

// ---- Commands ----

/// The name a Redis `(server, db index)` is filed under in the registry — the `db` field the rail
/// draws, and what `find` matches on so opening the same index twice is idempotent.
pub(crate) fn redis_db_name(index: i64) -> String {
    format!("db{}", index)
}

#[tauri::command]
pub async fn redis_connect(config: Value) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let db_index = config.get("dbIndex").and_then(|v| v.as_i64()).unwrap_or(0);
        // Open the SSH tunnel first: conn_config then points at 127.0.0.1:<forwarded port>, and that very conn_config
        // is the one stored, so every later reconnect (changing db index, Pub/Sub, Profiler) reuses this same
        // port instead of opening a new tunnel.
        let (conn_config, tunnel) = crate::database::apply_ssh_tunnel(&config, 6379).await?;
        let mut conn = make_conn(&conn_config, db_index).await?;

        // PING to make sure the connection/authentication really worked.
        let _: String = redis::cmd("PING")
            .query_async(&mut conn)
            .await
            .map_err(|e| format!("PING lỗi: {}", e))?;

        let caps = probe_caps(&mut conn).await;
        let read_only = config
            .get("readOnly")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let conn_id = crate::state::mint_id();
        // `ServerHandle` keeps the TUNNELED config, unlike SQL (which keeps the original config and reopens the
        // tunnel every time it builds a pool). Redis reconnects far more often — changing db index, Pub/Sub and the
        // Profiler all open a new socket — and the tunnel is already alive on this very handle, so rebuilding
        // it would open one redundant forwarded port.
        let server = Arc::new(crate::state::ServerHandle::new(
            crate::state::mint_id(),
            "redis".to_string(),
            conn_config,
            tunnel,
        ));
        state.connections.insert(
            conn_id.clone(),
            crate::state::ConnEntry {
                read_only,
                // Redis is out of MCP scope entirely; the field exists because the registry is shared.
                mcp_exposed: false,
                mcp_write: false,
                server,
                db: redis_db_name(db_index),
                conn: crate::state::LiveConn::Redis(crate::state::RedisConn {
                    conn,
                    db_index,
                    caps: caps.clone(),
                }),
                // Redis has no schemas. `None` rather than `Some("")`: `pg_schema_of` defaults to
                // `public`, and an empty string here would end up in the frontend's scopeKey.
                current_schema: None,
            },
        )?;

        Ok(json!({
            "success": true,
            "connId": &*conn_id,
            "dbIndex": db_index,
            "caps": caps.to_json(),
            "readOnly": read_only,
        }))
    })
    .await
}

/// Mirrors the app's read-only toggle into the backend. The toggle can be flipped after
/// connecting, so the value cannot be read from the connect config alone.
///
/// Writes the registry's own flag — there is no second Redis-only flag any more, so the rail, the
/// SQL guard and the Redis guard can no longer disagree about one connection.
#[tauri::command]
pub async fn redis_set_read_only(conn_id: String, flag: bool) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        state.connections.set_read_only(&conn_id, flag)?;
        Ok(json!({ "success": true, "readOnly": flag }))
    })
    .await
}

#[tauri::command]
pub async fn redis_disconnect(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        // Dropping the entry releases its `Arc<ServerHandle>`; the SSH tunnel closes with the LAST
        // entry of that server, not with this one — which is the point of putting it there. Disconnecting `db3`
        // while `db0` of the same server is still open must leave the forwarded port alive.
        let entry = state.connections.remove(&conn_id)?;
        drop(entry);
        Ok(json!({ "success": true }))
    })
    .await
}

/// Change the database index (0-15).
///
/// It no longer changes shared state: it **opens another connection** to the same server and returns that
/// connection's `conn_id` (§2.1). The frontend moves the workspace to the new id, exactly as when opening a
/// second database of a Postgres server. Idempotent — clicking `db3` twice returns the same `conn_id`.
#[tauri::command]
pub async fn redis_select_db(conn_id: String, index: i64) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        select_db_inner(&state, &conn_id, index).await
    })
    .await
}

// Shared by the command above and by the `SELECT n` interception in `redis_execute_cmd`, so
// the console cannot switch database behind the UI's back.
pub(crate) async fn select_db_inner(
    state: &crate::AppState,
    conn_id: &str,
    index: i64,
) -> Result<Value, String> {
    let (server, read_only) = {
        let ctx = state.connections.acquire_redis(conn_id)?;
        (ctx.server_arc(), ctx.read_only())
    };
    let db = redis_db_name(index);

    // Already open -> reuse it, do not mint a second pool for the same place.
    if let Some(existing) = state.connections.find(&server.id, &db)? {
        return Ok(json!({ "success": true, "connId": &*existing, "dbIndex": index }));
    }

    let config = server.config();
    let mut conn = make_conn(&config, index).await?;
    let _: String = redis::cmd("PING")
        .query_async(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    let caps = probe_caps(&mut conn).await;

    let new_id = crate::state::mint_id();
    state.connections.insert(
        new_id.clone(),
        crate::state::ConnEntry {
            // Inherit the read-only flag of the connection it was opened from: same server, and whoever marked
            // production read-only meant every db index of it. Same reasoning as `open_database`.
            read_only,
            mcp_exposed: false,
            mcp_write: false,
            // The SAME `Arc<ServerHandle>`: a different `ServerHandle` would open its own tunnel and close it as soon
            // as the first connection disappeared.
            server,
            db,
            conn: crate::state::LiveConn::Redis(crate::state::RedisConn {
                conn,
                db_index: index,
                caps,
            }),
            current_schema: None,
        },
    )?;
    Ok(json!({ "success": true, "connId": &*new_id, "dbIndex": index }))
}
