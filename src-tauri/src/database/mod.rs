//! Everything that talks to a SQL database.
//!
//! `mod.rs` holds no logic: it only declares the submodules and re-exports. It uses `pub use x::*;`
//! (a glob) rather than listing each name — `#[tauri::command]` also generates a hidden
//! `macro_rules! __cmd__<name>` that `generate_handler!` calls, and only a glob pulls it in.

pub mod exec;

mod commands;
mod conn;
mod decode;
mod dsn;
mod dump_file;
mod iam;
mod ident;
pub(crate) mod introspect;
mod read_only;
mod rows;
mod splitter;
mod timeout;

pub use commands::*;
pub use conn::*;
pub(crate) use dsn::*;
pub(crate) use dump_file::*;
pub(crate) use exec::bound::*;
pub(crate) use exec::raw::*;
pub(crate) use exec::stream::*;
pub(crate) use iam::*;
pub(crate) use ident::*;
pub(crate) use read_only::*;
pub(crate) use rows::*;
pub(crate) use splitter::*;
pub(crate) use timeout::*;
