//! Connection status: the ping latency of every connection, and the full description of one connection.

use serde_json::{Value, json};
use sqlx::Row;

use crate::database::{DbConnection, DbKind};
use crate::state::SessionInfo;

#[derive(serde::Serialize)]
pub struct ConnectionStatusInfo {
    pub is_connected: bool,
    pub db_type: String,
    pub conn_type: String,
    pub host: String,
    pub latency_ms: u64,
    /// Server version as the server reports it ("8.4.3", "16.2 (Debian…)"), empty when unreadable.
    pub server_version: String,
    /// Account the session is authenticated as. Empty for SQLite (there is none).
    pub user: String,
    /// Database the session is currently using.
    pub database: String,
    /// TCP port. 0 for SQLite.
    pub port: u16,
    /// Negotiated TLS cipher suite. Empty when the session is not encrypted.
    pub cipher: String,
    /// Negotiated TLS protocol version. Empty when the session is not encrypted.
    pub tls_version: String,
}

/// The latency of **every** open connection, one `SELECT 1` each, run in parallel.
///
/// `get_connection_status` is not used for this: that command also asks for the version, the user and TLS, i.e. 3–5
/// round trips for *one* connection. Calling it N times every time the Quick Switcher opens makes a menu wait a few
/// hundred ms — which is exactly why this command exists on its own.
///
/// **It goes straight to the pool, not through `execute_raw_sql_generic`.** Going through that would make
/// `should_route` push this statement into the transaction session while the user has manual commit on, and `run_raw`
/// calls `ensure_begin` on the **first statement whatever it is** — a background ping would silently OPEN a transaction
/// on every connection, and the "waiting to be committed" counter would then talk about things the user never typed. A ping is
/// a state-reading operation; it must leave no trace behind.
///
/// It takes no `conn_id`: this is a question about the registry, like `list_connections`, not about one
/// connection. A failure on one connection returns `ok: false` rather than failing the whole command — a server that has gone away
/// is *information* the UI needs to show, not an error that hides the other N-1 connections as well.
#[tauri::command]
pub async fn ping_connections() -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let handles = state.connections.handles()?;
        let pings = futures_util::future::join_all(handles.into_iter().map(|(id, conn)| async move {
        let started = std::time::Instant::now();
        let ok = match &conn.kind {
            // SQLite is a shared handle behind a `Mutex`: one `SELECT 1` takes microseconds, but when the lock is
            // held by a long query the ping waits with it. That is a truth worth showing — that connection
            // *is* busy — so there is no attempt to dodge it with `try_lock`.
            DbKind::Sqlite(arc) => arc
                .lock()
                .map(|c| c.execute_batch("SELECT 1;").is_ok())
                .unwrap_or(false),
            DbKind::Postgres(pool) => sqlx::query("SELECT 1;").execute(pool).await.is_ok(),
            DbKind::Mysql(pool) => sqlx::query("SELECT 1;").execute(pool).await.is_ok(),
        };
        json!({ "connId": &*id, "ok": ok, "latencyMs": started.elapsed().as_millis() as u64 })
    }))
    .await;
        Ok(json!({ "success": true, "pings": pings }))
    })
    .await
}

impl ConnectionStatusInfo {
    fn disconnected() -> Self {
        ConnectionStatusInfo {
            is_connected: false,
            db_type: String::new(),
            conn_type: "loc".to_string(),
            host: String::new(),
            latency_ms: 0,
            server_version: String::new(),
            user: String::new(),
            database: String::new(),
            port: 0,
            cipher: String::new(),
            tls_version: String::new(),
        }
    }
}

/// The value of one MySQL status variable (`SHOW SESSION STATUS LIKE …`).
///
/// It takes the whole statement as a literal rather than splicing the variable name into a string: sqlx 0.9
/// only implements `SqlSafeStr` for `&'static str`, and nothing here is dynamic anyway —
/// the variable name is always a constant, so it needs none of the `AssertSqlSafe` the places that build SQL
/// from table/column names in this file use.
///
/// Running it on a different connection of the pool still gives the right answer: the TLS configuration
/// belongs to the whole pool, so every session negotiates the same cipher/version.
/// MySQL returns an empty string for `Ssl_cipher` when the session is not encrypted.
async fn mysql_status_var(pool: &sqlx::MySqlPool, sql: &'static str) -> String {
    match sqlx::query(sql).fetch_optional(pool).await {
        // Column 1 is `Value`; taken by index rather than by name, matching this file's
        // convention against duplicate column names.
        Ok(Some(row)) => row.try_get::<String, _>(1).unwrap_or_default(),
        _ => String::new(),
    }
}

/// Probes the part of the status that does not change while the connection lives — see
/// `SessionInfo` for why it is asked for once rather than on every poll.
///
/// Every query here is "best effort": on error the field is left empty rather than breaking the
/// whole status pill. The TLS part is separate from the version/user part because `pg_stat_ssl`
/// does not exist on older Postgres — merged together, an old server would lose its version and
/// user as well.
async fn probe_session_info(conn: &DbConnection) -> SessionInfo {
    let (server_version, user, database, cipher, tls_version) = match &conn.kind {
        DbKind::Sqlite(arc) => {
            let version = arc
                .lock()
                .ok()
                .and_then(|c| {
                    c.query_row("SELECT sqlite_version()", [], |r| r.get::<_, String>(0))
                        .ok()
                })
                .unwrap_or_default();
            (
                version,
                String::new(),
                String::new(),
                String::new(),
                String::new(),
            )
        }
        DbKind::Postgres(pool) => {
            // `current_user`/`current_database()` are of type `name`, which sqlx cannot decode
            // straight into a String, hence the ::text cast.
            let (version, user, db) = match sqlx::query(
                "SELECT current_setting('server_version'), current_user::text, current_database()::text",
            )
            .fetch_optional(pool)
            .await
            {
                Ok(Some(r)) => (
                    r.try_get::<String, _>(0).unwrap_or_default(),
                    r.try_get::<String, _>(1).unwrap_or_default(),
                    r.try_get::<String, _>(2).unwrap_or_default(),
                ),
                _ => (String::new(), String::new(), String::new()),
            };
            let (cipher, tls) = match sqlx::query(
                "SELECT COALESCE(cipher, ''), COALESCE(version, '') \
                 FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
            )
            .fetch_optional(pool)
            .await
            {
                Ok(Some(r)) => (
                    r.try_get::<String, _>(0).unwrap_or_default(),
                    r.try_get::<String, _>(1).unwrap_or_default(),
                ),
                _ => (String::new(), String::new()),
            };
            (version, user, db, cipher, tls)
        }
        DbKind::Mysql(pool) => {
            let (version, user, db) =
                match sqlx::query("SELECT VERSION(), CURRENT_USER(), COALESCE(DATABASE(), '')")
                    .fetch_optional(pool)
                    .await
                {
                    Ok(Some(r)) => (
                        r.try_get::<String, _>(0).unwrap_or_default(),
                        r.try_get::<String, _>(1).unwrap_or_default(),
                        r.try_get::<String, _>(2).unwrap_or_default(),
                    ),
                    _ => (String::new(), String::new(), String::new()),
                };
            let cipher = mysql_status_var(pool, "SHOW SESSION STATUS LIKE 'Ssl_cipher'").await;
            let tls = mysql_status_var(pool, "SHOW SESSION STATUS LIKE 'Ssl_version'").await;
            (version, user, db, cipher, tls)
        }
    };
    SessionInfo {
        server_version,
        user,
        database,
        cipher,
        tls_version,
    }
}

/// Returns the current DB connection status, the connection kind (loc/ssh/ssl/rem) and the ping latency (ms).
#[tauri::command]
pub async fn get_connection_status(
    // `State`/`AppState` is not imported at the top of the file — every other command in this file writes
    // the full path, and that convention is kept.
    conn_id: String,
) -> Result<ConnectionStatusInfo, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let start = std::time::Instant::now();
        let (conn, db_type, config, has_ssh) = {
            // `.ok()`, not `?`: having no SQL connection is a TOLERATED state here — the Redis
            // branch below is the answer in that case. Using `?` would turn "no SQL connection" into an error
            // and block the Redis path too.
            match state.connections.acquire(&conn_id).ok() {
                Some(ctx) => (
                    Some(ctx.conn().clone()),
                    ctx.server().db_type.clone(),
                    Some(ctx.server().config()),
                    ctx.server().ssh_tunnel.is_some(),
                ),
                None => (None, String::new(), None, false),
            }
        };

        let conn = match conn {
            Some(c) => c,
            None => {
                // Check Redis connection
                // The same `conn_id`, only a different kind of connection. Redis is in the registry now, so there is no
                // more asking a global state "is there a Redis connection" — a question with no right
                // answer once two Redis connections are open at the same time.
                let (redis_conn, redis_config, redis_db_index, has_redis_ssh, caps) =
                    match state.connections.acquire_redis(&conn_id) {
                        Ok(ctx) => (
                            Some(ctx.conn()),
                            Some(ctx.config()),
                            ctx.db_index(),
                            ctx.has_ssh_tunnel(),
                            ctx.caps(),
                        ),
                        Err(_) => (None, None, 0, false, crate::redis_db::RedisCaps::default()),
                    };

                if let Some(mut r_conn) = redis_conn {
                    let start = std::time::Instant::now();
                    let _ = redis::cmd("PING").query_async::<String>(&mut r_conn).await;
                    let latency_ms = start.elapsed().as_millis() as u64;

                    let host = redis_config
                        .as_ref()
                        .and_then(|c| c.get("host"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("localhost")
                        .to_string();

                    let port = redis_config
                        .as_ref()
                        .and_then(|c| c.get("port"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(6379) as u16;

                    let user = redis_config
                        .as_ref()
                        .and_then(|c| c.get("username").or_else(|| c.get("user")))
                        .and_then(|v| v.as_str())
                        .unwrap_or("default")
                        .to_string();

                    let ssl_mode = redis_config
                        .as_ref()
                        .and_then(|c| c.get("sslMode"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("DISABLED");

                    let conn_type = if has_redis_ssh
                        || redis_config
                            .as_ref()
                            .and_then(|c| c.get("useSshTunnel"))
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                    {
                        "ssh".to_string()
                    } else if ssl_mode != "DISABLED" {
                        "ssl".to_string()
                    } else if host == "localhost"
                        || host == "127.0.0.1"
                        || host == "::1"
                        || host.starts_with("127.")
                    {
                        "loc".to_string()
                    } else {
                        "rem".to_string()
                    };

                    let database = format!("db{}", redis_db_index);
                    let server_version = caps.version;

                    return Ok(ConnectionStatusInfo {
                        is_connected: true,
                        db_type: "redis".to_string(),
                        conn_type,
                        host,
                        latency_ms,
                        server_version,
                        user,
                        database,
                        port,
                        cipher: if ssl_mode != "DISABLED" {
                            "TLS".to_string()
                        } else {
                            String::new()
                        },
                        tls_version: if ssl_mode != "DISABLED" {
                            ssl_mode.to_string()
                        } else {
                            String::new()
                        },
                    });
                }

                return Ok(ConnectionStatusInfo::disconnected());
            }
        };

        match &conn.kind {
            DbKind::Sqlite(arc) => {
                if let Ok(conn) = arc.lock() {
                    let _ = conn.execute_batch("SELECT 1;");
                }
            }
            DbKind::Postgres(pool) => {
                let _ = sqlx::query("SELECT 1;").execute(pool).await;
            }
            DbKind::Mysql(pool) => {
                let _ = sqlx::query("SELECT 1;").execute(pool).await;
            }
        }
        let latency_ms = start.elapsed().as_millis() as u64;

        // Everything past the latency ping is a constant of this session, so it is probed once and
        // cached on the registry entry (`SessionInfo`): the title bar polls this command every 6
        // seconds, and on MySQL the probe alone is three round trips.
        let session = match state.connections.session_info(&conn_id) {
            Some(cached) => cached,
            None => {
                let probed = probe_session_info(&conn).await;
                // A failure to store is ignored: the only one reachable is a poisoned registry lock,
                // and a status poll is the wrong place to turn that into a visible error — the next
                // poll simply probes again.
                let _ = state.connections.set_session_info(&conn_id, probed.clone());
                probed
            }
        };
        let SessionInfo {
            server_version,
            user: session_user,
            database: session_db,
            cipher,
            tls_version,
        } = session;

        let host = config
            .as_ref()
            .and_then(|c| c.get("host"))
            .and_then(|v| v.as_str())
            .unwrap_or("localhost")
            .to_string();

        let conn_type = if db_type == "sqlite" {
            "loc".to_string()
        } else if has_ssh
            || config
                .as_ref()
                .and_then(|c| c.get("useSshTunnel"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        {
            "ssh".to_string()
        } else if config
            .as_ref()
            .and_then(|c| c.get("sslEnabled"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
            || config
                .as_ref()
                .and_then(|c| c.get("sslMode"))
                .and_then(|v| v.as_str())
                .unwrap_or("DISABLED")
                != "DISABLED"
        {
            "ssl".to_string()
        } else if host == "localhost"
            || host == "127.0.0.1"
            || host == "::1"
            || host.starts_with("127.")
        {
            "loc".to_string()
        } else {
            "rem".to_string()
        };

        let port = config
            .as_ref()
            .and_then(|c| c.get("port"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u16;

        // SQLite has no notion of a "current database" — show the file path instead.
        let database = if session_db.is_empty() {
            config
                .as_ref()
                .and_then(|c| c.get("database").or_else(|| c.get("sqlitePath")))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        } else {
            session_db
        };

        Ok(ConnectionStatusInfo {
            is_connected: true,
            db_type,
            conn_type,
            host,
            latency_ms,
            server_version,
            user: session_user,
            database,
            port,
            cipher,
            tls_version,
        })
    })
    .await
}
