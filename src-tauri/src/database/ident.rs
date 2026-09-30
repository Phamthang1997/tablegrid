//! Quoting identifiers and literals per dialect. Every place that builds SQL from a table/column name goes through here.

use serde_json::Value;

use super::conn::{DbConnection, DbKind};

/// Defaults a Postgres schema to `public`, so a connection that never reported one behaves exactly
/// as it did before schema support existed.
///
/// This used to have a twin, `pg_schema(&DatabaseManager)`, called at 9 sites. Those sites now read
/// `ConnCtx::schema()`, which is defaulted on the way out — a call site can no longer forget to
/// default and silently query `public` (§4.4d of docs/multi-connection-plan.md). `ConnCtx` builds
/// its value with this function, so `public` is still spelled in exactly one place.
pub(crate) fn pg_schema_of(opt: &Option<String>) -> String {
    opt.clone().unwrap_or_else(|| "public".to_string())
}

/// Escape a schema/identifier for use inside a single-quoted SQL literal (`nspname = '...'`).
pub(crate) fn sql_str(s: &str) -> String {
    s.replace('\'', "''")
}

// Wrap an identifier per dialect (backticks on MySQL, double quotes elsewhere), doubling the closing character.
pub(crate) fn quote_ident(conn: &DbConnection, name: &str) -> String {
    match &conn.kind {
        DbKind::Mysql(_) => format!("`{}`", name.replace('`', "``")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// A table name as it must appear in generated SQL: `"sales"."film"` on Postgres.
///
/// Only Postgres qualifies — MySQL's schema *is* the open database (the connection already
/// points at it) and SQLite has none. Passing `None`/empty leaves the bare quoted name, so
/// every call site keeps its old output until a schema is actually selected. This is the twin
/// of `compare.rs`'s `qualified()`; see `docs/postgres-schema-support-plan.md` §4.2 for the
/// list of sites that must use it.
pub(crate) fn qualified(conn: &DbConnection, schema: &Option<String>, table: &str) -> String {
    match (&conn.kind, schema) {
        (DbKind::Postgres(_), Some(s)) if !s.is_empty() => {
            format!("{}.{}", quote_ident(conn, s), quote_ident(conn, table))
        }
        _ => quote_ident(conn, table),
    }
}

// Turn foreign-key checks on/off at the SESSION level. Only correct when every statement shares one `Exec`.
// Uses try_run: when the server refuses (Postgres' `session_replication_role` needs superuser) the main
// statement must still run, and the restoring statement must still be attempted even if the main one failed.
pub(crate) fn fk_checks_sql(conn: &DbConnection, on: bool) -> &'static str {
    match &conn.kind {
        DbKind::Mysql(_) => {
            if on {
                "SET FOREIGN_KEY_CHECKS = 1"
            } else {
                "SET FOREIGN_KEY_CHECKS = 0"
            }
        }
        DbKind::Postgres(_) => {
            if on {
                "SET session_replication_role = 'origin'"
            } else {
                "SET session_replication_role = 'replica'"
            }
        }
        DbKind::Sqlite(_) => {
            if on {
                "PRAGMA foreign_keys = ON"
            } else {
                "PRAGMA foreign_keys = OFF"
            }
        }
        // Unreachable in practice: the callers run these on an `Exec`, which refuses DuckDB. A
        // no-op rather than a panic keeps it that way if one day it is reached.
        DbKind::DuckDb(_) => "SELECT 1",
    }
}

// Format one JSON value as a SQL literal (following the same convention as commit_changes/export):
// null -> NULL, string -> '...' (single quotes escaped), everything else (numbers/bools) -> to_string().
pub(crate) fn sql_literal(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "NULL".to_string(),
        Some(Value::String(s)) => format!("'{}'", s.replace('\'', "''")),
        Some(other) => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    // `connect_lazy` builds a pool without touching the network, which is all these need: the
    // functions under test only branch on the DIALECT. It does spawn a pool reaper, though, so
    // the tests that build one must run under `#[tokio::test]`.
    fn sqlite() -> DbConnection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        DbConnection::adhoc(DbKind::Sqlite(Arc::new(Mutex::new(c))))
    }
    fn postgres() -> DbConnection {
        let p = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://u:p@127.0.0.1:5432/db")
            .unwrap();
        DbConnection::adhoc(DbKind::Postgres(p))
    }
    fn mysql() -> DbConnection {
        let p = sqlx::mysql::MySqlPoolOptions::new()
            .connect_lazy("mysql://u:p@127.0.0.1:3306/db")
            .unwrap();
        DbConnection::adhoc(DbKind::Mysql(p))
    }

    #[tokio::test]
    async fn quoting_follows_the_dialect() {
        assert_eq!(quote_ident(&mysql(), "film"), "`film`");
        assert_eq!(quote_ident(&postgres(), "film"), "\"film\"");
        assert_eq!(quote_ident(&sqlite(), "film"), "\"film\"");
    }

    /// SQL is assembled by string formatting throughout this app, so the closing character being
    /// doubled is the escaping. A name that carries one must not be able to end the quote early.
    #[tokio::test]
    async fn the_closing_character_is_doubled() {
        assert_eq!(quote_ident(&mysql(), "we`ird"), "`we``ird`");
        assert_eq!(quote_ident(&postgres(), "we\"ird"), "\"we\"\"ird\"");
        // A backtick is not special outside MySQL, and a double quote is not special inside it.
        assert_eq!(quote_ident(&postgres(), "a`b"), "\"a`b\"");
        assert_eq!(quote_ident(&mysql(), "a\"b"), "`a\"b`");
    }

    /// Only Postgres qualifies: MySQL's schema IS the open database and SQLite has none. Every
    /// call site must keep its old output until a schema is actually selected.
    #[tokio::test]
    async fn only_postgres_qualifies_with_a_schema() {
        let s = Some("sales".to_string());
        assert_eq!(qualified(&postgres(), &s, "film"), "\"sales\".\"film\"");
        assert_eq!(qualified(&mysql(), &s, "film"), "`film`");
        assert_eq!(qualified(&sqlite(), &s, "film"), "\"film\"");
        // No schema, or an empty one, leaves the bare quoted name on Postgres too.
        assert_eq!(qualified(&postgres(), &None, "film"), "\"film\"");
        assert_eq!(
            qualified(&postgres(), &Some(String::new()), "film"),
            "\"film\""
        );
    }

    #[test]
    fn pg_schema_defaults_to_public_in_one_place() {
        assert_eq!(pg_schema_of(&None), "public");
        assert_eq!(pg_schema_of(&Some("sales".into())), "sales");
    }

    #[test]
    fn sql_str_escapes_for_a_single_quoted_literal() {
        assert_eq!(sql_str("public"), "public");
        assert_eq!(sql_str("o'brien"), "o''brien");
    }

    #[tokio::test]
    async fn fk_checks_sql_is_per_dialect_and_reversible() {
        assert_eq!(fk_checks_sql(&mysql(), false), "SET FOREIGN_KEY_CHECKS = 0");
        assert_eq!(fk_checks_sql(&mysql(), true), "SET FOREIGN_KEY_CHECKS = 1");
        assert_eq!(
            fk_checks_sql(&postgres(), false),
            "SET session_replication_role = 'replica'"
        );
        assert_eq!(
            fk_checks_sql(&postgres(), true),
            "SET session_replication_role = 'origin'"
        );
        assert_eq!(fk_checks_sql(&sqlite(), false), "PRAGMA foreign_keys = OFF");
        assert_eq!(fk_checks_sql(&sqlite(), true), "PRAGMA foreign_keys = ON");
    }

    /// An absent key and an explicit JSON null must both become `NULL`, not the string `"null"` —
    /// they are what the grid sends for a cleared cell.
    #[test]
    fn sql_literal_covers_null_string_and_number() {
        assert_eq!(sql_literal(None), "NULL");
        assert_eq!(sql_literal(Some(&json!(null))), "NULL");
        assert_eq!(sql_literal(Some(&json!("o'brien"))), "'o''brien'");
        assert_eq!(sql_literal(Some(&json!(42))), "42");
        assert_eq!(sql_literal(Some(&json!(true))), "true");
    }
}
