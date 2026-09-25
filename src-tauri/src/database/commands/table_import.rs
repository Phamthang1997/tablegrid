//! Importing rows from a file into an EXISTING table: `import_begin` / `import_chunk` /
//! `import_finish` / `import_abort`.
//!
//! This replaced a single `import_table_data` call per 500 rows, which had three problems. Each call
//! committed on its own, so a failure at row 4,000 left rows 1–3,500 in the table with no way back.
//! Values were spliced into the SQL text, and `sql_literal` only doubles `'` — on MySQL, where `\`
//! is an escape inside a string, a cell such as `C:\path\` broke the statement. And a failing batch
//! said nothing about WHICH row failed.
//!
//! Here one import is one transaction on one dedicated connection (`Exec`), held across the calls in
//! a module-level map, the same shape as `export_sink.rs`. The frontend streams the file in chunks,
//! so a large file never crosses IPC in one piece, and at the end it either commits or rolls back.
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

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use serde_json::{Value, json};

use super::super::decode::{bind_mysql_params, bind_pg_params, json_to_sqlite_value};
use crate::database::{
    DbConnection, DbKind, Exec, cell, pg_raw, qualified, quote_ident, reject_conn_read_only,
    rows_of, sql_str,
};

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
}

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

/// Starts an import into `table`, for the given columns in the order every chunk's rows will use.
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

        let is_pg = matches!(conn.kind, DbKind::Postgres(_));
        let mut exec = Exec::acquire(&conn).await?;

        // Postgres: each column's exact type for its cast, and whether any mapped column is
        // `GENERATED ALWAYS AS IDENTITY` (then the INSERT has to say OVERRIDING SYSTEM VALUE).
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
            .await?;
            let by_name: HashMap<String, (String, String)> = rows_of(&res)
                .iter()
                .map(|r| (cell(r, "name").to_string(), (cell(r, "type").to_string(), cell(r, "ident").to_string())))
                .collect();
            for col in &columns {
                let (ty, ident) = by_name
                    .get(col)
                    .ok_or_else(|| format!("Bảng không có cột '{col}'"))?;
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
            qualified(&conn, &schema, &table),
            cols_sql,
            if overriding { " OVERRIDING SYSTEM VALUE" } else { "" }
        );

        let begin = match conn.kind {
            DbKind::Mysql(_) => "START TRANSACTION",
            _ => "BEGIN",
        };
        run_plain(&mut exec, begin).await?;

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
            }))),
        );
        Ok(json!({ "success": true, "handle": handle, "batchRows": batch_rows }))
    })
    .await
}

/// Inserts one chunk of rows. `first_row` is the chunk's position in the file (1-based, as the user
/// counts rows), so a failure can be reported as "row 4,217" rather than "somewhere in chunk 3".
///
/// Returns the rows that failed in this chunk. In `atomic` mode the first failure ends the chunk
/// with `stopped: true`, and the caller is expected to `import_finish(commit = false)`.
#[tauri::command]
pub async fn import_chunk(
    handle: String,
    rows: Vec<Vec<Value>>,
    first_row: u64,
) -> Result<Value, String> {
    Box::pin(async move {
        let shared = session_of(&handle)?;
        let mut guard = shared.lock().await;
        let s = guard
            .as_mut()
            .ok_or_else(|| "internal: import already finished".to_string())?;

        let mut failed: Vec<Value> = Vec::new();
        let mut inserted_here: u64 = 0;
        let mut stopped = false;
        let batch = s.batch_rows;

        'batches: for (b, chunk) in rows.chunks(batch).enumerate() {
            let base = first_row + (b * batch) as u64;
            run_plain(&mut s.exec, "SAVEPOINT tg_imp_batch").await?;
            if insert_rows(s, chunk).await.is_ok() {
                run_plain(&mut s.exec, "RELEASE SAVEPOINT tg_imp_batch").await?;
                inserted_here += chunk.len() as u64;
                continue;
            }
            // Something in this batch failed: undo it and find which rows, one at a time.
            run_plain(&mut s.exec, "ROLLBACK TO SAVEPOINT tg_imp_batch").await?;
            for (i, row) in chunk.iter().enumerate() {
                run_plain(&mut s.exec, "SAVEPOINT tg_imp_row").await?;
                match insert_rows(s, std::slice::from_ref(row)).await {
                    Ok(()) => {
                        run_plain(&mut s.exec, "RELEASE SAVEPOINT tg_imp_row").await?;
                        inserted_here += 1;
                    }
                    Err(e) => {
                        run_plain(&mut s.exec, "ROLLBACK TO SAVEPOINT tg_imp_row").await?;
                        s.failed_total += 1;
                        if failed.len() < FAILED_SAMPLE_MAX {
                            failed.push(json!({ "row": base + i as u64, "error": e }));
                        }
                        if s.mode == Mode::Atomic {
                            stopped = true;
                            break 'batches;
                        }
                    }
                }
            }
            run_plain(&mut s.exec, "RELEASE SAVEPOINT tg_imp_batch").await?;
        }

        s.inserted += inserted_here;
        Ok(json!({
            "success": true,
            "inserted": inserted_here,
            "failed": failed,
            "stopped": stopped,
            "insertedTotal": s.inserted,
            "failedTotal": s.failed_total,
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
        let end = if commit { "COMMIT" } else { "ROLLBACK" };
        if let Err(e) = run_plain(&mut s.exec, end).await {
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
                && run_plain(&mut s.exec, "ROLLBACK").await.is_err()
            {
                close_exec(s.exec).await;
            }
        }
        Ok(json!({ "success": true }))
    })
    .await
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
        }
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
        let res = import_chunk(h.clone(), rows(), 10).await.unwrap();
        assert_eq!(res["inserted"], 2);
        assert_eq!(res["failed"][0]["row"], 11);
        assert_eq!(res["stopped"], false);
        let done = import_finish(h, true).await.unwrap();
        assert_eq!(done["inserted"], 2);
    }

    #[tokio::test]
    async fn atomic_mode_stops_at_the_first_failing_row() {
        let h = register(sqlite_session(Mode::Atomic));
        let res = import_chunk(h.clone(), rows(), 1).await.unwrap();
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
        import_chunk(h.clone(), vec![vec![json!(7), json!("it's C:\\path\\")]], 1)
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
}
