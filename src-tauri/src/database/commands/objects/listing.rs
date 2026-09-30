//! Listing EVERY kind of database object, and reading the DDL of one of them by `kind`.

use serde_json::{Value, json};
use sqlx::Row;

use crate::database::{
    DbKind, all_string_values, execute_raw_sql_generic, result_rows, row_str, sql_str,
};

// List the database objects of the current connection: tables, views, functions, procedures
#[tauri::command]
pub async fn get_database_objects(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.schema().to_string())
    };
    let sch = sql_str(&schema);

    let mut tables: Vec<String> = Vec::new();
    let mut views: Vec<String> = Vec::new();
    let mut functions: Vec<String> = Vec::new();
    let mut procedures: Vec<String> = Vec::new();

    // Split tables/views out of the result (name_col, type_col) using the value that marks a view
    fn split_tables_views(results: &[Value], name_col: &str, type_col: &str, view_val: &str,
                          tables: &mut Vec<String>, views: &mut Vec<String>) {
        if let Some(data) = results.first().and_then(|r| r.get("data")).and_then(|v| v.as_array()) {
            for row in data {
                if let Some(o) = row.as_object() {
                    let name = o.get(name_col).and_then(|v| v.as_str()).unwrap_or("").to_string();
                    if name.is_empty() { continue; }
                    let ty = o.get(type_col).and_then(|v| v.as_str()).unwrap_or("");
                    if ty.eq_ignore_ascii_case(view_val) { views.push(name); } else { tables.push(name); }
                }
            }
        }
    }

    match &conn_type.kind {
        DbKind::Sqlite(conn_arc) => {
            let conn = conn_arc.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").map_err(|e| e.to_string())?;
            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let name: String = row.get(0).map_err(|e| e.to_string())?;
                let ty: String = row.get(1).map_err(|e| e.to_string())?;
                if ty == "view" { views.push(name); } else { tables.push(name); }
            }
            // SQLite has no user-defined functions/procedures
        }
        DbKind::DuckDb(arc) => {
            // Macros are DuckDB's only routines, and the app has no editor for them.
            for t in crate::database::duck_blocking(arc, crate::database::duck_tables_on).await? {
                let name = t["name"].as_str().unwrap_or("").to_string();
                if t["type"] == "view" { views.push(name); } else { tables.push(name); }
            }
        }
        DbKind::Postgres(_) => {
            // Materialized views: see the note in get_tables — information_schema has none.
            let tv = execute_raw_sql_generic(&conn_type,
                format!("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = '{sch}' \
                 UNION ALL \
                 SELECT c.relname, 'VIEW' FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = '{sch}' AND c.relkind = 'm' \
                 ORDER BY 1")).await?;
            split_tables_views(&tv, "table_name", "table_type", "VIEW", &mut tables, &mut views);

            let rt = execute_raw_sql_generic(&conn_type,
                format!("SELECT p.proname AS name, p.prokind::text AS kind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '{sch}' AND p.prokind IN ('f','p') ORDER BY p.proname"))
                .await.unwrap_or_default();
            if let Some(data) = rt.first().and_then(|r| r.get("data")).and_then(|v| v.as_array()) {
                for row in data {
                    if let Some(o) = row.as_object() {
                        let name = o.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        if name.is_empty() { continue; }
                        let kind = o.get("kind").and_then(|v| v.as_str()).unwrap_or("f");
                        if kind == "p" { procedures.push(name); } else { functions.push(name); }
                    }
                }
            }
        }
        DbKind::Mysql(_) => {
            let tv = execute_raw_sql_generic(&conn_type, "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name".to_string()).await?;
            split_tables_views(&tv, "table_name", "table_type", "VIEW", &mut tables, &mut views);

            let rt = execute_raw_sql_generic(&conn_type,
                "SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS kind FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() ORDER BY ROUTINE_NAME".to_string())
                .await.unwrap_or_default();
            if let Some(data) = rt.first().and_then(|r| r.get("data")).and_then(|v| v.as_array()) {
                for row in data {
                    if let Some(o) = row.as_object() {
                        let name = o.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        if name.is_empty() { continue; }
                        let kind = o.get("kind").and_then(|v| v.as_str()).unwrap_or("FUNCTION");
                        if kind.eq_ignore_ascii_case("PROCEDURE") { procedures.push(name); } else { functions.push(name); }
                    }
                }
            }
        }
    }

    // MySQL scheduled EVENTs. Only MySQL has them, and they are dumped like a routine (their
    // body carries its own `;`, so the export wraps them in a DELIMITER block).
    let mut events: Vec<String> = Vec::new();
    if matches!(conn_type.kind, DbKind::Mysql(_)) {
        let ev = execute_raw_sql_generic(
            &conn_type,
            "SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() ORDER BY EVENT_NAME".to_string(),
        )
        .await
        .unwrap_or_default();
        for row in result_rows(&ev) {
            if let Some(name) = row_str(row, "name")
                && !name.is_empty() {
                    events.push(name.to_string());
                }
        }
    }

    Ok(json!({
        "success": true,
        "tables": tables,
        "views": views,
        "functions": functions,
        "procedures": procedures,
        "events": events
    }))
}).await
}

// Read the definition (source) of a view / function / procedure
#[tauri::command]
pub async fn get_object_definition(
    conn_id: String,
    name: String,
    kind: String,
) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.schema().to_string())
    };
    let sch = sql_str(&schema);

    let ddl: String = match &conn_type.kind {
        DbKind::Mysql(pool) => {
            let stmt = match kind.as_str() {
                "function" => format!("SHOW CREATE FUNCTION `{}`", name),
                "procedure" => format!("SHOW CREATE PROCEDURE `{}`", name),
                "view" => format!("SHOW CREATE VIEW `{}`", name),
                "event" => format!("SHOW CREATE EVENT `{}`", name),
                _ => format!("SHOW CREATE TABLE `{}`", name),
            };
            let row = sqlx::query(sqlx::AssertSqlSafe(stmt)).fetch_one(pool).await.map_err(|e| e.to_string())?;
            let s: String = row.try_get("Create Event")
                .or_else(|_| row.try_get("Create Function"))
                .or_else(|_| row.try_get("Create Procedure"))
                .or_else(|_| row.try_get("Create View"))
                .or_else(|_| row.try_get("Create Table"))
                .map_err(|e| e.to_string())?;
            format!("{};", s)
        }
        DbKind::Postgres(_) => {
            let sql = match kind.as_str() {
                "function" | "procedure" => format!(
                    "SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '{}' AND p.proname = '{}' LIMIT 1",
                    sch, name.replace('\'', "''")
                ),
                "view" => format!(
                    "SELECT pg_get_viewdef('\"{}\".\"{}\"'::regclass, true) AS def",
                    sch.replace('"', "\"\""),
                    name.replace('"', "\"\"")
                ),
                _ => return Err("Loại đối tượng không được hỗ trợ".to_string()),
            };
            let results = execute_raw_sql_generic(&conn_type, sql).await?;
            all_string_values(&results).into_iter().next().ok_or("Không lấy được định nghĩa đối tượng")?
        }
        DbKind::Sqlite(conn_arc) => {
            let conn = conn_arc.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare("SELECT sql FROM sqlite_master WHERE name = ? LIMIT 1").map_err(|e| e.to_string())?;
            let mut rows = stmt.query([name.as_str()]).map_err(|e| e.to_string())?;
            if let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let s: String = row.get(0).map_err(|e| e.to_string())?;
                format!("{};", s)
            } else {
                return Err("Không tìm thấy định nghĩa".to_string());
            }
        }
        DbKind::DuckDb(arc) => {
            let n = name.clone();
            crate::database::duck_blocking(arc, move |c| crate::database::duck_definition_on(c, &n)).await?
        }
    };

    Ok(json!({ "success": true, "sql": ddl }))
}).await
}
