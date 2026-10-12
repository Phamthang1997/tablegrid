//! Importing rows from a file into a table: `import_begin` / `import_step` / `import_finish` /
//! `import_abort`.
//!
//! This replaced a single `import_table_data` call per 500 rows, which had three problems. Each call
//! committed on its own, so a failure at row 4,000 left rows 1–3,500 in the table with no way back.
//! Values were spliced into the SQL text, and `sql_literal` only doubles `'` — on MySQL, where `\`
//! is an escape inside a string, a cell such as `C:\path\` broke the statement. And a failing batch
//! said nothing about WHICH row failed.
//!
//! Here one import is one transaction on one dedicated connection (`Exec`), held across the calls in
//! a module-level map, the same shape as `export_sink.rs`. The FILE is read here too
//! (`import_file::FileFeed`): the frontend only says "next step", so no row crosses IPC. It used
//! to read, parse and convert the whole file in the webview and send it over in chunks, which is
//! what crashed on a 1GB file. At the end the import either commits or rolls back.
//! Three decisions carry the rest:
//!
//! - **Values are BOUND, never spliced.** Postgres is strict about a bound parameter's type — a text
//!   parameter into an `integer` column is an error, not a cast — so every placeholder carries an
//!   explicit cast to the column's own type, read from `format_type()` (`$3::timestamp without time
//!   zone`, `$4::"mood"`). MySQL and SQLite convert on assignment and need none.
//! - **Every batch runs inside a savepoint.** When a multi-row INSERT fails, the savepoint is rolled
//!   back and the batch is retried row by row, each row in a savepoint of its own. That finds the
//!   exact row that failed on every dialect — and on Postgres it is the only way to carry on at all,
//!   since one failed statement otherwise aborts the whole transaction (25P02).
//! - **Two modes.** `atomic` stops at the first failing row and the frontend then rolls everything
//!   back: all rows or none. `skip` records the failing row (up to `FAILED_SAMPLE_MAX` of them) and
//!   carries on, and what succeeded is committed.
//!
//! A NEW table (`create`) is created by the import itself. On Postgres and SQLite the CREATE runs
//! inside the import's transaction, so a rollback takes the table with it; MySQL commits DDL
//! implicitly, so there the table is created first and DROPped again when the import rolls back.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use serde::Deserialize;
use serde_json::{Value, json};

use super::super::decode::{bind_mysql_params, bind_pg_params, json_to_sqlite_value};
use crate::database::{
    DbConnection, DbKind, Exec, cell, pg_raw, qualified, quote_ident, reject_conn_read_only,
    rows_of, sql_str,
};
use crate::import_file::{FileFeed, FileSource};

/// Failed rows kept to show the user. All of them are counted; only the first ones are described.
const FAILED_SAMPLE_MAX: usize = 200;

/// Bound parameters per statement. Postgres and MySQL allow 65,535, SQLite 32,766 since 3.32 — one
/// limit under all three, so a wide table gets fewer rows per INSERT instead of an error.
const MAX_PARAMS: usize = 30_000;

/// Rows per INSERT when the table is narrow enough — the same batch size the dump uses.
const MAX_ROWS_PER_INSERT: usize = 500;

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Atomic,
    Skip,
}

struct ImportSession {
    exec: Exec,
    /// `INSERT INTO t (a, b) VALUES ` — the placeholders are added per batch.
    prefix: String,
    /// Postgres only: the cast for each column's placeholder, e.g. `::integer`. Empty elsewhere.
    casts: Vec<String>,
    is_pg: bool,
    mode: Mode,
    batch_rows: usize,
    inserted: u64,
    failed_total: u64,
    /// The file the rows come from.
    feed: Option<FileFeed>,
    /// MySQL only: the table this import created, dropped again if it rolls back (the CREATE
    /// committed on its own, so the rollback cannot take it).
    drop_on_rollback: Option<String>,
}

/// A column of a table the import creates.
#[derive(Debug, Clone, Deserialize)]
pub struct NewColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
}

/// Problems described per step; all are counted.
const STEP_ISSUES_MAX: usize = 20;

type SharedSession = Arc<tokio::sync::Mutex<Option<ImportSession>>>;

/// Open imports by handle. A tokio mutex per session, because a chunk holds it across the awaits of
/// its INSERTs; the map itself is a std mutex that is never held across an await.
static IMPORTS: LazyLock<std::sync::Mutex<HashMap<String, SharedSession>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

fn session_of(handle: &str) -> Result<SharedSession, String> {
    IMPORTS
        .lock()
        .map_err(|e| e.to_string())?
        .get(handle)
        .cloned()
        .ok_or_else(|| "internal: unknown import handle".to_string())
}

/// Rows per INSERT for a table of `ncols` columns.
fn batch_rows_for(ncols: usize) -> usize {
    (MAX_PARAMS / ncols.max(1)).clamp(1, MAX_ROWS_PER_INSERT)
}

/// `($1::integer, $2::text), ($3::integer, $4::text)` — or `(?, ?), (?, ?)` without casts.
fn placeholders(rows: usize, casts: &[String], ncols: usize, is_pg: bool) -> String {
    let mut out = String::new();
    let mut n = 0usize;
    for r in 0..rows {
        if r > 0 {
            out.push_str(", ");
        }
        out.push('(');
        for c in 0..ncols {
            if c > 0 {
                out.push_str(", ");
            }
            n += 1;
            if is_pg {
                out.push_str(&format!(
                    "${n}{}",
                    casts.get(c).map(String::as_str).unwrap_or("")
                ));
            } else {
                out.push('?');
            }
        }
        out.push(')');
    }
    out
}

/// Runs one statement with no parameters on the import's connection (BEGIN, SAVEPOINT, …).
async fn run_plain(exec: &mut Exec, sql: &str) -> Result<(), String> {
    exec.run(sql.to_string()).await
}

/// One INSERT of `rows` (each already `ncols` long), bound.
async fn insert_rows(s: &mut ImportSession, rows: &[Vec<Value>]) -> Result<(), String> {
    let ncols = s.casts.len().max(rows.first().map(Vec::len).unwrap_or(0));
    let sql = format!(
        "{}{}",
        s.prefix,
        placeholders(rows.len(), &s.casts, ncols, s.is_pg)
    );
    let params: Vec<Value> = rows.iter().flat_map(|r| r.iter().cloned()).collect();
    match &mut s.exec {
        Exec::Postgres(c) => bind_pg_params(sqlx::query(sqlx::AssertSqlSafe(sql)), &params)
            .execute(&mut **c)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Exec::Mysql(c) => bind_mysql_params(sqlx::query(sqlx::AssertSqlSafe(sql)), &params)
            .execute(&mut **c)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Exec::Sqlite(arc) => {
            let conn = arc.lock().map_err(|e| e.to_string())?;
            let values: Vec<rusqlite::types::Value> =
                params.iter().map(json_to_sqlite_value).collect();
            conn.execute(&sql, rusqlite::params_from_iter(values.iter()))
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
    }
}

/// Starts an import into `table`, for the given columns in the order every row will use.
///
/// `source` is the file the rows come from, read by `import_step`. `create` makes the import create
/// the table first, with these columns.
///
/// Run it on a job connection (`open_job_connection`): the transaction is held on a dedicated
/// connection for the whole import, and it must not be the user's.
#[tauri::command]
pub async fn import_begin(
    conn_id: String,
    table: String,
    columns: Vec<String>,
    mode: String,
    schema_override: Option<String>,
    source: Option<FileSource>,
    create: Option<Vec<NewColumn>>,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        if columns.is_empty() {
            return Err("Dữ liệu import không có cột nào".to_string());
        }
        // An import is its own transaction; with manual mode on it would commit behind the user.
        crate::tx::reject_if_manual_or_open(&conn_id, "nhập dữ liệu")?;
        let (conn, schema): (DbConnection, Option<String>) = {
            let ctx = state.connections.acquire(&conn_id)?;
            let schema = schema_override.or_else(|| ctx.raw_schema().map(str::to_string));
            (ctx.conn().clone(), schema)
        };
        reject_conn_read_only(&conn)?;
        // Opened first: a file that cannot be read should fail before anything is created.
        let feed = source.map(FileFeed::open).transpose()?;

        let is_pg = matches!(conn.kind, DbKind::Postgres(_));
        let is_mysql = matches!(conn.kind, DbKind::Mysql(_));
        let target = qualified(&conn, &schema, &table);
        let create_sql = match &create {
            Some(cols) => {
                if table.trim().is_empty() || cols.is_empty() || cols.iter().any(|c| c.name.is_empty() || c.ty.trim().is_empty()) {
                    return Err("Dữ liệu import không có cột nào".to_string());
                }
                let defs = cols
                    .iter()
                    .map(|c| format!("{} {}", quote_ident(&conn, &c.name), c.ty.trim()))
                    .collect::<Vec<_>>()
                    .join(", ");
                Some(format!("CREATE TABLE {target} ({defs})"))
            }
            None => None,
        };

        let mut exec = Exec::acquire(&conn).await?;
        let mut drop_on_rollback = None;
        if is_mysql && let Some(sql) = &create_sql {
            run_plain(&mut exec, sql).await?;
            drop_on_rollback = Some(target.clone());
        }
        let begin = if is_mysql { "START TRANSACTION" } else { "BEGIN" };
        run_plain(&mut exec, begin).await?;
        if !is_mysql
            && let Some(sql) = &create_sql
            && let Err(e) = run_plain(&mut exec, sql).await
        {
            let _ = run_plain(&mut exec, "ROLLBACK").await;
            return Err(e);
        }

        // Postgres: each column's exact type for its cast, and whether any mapped column is
        // `GENERATED ALWAYS AS IDENTITY` (then the INSERT has to say OVERRIDING SYSTEM VALUE).
        // Read inside the transaction, so a table it just created is there to read.
        let mut casts = Vec::new();
        let mut overriding = false;
        if is_pg && let Exec::Postgres(c) = &mut exec {
            let ns = schema.clone().unwrap_or_else(|| "public".to_string());
            let res = pg_raw(
                c,
                &format!(
                    "SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, \
                     a.attidentity::text AS ident \
                     FROM pg_attribute a JOIN pg_class t ON t.oid = a.attrelid \
                     JOIN pg_namespace n ON n.oid = t.relnamespace \
                     WHERE t.relname = '{}' AND n.nspname = '{}' AND a.attnum > 0 AND NOT a.attisdropped",
                    sql_str(&table),
                    sql_str(&ns)
                ),
            )
            .await;
            let res = match res {
                Ok(r) => r,
                Err(e) => {
                    let _ = run_plain(&mut exec, "ROLLBACK").await;
                    return Err(e);
                }
            };
            let by_name: HashMap<String, (String, String)> = rows_of(&res)
                .iter()
                .map(|r| (cell(r, "name").to_string(), (cell(r, "type").to_string(), cell(r, "ident").to_string())))
                .collect();
            for col in &columns {
                let Some((ty, ident)) = by_name.get(col) else {
                    let _ = run_plain(&mut exec, "ROLLBACK").await;
                    return Err(format!("Bảng không có cột '{col}'"));
                };
                casts.push(format!("::{ty}"));
                if ident == "a" {
                    overriding = true;
                }
            }
        }

        let cols_sql = columns
            .iter()
            .map(|c| quote_ident(&conn, c))
            .collect::<Vec<_>>()
            .join(", ");
        let prefix = format!(
            "INSERT INTO {} ({}){} VALUES ",
            target,
            cols_sql,
            if overriding { " OVERRIDING SYSTEM VALUE" } else { "" }
        );

        let batch_rows = batch_rows_for(columns.len());
        let handle = uuid::Uuid::new_v4().to_string();
        IMPORTS.lock().map_err(|e| e.to_string())?.insert(
            handle.clone(),
            Arc::new(tokio::sync::Mutex::new(Some(ImportSession {
                exec,
                prefix,
                casts: if is_pg { casts } else { vec![String::new(); columns.len()] },
                is_pg,
                mode: if mode == "skip" { Mode::Skip } else { Mode::Atomic },
                batch_rows,
                inserted: 0,
                failed_total: 0,
                feed,
                drop_on_rollback,
            }))),
        );
        Ok(json!({ "success": true, "handle": handle, "batchRows": batch_rows }))
    })
    .await
}

/// What inserting some rows did.
struct Inserted {
    inserted: u64,
    failed: Vec<Value>,
    stopped: bool,
}

/// Inserts rows, each with the row number to report it by.
///
/// Each batch runs in a savepoint; a failing batch is rolled back and retried row by row, each in a
/// savepoint of its own, which is how the failing ROW is named. In `atomic` mode the first failure
/// stops it with `stopped`, and the caller is expected to roll the import back.
async fn insert_numbered(
    s: &mut ImportSession,
    rows: &[(u64, Vec<Value>)],
) -> Result<Inserted, String> {
    let mut out = Inserted {
        inserted: 0,
        failed: Vec::new(),
        stopped: false,
    };
    let batch = s.batch_rows;
    'batches: for chunk in rows.chunks(batch) {
        let values: Vec<Vec<Value>> = chunk.iter().map(|(_, v)| v.clone()).collect();
        run_plain(&mut s.exec, "SAVEPOINT tg_imp_batch").await?;
        if insert_rows(s, &values).await.is_ok() {
            run_plain(&mut s.exec, "RELEASE SAVEPOINT tg_imp_batch").await?;
            out.inserted += chunk.len() as u64;
            continue;
        }
        // Something in this batch failed: undo it and find which rows, one at a time.
        run_plain(&mut s.exec, "ROLLBACK TO SAVEPOINT tg_imp_batch").await?;
        for (row_no, row) in chunk {
            run_plain(&mut s.exec, "SAVEPOINT tg_imp_row").await?;
            match insert_rows(s, std::slice::from_ref(row)).await {
                Ok(()) => {
                    run_plain(&mut s.exec, "RELEASE SAVEPOINT tg_imp_row").await?;
                    out.inserted += 1;
                }
                Err(e) => {
                    run_plain(&mut s.exec, "ROLLBACK TO SAVEPOINT tg_imp_row").await?;
                    s.failed_total += 1;
                    if out.failed.len() < FAILED_SAMPLE_MAX {
                        out.failed.push(json!({ "row": row_no, "error": e }));
                    }
                    if s.mode == Mode::Atomic {
                        out.stopped = true;
                        break 'batches;
                    }
                }
            }
        }
        run_plain(&mut s.exec, "RELEASE SAVEPOINT tg_imp_batch").await?;
    }
    s.inserted += out.inserted;
    Ok(out)
}

/// Reads the next `max_rows` rows of the import's file, converts them and inserts them.
///
/// A row the conversion refuses is counted in `badRows` (and the first ones described in `issues`);
/// in `atomic` mode it stops the import with `stopped` before anything of the step is written. A row
/// the database refuses is in `failed`. `done` says the file has been read to the end.
#[tauri::command]
pub async fn import_step(handle: String, max_rows: usize) -> Result<Value, String> {
    Box::pin(async move {
        let shared = session_of(&handle)?;
        let mut guard = shared.lock().await;
        let s = guard
            .as_mut()
            .ok_or_else(|| "internal: import already finished".to_string())?;
        let feed = s
            .feed
            .as_mut()
            .ok_or_else(|| "internal: import has no file".to_string())?;
        let step = feed
            .next(max_rows.clamp(1, 50_000), STEP_ISSUES_MAX)
            .await?;
        let (done, rows_read, bytes_done, bytes_total) = (
            feed.done(),
            feed.rows_read(),
            feed.bytes_done(),
            feed.bytes_total(),
        );

        let atomic_bad = s.mode == Mode::Atomic && step.bad_rows > 0;
        let res = if atomic_bad {
            Inserted {
                inserted: 0,
                failed: Vec::new(),
                stopped: true,
            }
        } else {
            insert_numbered(s, &step.rows).await?
        };
        Ok(json!({
            "success": true,
            "inserted": res.inserted,
            "failed": res.failed,
            "badRows": step.bad_rows,
            "issues": step.issues,
            "stopped": res.stopped,
            "done": done,
            "rowsRead": rows_read,
            "bytesDone": bytes_done,
            "bytesTotal": bytes_total,
            "insertedTotal": s.inserted,
        }))
    })
    .await
}

/// Ends an import: COMMIT, or ROLLBACK when `commit` is false (an atomic import that hit a bad row,
/// or a cancel). The connection goes back to the pool either way.
#[tauri::command]
pub async fn import_finish(handle: String, commit: bool) -> Result<Value, String> {
    Box::pin(async move {
        let shared = IMPORTS
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&handle)
            .ok_or_else(|| "internal: unknown import handle".to_string())?;
        let mut guard = shared.lock().await;
        let mut s = guard
            .take()
            .ok_or_else(|| "internal: import already finished".to_string())?;
        let res = if commit {
            run_plain(&mut s.exec, "COMMIT").await
        } else {
            roll_back(&mut s).await
        };
        if let Err(e) = res {
            // The connection is in an unknown state; it must not go back to the (shared) pool.
            close_exec(s.exec).await;
            return Err(e);
        }
        Ok(json!({
            "success": true,
            "committed": commit,
            "inserted": if commit { s.inserted } else { 0 },
            "failedTotal": s.failed_total,
        }))
    })
    .await
}

/// Rolls an import back and forgets it. Never an error — it runs in a `finally`, after the real
/// outcome, and an unknown handle means there is nothing left to undo.
#[tauri::command]
pub async fn import_abort(handle: String) -> Result<Value, String> {
    Box::pin(async move {
        let shared = IMPORTS.lock().ok().and_then(|mut m| m.remove(&handle));
        if let Some(shared) = shared {
            let mut guard = shared.lock().await;
            if let Some(mut s) = guard.take()
                && roll_back(&mut s).await.is_err()
            {
                close_exec(s.exec).await;
            }
        }
        Ok(json!({ "success": true }))
    })
    .await
}

/// ROLLBACK, and on MySQL drop the table this import created — its CREATE committed on its own.
async fn roll_back(s: &mut ImportSession) -> Result<(), String> {
    run_plain(&mut s.exec, "ROLLBACK").await?;
    if let Some(table) = s.drop_on_rollback.take() {
        run_plain(&mut s.exec, &format!("DROP TABLE IF EXISTS {table}")).await?;
    }
    Ok(())
}

/// Closes a pooled connection instead of returning it: a job connection shares the user's pool
/// (`open_job_connection`), so a connection left inside an open transaction would hand that
/// transaction to whatever the user runs next.
async fn close_exec(exec: Exec) {
    match exec {
        Exec::Postgres(c) => {
            let _ = c.close().await;
        }
        Exec::Mysql(c) => {
            let _ = c.close().await;
        }
        // One handle, owned by the job connection and dropped with it.
        Exec::Sqlite(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_size_shrinks_for_wide_tables_but_never_to_zero() {
        assert_eq!(batch_rows_for(3), MAX_ROWS_PER_INSERT);
        assert_eq!(batch_rows_for(100), 300);
        assert_eq!(batch_rows_for(50_000), 1);
        assert_eq!(batch_rows_for(0), MAX_ROWS_PER_INSERT);
    }

    #[test]
    fn placeholders_number_and_cast_every_cell_on_postgres() {
        let casts = vec!["::integer".to_string(), "::text".to_string()];
        assert_eq!(
            placeholders(2, &casts, 2, true),
            "($1::integer, $2::text), ($3::integer, $4::text)"
        );
    }

    #[test]
    fn placeholders_are_bare_question_marks_elsewhere() {
        assert_eq!(placeholders(2, &[], 3, false), "(?, ?, ?), (?, ?, ?)");
    }

    /// End to end on an in-memory SQLite: a bad row in a batch is found by position, skip mode keeps
    /// the good rows, atomic mode stops at the bad one.
    fn sqlite_session(mode: Mode) -> ImportSession {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL); BEGIN;")
            .unwrap();
        ImportSession {
            exec: Exec::Sqlite(std::sync::Arc::new(std::sync::Mutex::new(conn))),
            prefix: "INSERT INTO \"t\" (\"id\", \"name\") VALUES ".to_string(),
            casts: vec![String::new(), String::new()],
            is_pg: false,
            mode,
            batch_rows: 500,
            inserted: 0,
            failed_total: 0,
            feed: None,
            drop_on_rollback: None,
        }
    }

    /// Inserts rows numbered from `first_row`, the way a step does.
    async fn chunk(h: String, rows: Vec<Vec<Value>>, first_row: u64) -> Result<Value, String> {
        let shared = session_of(&h)?;
        let mut guard = shared.lock().await;
        let s = guard.as_mut().unwrap();
        let numbered: Vec<(u64, Vec<Value>)> = rows
            .into_iter()
            .enumerate()
            .map(|(i, r)| (first_row + i as u64, r))
            .collect();
        let res = insert_numbered(s, &numbered).await?;
        Ok(json!({ "inserted": res.inserted, "failed": res.failed, "stopped": res.stopped }))
    }

    fn register(s: ImportSession) -> String {
        let h = uuid::Uuid::new_v4().to_string();
        IMPORTS
            .lock()
            .unwrap()
            .insert(h.clone(), Arc::new(tokio::sync::Mutex::new(Some(s))));
        h
    }

    fn rows() -> Vec<Vec<Value>> {
        vec![
            vec![json!(1), json!("a")],
            vec![json!(2), Value::Null], // NOT NULL violation — the bad row
            vec![json!(3), json!("it's C:\\path\\")], // the quote and backslash a spliced literal broke on
        ]
    }

    #[tokio::test]
    async fn skip_mode_reports_the_failing_row_and_keeps_the_rest() {
        let h = register(sqlite_session(Mode::Skip));
        let res = chunk(h.clone(), rows(), 10).await.unwrap();
        assert_eq!(res["inserted"], 2);
        assert_eq!(res["failed"][0]["row"], 11);
        assert_eq!(res["stopped"], false);
        let done = import_finish(h, true).await.unwrap();
        assert_eq!(done["inserted"], 2);
    }

    #[tokio::test]
    async fn atomic_mode_stops_at_the_first_failing_row() {
        let h = register(sqlite_session(Mode::Atomic));
        let res = chunk(h.clone(), rows(), 1).await.unwrap();
        assert_eq!(res["stopped"], true);
        assert_eq!(res["failed"][0]["row"], 2);
        let done = import_finish(h, false).await.unwrap();
        assert_eq!(done["committed"], false);
        assert_eq!(done["inserted"], 0);
    }

    #[tokio::test]
    async fn bound_values_survive_quotes_and_backslashes() {
        let s = sqlite_session(Mode::Skip);
        let Exec::Sqlite(arc) = &s.exec else {
            unreachable!()
        };
        let arc = arc.clone();
        let h = register(s);
        chunk(h.clone(), vec![vec![json!(7), json!("it's C:\\path\\")]], 1)
            .await
            .unwrap();
        import_finish(h, true).await.unwrap();
        let name: String = arc
            .lock()
            .unwrap()
            .query_row("SELECT name FROM t WHERE id = 7", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "it's C:\\path\\");
    }

    #[tokio::test]
    async fn abort_is_harmless_on_an_unknown_handle() {
        assert!(import_abort("nope".to_string()).await.is_ok());
    }

    /// The whole path on a file: rows read and converted in Rust, a conversion failure skipped and
    /// counted, a database failure (the duplicate id) named by its row in the file.
    #[tokio::test]
    async fn steps_import_a_file_and_number_failures_by_file_row() {
        let dir = std::env::temp_dir().join(format!("tg-step-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rows.csv");
        std::fs::write(
            &path,
            "id,name
1,a
x,bad id
1,dup
3,c
",
        )
        .unwrap();
        let src: FileSource = serde_json::from_value(json!({
            "path": path.to_string_lossy(),
            "options": {},
            "columns": [
                { "target": { "name": "id", "type": "integer", "nullable": false }, "source": 0 },
                { "target": { "name": "name", "type": "text", "nullable": false }, "source": 1 },
            ],
            "coerce": { "trim": true },
        }))
        .unwrap();
        let mut session = sqlite_session(Mode::Skip);
        session.feed = Some(FileFeed::open(src).unwrap());
        let Exec::Sqlite(arc) = &session.exec else {
            unreachable!()
        };
        let arc = arc.clone();
        let h = register(session);

        let mut inserted = 0;
        let mut bad = 0;
        let mut failed = Vec::new();
        loop {
            let r = import_step(h.clone(), 2).await.unwrap();
            inserted += r["inserted"].as_u64().unwrap();
            bad += r["badRows"].as_u64().unwrap();
            failed.extend(
                r["failed"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|f| f["row"].as_u64().unwrap()),
            );
            if r["done"] == true {
                assert_eq!(r["rowsRead"], 4);
                break;
            }
        }
        assert_eq!((inserted, bad, failed), (2, 1, vec![4]));
        import_finish(h, true).await.unwrap();
        let n: i64 = arc
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
    }

    #[tokio::test]
    async fn an_atomic_step_with_a_bad_row_writes_nothing() {
        let dir = std::env::temp_dir().join(format!("tg-step-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rows.csv");
        std::fs::write(
            &path,
            "id,name
1,a
x,b
",
        )
        .unwrap();
        let src: FileSource = serde_json::from_value(json!({
            "path": path.to_string_lossy(),
            "options": {},
            "columns": [
                { "target": { "name": "id", "type": "integer", "nullable": false }, "source": 0 },
                { "target": { "name": "name", "type": "text", "nullable": false }, "source": 1 },
            ],
            "coerce": {},
        }))
        .unwrap();
        let mut session = sqlite_session(Mode::Atomic);
        session.feed = Some(FileFeed::open(src).unwrap());
        let h = register(session);
        let r = import_step(h.clone(), 100).await.unwrap();
        assert_eq!(r["stopped"], true);
        assert_eq!(r["inserted"], 0);
        assert_eq!(r["issues"][0]["row"], 3);
        import_abort(h).await.unwrap();
    }
}
