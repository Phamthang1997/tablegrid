//! Where an MCP statement actually runs: the database enforces what `policy` only classifies.
//!
//! `policy::ensure_single_read` reads the first keyword of a statement, and a keyword is not a
//! guarantee. A read head can still write: `EXPLAIN ANALYZE DELETE …` executes the DELETE on
//! Postgres, `SELECT … INTO new_table` creates a table, `SELECT nextval(…)` advances a sequence, and
//! any function called from a SELECT may have side effects. No text check can list all of those, so
//! every read here runs where the DATABASE refuses the write:
//!
//! - **Postgres**: inside `BEGIN READ ONLY`, always rolled back.
//! - **MySQL**: inside `START TRANSACTION READ ONLY`, always rolled back.
//! - **SQLite**: with `PRAGMA query_only = ON` for the duration, restored before the lock is freed.
//!
//! **The time limit has to be one the database obeys.** `with_timeout` only drops the future, and
//! that is not a limit on two of the three engines: on SQLite the statement is synchronous, so
//! `tokio::time::timeout` never got to check its clock and a runaway query ran to the end; on a
//! server it leaves the statement running after the client gave up - and for a WRITE, possibly
//! committing after the AI was told it had been stopped, which invites a retry that writes twice.
//! So: Postgres gets a server-side `statement_timeout` (a cancelled autocommit statement is rolled
//! back, so the outcome is known), SQLite runs on a blocking thread the timer can `interrupt()`,
//! and MySQL - which has no server-side limit for anything but SELECT - is the one engine where a
//! timed-out write is reported as "outcome unknown" rather than as "stopped".
//!
//! A pooled connection whose statement failed or was cut off is CLOSED rather than returned: its
//! session state is unknown, and the next borrower is the user's own grid.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection as SqliteConnection;
use serde_json::Value;
use sqlx::Connection;

use crate::database::{
    DbConnection, DbKind, mysql_raw, pg_raw, reject_if_read_only, sqlite_raw_on,
};

/// How much longer the client waits than the server-side limit, so that on Postgres the server's
/// own cancellation - a definite "not applied" - arrives before our "we gave up waiting".
const CLIENT_GRACE: Duration = Duration::from_secs(2);

/// What a read is told when the limit is hit. English: the reader is an AI client.
fn read_timeout_msg(limit: Duration) -> String {
    format!(
        "the query ran longer than {}s and was stopped. Narrow it (a WHERE clause, a LIMIT) and try \
         again.",
        limit.as_secs()
    )
}

/// A write whose outcome is known: the engine cancelled it, and a cancelled autocommit statement is
/// rolled back.
fn write_stopped_msg(limit: Duration) -> String {
    format!(
        "the statement ran longer than {}s and was cancelled by the database, so nothing was \
         applied.",
        limit.as_secs()
    )
}

/// A write whose outcome is NOT known. Saying "stopped" here would be the lie that causes a retry.
fn write_unknown_msg(limit: Duration) -> String {
    format!(
        "the statement did not finish within {}s. It may still have been applied - check with a \
         SELECT before retrying, or a retry may apply it twice.",
        limit.as_secs()
    )
}

/// Run ONE read statement so that the database itself refuses any write it may contain.
pub async fn run_read(
    conn: &DbConnection,
    sql: String,
    limit: Duration,
) -> Result<Vec<Value>, String> {
    // Same belt as the pooled funnel: a connection the user marked read-only stays read-only.
    reject_if_read_only(conn, &sql)?;
    match &conn.kind {
        DbKind::Sqlite(handle) => {
            sqlite_timed(
                handle.clone(),
                limit,
                read_timeout_msg(limit),
                move |c, finished| query_only_run(c, &sql, finished),
            )
            .await
        }
        DbKind::Postgres(pool) => {
            let mut pc = pool.acquire().await.map_err(|e| e.to_string())?;
            let ms = limit.as_millis();
            let body = async {
                let mut tx = pc
                    .begin_with("BEGIN READ ONLY")
                    .await
                    .map_err(|e| e.to_string())?;
                // `SET LOCAL` ends with the transaction, so nothing leaks into the pooled session.
                sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                    "SET LOCAL statement_timeout = {ms}"
                )))
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                let out = pg_raw(&mut tx, &sql).await;
                tx.rollback().await.map_err(|e| e.to_string())?;
                out
            };
            let res = tokio::time::timeout(limit + CLIENT_GRACE, body).await;
            settle(res, &mut pc, read_timeout_msg(limit))
        }
        DbKind::Mysql(pool) => {
            let mut pc = pool.acquire().await.map_err(|e| e.to_string())?;
            let ms = limit.as_millis();
            let body = async {
                // Session-level, so it is put back afterwards. MariaDB has no such variable; then the
                // client-side limit and closing the connection are what is left.
                let limited = sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                    "SET SESSION max_execution_time = {ms}"
                )))
                .execute(&mut *pc)
                .await
                .is_ok();
                let out = {
                    let mut tx = pc
                        .begin_with("START TRANSACTION READ ONLY")
                        .await
                        .map_err(|e| e.to_string())?;
                    let out = mysql_raw(&mut tx, &sql).await;
                    tx.rollback().await.map_err(|e| e.to_string())?;
                    out
                };
                if limited {
                    sqlx::raw_sql("SET SESSION max_execution_time = DEFAULT")
                        .execute(&mut *pc)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                out
            };
            let res = tokio::time::timeout(limit, body).await;
            settle(res, &mut pc, read_timeout_msg(limit))
        }
    }
}

/// Run ONE approved write, autocommit, under a limit the database obeys where it can.
pub async fn run_write(
    conn: &DbConnection,
    sql: String,
    limit: Duration,
) -> Result<Vec<Value>, String> {
    reject_if_read_only(conn, &sql)?;
    match &conn.kind {
        DbKind::Sqlite(handle) => {
            // An interrupted SQLite statement is rolled back, so this outcome is known too.
            sqlite_timed(
                handle.clone(),
                limit,
                write_stopped_msg(limit),
                move |c, finished| {
                    let out = sqlite_raw_on(c, &sql);
                    finished();
                    out
                },
            )
            .await
        }
        DbKind::Postgres(pool) => {
            let mut pc = pool.acquire().await.map_err(|e| e.to_string())?;
            let ms = limit.as_millis();
            // Session-level rather than `SET LOCAL` in a transaction: some DDL (`CREATE INDEX
            // CONCURRENTLY`, `VACUUM`) refuses to run inside a transaction block, and a write has to
            // keep the autocommit behaviour the approval dialog promised.
            let body = async {
                sqlx::raw_sql(sqlx::AssertSqlSafe(format!("SET statement_timeout = {ms}")))
                    .execute(&mut *pc)
                    .await
                    .map_err(|e| e.to_string())?;
                let out = pg_raw(&mut pc, &sql).await;
                sqlx::raw_sql("RESET statement_timeout")
                    .execute(&mut *pc)
                    .await
                    .map_err(|e| e.to_string())?;
                out
            };
            let res = tokio::time::timeout(limit + CLIENT_GRACE, body).await;
            // The server's own cancellation is the known outcome: say so in words the model acts on.
            settle(res, &mut pc, write_unknown_msg(limit)).map_err(|e| {
                if e.contains("statement timeout") {
                    write_stopped_msg(limit)
                } else {
                    e
                }
            })
        }
        DbKind::Mysql(pool) => {
            let mut pc = pool.acquire().await.map_err(|e| e.to_string())?;
            let res = tokio::time::timeout(limit, mysql_raw(&mut pc, &sql)).await;
            settle(res, &mut pc, write_unknown_msg(limit))
        }
    }
}

/// Outcome of a timed Postgres/MySQL statement. Anything but a clean result closes the connection.
///
/// A plain query error leaves the connection usable (the rollback or the autocommit already ran),
/// but telling it apart from a failed ROLLBACK/SET/RESET would take a second error type for a path
/// that costs one reconnect, so every failure closes.
fn settle<C: sqlx::Database>(
    res: Result<Result<Vec<Value>, String>, tokio::time::error::Elapsed>,
    pc: &mut sqlx::pool::PoolConnection<C>,
    timed_out: String,
) -> Result<Vec<Value>, String> {
    match res {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => {
            pc.close_on_drop();
            Err(e)
        }
        Err(_) => {
            pc.close_on_drop();
            Err(timed_out)
        }
    }
}

/// Shared between the SQLite worker and the timer, always under one mutex.
#[derive(Default)]
struct Gate {
    /// The timer gave up. A worker that only now obtained the connection lock must not start.
    cancelled: bool,
    /// Our statement finished. From here on an interrupt could only hit someone else's work.
    done: bool,
    handle: Option<rusqlite::InterruptHandle>,
}

/// Run `work` on the SQLite handle on a blocking thread, interrupting it when `limit` runs out.
///
/// `work` receives a `finished` callback and must call it as soon as the statement is done and
/// before any clean-up statement. Once it has run no interrupt is sent any more, so clean-up can
/// never be what an interrupt lands on. The `done` flag is written while the worker still holds the
/// connection lock, and read under the gate by the timer - so an interrupt can only reach OUR
/// statement, never the user's next one, which cannot start before that lock is freed.
async fn sqlite_timed<F>(
    handle: Arc<Mutex<SqliteConnection>>,
    limit: Duration,
    timed_out: String,
    work: F,
) -> Result<Vec<Value>, String>
where
    F: FnOnce(&SqliteConnection, &dyn Fn()) -> Result<Vec<Value>, String> + Send + 'static,
{
    let gate = Arc::new(Mutex::new(Gate::default()));
    let worker_gate = gate.clone();
    let late = timed_out.clone();

    let mut task = tokio::task::spawn_blocking(move || {
        // The lock may be held by the user's own long query, so the limit can run out while we wait.
        let guard = handle.lock().map_err(|e| e.to_string())?;
        {
            let mut g = worker_gate.lock().map_err(|e| e.to_string())?;
            if g.cancelled {
                return Err(late);
            }
            g.handle = Some(guard.get_interrupt_handle());
        }
        let finished = || {
            if let Ok(mut g) = worker_gate.lock() {
                g.done = true;
            }
        };
        work(&guard, &finished)
    });

    match tokio::time::timeout(limit, &mut task).await {
        Ok(joined) => joined.map_err(|e| e.to_string())?,
        Err(_) => {
            if let Ok(mut g) = gate.lock() {
                g.cancelled = true;
                if !g.done
                    && let Some(h) = &g.handle
                {
                    h.interrupt();
                }
            }
            // Wait for the worker to wind down, so the pragma is restored and the lock released
            // before this returns - the caller may run the next statement straight away. A statement
            // that finished in the instant after the timer fired keeps its real result.
            match task.await {
                Ok(Ok(v)) => Ok(v),
                _ => Err(timed_out),
            }
        }
    }
}

/// `query_only` on, the statement, then the pragma put back as it was - on every path, including a
/// failed or interrupted statement.
///
/// (An interrupt that arrived just before `finished` leaves a flag SQLite clears itself when the next
/// statement starts with none active, so it cannot fail the restore either.)
fn query_only_run(
    conn: &SqliteConnection,
    sql: &str,
    finished: &dyn Fn(),
) -> Result<Vec<Value>, String> {
    let was_on: i64 = conn
        .query_row("PRAGMA query_only", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let out = conn
        .execute_batch("PRAGMA query_only = ON")
        .map_err(|e| e.to_string())
        .and_then(|_| sqlite_raw_on(conn, sql));
    finished();
    let restore = if was_on != 0 {
        "PRAGMA query_only = ON"
    } else {
        "PRAGMA query_only = OFF"
    };
    // A failed restore would leave the user's connection refusing every write - one retry, and then
    // an error they hear about rather than a state they discover later.
    conn.execute_batch(restore)
        .or_else(|_| conn.execute_batch(restore))
        .map_err(|e| e.to_string())?;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Arc<Mutex<SqliteConnection>> {
        let c = SqliteConnection::open_in_memory().expect("open");
        c.execute_batch("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (2);")
            .expect("seed");
        Arc::new(Mutex::new(c))
    }

    fn query_only(h: &Arc<Mutex<SqliteConnection>>) -> i64 {
        h.lock()
            .unwrap()
            .query_row("PRAGMA query_only", [], |r| r.get(0))
            .unwrap()
    }

    fn read(
        h: &Arc<Mutex<SqliteConnection>>,
        sql: &str,
        limit: Duration,
    ) -> impl Future<Output = Result<Vec<Value>, String>> + use<> {
        let sql = sql.to_string();
        sqlite_timed(h.clone(), limit, read_timeout_msg(limit), move |c, f| {
            query_only_run(c, &sql, f)
        })
    }

    /// The whole point of the module: a statement that writes is refused by SQLite itself, whatever
    /// its first keyword says - and the user's connection is writable again afterwards.
    #[tokio::test]
    async fn a_read_cannot_write_and_leaves_the_connection_writable() {
        let h = db();
        let rows = read(&h, "SELECT a FROM t", Duration::from_secs(5))
            .await
            .expect("read");
        assert_eq!(rows[0]["data"].as_array().map(Vec::len), Some(2));

        for write in [
            "DELETE FROM t",
            "CREATE TABLE u (b)",
            "INSERT INTO t VALUES (3)",
        ] {
            assert!(
                read(&h, write, Duration::from_secs(5)).await.is_err(),
                "{write}"
            );
        }
        assert_eq!(query_only(&h), 0, "pragma must be restored");
        let n: i64 = h
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2, "nothing was written");
        h.lock()
            .unwrap()
            .execute_batch("INSERT INTO t VALUES (9)")
            .expect("user can write");
    }

    /// A user who had `query_only` on keeps it on.
    #[tokio::test]
    async fn a_read_restores_the_pragma_it_found() {
        let h = db();
        h.lock()
            .unwrap()
            .execute_batch("PRAGMA query_only = ON")
            .unwrap();
        read(&h, "SELECT 1", Duration::from_secs(5))
            .await
            .expect("read");
        assert_eq!(query_only(&h), 1);
    }

    /// The limit used to do nothing on SQLite. A runaway query must be stopped, and the connection
    /// must be free and writable when the call returns.
    #[tokio::test]
    async fn a_runaway_query_is_interrupted_at_the_limit() {
        let h = db();
        let endless = "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) \
                       SELECT COUNT(*) FROM r";
        let started = std::time::Instant::now();
        let err = read(&h, endless, Duration::from_millis(300))
            .await
            .expect_err("must stop");
        assert!(err.contains("stopped"), "{err}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(query_only(&h), 0);
        h.lock()
            .unwrap()
            .execute_batch("INSERT INTO t VALUES (9)")
            .expect("user can write");
    }

    /// Timing out while still waiting for the lock (the user's own query holds it) must not run the
    /// AI's statement afterwards.
    #[tokio::test]
    async fn a_read_that_timed_out_waiting_for_the_lock_never_runs() {
        let h = db();
        let held = h.clone();
        let blocker = std::thread::spawn(move || {
            let _g = held.lock().unwrap();
            std::thread::sleep(Duration::from_millis(600));
        });
        std::thread::sleep(Duration::from_millis(50));
        let sql = "INSERT INTO t VALUES (42)".to_string();
        let res = sqlite_timed(
            h.clone(),
            Duration::from_millis(100),
            "late".to_string(),
            move |c, f| {
                let out = sqlite_raw_on(c, &sql);
                f();
                out
            },
        )
        .await;
        blocker.join().unwrap();
        assert_eq!(res.err().as_deref(), Some("late"));
        let n: i64 = h
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM t WHERE a = 42", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "the statement must not run after its caller gave up");
    }
}
