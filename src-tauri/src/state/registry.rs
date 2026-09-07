//! `ConnRegistry` — the `conn_id` -> connection map, and `acquire()` is the ONLY way out.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;

use super::ctx::{ConnCtx, RedisCtx, ctx_of, redis_ctx_of};
use super::entry::{ConnEntry, LiveConn, RedisConn};
use super::ids::ConnScopeId;
use crate::database::DbConnection;

/// Every open connection, keyed by `conn_id`.
///
/// `std::sync::Mutex`, not `tokio`'s: the critical section is "clone a handle out and drop the
/// guard", which must stay sub-microsecond and must never span an `.await` (`CODING_STANDARDS.md`
/// §6.3). An async mutex is slower uncontended and invites exactly the hold-across-await this
/// codebase forbids.
pub struct ConnRegistry {
    inner: Mutex<HashMap<ConnScopeId, ConnEntry>>,
}

impl Default for ConnRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ConnRegistry {
    pub fn new() -> Self {
        ConnRegistry {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// The only way to get a connection out of the registry.
    ///
    /// An unknown id reuses the existing `"Chưa kết nối CSDL"` verbatim rather than adding a
    /// message: to the user an id that no longer resolves and a connection that was closed are the
    /// same event, and reusing the literal keeps `src/utils/backendErrors.ts` and its
    /// byte-identical Vietnamese round-trip test untouched (§6).
    pub fn acquire(&self, id: &str) -> Result<ConnCtx, String> {
        let map = self.inner.lock().map_err(|e| e.to_string())?;
        // `get_key_value`, not `get`: the ConnCtx carries the *conn_id* (this map's key), which is
        // what tx will key a session on. `entry.server.id` is a different thing — several
        // conn_ids share one server.
        let (key, entry) = map
            .get_key_value(id)
            .ok_or_else(|| "Chưa kết nối CSDL".to_string())?;
        ctx_of(key, entry)
    }

    /// The Redis twin of `acquire`.
    /// Same lookup, same error literal for an id that is not a Redis connection — see `ctx_of`.
    /// The read-only flag is read inside this lock and carried on the ctx (`redis_ctx_of`): a
    /// command that asked the registry a second time could see a different answer than the one it
    /// validated against.
    /// against.
    pub fn acquire_redis(&self, id: &str) -> Result<RedisCtx, String> {
        let map = self.inner.lock().map_err(|e| e.to_string())?;
        let (key, entry) = map
            .get_key_value(id)
            .ok_or_else(|| "Chưa kết nối Redis".to_string())?;
        redis_ctx_of(key, entry)
    }

    /// Every open connection, as the left rail needs to draw it (§4.2c): the rail lists **open
    /// connections**, not every database on the server, so this replaces the `list_databases` query
    /// it used to run against the active connection.
    ///
    /// Sorted by id so the rail does not reshuffle itself on every poll — a `HashMap` has no order.
    pub fn list(&self) -> Result<Vec<Value>, String> {
        let map = self.inner.lock().map_err(|e| e.to_string())?;
        let mut out: Vec<(ConnScopeId, Value)> = map
            .iter()
            .map(|(id, e)| {
                (
                    id.clone(),
                    serde_json::json!({
                        "connId": &**id,
                        "db": e.db,
                        "dialect": e.conn.dialect(),
                        "serverId": &*e.server.id,
                        "schema": e.current_schema,
                        // The rail's badge (§4.2b): the number of WRITE statements waiting to be committed on this connection.
                        "pending": crate::tx::pending_count(id),
                        "readOnly": e.read_only,
                        "mcpExposed": e.mcp_exposed,
                        "mcpWrite": e.mcp_write,
                    }),
                )
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out.into_iter().map(|(_, v)| v).collect())
    }

    /// Every open connection, with the handle **cloned out from under the lock**.
    ///
    /// It exists for `ping_connections`, which has to touch every connection with an `.await`. Returning
    /// JSON like `list()` will not do: the registry lock is a `std::sync::Mutex` and must never be held
    /// across an await (`CODING_STANDARDS.md` §6.3). Cloning an `Arc`/pool is one atomic increment.
    ///
    /// SQL connections only. `ping_connections` runs a liveness SELECT, which means nothing for Redis;
    /// pinging Redis is a `PING` on a `RedisCtx` and is a separate job.
    pub fn handles(&self) -> Result<Vec<(ConnScopeId, DbConnection)>, String> {
        let map = self.inner.lock().map_err(|e| e.to_string())?;
        let mut out: Vec<(ConnScopeId, DbConnection)> = map
            .iter()
            .filter_map(|(id, e)| e.conn.sql().map(|c| (id.clone(), c.clone())))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }

    pub fn insert(&self, id: ConnScopeId, entry: ConnEntry) -> Result<(), String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        map.insert(id, entry);
        Ok(())
    }

    /// Replaces the live handle of one entry, for an IAM token refresh that rebuilt the pool.
    pub fn replace_conn(&self, id: &str, conn: DbConnection) -> Result<(), String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = map.get_mut(id) {
            entry.conn = LiveConn::Sql(conn);
        }
        Ok(())
    }

    /// Replaces the live Redis handle of one entry — the reconnect a Pub/Sub or Profiler teardown
    /// leaves behind, and the only Redis analogue of the IAM pool swap above.
    pub fn replace_redis_conn(&self, id: &str, conn: RedisConn) -> Result<(), String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = map.get_mut(id) {
            entry.conn = LiveConn::Redis(conn);
        }
        Ok(())
    }

    /// The connection already open on this `(server, database)`, if any. Makes `open_database`
    /// idempotent: clicking a database twice must not mint a second pool for the same place.
    pub fn find(&self, server: &str, db: &str) -> Result<Option<ConnScopeId>, String> {
        let map = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(map
            .iter()
            .find(|(_, e)| &*e.server.id == server && e.db == db)
            .map(|(id, _)| id.clone()))
    }

    /// An already-open SQLite connection on the same file, if any.
    ///
    /// SQLite is the one dialect where a second connection to the same database is not just
    /// redundant but harmful: two `rusqlite::Connection`s on one file mean `SQLITE_BUSY` the moment
    /// both write. Postgres and MySQL are left alone — opening the same database twice there is a
    /// legitimate thing to want (two independent sessions), and the credentials may even differ.
    ///
    /// Paths are compared after `canonicalize`, which folds `..`, relative paths and — on Windows —
    /// case. A path that cannot be canonicalized (the file is gone) falls back to a raw compare, so
    /// a missing file never *matches* something it should not.
    pub fn find_sqlite(&self, path: &str) -> Result<Option<ConnScopeId>, String> {
        let want = std::fs::canonicalize(path).ok();
        let map = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(map
            .iter()
            .find(|(_, e)| {
                let Some(conn) = e.conn.sql() else {
                    return false;
                };
                if !matches!(conn.kind, crate::database::DbKind::Sqlite(_)) {
                    return false;
                }
                match (&want, std::fs::canonicalize(&e.db).ok()) {
                    // `want` is matched by reference (it is reused on every iteration), so `a` is a
                    // `&PathBuf` while `b` is owned.
                    (Some(a), Some(b)) => *a == b,
                    _ => e.db == path,
                }
            })
            .map(|(id, _)| id.clone()))
    }

    /// Drops one entry and hands it back, so the caller can roll back its transaction session and
    /// close its pool *after* the registry lock is released — neither may run while a guard is held.
    pub fn remove(&self, id: &str) -> Result<Option<ConnEntry>, String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(map.remove(id))
    }

    pub fn set_read_only(&self, id: &str, on: bool) -> Result<(), String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = map.get_mut(id) {
            entry.read_only = on;
        }
        Ok(())
    }

    pub fn is_read_only(&self, id: &str) -> bool {
        let map = match self.inner.lock() {
            Ok(m) => m,
            Err(e) => e.into_inner(),
        };
        map.get(id).map(|e| e.read_only).unwrap_or(false)
    }

    /// Show this connection to the built-in MCP server, or hide it again.
    pub fn set_mcp_exposed(&self, id: &str, on: bool) -> Result<(), String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = map.get_mut(id) {
            entry.mcp_exposed = on;
            // Un-sharing takes the write permission with it. Leaving it set would mean re-ticking
            // the read box silently restores write access the user granted in another context -
            // a permission coming back on its own is the one behaviour a permission must never have.
            if !on {
                entry.mcp_write = false;
            }
        }
        Ok(())
    }

    /// Allow an AI client to ask for writes on this connection, or stop allowing it.
    ///
    /// Refuses on a connection that is not shared at all: a write tick on a hidden connection is a
    /// permission with nothing to apply to, and it would be a lie shown as a checked box.
    pub fn set_mcp_write(&self, id: &str, on: bool) -> Result<(), String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        match map.get_mut(id) {
            Some(entry) if entry.mcp_exposed || !on => {
                entry.mcp_write = on;
                Ok(())
            }
            Some(_) => {
                Err("Kết nối này chưa được chia sẻ với MCP nên không thể bật quyền ghi".to_string())
            }
            None => Ok(()),
        }
    }

    /// May an AI client write on this connection?
    ///
    /// Reads through a poisoned lock and defaults an unknown id to `false`, for the same reason as
    /// `is_mcp_exposed`: every way of not knowing has to answer no.
    pub fn is_mcp_write_allowed(&self, id: &str) -> bool {
        let map = match self.inner.lock() {
            Ok(m) => m,
            Err(e) => e.into_inner(),
        };
        map.get(id)
            .map(|e| e.mcp_exposed && e.mcp_write)
            .unwrap_or(false)
    }

    /// Is this `conn_id` one the user shared with AI clients?
    ///
    /// A poisoned lock reads through rather than failing open in the other direction: the answer is
    /// still whatever the user set, and defaulting to `true` here would expose everything the moment
    /// any thread panicked. An unknown id is `false` for the same reason.
    pub fn is_mcp_exposed(&self, id: &str) -> bool {
        let map = match self.inner.lock() {
            Ok(m) => m,
            Err(e) => e.into_inner(),
        };
        map.get(id).map(|e| e.mcp_exposed).unwrap_or(false)
    }

    /// The SQL connections the user shared with AI clients, as the MCP `list_connections` tool needs
    /// them.
    ///
    /// Filtered HERE rather than by the caller: a tool that received the full list and filtered it
    /// itself would be one forgotten `.filter()` away from listing production. Redis entries are
    /// dropped too - MCP has no Redis tools, so an exposed Redis connection would be a name an AI
    /// could see but never use.
    /// Ids of the SQL connections shared with MCP clients.
    ///
    /// Exists so `policy::pick_connection` can answer "is there exactly one?" without building and
    /// re-parsing the JSON that `list_mcp_exposed` returns. Same filter as that function, and it has
    /// to stay the same filter: a Redis connection counted here would make a lone Redis the "only
    /// shared connection" for tools that cannot touch it.
    pub fn mcp_exposed_ids(&self) -> Vec<String> {
        let map = match self.inner.lock() {
            Ok(m) => m,
            Err(e) => e.into_inner(),
        };
        map.iter()
            .filter(|(_, e)| e.mcp_exposed && e.conn.sql().is_some())
            .map(|(id, _)| (**id).to_string())
            .collect()
    }

    pub fn list_mcp_exposed(&self) -> Result<Vec<Value>, String> {
        let map = self.inner.lock().map_err(|e| e.to_string())?;
        let mut out: Vec<(ConnScopeId, Value)> = map
            .iter()
            .filter(|(_, e)| e.mcp_exposed && e.conn.sql().is_some())
            .map(|(id, e)| {
                (
                    id.clone(),
                    // **snake_case, unlike `list()` above.** This shape is read by an AI client and
                    // nothing else, and the field it must send back is spelled `connection_id` -
                    // tool parameters derive their names from Rust struct fields (`ConnArgs`). When
                    // this returned `connectionId`, the client had to read one spelling and send
                    // another; a real client got `failed to deserialize parameters: missing field
                    // 'connection_id'` for doing the obvious thing. The whole object follows the
                    // parameter convention so there is one casing on the MCP wire, not two.
                    serde_json::json!({
                        "connection_id": &**id,
                        "write_allowed": e.mcp_write,
                        "database": e.db,
                        "dialect": e.conn.dialect(),
                        "schema": e.current_schema,
                        // What the AI is allowed to attempt. It cannot write in this build either
                        // way, but a connection the user has additionally locked is worth saying.
                        "read_only": e.read_only,
                    }),
                )
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out.into_iter().map(|(_, v)| v).collect())
    }

    pub fn set_schema(&self, id: &str, schema: Option<String>) -> Result<(), String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = map.get_mut(id) {
            entry.current_schema = schema;
        }
        Ok(())
    }

    /// The database an entry points at, after a MySQL `USE` inside a restore — the last writer left
    /// now that `switch_database` is gone. It cannot go the same way: a `USE` comes from inside the
    /// dump being replayed, so there is no command call to mint a new `conn_id` from (§4.3).
    pub fn set_db(&self, id: &str, db: String) -> Result<(), String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = map.get_mut(id) {
            entry.db = db;
        }
        Ok(())
    }
}
