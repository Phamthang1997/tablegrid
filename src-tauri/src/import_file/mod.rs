//! Importing a CSV / JSON / Excel file into a table, read from disk a record at a time.
//!
//! WHY THIS IS RUST AND NOT THE WEBVIEW: the dialog used to `file.arrayBuffer()` the whole file,
//! decode it into one string, parse it into a grid of JS strings, copy that grid, and convert the
//! whole grid again for the dry run — five copies of the file in the webview, the biggest several
//! times its size. A file of a few hundred MB took the webview down, and one past ~512M characters
//! cannot be a JS string at all. Here the dialog holds a PATH, and the file is read in a stream for
//! the preview (a few hundred rows), the dry run (counts only) and the import (a bounded channel a
//! few thousand rows ahead of the INSERTs).
//!
//! The conversion rules moved with the reading (`coerce.rs`, from `utils/tableImport.ts`), so there
//! is no TS twin: what the dry run reports is what the import does.
//!
//! LANGUAGE: error messages are Vietnamese like the rest of the backend and are translated at the
//! `dbHelper` boundary (`src/utils/backendErrors.ts`) — reword one here and update that table.

mod cell;
mod coerce;
mod commands;
mod csv;
mod json;
mod source;
mod text;
mod xlsx;

pub use commands::*;
