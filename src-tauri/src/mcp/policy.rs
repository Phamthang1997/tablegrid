//! Defence layers 3 and 4: which connection an AI client may touch, and what it may run there.
//!
//! Everything in this file answers "no" by default. A tool that forgets to ask still cannot reach a
//! database, because `resolve()` is the only way to turn a `connection_id` from the wire into a
//! usable connection.

use rmcp::ErrorData as McpError;

use super::audit::{Denial, Refusal};

use crate::database::{DbConnection, split_sql_statements, strip_leading_comments};
use crate::state::AppState;

/// Rows returned to an AI client when the caller does not say otherwise.
pub const DEFAULT_ROW_LIMIT: usize = 100;

/// The ceiling a caller cannot argue past.
///
/// An AI asking for a million rows is not malicious, it is just optimistic; the cap is what keeps
/// one hopeful `limit` from turning into a full table decode.
pub const MAX_ROW_LIMIT: usize = 1000;

/// The hard ceiling on how long ONE MCP read may run.
///
/// The plan (§4.4) said "reuse the user's `statement_timeout`, the ceiling protects the database and
/// who typed the query does not change that". Half right: `stmt_timeout()` reads
/// `statementTimeoutSecs` and `unwrap_or(0)`, and `0` means **no timeout at all** - which is the
/// default. So on an ordinary connection the stated brake did not exist, and §4.3 accepts decoding a
/// full result before trimming it, which together means an AI's `SELECT * FROM huge_table` had
/// nothing stopping it.
///
/// A separate ceiling for MCP is justified by the one asymmetry the plan itself names: the user can
/// SEE their own query and press Stop, and an AI's query has no UI to stop - §4.4 says so in the
/// same breath as calling timeout the brake. Where timeout is the only brake, it cannot be optional.
const MAX_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// How long an MCP read may run: the user's own limit, but never above `MAX_TIMEOUT`.
///
/// **The smaller of the two, not the user's outright.** A lower setting is the user asking for
/// stricter, and that applies to an AI as much as to them; a higher one (or none) still lands on the
/// ceiling, because nobody is watching this query to cut it short by hand.
pub fn mcp_timeout(user: Option<std::time::Duration>) -> std::time::Duration {
    match user {
        Some(d) if d < MAX_TIMEOUT => d,
        _ => MAX_TIMEOUT,
    }
}

/// Statement heads that only read.
///
/// A **whitelist**, and the exact set `src/utils/safeMode.ts` uses, so "what counts as a read" has
/// one answer in this codebase rather than two that drift. Everything else is refused - including
/// `WITH`, which can end in INSERT/UPDATE/DELETE on Postgres, and including anything unrecognised.
/// Refusing wrongly costs the AI one sentence of explanation; allowing wrongly costs rows.
const READ_HEADS: [&str; 5] = ["SELECT", "EXPLAIN", "SHOW", "DESCRIBE", "DESC"];

/// A resolved connection: the handle, plus what a tool needs to name a table on it.
pub struct Target {
    pub conn: DbConnection,
    /// Postgres only, and `None` elsewhere - exactly what `qualified()` expects, so a table name
    /// built here lands in the schema the user is actually looking at rather than in `public`.
    pub schema: Option<String>,
    /// The statement time limit this read runs under. **Never `None`** - unlike the UI's own paths,
    /// an MCP read always has a limit; see `mcp_timeout`.
    pub timeout: std::time::Duration,
    /// Database name, for the approval dialog. Carried here rather than looked up again by the
    /// write tool: the entry is already in hand at resolve time, and a second lookup could name a
    /// different connection than the one this `Target` points at.
    pub database: String,
    /// `postgres` / `mysql` / `sqlite`, so the dialog can highlight the SQL it shows.
    pub dialect: &'static str,
}

/// The connection behind a `connection_id` from the wire, if the user shared it.
///
/// An id that is not exposed gets the SAME error as an id that does not exist. That is deliberate:
/// distinguishing them would confirm to a caller that a connection it may not see is nonetheless
/// open, which is a name, a database and a dialect it was never meant to learn.
/// Also returns the id it settled on, because the introspection bodies are keyed by it.
pub fn resolve(state: &AppState, given: Option<&str>) -> Result<(Target, String), Refusal> {
    resolve_inner(state, given, false)
}

/// The same, for a tool that intends to WRITE.
///
/// A separate entry point rather than a flag the caller may forget: `resolve` is the only door to a
/// connection, and the write tick has to sit in that same door. A tool that called `resolve` and
/// then checked the permission itself would be one missing `if` away from writing on a connection
/// shared for reading only.
///
/// The refusal is DISTINCT from `unknown_connection()`, deliberately breaking §3.3's rule about
/// never confirming what the caller may not see: to reach this line the caller already knows the
/// connection exists (it can read it), so the only thing the message reveals is which permission is
/// missing - and saying that is what lets the model ask the user for the right thing instead of
/// retrying the write forever.
pub fn resolve_write(state: &AppState, given: Option<&str>) -> Result<(Target, String), Refusal> {
    resolve_inner(state, given, true)
}

fn resolve_inner(
    state: &AppState,
    given: Option<&str>,
    need_write: bool,
) -> Result<(Target, String), Refusal> {
    let connection_id = pick_connection(state, given)?;
    if !state.connections.is_mcp_exposed(&connection_id) {
        return Err(unknown_connection());
    }
    if need_write && !state.connections.is_mcp_write_allowed(&connection_id) {
        return Err(Refusal::new(
            Denial::WriteNotAllowed,
            McpError::invalid_params(
                "the user shared this connection for reading only. Ask them to tick \"allow \
                 writes\" for it in TableGrid's MCP settings if they want you to change data."
                    .to_string(),
                None,
            ),
        ));
    }
    let ctx = state
        .connections
        .acquire(&connection_id)
        .map_err(|_| unknown_connection())?;
    reject_if_manual(&connection_id)?;
    let target = Target {
        conn: ctx.conn().clone(),
        schema: ctx.raw_schema().map(str::to_owned),
        timeout: mcp_timeout(crate::database::stmt_timeout(&ctx.server().config())),
        database: ctx.db().to_string(),
        dialect: ctx.dialect(),
    };
    Ok((target, connection_id))
}

/// The connection a call means: the one it named, or - when it named none - the only shared one.
///
/// **`connection_id` is optional, and that is an ergonomic decision with a safety argument.** Asking
/// "what tables does this database have" used to cost two round trips minimum, because the id had to
/// be discovered before anything could use it; a model that only wants one answer spends a call
/// learning a UUID. When exactly ONE connection is shared, that call carries no information: the
/// choice is already fully determined by the single tick the user made.
///
/// It stays explicit whenever it is genuinely ambiguous. Two or more shared connections refuse and
/// **name them**, so the caller's next attempt is right rather than a guess - guessing here would
/// read the wrong database, and this is the one place where "answers no by default" has to bend far
/// enough to be useful without bending into a guess.
fn pick_connection(state: &AppState, given: Option<&str>) -> Result<String, Refusal> {
    match given {
        Some(id) => Ok(id.to_string()),
        None => choose_only(state.connections.mcp_exposed_ids()),
    }
}

/// The three-way decision behind an omitted `connection_id`, kept **pure** so it has a test.
///
/// Zero shared answers with the same message as an id that does not exist (§3.3: never confirm that
/// something exists which the caller may not see). Two or more names them, because the alternative -
/// picking one - is reading a database the user did not mean.
fn choose_only(mut shared: Vec<String>) -> Result<String, Refusal> {
    match shared.len() {
        1 => Ok(shared.remove(0)),
        0 => Err(unknown_connection()),
        _ => {
            // Sorted so the message is stable: the registry is a HashMap, and an error that lists
            // the same two connections in a different order every call reads as flapping.
            shared.sort();
            Err(Refusal::new(
                Denial::NotShared,
                McpError::invalid_params(
                    format!(
                        "the user has shared {} connections, so connection_id is required. Call \
                         tablegrid_list_connections and pass one of: {}",
                        shared.len(),
                        shared.join(", ")
                    ),
                    None,
                ),
            ))
        }
    }
}

/// Refuse while the user has a manual transaction going on this connection.
///
/// This is what makes the pooled funnel in `execute_raw_sql_pooled` a belt next to braces rather
/// than the only guard. `should_route()` answers `true` whenever a session exists in manual mode -
/// before it looks at WHO sent the statement - so an AI read arriving mid-transaction would issue
/// `BEGIN` on the user session and light up a transaction they never opened. Refusing here means the
/// question never reaches routing at all; the pooled funnel then covers the sliver where the user
/// flips to manual mode between this check and the query.
///
/// The same shape `restore_backup` and `generate_data` already use (`reject_if_manual_or_open`),
/// with an English message because the reader here is an AI client.
pub fn reject_if_manual(connection_id: &str) -> Result<(), Refusal> {
    if crate::tx::manual_mode(connection_id) || crate::tx::is_open(connection_id) {
        return Err(Refusal::new(
            Denial::ManualTransaction,
            McpError::invalid_params(
                "this connection is in manual-commit mode in TableGrid. Ask the user to commit or \
                 roll back and switch back to auto-commit before querying it."
                    .to_string(),
                None,
            ),
        ));
    }
    Ok(())
}

fn unknown_connection() -> Refusal {
    // English, and NOT routed through `backendErrors.ts`: this is read by an AI client, not shown in
    // the TableGrid UI. Same rule as the comments `compare/` writes into a generated SQL script.
    Refusal::new(
        Denial::NotShared,
        McpError::invalid_params(
            "unknown connection_id, or it is not shared with MCP clients. Call \
             tablegrid_list_connections to see the connections the user shared."
                .to_string(),
            None,
        ),
    )
}

/// Is this SQL a single read statement?
///
/// Two refusals, not one. **Multiple statements** are refused because one tool call is one
/// statement: allowing a batch would mean the classification below has to hold for every statement
/// an AI concatenated, which is attack surface a read-only feature has no reason to carry.
/// **Non-reads** are refused by the whitelist above.
///
/// The splitter is the SQL editor's own, so a `;` inside a string, a comment or a `$$…$$` body does
/// not read as two statements - the difference between refusing a valid query and letting a second
/// one through unnoticed.
pub fn ensure_single_read(sql: &str) -> Result<(), Refusal> {
    let statements = split_sql_statements(sql);
    match statements.len() {
        0 => {
            return Err(refuse_read("no SQL statement found".to_string()));
        }
        1 => {}
        n => {
            return Err(refuse_read(format!(
                "expected exactly one statement, got {n}. Send them one call at a time."
            )));
        }
    }

    let head = statement_head(&statements[0]);
    if READ_HEADS.contains(&head.as_str()) {
        Ok(())
    } else {
        Err(refuse_read(format!(
            "this build allows read statements only ({}); got `{}`. \
             Ask the user to run writes from TableGrid itself.",
            READ_HEADS.join(", "),
            if head.is_empty() { "?" } else { &head }
        )))
    }
}

/// Is this SQL a single statement that is NOT a read?
///
/// The mirror of `ensure_single_read`, and it refuses reads on purpose: a `SELECT` sent to the
/// write tool would raise an approval dialog for something `tablegrid_query` answers without one,
/// which trains the user to click through dialogs. One statement per call, for the same reason as
/// the read side - the approval dialog shows what it is approving, and a batch would let a second
/// statement ride along behind the one the user read.
///
/// Everything else passes, INCLUDING DDL. There is no allow-list of "safe" writes here on purpose:
/// §0.3 already settled that keyword classification is the wrong mechanism, and a human reading the
/// statement is a better filter than any list this file could carry. `DROP TABLE` is refusable by
/// the person looking at it.
pub fn ensure_single_write(sql: &str) -> Result<(), Refusal> {
    let statements = split_sql_statements(sql);
    match statements.len() {
        0 => return Err(refuse_write("no SQL statement found".to_string())),
        1 => {}
        n => {
            return Err(refuse_write(format!(
                "expected exactly one statement, got {n}. Send them one call at a time so the user \
                 approves each one."
            )));
        }
    }

    let head = statement_head(&statements[0]);
    if READ_HEADS.contains(&head.as_str()) {
        return Err(refuse_write(format!(
            "`{head}` only reads, so use tablegrid_query for it. This tool is for statements that \
             change data, and every call costs the user an approval dialog."
        )));
    }
    if head.is_empty() {
        return Err(refuse_write(
            "could not read a statement keyword from this SQL".to_string(),
        ));
    }
    Ok(())
}

/// Every layer-4 refusal, so the denial and the message are built in one place.
fn refuse_read(message: String) -> Refusal {
    Refusal::new(Denial::NotReadOnly, McpError::invalid_params(message, None))
}

/// Layer-4 refusals from the write side. Same denial kind: both answer "this statement is not the
/// shape this tool accepts", and splitting them would only make the audit log harder to read.
fn refuse_write(message: String) -> Refusal {
    Refusal::new(Denial::NotReadOnly, McpError::invalid_params(message, None))
}

/// First keyword of a statement, uppercased, read past leading comments and wrapping parens.
///
/// `(SELECT …) UNION (SELECT …)` is still a read, which is why the parens are skipped rather than
/// treated as an unknown shape.
fn statement_head(statement: &str) -> String {
    let text = strip_leading_comments(statement);
    let word: String = text
        .trim_start_matches(['(', ' ', '\t', '\r', '\n'])
        .chars()
        .take_while(|c| c.is_ascii_alphabetic() || *c == '_')
        .collect();
    word.to_uppercase()
}

/// The row cap a caller actually gets.
pub fn row_limit(requested: Option<usize>) -> usize {
    requested
        .unwrap_or(DEFAULT_ROW_LIMIT)
        .clamp(1, MAX_ROW_LIMIT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_pass_and_everything_else_does_not() {
        for sql in [
            "SELECT 1",
            "select * from t",
            "EXPLAIN SELECT 1",
            "SHOW TABLES",
            "DESC t",
        ] {
            assert!(ensure_single_read(sql).is_ok(), "should allow: {sql}");
        }
        for sql in [
            "UPDATE t SET a = 1",
            "DELETE FROM t",
            "DROP TABLE t",
            "TRUNCATE t",
            "CREATE TABLE t (a int)",
            // A CTE can end in a write on Postgres, and nothing here parses far enough to tell.
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "CALL do_something()",
        ] {
            assert!(ensure_single_read(sql).is_err(), "should refuse: {sql}");
        }
    }

    #[test]
    fn writes_pass_the_write_gate_and_reads_are_sent_back_to_the_read_tool() {
        for sql in [
            "UPDATE t SET a = 1",
            "DELETE FROM t WHERE id = 1",
            "INSERT INTO t VALUES (1)",
            "DROP TABLE t",
            "CREATE TABLE t (a int)",
            // A CTE is unrecognised on the read side and refused there; on the write side that
            // same lack of knowledge means it MIGHT write, and a human is about to read it.
            "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x",
        ] {
            assert!(ensure_single_write(sql).is_ok(), "should allow: {sql}");
        }

        // A read here is not refused for being dangerous - it is refused for being pointless, and
        // the message has to send the model to the tool that answers it without a dialog.
        let read = ensure_single_write("SELECT 1").expect_err("a read is not a mutation");
        assert!(
            read.error.message.contains("tablegrid_query"),
            "{}",
            read.error.message
        );

        // One statement per call: the dialog shows what it is approving, and a second statement
        // would ride along behind the one the user read.
        assert!(ensure_single_write("UPDATE t SET a = 1; DROP TABLE t").is_err());
        // ...but a semicolon inside a string is still one statement, as on the read side.
        assert!(ensure_single_write("UPDATE t SET a = 'x;y'").is_ok());
        assert!(ensure_single_write("   ").is_err());
    }

    #[test]
    fn a_leading_comment_cannot_disguise_a_write() {
        assert!(ensure_single_read("/* SELECT */ DROP TABLE t").is_err());
        assert!(ensure_single_read("-- SELECT\nDELETE FROM t").is_err());
        // ...and must not make a genuine read look unrecognisable either.
        assert!(ensure_single_read("/* daily report */ SELECT 1").is_ok());
    }

    #[test]
    fn parenthesised_unions_are_still_reads() {
        assert!(ensure_single_read("(SELECT 1) UNION (SELECT 2)").is_ok());
    }

    #[test]
    fn a_second_statement_is_refused_but_a_semicolon_in_a_string_is_not() {
        assert!(ensure_single_read("SELECT 1; DROP TABLE t").is_err());
        assert!(
            ensure_single_read("SELECT 1;").is_ok(),
            "one statement with a trailing ;"
        );
        // The splitter's whole job: this is ONE statement, not two.
        assert!(ensure_single_read("SELECT 'a;b' FROM t").is_ok());
    }

    /// Omitting `connection_id` saves a round trip only while it cannot pick the wrong database.
    #[test]
    fn an_omitted_connection_id_resolves_only_when_there_is_no_choice() {
        let one = choose_only(vec!["c1".to_string()]);
        assert_eq!(one.ok(), Some("c1".to_string()));

        // Nothing shared reads exactly like an id that does not exist - §3.3.
        assert!(choose_only(vec![]).is_err());

        // Two shared must REFUSE and name them, never guess.
        let many = choose_only(vec!["zeta".to_string(), "alpha".to_string()]).expect_err("refuse");
        let msg = many.error.message.to_string();
        assert!(msg.contains("connection_id is required"), "{msg}");
        assert!(msg.contains("alpha, zeta"), "must name them, sorted: {msg}");
    }

    #[test]
    fn an_mcp_read_always_has_a_limit_and_never_a_longer_one() {
        use std::time::Duration;
        // The default case, and the one this exists for: `statementTimeoutSecs` unset means
        // `stmt_timeout` returns None, which used to mean no brake at all.
        assert_eq!(mcp_timeout(None), MAX_TIMEOUT);
        // Stricter than us is the user asking for stricter, and it applies to an AI too.
        assert_eq!(
            mcp_timeout(Some(Duration::from_secs(5))),
            Duration::from_secs(5)
        );
        // Looser than us still lands on the ceiling: nobody is watching this query to stop it.
        assert_eq!(mcp_timeout(Some(Duration::from_secs(3600))), MAX_TIMEOUT);
        assert_eq!(mcp_timeout(Some(MAX_TIMEOUT)), MAX_TIMEOUT);
    }

    #[test]
    fn row_limit_is_clamped_at_both_ends() {
        assert_eq!(row_limit(None), DEFAULT_ROW_LIMIT);
        assert_eq!(row_limit(Some(10)), 10);
        assert_eq!(row_limit(Some(0)), 1);
        assert_eq!(row_limit(Some(9_000_000)), MAX_ROW_LIMIT);
    }
}
