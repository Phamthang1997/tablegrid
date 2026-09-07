//! The built-in MCP server: an AI client on this machine reads databases through the connections the
//! user already has open, instead of being handed a connection string of its own.
//!
//! Plan, and the reasoning behind every decision here: `docs/mcp-server-plan.md`.
//!
//! **The protocol is not implemented in this directory.** `rmcp` (the official SDK, pinned at 3.1)
//! owns JSON-RPC 2.0, `initialize`, version negotiation and Streamable HTTP sessions. Writing a
//! hand-rolled parser here is the sign of a wrong turn: the spec revision moved twice while the plan
//! was being written, and version negotiation is exactly the part that fails silently once it is
//! stale. `rmcp` 3.1 implements revision **2026-07-28** and stays compatible back to 2025-11-25.
//!
//! What this directory owns is everything `rmcp` deliberately does not: where the server binds, who
//! is allowed to talk to it, which connections it may see, and what it is allowed to run.
//!
//! Five defence layers, in the order a request meets them (§3 of the plan):
//!
//! 1. **Bind `127.0.0.1` + `Origin`/`Host` validation** (`http.rs`). Loopback alone is not a wall: a
//!    page in the user's own browser can reach a loopback port, and DNS rebinding forges `Host`.
//!    The header check is what stops both.
//! 2. **Bearer token** from the OS keyring (`auth.rs`).
//! 3. **Per-connection exposure, default OFF** (`policy.rs`). Two ticks per connection, both off
//!    by default: one to let an AI see it at all, a second to let one ask for a write.
//! 4. **Statement classification** (`policy.rs`). A whitelist of read heads for the read tools, its
//!    mirror for the write tool, and one statement per call on both sides.
//! 5. **Interactive approval** (`approval.rs`). Every write is parked until the user answers a
//!    dialog showing the exact statement, or 60 seconds pass and it is refused.
//!
//! All five exist. Layers 3-5 are what `tools/` is allowed to assume, so a new tool that skips
//! `policy::resolve` skips all three at once - it is the only door to a connection for that reason.

mod approval;
mod audit;
pub mod audit_file;
mod auth;
pub(crate) mod http;
mod policy;
mod server;
pub mod stdio;
mod tools;

pub mod commands;

pub use server::{DEFAULT_PORT, McpServer, McpStatus};
