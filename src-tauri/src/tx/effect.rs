//! Classifying a SQL statement: what it does to the transaction, whether it is a write,
//! and the fixed strings of each dialect (BEGIN, isolation levels).
//!
//! This whole file is PURE functions — no state, no I/O — which makes it the only part of
//! `tx/` testable without a database.

use crate::database::{DbConnection, DbKind};

/// What a statement does to the transaction around it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TxEffect {
    None,
    Begin,
    Commit,
    Rollback,
    Savepoint(String),
    RollbackTo(String),
    Release(String),
    /// MySQL commits the open transaction before running the statement (DDL, LOCK TABLES, ...).
    /// Not an error, but the pending counter must drop to zero or the UI promises a rollback that
    /// cannot undo what already went in.
    ImplicitCommit,
}

// ---------------------------------------------------------------------------
// Pure helpers (verified with the standalone-rustc trick, see docs/implementation_plan17)
// ---------------------------------------------------------------------------

/// Word tokens of a statement, with leading comments already stripped by the caller. Punctuation
/// that can glue itself to a keyword (`;`, `(`) is a separator so `COMMIT;` and `COMMIT` classify
/// the same.
///
/// Returns the tokens twice: uppercased for keyword matching, and as typed for the ones that are
/// *names*. Uppercasing a savepoint name would show `S1` in the UI for a savepoint the user called
/// `s1`.
fn tokens(stmt: &str) -> (Vec<String>, Vec<String>) {
    // `=` is a separator too, or `SET AUTOCOMMIT=1` tokenizes as one word and misses the check
    // for MySQL's implicit commit.
    //
    // Only the first 4 tokens are ever read (`ROLLBACK TO SAVEPOINT <name>` is the longest form),
    // and this runs on EVERY statement — including a bulk INSERT whose text can be megabytes. The
    // cap keeps that from allocating a token per value.
    let raw: Vec<String> = stmt
        .split(|c: char| {
            c.is_whitespace() || c == ';' || c == '(' || c == ')' || c == ',' || c == '='
        })
        .filter(|w| !w.is_empty())
        .take(4)
        .map(|w| w.to_string())
        .collect();
    let upper = raw.iter().map(|w| w.to_uppercase()).collect();
    (upper, raw)
}

/// Savepoint names are identifiers: case-insensitive on both Postgres and MySQL unless quoted, and
/// this app never quotes them (see `sanitize_savepoint`).
pub(super) fn same_savepoint(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Strip the quoting a savepoint name may carry so `RELEASE SAVEPOINT \`s1\`` and
/// `RELEASE SAVEPOINT s1` name the same savepoint.
fn unquote(name: &str) -> String {
    name.trim_matches(|c| c == '`' || c == '"' || c == '\'' || c == ';')
        .to_string()
}

/// MySQL statements that commit the open transaction before they run.
///
/// The negative cases matter as much as the positive ones: `CREATE TEMPORARY TABLE` and
/// `DROP TEMPORARY TABLE` do NOT commit, and treating them as if they did would zero the pending
/// counter while the user's changes are still rollback-able.
fn mysql_implicit_commit(w: &[String]) -> bool {
    let first = w.first().map(|s| s.as_str()).unwrap_or("");
    let second = w.get(1).map(|s| s.as_str()).unwrap_or("");
    match first {
        "CREATE" | "DROP" => {
            if second == "TEMPORARY" {
                return false;
            }
            // CREATE/DROP of any schema object commits. The exhaustive list is long and grows per
            // MySQL version, so match the shape instead: anything that is not a temporary table.
            true
        }
        "ALTER" | "RENAME" | "TRUNCATE" => true,
        "LOCK" | "UNLOCK" => second == "TABLES",
        "GRANT" | "REVOKE" | "FLUSH" | "ANALYZE" | "OPTIMIZE" | "REPAIR" => true,
        "SET" => second == "AUTOCOMMIT",
        _ => false,
    }
}

/// Classify one statement. `stmt` must already have gone through
/// `database::strip_leading_comments` — a mysqldump statement carries its comment header inside
/// the statement text, and classifying the raw text would miss every keyword.
pub fn tx_effect(dialect: &str, stmt: &str) -> TxEffect {
    let (w, raw) = tokens(stmt);
    let first = w.first().map(|s| s.as_str()).unwrap_or("");
    let second = w.get(1).map(|s| s.as_str()).unwrap_or("");

    match first {
        "BEGIN" => TxEffect::Begin,
        "START" if second == "TRANSACTION" => TxEffect::Begin,
        "COMMIT" => TxEffect::Commit,
        // SQLite spells COMMIT as END too. Only SQLite: in MySQL a bare `END` belongs to a routine
        // body and never arrives here as a standalone statement.
        "END" if dialect == "sqlite" => TxEffect::Commit,
        "ROLLBACK" => {
            // ROLLBACK TO [SAVEPOINT] name — keeps the transaction open, unlike a plain ROLLBACK.
            if second == "TO" {
                let name = if w.get(2).map(|s| s.as_str()) == Some("SAVEPOINT") {
                    raw.get(3)
                } else {
                    raw.get(2)
                };
                match name {
                    Some(n) => TxEffect::RollbackTo(unquote(n)),
                    None => TxEffect::Rollback,
                }
            } else {
                TxEffect::Rollback
            }
        }
        "SAVEPOINT" => match raw.get(1) {
            Some(n) => TxEffect::Savepoint(unquote(n)),
            None => TxEffect::None,
        },
        "RELEASE" => {
            let name = if second == "SAVEPOINT" {
                raw.get(2)
            } else {
                raw.get(1)
            };
            match name {
                Some(n) => TxEffect::Release(unquote(n)),
                None => TxEffect::None,
            }
        }
        _ if dialect == "mysql" && mysql_implicit_commit(&w) => TxEffect::ImplicitCommit,
        _ => TxEffect::None,
    }
}

/// Does this statement change anything the user would want committed?
///
/// A `SELECT` inside a manual transaction is normal and even necessary — that is how you read back
/// what you just wrote, and how an isolation level means anything at all — so it still opens the
/// transaction. But counting it would be a lie: the pending counter next to the Commit button
/// promises "this many changes are waiting", and "2 statements" after two SELECTs reads as two
/// unsaved edits that do not exist.
///
/// Unknown shapes count as writes on purpose. Reporting a change that is not there costs one
/// needless rollback; reporting none when there is one loses data.
///
/// Like `tx_effect`, `stmt` must already have gone through `database::strip_leading_comments`:
/// a statement whose text starts with its own comment header would classify on the comment.
pub fn is_write_stmt(stmt: &str) -> bool {
    let (w, _) = tokens(stmt);
    let first = w.first().map(|s| s.as_str()).unwrap_or("");
    !matches!(
        first,
        // Reads and session/metadata statements. `WITH` is deliberately absent: a CTE can end in
        // INSERT/UPDATE/DELETE, so it is treated as a write.
        "SELECT"
            | "SHOW"
            | "EXPLAIN"
            | "DESCRIBE"
            | "DESC"
            | "PRAGMA"
            | "USE"
            | "SET"
            | "VALUES"
            | "TABLE"
            | "HELP"
            | ""
    )
}

/// Isolation levels this app offers, per dialect. SQLite has no isolation levels — the equivalent
/// knob is the locking mode of `BEGIN`, so its values are DEFERRED/IMMEDIATE/EXCLUSIVE and the UI
/// shows a different list rather than a shared list with items disabled.
pub fn isolation_allowed(dialect: &str, level: &str) -> bool {
    let up = level.to_uppercase();
    match dialect {
        "postgres" => matches!(
            up.as_str(),
            "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE"
        ),
        "mysql" => matches!(
            up.as_str(),
            "READ UNCOMMITTED" | "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE"
        ),
        "sqlite" => matches!(up.as_str(), "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE"),
        _ => false,
    }
}

/// The statement(s) that open a transaction, per dialect.
///
/// `isolation` is re-checked against the whitelist here even though the UI only offers valid
/// values: this string ends up inside SQL by formatting, like the rest of this app, and a
/// whitelist is the escaping.
pub fn begin_statements(dialect: &str, isolation: Option<&str>, read_only: bool) -> Vec<String> {
    let level = isolation
        .map(|s| s.to_uppercase())
        .filter(|s| isolation_allowed(dialect, s));

    match dialect {
        "postgres" => {
            let mut s = String::from("BEGIN");
            if let Some(l) = &level {
                s.push_str(&format!(" ISOLATION LEVEL {}", l));
            }
            if read_only {
                s.push_str(" READ ONLY");
            }
            vec![s]
        }
        "mysql" => {
            // MySQL cannot carry the isolation level on START TRANSACTION. `SET TRANSACTION`
            // without SESSION/GLOBAL applies to the NEXT transaction only, which is exactly the
            // scope wanted here.
            let mut out = Vec::new();
            if let Some(l) = &level {
                out.push(format!("SET TRANSACTION ISOLATION LEVEL {}", l));
            }
            out.push(if read_only {
                "START TRANSACTION READ ONLY".to_string()
            } else {
                "START TRANSACTION".to_string()
            });
            out
        }
        // SQLite: the level select carries the locking mode instead. READ ONLY has no equivalent.
        _ => vec![format!(
            "BEGIN {}",
            level.unwrap_or_else(|| "DEFERRED".to_string())
        )],
    }
}

/// Postgres marks the whole transaction unusable after one failed statement; everything after it
/// fails with 25P02 until ROLLBACK. That is a distinct UI state (only Rollback is offered), so it
/// is detected here rather than by the frontend comparing error text.
pub fn is_aborted_error(err: &str) -> bool {
    err.contains("25P02") || err.contains("current transaction is aborted")
}

pub fn dialect_of(conn: &DbConnection) -> &'static str {
    match &conn.kind {
        DbKind::Sqlite(_) => "sqlite",
        DbKind::Postgres(_) => "postgres",
        DbKind::Mysql(_) => "mysql",
        DbKind::DuckDb(_) => "duckdb",
    }
}

/// Savepoint names go into SQL by formatting like every other identifier in this app. Unlike a
/// table name they are invented by the user in a text box with no catalog to check against, so
/// restrict them to a shape that cannot carry an injection instead of quoting them.
pub(super) fn sanitize_savepoint(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    let ok = !trimmed.is_empty()
        && trimmed.len() <= 64
        && trimmed
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !ok {
        return Err("Tên savepoint chỉ gồm chữ, số và dấu gạch dưới, bắt đầu bằng chữ".to_string());
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_the_transaction_verbs() {
        assert_eq!(tx_effect("postgres", "BEGIN"), TxEffect::Begin);
        assert_eq!(tx_effect("mysql", "START TRANSACTION"), TxEffect::Begin);
        assert_eq!(tx_effect("postgres", "COMMIT;"), TxEffect::Commit);
        assert_eq!(tx_effect("postgres", "ROLLBACK"), TxEffect::Rollback);
    }

    /// `END` is COMMIT only on SQLite. On MySQL a bare `END` closes a routine body, and treating
    /// it as a commit would zero the pending counter mid-transaction.
    #[test]
    fn end_commits_on_sqlite_only() {
        assert_eq!(tx_effect("sqlite", "END"), TxEffect::Commit);
        assert_eq!(tx_effect("mysql", "END"), TxEffect::None);
        assert_eq!(tx_effect("postgres", "END"), TxEffect::None);
    }

    /// `ROLLBACK TO` keeps the transaction open — a different UI state from a plain ROLLBACK.
    #[test]
    fn rollback_to_carries_the_savepoint_name() {
        assert_eq!(
            tx_effect("postgres", "ROLLBACK TO s1"),
            TxEffect::RollbackTo("s1".into())
        );
        assert_eq!(
            tx_effect("postgres", "ROLLBACK TO SAVEPOINT s1"),
            TxEffect::RollbackTo("s1".into())
        );
        // No name at all is a plain rollback, not a panic.
        assert_eq!(tx_effect("postgres", "ROLLBACK TO"), TxEffect::Rollback);
    }

    /// The name is kept AS TYPED: uppercasing it would show `S1` for a savepoint the user made
    /// as `s1`, and the dialog is a record of what ran.
    #[test]
    fn savepoint_names_keep_their_case_and_lose_their_quotes() {
        assert_eq!(
            tx_effect("mysql", "SAVEPOINT s1"),
            TxEffect::Savepoint("s1".into())
        );
        assert_eq!(
            tx_effect("mysql", "SAVEPOINT `s1`"),
            TxEffect::Savepoint("s1".into())
        );
        assert_eq!(
            tx_effect("mysql", "RELEASE SAVEPOINT s1"),
            TxEffect::Release("s1".into())
        );
    }

    /// MySQL commits before DDL. Missing one leaves the counter promising a rollback that cannot
    /// undo what already went in.
    #[test]
    fn mysql_ddl_commits_implicitly() {
        for sql in [
            "CREATE TABLE t (id INT)",
            "DROP TABLE t",
            "ALTER TABLE t ADD c INT",
            "TRUNCATE t",
            "LOCK TABLES t WRITE",
            "SET AUTOCOMMIT=1",
        ] {
            assert_eq!(tx_effect("mysql", sql), TxEffect::ImplicitCommit, "{sql}");
        }
        // Only MySQL behaves this way.
        assert_eq!(
            tx_effect("postgres", "CREATE TABLE t (id INT)"),
            TxEffect::None
        );
    }

    /// The negative case matters as much: a TEMPORARY table does NOT commit, so the counter must
    /// stay put and the changes stay rollback-able.
    #[test]
    fn mysql_temporary_tables_do_not_commit() {
        assert_eq!(
            tx_effect("mysql", "CREATE TEMPORARY TABLE t (id INT)"),
            TxEffect::None
        );
        assert_eq!(tx_effect("mysql", "DROP TEMPORARY TABLE t"), TxEffect::None);
    }

    /// A SELECT opens the transaction but is not counted: the number next to Commit promises
    /// "this many changes are waiting".
    #[test]
    fn reads_are_not_writes() {
        for sql in [
            "SELECT 1",
            "SHOW TABLES",
            "EXPLAIN SELECT 1",
            "PRAGMA foreign_keys",
            "USE db",
            "SET autocommit=1",
            "",
        ] {
            assert!(!is_write_stmt(sql), "{sql}");
        }
    }

    /// Unknown shapes count as writes on purpose: over-reporting costs a needless rollback,
    /// under-reporting loses data. `WITH` can end in an INSERT.
    #[test]
    fn unknown_shapes_count_as_writes() {
        for sql in [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET a = 1",
            "DELETE FROM t",
            "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x",
            "CALL p()",
        ] {
            assert!(is_write_stmt(sql), "{sql}");
        }
    }

    #[test]
    fn isolation_levels_are_per_dialect() {
        assert!(isolation_allowed("postgres", "serializable"));
        assert!(!isolation_allowed("postgres", "READ UNCOMMITTED"));
        assert!(isolation_allowed("mysql", "READ UNCOMMITTED"));
        // SQLite has locking modes, not isolation levels.
        assert!(isolation_allowed("sqlite", "IMMEDIATE"));
        assert!(!isolation_allowed("sqlite", "SERIALIZABLE"));
        assert!(!isolation_allowed("oracle", "SERIALIZABLE"));
    }

    /// MySQL cannot carry the level on START TRANSACTION, so it needs two statements.
    #[test]
    fn begin_statements_per_dialect() {
        assert_eq!(begin_statements("postgres", None, false), vec!["BEGIN"]);
        assert_eq!(
            begin_statements("postgres", Some("serializable"), true),
            vec!["BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY"]
        );
        assert_eq!(
            begin_statements("mysql", Some("REPEATABLE READ"), false),
            vec![
                "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
                "START TRANSACTION"
            ]
        );
        assert_eq!(
            begin_statements("sqlite", None, false),
            vec!["BEGIN DEFERRED"]
        );
    }

    /// The whitelist IS the escaping: the level is formatted into SQL, so a value that is not on
    /// the list must be dropped rather than passed through.
    #[test]
    fn begin_statements_drop_a_level_not_on_the_whitelist() {
        assert_eq!(
            begin_statements("postgres", Some("SERIALIZABLE; DROP TABLE t"), false),
            vec!["BEGIN"]
        );
    }

    #[test]
    fn savepoint_names_are_restricted_not_quoted() {
        assert_eq!(sanitize_savepoint("  sp_1  ").unwrap(), "sp_1");
        assert_eq!(sanitize_savepoint("_x").unwrap(), "_x");
        for bad in [
            "",
            "1sp",
            "sp-1",
            "sp 1",
            "sp\"; DROP TABLE t --",
            &"a".repeat(65),
        ] {
            assert!(sanitize_savepoint(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn savepoint_comparison_is_case_insensitive() {
        assert!(same_savepoint("S1", "s1"));
        assert!(!same_savepoint("s1", "s2"));
    }

    /// Detected here, never by the frontend comparing error text.
    #[test]
    fn postgres_aborted_state_is_recognised() {
        assert!(is_aborted_error("ERROR: current transaction is aborted"));
        assert!(is_aborted_error("error returned from database: 25P02"));
        assert!(!is_aborted_error("syntax error at or near"));
    }
}
