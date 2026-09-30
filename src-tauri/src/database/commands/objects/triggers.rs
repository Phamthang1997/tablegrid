//! Triggers: listing them per table or database-wide, saving and dropping them.

use serde_json::{Value, json};

use crate::database::{DbKind, execute_raw_sql_generic, result_rows, row_str, sql_str};

#[tauri::command]
pub async fn get_table_triggers(conn_id: String, table_name: String) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.schema().to_string())
    };
    let sch = sql_str(&schema);

    let sql = match &conn_type.kind {
        DbKind::Mysql(_) => format!(
            "SELECT TRIGGER_NAME as name, ACTION_TIMING as timing, EVENT_MANIPULATION as event, ACTION_STATEMENT as statement FROM INFORMATION_SCHEMA.TRIGGERS WHERE EVENT_OBJECT_TABLE = '{}' AND TRIGGER_SCHEMA = DATABASE()",
            table_name.replace('\'', "''")
        ),
        DbKind::Postgres(_) => format!(
            "SELECT tr.tgname AS name, CASE WHEN tr.tgtype & 2 = 2 THEN 'BEFORE' WHEN tr.tgtype & 64 = 64 THEN 'INSTEAD OF' ELSE 'AFTER' END AS timing, CASE WHEN tr.tgtype & 4 = 4 THEN 'INSERT' WHEN tr.tgtype & 8 = 8 THEN 'DELETE' WHEN tr.tgtype & 16 = 16 THEN 'UPDATE' ELSE 'MANIPULATION' END AS event, pg_get_triggerdef(tr.oid) AS statement FROM pg_trigger tr JOIN pg_class c ON c.oid = tr.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = '{}' AND n.nspname = '{}' AND NOT tr.tgisinternal",
            table_name.replace('\'', "''"), sch
        ),
        DbKind::Sqlite(_) => format!(
            "SELECT name, 'BEFORE' as timing, 'MANIPULATION' as event, sql as statement FROM sqlite_master WHERE type = 'trigger' AND tbl_name = '{}'",
            table_name.replace('\'', "''")
        ),
        // DuckDB has no triggers: the same columns, no rows.
        DbKind::DuckDb(_) => "SELECT NULL AS name, NULL AS timing, NULL AS event, NULL AS statement WHERE false".to_string(),
    };

    let results = execute_raw_sql_generic(&conn_type, sql).await?;
    let mut triggers: Vec<Value> = Vec::new();
    for row in result_rows(&results) {
        triggers.push(json!({
            "name": row_str(row, "name").unwrap_or(""),
            "timing": row_str(row, "timing").unwrap_or("AFTER"),
            "event": row_str(row, "event").unwrap_or("INSERT"),
            "statement": row_str(row, "statement").unwrap_or("")
        }));
    }

    Ok(json!({ "success": true, "triggers": triggers }))
}).await
}

// Rebuild a runnable CREATE TRIGGER from what MySQL's information_schema exposes.
//
// MySQL is the only dialect that does not hand back the original statement: Postgres has
// pg_get_triggerdef() and SQLite stores the source in sqlite_master.sql, but
// INFORMATION_SCHEMA.TRIGGERS only has the pieces. `SHOW CREATE TRIGGER` would return the
// whole thing, yet it is one round trip per trigger and its output carries a DEFINER clause
// the dump has to strip anyway, so assembling it here costs one query for the whole database.
// ACTION_ORIENTATION is always 'ROW' in MySQL, hence the fixed FOR EACH ROW.
fn mysql_trigger_ddl(name: &str, table: &str, timing: &str, event: &str, body: &str) -> String {
    format!(
        "CREATE TRIGGER `{}` {} {} ON `{}` FOR EACH ROW\n{}",
        name,
        timing.trim(),
        event.trim(),
        table,
        body.trim()
    )
}

/// Every trigger of the current database, with a statement a dump can replay as-is.
///
/// `get_table_triggers` answers per table and is what the Structure tab uses; the export path
/// needs the whole database in one call, plus the owning table name (Postgres cannot drop a
/// trigger without `ON <table>`).
#[tauri::command]
pub async fn get_all_triggers(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.schema().to_string())
    };
    let sch = sql_str(&schema);

    let sql = match &conn_type.kind {
        DbKind::Mysql(_) => "SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event, ACTION_STATEMENT AS statement FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER, TRIGGER_NAME".to_string(),
        DbKind::Postgres(_) => format!("SELECT tr.tgname AS name, c.relname AS tbl, '' AS timing, '' AS event, pg_get_triggerdef(tr.oid) AS statement FROM pg_trigger tr JOIN pg_class c ON c.oid = tr.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '{sch}' AND NOT tr.tgisinternal ORDER BY c.relname, tr.tgname"),
        // sql IS NULL for objects SQLite creates itself; those cannot be replayed anyway.
        DbKind::Sqlite(_) => "SELECT name, tbl_name AS tbl, '' AS timing, '' AS event, sql AS statement FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY tbl_name, name".to_string(),
        DbKind::DuckDb(_) => "SELECT NULL AS name, NULL AS tbl, NULL AS timing, NULL AS event, NULL AS statement WHERE false".to_string(),
    };

    let results = execute_raw_sql_generic(&conn_type, sql).await?;
    let is_mysql = matches!(conn_type.kind, DbKind::Mysql(_));
    let mut triggers: Vec<Value> = Vec::new();
    for row in result_rows(&results) {
        let name = row_str(row, "name").unwrap_or("");
        let table = row_str(row, "tbl").unwrap_or("");
        let statement = row_str(row, "statement").unwrap_or("");
        if name.is_empty() || statement.is_empty() {
            continue;
        }
        let ddl = if is_mysql {
            mysql_trigger_ddl(
                name,
                table,
                row_str(row, "timing").unwrap_or("BEFORE"),
                row_str(row, "event").unwrap_or("INSERT"),
                statement,
            )
        } else {
            statement.to_string()
        };
        triggers.push(json!({ "name": name, "table": table, "statement": ddl }));
    }

    Ok(json!({ "success": true, "triggers": triggers }))
}).await
}

#[tauri::command]
pub async fn save_trigger(conn_id: String, statement_sql: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let conn_type = {
            let ctx = state.connections.acquire(&conn_id)?;
            ctx.conn().clone()
        };

        execute_raw_sql_generic(&conn_type, statement_sql).await?;
        Ok(json!({ "success": true, "message": "Đã lưu Trigger thành công" }))
    })
    .await
}

#[tauri::command]
pub async fn drop_trigger(conn_id: String, trigger_name: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let conn_type = {
            let ctx = state.connections.acquire(&conn_id)?;
            ctx.conn().clone()
        };

        let sql = match &conn_type.kind {
            DbKind::Mysql(_) => format!("DROP TRIGGER `{}`", trigger_name),
            _ => format!("DROP TRIGGER IF EXISTS \"{}\"", trigger_name),
        };

        execute_raw_sql_generic(&conn_type, sql).await?;
        Ok(json!({ "success": true, "message": "Đã xóa Trigger thành công" }))
    })
    .await
}
