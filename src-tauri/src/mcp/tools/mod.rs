//! The MCP surface: the six tools an AI client can call, and nothing else.
//!
//! This file holds the DECLARATIONS - names, parameter schemas, descriptions - because
//! `#[tool_router]` wants them in one impl block. The bodies live in `catalog.rs` (introspection)
//! and `data.rs` (rows).
//!
//! Six of the seven tools are reads. The seventh, `tablegrid_mutate`, is guarded by three things
//! that are not interchangeable: a per-connection write tick the user sets (default off), a shape
//! check that refuses batches, and an approval dialog showing the exact statement. It runs on a
//! pooled connection, so what it writes is committed the moment it succeeds and the user's own
//! Rollback button cannot reach it - which is why the dialog says so rather than implying an undo.
//! See `docs/mcp-server-plan.md` §3.5.
//!
//! Parameter structs derive `JsonSchema`, so the schema an AI reads is generated from the very
//! struct the body destructures - the two cannot drift.

mod catalog;

mod data;

mod write;

use rmcp::{
    ErrorData as McpError, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router,
};
use std::future::Future;
use std::time::Instant;

use serde::Deserialize;
use serde_json::Value;

use super::audit::{self, Refusal};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ConnArgs {
    /// From tablegrid_list_connections. OMIT this when the user has shared exactly one
    /// connection - the tool then uses it. Required only when several are shared.
    //
    // `with = "String"` overrides only the SCHEMA, not the deserialisation. Without it, schemars
    // renders `Option<String>` as `"type": ["string", "null"]`, and a type ARRAY is outside the
    // schema subset Gemini/Antigravity accepts for function calling - it rejected the whole
    // `tools/list`, closed the client, and surfaced it as an unrelated `session not found`. The field
    // needs `#[serde(default)]` next to it to stay OUT of `required`: `with` makes schemars see a
    // plain String, and a plain String is required unless serde says it has a default. Without that
    // line the schema demanded the very argument this change exists to let callers omit.
    #[serde(default)]
    #[schemars(with = "String")]
    pub connection_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TableArgs {
    /// From tablegrid_list_connections. OMIT this when the user has shared exactly one
    /// connection - the tool then uses it. Required only when several are shared.
    //
    // `with = "String"` overrides only the SCHEMA, not the deserialisation. Without it, schemars
    // renders `Option<String>` as `"type": ["string", "null"]`, and a type ARRAY is outside the
    // schema subset Gemini/Antigravity accepts for function calling - it rejected the whole
    // `tools/list`, closed the client, and surfaced it as an unrelated `session not found`. The field
    // needs `#[serde(default)]` next to it to stay OUT of `required`: `with` makes schemars see a
    // plain String, and a plain String is required unless serde says it has a default. Without that
    // line the schema demanded the very argument this change exists to let callers omit.
    #[serde(default)]
    #[schemars(with = "String")]
    pub connection_id: Option<String>,
    /// Unqualified table or view name, as tablegrid_list_tables reports it.
    pub table_name: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PreviewArgs {
    /// From tablegrid_list_connections. OMIT this when the user has shared exactly one
    /// connection - the tool then uses it. Required only when several are shared.
    //
    // `with = "String"` overrides only the SCHEMA, not the deserialisation. Without it, schemars
    // renders `Option<String>` as `"type": ["string", "null"]`, and a type ARRAY is outside the
    // schema subset Gemini/Antigravity accepts for function calling - it rejected the whole
    // `tools/list`, closed the client, and surfaced it as an unrelated `session not found`. The field
    // needs `#[serde(default)]` next to it to stay OUT of `required`: `with` makes schemars see a
    // plain String, and a plain String is required unless serde says it has a default. Without that
    // line the schema demanded the very argument this change exists to let callers omit.
    #[serde(default)]
    #[schemars(with = "String")]
    pub connection_id: Option<String>,
    /// Unqualified table or view name, as tablegrid_list_tables reports it.
    pub table_name: String,
    /// Rows to return. Default 100, capped at 1000.
    // Same reason as `connection_id` above: an un-annotated `Option<usize>` renders as
    // `"type": ["integer", "null"]`, and a type array is outside the schema subset Gemini accepts.
    #[serde(default)]
    #[schemars(with = "usize")]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct QueryArgs {
    /// From tablegrid_list_connections. OMIT this when the user has shared exactly one
    /// connection - the tool then uses it. Required only when several are shared.
    //
    // `with = "String"` overrides only the SCHEMA, not the deserialisation. Without it, schemars
    // renders `Option<String>` as `"type": ["string", "null"]`, and a type ARRAY is outside the
    // schema subset Gemini/Antigravity accepts for function calling - it rejected the whole
    // `tools/list`, closed the client, and surfaced it as an unrelated `session not found`. The field
    // needs `#[serde(default)]` next to it to stay OUT of `required`: `with` makes schemars see a
    // plain String, and a plain String is required unless serde says it has a default. Without that
    // line the schema demanded the very argument this change exists to let callers omit.
    #[serde(default)]
    #[schemars(with = "String")]
    pub connection_id: Option<String>,
    /// Exactly ONE read statement: SELECT, EXPLAIN, SHOW, DESCRIBE or DESC.
    pub sql: String,
    /// Rows to return. Default 100, capped at 1000.
    // Same reason as `connection_id` above: an un-annotated `Option<usize>` renders as
    // `"type": ["integer", "null"]`, and a type array is outside the schema subset Gemini accepts.
    #[serde(default)]
    #[schemars(with = "usize")]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct MutateArgs {
    /// From tablegrid_list_connections. OMIT this when the user has shared exactly one
    /// connection - the tool then uses it. Required only when several are shared.
    //
    // `with = "String"` for the same reason as every other argument struct here: an
    // `Option<String>` renders as a type ARRAY, which Gemini/Antigravity reject for the whole
    // tools/list. See the long note on `ConnArgs`.
    #[serde(default)]
    #[schemars(with = "String")]
    pub connection_id: Option<String>,
    /// Exactly ONE statement that changes data or schema. The user sees this text verbatim in the
    /// approval dialog, so write it the way you want it read.
    pub sql: String,
}

#[derive(Clone)]
pub struct TableGridMcp {
    // Unread until a tool needs per-call state: with a static router the generated dispatch in
    // `#[tool_handler]` never looks at the field. It is not optional - both macros expect a field
    // of this exact name and type.
    #[allow(dead_code)]
    tool_router: ToolRouter<TableGridMcp>,
}

#[tool_router]
impl TableGridMcp {
    pub fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }

    #[tool(
        description = "List the database connections the TableGrid user has shared with AI clients. \
                       You do NOT need this first: every other tool takes connection_id as optional \
                       and uses the only shared connection when it is omitted. Call this when a tool \
                       says several are shared, or when the user asks what is available. Each entry \
                       carries connection_id, database, dialect, schema and read_only - pass \
                       connection_id back verbatim."
    )]
    async fn tablegrid_list_connections(&self) -> Result<CallToolResult, McpError> {
        audited(
            "tablegrid_list_connections",
            None,
            None,
            catalog::list_connections(),
        )
        .await
    }

    // "(or schemas)" was wrong: `list_databases_inner` reads `pg_database` on Postgres and
    // `SHOW DATABASES` on MySQL, so it never returns a schema. SQLite returns an empty array (one
    // file is one database) - said out loud, because an AI that gets `[]` with no explanation reads
    // it as a broken tool. And the names are NOT actionable: there is no tool to open one, so the
    // description has to stop a model from trying a database name as a connection_id.
    #[tool(
        description = "List the other databases on the same server as this connection. Informational \
                       only: you cannot switch to one, and a database name is not a connection_id - \
                       only tablegrid_list_connections yields those. Empty on SQLite, where one file \
                       is one database."
    )]
    async fn tablegrid_list_databases(
        &self,
        Parameters(a): Parameters<ConnArgs>,
    ) -> Result<CallToolResult, McpError> {
        audited(
            "tablegrid_list_databases",
            a.connection_id.as_deref(),
            None,
            catalog::list_databases(a.connection_id.as_deref()),
        )
        .await
    }

    // The description said "with row count estimates" and the body has never returned one:
    // `get_tables_inner` yields `name` + `type` on all three dialects and nothing else. That lie
    // costs real tokens rather than just being untidy - a model that believes it calls this for row
    // counts, does not find them, and then issues one `tablegrid_query` per table. So the promise is
    // corrected AND the model is told where counts actually come from.
    #[tool(
        description = "List the tables and views of the database a connection is open on. Returns \
                       name and type only - no row counts. For counts, use tablegrid_query with \
                       SELECT COUNT(*), or one query against information_schema.tables."
    )]
    async fn tablegrid_list_tables(
        &self,
        Parameters(a): Parameters<ConnArgs>,
    ) -> Result<CallToolResult, McpError> {
        audited(
            "tablegrid_list_tables",
            a.connection_id.as_deref(),
            None,
            catalog::list_tables(a.connection_id.as_deref()),
        )
        .await
    }

    // This one's promise checks out: `get_table_schema_inner` really does return columns (name,
    // type, nullable, isPrimaryKey, defaultValue, autoIncrement), indexes and foreignKeys.
    //
    // Its keys are camelCase while every tool PARAMETER is snake_case, and that stays. Unlike
    // `list_mcp_exposed` - MCP-only, so renaming its `connectionId` to `connection_id` cost nothing -
    // this body is shared with the UI's schema viewer, so renaming here breaks the UI for a
    // consistency an AI never has to round-trip. Do not "fix" it.
    #[tool(
        description = "Describe one table: columns, types, nullability, primary key, foreign keys \
                       and indexes. Prefer this over SELECT * when you only need the shape."
    )]
    async fn tablegrid_describe_table(
        &self,
        Parameters(a): Parameters<TableArgs>,
    ) -> Result<CallToolResult, McpError> {
        audited(
            "tablegrid_describe_table",
            a.connection_id.as_deref(),
            Some(&a.table_name),
            catalog::describe_table(a.connection_id.as_deref(), &a.table_name),
        )
        .await
    }

    #[tool(
        description = "Read the first rows of a table, to see what the data actually looks like. \
                       Cheaper and safer than writing a SELECT for the same thing."
    )]
    async fn tablegrid_preview_table(
        &self,
        Parameters(a): Parameters<PreviewArgs>,
    ) -> Result<CallToolResult, McpError> {
        audited(
            "tablegrid_preview_table",
            a.connection_id.as_deref(),
            Some(&a.table_name),
            data::preview_table(a.connection_id.as_deref(), &a.table_name, a.limit),
        )
        .await
    }

    // Three things the old text left the model to discover by failing. `WITH` is the expensive one:
    // a CTE is the first shape an analytical query reaches for, `policy::READ_HEADS` is a whitelist
    // of five heads that does not include it (a CTE can end in INSERT on Postgres, and nothing here
    // parses far enough to tell), so every such attempt was one refused round trip. Also: one
    // statement per call, and DESC counts - the old list named four of the five allowed heads.
    #[tool(
        description = "Run ONE read-only SQL statement and return the rows. Allowed heads: SELECT, \
                       EXPLAIN, SHOW, DESCRIBE, DESC. Everything else is refused, including WITH \
                       (rewrite a CTE as a subquery) and more than one statement per call. Writes \
                       and DDL are refused - ask the user to run those in TableGrid themselves. \
                       `limit` trims the result AFTER the database has run the whole query, so check \
                       `truncated` before drawing conclusions from a row count, and prefer your own \
                       LIMIT/COUNT(*) for big tables."
    )]
    async fn tablegrid_query(
        &self,
        Parameters(a): Parameters<QueryArgs>,
    ) -> Result<CallToolResult, McpError> {
        audited(
            "tablegrid_query",
            a.connection_id.as_deref(),
            Some(&a.sql),
            data::query(a.connection_id.as_deref(), &a.sql, a.limit),
        )
        .await
    }

    // Everything a model needs in order not to waste the user's attention is in this description,
    // because the cost of a bad call here is not a wasted round trip - it is a human interrupted.
    // Hence: one statement, no reads, no undo, and the fact that a refusal may mean the write tick
    // is off rather than that the SQL was wrong.
    #[tool(
        description = "Run ONE statement that CHANGES data or schema (INSERT, UPDATE, DELETE, \
                       DDL). The TableGrid user must approve the exact statement in a dialog \
                       before it runs, so: one statement per call, no batches, and no reads (use \
                       tablegrid_query for those). It is refused outright unless the user ticked \
                       'allow writes' for that connection - such a refusal is not a reason to \
                       rewrite the SQL, it is a reason to ask them. The statement runs OUTSIDE any \
                       transaction the user has open and commits immediately; there is no undo, so \
                       do not offer one. No affected-row count is returned - confirm with a \
                       follow-up SELECT."
    )]
    async fn tablegrid_mutate(
        &self,
        Parameters(a): Parameters<MutateArgs>,
    ) -> Result<CallToolResult, McpError> {
        audited(
            "tablegrid_mutate",
            a.connection_id.as_deref(),
            Some(&a.sql),
            write::mutate(a.connection_id.as_deref(), &a.sql),
        )
        .await
    }
}

impl Default for TableGridMcp {
    fn default() -> Self {
        Self::new()
    }
}

#[tool_handler]
impl ServerHandler for TableGridMcp {
    fn get_info(&self) -> ServerInfo {
        // No `with_protocol_version(...)`: the default is whatever revision this build of `rmcp`
        // implements. Pinning one here would freeze the app at a revision the SDK has moved past,
        // which is the exact failure the SDK was adopted to avoid.
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            // NOT `Implementation::from_build_env()`: that macro reads the CARGO_PKG_* of the crate
            // it expands in, which is `rmcp` - so the server introduced itself to every client as
            // "rmcp 3.1.4" instead of TableGrid. Spelled out here, it reads this crate's own.
            .with_server_info(tablegrid_identity())
            // Read ONCE per session, so this is the cheapest place to prevent a long detour. The
            // first version only said what the server was; a model asked "list the tables of db
            // test" would still go looking around before deciding these tools were the answer. It
            // now says outright that a question about the user's databases IS answered here, that
            // one call is usually enough, and where NOT to look - a connection string is not
            // something to hunt for on disk.
            .with_instructions(
                "These tools read the databases the TableGrid user already has open, live and \
                 read-only. Any question about their tables, schema or rows is answered here - do \
                 not look for credentials, config files or connection strings anywhere else, and do \
                 not ask the user for them.\n\
                 One call is usually enough: connection_id is OPTIONAL and can be omitted whenever \
                 the user has shared exactly one connection, so \"list the tables of the database\" \
                 is a single tablegrid_list_tables with no arguments. Call \
                 tablegrid_list_connections only when a tool tells you several are shared, or when \
                 the user asks which are available.\n\
                 A write or DDL goes through tablegrid_mutate, and only when the user has ticked \
                 \"allow writes\" for that connection. Every such call interrupts them with a \
                 dialog showing your exact statement, so send one at a time and say what it is \
                 for; the write commits immediately and cannot be undone from TableGrid."
                    .to_string(),
            )
    }
}

// ---------------------------------------------------------------------------
// Shared by the tool bodies
// ---------------------------------------------------------------------------

/// Run one tool call, time it, and record what happened.
///
/// **Every tool goes through here**, which is the point: recording per tool body would be one
/// forgotten line away from a request that touched a database and left no trace. It is the same
/// reason `policy::resolve` is the only door to a connection.
///
/// The body returns `Refusal` rather than a bare error so the log can say WHICH layer refused;
/// `?` would convert that away, which is why the conversion happens here and nowhere earlier.
async fn audited(
    tool: &str,
    conn_id: Option<&str>,
    sql: Option<&str>,
    run: impl Future<Output = Result<CallToolResult, Refusal>>,
) -> Result<CallToolResult, McpError> {
    let started = Instant::now();
    let outcome = run.await;
    let ms = started.elapsed().as_millis() as u64;
    let entry = audit::entry(tool, conn_id, sql, ms);

    match outcome {
        Ok(result) => {
            audit::record(entry);
            Ok(result)
        }
        Err(refusal) => {
            let message = refusal.error.message.to_string();
            audit::record(entry.denied(refusal.denial, message));
            Err(refusal.error)
        }
    }
}

/// The parked `AppState`, or a refusal saying the app is not ready.
///
/// A tool that runs before setup finished is a client that connected during startup - rare, and
/// answerable, which is better than a panic in an axum task nobody is watching.
pub(super) fn app_state() -> Result<crate::AppState, Refusal> {
    crate::state::parked_state()
        .ok_or_else(|| passthrough("TableGrid is still starting up".to_string()))
}

/// Wraps an error string from shared TableGrid code.
///
/// Known wart, recorded rather than papered over: these messages come from code the UI also uses, so
/// they arrive in Vietnamese. Translating them here would mean a second copy of
/// `src/utils/backendErrors.ts` in Rust, which is a worse trade than an AI client occasionally
/// reading a Vietnamese driver error. Messages this module writes itself are English.
pub(super) fn passthrough(err: String) -> Refusal {
    Refusal::new(audit::Denial::Failed, McpError::internal_error(err, None))
}

/// A tool result carrying JSON.
///
/// Pretty-printed text rather than a structured payload: every MCP client renders text content, and
/// the shape is already self-describing. Worth revisiting once structured output is universal.
pub(super) fn json_result(value: &Value) -> Result<CallToolResult, Refusal> {
    let text = serde_json::to_string_pretty(value).map_err(|e| passthrough(e.to_string()))?;
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

/// How the server introduces itself.
///
/// NOT `Implementation::from_build_env()`, which every rmcp example uses: that macro reads the
/// CARGO_PKG_* of the crate it expands in - `rmcp` - so the server announced itself to every client
/// as "rmcp 3.1.4". A client listing its MCP servers would show the SDK's name instead of this app's.
fn tablegrid_identity() -> Implementation {
    let mut me = Implementation::from_build_env();
    me.name = "tablegrid".to_string();
    me.version = env!("CARGO_PKG_VERSION").to_string();
    me
}
