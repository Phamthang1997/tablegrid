//! `DbConnection` — the handle of one SQL connection, and `Exec` — a connection dedicated
//! to a whole run of statements.

use std::sync::{Arc, Mutex};

use duckdb::Connection as DuckConnection;
use rusqlite::Connection as SqliteConnection;
use sqlx::{MySqlPool, PgPool};

#[derive(Clone)]
pub enum DbKind {
    Sqlite(Arc<Mutex<SqliteConnection>>),
    Postgres(PgPool),
    Mysql(MySqlPool),
    /// One shared handle, like SQLite: a DuckDB file is a database, not a server.
    DuckDb(Arc<Mutex<DuckConnection>>),
}

/// A live connection handle plus **which connection it is**.
///
/// The id rides inside the handle so the ~35 helper signatures that take `&DbConnection` and the 66
/// `execute_raw_sql_generic` call sites stay byte-identical, while `tx/` finally has a key to
/// look a session up by (§4.4a of `docs/multi-connection-plan.md`).
#[derive(Clone)]
pub struct DbConnection {
    pub id: crate::state::ConnId,
    pub kind: DbKind,
}

impl DbConnection {
    /// A handle on a registry entry — the only kind a transaction session may pin.
    pub fn session(id: crate::state::ConnScopeId, kind: DbKind) -> Self {
        DbConnection {
            id: crate::state::ConnId::Session(id),
            kind,
        }
    }

    /// A handle on a pool this process opened for itself. See `ConnId::Adhoc`.
    pub fn adhoc(kind: DbKind) -> Self {
        DbConnection {
            id: crate::state::ConnId::Adhoc,
            kind,
        }
    }
}

/// One statement target: a pooled connection (Postgres/MySQL) or the shared SQLite handle.
///
/// A dedicated connection is the point. `execute_raw_sql_generic` acquires a NEW connection from
/// the pool per call, so `BEGIN` / `SET FOREIGN_KEY_CHECKS` / `SET session_replication_role` /
/// `PRAGMA foreign_keys` issued through it would land on a different session than the statements
/// they are meant to wrap, and quietly do nothing.
pub(crate) enum Exec {
    Sqlite(Arc<Mutex<SqliteConnection>>),
    Postgres(sqlx::pool::PoolConnection<sqlx::Postgres>),
    Mysql(sqlx::pool::PoolConnection<sqlx::MySql>),
}

impl Exec {
    /// Takes one connection out of the pool and holds it for the caller's whole sequence.
    pub(crate) async fn acquire(conn: &DbConnection) -> Result<Exec, String> {
        Ok(match &conn.kind {
            DbKind::Sqlite(arc) => Exec::Sqlite(arc.clone()),
            DbKind::Postgres(pool) => {
                Exec::Postgres(pool.acquire().await.map_err(|e| e.to_string())?)
            }
            DbKind::Mysql(pool) => Exec::Mysql(pool.acquire().await.map_err(|e| e.to_string())?),
            // Every write path that needs one connection for a sequence of statements comes through
            // here (the grid's Save, table import, data generation, drop/truncate), so this one
            // refusal is what keeps DuckDB read-mostly.
            DbKind::DuckDb(_) => return Err(super::DUCK_UNSUPPORTED.to_string()),
        })
    }

    pub(crate) async fn run(&mut self, sql: String) -> Result<(), String> {
        match self {
            Exec::Sqlite(arc) => {
                let conn = arc.lock().map_err(|e| e.to_string())?;
                conn.execute_batch(&sql).map_err(|e| e.to_string())
            }
            // raw_sql = text protocol. MySQL rejects some statements in the prepared protocol
            // (error 1295) and these statements carry literals only, so nothing is gained
            // by preparing them.
            Exec::Postgres(c) => sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
                .execute(&mut **c)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string()),
            Exec::Mysql(c) => sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
                .execute(&mut **c)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string()),
        }
    }

    /// For statements whose failure must not abort the caller (a session flag the server refuses,
    /// an optional catalog table that does not exist).
    pub(crate) async fn try_run(&mut self, sql: &str) {
        let _ = self.run(sql.to_string()).await;
    }
}
