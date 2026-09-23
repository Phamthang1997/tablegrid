//! A connection's read-only mode: rejecting a write statement before it ever leaves the backend.

use super::conn::DbConnection;
use super::splitter::classification_head;

/// Refuse **anything** on a connection the user marked read-only, without looking at statement text.
///
/// For the paths that do not send one statement: the grid's Save, DROP/TRUNCATE, restore and the
/// Data Generator all know they are writes before they build any SQL, so classifying text there
/// would only be a way to get it wrong.
pub(crate) fn reject_conn_read_only(conn: &DbConnection) -> Result<(), String> {
    if crate::state::conn_is_read_only(&conn.id) {
        return Err("Kết nối đang ở chế độ chỉ đọc — tắt chế độ này trước khi ghi".to_string());
    }
    Ok(())
}

/// Refuse a write on a connection the user marked read-only.
///
/// Checked in the three funnels rather than in each write command, and that is the whole design: the
/// SQL editor sends arbitrary statement text, so guarding ~20 commands would leave the one path that
/// matters most guarded by whichever `if` someone remembered.
///
/// The funnels are **not** quite everywhere, though, and the four exceptions are exactly the ones
/// that hold their own connection: `commit_changes`, `run_fk_wrapped` (DROP/TRUNCATE),
/// `restore_backup` and `generate_data` go through `Exec`/an acquired pool connection because they
/// need one session for a batch — the same reason they must also ask `use_session()` rather than
/// `is_open()`. Each calls `reject_conn_read_only` at its entry. **A new path that takes its own
/// connection has to do the same**, and it fails loudly nowhere if it forgets: the write simply
/// succeeds on the connection labelled production.
///
/// `is_write_stmt` is deliberately conservative — `WITH` counts as a write, because a CTE can end in
/// INSERT/UPDATE/DELETE. Over-refusing costs a toggle; under-refusing costs the row.
pub(crate) fn reject_if_read_only(conn: &DbConnection, sql: &str) -> Result<(), String> {
    if !crate::tx::is_write_stmt(classification_head(sql)) {
        return Ok(());
    }
    reject_conn_read_only(conn)
}
