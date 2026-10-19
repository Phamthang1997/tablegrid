//! `ConnCtx` / `RedisCtx` — what `acquire()` hands back: a connection ALREADY tied to its identity.

use std::sync::Arc;

use serde_json::Value;

use super::entry::{ConnEntry, LiveConn};
use super::ids::ConnScopeId;
use super::server::ServerHandle;
use crate::database::DbConnection;
use crate::redis_db::RedisCaps;

/// A connection plus everything a command used to clone out of `DatabaseManager` by hand.
///
/// Fields are private and there is no `Clone`: this is threaded, not duplicated. Handing out a
/// bare `DbConnection` next to a separately-passed id would let a caller pair A's handle with B's
/// id, which is the failure class this whole refactor exists to remove.
pub struct ConnCtx {
    id: ConnScopeId,
    server: Arc<ServerHandle>,
    conn: DbConnection,
    dialect: &'static str,
    schema: String,
    raw_schema: Option<String>,
    db: String,
}

impl ConnCtx {
    pub fn id(&self) -> &ConnScopeId {
        &self.id
    }

    pub fn conn(&self) -> &DbConnection {
        &self.conn
    }

    /// The server this connection belongs to — `last_config` and the live SSH tunnel, for the paths
    /// that rebuild a pool (open another database, refresh an IAM token) rather than run a
    /// statement. Several `ConnCtx` on the same server hand back the same `Arc`.
    pub fn server(&self) -> &ServerHandle {
        &self.server
    }

    /// The shared handle itself, for `open_database`: a second database on this server must hold the
    /// **same** `Arc`, or it would open its own tunnel and re-authenticate, and the tunnel would
    /// close as soon as the first connection went away.
    pub fn server_arc(&self) -> Arc<ServerHandle> {
        self.server.clone()
    }

    /// Derived from the live connection, never from `ServerHandle::db_type`.
    pub fn dialect(&self) -> &'static str {
        self.dialect
    }

    /// **Already defaulted to `public`.** Returning `Option<String>` here would let a call site
    /// forget `pg_schema_of` and silently query `public` while the compiler stayed happy — the
    /// quiet-wrong-schema bug `postgres-schema-support-plan.md` §4.2 lists as the easiest to miss.
    /// Use `raw_schema()` only where the *absence* of a schema is the answer.
    pub fn schema(&self) -> &str {
        &self.schema
    }

    /// The unresolved value, for `list_schemas`' `"current"` field.
    pub fn raw_schema(&self) -> Option<&str> {
        self.raw_schema.as_deref()
    }

    /// Kept so `ConnEntry::db` has a reader: `set_db` still writes it on a MySQL `USE` inside a
    /// restore, and the left rail displays it (§4.2c). `open_job_connection` reads it to point the
    /// job's connection at the same database (the file path, on SQLite).
    pub fn db(&self) -> &str {
        &self.db
    }
}

/// Takes the map key, not `entry.server.id`: the id a `ConnCtx` carries is the **conn_id**.
///
/// A Redis entry has no `DbConnection`, so it cannot produce a `ConnCtx`. It reuses the existing
/// `"Chưa kết nối CSDL"` verbatim rather than adding a message: reaching here with a Redis
/// `conn_id` means a SQL command was called with one, which the UI never does, and a new literal
/// would have to be added to `src/utils/backendErrors.ts` and its byte-identical round-trip test
/// for a string no user is meant to see.
pub(super) fn ctx_of(key: &ConnScopeId, entry: &ConnEntry) -> Result<ConnCtx, String> {
    let conn = entry
        .conn
        .sql()
        .ok_or_else(|| "Chưa kết nối CSDL".to_string())?
        .clone();
    Ok(ConnCtx {
        id: key.clone(),
        server: entry.server.clone(),
        // Always derived from the live connection, never from `ServerHandle::db_type` — the two
        // cannot disagree that way, and `db_type` is `""` while disconnected.
        dialect: crate::tx::dialect_of(&conn),
        conn,
        schema: crate::database::pg_schema_of(&entry.current_schema),
        raw_schema: entry.current_schema.clone(),
        db: entry.db.clone(),
    })
}

/// A Redis connection plus its identity — the twin of `ConnCtx`, and deliberately a separate type.
///
/// Merging the two would give every SQL call site a `schema()`/`dialect()` that may be meaningless
/// and every Redis call site a `conn()` of the wrong type. Two types means the compiler decides
/// which commands may see which connection.
pub struct RedisCtx {
    id: ConnScopeId,
    server: Arc<ServerHandle>,
    conn: redis::aio::MultiplexedConnection,
    db_index: i64,
    caps: RedisCaps,
    read_only: bool,
}

impl RedisCtx {
    #[allow(dead_code)]
    pub fn id(&self) -> &ConnScopeId {
        &self.id
    }

    /// The handle, cloned out of the registry — `MultiplexedConnection` is itself a cheap clone
    /// over a shared socket, so this is the Redis equivalent of cloning a pool.
    pub fn conn(&self) -> redis::aio::MultiplexedConnection {
        self.conn.clone()
    }

    pub fn db_index(&self) -> i64 {
        self.db_index
    }

    pub fn caps(&self) -> RedisCaps {
        self.caps.clone()
    }

    /// The server config, for the paths that open a *second* socket rather than reuse this one —
    /// Pub/Sub and the Profiler, which hold a connection in a blocking read. It is the **tunneled**
    /// config, so a reconnect reuses the SSH tunnel that is still alive on `ServerHandle`.
    pub fn config(&self) -> Value {
        self.server.config()
    }

    /// The shared handle, for opening another db index on this server — the Redis twin of
    /// `ConnCtx::server_arc`, and load-bearing for the same reason: a second `ServerHandle` would
    /// open its own tunnel and close it as soon as the first connection went away.
    pub fn server_arc(&self) -> Arc<ServerHandle> {
        self.server.clone()
    }

    pub fn read_only(&self) -> bool {
        self.read_only
    }

    /// Whether this connection reaches its server through an SSH tunnel — the connection-status
    /// popover labels the connection `ssh` from it.
    pub fn has_ssh_tunnel(&self) -> bool {
        self.server.ssh_tunnel.is_some()
    }
}

/// The Redis twin of `ctx_of`, and same reason for living here: `RedisCtx`'s fields are private, so
/// the one place allowed to build one is the module that declares it.
///
/// `read_only` is read from the entry — i.e. inside the registry lock the caller holds — and carried
/// on the ctx: a command that asked the registry a second time could see a different answer than
/// the one it validated against.
pub(super) fn redis_ctx_of(key: &ConnScopeId, entry: &ConnEntry) -> Result<RedisCtx, String> {
    let LiveConn::Redis(r) = &entry.conn else {
        return Err("Chưa kết nối Redis".to_string());
    };
    Ok(RedisCtx {
        id: key.clone(),
        server: entry.server.clone(),
        conn: r.conn.clone(),
        db_index: r.db_index,
        caps: r.caps.clone(),
        read_only: entry.read_only,
    })
}
