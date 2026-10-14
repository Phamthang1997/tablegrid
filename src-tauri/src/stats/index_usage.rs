//! The FACTS behind Database Info's Index tab: every index of the current database/schema with its
//! key columns, kind, size and how often it has been used, plus the foreign keys (an index that
//! backs one must not be proposed for dropping lightly).
//!
//! Only facts. Which index is unused, duplicated or covered by another is decided by
//! `src/utils/indexAnalysis.ts`, a pure function with tests — the judgement is where the risk is
//! (a wrong "redundant" on production is a dropped index someone needed), and judgement is easier to
//! pin down in one tested function than spread across three dialects of SQL here.
//!
//! Every secondary query is best-effort: no `performance_schema`, no rights on
//! `mysql.innodb_index_stats`, an old server without a view — each gives `null` for what it would
//! have answered (and says so through `usageAvailable` / `sizesAvailable`) rather than failing the
//! tab. The index list itself is the one query that must succeed.
//!
//! Read through `execute_raw_sql_pooled`: diagnostics must not join the user's manual transaction.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::database::{
    DbConnection, DbKind, execute_raw_sql_pooled, pg_schema_of, rows_of, sql_str,
};

fn text(row: &Value, key: &str) -> String {
    match row.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn num(row: &Value, key: &str) -> Option<i64> {
    match row.get(key)? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.trim().parse::<f64>().ok().map(|f| f as i64),
        _ => None,
    }
}

fn truthy(row: &Value, key: &str) -> bool {
    match row.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
        Some(Value::String(s)) => matches!(s.as_str(), "t" | "true" | "1" | "YES" | "yes"),
        _ => false,
    }
}

async fn rows(conn: &DbConnection, sql: String) -> Result<Vec<Value>, String> {
    Ok(rows_of(&execute_raw_sql_pooled(conn, sql).await?))
}

/// `tbl#p#p0` / `tbl#P#p0#SP#sp0` (InnoDB's names for a partition) → `tbl`.
pub(crate) fn base_table_name(name: &str) -> &str {
    let lower = name.to_ascii_lowercase();
    match lower.find("#p#") {
        Some(i) => &name[..i],
        None => name,
    }
}

/// Space-separated vector text (`oidvector`/`int2vector` cast to text) → its items.
pub(crate) fn vector_items(s: &str) -> Vec<String> {
    s.split_whitespace().map(str::to_string).collect()
}

/// Rows of `information_schema.STATISTICS` (one per key part, ordered) → one entry per index.
/// A functional key part has no column name; it gets a name no other index can have, so two
/// functional indexes are never mistaken for duplicates.
pub(crate) fn group_mysql_statistics(stat_rows: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut current: Option<(String, String)> = None;
    for r in stat_rows {
        let table = text(r, "tbl");
        let name = text(r, "idx");
        let mut col = text(r, "col");
        if col.is_empty() {
            col = format!("<expression {}#{}>", name, text(r, "seq"));
        }
        let sub = num(r, "sub_part").unwrap_or(0);
        let key = (table.clone(), name.clone());
        if current.as_ref() != Some(&key) {
            current = Some(key);
            out.push(json!({
                "table": table,
                "name": name,
                "columns": [],
                "flavors": [],
                "unique": num(r, "non_unique").unwrap_or(1) == 0,
                "primary": name == "PRIMARY",
                "constraint": false,
                "method": text(r, "method").to_lowercase(),
                "predicate": Value::Null,
                "valid": true,
                "sizeBytes": Value::Null,
                "scans": Value::Null,
            }));
        }
        let last = out.last_mut().expect("pushed above");
        last["columns"]
            .as_array_mut()
            .unwrap()
            .push(Value::String(col));
        // A prefix index on `name(10)` is not the same key as one on `name`.
        last["flavors"]
            .as_array_mut()
            .unwrap()
            .push(Value::String(if sub > 0 {
                format!("prefix:{sub}")
            } else {
                String::new()
            }));
    }
    out
}

async fn postgres_facts(conn: &DbConnection, schema: &str) -> Result<Value, String> {
    let s = sql_str(schema);
    let index_rows = rows(
        conn,
        format!(
            "SELECT t.relname AS tbl, i.relname AS idx, ix.indisunique AS uniq, ix.indisprimary AS pk, \
                ix.indisvalid AS valid, am.amname AS method, \
                COALESCE(pg_get_expr(ix.indpred, ix.indrelid), '') AS pred, \
                (SELECT string_agg(pg_get_indexdef(ix.indexrelid, k, true), chr(31) ORDER BY k) \
                   FROM generate_series(1, ix.indnkeyatts) AS k) AS cols, \
                ix.indclass::text AS opclasses, ix.indoption::text AS opts, ix.indcollation::text AS colls, \
                pg_relation_size(i.oid) AS size_bytes, s.idx_scan AS scans, \
                EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid AND c.contype IN ('p','u','x')) AS backs \
             FROM pg_index ix \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_class t ON t.oid = ix.indrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             JOIN pg_am am ON am.oid = i.relam \
             LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = ix.indexrelid \
             WHERE n.nspname = '{s}' \
             ORDER BY t.relname, i.relname"
        ),
    )
    .await?;

    let indexes: Vec<Value> = index_rows
        .iter()
        .map(|r| {
            let cols: Vec<String> = text(r, "cols")
                .split('\u{1f}')
                .filter(|c| !c.is_empty())
                .map(str::to_string)
                .collect();
            let n = cols.len();
            let opc = vector_items(&text(r, "opclasses"));
            let opt = vector_items(&text(r, "opts"));
            let col = vector_items(&text(r, "colls"));
            // One "flavor" per key column: operator class, sort options and collation. Two indexes
            // on the same columns with another opclass (text_pattern_ops) or DESC are not duplicates.
            let flavors: Vec<String> = (0..n)
                .map(|k| {
                    format!(
                        "{}:{}:{}",
                        opc.get(k).map(String::as_str).unwrap_or(""),
                        opt.get(k).map(String::as_str).unwrap_or(""),
                        col.get(k).map(String::as_str).unwrap_or("")
                    )
                })
                .collect();
            let pred = text(r, "pred");
            json!({
                "table": text(r, "tbl"),
                "name": text(r, "idx"),
                "columns": cols,
                "flavors": flavors,
                "unique": truthy(r, "uniq"),
                "primary": truthy(r, "pk"),
                "constraint": truthy(r, "backs"),
                "method": text(r, "method"),
                "predicate": if pred.is_empty() { Value::Null } else { Value::String(pred) },
                "valid": truthy(r, "valid"),
                "sizeBytes": num(r, "size_bytes"),
                "scans": num(r, "scans"),
            })
        })
        .collect();

    let fk_rows = rows(
        conn,
        format!(
            "SELECT cl.relname AS tbl, \
                (SELECT string_agg(a.attname, chr(31) ORDER BY u.ord) \
                   FROM unnest(c.conkey) WITH ORDINALITY AS u(att, ord) \
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.att) AS cols \
             FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid \
             JOIN pg_namespace n ON n.oid = cl.relnamespace \
             WHERE c.contype = 'f' AND n.nspname = '{s}'"
        ),
    )
    .await
    .unwrap_or_default();
    let fks: Vec<Value> = fk_rows
        .iter()
        .map(|r| json!({ "table": text(r, "tbl"), "columns": text(r, "cols").split('\u{1f}').collect::<Vec<_>>() }))
        .collect();

    let since = rows(
        conn,
        "SELECT COALESCE(to_char(stats_reset, 'YYYY-MM-DD HH24:MI:SS'), '') AS reset, \
            to_char(pg_postmaster_start_time(), 'YYYY-MM-DD HH24:MI:SS') AS started \
         FROM pg_stat_database WHERE datname = current_database()"
            .to_string(),
    )
    .await
    .ok()
    .and_then(|r| r.into_iter().next());
    let reset = since
        .as_ref()
        .map(|r| text(r, "reset"))
        .filter(|s| !s.is_empty());
    let started = since
        .as_ref()
        .map(|r| text(r, "started"))
        .filter(|s| !s.is_empty());

    Ok(json!({
        "dialect": "postgres",
        "schema": schema,
        "indexes": indexes,
        "foreignKeys": fks,
        "usageAvailable": true,
        "sizesAvailable": true,
        "statsReset": reset,
        "serverStarted": started,
    }))
}

async fn mysql_facts(conn: &DbConnection) -> Result<Value, String> {
    let stat_rows = rows(
        conn,
        "SELECT TABLE_NAME AS tbl, INDEX_NAME AS idx, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq, \
            COALESCE(COLUMN_NAME, '') AS col, COALESCE(SUB_PART, 0) AS sub_part, INDEX_TYPE AS method \
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() \
         ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX"
            .to_string(),
    )
    .await?;
    let mut indexes = group_mysql_statistics(&stat_rows);

    // Usage: the counters `sys.schema_unused_indexes` reads. Off (performance_schema=OFF) or
    // forbidden is "unknown", never "0 scans".
    let usage = rows(
        conn,
        "SELECT OBJECT_NAME AS tbl, INDEX_NAME AS idx, COUNT_STAR AS scans \
         FROM performance_schema.table_io_waits_summary_by_index_usage \
         WHERE OBJECT_SCHEMA = DATABASE() AND INDEX_NAME IS NOT NULL"
            .to_string(),
    )
    .await;
    let usage_available = usage.as_ref().is_ok_and(|r| !r.is_empty());
    if let Ok(u) = &usage {
        let map: BTreeMap<(String, String), i64> = u
            .iter()
            .map(|r| {
                (
                    (text(r, "tbl"), text(r, "idx")),
                    num(r, "scans").unwrap_or(0),
                )
            })
            .collect();
        for ix in indexes.iter_mut() {
            let k = (text(ix, "table"), text(ix, "name"));
            if let Some(n) = map.get(&k) {
                ix["scans"] = json!(n);
            } else if usage_available {
                // A table performance_schema has not seen since start: no I/O through the index.
                ix["scans"] = json!(0);
            }
        }
    }

    let sizes = rows(
        conn,
        "SELECT table_name AS tbl, index_name AS idx, stat_value * @@innodb_page_size AS size_bytes \
         FROM mysql.innodb_index_stats WHERE database_name = DATABASE() AND stat_name = 'size'"
            .to_string(),
    )
    .await;
    let sizes_available = sizes.as_ref().is_ok_and(|r| !r.is_empty());
    if let Ok(sz) = &sizes {
        let mut map: BTreeMap<(String, String), i64> = BTreeMap::new();
        for r in sz {
            let t = text(r, "tbl");
            *map.entry((base_table_name(&t).to_string(), text(r, "idx")))
                .or_default() += num(r, "size_bytes").unwrap_or(0);
        }
        for ix in indexes.iter_mut() {
            if let Some(n) = map.get(&(text(ix, "table"), text(ix, "name"))) {
                ix["sizeBytes"] = json!(n);
            }
        }
    }

    let fk_rows = rows(
        conn,
        "SELECT TABLE_NAME AS tbl, CONSTRAINT_NAME AS name, COLUMN_NAME AS col \
         FROM information_schema.KEY_COLUMN_USAGE \
         WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL \
         ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION"
            .to_string(),
    )
    .await
    .unwrap_or_default();
    let mut fks: Vec<Value> = Vec::new();
    let mut cur: Option<(String, String)> = None;
    for r in &fk_rows {
        let key = (text(r, "tbl"), text(r, "name"));
        if cur.as_ref() != Some(&key) {
            fks.push(json!({ "table": key.0.clone(), "columns": [] }));
            cur = Some(key);
        }
        fks.last_mut().unwrap()["columns"]
            .as_array_mut()
            .unwrap()
            .push(Value::String(text(r, "col")));
    }

    let started = rows(
        conn,
        "SELECT DATE_FORMAT(NOW() - INTERVAL VARIABLE_VALUE SECOND, '%Y-%m-%d %H:%i:%s') AS started \
         FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Uptime'"
            .to_string(),
    )
    .await
    .ok()
    .and_then(|r| r.into_iter().next())
    .map(|r| text(&r, "started"))
    .filter(|s| !s.is_empty());

    Ok(json!({
        "dialect": "mysql",
        "schema": Value::Null,
        "indexes": indexes,
        "foreignKeys": fks,
        "usageAvailable": usage_available,
        "sizesAvailable": sizes_available,
        // MySQL's index counters start with the server; they have no separate reset time.
        "statsReset": Value::Null,
        "serverStarted": started,
    }))
}

async fn sqlite_facts(conn: &DbConnection) -> Result<Value, String> {
    let idx_rows = rows(
        conn,
        "SELECT m.name AS tbl, il.name AS idx, il.\"unique\" AS uniq, il.origin AS origin, il.partial AS partial, \
            ii.seqno AS seq, COALESCE(ii.name, '') AS col \
         FROM sqlite_master m JOIN pragma_index_list(m.name) il JOIN pragma_index_info(il.name) ii \
         WHERE m.type = 'table' ORDER BY m.name, il.name, ii.seqno"
            .to_string(),
    )
    .await?;
    let mut indexes: Vec<Value> = Vec::new();
    let mut cur: Option<(String, String)> = None;
    for r in &idx_rows {
        let key = (text(r, "tbl"), text(r, "idx"));
        if cur.as_ref() != Some(&key) {
            let origin = text(r, "origin");
            indexes.push(json!({
                "table": key.0.clone(),
                "name": key.1.clone(),
                "columns": [],
                "flavors": [],
                "unique": truthy(r, "uniq"),
                "primary": origin == "pk",
                // `u` = created by a UNIQUE constraint: it cannot be dropped as an index.
                "constraint": origin == "u",
                "method": "btree",
                // The predicate itself is not exposed by the pragma; "partial" keeps it from ever
                // comparing equal to a full index.
                "predicate": if truthy(r, "partial") { Value::String("partial".into()) } else { Value::Null },
                "valid": true,
                "sizeBytes": Value::Null,
                "scans": Value::Null,
            }));
            cur = Some(key);
        }
        let col = text(r, "col");
        let col = if col.is_empty() {
            format!("<expression {}#{}>", text(r, "idx"), text(r, "seq"))
        } else {
            col
        };
        let last = indexes.last_mut().unwrap();
        last["columns"]
            .as_array_mut()
            .unwrap()
            .push(Value::String(col));
        last["flavors"]
            .as_array_mut()
            .unwrap()
            .push(Value::String(String::new()));
    }

    let fk_rows = rows(
        conn,
        "SELECT m.name AS tbl, fk.id AS id, fk.\"from\" AS col FROM sqlite_master m \
         JOIN pragma_foreign_key_list(m.name) fk WHERE m.type = 'table' ORDER BY m.name, fk.id, fk.seq"
            .to_string(),
    )
    .await
    .unwrap_or_default();
    let mut fks: Vec<Value> = Vec::new();
    let mut cur: Option<(String, String)> = None;
    for r in &fk_rows {
        let key = (text(r, "tbl"), text(r, "id"));
        if cur.as_ref() != Some(&key) {
            fks.push(json!({ "table": key.0.clone(), "columns": [] }));
            cur = Some(key);
        }
        fks.last_mut().unwrap()["columns"]
            .as_array_mut()
            .unwrap()
            .push(Value::String(text(r, "col")));
    }

    Ok(json!({
        "dialect": "sqlite",
        "schema": Value::Null,
        "indexes": indexes,
        "foreignKeys": fks,
        "usageAvailable": false,
        "sizesAvailable": false,
        "statsReset": Value::Null,
        "serverStarted": Value::Null,
    }))
}

#[tauri::command]
pub async fn get_index_facts(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let (conn, schema) = {
            let ctx = state.connections.acquire(&conn_id)?;
            (
                ctx.conn().clone(),
                pg_schema_of(&ctx.raw_schema().map(str::to_string)),
            )
        };
        match &conn.kind {
            DbKind::Postgres(_) => postgres_facts(&conn, &schema).await,
            DbKind::Mysql(_) => mysql_facts(&conn).await,
            DbKind::Sqlite(_) => sqlite_facts(&conn).await,
            DbKind::DuckDb(_) => Err(crate::database::DUCK_UNSUPPORTED.to_string()),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partition_names_fold_into_their_table() {
        assert_eq!(base_table_name("orders#p#p0"), "orders");
        assert_eq!(base_table_name("orders#P#p1#SP#sp0"), "orders");
        assert_eq!(base_table_name("orders"), "orders");
    }

    #[test]
    fn mysql_statistics_rows_group_into_indexes_in_key_order() {
        let r = |t: &str, i: &str, nu: i64, seq: i64, c: &str, sub: i64| json!({"tbl": t, "idx": i, "non_unique": nu, "seq": seq, "col": c, "sub_part": sub, "method": "BTREE"});
        let out = group_mysql_statistics(&[
            r("customer", "PRIMARY", 0, 1, "customer_id", 0),
            r("customer", "idx_name", 1, 1, "last_name", 0),
            r("customer", "idx_name", 1, 2, "first_name", 10),
            r("customer", "fx", 1, 1, "", 0),
        ]);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0]["primary"], true);
        assert_eq!(out[0]["unique"], true);
        assert_eq!(out[1]["columns"], json!(["last_name", "first_name"]));
        assert_eq!(
            out[1]["flavors"],
            json!(["", "prefix:10"]),
            "a prefix index is not the full column"
        );
        assert_eq!(out[1]["method"], "btree");
        assert!(
            out[2]["columns"][0]
                .as_str()
                .unwrap()
                .starts_with("<expression"),
            "a functional key part never matches a column"
        );
    }

    #[test]
    fn vectors_split_on_whitespace() {
        assert_eq!(vector_items("3124 3124"), vec!["3124", "3124"]);
        assert!(vector_items("").is_empty());
    }
}
