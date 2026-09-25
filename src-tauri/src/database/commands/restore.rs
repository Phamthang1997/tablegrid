//! `restore_backup` — replays a multi-statement `.sql` dump, filtered to the tables the user selected.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};
use sqlx::{MySqlPool, PgPool};
use tauri::ipc::Channel;

use crate::database::{
    DbConnection, DbKind, DumpStatements, build_mysql_url, build_pg_url, open_dump,
    probe_mysql_script, reject_conn_read_only, split_sql_statements, sqlite_raw,
    strip_leading_comments,
};

/// Key of a running restore's cancel flag in `AppState::cancel_flags`.
///
/// Per `conn_id`, like `datagen`'s `cancel_key`. That is also per JOB now: every background restore
/// runs on a connection of its own (`open_job_connection`), so two restores can never share a key.
fn restore_cancel_key(conn_id: &str) -> String {
    format!("__restore__:{conn_id}")
}

/// Removes the flag when the restore returns, whichever way it returns.
///
/// A guard rather than a `remove` before each `return`: `restore_backup` has a dozen exits, most of
/// them `?`, and a flag left behind would make the NEXT restore on that id start out cancelled.
struct CancelFlagGuard {
    state: crate::AppState,
    key: String,
}

impl CancelFlagGuard {
    fn register(
        state: &crate::AppState,
        key: String,
        flag: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        state
            .cancel_flags
            .lock()
            .map_err(|e| e.to_string())?
            .insert(key.clone(), flag);
        Ok(Self {
            state: state.clone(),
            key,
        })
    }
}

impl Drop for CancelFlagGuard {
    fn drop(&mut self) {
        if let Ok(mut flags) = self.state.cancel_flags.lock() {
            flags.remove(&self.key);
        }
    }
}

/// Ask a running restore on `conn_id` to stop.
///
/// Raises the flag and returns at once; the restore notices between two statements, rolls back and
/// answers its own call with `cancelled: true`. Not an error when nothing is running — the restore
/// may have finished while the click was on its way.
#[tauri::command]
pub async fn cancel_restore(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
        let found = match flags.get(&restore_cancel_key(&conn_id)) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        };
        Ok(json!({ "success": true, "found": found }))
    })
    .await
}

/// The head of a statement, upper-cased — enough to classify it with `is_skipped_stmt`/`is_session_level_stmt`.
///
/// Only the first 4-5 words decide a statement's kind, so `to_uppercase()` over the WHOLE statement is useless and expensive:
/// it allocates a copy of every INSERT, i.e. copies the entire dump one more time.
/// The longest keyword to match is `START TRANSACTION` (17 characters), so 32 bytes is wide enough.
pub(super) fn upper_head(body: &str) -> String {
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

pub(super) fn is_skipped_stmt(stmt_upper: &str) -> bool {
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
pub(super) fn use_db_name(stmt: &str) -> Option<String> {
    let parts: Vec<&str> = stmt.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }
    let name = parts[1]
        .trim_matches(|c| c == ';' || c == '`' || c == '"' || c == '\'')
        .to_string();
    if name.is_empty() { None } else { Some(name) }
}

// Is this statement a CREATE VIEW? Those are moved to the end of the restore.
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
fn is_create_view(stmt: &str) -> bool {
    static RE: std::sync::LazyLock<Option<regex::Regex>> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?VIEW\b",
        )
        .ok()
    });
    RE.as_ref()
        .is_some_and(|re| re.is_match(strip_leading_comments(stmt)))
}

/// Decides, statement by statement, what a restore runs — the same decision for a dump in memory
/// and one streamed from a file.
struct Classifier {
    matcher: TableMatcher,
    run_all: bool,
    /// The last `USE <db>` seen, for reconnecting once the restore is done.
    last_use_db: Option<String>,
}

impl Classifier {
    /// The statement to run and whether it is session-level (its failure does not abort the
    /// restore), or None when it is not to be run at all.
    fn classify(&mut self, q: String) -> Option<(String, bool)> {
        // Classify by the part AFTER the leading comment: a mysqldump dump always has
        // `-- Dumping data for table x` glued right in front of LOCK TABLES / INSERT.
        let body = strip_leading_comments(&q);
        let head = upper_head(body);
        if is_skipped_stmt(&head) {
            return None;
        }
        if body.is_empty() {
            // A statement that is nothing but a comment. MySQL's CONDITIONAL comments (`/*!40101 SET NAMES utf8mb4 */`)
            // are real statements and affect the charset/timezone of the imported data -> they still have to run
            // (classified as session-level so their failure does not abort the restore). Ordinary comments are dropped.
            return q.contains("/*!").then_some((q, true));
        }
        let session_level = is_session_level_stmt(&head);
        if session_level {
            if head.starts_with("USE ")
                && let Some(db) = use_db_name(body)
            {
                self.last_use_db = Some(db);
            }
        } else if !self.run_all && !self.matcher.matches(&q) {
            return None;
        }
        Some((q, session_level))
    }
}

/// Where a restore's statements come from.
enum Feed {
    /// Already split, filtered and reordered, so the total is known up front.
    Mem {
        total: usize,
        items: std::vec::IntoIter<(String, bool)>,
    },
    /// Split by a reader thread while the file is read. The total is not known until the end, so
    /// progress is the share of the FILE read — which is also what a user watching a 1GB dump wants.
    File {
        rx: tokio::sync::mpsc::Receiver<Result<String, String>>,
        /// CREATE VIEW statements, held back until the rest of the file has run.
        views: Vec<(String, bool)>,
        /// The held-back views, once the file is exhausted.
        tail: Option<std::vec::IntoIter<(String, bool)>>,
        bytes_read: Arc<std::sync::atomic::AtomicU64>,
        bytes_total: u64,
    },
}

impl Feed {
    fn total(&self) -> Option<usize> {
        match self {
            Feed::Mem { total, .. } => Some(*total),
            Feed::File { .. } => None,
        }
    }

    fn start_message(&self) -> Value {
        match self {
            Feed::Mem { total, .. } => json!({ "type": "start", "total": total }),
            Feed::File { bytes_total, .. } => json!({ "type": "start", "bytesTotal": bytes_total }),
        }
    }

    fn progress_message(&self, done: usize) -> Value {
        match self {
            Feed::Mem { total, .. } => json!({ "type": "progress", "done": done, "total": total }),
            Feed::File {
                bytes_read,
                bytes_total,
                ..
            } => json!({
                "type": "progress",
                "done": done,
                "bytesDone": bytes_read.load(Ordering::Relaxed),
                "bytesTotal": bytes_total,
            }),
        }
    }

    /// The next statement to run, None when there is none left, or the error that stopped the
    /// reader (an unreadable or truncated file).
    async fn next(
        &mut self,
        classifier: &mut Classifier,
    ) -> Result<Option<(String, bool)>, String> {
        match self {
            Feed::Mem { items, .. } => Ok(items.next()),
            Feed::File {
                rx, views, tail, ..
            } => {
                if let Some(rest) = tail {
                    return Ok(rest.next());
                }
                while let Some(item) = rx.recv().await {
                    let Some((q, session_level)) = classifier.classify(item?) else {
                        continue;
                    };
                    if is_create_view(&q) {
                        views.push((q, session_level));
                        continue;
                    }
                    return Ok(Some((q, session_level)));
                }
                let mut rest = std::mem::take(views).into_iter();
                let first = rest.next();
                *tail = Some(rest);
                Ok(first)
            }
        }
    }
}

#[tauri::command]
pub async fn restore_backup(
    conn_id: String,
    // Exactly one of `sql_content` / `file_path`. The text is for a dump built in memory (the
    // copy-database path); a dump the user picked is read from disk (`dump_file.rs`), so a file of
    // any size never has to exist as one string anywhere.
    sql_content: Option<String>,
    file_path: Option<String>,
    // Statements run before the dump's own — the overwrite option's `DROP … IF EXISTS` list. They
    // go through the same filter and classification as the dump's statements.
    prepend: Option<Vec<String>>,
    // Only with `file_path`: whether the file issues `DELIMITER`, as `scan_dump_file` reported it.
    // It decides what `$$` means for the whole file; without it the file is read once more to find out.
    mysql_script: Option<bool>,
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

    // Registered before the dump is even split, so a cancel pressed during "Preparing…" is not
    // lost; removed by the guard on every way out, including the `?`s below.
    let cancel = Arc::new(AtomicBool::new(false));
    let _cancel_guard = CancelFlagGuard::register(&state, restore_cancel_key(&conn_id), cancel.clone())?;
    let mut cancelled = false;

    let mut statements_count = 0;

    let mut classifier = Classifier {
        matcher: TableMatcher::new(&tables),
        run_all,
        last_use_db: None,
    };
    let prepend = prepend.unwrap_or_default();

    let mut feed = match (sql_content, file_path) {
        (Some(sql), None) => {
            // The SAME splitter as the SQL editor: it understands MySQL's DELIMITER command and Postgres' $$ blocks,
            // so a trigger/procedure/function body is not cut at a ';' inside it.
            //
            // Filter FIRST so the total number of statements to run is known -> a real percentage instead of an
            // indeterminate bar. The accompanying bool = a session-/schema-level statement (whose failure does
            // not abort the restore).
            let mut to_run: Vec<(String, bool)> = Vec::new();
            for q in prepend.into_iter().chain(split_sql_statements(&sql)) {
                to_run.extend(classifier.classify(q));
            }
            drop(sql);
            // Move every CREATE VIEW statement to the end — see `is_create_view`. partition keeps the
            // order within each group.
            let (rest, views): (Vec<_>, Vec<_>) =
                to_run.into_iter().partition(|(q, _)| !is_create_view(q));
            let mut to_run = rest;
            to_run.extend(views);
            Feed::Mem { total: to_run.len(), items: to_run.into_iter() }
        }
        (None, Some(path)) => {
            // Opened here rather than in the reader thread so a missing file is a plain error
            // before anything has started, and so the byte counter is in hand for progress.
            let p = path.clone();
            let dump = tokio::task::spawn_blocking(move || open_dump(&p))
                .await
                .map_err(|e| e.to_string())??;
            let bytes_read = dump.bytes_read.clone();
            let bytes_total = dump.bytes_total;
            // Bounded: the reader runs at most this many statements ahead of the server, so the
            // dump in memory is a handful of statements whatever the file's size. Dropping the
            // receiver (the restore returning, cancelled or failed) ends the thread at its next send.
            let (tx, rx) = tokio::sync::mpsc::channel::<Result<String, String>>(16);
            std::thread::spawn(move || {
                let mysql_script = match mysql_script {
                    Some(b) => b,
                    None => match probe_mysql_script(&path) {
                        Ok(b) => b,
                        Err(e) => {
                            let _ = tx.blocking_send(Err(e));
                            return;
                        }
                    },
                };
                for q in prepend.into_iter().map(Ok).chain(DumpStatements::new(dump.reader, mysql_script)) {
                    let failed = q.is_err();
                    if tx.blocking_send(q).is_err() || failed {
                        return;
                    }
                }
            });
            Feed::File { rx, views: Vec::new(), tail: None, bytes_read, bytes_total }
        }
        _ => return Err("Cần đúng một nguồn dump: nội dung SQL hoặc đường dẫn tệp.".to_string()),
    };

    let _ = on_progress.send(feed.start_message());
    // Send one event every PROGRESS_EVERY statements so a dump of tens of thousands of statements does not flood the IPC.
    const PROGRESS_EVERY: usize = 20;
    let mut done: usize = 0;
    let tick = |done: usize, feed: &Feed| {
        if done % PROGRESS_EVERY == 1 || feed.total() == Some(done) {
            let _ = on_progress.send(feed.progress_message(done));
        }
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
            loop {
                // Checked between statements, never inside one: a statement is the unit the
                // server can roll back, so stopping here leaves nothing half-applied.
                if cancel.load(Ordering::Relaxed) {
                    cancelled = true;
                    break;
                }
                let (q, session_level) = match feed.next(&mut classifier).await {
                    Ok(Some(item)) => item,
                    Ok(None) => break,
                    Err(e) => {
                        let _ = sqlx::query("ROLLBACK;").execute(&mut *conn).await;
                        let _ = sqlx::raw_sql("UNLOCK TABLES;").execute(&mut *conn).await;
                        let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 1;").execute(&mut *conn).await;
                        return Err(e);
                    }
                };

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
                                failed_samples.push(json!({ "sql": stmt_for_error(&q), "error": e.to_string() }));
                            }
                            done += 1;
                            continue;
                        }
                        let _ = sqlx::query("ROLLBACK;").execute(&mut *conn).await;
                        // Hand the connection back to the pool clean, leaving no lock/FK-check behind.
                        let _ = sqlx::raw_sql("UNLOCK TABLES;").execute(&mut *conn).await;
                        let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 1;").execute(&mut *conn).await;
                        return Err(format!("Lỗi khi chạy lệnh SQL: {}. Chi tiết: {}", stmt_for_error(&q), e));
                    }
                    done += 1;
                    continue;
                }
                statements_count += 1;
                done += 1;
                tick(done, &feed);
            }

            // A cancelled run is rolled back like a failed one. MySQL commits implicitly on DDL, so
            // tables the dump had already created stay behind — the UI says so rather than promising
            // a clean undo.
            let end = if cancelled { "ROLLBACK;" } else { "COMMIT;" };
            let _ = sqlx::query(end).execute(&mut *conn).await;
            // 4. Hand the connection back to the pool clean: drop the locks (in case a LOCK slipped through) + turn FKs back on
            let _ = sqlx::raw_sql("UNLOCK TABLES;").execute(&mut *conn).await;
            let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 1;").execute(&mut *conn).await;
        }
        DbKind::Postgres(pool) => {
            // ONE connection for the whole restore, exactly like the MySQL branch.
            //
            // This branch used to send `BEGIN;` and every statement through `execute_raw_sql_generic`,
            // which acquires a pooled connection PER CALL — so the transaction only held together
            // because `should_route` recognises a `BEGIN` and opened a manual-transaction session on
            // the connection's id. When that id was the user's, the restore became the user's
            // transaction: their pending counter counted every INSERT, and anything they ran in a tab
            // meanwhile joined the restore's transaction and went down with its ROLLBACK. And
            // `SET CONSTRAINTS ALL DEFERRED` ran before that `BEGIN`, on some other pooled
            // connection, outside any transaction — i.e. it did nothing.
            //
            // Nothing here goes through a funnel any more, so no session is ever opened. `raw_sql`
            // (the simple query protocol) because a restore runs statements and never reads a row back.
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            async fn run(conn: &mut sqlx::PgConnection, sql: String) -> Result<(), String> {
                sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
                    .execute(&mut *conn)
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            }
            async fn run_str(conn: &mut sqlx::PgConnection, sql: &'static str) -> Result<(), String> {
                run(conn, sql.to_string()).await
            }
            let _ = run_str(&mut conn, "BEGIN;").await;
            // Only valid inside a transaction, hence after BEGIN; only affects DEFERRABLE constraints.
            let _ = run_str(&mut conn, "SET CONSTRAINTS ALL DEFERRED;").await;

            loop {
                if cancel.load(Ordering::Relaxed) {
                    cancelled = true;
                    break;
                }
                let (q, session_level) = match feed.next(&mut classifier).await {
                    Ok(Some(item)) => item,
                    Ok(None) => break,
                    Err(e) => {
                        let _ = run_str(&mut conn, "ROLLBACK;").await;
                        return Err(e);
                    }
                };
                // A MySQL dump's backtick-quoted identifiers, turned into Postgres' double quotes.
                // Copied only when there is one to turn: a multi-row INSERT is hundreds of KB, and
                // this used to be one more full copy of every statement of the dump.
                let exec_sql = if q.contains('`') { q.replace('`', "\"") } else { q.clone() };
                // One error puts a Postgres transaction into the aborted state (25P02), after which
                // every later statement fails with "current transaction is aborted". Carrying on needs
                // a rollback point per statement. Paid when the user asked to carry on, and for every
                // session-level statement: those are allowed to fail (a MySQL `SET` line in a dump
                // from another dialect), and without a savepoint that "allowed" failure used to poison
                // the whole transaction and fail everything after it.
                let savepoint = continue_on_error || session_level;
                if savepoint {
                    let _ = run_str(&mut conn, "SAVEPOINT tn_restore_sp;").await;
                }
                if let Err(e) = run(&mut conn, exec_sql).await {
                    if savepoint {
                        let _ = run_str(&mut conn, "ROLLBACK TO SAVEPOINT tn_restore_sp;").await;
                    }
                    done += 1;
                    if session_level {
                        continue;
                    }
                    if continue_on_error {
                        failed_count += 1;
                        if failed_samples.len() < FAILED_SAMPLES_MAX {
                            failed_samples.push(json!({ "sql": stmt_for_error(&q), "error": e.to_string() }));
                        }
                        continue;
                    }
                    let _ = run_str(&mut conn, "ROLLBACK;").await;
                    return Err(format!("Lỗi khi chạy lệnh SQL: {}. Chi tiết: {}", stmt_for_error(&q), e));
                }
                // Release the rollback point as soon as the statement is through, so savepoints do not pile up.
                if savepoint {
                    let _ = run_str(&mut conn, "RELEASE SAVEPOINT tn_restore_sp;").await;
                }
                statements_count += 1;
                done += 1;
                tick(done, &feed);
            }

            let end = if cancelled { "ROLLBACK;" } else { "COMMIT;" };
            let _ = run_str(&mut conn, end).await;
        }
        DbKind::Sqlite(conn_arc) => {
            // Statements go straight to the handle rather than through `execute_raw_sql_generic`, for
            // the reason the Postgres branch gives: the restore owns this transaction, and no
            // manual-transaction session may be opened or consulted for it.
            if let Ok(conn) = conn_arc.lock() {
                let _ = conn.execute("PRAGMA foreign_keys = OFF;", []);
                let _ = conn.execute("BEGIN TRANSACTION;", []);
            }
            let abort = || {
                if let Ok(conn) = conn_arc.lock() {
                    let _ = conn.execute("ROLLBACK;", []);
                    let _ = conn.execute("PRAGMA foreign_keys = ON;", []);
                }
            };

            loop {
                if cancel.load(Ordering::Relaxed) {
                    cancelled = true;
                    break;
                }
                let (q, session_level) = match feed.next(&mut classifier).await {
                    Ok(Some(item)) => item,
                    Ok(None) => break,
                    Err(e) => {
                        abort();
                        return Err(e);
                    }
                };
                if let Err(e) = sqlite_raw(conn_arc, &q) {
                    done += 1;
                    if !session_level && continue_on_error {
                        failed_count += 1;
                        if failed_samples.len() < FAILED_SAMPLES_MAX {
                            failed_samples.push(json!({ "sql": stmt_for_error(&q), "error": e.to_string() }));
                        }
                        continue;
                    }
                    if !session_level {
                        abort();
                        return Err(format!("Lỗi khi chạy lệnh SQL: {}. Chi tiết: {}", stmt_for_error(&q), e));
                    }
                    continue;
                }
                statements_count += 1;
                done += 1;
                tick(done, &feed);
            }

            if let Ok(conn) = conn_arc.lock() {
                let _ = conn.execute(if cancelled { "ROLLBACK;" } else { "COMMIT;" }, []);
                let _ = conn.execute("PRAGMA foreign_keys = ON;", []);
            }
        }
    }
    let last_use_db = classifier.last_use_db;


    if cancelled {
        // Not an `Err`: nothing failed, and an error string would be translated and shown as one.
        // The count is what ran before the stop — on MySQL, DDL among those stays committed.
        return Ok(json!({
            "success": false,
            "cancelled": true,
            "statementsCount": statements_count,
            "dialect": crate::tx::dialect_of(&conn_type),
        }));
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

    let _ = on_progress.send(json!({ "type": "done", "done": done, "total": feed.total().unwrap_or(done), "statementsCount": statements_count }));

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
