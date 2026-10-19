//! Speaking SSH. Two separate jobs, with `auth` as the shared part:
//!
//! - `auth.rs`   — connect + authenticate (password or private key)
//! - `tunnel.rs` — port forwarding for SQL and Redis
//! - `known_hosts.rs` — host key verification (trust on first use, refuse a changed key)
//! - `commands.rs` — the two commands the frontend asks and answers a refused key with
//!
//! `terminal/ssh.rs` (PTY/shell) uses `auth` too but is NOT here: it belongs to
//! `terminal/` next to the local one, because the two terminal panels share one message protocol
//! and that is the fragile constraint. SSH is only its transport.

pub mod auth;
pub mod commands;
pub mod known_hosts;
pub mod tunnel;

pub use auth::*;
pub use tunnel::*;
