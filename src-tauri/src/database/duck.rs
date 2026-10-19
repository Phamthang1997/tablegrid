//! DuckDB: opening a connection, decoding its cells, and the three funnels (raw / bound / stream).
//!
//! DuckDB is here to query FILES in place — Parquet, CSV, JSON — so the connection is read-mostly
//! from the app's side: every command outside these funnels and the catalog refuses it with
//! `DUCK_UNSUPPORTED` rather than guessing at a dialect it was written for.
//!
//! The crate is shaped like rusqlite (a synchronous handle), so a connection is the same
//! `Arc<Mutex<_>>` SQLite uses, and every call runs in `spawn_blocking`: a scan of a multi-GB file
//! can take seconds, and on the async runtime it would stall every other command meanwhile.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use duckdb::Connection as DuckConnection;
use duckdb::types::{TimeUnit, Value as DuckValue};
use serde_json::{Value, json};
use tauri::ipc::Channel;

use super::rows::uniquify_columns;

/// Shown for every command that has no DuckDB implementation (structure edits, restore, compare…).
pub(crate) const DUCK_UNSUPPORTED: &str = "DuckDB chưa hỗ trợ thao tác này";

/// Same batch size as the other dialects' streams.
const STREAM_BATCH: usize = 500;

/// Opens a DuckDB database: a file path, or an in-memory database for an empty path.
///
/// Extension autoinstall and autoload are switched OFF before anything else runs. With them on,
/// the first query naming `s3://…` (or any function of an extension not compiled in) makes DuckDB
/// download and load native code from extensions.duckdb.org without asking — which is also the
/// one thing that cannot work offline. Parquet and JSON are compiled into the binary, so nothing
/// the app offers needs a download; anything else fails with DuckDB's own "requires the extension"
/// message.
pub(crate) fn open_duckdb(path: &str) -> Result<DuckConnection, String> {
    let conn = if path.trim().is_empty() || path.trim() == ":memory:" {
        DuckConnection::open_in_memory()
    } else {
        DuckConnection::open(path)
    }
    .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "SET autoinstall_known_extensions = false; SET autoload_known_extensions = false;",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// One DuckDB cell as JSON, in the shapes the grids already render.
///
/// Scalars map onto what the other dialects send (numbers, strings, a byte array for a blob);
/// a value that cannot be a JSON number without losing digits — HUGEINT, DECIMAL — is a string,
/// as Postgres' NUMERIC is. Nested values (LIST, STRUCT, MAP, ARRAY) become JSON **text**: a grid
/// cell renders a string, and an object would print as `[object Object]`.
pub(crate) fn duck_to_json(v: DuckValue) -> Value {
    match v {
        DuckValue::Null => Value::Null,
        DuckValue::Enum(s) | DuckValue::Text(s) => json!(s),
        nested @ (DuckValue::List(_)
        | DuckValue::Array(_)
        | DuckValue::Struct(_)
        | DuckValue::Map(_)) => {
            json!(nested_json(nested).to_string())
        }
        DuckValue::Union(inner) => duck_to_json(*inner),
        scalar => scalar_json(scalar),
    }
}

/// Scalars, shared by the top level and the inside of nested values.
fn scalar_json(v: DuckValue) -> Value {
    match v {
        DuckValue::Null => Value::Null,
        DuckValue::Boolean(b) => json!(b),
        DuckValue::TinyInt(n) => json!(n),
        DuckValue::SmallInt(n) => json!(n),
        DuckValue::Int(n) => json!(n),
        DuckValue::BigInt(n) => json!(n),
        DuckValue::UTinyInt(n) => json!(n),
        DuckValue::USmallInt(n) => json!(n),
        DuckValue::UInt(n) => json!(n),
        DuckValue::UBigInt(n) => json!(n),
        DuckValue::HugeInt(n) => json!(n.to_string()),
        DuckValue::UHugeInt(n) => json!(n.to_string()),
        DuckValue::Float(f) => float_json(f as f64),
        DuckValue::Double(f) => float_json(f),
        DuckValue::Decimal(d) => json!(d.to_string()),
        DuckValue::Timestamp(unit, v) => json!(timestamp_text(unit, v)),
        DuckValue::Date32(days) => json!(date_text(days)),
        DuckValue::Time64(unit, v) => json!(time_text(unit, v)),
        DuckValue::Interval {
            months,
            days,
            nanos,
        } => json!(interval_text(months, days, nanos)),
        DuckValue::Text(s) | DuckValue::Enum(s) => json!(s),
        DuckValue::Blob(b) | DuckValue::Geometry(b) => json!(b),
        nested => nested_json(nested),
    }
}

/// A nested value as a JSON tree (only ever serialised to text by `duck_to_json`).
fn nested_json(v: DuckValue) -> Value {
    match v {
        DuckValue::List(items) | DuckValue::Array(items) => Value::Array(items.into_iter().map(nested_json).collect()),
        DuckValue::Struct(fields) => {
            let mut m = serde_json::Map::new();
            for (k, v) in fields.iter() {
                m.insert(k.clone(), nested_json(v.clone()));
            }
            Value::Object(m)
        }
        // A MAP's keys need not be strings, so it is a list of pairs rather than an object.
        DuckValue::Map(entries) => Value::Array(
            entries
                .iter()
                .map(|(k, v)| json!({ "key": nested_json(k.clone()), "value": nested_json(v.clone()) }))
                .collect(),
        ),
        DuckValue::Union(inner) => nested_json(*inner),
        scalar => scalar_json(scalar),
    }
}

/// NaN and ±inf are not JSON numbers; serde would turn them into `null`, i.e. lie.
fn float_json(f: f64) -> Value {
    if f.is_finite() {
        json!(f)
    } else {
        json!(f.to_string())
    }
}

fn to_micros(unit: TimeUnit, v: i64) -> i64 {
    match unit {
        TimeUnit::Second => v.saturating_mul(1_000_000),
        TimeUnit::Millisecond => v.saturating_mul(1_000),
        TimeUnit::Microsecond => v,
        TimeUnit::Nanosecond => v / 1_000,
    }
}

/// `YYYY-MM-DD HH:MM:SS[.ffffff]`, the same spelling Postgres' timestamps reach the grid in. A
/// TIMESTAMPTZ arrives as the UTC instant, so it is shown in UTC.
fn timestamp_text(unit: TimeUnit, v: i64) -> String {
    match chrono::DateTime::from_timestamp_micros(to_micros(unit, v)) {
        Some(dt) => dt.naive_utc().to_string(),
        None => v.to_string(),
    }
}

fn date_text(days: i32) -> String {
    chrono::NaiveDate::from_ymd_opt(1970, 1, 1)
        .and_then(|epoch| epoch.checked_add_signed(chrono::TimeDelta::days(days as i64)))
        .map(|d| d.to_string())
        .unwrap_or_else(|| days.to_string())
}

fn time_text(unit: TimeUnit, v: i64) -> String {
    let micros = to_micros(unit, v);
    let secs = micros.div_euclid(1_000_000);
    let frac = micros.rem_euclid(1_000_000) as u32;
    chrono::NaiveTime::from_num_seconds_from_midnight_opt(secs as u32, frac * 1_000)
        .map(|t| t.to_string())
        .unwrap_or_else(|| v.to_string())
}

/// DuckDB's own spelling: `1 year 2 months 3 days 04:05:06.5`, zero parts left out.
fn interval_text(months: i32, days: i32, nanos: i64) -> String {
    let mut parts = Vec::new();
    let (y, mo) = (months / 12, months % 12);
    let unit =
        |n: i64, one: &str, many: &str| format!("{n} {}", if n.abs() == 1 { one } else { many });
    if y != 0 {
        parts.push(unit(y as i64, "year", "years"));
    }
    if mo != 0 {
        parts.push(unit(mo as i64, "month", "months"));
    }
    if days != 0 {
        parts.push(unit(days as i64, "day", "days"));
    }
    if nanos != 0 || parts.is_empty() {
        let sign = if nanos < 0 { "-" } else { "" };
        let n = nanos.unsigned_abs();
        let (h, m, s, frac) = (
            n / 3_600_000_000_000,
            n / 60_000_000_000 % 60,
            n / 1_000_000_000 % 60,
            n % 1_000_000_000,
        );
        let mut t = format!("{sign}{h:02}:{m:02}:{s:02}");
        if frac != 0 {
            t.push_str(format!(".{frac:09}").trim_end_matches('0'));
        }
        parts.push(t);
    }
    parts.join(" ")
}

/// A JSON parameter as a DuckDB value (the SQL editor's `?` parameters).
fn param(v: &Value) -> DuckValue {
    match v {
        Value::Null => DuckValue::Null,
        Value::Bool(b) => DuckValue::Boolean(*b),
        Value::Number(n) => n
            .as_i64()
            .map(DuckValue::BigInt)
            .or_else(|| n.as_f64().map(DuckValue::Double))
            .unwrap_or(DuckValue::Null),
        Value::String(s) => DuckValue::Text(s.clone()),
        other => DuckValue::Text(other.to_string()),
    }
}

/// Runs one statement to completion and returns `{ columns, data }` — the shape of `sqlite_raw`.
///
/// Column names are read from the executed statement: duckdb-rs panics when they are asked for
/// before execution, which is the order the SQLite body uses.
pub(crate) fn duck_query_on(
    conn: &DuckConnection,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Value>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let values: Vec<DuckValue> = params.iter().map(param).collect();
    let mut rows = stmt
        .query(duckdb::params_from_iter(values.iter()))
        .map_err(|e| e.to_string())?;
    let mut columns: Vec<String> = rows.as_ref().map(|s| s.column_names()).unwrap_or_default();
    uniquify_columns(&mut columns);
    let mut data = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut map = serde_json::Map::new();
        // By index, like every other row-building site: a name lookup would find the first of
        // two columns that share a name.
        for (i, name) in columns.iter().enumerate() {
            let v: DuckValue = row.get(i).map_err(|e| e.to_string())?;
            map.insert(name.clone(), duck_to_json(v));
        }
        data.push(Value::Object(map));
    }
    Ok(vec![json!({ "columns": columns, "data": data })])
}

/// Funnel 1 and 2 for DuckDB: raw when `params` is empty, bound otherwise — the crate makes no
/// difference between the two.
pub(crate) async fn duck_query(
    conn_arc: &Arc<Mutex<DuckConnection>>,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Value>, String> {
    let conn_arc = conn_arc.clone();
    let sql = sql.to_string();
    let params = params.to_vec();
    tokio::task::spawn_blocking(move || {
        let c = conn_arc.lock().map_err(|e| e.to_string())?;
        duck_query_on(&c, &sql, &params)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Funnel 3 for DuckDB: `columns`, then `rows` batches, the protocol `sqlite_stream` speaks.
pub(crate) async fn duck_stream(
    conn_arc: &Arc<Mutex<DuckConnection>>,
    sql: &str,
    params: &[Value],
    stmt_index: usize,
    channel: &Channel<Value>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let conn_arc = conn_arc.clone();
    let channel = channel.clone();
    let cancel = cancel.clone();
    let sql = sql.to_string();
    let values: Vec<DuckValue> = params.iter().map(param).collect();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let c = conn_arc.lock().map_err(|e| e.to_string())?;
        let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query(duckdb::params_from_iter(values.iter())).map_err(|e| e.to_string())?;
        let mut columns: Vec<String> = rows.as_ref().map(|s| s.column_names()).unwrap_or_default();
        uniquify_columns(&mut columns);
        let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": columns }));
        let mut batch: Vec<Value> = Vec::with_capacity(STREAM_BATCH);
        while !cancel.load(Ordering::Relaxed) {
            let Some(row) = rows.next().map_err(|e| e.to_string())? else { break };
            let mut map = serde_json::Map::new();
            for (i, name) in columns.iter().enumerate() {
                let v: DuckValue = row.get(i).map_err(|e| e.to_string())?;
                map.insert(name.clone(), duck_to_json(v));
            }
            batch.push(Value::Object(map));
            if batch.len() >= STREAM_BATCH {
                let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": std::mem::take(&mut batch) }));
            }
        }
        if !batch.is_empty() {
            let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": batch }));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─── Catalog ─────────────────────────────────────────────────────────────────────────────
//
// Read from DuckDB's own table functions (`duckdb_columns()`, `duckdb_constraints()`,
// `duckdb_indexes()`) rather than information_schema where they say more — the full type
// spelling, the key columns as a list. Every query is scoped to `current_database()` and
// `current_schema()`, and the table name is BOUND: the same rule as everywhere else, where a
// name reaching a catalog query is either escaped or a parameter.

/// The rows of a query, as JSON objects.
fn rows_on(
    conn: &DuckConnection,
    sql: &str,
    params: &[Value],
) -> Result<Vec<serde_json::Map<String, Value>>, String> {
    let out = duck_query_on(conn, sql, params)?;
    Ok(out
        .first()
        .and_then(|r| r.get("data"))
        .and_then(|d| d.as_array())
        .map(|rows| rows.iter().filter_map(|r| r.as_object().cloned()).collect())
        .unwrap_or_default())
}

fn text(row: &serde_json::Map<String, Value>, key: &str) -> String {
    match row.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// Tables and views of the current schema, in `get_tables`' shape. A file the user attached is a
/// VIEW over `read_parquet(…)`, so it lists as a view.
pub(crate) fn duck_tables_on(conn: &DuckConnection) -> Result<Vec<Value>, String> {
    let rows = rows_on(
        conn,
        "SELECT table_name AS name, table_type AS kind FROM information_schema.tables \
         WHERE table_catalog = current_database() AND table_schema = current_schema() \
         ORDER BY table_name",
        &[],
    )?;
    Ok(rows
        .iter()
        .map(|r| json!({ "name": text(r, "name"), "type": if text(r, "kind") == "VIEW" { "view" } else { "table" } }))
        .collect())
}

/// Primary-key columns in key order.
pub(crate) fn duck_primary_key_on(conn: &DuckConnection, table: &str) -> Vec<String> {
    rows_on(
        conn,
        "SELECT unnest(constraint_column_names) AS c FROM duckdb_constraints() \
         WHERE database_name = current_database() AND schema_name = current_schema() \
           AND table_name = ? AND constraint_type = 'PRIMARY KEY'",
        &[json!(table)],
    )
    .map(|rows| rows.iter().map(|r| text(r, "c")).collect())
    .unwrap_or_default()
}

/// `get_table_schema`'s `{ columns, indexes, foreignKeys }` for one table or view.
pub(crate) fn duck_table_schema_on(conn: &DuckConnection, table: &str) -> Result<Value, String> {
    let pk = duck_primary_key_on(conn, table);
    let cols = rows_on(
        conn,
        "SELECT column_name, data_type, is_nullable, column_default FROM duckdb_columns() \
         WHERE database_name = current_database() AND schema_name = current_schema() AND table_name = ? \
         ORDER BY column_index",
        &[json!(table)],
    )?;
    let columns: Vec<Value> = cols
        .iter()
        .map(|r| {
            let name = text(r, "column_name");
            let default = text(r, "column_default");
            json!({
                "name": name,
                "type": text(r, "data_type"),
                "nullable": r.get("is_nullable").and_then(Value::as_bool).unwrap_or(true),
                "isPrimaryKey": pk.contains(&name),
                "defaultValue": if default.is_empty() { Value::Null } else { json!(default) },
                // A sequence default is DuckDB's only auto-increment.
                "autoIncrement": default.contains("nextval("),
            })
        })
        .collect();

    // Optional extras: a view has neither, and a catalog function missing on some version must
    // not blank the whole structure view.
    let indexes: Vec<Value> = rows_on(
        conn,
        "SELECT index_name, is_unique, CAST(expressions AS VARCHAR) AS expr FROM duckdb_indexes() \
         WHERE database_name = current_database() AND schema_name = current_schema() AND table_name = ? \
         ORDER BY index_name",
        &[json!(table)],
    )
    .unwrap_or_default()
    .iter()
    .map(|r| {
        let unique = r.get("is_unique").and_then(Value::as_bool).unwrap_or(false);
        json!({
            "name": text(r, "index_name"),
            "columns": index_columns(&text(r, "expr")),
            "unique": unique,
            "type": if unique { "UNIQUE" } else { "INDEX" },
            "method": "ART",
        })
    })
    .collect();

    // Two unnests in one SELECT advance together, pairing each column with its referenced column.
    let foreign_keys: Vec<Value> = rows_on(
        conn,
        "SELECT constraint_name AS name, unnest(constraint_column_names) AS col, referenced_table AS ref_table, \
                unnest(referenced_column_names) AS ref_col FROM duckdb_constraints() \
         WHERE database_name = current_database() AND schema_name = current_schema() \
           AND table_name = ? AND constraint_type = 'FOREIGN KEY'",
        &[json!(table)],
    )
    .unwrap_or_default()
    .iter()
    .map(|r| json!({ "name": text(r, "name"), "column": text(r, "col"), "refTable": text(r, "ref_table"), "refColumn": text(r, "ref_col") }))
    .collect();

    Ok(
        json!({ "success": true, "columns": columns, "indexes": indexes, "foreignKeys": foreign_keys }),
    )
}

/// `(columns, foreignKeys)`, each keyed by table name.
pub(crate) type CatalogMaps = (
    serde_json::Map<String, Value>,
    serde_json::Map<String, Value>,
);

/// `get_full_catalog`'s `(columns, foreignKeys)` maps for the whole schema, in three queries —
/// what autocomplete and the ER diagram load at once instead of one `get_table_schema` per table.
pub(crate) fn duck_catalog_on(conn: &DuckConnection) -> Result<CatalogMaps, String> {
    const SCOPE: &str = "database_name = current_database() AND schema_name = current_schema()";
    let mut pk: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for r in rows_on(
        conn,
        &format!(
            "SELECT table_name AS t, unnest(constraint_column_names) AS c FROM duckdb_constraints() WHERE {SCOPE} AND constraint_type = 'PRIMARY KEY'"
        ),
        &[],
    )? {
        pk.insert((text(&r, "t"), text(&r, "c")));
    }
    let mut columns = serde_json::Map::new();
    for r in rows_on(
        conn,
        &format!(
            "SELECT table_name AS t, column_name AS c, data_type AS ty FROM duckdb_columns() WHERE {SCOPE} ORDER BY table_name, column_index"
        ),
        &[],
    )? {
        let (t, c) = (text(&r, "t"), text(&r, "c"));
        let is_pk = pk.contains(&(t.clone(), c.clone()));
        if let Some(arr) = columns
            .entry(t)
            .or_insert_with(|| Value::Array(vec![]))
            .as_array_mut()
        {
            arr.push(json!({ "name": c, "type": text(&r, "ty"), "isPrimaryKey": is_pk }));
        }
    }
    let mut fks = serde_json::Map::new();
    for r in rows_on(
        conn,
        &format!(
            "SELECT table_name AS t, unnest(constraint_column_names) AS c, referenced_table AS rt, unnest(referenced_column_names) AS rc FROM duckdb_constraints() WHERE {SCOPE} AND constraint_type = 'FOREIGN KEY'"
        ),
        &[],
    )? {
        if let Some(arr) = fks
            .entry(text(&r, "t"))
            .or_insert_with(|| Value::Array(vec![]))
            .as_array_mut()
        {
            arr.push(json!({ "column": text(&r, "c"), "refTable": text(&r, "rt"), "refColumn": text(&r, "rc") }));
        }
    }
    Ok((columns, fks))
}

/// The `CREATE …` statement DuckDB kept for a table or a view — its own text, as SQLite's
/// `sqlite_master.sql` is.
pub(crate) fn duck_definition_on(conn: &DuckConnection, name: &str) -> Result<String, String> {
    let rows = rows_on(
        conn,
        "SELECT sql FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = current_schema() AND table_name = ? \
         UNION ALL \
         SELECT sql FROM duckdb_views() WHERE database_name = current_database() AND schema_name = current_schema() AND view_name = ? \
           AND NOT internal",
        &[json!(name), json!(name)],
    )?;
    let sql = rows
        .first()
        .map(|r| text(r, "sql"))
        .filter(|s| !s.is_empty())
        .ok_or("Không tìm thấy định nghĩa bảng")?;
    let sql = sql.trim().trim_end_matches(';');
    Ok(format!("{sql};"))
}

/// `duckdb_indexes().expressions` as text is `[a, "b c"]`; the grid wants `a, b c`.
fn index_columns(expr: &str) -> String {
    let inner = expr.trim().trim_start_matches('[').trim_end_matches(']');
    inner
        .split(',')
        .map(|p| p.trim().trim_matches('"').trim_matches('\''))
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Runs a catalog function on the blocking pool, like every other DuckDB call.
pub(crate) async fn duck_blocking<T: Send + 'static>(
    conn_arc: &Arc<Mutex<DuckConnection>>,
    f: impl FnOnce(&DuckConnection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let conn_arc = conn_arc.clone();
    tokio::task::spawn_blocking(move || {
        let c = conn_arc.lock().map_err(|e| e.to_string())?;
        f(&c)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(sql: &str) -> Value {
        let conn = open_duckdb("").unwrap();
        let out = duck_query_on(&conn, sql, &[]).unwrap();
        let row = out[0]["data"][0].as_object().unwrap().clone();
        Value::Object(row)
    }

    #[test]
    fn scalars_reach_the_grid_in_the_usual_shapes() {
        let r = one(
            "SELECT 1::TINYINT a, 42::BIGINT b, 18446744073709551615::UBIGINT c, \
                    170141183460469231731687303715884105727::HUGEINT d, 12.50::DECIMAL(10,2) e, \
                    true f, 'x'::VARCHAR g, 'inf'::DOUBLE h, 0.5::FLOAT i",
        );
        assert_eq!(r["a"], json!(1));
        assert_eq!(r["b"], json!(42));
        assert_eq!(r["c"], json!(18446744073709551615u64));
        // Past 2^53 — kept as text so no digit is lost on the way into JavaScript.
        assert_eq!(r["d"], json!("170141183460469231731687303715884105727"));
        assert_eq!(r["e"], json!("12.50"));
        assert_eq!(r["f"], json!(true));
        assert_eq!(r["g"], json!("x"));
        assert_eq!(r["h"], json!("inf"));
        assert_eq!(r["i"], json!(0.5));
    }

    #[test]
    fn temporal_values_are_readable_text() {
        let r = one(
            "SELECT DATE '2024-02-29' d, TIMESTAMP '2024-02-29 13:04:05.25' ts, TIME '23:59:58' t, \
                    INTERVAL '1 year 2 months 3 days 04:05:06.5' iv, INTERVAL '0 seconds' zero",
        );
        assert_eq!(r["d"], json!("2024-02-29"));
        assert_eq!(r["ts"], json!("2024-02-29 13:04:05.250"));
        assert_eq!(r["t"], json!("23:59:58"));
        assert_eq!(r["iv"], json!("1 year 2 months 3 days 04:05:06.5"));
        assert_eq!(r["zero"], json!("00:00:00"));
    }

    #[test]
    fn nested_values_become_json_text() {
        let r = one("SELECT [1, 2, 3] l, {'k': 'v', 'n': 1} s, MAP {1: 'a'} m, NULL::INT[] nl");
        assert_eq!(r["l"], json!("[1,2,3]"));
        assert_eq!(r["s"], json!(r#"{"k":"v","n":1}"#));
        assert_eq!(r["m"], json!(r#"[{"key":1,"value":"a"}]"#));
        assert_eq!(r["nl"], Value::Null);
    }

    #[test]
    fn repeated_column_names_are_suffixed_not_collapsed() {
        let conn = open_duckdb("").unwrap();
        let out = duck_query_on(&conn, "SELECT 1 AS x, 2 AS x", &[]).unwrap();
        assert_eq!(out[0]["columns"], json!(["x", "x (2)"]));
        assert_eq!(out[0]["data"][0]["x (2)"], json!(2));
    }

    #[test]
    fn parameters_are_bound() {
        let conn = open_duckdb("").unwrap();
        let out = duck_query_on(
            &conn,
            "SELECT ? + 1 AS n, ? AS s",
            &[json!(41), json!("hi")],
        )
        .unwrap();
        assert_eq!(out[0]["data"][0]["n"], json!(42));
        assert_eq!(out[0]["data"][0]["s"], json!("hi"));
    }

    /// The reason DuckDB is here, and the promise that nothing is fetched to keep it.
    #[test]
    fn reads_parquet_and_json_offline_and_refuses_what_is_not_compiled_in() {
        let dir = std::env::temp_dir().join(format!("tg-duck-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pq = dir.join("t.parquet").to_string_lossy().replace('\\', "/");
        let js = dir.join("t.json").to_string_lossy().replace('\\', "/");
        let conn = open_duckdb("").unwrap();
        conn.execute_batch(&format!(
            "COPY (SELECT range AS id FROM range(1000)) TO '{pq}' (FORMAT parquet);\
             COPY (SELECT 7 AS a) TO '{js}' (FORMAT json);"
        ))
        .unwrap();
        let n = duck_query_on(
            &conn,
            &format!("SELECT count(*) AS n FROM read_parquet('{pq}')"),
            &[],
        )
        .unwrap();
        assert_eq!(n[0]["data"][0]["n"], json!(1000));
        let a =
            duck_query_on(&conn, &format!("SELECT a FROM read_json_auto('{js}')"), &[]).unwrap();
        assert_eq!(a[0]["data"][0]["a"], json!(7));
        let s3 = duck_query_on(
            &conn,
            "SELECT * FROM read_parquet('s3://bucket/x.parquet')",
            &[],
        );
        assert!(s3.unwrap_err().contains("httpfs"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The catalog queries run against the real `duckdb_*()` functions, so a renamed column in a
    /// DuckDB upgrade fails here rather than as an empty structure view.
    #[test]
    fn catalog_lists_tables_columns_keys_indexes_and_foreign_keys() {
        let conn = open_duckdb("").unwrap();
        conn.execute_batch(
            "CREATE TABLE country (code VARCHAR PRIMARY KEY, name VARCHAR NOT NULL);\
             CREATE SEQUENCE city_seq;\
             CREATE TABLE city (id INTEGER PRIMARY KEY DEFAULT nextval('city_seq'), country VARCHAR REFERENCES country(code), \
                                pop DECIMAL(12,2), tags VARCHAR[]);\
             CREATE UNIQUE INDEX city_pop ON city (pop, country);\
             CREATE VIEW big AS SELECT * FROM city WHERE pop > 1000;",
        )
        .unwrap();

        let tables = duck_tables_on(&conn).unwrap();
        assert_eq!(
            tables,
            vec![
                json!({ "name": "big", "type": "view" }),
                json!({ "name": "city", "type": "table" }),
                json!({ "name": "country", "type": "table" }),
            ]
        );

        assert_eq!(duck_primary_key_on(&conn, "city"), vec!["id"]);
        let s = duck_table_schema_on(&conn, "city").unwrap();
        let cols = s["columns"].as_array().unwrap();
        assert_eq!(
            cols.iter()
                .map(|c| c["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["id", "country", "pop", "tags"]
        );
        assert_eq!(cols[0]["isPrimaryKey"], json!(true));
        assert_eq!(cols[0]["autoIncrement"], json!(true));
        assert_eq!(cols[2]["type"], json!("DECIMAL(12,2)"));
        assert_eq!(cols[3]["type"], json!("VARCHAR[]"));
        assert_eq!(s["indexes"][0]["name"], json!("city_pop"));
        assert_eq!(s["indexes"][0]["columns"], json!("pop, country"));
        assert_eq!(s["indexes"][0]["unique"], json!(true));
        assert_eq!(s["foreignKeys"][0]["column"], json!("country"));
        assert_eq!(s["foreignKeys"][0]["refTable"], json!("country"));
        assert_eq!(s["foreignKeys"][0]["refColumn"], json!("code"));

        assert!(
            duck_definition_on(&conn, "country")
                .unwrap()
                .starts_with("CREATE TABLE country(")
        );
        let view = duck_definition_on(&conn, "big").unwrap();
        assert!(view.starts_with("CREATE VIEW big AS SELECT"), "{view}");
        assert!(view.ends_with(';') && !view.ends_with(";;"));
        assert!(duck_definition_on(&conn, "nope").is_err());

        let (cat_cols, cat_fks) = duck_catalog_on(&conn).unwrap();
        assert_eq!(
            cat_cols["city"][0],
            json!({ "name": "id", "type": "INTEGER", "isPrimaryKey": true })
        );
        assert_eq!(cat_cols["city"][1]["isPrimaryKey"], json!(false));
        assert_eq!(
            cat_cols["big"].as_array().unwrap().len(),
            4,
            "views are in the catalog too"
        );
        assert_eq!(
            cat_fks["city"][0],
            json!({ "column": "country", "refTable": "country", "refColumn": "code" })
        );

        let v = duck_table_schema_on(&conn, "big").unwrap();
        assert_eq!(v["columns"].as_array().unwrap().len(), 4);
        assert!(v["indexes"].as_array().unwrap().is_empty());
        // A name that needs quoting is bound, not spliced.
        assert!(
            duck_table_schema_on(&conn, "x'; DROP TABLE city; --").unwrap()["columns"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(duck_tables_on(&conn).unwrap().len(), 3);
    }

    #[test]
    fn index_expressions_become_a_column_list() {
        assert_eq!(index_columns("[pop, country]"), "pop, country");
        assert_eq!(index_columns("[\"my col\"]"), "my col");
        assert_eq!(index_columns(""), "");
    }

    #[test]
    fn interval_edge_cases() {
        assert_eq!(interval_text(0, 0, -1_500_000_000), "-00:00:01.5");
        assert_eq!(interval_text(1, 1, 0), "1 month 1 day");
        assert_eq!(interval_text(-12, 0, 0), "-1 year");
    }
}
