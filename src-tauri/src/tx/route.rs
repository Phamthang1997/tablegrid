//! Routing: does this statement run on a pooled connection or on the pinned session?
//!
//! `should_route()` must be asked at the TOP of every SQL execution path. Routing only some of them
//! means a grid refresh reads through a different connection and cannot see the uncommitted data —
//! which to the user reads as lost data.

use std::time::Instant;

use serde_json::Value;
use tauri::ipc::Channel;

use crate::database::{self, DbConnection, DbKind};

use super::effect::{TxEffect, begin_statements, dialect_of, is_write_stmt, tx_effect};
use super::session::{
    Pinned, apply_effect, check_not_aborted, conn_scope_id, emit_state, get_session, is_open,
    release_if_closed, session_for, tx_registry,
};

// `reject_if_pending` was deleted along with `switch_database` — it existed only to guard swapping the pool
// out from under a live session. Nothing does that any more: `open_database` adds a NEW pool and so never
// touches an existing session, which leaves nothing to reject.

/// Should this statement run on the pinned session instead of a pooled connection?
///
/// Three reasons, and the third is what makes a hand-typed `BEGIN` work: before this existed, a
/// `BEGIN` typed into the SQL editor went to a pooled connection, the next statement went to
/// another one, and the connection carrying the open transaction went back to the pool holding
/// locks. The statement that opens a transaction has to create the session it belongs to.
pub fn should_route(conn: &DbConnection, sql: &str) -> bool {
    // A pool this process opened for itself is never the user's session — `ConnId::Adhoc` has no
    // session id at all. See §0 of docs/multi-connection-plan.md for what that used to cost.
    let Some(id) = conn_scope_id(conn) else {
        return false;
    };
    // `get_session`, not `session_for`: this runs on EVERY statement, including each of the 50k in a
    // restore, and the check path must not write to the map. No session yet == auto-commit, which is
    // the right answer for a connection never switched to manual mode.
    if let Some(s) = get_session(id) {
        let m = match s.meta.lock() {
            Ok(m) => m,
            Err(e) => e.into_inner(),
        };
        if !m.autocommit || m.open {
            return true;
        }
    }
    tx_effect(dialect_of(conn), database::strip_leading_comments(sql)) == TxEffect::Begin
}

// ---------------------------------------------------------------------------
// Running statements through the session
// ---------------------------------------------------------------------------

/// Take this connection's session lock, pinning a connection on first use.
///
/// The `Arc` is cloned out and the **registry lock is already released** by the time we await:
/// holding the map guard across `.await` would violate `CODING_STANDARDS.md` §6.3 and would put the
/// global serialisation back one level up — exactly what the per-session `pinned` removes.
pub(super) async fn lock_pinned(
    conn: &DbConnection,
) -> Result<tokio::sync::OwnedMutexGuard<Option<Pinned>>, String> {
    // English, and deliberately not in `backendErrors.ts`: unreachable in practice, because every
    // caller got here through `should_route`, which returns false for `ConnId::Adhoc`. A developer
    // diagnostic, not a user condition — same call as the one made for `sole()` in Phase 1b.
    let id = conn_scope_id(conn).ok_or("internal: ad-hoc connection has no transaction session")?;
    let pinned = session_for(id).pinned.clone();
    let mut guard = pinned.lock_owned().await;
    if guard.is_none() {
        *guard = Some(match &conn.kind {
            DbKind::Sqlite(_) => Pinned::Sqlite,
            DbKind::Postgres(pool) => {
                Pinned::Postgres(pool.acquire().await.map_err(|e| e.to_string())?)
            }
            DbKind::Mysql(pool) => Pinned::Mysql(pool.acquire().await.map_err(|e| e.to_string())?),
        });
    }
    Ok(guard)
}

/// Run one statement on the pinned connection, without touching transaction state.
pub(super) async fn raw_on_pinned(
    pinned: &mut Pinned,
    conn: &DbConnection,
    sql: &str,
) -> Result<Vec<Value>, String> {
    match pinned {
        Pinned::Sqlite => match &conn.kind {
            DbKind::Sqlite(arc) => database::sqlite_raw(arc, sql),
            _ => Err("Kết nối không khớp với phiên transaction".to_string()),
        },
        Pinned::Postgres(c) => database::pg_raw(c, sql).await,
        Pinned::Mysql(c) => database::mysql_raw(c, sql).await,
    }
}

/// Issue BEGIN if the transaction is not open yet.
///
/// Skipped when the statement about to run is itself a BEGIN — otherwise Postgres warns about a
/// nested BEGIN and MySQL silently commits the one we just opened.
async fn ensure_begin(
    pinned: &mut Pinned,
    conn: &DbConnection,
    effect: &TxEffect,
) -> Result<(), String> {
    // Same invariant as `lock_pinned`, which every caller went through first.
    let session = session_for(
        conn_scope_id(conn).ok_or("internal: ad-hoc connection has no transaction session")?,
    );
    let (already_open, isolation, read_only) = {
        let m = session.meta.lock().map_err(|e| e.to_string())?;
        (m.open, m.isolation.clone(), m.read_only)
    };
    if already_open || *effect == TxEffect::Begin {
        return Ok(());
    }
    for stmt in begin_statements(dialect_of(conn), isolation.as_deref(), read_only) {
        raw_on_pinned(pinned, conn, &stmt).await?;
    }
    let mut m = session.meta.lock().map_err(|e| e.to_string())?;
    m.open = true;
    m.aborted = false;
    m.statements = 0;
    m.started_at = Some(Instant::now());
    m.savepoints.clear();
    Ok(())
}

/// `execute_raw_sql_generic` routed through the session.
pub(crate) async fn run_raw(conn: &DbConnection, sql: String) -> Result<Vec<Value>, String> {
    let stripped = database::strip_leading_comments(&sql);
    let effect = tx_effect(dialect_of(conn), stripped);
    let is_write = is_write_stmt(stripped);
    let id = conn_scope_id(conn).ok_or("internal: ad-hoc connection has no transaction session")?;
    check_not_aborted(id, &effect)?;

    let mut guard = lock_pinned(conn).await?;
    let pinned = guard.as_mut().ok_or("Phiên transaction không sẵn sàng")?;
    ensure_begin(pinned, conn, &effect).await?;

    let out = raw_on_pinned(pinned, conn, &sql).await;
    drop(guard);

    match &out {
        Ok(_) => apply_effect(id, &effect, is_write, &sql, None),
        Err(e) => apply_effect(id, &effect, is_write, &sql, Some(e)),
    }
    // A COMMIT/ROLLBACK frees the connection back to the pool; holding it after the transaction
    // ended would starve the pool for no reason.
    release_if_closed(id).await;
    out
}

/// `run_bound_query` routed through the session (parameterized single statement).
pub(crate) async fn run_bound(
    conn: &DbConnection,
    sql: String,
    params: &[Value],
) -> Result<Vec<Value>, String> {
    let stripped = database::strip_leading_comments(&sql);
    let effect = tx_effect(dialect_of(conn), stripped);
    let is_write = is_write_stmt(stripped);
    let id = conn_scope_id(conn).ok_or("internal: ad-hoc connection has no transaction session")?;
    check_not_aborted(id, &effect)?;

    let mut guard = lock_pinned(conn).await?;
    let pinned = guard.as_mut().ok_or("Phiên transaction không sẵn sàng")?;
    ensure_begin(pinned, conn, &effect).await?;

    let out = match pinned {
        Pinned::Sqlite => match &conn.kind {
            DbKind::Sqlite(arc) => database::sqlite_bound(arc, &sql, params),
            _ => Err("Kết nối không khớp với phiên transaction".to_string()),
        },
        Pinned::Postgres(c) => database::pg_bound(c, &sql, params).await,
        Pinned::Mysql(c) => database::mysql_bound(c, &sql, params).await,
    };
    drop(guard);

    match &out {
        Ok(_) => apply_effect(id, &effect, is_write, &sql, None),
        Err(e) => apply_effect(id, &effect, is_write, &sql, Some(e)),
    }
    release_if_closed(id).await;
    out
}

/// `run_bound` with `setup` statements (`SET LOCAL …`) scoped to this one query. Postgres only.
///
/// Runs inside a savepoint that is always rolled back: `ROLLBACK TO` undoes a `SET LOCAL` as well,
/// so the user's transaction keeps its own settings, and a failing query cannot leave it aborted
/// (25P02) either. The query itself is counted like any other read — it opens the transaction if
/// manual mode has not yet, exactly as a SELECT from the editor would.
pub(crate) async fn run_bound_scoped(
    conn: &DbConnection,
    setup: &[String],
    sql: String,
    params: &[Value],
) -> Result<Vec<Value>, String> {
    let stripped = database::strip_leading_comments(&sql);
    let effect = tx_effect(dialect_of(conn), stripped);
    let is_write = is_write_stmt(stripped);
    let id = conn_scope_id(conn).ok_or("internal: ad-hoc connection has no transaction session")?;
    check_not_aborted(id, &effect)?;

    let mut guard = lock_pinned(conn).await?;
    let pinned = guard.as_mut().ok_or("Phiên transaction không sẵn sàng")?;
    ensure_begin(pinned, conn, &effect).await?;
    let Pinned::Postgres(c) = pinned else {
        return Err("Tìm kiếm vector chỉ hỗ trợ PostgreSQL".to_string());
    };

    const SP: &str = "tablegrid_vector_search";
    database::pg_raw(c, &format!("SAVEPOINT {SP}")).await?;
    let mut out = Ok(Vec::new());
    for stmt in setup {
        if let Err(e) = database::pg_raw(c, stmt).await {
            out = Err(e);
            break;
        }
    }
    if out.is_ok() {
        out = database::pg_bound(c, &sql, params).await;
    }
    // Both always run. If the rollback itself fails the savepoint is still there; say so rather
    // than report a result from a transaction whose state is now unknown.
    let undo = database::pg_raw(c, &format!("ROLLBACK TO SAVEPOINT {SP}")).await;
    let release = database::pg_raw(c, &format!("RELEASE SAVEPOINT {SP}")).await;
    drop(guard);
    undo.and(release)?;

    match &out {
        Ok(_) => apply_effect(id, &effect, is_write, &sql, None),
        Err(e) => apply_effect(id, &effect, is_write, &sql, Some(e)),
    }
    release_if_closed(id).await;
    out
}

/// `stream_one_statement` routed through the session.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_stream(
    conn: &DbConnection,
    sql: &str,
    params: &[Value],
    stmt_index: usize,
    channel: &Channel<Value>,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    let stripped = database::strip_leading_comments(sql);
    let effect = tx_effect(dialect_of(conn), stripped);
    let is_write = is_write_stmt(stripped);
    let id = conn_scope_id(conn).ok_or("internal: ad-hoc connection has no transaction session")?;
    check_not_aborted(id, &effect)?;

    let mut guard = lock_pinned(conn).await?;
    let pinned = guard.as_mut().ok_or("Phiên transaction không sẵn sàng")?;
    ensure_begin(pinned, conn, &effect).await?;

    let out = match pinned {
        // SQLite streams off the shared handle exactly as it does outside a transaction — the
        // handle IS the session. Calling the dialect helper directly (not `stream_one_statement`)
        // matters: that one routes back here and would recurse.
        Pinned::Sqlite => match &conn.kind {
            DbKind::Sqlite(arc) => {
                database::sqlite_stream(arc, sql, params, stmt_index, channel, cancel).await
            }
            _ => Err("Kết nối không khớp với phiên transaction".to_string()),
        },
        Pinned::Postgres(c) => {
            database::pg_stream(c, sql, params, stmt_index, channel, cancel).await
        }
        Pinned::Mysql(c) => {
            database::mysql_stream(c, sql, params, stmt_index, channel, cancel).await
        }
    };
    drop(guard);

    match &out {
        Ok(_) => apply_effect(id, &effect, is_write, sql, None),
        Err(e) => apply_effect(id, &effect, is_write, sql, Some(e)),
    }
    release_if_closed(id).await;
    out
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/// Roll back and drop the pinned connection. Used when the connection underneath is about to
/// disappear (disconnect, connect elsewhere, IAM pool swap): the transaction would die anyway, and
/// dying silently is what makes users lose work without knowing it.
pub async fn abandon(conn: Option<&DbConnection>) {
    let Some(id) = conn.and_then(conn_scope_id).map(str::to_string) else {
        return;
    };
    let Some(session) = get_session(&id) else {
        return;
    };
    let was_open = is_open(&id);
    let pinned = session.pinned.clone();
    let mut guard = pinned.lock_owned().await;
    if was_open && let (Some(p), Some(c)) = (guard.as_mut(), conn) {
        let _ = raw_on_pinned(p, c, "ROLLBACK").await;
    }
    *guard = None;
    drop(guard);
    {
        let mut m = match session.meta.lock() {
            Ok(m) => m,
            Err(e) => e.into_inner(),
        };
        m.close();
        m.last_implicit_commit = false;
    }
    emit_state(&id);
}

/// Full reset on a new connection: auto-commit preference included, because isolation levels are
/// dialect-specific and carrying "REPEATABLE READ" over to SQLite would be meaningless.
pub async fn reset(conn: Option<&DbConnection>) {
    abandon(conn).await;
    let Some(id) = conn.and_then(conn_scope_id).map(str::to_string) else {
        return;
    };
    // **Remove the entry, do not just reset its fields.** Leaving it behind leaks one entry per
    // connect/disconnect cycle, and — the part that bites — a later connection reusing this id would
    // inherit `autocommit = false` and silently open a transaction the user never asked for.
    // Removal also *is* the reset: a missing entry reads as auto-commit on, nothing open, no
    // isolation override, which is exactly the state this used to write by hand.
    {
        let mut map = match tx_registry().lock() {
            Ok(m) => m,
            Err(e) => e.into_inner(),
        };
        map.remove(id.as_str());
    }
    emit_state(&id);
}
