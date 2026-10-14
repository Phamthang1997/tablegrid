//! Resolving ONE side of the comparison into a usable connection, plus the module's shared
//! data-reading path.
//!
//! Each side is resolved separately: it reuses the open connection when that side points at the current
//! database (no re-authentication — which matters for AWS IAM tokens), and otherwise opens a TEMPORARY
//! pool from the server's config. A temporary pool carries `ConnId::Adhoc`, so `should_route` never
//! pins it as the user's transaction session.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::database::{
    DbConnection, DbKind, build_mysql_url, build_pg_url, execute_raw_sql_generic,
};
use crate::ssh::SshTunnel;

// ===================== Parameters from the frontend =====================

/// One side of the comparison. Passing nothing -> the currently connected database itself.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareSide {
    /// Database name (MySQL/Postgres).
    pub database: Option<String>,
    /// Postgres schema (defaults to `public`). Ignored on MySQL/SQLite.
    pub schema: Option<String>,
    /// Path to the SQLite file.
    pub file_path: Option<String>,
    /// The full connection config (in the raw form `connect_db` accepts). Left empty -> use
    /// the config of the open connection.
    pub config: Option<Value>,
}

// ===================== The connection for one side =====================

pub(super) struct Resolved {
    pub(super) conn: DbConnection,
    pub(super) dialect: String,
    /// MySQL: the database name; Postgres: the schema name; SQLite: "main".
    pub(super) schema: String,
    /// The display label (database name or SQLite file).
    pub(super) label: String,
    /// The server, so the UI can tell apart two sides with the same database name on different servers.
    pub(super) server: String,
    /// true when this is a temporary connection opened by this module -> it must be closed when done.
    pub(super) owned: bool,
    /// Keeps the SSH tunnel alive for the whole command (only when this side opened the tunnel itself).
    pub(super) _tunnel: Option<SshTunnel>,
}

impl Resolved {
    pub(super) async fn close(self) {
        if !self.owned {
            return;
        }
        match self.conn.kind {
            DbKind::Postgres(pool) => pool.close().await,
            DbKind::Mysql(pool) => pool.close().await,
            // rusqlite closes itself when the last Arc is dropped.
            DbKind::Sqlite(_) | DbKind::DuckDb(_) => {}
        }
    }
}

pub(super) fn cfg_str(config: &Value, key: &str) -> Option<String> {
    config
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub(super) fn server_label(config: &Value) -> String {
    let host = cfg_str(config, "host").unwrap_or_else(|| "localhost".to_string());
    match config.get("port").and_then(|v| v.as_u64()) {
        Some(p) => format!("{}:{}", host, p),
        None => host,
    }
}

/// The database/file name the OPEN connection currently points at. Used to decide whether a side can
/// reuse the existing connection instead of opening a new one.
pub(super) async fn current_db_name(conn: &DbConnection, dialect: &str) -> Option<String> {
    let sql = match dialect {
        "postgres" => "SELECT current_database() AS db",
        "mysql" => "SELECT DATABASE() AS db",
        _ => return None,
    };
    let rows = query_rows(conn, sql.to_string()).await.ok()?;
    rows.first()
        .and_then(|r| r.get("db"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

pub(super) async fn resolve_side(
    state: &crate::AppState,
    side: &CompareSide,
    conn_id: &str,
) -> Result<Resolved, String> {
    let (active, active_type, last_config, tunnel_port) = {
        // `.ok()`, not `?`: each side may carry its own config, so "not connected" is not
        // an error here — `base` below is what decides (`side.config.or(last_config)`).
        match state.connections.acquire(conn_id).ok() {
            Some(ctx) => (
                Some(ctx.conn().clone()),
                ctx.server().db_type.clone(),
                Some(ctx.server().config()),
                ctx.server().ssh_tunnel.as_ref().map(|t| t.local_port),
            ),
            None => (None, String::new(), None, None),
        }
    };

    let own_config = side.config.is_some();
    let base = side
        .config
        .clone()
        .or(last_config)
        .ok_or_else(|| "Chưa có cấu hình kết nối".to_string())?;

    // When the frontend sends a config the dialect is inside it; otherwise take it from the open connection.
    let dialect = if own_config {
        cfg_str(&base, "dbType")
    } else if !active_type.is_empty() {
        Some(active_type.clone())
    } else {
        cfg_str(&base, "dbType")
    }
    .ok_or_else(|| "Hệ quản trị CSDL không được hỗ trợ".to_string())?;

    if dialect == "sqlite" {
        let path = side
            .file_path
            .clone()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| cfg_str(&base, "filePath"))
            .ok_or_else(|| "Thiếu đường dẫn tệp SQLite".to_string())?;

        // The same file as the open connection -> reuse it (so the file is not locked twice).
        let active_path = cfg_str(&base, "filePath");
        if !own_config
            && active_path.as_deref() == Some(path.as_str())
            && let Some(conn) = active.clone()
        {
            return Ok(Resolved {
                conn,
                dialect,
                schema: "main".to_string(),
                label: path.clone(),
                server: path,
                owned: false,
                _tunnel: None,
            });
        }

        // Opened READ-ONLY: a comparison must never create an empty file when the user mistypes a path.
        let conn = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| format!("Không mở được tệp SQLite '{}': {}", path, e))?;

        return Ok(Resolved {
            // `adhoc`: this pool is opened by the module itself, so it must never become the user's
            // transaction session — see `ConnId::Adhoc` and §0 of the plan.
            conn: DbConnection::adhoc(DbKind::Sqlite(std::sync::Arc::new(std::sync::Mutex::new(
                conn,
            )))),
            dialect,
            schema: "main".to_string(),
            label: path.clone(),
            server: path,
            owned: true,
            _tunnel: None,
        });
    }

    if dialect != "postgres" && dialect != "mysql" {
        return Err("Hệ quản trị CSDL không được hỗ trợ".to_string());
    }

    let wanted_db = side
        .database
        .clone()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| cfg_str(&base, "database"));

    // Reuse the open connection when this side points at the current database: no
    // re-authentication (which matters for AWS IAM, whose token only lives 15 minutes).
    if !own_config && let Some(conn) = active.clone() {
        let current = current_db_name(&conn, &dialect).await;
        let same = match (&wanted_db, &current) {
            (Some(w), Some(c)) => w == c,
            (None, _) => true,
            _ => false,
        };
        if same {
            let schema = match dialect.as_str() {
                "postgres" => side.schema.clone().unwrap_or_else(|| "public".to_string()),
                _ => current.clone().or(wanted_db.clone()).unwrap_or_default(),
            };
            return Ok(Resolved {
                conn,
                dialect,
                schema,
                label: current.or(wanted_db).unwrap_or_default(),
                server: server_label(&base),
                owned: false,
                _tunnel: None,
            });
        }
    }

    // A temporary connection. When the config comes from the open connection, host/port must point at the
    // running tunnel; when the frontend sends a config with SSH, open a tunnel of our own.
    let default_port: u16 = if dialect == "postgres" { 5432 } else { 3306 };
    let mut conn_config = base.clone();
    let mut tunnel: Option<SshTunnel> = None;

    if own_config {
        let (tunneled, t) = crate::database::apply_ssh_tunnel(&conn_config, default_port).await?;
        conn_config = tunneled;
        tunnel = t;
    } else if let (Some(obj), Some(port)) = (conn_config.as_object_mut(), tunnel_port) {
        obj.insert("host".to_string(), json!("127.0.0.1"));
        obj.insert("port".to_string(), json!(port));
    }
    crate::database::apply_iam_password(&base, &mut conn_config, default_port)?;

    let db_override = wanted_db.as_deref();
    // `adhoc` — see the note in the SQLite branch above.
    let conn = DbConnection::adhoc(if dialect == "postgres" {
        let url = build_pg_url(&conn_config, db_override);
        DbKind::Postgres(
            sqlx::pool::PoolOptions::<sqlx::Postgres>::new()
                .max_connections(2)
                .connect(&url)
                .await
                .map_err(|e| e.to_string())?,
        )
    } else {
        let url = build_mysql_url(&conn_config, db_override);
        DbKind::Mysql(
            sqlx::pool::PoolOptions::<sqlx::MySql>::new()
                .max_connections(2)
                .connect(&url)
                .await
                .map_err(|e| e.to_string())?,
        )
    });

    let label = wanted_db
        .clone()
        .or_else(|| cfg_str(&base, "database"))
        .unwrap_or_default();
    let schema = match dialect.as_str() {
        "postgres" => side.schema.clone().unwrap_or_else(|| "public".to_string()),
        _ => label.clone(),
    };

    Ok(Resolved {
        conn,
        dialect,
        schema,
        label,
        server: server_label(&base),
        owned: true,
        _tunnel: tunnel,
    })
}

pub(super) fn side_json(r: &Resolved, tables: usize) -> Value {
    json!({
        "label": r.label,
        "server": r.server,
        "dialect": r.dialect,
        "schema": r.schema,
        "tableCount": tables,
    })
}

// ===================== Reading JSON results =====================

/// The single funnel for every statement this module runs — all 18 call sites go through here.
///
/// A side resolved to an ad-hoc pool must never become the user's pinned transaction session. That
/// no longer depends on calling a particular executor: the pool carries `ConnId::Adhoc` and
/// `should_route` refuses it.
pub(super) async fn query_rows(conn: &DbConnection, sql: String) -> Result<Vec<Value>, String> {
    let res = execute_raw_sql_generic(conn, sql).await?;
    Ok(res
        .first()
        .and_then(|r| r.get("data"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default())
}

/// Like `query_rows` but an error -> an empty list. Used for optional metadata
/// (indexes/FKs/views) so that a missing privilege on one system table cannot break the whole comparison.
pub(super) async fn query_rows_soft(conn: &DbConnection, sql: String) -> Vec<Value> {
    query_rows(conn, sql).await.unwrap_or_default()
}

pub(super) fn f_str(row: &Value, key: &str) -> String {
    match row.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

pub(super) fn f_opt_str(row: &Value, key: &str) -> Option<String> {
    match row.get(key) {
        Some(Value::Null) | None => None,
        _ => Some(f_str(row, key)),
    }
}

pub(super) fn f_bool(row: &Value, key: &str) -> bool {
    match row.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Some(Value::String(s)) => {
            let u = s.trim().to_ascii_uppercase();
            u == "YES" || u == "TRUE" || u == "T" || u == "1"
        }
        _ => false,
    }
}
