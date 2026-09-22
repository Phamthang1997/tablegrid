//! `restore_backup` — replays a multi-statement `.sql` dump, filtered to the tables the user selected.

use serde_json::{Value, json};
use sqlx::{MySqlPool, PgPool};
use tauri::ipc::Channel;

use crate::database::{
    DbConnection, DbKind, build_mysql_url, build_pg_url, execute_raw_sql_generic,
    reject_conn_read_only, split_sql_statements, strip_leading_comments,
};

/// The head of a statement, upper-cased — enough to classify it with `is_skipped_stmt`/`is_session_level_stmt`.
///
/// Only the first 4-5 words decide a statement's kind, so `to_uppercase()` over the WHOLE statement is useless and expensive:
/// it allocates a copy of every INSERT, i.e. copies the entire dump one more time.
/// The longest keyword to match is `START TRANSACTION` (17 characters), so 32 bytes is wide enough.
fn upper_head(body: &str) -> String {
    let mut end = body.len().min(32);
    // Slicing by byte means backing up to a UTF-8 character boundary (a statement may start with a multi-byte character).
    while end > 0 && !body.is_char_boundary(end) {
        end -= 1;
    }
    body[..end].to_uppercase()
}

// Statements in a dump that the restore must NOT replay:
//   - LOCK/UNLOCK TABLES: mysqldump adds them for speed. `LOCK TABLES x WRITE` carries a table name so it
//     passes the filter, while `UNLOCK TABLES` does not -> the lock stays held and the next table fails with
//     1100 "was not locked with LOCK TABLES". Dropping the whole pair is safest, especially when the user
//     selected only some of the tables.
//   - BEGIN/START TRANSACTION/COMMIT/ROLLBACK: the transaction is managed by this function; replaying the
//     dump's own statement (ROLLBACK above all) could throw away what has already been imported.
/// Statement text as it appears in an error message.
///
/// The framing is `Lỗi khi chạy lệnh SQL: {statement}. Chi tiết: {cause}` (kept verbatim so the
/// regex in `backendErrors.ts` still matches), which puts the statement first — and a multi-row
/// INSERT is now hundreds of KB, so the cause was pushed far below the visible area of the error
/// dialog and users saw a wall of VALUES with no reason attached. Only the head is needed to
/// recognise which statement failed.
///
/// The marker is a bare `…` on purpose: any word here would be a user-visible string escaping
/// through the error channel untranslated, and `backendErrors.ts` matches this message with a
/// regex that passes the interpolated text straight through.
fn stmt_for_error(stmt: &str) -> String {
    const MAX: usize = 400;
    if stmt.len() <= MAX {
        return stmt.to_string();
    }
    let mut end = MAX;
    while end > 0 && !stmt.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &stmt[..end])
}

fn is_skipped_stmt(stmt_upper: &str) -> bool {
    stmt_upper.starts_with("LOCK TABLES")
        || stmt_upper.starts_with("UNLOCK TABLES")
        || stmt_upper.starts_with("START TRANSACTION")
        || stmt_upper == "BEGIN"
        || stmt_upper.starts_with("BEGIN;")
        || stmt_upper.starts_with("BEGIN WORK")
        || stmt_upper.starts_with("COMMIT")
        || stmt_upper.starts_with("ROLLBACK")
}

// Session-/schema-level statements in a dump file: they always run even when the user selected only some tables
// (they mention no table name, so the table filter would drop them), and their failure does NOT abort the whole
// restore — a dump from another dialect commonly carries `SET NAMES`/`SET @@...` that the current server does
// not understand, while `CREATE SCHEMA` errors out when the schema already exists.
fn is_session_level_stmt(stmt_upper: &str) -> bool {
    stmt_upper.starts_with("USE ")
        || stmt_upper.starts_with("SET ")
        // PRAGMA is the SQLite spelling of the same thing — the header this app writes opens
        // with `PRAGMA foreign_keys = OFF;`, which names no table and would otherwise be
        // filtered out. A PRAGMA the current server does not know must not abort the restore
        // either, which is exactly what this list means.
        || stmt_upper.starts_with("PRAGMA ")
        || stmt_upper.starts_with("CREATE DATABASE")
        || stmt_upper.starts_with("CREATE SCHEMA")
}

// Does the statement mention one of the selected tables (matched on word boundaries so
// `film` does not match `film_actor`).
//
// The regex is compiled ONCE for the whole restore, not per (statement × table) pair:
// a 10MB dump holds ~50,000 statements, times 22 tables is over a million `Regex::new()` calls — this
// filtering step used to cost more time than running the actual SQL, and it happens BEFORE `start` is sent
// to the UI, so all the user saw was a frozen "Preparing...".
pub(crate) struct TableMatcher {
    /// One alternation regex for every table: each statement is scanned once instead of once per table.
    re: Option<regex::Regex>,
    /// The fallback for when the regex cannot be built (very odd table names / too long a list).
    lowered: Vec<String>,
}

impl TableMatcher {
    pub(crate) fn new(tables: &[String]) -> Self {
        if tables.is_empty() {
            return Self {
                re: None,
                lowered: Vec::new(),
            };
        }
        let alts: Vec<String> = tables.iter().map(|t| regex::escape(t)).collect();
        // (?i) instead of lower-casing each statement: `to_lowercase()` allocates a copy
        // of every INSERT, i.e. copies the whole dump.
        let re = regex::Regex::new(&format!(r"(?i)\b(?:{})\b", alts.join("|"))).ok();
        Self {
            re,
            lowered: tables.iter().map(|t| t.to_lowercase()).collect(),
        }
    }

    pub(crate) fn matches(&self, stmt: &str) -> bool {
        if let Some(re) = &self.re {
            return re.is_match(stmt);
        }
        let lower = stmt.to_lowercase();
        self.lowered.iter().any(|t| lower.contains(t))
    }
}

// The database name in a `USE <db>` statement (for reconnecting once the restore is done).
fn use_db_name(stmt: &str) -> Option<String> {
    let parts: Vec<&str> = stmt.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }
    let name = parts[1]
        .trim_matches(|c| c == ';' || c == '`' || c == '"' || c == '\'')
        .to_string();
    if name.is_empty() { None } else { Some(name) }
}

#[tauri::command]
pub async fn restore_backup(
    conn_id: String,
    sql_content: String,
    tables: Vec<String>,
    // The progress channel back to the UI: {type:'start'|'progress'|'done', done, total}. A restore is one
    // long call, so without a channel the UI could only draw an indeterminate bar.
    // Mandatory (not an Option): Channel does not implement Deserialize, so `Option<Channel<_>>`
    // does not satisfy CommandArg — the frontend always creates the channel, whether it needs it or not.
    on_progress: Channel<Value>,
    // Skip a failing statement and keep going instead of rolling everything back (like `mysql --force`).
    //
    // This is NOT "turn off integrity checking": foreign keys are already off for every restore
    // (`SET FOREIGN_KEY_CHECKS = 0` / `SET CONSTRAINTS ALL DEFERRED` / `PRAGMA foreign_keys OFF`).
    // What really ruins a whole import are the errors that cannot be turned off: a `CREATE VIEW` reading a table
    // that is not in the file, a routine calling a function that does not exist yet, a data type this server does not know.
    // This mode rescues the part that can run, at the cost of atomicity.
    continue_on_error: Option<bool>,
    // Replay EVERY statement of the dump, ignoring the `tables` filter.
    //
    // That filter exists for a dump the USER supplied: an .sql file of unknown provenance, where the
    // only handle on "which tables" is a word-boundary match over the statement text. It is the wrong
    // tool for a dump this app has just built from a chosen set of objects, and not merely redundant —
    // `TableMatcher` cannot see a table's name in every statement that belongs to it. Postgres'
    // `CREATE SEQUENCE IF NOT EXISTS film_film_id_seq;` contains no whole word `film` (an underscore
    // is a word character), so filtering a generated dump drops the sequence, and the `CREATE TABLE
    // film (… DEFAULT nextval('film_film_id_seq'))` right behind it then fails on a sequence that was
    // never created.
    //
    // Used by the copy-database path, which passes an empty `tables`: the caller already decided what
    // went into the dump, so a second filter can only subtract from it.
    run_all: Option<bool>,
) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let continue_on_error = continue_on_error.unwrap_or(false);
    let run_all = run_all.unwrap_or(false);
    // Failing statements that were skipped: all of them are counted, but only the first few are kept to show the user.
    let mut failed_count: usize = 0;
    let mut failed_samples: Vec<Value> = Vec::new();
    const FAILED_SAMPLES_MAX: usize = 5;
    // Restore acquires its own connection and runs its own transaction. It would not corrupt the
    // user's open transaction — different session — but it would block on the locks that
    // transaction holds, and a frozen progress bar is a worse answer than a clear refusal.
    crate::tx::reject_if_manual_or_open(&conn_id, "phục hồi dữ liệu")?;
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };
    // Restore replays a whole dump on its own connection, so none of the funnels sees it.
    reject_conn_read_only(&conn_type)?;

    let mut statements_count = 0;
    let mut last_use_db: Option<String> = None;

    // The SAME splitter as the SQL editor: it understands MySQL's DELIMITER command and Postgres' $$ blocks,
    // so a trigger/procedure/function body is not cut at a ';' inside it.
    let statements = split_sql_statements(&sql_content);

    // Filter FIRST so the total number of statements to run is known -> a real percentage instead of an indeterminate bar.
    // The accompanying bool = a session-/schema-level statement (whose failure does not abort the restore).
    let mut to_run: Vec<(String, bool)> = Vec::new();
    let matcher = TableMatcher::new(&tables);
    for q in statements {
        // Classify by the part AFTER the leading comment: a mysqldump dump always has
        // `-- Dumping data for table x` glued right in front of LOCK TABLES / INSERT.
        let body = strip_leading_comments(&q);
        let head = upper_head(body);
        if is_skipped_stmt(&head) {
            continue;
        }
        if body.is_empty() {
            // A statement that is nothing but a comment. MySQL's CONDITIONAL comments (`/*!40101 SET NAMES utf8mb4 */`)
            // are real statements and affect the charset/timezone of the imported data -> they still have to run
            // (classified as session-level so their failure does not abort the restore). Ordinary comments are dropped.
            if q.contains("/*!") {
                to_run.push((q, true));
            }
            continue;
        }
        let session_level = is_session_level_stmt(&head);
        if session_level {
            if head.starts_with("USE ")
                && let Some(db) = use_db_name(body) {
                    last_use_db = Some(db);
                }
        } else if !run_all && !matcher.matches(&q) {
            continue;
        }
        to_run.push((q, session_level));
    }

    // Move every CREATE VIEW statement to the end.
    //
    // Dumps interleave views with tables alphabetically — sakila's `actor_info` view sits right
    // after the `actor` table, long before the `film` table it reads — while `CREATE VIEW` is
    // validated AS IT RUNS: MySQL returns 1146 "Table doesn't exist" and the whole import is rolled back.
    // The export side has been fixed to write views after the tables, but dumps that already exist (and other
    // tools' dumps) cannot be fixed retroactively, so the runner has to tolerate the wrong order too.
    //
    // Only CREATE VIEW moves, and their relative order is preserved (a view may read another view;
    // the app's export already orders them by dependency — see `orderViewsByDependency`).
    // `DROP VIEW` staying put is harmless. Moving any other kind of statement could change what the dump
    // means — a dump that INSERTs through an updatable view, for example, would break.
    if let Ok(create_view_re) = regex::Regex::new(
        r"(?i)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?VIEW\b",
    ) {
        // partition keeps the order within each group.
        let (rest, views): (Vec<_>, Vec<_>) = to_run
            .into_iter()
            .partition(|(q, _)| !create_view_re.is_match(strip_leading_comments(q)));
        to_run = rest;
        to_run.extend(views);
    }

    let total = to_run.len();
    let _ = on_progress.send(json!({ "type": "start", "total": total }));
    // Send one event every PROGRESS_EVERY statements so a dump of tens of thousands of statements does not flood the IPC.
    const PROGRESS_EVERY: usize = 20;
    let send_progress = |done: usize| {
        let _ = on_progress.send(json!({ "type": "progress", "done": done, "total": total }));
    };


    match &conn_type.kind {
        DbKind::Mysql(pool) => {
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;

            // 0. Clear any lock still held on this connection. LOCK TABLES is per SESSION and the pool
            //    reuses sessions: an earlier restore that ran `LOCK TABLES x WRITE` and never reached
            //    `UNLOCK TABLES` leaves the lock behind, so the next write to another table fails with
            //    1100 "was not locked with LOCK TABLES". It has to come BEFORE START TRANSACTION because
            //    UNLOCK TABLES implicitly commits an open transaction.
            let _ = sqlx::raw_sql("UNLOCK TABLES;").execute(&mut *conn).await;

            // 1. Turn off foreign keys
            let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 0;").execute(&mut *conn).await;
            // 2. Begin the transaction
            let _ = sqlx::query("START TRANSACTION;").execute(&mut *conn).await;

            // 3. Run the statements
            for (idx, (q, session_level)) in to_run.iter().enumerate() {
                let session_level = *session_level;

                // raw_sql = the text protocol: MySQL does NOT allow CREATE/DROP TRIGGER|PROCEDURE|FUNCTION|
                // EVENT through a prepared statement (error 1295), and a dump usually contains all of those.
                // A restore only needs to run statements, never to read a row, so the text protocol is used for everything.
                if let Err(e) = sqlx::raw_sql(sqlx::AssertSqlSafe(q.clone())).execute(&mut *conn).await {
                    // A failing session-/schema-level statement is skipped; a real error rolls back and returns the error.
                    if !session_level {
                        if continue_on_error {
                            // One failing statement does NOT abort a MySQL transaction, so what has been written
                            // is still there and the run can continue right away.
                            failed_count += 1;
                            if failed_samples.len() < FAILED_SAMPLES_MAX {
                                failed_samples.push(json!({ "sql": stmt_for_error(q), "error": e.to_string() }));
                            }
                            continue;
                        }
                        let _ = sqlx::query("ROLLBACK;").execute(&mut *conn).await;
                        // Hand the connection back to the pool clean, leaving no lock/FK-check behind.
                        let _ = sqlx::raw_sql("UNLOCK TABLES;").execute(&mut *conn).await;
                        let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 1;").execute(&mut *conn).await;
                        return Err(format!("Lỗi khi chạy lệnh SQL: {}. Chi tiết: {}", stmt_for_error(q), e));
                    }
                    continue;
                }
                statements_count += 1;
                if idx % PROGRESS_EVERY == 0 || idx + 1 == total {
                    send_progress(idx + 1);
                }

            }

            let _ = sqlx::query("COMMIT;").execute(&mut *conn).await;
            // 4. Hand the connection back to the pool clean: drop the locks (in case a LOCK slipped through) + turn FKs back on
            let _ = sqlx::raw_sql("UNLOCK TABLES;").execute(&mut *conn).await;
            let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 1;").execute(&mut *conn).await;
        }
        _ => {
            // Turn off foreign-key checking and begin the transaction
            match &conn_type.kind {
                DbKind::Postgres(_) => {
                    let _ = execute_raw_sql_generic(&conn_type, "SET CONSTRAINTS ALL DEFERRED;".to_string()).await;
                    let _ = execute_raw_sql_generic(&conn_type, "BEGIN;".to_string()).await;
                }
                DbKind::Sqlite(conn_arc) => {
                    if let Ok(conn) = conn_arc.lock() {
                        let _ = conn.execute("PRAGMA foreign_keys = OFF;", []);
                        let _ = conn.execute("BEGIN TRANSACTION;", []);
                    }
                }
                _ => {}
            }

            for (idx, (q, session_level)) in to_run.iter().enumerate() {
                let session_level = *session_level;

                let exec_sql = match &conn_type.kind {
                    DbKind::Postgres(_) => q.replace("`", "\""),
                    _ => q.clone(),
                };
                // Postgres: one error puts the whole transaction into the aborted state (25P02), and
                // every later statement then fails with "current transaction is aborted". Continuing
                // requires a rollback point per statement. The 2 extra round trips are only paid when the user turns
                // this mode on; MySQL and SQLite need none of it, since one failing statement does not abort their transaction.
                let pg_savepoint = continue_on_error && matches!(&conn_type.kind, DbKind::Postgres(_));
                if pg_savepoint {
                    let _ = execute_raw_sql_generic(&conn_type, "SAVEPOINT tn_restore_sp;".to_string()).await;
                }
                if let Err(e) = execute_raw_sql_generic(&conn_type, exec_sql).await {
                    if !session_level && continue_on_error {
                        if pg_savepoint {
                            let _ = execute_raw_sql_generic(&conn_type, "ROLLBACK TO SAVEPOINT tn_restore_sp;".to_string()).await;
                        }
                        failed_count += 1;
                        if failed_samples.len() < FAILED_SAMPLES_MAX {
                            failed_samples.push(json!({ "sql": stmt_for_error(q), "error": e.to_string() }));
                        }
                        continue;
                    }
                    if !session_level {
                        // Roll back on error
                        match &conn_type.kind {
                            DbKind::Postgres(_) => {
                                let _ = execute_raw_sql_generic(&conn_type, "ROLLBACK;".to_string()).await;
                            }
                            DbKind::Sqlite(conn_arc) => {
                                if let Ok(conn) = conn_arc.lock() {
                                    let _ = conn.execute("ROLLBACK;", []);
                                    let _ = conn.execute("PRAGMA foreign_keys = ON;", []);
                                }
                            }
                            _ => {}
                        }
                        return Err(format!("Lỗi khi chạy lệnh SQL: {}. Chi tiết: {}", stmt_for_error(q), e));
                    }
                    continue;
                }
                // Release the rollback point as soon as the statement is through, so savepoints do not pile up.
                if pg_savepoint {
                    let _ = execute_raw_sql_generic(&conn_type, "RELEASE SAVEPOINT tn_restore_sp;".to_string()).await;
                }
                statements_count += 1;
                if idx % PROGRESS_EVERY == 0 || idx + 1 == total {
                    send_progress(idx + 1);
                }

            }

            // Commit transaction
            match &conn_type.kind {
                DbKind::Postgres(_) => {
                    let _ = execute_raw_sql_generic(&conn_type, "COMMIT;".to_string()).await;
                }
                DbKind::Sqlite(conn_arc) => {
                    if let Ok(conn) = conn_arc.lock() {
                        let _ = conn.execute("COMMIT;", []);
                    }
                }
                _ => {}
            }

            // Turn foreign keys back on
            if let DbKind::Sqlite(conn_arc) = &conn_type.kind
                && let Ok(conn) = conn_arc.lock() {
                    let _ = conn.execute("PRAGMA foreign_keys = ON;", []);
                }
        }
    }

    if let Some(ref db_name) = last_use_db {
        let (last_conf_opt, db_type, tunnel_port) = {
            // Server-level, not connection-level: `last_config` + the tunnel port belong to
            // `ServerHandle`. `last_config` there is a `Value` (a server always has a config), so it is wrapped in
            // `Some` to leave the code below unchanged.
            let ctx = state.connections.acquire(&conn_id)?;
            (Some(ctx.server().config()), ctx.server().db_type.clone(),
             ctx.server().ssh_tunnel.as_ref().map(|t| t.local_port))
        };

        if let Some(mut last_conf) = last_conf_opt {
            if let Some(obj) = last_conf.as_object_mut() {
                obj.insert("database".to_string(), json!(db_name));
                // When an SSH tunnel is in use, the reconnect must still go through 127.0.0.1:<local_port>
                if let Some(port) = tunnel_port {
                    obj.insert("host".to_string(), json!("127.0.0.1"));
                    obj.insert("port".to_string(), json!(port));
                }
            }

            let new_conn = match db_type.as_str() {
                "postgres" => {
                    let url = build_pg_url(&last_conf, Some(db_name.as_str()));
                    let pool = PgPool::connect(&url).await.map_err(|e| e.to_string())?;
                    Some(DbKind::Postgres(pool))
                }
                "mysql" => {
                    let url = build_mysql_url(&last_conf, Some(db_name.as_str()));
                    let pool = MySqlPool::connect(&url).await.map_err(|e| e.to_string())?;
                    Some(DbKind::Mysql(pool))
                }
                _ => None
            };
            if let Some(kind) = new_conn {
                // `USE <db>` changes the database right under the tab doing the restore. Phase 3 will mint a
                // new `conn_id` for the new database (§4.3); for now the current entry is switched as before —
                // so the new pool carries THAT entry's id, not a fresh one.
                let ctx = state.connections.acquire(&conn_id)?;
                let id = ctx.id().clone();
                ctx.server().set_config(last_conf);
                state.connections.replace_conn(&id, DbConnection::session(id.clone(), kind))?;
                state.connections.set_db(&id, db_name.clone())?;
            }
        }
    }

    let _ = on_progress.send(json!({ "type": "done", "done": total, "total": total, "statementsCount": statements_count }));

    Ok(json!({
        "success": true,
        "statementsCount": statements_count,
        "activeDatabase": last_use_db,
        // Only non-zero when continue_on_error is on — the UI has to say "imported, but this much is missing";
        // staying silent here makes the user believe the import was complete.
        "failedCount": failed_count,
        "failedSamples": failed_samples
    }))
}).await
}
