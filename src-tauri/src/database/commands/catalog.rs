//! Reading the current database's metadata: the table list, the catalog for autocomplete,
//! row counts (exact or estimated) and primary keys.

use serde_json::{Value, json};

use crate::database::introspect::{
    get_primary_key_columns, get_tables_inner, get_temporary_tables_inner,
};
use crate::database::{
    DbConnection, DbKind, cell, execute_raw_sql_generic, first_i64, pg_schema_of, rows_of, sql_str,
};

// Fetch the whole catalog (tables + columns/types/PK + FKs) in FEW queries so smart completion loads once
// instead of calling get_table_schema per table. MySQL/Postgres only (they have information_schema);

// SQLite returns empty -> the frontend falls back to lazy per-table loading.
#[tauri::command]
pub async fn get_full_catalog(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let (conn_type, db_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.dialect().to_string(), ctx.schema().to_string())
    };
    let sch = sql_str(&schema);

    let mut columns_map = serde_json::Map::new(); // table -> [{name,type,isPrimaryKey}]
    let mut fk_map = serde_json::Map::new();      // table -> [{column,refTable,refColumn}]

    if db_type == "mysql" {
        let col_sql = "SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS ty, COLUMN_KEY AS k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION".to_string();
        for row in rows_of(&execute_raw_sql_generic(&conn_type, col_sql).await?) {
            let t = cell(&row, "t").to_string();
            let entry = columns_map.entry(t).or_insert_with(|| Value::Array(vec![]));
            if let Some(arr) = entry.as_array_mut() {
                arr.push(json!({ "name": cell(&row, "c"), "type": cell(&row, "ty"), "isPrimaryKey": cell(&row, "k") == "PRI" }));
            }
        }
        let fk_sql = "SELECT TABLE_NAME AS t, COLUMN_NAME AS c, REFERENCED_TABLE_NAME AS rt, REFERENCED_COLUMN_NAME AS rc FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL".to_string();
        for row in rows_of(&execute_raw_sql_generic(&conn_type, fk_sql).await?) {
            let t = cell(&row, "t").to_string();
            let entry = fk_map.entry(t).or_insert_with(|| Value::Array(vec![]));
            if let Some(arr) = entry.as_array_mut() {
                arr.push(json!({ "column": cell(&row, "c"), "refTable": cell(&row, "rt"), "refColumn": cell(&row, "rc") }));
            }
        }
    } else if db_type == "postgres" {
        // format_type() so hover/completion shows `varchar(45)` like the MySQL branch
        // above (COLUMN_TYPE) instead of information_schema's bare `character varying`.
        let col_sql = format!(
            "SELECT cl.relname::text AS t, a.attname::text AS c, format_type(a.atttypid, a.atttypmod) AS ty \
             FROM pg_attribute a \
             JOIN pg_class cl ON cl.oid = a.attrelid \
             JOIN pg_namespace n ON n.oid = cl.relnamespace \
             WHERE n.nspname = '{sch}' AND cl.relkind IN ('r','v','m','p','f') \
               AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY cl.relname, a.attnum");
        for row in rows_of(&execute_raw_sql_generic(&conn_type, col_sql).await?) {
            let t = cell(&row, "t").to_string();
            let entry = columns_map.entry(t).or_insert_with(|| Value::Array(vec![]));
            if let Some(arr) = entry.as_array_mut() {
                arr.push(json!({ "name": cell(&row, "c"), "type": cell(&row, "ty"), "isPrimaryKey": false }));
            }
        }
        // PK: mark isPrimaryKey
        let pk_sql = format!("SELECT tc.table_name AS t, kcu.column_name AS c FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = '{sch}'");
        for row in rows_of(&execute_raw_sql_generic(&conn_type, pk_sql).await?) {
            let t = cell(&row, "t");
            let c = cell(&row, "c");
            if let Some(arr) = columns_map.get_mut(t).and_then(|v| v.as_array_mut()) {
                for col in arr.iter_mut() {
                    if col.get("name").and_then(|v| v.as_str()) == Some(c)
                        && let Some(o) = col.as_object_mut() { o.insert("isPrimaryKey".into(), json!(true)); }
                }
            }
        }
        let fk_sql = format!("SELECT tc.table_name AS t, kcu.column_name AS c, ccu.table_name AS rt, ccu.column_name AS rc FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = '{sch}'");
        for row in rows_of(&execute_raw_sql_generic(&conn_type, fk_sql).await?) {
            let t = cell(&row, "t").to_string();
            let entry = fk_map.entry(t).or_insert_with(|| Value::Array(vec![]));
            if let Some(arr) = entry.as_array_mut() {
                arr.push(json!({ "column": cell(&row, "c"), "refTable": cell(&row, "rt"), "refColumn": cell(&row, "rc") }));
            }
        }
    }
    // SQLite: return empty -> the frontend does its own lazy per-table loading

    Ok(json!({ "columns": columns_map, "foreignKeys": fk_map }))
}).await
}

#[tauri::command]
pub async fn get_tables(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        get_tables_inner(&state, conn_id).await
    })
    .await
}

/// Below this, an exact `COUNT(*)` is cheap enough that the estimate is not worth its inaccuracy.
///
/// The threshold is compared against the *estimate*, which is the only number available before
/// deciding — so a table the planner thinks is small always gets counted for real, and a table it
/// thinks is huge is never scanned just to fill in a status line.
const APPROX_COUNT_MIN: i64 = 500_000;

/// Exact `COUNT(*)`. `None` means "could not be counted", which is **not** the same as zero — the
/// grid has to be able to say "unknown" instead of claiming an empty table.
pub(super) async fn exact_row_count(conn: &DbConnection, count_sql: &str) -> Option<i64> {
    match &conn.kind {
        DbKind::Sqlite(conn_arc) => {
            let c = conn_arc.lock().ok()?;
            c.query_row(count_sql, [], |r| r.get::<_, i64>(0)).ok()
        }
        _ => first_i64(
            execute_raw_sql_generic(conn, count_sql.to_string())
                .await
                .ok()?,
        ),
    }
}

/// The planner's own row estimate, when it is both available and large enough to be worth using.
///
/// Same statistics `stats/` already reads for the database overview, and the same caveats
/// apply: `reltuples` is `-1` on a Postgres table that was never analyzed and MySQL's `TABLE_ROWS`
/// is an InnoDB guess that can be off by half. Both fall out through `APPROX_COUNT_MIN` rather
/// than needing a special case — a bogus estimate reads as "small" and gets counted for real.
///
/// Deliberately restricted to `relkind = 'r'` / `TABLE_TYPE = 'BASE TABLE'`: a view has no
/// statistics of its own, and a partitioned parent's `reltuples` does not include its partitions.
/// SQLite has no such statistic at all, and its `COUNT(*)` is local file I/O, so it returns `None`.
///
/// The caller must only reach this with **no WHERE clause** — an estimate cannot answer a filter.
pub(super) async fn estimate_row_count(
    conn: &DbConnection,
    schema: &Option<String>,
    table: &str,
) -> Option<i64> {
    let sql = match &conn.kind {
        DbKind::Postgres(_) => format!(
            "SELECT c.reltuples::bigint AS n FROM pg_class c \
             JOIN pg_namespace ns ON ns.oid = c.relnamespace \
             WHERE ns.nspname = '{}' AND c.relname = '{}' AND c.relkind = 'r'",
            sql_str(&pg_schema_of(schema)),
            sql_str(table)
        ),
        DbKind::Mysql(_) => format!(
            "SELECT TABLE_ROWS AS n FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{}' AND TABLE_TYPE = 'BASE TABLE'",
            sql_str(table)
        ),
        DbKind::Sqlite(_) => return None,
    };
    let n = first_i64(execute_raw_sql_generic(conn, sql).await.ok()?)?;
    (n >= APPROX_COUNT_MIN).then_some(n)
}

// The list of primary-key columns of a table, per dialect (composite primary keys included).
//

// Auto-detect the primary-key column name (taking the first one). Returns None when it cannot be determined.
pub(super) async fn detect_primary_key(
    conn: &DbConnection,
    schema: &Option<String>,
    table: &str,
) -> Option<String> {
    get_primary_key_columns(conn, schema, table)
        .await
        .into_iter()
        .next()
}

/// The temp tables/views this session owns — the sidebar's Temporary section.
///
/// The body lives in `database/introspect.rs` (no `#[tauri::command]` may sit there; see that
/// file's header) next to `get_tables_inner`, whose shape it mirrors so one sidebar row component
/// renders both.
#[tauri::command]
pub async fn get_temporary_tables(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        get_temporary_tables_inner(&state, conn_id).await
    })
    .await
}
