//! `restore_backup` — replays a multi-statement `.sql` dump, filtered to the tables the user selected.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};
use sqlx::{MySqlPool, PgPool};
use tauri::ipc::Channel;

use crate::database::{
    DbConnection, DbKind, DumpItem, DumpStatements, build_mysql_url, build_pg_url, open_dump,
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
        // The target database is the one the user picked, and a dump has no say in dropping it —
        // or any other. It used to go through the table filter, which matches words: a selected
        // table called `demo` let pg_dump's `DROP DATABASE demo;` through (fatal on Postgres,
        // which refuses it inside a transaction; on MySQL it would really drop the database).
        || stmt_upper.starts_with("DROP DATABASE")
}

/// A statement setting the session's client charset, re-aimed at UTF-8 — or None for any other.
///
/// Everything a restore sends is UTF-8: the splitter decodes a latin1 dump into it
/// (`decode_dump_text`). A dump's own `SET NAMES latin1` (mysqldump writes one in its header,
/// and `SET character_set_client = utf8` around every CREATE TABLE) would then make the server
/// read those UTF-8 bytes as latin1 and store `CuraÃ§ao`. Pinned to UTF-8, the server converts
/// to each column's own charset itself, which is what the dump meant. Only a statement that sets
/// nothing else is touched: `SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT` and
/// `SET character_set_client = @saved_cs_client` keep their meaning (they save and restore).
fn pin_client_charset(stmt: &str, postgres: bool) -> Option<String> {
    use std::sync::LazyLock;
    static MY_NAMES: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)^SET\s+(?:NAMES|CHARACTER\s+SET|CHARSET)\s+'?([A-Za-z0-9_]+)'?(?:\s+COLLATE\s+'?[A-Za-z0-9_]+'?)?\s*$",
        )
        .expect("MY_NAMES")
    });
    static MY_VAR: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)^SET\s+(?:@@(?:SESSION\.)?|SESSION\s+)?character_set_(client|connection|results)\s*=\s*'?([A-Za-z0-9_]+)'?\s*$",
        )
        .expect("MY_VAR")
    });
    static PG_ENC: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)^SET\s+client_encoding\s*(?:=|TO)\s*'?([A-Za-z0-9_-]+)'?\s*$")
            .expect("PG_ENC")
    });
    // mysqldump wraps these in version comments (`/*!40101 SET NAMES latin1 */`); MySQL runs
    // what is inside, so that is what is read.
    let head = crate::database::classification_head(stmt).trim();
    let head = head.strip_suffix("*/").unwrap_or(head).trim_end();
    if postgres {
        let c = PG_ENC.captures(head)?;
        let enc = c[1].to_ascii_uppercase();
        return (!matches!(enc.as_str(), "UTF8" | "UTF-8" | "UNICODE"))
            .then(|| "SET client_encoding = 'UTF8'".to_string());
    }
    if let Some(c) = MY_NAMES.captures(head) {
        return (!c[1].eq_ignore_ascii_case("utf8mb4")).then(|| "SET NAMES utf8mb4".to_string());
    }
    let c = MY_VAR.captures(head)?;
    (!c[2].eq_ignore_ascii_case("utf8mb4"))
        .then(|| format!("SET character_set_{} = utf8mb4", c[1].to_ascii_lowercase()))
}

/// `ALTER DATABASE <the dump's db> SET …` aimed at `current` instead — or None for any other
/// statement, and for the other forms of ALTER DATABASE (OWNER TO, RENAME, …), which stay aimed
/// at the database they name.
///
/// pg_dump --create writes a database's own settings as `ALTER DATABASE demo SET "bookings.lang"
/// TO 'en'`, meant for the database it is about to `\connect` to. A restore puts everything into
/// the database the user picked, so the settings follow the data there; aimed at `demo`, the
/// statement failed on a server that has no `demo`, and the demo's views then read no setting.
fn retarget_alter_database(stmt: &str, current: &str) -> Option<String> {
    let body = strip_leading_comments(stmt);
    let rest = body
        .get(..14)
        .filter(|h| h.eq_ignore_ascii_case("ALTER DATABASE"))
        .map(|_| &body[14..])?;
    let rest = rest.trim_start();
    // The name: a quoted identifier (`""` escapes a quote) or a bare word.
    let name_len = if let Some(quoted) = rest.strip_prefix('"') {
        let mut i = 0;
        let b = quoted.as_bytes();
        loop {
            match b.get(i) {
                Some(b'"') if b.get(i + 1) == Some(&b'"') => i += 2,
                Some(b'"') => break i + 2,
                Some(_) => i += 1,
                None => return None,
            }
        }
    } else {
        rest.find(char::is_whitespace)?
    };
    let tail = &rest[name_len..];
    let verb = tail.trim_start();
    let is_set = verb
        .get(..4)
        .is_some_and(|w| w.eq_ignore_ascii_case("SET "))
        || verb
            .get(..6)
            .is_some_and(|w| w.eq_ignore_ascii_case("RESET "));
    if !is_set {
        return None;
    }
    Some(format!(
        "ALTER DATABASE \"{}\"{}",
        current.replace('"', "\"\""),
        tail
    ))
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
        // pg_dump's own spelling of `SET search_path = ''`, written as a SELECT so it works
        // wherever a function call does. It names no table, so the filter would drop it.
        || stmt_upper.starts_with("SELECT PG_CATALOG.SET_CONFIG(")
        || stmt_upper.starts_with("CREATE DATABASE")
        // Database-level settings: not a table's, and aimed at a database that may not be this
        // one (see `retarget_alter_database`), so a failure must not abort the restore.
        || stmt_upper.starts_with("ALTER DATABASE")
        || stmt_upper.starts_with("CREATE SCHEMA")
        // What a table is BUILT FROM rather than a table: none of them names the table that
        // needs it, so the filter dropped them and the table then failed — pg_dump's demo
        // database lost its `EXCLUDE … USING gist` constraint to a missing `btree_gist`, and a
        // `serial` column's `film_film_id_seq` holds no whole word `film`. Creating one the
        // selection does not need is harmless, and one that already exists must not abort.
        || stmt_upper.starts_with("CREATE EXTENSION")
        || stmt_upper.starts_with("CREATE TYPE")
        || stmt_upper.starts_with("CREATE DOMAIN")
        || stmt_upper.starts_with("CREATE SEQUENCE")
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

// Is this statement a CREATE VIEW? One that FAILS is retried at the end of the restore.
//
// Dumps interleave views with tables alphabetically — sakila's `actor_info` view sits right
// after the `actor` table, long before the `film` table it reads — while `CREATE VIEW` is
// validated AS IT RUNS: MySQL returns 1146 "Table doesn't exist" and the whole import is rolled back.
// The export side has been fixed to write views after the tables, but dumps that already exist (and other
// tools' dumps) cannot be fixed retroactively, so the runner has to tolerate the wrong order too.
//
// It used to move EVERY CREATE VIEW to the end up front, and that broke the dumps that were already
// right: pg_dump orders views by dependency and follows each with its `COMMENT ON VIEW` / `ALTER
// VIEW … OWNER` / `GRANT`, which then ran against a view that did not exist yet. Running it in
// place and deferring only on failure keeps a correct dump's meaning and still rescues a wrong one.
// The retries keep their relative order (a view may read another view). Moving any other kind of
// statement could change what the dump means — a dump that INSERTs through an updatable view, for
// example, would break.
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

/// What `Feed::next` hands the runner.
enum Step {
    /// A statement, and whether it is session-level (its failure does not abort the restore).
    Stmt(String, bool),
    /// `COPY … FROM stdin`: its data is read with `Feed::copy_chunk` until that answers None.
    Copy(String),
}

/// What happened to one COPY block.
enum CopyOutcome {
    Done,
    Cancelled,
    /// The server refused it; the block's data has been read past, so the run can carry on.
    Failed(String),
}

/// The error for a COPY block met on MySQL or SQLite: that data format only Postgres reads.
const COPY_NEEDS_PG: &str =
    "Tệp dump dùng COPY … FROM stdin (định dạng của pg_dump), chỉ phục hồi được vào PostgreSQL";

/// Streams one COPY block to Postgres a chunk at a time, straight from the reader thread — a
/// table's data in a pg_dump file is one block, and 150MB of it must not become one string.
/// `Err` is only an unreadable file; a refusal from the server is `CopyOutcome::Failed`.
async fn pg_copy_in(
    conn: &mut sqlx::PgConnection,
    sql: &str,
    feed: &mut Feed,
    cancel: &AtomicBool,
    on_chunk: &(dyn Fn(&Feed) + Sync),
) -> Result<CopyOutcome, String> {
    let mut copy = match conn.copy_in_raw(sql).await {
        Ok(c) => c,
        Err(e) => {
            feed.skip_copy().await?;
            return Ok(CopyOutcome::Failed(e.to_string()));
        }
    };
    loop {
        // Checked between chunks too: one COPY can be most of the file.
        if cancel.load(Ordering::Relaxed) {
            let _ = copy.abort("cancelled").await;
            return Ok(CopyOutcome::Cancelled);
        }
        match feed.copy_chunk().await {
            Ok(Some(data)) => {
                if let Err(e) = copy.send(data).await {
                    let msg = e.to_string();
                    let _ = copy.abort(msg.clone()).await;
                    feed.skip_copy().await?;
                    return Ok(CopyOutcome::Failed(msg));
                }
                on_chunk(feed);
            }
            Ok(None) => break,
            Err(e) => {
                let _ = copy.abort(e.clone()).await;
                return Err(e);
            }
        }
    }
    match copy.finish().await {
        Ok(_) => Ok(CopyOutcome::Done),
        Err(e) => Ok(CopyOutcome::Failed(e.to_string())),
    }
}

/// Where a restore's statements come from.
enum Feed {
    /// Already split, filtered and reordered, so the total is known up front.
    Mem {
        total: usize,
        items: std::vec::IntoIter<(String, bool)>,
        retry: Vec<(String, bool)>,
        tail: Option<std::vec::IntoIter<(String, bool)>>,
    },
    /// Split by a reader thread while the file is read. The total is not known until the end, so
    /// progress is the share of the FILE read — which is also what a user watching a 1GB dump wants.
    File {
        rx: tokio::sync::mpsc::Receiver<Result<DumpItem, String>>,
        /// CREATE VIEW statements that failed in place, retried once the rest has run.
        retry: Vec<(String, bool)>,
        /// The retries, once the source is exhausted.
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

    /// Put back a CREATE VIEW that failed, to run again after everything else.
    fn defer(&mut self, q: String, session_level: bool) {
        match self {
            Feed::Mem { retry, .. } | Feed::File { retry, .. } => retry.push((q, session_level)),
        }
    }

    /// Whether the statements now coming are the deferred retries — which are not deferred again.
    fn retrying(&self) -> bool {
        match self {
            Feed::Mem { tail, .. } | Feed::File { tail, .. } => tail.is_some(),
        }
    }

    /// The next statement to run, None when there is none left, or the error that stopped the
    /// reader (an unreadable or truncated file).
    async fn next(&mut self, classifier: &mut Classifier) -> Result<Option<Step>, String> {
        let stmt = |(q, s): (String, bool)| Step::Stmt(q, s);
        match self {
            Feed::Mem {
                items, retry, tail, ..
            } => {
                if let Some(rest) = tail {
                    return Ok(rest.next().map(stmt));
                }
                if let Some(item) = items.next() {
                    return Ok(Some(stmt(item)));
                }
                let mut rest = std::mem::take(retry).into_iter();
                let first = rest.next();
                *tail = Some(rest);
                Ok(first.map(stmt))
            }
            Feed::File {
                rx, retry, tail, ..
            } => {
                if let Some(rest) = tail {
                    return Ok(rest.next().map(stmt));
                }
                while let Some(item) = rx.recv().await {
                    match item? {
                        DumpItem::Stmt(q) => {
                            let Some((q, session_level)) = classifier.classify(q) else {
                                continue;
                            };
                            return Ok(Some(Step::Stmt(q, session_level)));
                        }
                        // Filtered like any statement: a COPY names its table.
                        DumpItem::CopyStart(q) => match classifier.classify(q) {
                            Some((q, _)) => return Ok(Some(Step::Copy(q))),
                            None => skip_copy_rx(rx).await?,
                        },
                        DumpItem::CopyData(_) | DumpItem::CopyEnd => {}
                    }
                }
                let mut rest = std::mem::take(retry).into_iter();
                let first = rest.next();
                *tail = Some(rest);
                Ok(first.map(stmt))
            }
        }
    }

    /// The next piece of the COPY block `next` just returned; None at its end.
    async fn copy_chunk(&mut self) -> Result<Option<Vec<u8>>, String> {
        match self {
            Feed::Mem { .. } => Ok(None),
            Feed::File { rx, .. } => match rx.recv().await {
                Some(Ok(DumpItem::CopyData(d))) => Ok(Some(d)),
                Some(Ok(_)) | None => Ok(None),
                Some(Err(e)) => Err(e),
            },
        }
    }

    /// Reads past the rest of the current COPY block.
    async fn skip_copy(&mut self) -> Result<(), String> {
        match self {
            Feed::Mem { .. } => Ok(()),
            Feed::File { rx, .. } => skip_copy_rx(rx).await,
        }
    }
}

/// A `Feed` reading a dump file on a thread of its own.
async fn file_feed(
    path: String,
    mysql_script: Option<bool>,
    prepend: Vec<String>,
) -> Result<Feed, String> {
    // Opened here rather than in the reader thread so a missing file is a plain error
    // before anything has started, and so the byte counter is in hand for progress.
    let p = path.clone();
    let dump = tokio::task::spawn_blocking(move || open_dump(&p))
        .await
        .map_err(|e| e.to_string())??;
    let bytes_read = dump.bytes_read.clone();
    let bytes_total = dump.bytes_total;
    // Bounded: the reader runs at most this many items ahead of the server, so the dump in
    // memory is a handful of statements (or COPY chunks) whatever the file's size. Dropping the
    // receiver (the restore returning, cancelled or failed) ends the thread at its next send.
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<DumpItem, String>>(16);
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
        let items = DumpStatements::new(dump.reader, mysql_script);
        for q in prepend
            .into_iter()
            .map(|s| Ok(DumpItem::Stmt(s)))
            .chain(items)
        {
            let failed = q.is_err();
            if tx.blocking_send(q).is_err() || failed {
                return;
            }
        }
    });
    Ok(Feed::File {
        rx,
        retry: Vec::new(),
        tail: None,
        bytes_read,
        bytes_total,
    })
}

async fn skip_copy_rx(
    rx: &mut tokio::sync::mpsc::Receiver<Result<DumpItem, String>>,
) -> Result<(), String> {
    while let Some(item) = rx.recv().await {
        match item? {
            DumpItem::CopyData(_) => {}
            _ => return Ok(()),
        }
    }
    Ok(())
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
            Feed::Mem {
                total: to_run.len(),
                items: to_run.into_iter(),
                retry: Vec::new(),
                tail: None,
            }
        }
        (None, Some(path)) => file_feed(path, mysql_script, prepend).await?,
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
                    Ok(Some(Step::Stmt(q, s))) => (q, s),
                    Ok(None) => break,
                    other => {
                        let _ = sqlx::query("ROLLBACK;").execute(&mut *conn).await;
                        let _ = sqlx::raw_sql("UNLOCK TABLES;").execute(&mut *conn).await;
                        let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 1;").execute(&mut *conn).await;
                        return Err(match other {
                            Err(e) => e,
                            _ => COPY_NEEDS_PG.to_string(),
                        });
                    }
                };

                // raw_sql = the text protocol: MySQL does NOT allow CREATE/DROP TRIGGER|PROCEDURE|FUNCTION|
                // EVENT through a prepared statement (error 1295), and a dump usually contains all of those.
                // A restore only needs to run statements, never to read a row, so the text protocol is used for everything.
                // The dump's own charset statements are pinned to UTF-8 — see `pin_client_charset`.
                let exec_sql = pin_client_charset(&q, false).unwrap_or_else(|| q.clone());
                if let Err(e) = sqlx::raw_sql(sqlx::AssertSqlSafe(exec_sql)).execute(&mut *conn).await {
                    // A CREATE VIEW read a table the dump has not created yet: try it again at the end.
                    // A failed statement does not abort a MySQL transaction, so no savepoint is needed.
                    if !feed.retrying() && is_create_view(&q) {
                        feed.defer(q, session_level);
                        continue;
                    }
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
            // Where `retarget_alter_database` sends a dump's database settings.
            let current_db: Option<String> = sqlx::query_scalar("SELECT current_database()")
                .fetch_one(&mut *conn)
                .await
                .ok();

            loop {
                if cancel.load(Ordering::Relaxed) {
                    cancelled = true;
                    break;
                }
                let (q, session_level) = match feed.next(&mut classifier).await {
                    Ok(Some(Step::Stmt(q, s))) => (q, s),
                    Ok(Some(Step::Copy(q))) => {
                        // Same savepoint rule as a statement: without one, a refused COPY leaves
                        // the transaction aborted (25P02) and `continue_on_error` cannot carry on.
                        if continue_on_error {
                            let _ = run_str(&mut conn, "SAVEPOINT tn_restore_sp;").await;
                        }
                        let done_now = done;
                        let on_chunk = |f: &Feed| {
                            let _ = on_progress.send(f.progress_message(done_now));
                        };
                        match pg_copy_in(&mut conn, &q, &mut feed, &cancel, &on_chunk).await {
                            Err(e) => {
                                let _ = run_str(&mut conn, "ROLLBACK;").await;
                                return Err(e);
                            }
                            Ok(CopyOutcome::Cancelled) => {
                                cancelled = true;
                                break;
                            }
                            Ok(CopyOutcome::Done) => {
                                if continue_on_error {
                                    let _ = run_str(&mut conn, "RELEASE SAVEPOINT tn_restore_sp;").await;
                                }
                                statements_count += 1;
                                done += 1;
                                tick(done, &feed);
                            }
                            Ok(CopyOutcome::Failed(e)) => {
                                done += 1;
                                if !continue_on_error {
                                    let _ = run_str(&mut conn, "ROLLBACK;").await;
                                    return Err(format!("Lỗi khi chạy lệnh SQL: {}. Chi tiết: {}", stmt_for_error(&q), e));
                                }
                                let _ = run_str(&mut conn, "ROLLBACK TO SAVEPOINT tn_restore_sp;").await;
                                failed_count += 1;
                                if failed_samples.len() < FAILED_SAMPLES_MAX {
                                    failed_samples.push(json!({ "sql": stmt_for_error(&q), "error": e }));
                                }
                            }
                        }
                        continue;
                    }
                    Ok(None) => break,
                    Err(e) => {
                        let _ = run_str(&mut conn, "ROLLBACK;").await;
                        return Err(e);
                    }
                };
                // A MySQL dump's backtick-quoted identifiers, turned into Postgres' double quotes.
                // Copied only when there is one to turn: a multi-row INSERT is hundreds of KB, and
                // this used to be one more full copy of every statement of the dump.
                let exec_sql = if let Some(sql) = current_db
                    .as_deref()
                    .and_then(|db| retarget_alter_database(&q, db))
                {
                    sql
                } else if let Some(sql) = pin_client_charset(&q, true) {
                    sql
                } else if q.contains('`') {
                    q.replace('`', "\"")
                } else {
                    q.clone()
                };
                // One error puts a Postgres transaction into the aborted state (25P02), after which
                // every later statement fails with "current transaction is aborted". Carrying on needs
                // a rollback point per statement. Paid when the user asked to carry on, and for every
                // session-level statement: those are allowed to fail (a MySQL `SET` line in a dump
                // from another dialect), and without a savepoint that "allowed" failure used to poison
                // the whole transaction and fail everything after it.
                // A CREATE VIEW gets one too, so that failing in place (see `is_create_view`) can be
                // retried at the end instead of aborting the transaction.
                let deferrable = !feed.retrying() && is_create_view(&q);
                let savepoint = continue_on_error || session_level || deferrable;
                if savepoint {
                    let _ = run_str(&mut conn, "SAVEPOINT tn_restore_sp;").await;
                }
                if let Err(e) = run(&mut conn, exec_sql).await {
                    if savepoint {
                        let _ = run_str(&mut conn, "ROLLBACK TO SAVEPOINT tn_restore_sp;").await;
                    }
                    if deferrable {
                        feed.defer(q, session_level);
                        continue;
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
                    Ok(Some(Step::Stmt(q, s))) => (q, s),
                    Ok(None) => break,
                    other => {
                        abort();
                        return Err(match other {
                            Err(e) => e,
                            _ => COPY_NEEDS_PG.to_string(),
                        });
                    }
                };
                if let Err(e) = sqlite_raw(conn_arc, &q) {
                    if !feed.retrying() && is_create_view(&q) {
                        feed.defer(q, session_level);
                        continue;
                    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn classify(tables: &[&str], q: &str) -> Option<(String, bool)> {
        let tables: Vec<String> = tables.iter().map(|t| t.to_string()).collect();
        Classifier {
            matcher: TableMatcher::new(&tables),
            run_all: false,
            last_use_db: None,
        }
        .classify(q.to_string())
    }

    /// The table filter matches WORDS, so pg_dump's database statements used to get through it
    /// by accident: the demo dump's function `lang` let `ALTER DATABASE demo SET "bookings.lang"`
    /// through as an ordinary statement, whose failure (no `demo` on the server) killed the run.
    #[test]
    fn database_statements_are_never_decided_by_the_table_filter() {
        // Never run, even when a selected name matches.
        assert_eq!(classify(&["demo"], "DROP DATABASE demo"), None);
        assert_eq!(classify(&[], "-- x\ndrop database if exists demo"), None);
        // Always attempted, and a failure is not fatal.
        assert_eq!(
            classify(
                &["lang"],
                "ALTER DATABASE demo SET \"bookings.lang\" TO 'en'"
            ),
            Some((
                "ALTER DATABASE demo SET \"bookings.lang\" TO 'en'".into(),
                true
            ))
        );
        assert_eq!(
            classify(&["film"], "ALTER DATABASE demo OWNER TO postgres").map(|c| c.1),
            Some(true)
        );
    }

    /// Everything else a table is built from runs whatever is selected.
    #[test]
    fn what_a_table_is_built_from_always_runs() {
        for q in [
            "CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA bookings",
            "CREATE TYPE mood AS ENUM ('a')",
            "CREATE DOMAIN d AS int",
            "CREATE SEQUENCE bookings.film_film_id_seq",
            "SELECT pg_catalog.set_config('search_path', '', false)",
        ] {
            assert_eq!(classify(&["film"], q).map(|c| c.1), Some(true), "{q}");
        }
        assert_eq!(classify(&["film"], "SELECT 1"), None);
    }

    #[test]
    fn a_dumps_database_settings_follow_the_data_into_the_target() {
        assert_eq!(
            retarget_alter_database(
                "-- Name: demo\nALTER DATABASE demo SET \"bookings.lang\" TO 'en'",
                "postgres"
            )
            .as_deref(),
            Some("ALTER DATABASE \"postgres\" SET \"bookings.lang\" TO 'en'")
        );
        assert_eq!(
            retarget_alter_database("alter database \"my \"\"db\"\"\" reset all", "x\"y")
                .as_deref(),
            Some("ALTER DATABASE \"x\"\"y\" reset all")
        );
        // Other forms stay aimed at the database they name.
        assert_eq!(
            retarget_alter_database("ALTER DATABASE demo OWNER TO postgres", "p"),
            None
        );
        assert_eq!(retarget_alter_database("ALTER DATABASE demo", "p"), None);
        assert_eq!(
            retarget_alter_database("ALTER TABLE t SET SCHEMA s", "p"),
            None
        );
    }

    #[test]
    fn a_dumps_charset_statements_are_pinned_to_utf8() {
        let my = |q: &str| pin_client_charset(q, false);
        assert_eq!(
            my("/*!40101 SET NAMES latin1 */").as_deref(),
            Some("SET NAMES utf8mb4")
        );
        assert_eq!(
            my("SET NAMES 'utf8' COLLATE 'utf8_general_ci'").as_deref(),
            Some("SET NAMES utf8mb4")
        );
        assert_eq!(
            my("/*!40101 SET character_set_client = utf8 */").as_deref(),
            Some("SET character_set_client = utf8mb4")
        );
        assert_eq!(
            my("SET CHARACTER SET latin1").as_deref(),
            Some("SET NAMES utf8mb4")
        );
        // Already UTF-8, or saving/restoring a variable: left alone.
        assert_eq!(my("SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci"), None);
        assert_eq!(
            my("/*!40101 SET character_set_client = @saved_cs_client */"),
            None
        );
        assert_eq!(
            my("/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */"),
            None
        );
        assert_eq!(
            my("/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */"),
            None
        );
        assert_eq!(my("SET NAMES latin1, time_zone = '+00:00'"), None);
        assert_eq!(my("SET TIME_ZONE='+00:00'"), None);

        let pg = |q: &str| pin_client_charset(q, true);
        assert_eq!(
            pg("SET client_encoding = 'LATIN1'").as_deref(),
            Some("SET client_encoding = 'UTF8'")
        );
        assert_eq!(
            pg("SET client_encoding TO win1252").as_deref(),
            Some("SET client_encoding = 'UTF8'")
        );
        assert_eq!(pg("SET client_encoding = 'UTF8'"), None);
        // Each dialect only reads its own spelling.
        assert_eq!(pg("SET NAMES latin1"), None);
    }

    /// The MySQL twin of `replay_a_real_dump`, run the way the MySQL branch runs: the table filter
    /// from a scan, the charset pinning, and the dump's own `USE`. Needs `DUMP_PATH` and `MYSQL_URL`,
    /// and CREATES whatever database the dump's `CREATE SCHEMA` / `USE` names. Checks nothing by
    /// itself beyond "no statement failed" — look at the rows afterwards.
    #[tokio::test]
    #[ignore]
    async fn replay_a_real_mysql_dump() {
        let path = std::env::var("DUMP_PATH").unwrap();
        let url = std::env::var("MYSQL_URL").unwrap();
        let pool = MySqlPool::connect(&url).await.unwrap();
        let mut conn = pool.acquire().await.unwrap();
        let dump = open_dump(&path).unwrap();
        let mut summary = super::super::dump_scan::DumpSummary::new();
        for item in DumpStatements::new(dump.reader, false) {
            if let DumpItem::Stmt(q) | DumpItem::CopyStart(q) = item.unwrap() {
                summary.add(&q);
            }
        }
        let tables: Vec<String> = summary.into_json()["tables"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t.as_str().unwrap().to_string())
            .collect();
        println!("tables {tables:?}");
        let mut feed = file_feed(path, None, Vec::new()).await.unwrap();
        let mut classifier = Classifier {
            matcher: TableMatcher::new(&tables),
            run_all: false,
            last_use_db: None,
        };
        let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 0;")
            .execute(&mut *conn)
            .await;
        let (mut ok, mut failed) = (0, 0);
        while let Some(step) = feed.next(&mut classifier).await.unwrap() {
            let Step::Stmt(q, session_level) = step else {
                panic!("COPY in a MySQL dump");
            };
            let exec_sql = pin_client_charset(&q, false).unwrap_or_else(|| q.clone());
            match sqlx::raw_sql(sqlx::AssertSqlSafe(exec_sql))
                .execute(&mut *conn)
                .await
            {
                Ok(_) => ok += 1,
                Err(e) if session_level => {
                    println!("skipped (session-level) {}: {e}", stmt_for_error(&q))
                }
                Err(e) => {
                    failed += 1;
                    println!("FAILED {}: {e}", stmt_for_error(&q));
                }
            }
        }
        let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 1;")
            .execute(&mut *conn)
            .await;
        println!("ok={ok} failed={failed} use={:?}", classifier.last_use_db);
        assert_eq!(failed, 0);
    }

    /// Replays a real dump file into a scratch Postgres database through the same `Feed` and
    /// `pg_copy_in` the restore runs, statement by statement in autocommit. Needs `DUMP_PATH` and
    /// `PG_URL` (a database it may fill); `… DATABASE` statements are skipped so nothing outside
    /// that database is touched. Run with:
    /// `cargo test --lib replay_a_real_dump -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn replay_a_real_dump() {
        let path = std::env::var("DUMP_PATH").unwrap();
        let url = std::env::var("PG_URL").unwrap();
        let pool = PgPool::connect(&url).await.unwrap();
        let mut conn = pool.acquire().await.unwrap();
        // FILTER=1: select every table the scan found, as the restore dialogs do by default,
        // instead of replaying the whole file.
        let tables: Vec<String> = if std::env::var("FILTER").is_ok() {
            let dump = open_dump(&path).unwrap();
            let mut summary = super::super::dump_scan::DumpSummary::new();
            for item in DumpStatements::new(dump.reader, false) {
                if let DumpItem::Stmt(q) | DumpItem::CopyStart(q) = item.unwrap() {
                    summary.add(&q);
                }
            }
            let v = summary.into_json();
            v["tables"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t.as_str().unwrap().to_string())
                .collect()
        } else {
            Vec::new()
        };
        println!("tables {tables:?}");
        let mut feed = file_feed(path, Some(false), Vec::new()).await.unwrap();
        let mut classifier = Classifier {
            matcher: TableMatcher::new(&tables),
            run_all: tables.is_empty(),
            last_use_db: None,
        };
        let cancel = AtomicBool::new(false);
        let started = std::time::Instant::now();
        let (mut ok, mut copies, mut failed) = (0, 0, 0);
        while let Some(step) = feed.next(&mut classifier).await.unwrap() {
            match step {
                Step::Stmt(q, _) => {
                    if upper_head(strip_leading_comments(&q)).contains("DATABASE") {
                        continue;
                    }
                    match sqlx::raw_sql(sqlx::AssertSqlSafe(q.clone()))
                        .execute(&mut *conn)
                        .await
                    {
                        Ok(_) => ok += 1,
                        Err(e) => {
                            failed += 1;
                            let head: String = q.chars().take(100).collect();
                            println!("FAILED {head}: {e}");
                        }
                    }
                }
                Step::Copy(q) => match pg_copy_in(&mut conn, &q, &mut feed, &cancel, &|_| {})
                    .await
                    .unwrap()
                {
                    CopyOutcome::Done => copies += 1,
                    CopyOutcome::Failed(e) => {
                        failed += 1;
                        println!("COPY FAILED {q}: {e}");
                    }
                    CopyOutcome::Cancelled => unreachable!(),
                },
            }
        }
        println!(
            "elapsed {:?} ok={ok} copies={copies} failed={failed}",
            started.elapsed()
        );
    }
}
