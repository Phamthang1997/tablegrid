//! Crate root. It holds ONLY what nothing else can: the module list, plus two re-exports that keep
//! the old paths working (`tablegrid::run` for `main.rs`, `crate::AppState` for 152 call sites).
//!
//! The three clippy lints below are switched off with reasons, the same way `.oxlintrc.json`'s
//! off-switches are argued in CLAUDE.md: a lint kept on without agreement teaches people to ignore
//! the output, and one turned off without a reason gets turned back on by the next reader.

// Every site indexes something OTHER than the collection being counted: the decode loops walk
// `0..col_count` to call the driver's `row.get_ref(i)` — reading a result set BY INDEX is a
// documented requirement, since `try_get` by name returns the first column of a repeated name — and
// `uniquify_columns` writes back into the slice it is walking. `.enumerate()` would keep the index
// and add a borrow, which is a lateral move at best and a rewrite of the hottest loop in the app at
// worst. Zero measured benefit against non-zero risk.
#![allow(clippy::needless_range_loop)]
// A `#[tauri::command]`'s parameter list IS the IPC contract: `dbHelper.ts` sends exactly those
// names, so grouping them into a struct changes the JSON the frontend must send. `get_table_data`
// has ten because paging, sorting, filtering and seek-pagination are ten independent things.
#![allow(clippy::too_many_arguments)]
// `check_server_key` in `ssh/auth.rs` is a trait impl whose signature returns
// `impl Future<..> + Send`. Rewriting it as `async fn` drops that explicit `Send` bound, and the
// future is handed to a spawned task that requires it. The manual form is the working one.
#![allow(clippy::manual_async_fn)]

pub mod app;
pub mod backup_prune;
pub mod compare;
pub mod credentials;
pub mod database;
pub mod datagen;
pub mod export_sink;
pub mod mcp;
pub mod redis_db;
pub mod ssh;
pub mod state;
pub mod stats;
pub mod terminal;
pub mod tx;

pub use app::run::run;
pub use state::AppState;
