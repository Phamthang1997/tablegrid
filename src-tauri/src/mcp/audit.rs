//! What an AI client asked for, kept so the user can see it.
//!
//! **In memory, and it says so in the UI.** The log is born in Rust while a window may not even be
//! open, so the frontend stores this app already has (`queryHistory.ts`, `jobs.ts`, both
//! `localStorage`) would drop exactly the requests most worth keeping - the ones that arrived while
//! nobody was watching. A ring buffer here is the honest V1: bounded, complete for this run, and
//! gone on exit. Writing it to a file is V2 (`docs/mcp-server-plan.md` §5.3).
//!
//! Every entry records **which layer refused**, not just that something failed. A log that only says
//! "denied" is something to look at; a log that says "denied at layer 3, connection not shared" is
//! something to act on.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use serde_json::{Value, json};

/// How many requests are kept. Old entries fall off the front.
const CAP: usize = 500;

/// How much of a statement is kept per entry.
///
/// The same shape `tx/` uses for its pending-statement log: cut, and **say** it was cut, rather than
/// silently showing less than what ran.
const SQL_MAX: usize = 2000;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Why a request did not run. `None` means it did.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Denial {
    /// Layer 1: `Origin` or `Host` was not loopback-on-our-port.
    BadOrigin,
    /// Layer 2: the bearer token was absent or wrong.
    BadToken,
    /// Layer 3: the connection is not shared with MCP clients (or does not exist).
    NotShared,
    /// Layer 4: not a single read statement.
    NotReadOnly,
    /// The connection is mid-transaction in TableGrid.
    ManualTransaction,
    /// Layer 4: the connection is shared for reading, but the user has not allowed writes on it.
    WriteNotAllowed,
    /// Layer 5: the user declined, did not answer in time, or the dialog went away.
    NotApproved,
    /// The database itself refused, or the query failed.
    Failed,
}

impl Denial {
    fn layer(self) -> u8 {
        match self {
            Denial::BadOrigin => 1,
            Denial::BadToken => 2,
            Denial::NotShared => 3,
            Denial::NotReadOnly => 4,
            Denial::ManualTransaction => 4,
            Denial::WriteNotAllowed => 4,
            Denial::NotApproved => 5,
            Denial::Failed => 0,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Monotonic within one run. The UI prepends new entries, so a list key derived from position
    /// would shift under every arrival and re-render the whole log.
    pub id: u64,
    /// RFC 3339, local time. The UI reformats it; keeping it as text means no clock type crosses IPC.
    pub at: String,
    pub tool: String,
    pub conn_id: Option<String>,
    pub sql: Option<String>,
    /// `sql` was cut at `SQL_MAX`.
    pub sql_truncated: bool,
    pub ms: u64,
    pub ok: bool,
    /// Present only when `ok` is false.
    pub denial: Option<Denial>,
    /// Which defence layer refused, `0` when the failure came from the database.
    pub layer: Option<u8>,
    pub message: Option<String>,
}

#[derive(Default)]
pub struct Audit {
    entries: Mutex<VecDeque<Entry>>,
}

impl Audit {
    pub fn record(&self, entry: Entry) {
        {
            let mut q = match self.entries.lock() {
                Ok(q) => q,
                Err(e) => e.into_inner(),
            };
            if q.len() == CAP {
                q.pop_front();
            }
            q.push_back(entry.clone());
        }
        // Outside the lock, and before the event for the same reason: the UI listener runs on the
        // caller's thread in Tauri, so holding this mutex across it would serialise every MCP
        // request behind the slowest window. The file write only queues, it does not block.
        super::audit_file::append(&entry);
        crate::state::emit("mcp-request", json!(entry));
    }

    /// Newest first, which is how the UI shows it and how `queryHistory` orders its own list.
    pub fn snapshot(&self) -> Vec<Value> {
        let q = match self.entries.lock() {
            Ok(q) => q,
            Err(e) => e.into_inner(),
        };
        q.iter().rev().map(|e| json!(e)).collect()
    }

    pub fn clear(&self) {
        let mut q = match self.entries.lock() {
            Ok(q) => q,
            Err(e) => e.into_inner(),
        };
        q.clear();
    }
}

/// Cut a statement to `SQL_MAX`, reporting whether it was cut.
///
/// Cuts on a **character** boundary, not a byte one: a `String` sliced mid-UTF-8 panics, and a
/// non-ASCII table name is not an exotic case in this app.
pub fn clip_sql(sql: &str) -> (String, bool) {
    match sql.char_indices().nth(SQL_MAX) {
        Some((cut, _)) => (sql[..cut].to_string(), true),
        None => (sql.to_string(), false),
    }
}

/// One entry, ready to record.
pub fn entry(tool: &str, conn_id: Option<&str>, sql: Option<&str>, ms: u64) -> Entry {
    let (sql, sql_truncated) = match sql {
        Some(s) => {
            let (text, cut) = clip_sql(s);
            (Some(text), cut)
        }
        None => (None, false),
    };
    Entry {
        id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
        at: chrono::Local::now().to_rfc3339(),
        tool: tool.to_string(),
        conn_id: conn_id.map(str::to_owned),
        sql,
        sql_truncated,
        ms,
        ok: true,
        denial: None,
        layer: None,
        message: None,
    }
}

/// Put one entry in the log, if the app is up.
///
/// The single writer for **both** callers: the tool wrapper in `tools/mod.rs` and the two HTTP
/// guards in `http.rs`. They record from different places for the same reason - a request the user
/// cannot see is a request they cannot diagnose - and two copies of the "is the app up yet" dance
/// would be one place for the door to stop reporting.
///
/// A request answered before setup finished is not worth failing over: the client already has its
/// answer, and there is no window listening to be told about it either.
pub fn record(entry: Entry) {
    if let Some(state) = crate::state::parked_state() {
        state.mcp.audit.record(entry);
    }
}

impl Entry {
    pub fn denied(mut self, denial: Denial, message: String) -> Self {
        self.ok = false;
        self.layer = Some(denial.layer());
        self.denial = Some(denial);
        self.message = Some(message);
        self
    }
}

/// A refusal, carrying **both** what the client is told and which layer said no.
///
/// The two must travel together. Recovering the layer from the message afterwards would mean
/// branching on user-facing text, which this codebase refuses to do anywhere - and the message is
/// the one part that may be reworded freely.
pub struct Refusal {
    pub denial: Denial,
    pub error: rmcp::ErrorData,
}

impl Refusal {
    pub fn new(denial: Denial, error: rmcp::ErrorData) -> Self {
        Refusal { denial, error }
    }
}

impl From<Refusal> for rmcp::ErrorData {
    fn from(r: Refusal) -> Self {
        r.error
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ring_drops_the_oldest_and_reports_newest_first() {
        let audit = Audit::default();
        for i in 0..CAP + 10 {
            audit.record(entry(&format!("tool{i}"), None, None, 0));
        }
        let snap = audit.snapshot();
        assert_eq!(snap.len(), CAP);
        assert_eq!(snap[0]["tool"], format!("tool{}", CAP + 9), "newest first");
        assert_eq!(snap[CAP - 1]["tool"], "tool10", "the first 10 fell off");
    }

    #[test]
    fn clipping_never_splits_a_character() {
        // A statement of multi-byte characters longer than the cap: slicing by BYTE would panic.
        let long: String = "é".repeat(SQL_MAX + 50);
        let (text, cut) = clip_sql(&long);
        assert!(cut);
        assert_eq!(text.chars().count(), SQL_MAX);
    }

    #[test]
    fn short_sql_is_not_marked_truncated() {
        let (text, cut) = clip_sql("SELECT 1");
        assert_eq!(text, "SELECT 1");
        assert!(!cut);
    }

    #[test]
    fn a_denial_records_which_layer_refused() {
        let e = entry("tablegrid_query", Some("c1"), Some("DROP TABLE t"), 3)
            .denied(Denial::NotReadOnly, "writes are refused".to_string());
        assert!(!e.ok);
        assert_eq!(e.layer, Some(4));
        // The database's own failures are not a defence layer, and must not read as one.
        let f = entry("tablegrid_query", Some("c1"), Some("SELECT 1"), 3)
            .denied(Denial::Failed, "syntax error".to_string());
        assert_eq!(f.layer, Some(0));
    }

    /// The two layers that actually fire while a user is still setting a client up. They used to be
    /// recorded nowhere, so the panel said "no request yet" while the client was being turned away
    /// at the door on every retry - the one state this log exists to make visible.
    #[test]
    fn the_door_layers_report_themselves() {
        let origin = entry("POST /mcp", None, None, 0)
            .denied(Denial::BadOrigin, "origin not allowed".to_string());
        assert_eq!(origin.layer, Some(1));
        let token = entry("POST /mcp", None, None, 0).denied(
            Denial::BadToken,
            "missing or invalid bearer token".to_string(),
        );
        assert_eq!(token.layer, Some(2));
        // The layer must survive serialisation: the UI switches on `denial`, and falls back to
        // `layer` for a variant it does not know yet.
        let wire = json!(token);
        assert_eq!(wire["denial"], "badToken");
        assert_eq!(wire["layer"], 2);
    }
}
