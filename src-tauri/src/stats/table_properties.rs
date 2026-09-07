//! `get_table_properties` — everything the Properties tab shows about ONE table, in one call.
//!
//! Two things shape this file. First, it reads through `execute_raw_sql_generic` rather than the
//! driver rows: that funnel already routes to the pinned connection when a manual transaction is
//! open, which is the only way a **session-temporary** table is visible at all (a pooled connection
//! has its own, empty, temp namespace). Second, every secondary lookup is `.ok()`-tolerant — a
//! missing `sqlite_sequence`, a `dbstat` the build was compiled without, a `pg_stat_all_tables` row
//! that does not exist yet — because one absent extra must not blank the whole panel.
//!
//! The Postgres DDL is rebuilt here instead of calling `get_table_definition`: that command
//! qualifies with the connection's schema, so it cannot see a table living in `pg_temp_N`, and the
//! columns it would query are the ones this command has already fetched.

use serde_json::{Value, json};

use crate::database::{
    DbConnection, DbKind, execute_raw_sql_generic, pg_schema_of, rows_of, sql_str,
};

/// A cell as text. Numbers are accepted too — MySQL's `AUTO_INCREMENT` and Postgres timestamps come
/// back as one or the other depending on the driver's decode, and both read the same to the user.
fn text(row: &Value, key: &str) -> Option<String> {
    match row.get(key) {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::Bool(b)) => Some(b.to_string()),
        _ => None,
    }
}

/// A cell as an integer. `DECIMAL`/`bigint` arrive as strings often enough that both have to be
/// accepted, and `reltuples` is a float that has to be truncated rather than dropped.
fn num(row: &Value, key: &str) -> Option<i64> {
    match row.get(key)? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s
            .parse::<i64>()
            .ok()
            .or_else(|| s.parse::<f64>().ok().map(|f| f as i64)),
        _ => None,
    }
}

fn jnum(v: Option<i64>) -> Value {
    v.map(Value::from).unwrap_or(Value::Null)
}

fn jtext(v: Option<String>) -> Value {
    v.map(Value::from).unwrap_or(Value::Null)
}

/// One row of a read that is allowed to fail — a PRAGMA the build does not carry, a catalog view an
/// old server does not have. A failure and an empty result are the same answer here: "unknown".
async fn one_row(conn: &DbConnection, sql: String) -> Option<Value> {
    let res = execute_raw_sql_generic(conn, sql).await.ok()?;
    rows_of(&res).into_iter().next()
}

/// The named cell of the first row of a tolerant read, as an integer.
async fn one_num(conn: &DbConnection, sql: String, key: &str) -> Option<i64> {
    num(&one_row(conn, sql).await?, key)
}

/// Every value of one column, in order — primary-key column names, mostly.
async fn column_of(conn: &DbConnection, sql: String, key: &str) -> Vec<String> {
    match execute_raw_sql_generic(conn, sql).await {
        Ok(res) => rows_of(&res).iter().filter_map(|r| text(r, key)).collect(),
        Err(_) => Vec::new(),
    }
}

/// `SHOW INDEX` column names, in both spellings. MySQL titlecases them and MariaDB has been seen
/// upcasing them, and the same row is read from three places — hence a function rather than a
/// closure, which would also have to be re-annotated at each use to stay higher-ranked.
fn show_index_key(row: &Value) -> Option<String> {
    text(row, "Key_name").or_else(|| text(row, "KEY_NAME"))
}

fn show_index_column(row: &Value) -> Option<String> {
    text(row, "Column_name").or_else(|| text(row, "COLUMN_NAME"))
}

/// The charset half of a MySQL collation (`utf8mb4_0900_ai_ci` -> `utf8mb4`).
fn charset_of(collation: &str) -> Option<String> {
    collation
        .split('_')
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[tauri::command]
pub async fn get_table_properties(
    conn_id: String,
    table_name: String,
    // The schema to read from, overriding the connection's current one. Only the Temporary section
    // sends it, and only on Postgres, where a session-temporary table lives in `pg_temp_N` — the
    // sidebar already knows which one, so the lookup does not have to guess.
    schema: Option<String>,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let (conn, dialect, ctx_schema) = {
            let ctx = state.connections.acquire(&conn_id)?;
            let c = ctx.conn().clone();
            let s = match schema.as_deref() {
                Some(s) if !s.is_empty() => Some(s.to_string()),
                _ => ctx.raw_schema().map(str::to_string),
            };
            (c, ctx.dialect().to_string(), s)
        };

        match &conn.kind {
            DbKind::Sqlite(_) => sqlite_properties(&conn, &dialect, &table_name).await,
            DbKind::Mysql(_) => mysql_properties(&conn, &dialect, &table_name).await,
            DbKind::Postgres(_) => {
                postgres_properties(&conn, &dialect, &table_name, &ctx_schema).await
            }
        }
    })
    .await
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

async fn sqlite_properties(
    conn: &DbConnection,
    dialect: &str,
    table: &str,
) -> Result<Value, String> {
    let lit = sql_str(table);
    let ident = table.replace('"', "\"\"");

    // The temp catalogue is asked FIRST, the same order SQLite itself resolves a bare name in: a
    // temp table shadows a permanent one of the same name, so reporting the permanent one's
    // properties next to the temp one's rows would be a quiet lie.
    let mut found: Option<(String, Option<String>, bool)> = None;
    for (master, is_temp) in [("sqlite_temp_master", true), ("sqlite_master", false)] {
        let sql = format!(
            "SELECT type, sql FROM {master} WHERE name = '{lit}' AND type IN ('table','view') LIMIT 1"
        );
        if let Some(row) = one_row(conn, sql).await {
            found = Some((
                text(&row, "type").unwrap_or_else(|| "table".to_string()),
                text(&row, "sql").map(|s| format!("{};", s.trim().trim_end_matches(';'))),
                is_temp,
            ));
            break;
        }
    }
    let (obj_type, ddl, is_temp) =
        found.ok_or_else(|| "Không tìm thấy định nghĩa bảng".to_string())?;
    let is_view = obj_type.eq_ignore_ascii_case("view");

    let cols = execute_raw_sql_generic(conn, format!("PRAGMA table_info(\"{ident}\")"))
        .await
        .map(|r| rows_of(&r))
        .unwrap_or_default();
    let column_count = cols.len() as i64;
    let mut pks: Vec<(i64, String)> = cols
        .iter()
        .filter_map(|r| {
            let pk = num(r, "pk").unwrap_or(0);
            (pk > 0).then(|| (pk, text(r, "name").unwrap_or_default()))
        })
        .collect();
    pks.sort_by_key(|(order, _)| *order);
    let primary_keys: Vec<String> = pks.into_iter().map(|(_, n)| n).collect();

    let index_rows = execute_raw_sql_generic(conn, format!("PRAGMA index_list(\"{ident}\")"))
        .await
        .map(|r| rows_of(&r))
        .unwrap_or_default();
    let index_count = index_rows.len() as i64;
    let fk_count = execute_raw_sql_generic(conn, format!("PRAGMA foreign_key_list(\"{ident}\")"))
        .await
        .map(|r| rows_of(&r).len() as i64)
        .unwrap_or(0);

    // SQLite has no planner estimate to read, so the "estimate" IS the exact count. `rowsExact`
    // says so, and the panel then hides the "count for real" button rather than offering one that
    // recomputes the number already on screen.
    let rows = one_num(conn, format!("SELECT COUNT(*) AS n FROM \"{ident}\""), "n").await;

    // dbstat is a compile-time option (SQLITE_ENABLE_DBSTAT_VTAB). When it is missing this whole
    // block yields None and the size card shows "-", which is honest: there is no other way to ask
    // SQLite how many bytes one table occupies.
    let data_size = one_num(
        conn,
        format!("SELECT SUM(pgsize) AS n FROM dbstat WHERE name = '{lit}'"),
        "n",
    )
    .await;
    let mut index_size: Option<i64> = None;
    for r in &index_rows {
        if let Some(idx) = text(r, "name") {
            let n = one_num(
                conn,
                format!(
                    "SELECT SUM(pgsize) AS n FROM dbstat WHERE name = '{}'",
                    sql_str(&idx)
                ),
                "n",
            )
            .await;
            if let Some(n) = n {
                index_size = Some(index_size.unwrap_or(0) + n);
            }
        }
    }
    let total_size = match (data_size, index_size) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
    };

    let auto_increment = one_num(
        conn,
        format!("SELECT seq AS n FROM sqlite_sequence WHERE name = '{lit}'"),
        "n",
    )
    .await;

    // `pragma_database_list` is the table-valued form of `PRAGMA database_list`; `main` is the file
    // the connection was opened on, and a temp table's pages live in `temp` — usually in memory,
    // which is why that row's `file` is empty.
    let file_path = one_row(
        conn,
        format!(
            "SELECT file FROM pragma_database_list WHERE name = '{}'",
            if is_temp { "temp" } else { "main" }
        ),
    )
    .await
    .and_then(|r| text(&r, "file"));

    let table_type = match (is_view, is_temp) {
        (true, true) => "TEMPORARY VIEW",
        (true, false) => "VIEW",
        (false, true) => "TEMPORARY TABLE",
        (false, false) => "BASE TABLE",
    };

    Ok(json!({
        "tableName": table,
        "schemaName": if is_temp { "temp" } else { "main" },
        "dbType": dialect,
        "tableType": table_type,
        "isTemporary": is_temp,
        "isView": is_view,
        "engine": "SQLite",
        "rowFormat": Value::Null,
        "collation": Value::Null,
        "characterSet": Value::Null,
        "comment": Value::Null,
        "tablespace": Value::Null,
        "createOptions": Value::Null,
        "filePath": jtext(file_path),
        "estimatedRows": rows.unwrap_or(0),
        "rowsExact": true,
        "dataSizeBytes": jnum(data_size),
        "indexSizeBytes": jnum(index_size),
        "totalSizeBytes": jnum(total_size),
        "freeSizeBytes": Value::Null,
        "avgRowLengthBytes": Value::Null,
        "autoIncrement": jnum(auto_increment),
        "createTime": Value::Null,
        "updateTime": Value::Null,
        "checkTime": Value::Null,
        "columnCount": column_count,
        "primaryKeys": primary_keys,
        "indexCount": index_count,
        "foreignKeyCount": fk_count,
        "referencedByCount": Value::Null,
        "liveTuples": Value::Null,
        "deadTuples": Value::Null,
        "seqScans": Value::Null,
        "indexScans": Value::Null,
        "lastVacuum": Value::Null,
        "lastAnalyze": Value::Null,
        "ddl": jtext(ddl),
    }))
}

// ---------------------------------------------------------------------------
// MySQL / MariaDB
// ---------------------------------------------------------------------------

async fn mysql_properties(
    conn: &DbConnection,
    dialect: &str,
    table: &str,
) -> Result<Value, String> {
    let lit = sql_str(table);
    let ident = table.replace('`', "``");

    let meta = one_row(
        conn,
        format!(
            "SELECT TABLE_TYPE, ENGINE, ROW_FORMAT, TABLE_ROWS, AVG_ROW_LENGTH, DATA_LENGTH, \
                    INDEX_LENGTH, DATA_FREE, AUTO_INCREMENT, CREATE_TIME, UPDATE_TIME, CHECK_TIME, \
                    TABLE_COLLATION, TABLE_COMMENT, CREATE_OPTIONS, TABLE_SCHEMA \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{lit}' LIMIT 1"
        ),
    )
    .await;

    // `SHOW CREATE TABLE` is the one lookup that also answers for a session-temporary table, which
    // `information_schema.TABLES` never lists. It therefore decides whether the name exists at all,
    // and the branches below fill the rest from `SHOW …` when the data dictionary stays blank.
    let ddl_row = one_row(conn, format!("SHOW CREATE TABLE `{ident}`")).await;
    // Either witness is enough: `SHOW CREATE VIEW` names its column `Create View`, and if that call
    // failed for any reason the data dictionary still says what the object is.
    let is_view = ddl_row
        .as_ref()
        .is_some_and(|r| r.get("Create View").is_some())
        || meta
            .as_ref()
            .and_then(|m| text(m, "TABLE_TYPE"))
            .is_some_and(|ty| ty.eq_ignore_ascii_case("VIEW"));
    let ddl = ddl_row.as_ref().and_then(|r| {
        text(r, "Create Table")
            .or_else(|| text(r, "Create View"))
            .map(|s| format!("{};", s.trim().trim_end_matches(';')))
    });
    if meta.is_none() && ddl.is_none() {
        return Err("Không tìm thấy định nghĩa bảng".to_string());
    }
    let is_temp = meta.is_none();

    let show_index = if is_temp {
        execute_raw_sql_generic(conn, format!("SHOW INDEX FROM `{ident}`"))
            .await
            .map(|r| rows_of(&r))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let (column_count, index_count, primary_keys) = if is_temp {
        let mut names: Vec<String> = show_index.iter().filter_map(show_index_key).collect();
        names.sort();
        names.dedup();
        (
            execute_raw_sql_generic(conn, format!("SHOW COLUMNS FROM `{ident}`"))
                .await
                .map(|r| rows_of(&r).len() as i64)
                .unwrap_or(0),
            names.len() as i64,
            show_index
                .iter()
                .filter_map(|r| {
                    (show_index_key(r).as_deref() == Some("PRIMARY"))
                        .then(|| show_index_column(r))
                        .flatten()
                })
                .collect::<Vec<String>>(),
        )
    } else {
        (
            one_num(
                conn,
                format!(
                    "SELECT COUNT(*) AS n FROM information_schema.COLUMNS \
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{lit}'"
                ),
                "n",
            )
            .await
            .unwrap_or(0),
            one_num(
                conn,
                format!(
                    "SELECT COUNT(DISTINCT INDEX_NAME) AS n FROM information_schema.STATISTICS \
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{lit}'"
                ),
                "n",
            )
            .await
            .unwrap_or(0),
            column_of(
                conn,
                format!(
                    "SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE \
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{lit}' \
                       AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION"
                ),
                "name",
            )
            .await,
        )
    };

    let fk_count = one_num(
        conn,
        format!(
            "SELECT COUNT(DISTINCT CONSTRAINT_NAME) AS n FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{lit}' \
               AND REFERENCED_TABLE_NAME IS NOT NULL"
        ),
        "n",
    )
    .await
    .unwrap_or(0);
    let referenced_by = one_num(
        conn,
        format!(
            "SELECT COUNT(*) AS n FROM (SELECT DISTINCT CONSTRAINT_NAME, TABLE_NAME \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = '{lit}') k"
        ),
        "n",
    )
    .await;

    let meta = meta.unwrap_or(Value::Null);
    let collation = text(&meta, "TABLE_COLLATION");
    let charset = collation.as_deref().and_then(charset_of);
    let data_len = num(&meta, "DATA_LENGTH");
    let index_len = num(&meta, "INDEX_LENGTH");
    let total = match (data_len, index_len) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
    };
    // TABLE_ROWS is InnoDB's sampled estimate and is NULL for a view; a temp table has no row at
    // all in the data dictionary, so it is counted for real — it is per-session, i.e. small.
    let est_rows = if is_temp && !is_view {
        one_num(conn, format!("SELECT COUNT(*) AS n FROM `{ident}`"), "n").await
    } else {
        num(&meta, "TABLE_ROWS")
    };

    let table_type = if is_temp {
        "TEMPORARY TABLE".to_string()
    } else {
        text(&meta, "TABLE_TYPE").unwrap_or_else(|| "BASE TABLE".to_string())
    };

    Ok(json!({
        "tableName": table,
        "schemaName": jtext(text(&meta, "TABLE_SCHEMA")),
        "dbType": dialect,
        "tableType": table_type,
        "isTemporary": is_temp,
        "isView": is_view,
        "engine": jtext(text(&meta, "ENGINE")),
        "rowFormat": jtext(text(&meta, "ROW_FORMAT")),
        "collation": jtext(collation),
        "characterSet": jtext(charset),
        "comment": jtext(text(&meta, "TABLE_COMMENT")),
        // MySQL's data dictionary has no per-table tablespace worth showing (the InnoDB one lives in
        // `INNODB_TABLES`), and CREATE_OPTIONS is a different thing — `partitioned`,
        // `row_format=DYNAMIC` — so it gets its own field rather than being filed under a name it
        // does not answer to.
        "tablespace": Value::Null,
        "createOptions": jtext(text(&meta, "CREATE_OPTIONS")),
        "filePath": Value::Null,
        "estimatedRows": est_rows.unwrap_or(0),
        // Only the temp branch counted for real. InnoDB's TABLE_ROWS can be off by orders of
        // magnitude, which is exactly what the "count for real" button is there for.
        "rowsExact": is_temp && !is_view,
        "dataSizeBytes": jnum(data_len),
        "indexSizeBytes": jnum(index_len),
        "totalSizeBytes": jnum(total),
        "freeSizeBytes": jnum(num(&meta, "DATA_FREE")),
        "avgRowLengthBytes": jnum(num(&meta, "AVG_ROW_LENGTH")),
        "autoIncrement": jnum(num(&meta, "AUTO_INCREMENT")),
        "createTime": jtext(text(&meta, "CREATE_TIME")),
        "updateTime": jtext(text(&meta, "UPDATE_TIME")),
        "checkTime": jtext(text(&meta, "CHECK_TIME")),
        "columnCount": column_count,
        "primaryKeys": primary_keys,
        "indexCount": index_count,
        "foreignKeyCount": fk_count,
        "referencedByCount": jnum(referenced_by),
        "liveTuples": Value::Null,
        "deadTuples": Value::Null,
        "seqScans": Value::Null,
        "indexScans": Value::Null,
        "lastVacuum": Value::Null,
        "lastAnalyze": Value::Null,
        "ddl": jtext(ddl),
    }))
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

/// `relkind` -> the words the panel shows. `relpersistence` carries the temporary/unlogged prefix,
/// because a temp table's relkind is a plain `'r'` like any other.
fn pg_table_type(relkind: &str, persistence: &str) -> String {
    let base = match relkind {
        "v" => "VIEW",
        "m" => "MATERIALIZED VIEW",
        "p" => "PARTITIONED TABLE",
        "f" => "FOREIGN TABLE",
        "t" => "TOAST TABLE",
        _ => "BASE TABLE",
    };
    let storable = relkind == "r" || relkind == "p";
    match persistence {
        "t" if storable => "TEMPORARY TABLE".to_string(),
        "u" if storable => "UNLOGGED TABLE".to_string(),
        _ => base.to_string(),
    }
}

async fn postgres_properties(
    conn: &DbConnection,
    dialect: &str,
    table: &str,
    schema: &Option<String>,
) -> Result<Value, String> {
    let lit = sql_str(table);
    let sch = sql_str(&pg_schema_of(schema));

    // `pg_my_temp_schema()` — this session's own temp namespace, never another session's. The
    // catalogue shows every session's temp relations, so matching `nspname LIKE 'pg_temp%'` would
    // happily report a table this connection cannot read a single row from. The ORDER BY makes the
    // temp one win a name clash, which is the order Postgres' own search_path resolves in.
    // The size functions are guarded by relkind: a plain view has no storage to measure.
    let meta_sql = format!(
        "SELECT c.oid::bigint AS oid, \
                n.nspname::text AS schema_name, \
                c.relkind::text AS relkind, \
                c.relpersistence::text AS persistence, \
                (n.oid = pg_my_temp_schema()) AS is_temp, \
                GREATEST(c.reltuples, 0)::bigint AS est_rows, \
                CASE WHEN c.relkind IN ('r','m','p','t') THEN pg_total_relation_size(c.oid) END::bigint AS total_size, \
                CASE WHEN c.relkind IN ('r','m','p','t') THEN pg_relation_size(c.oid) END::bigint AS data_size, \
                CASE WHEN c.relkind IN ('r','m','p','t') THEN pg_indexes_size(c.oid) END::bigint AS index_size, \
                COALESCE(t.spcname, 'pg_default')::text AS tablespace, \
                obj_description(c.oid, 'pg_class')::text AS comment, \
                am.amname::text AS engine, \
                (SELECT d.datcollate FROM pg_database d WHERE d.datname = current_database())::text AS collation, \
                (SELECT pg_encoding_to_char(d.encoding) FROM pg_database d WHERE d.datname = current_database())::text AS charset \
         FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_tablespace t ON t.oid = c.reltablespace \
         LEFT JOIN pg_am am ON am.oid = c.relam \
         WHERE c.relname = '{lit}' AND (n.nspname = '{sch}' OR n.oid = pg_my_temp_schema()) \
         ORDER BY (n.oid = pg_my_temp_schema()) DESC \
         LIMIT 1"
    );
    let meta = one_row(conn, meta_sql)
        .await
        .ok_or_else(|| "Không tìm thấy định nghĩa bảng".to_string())?;
    let oid = num(&meta, "oid").ok_or_else(|| "Không tìm thấy định nghĩa bảng".to_string())?;
    let relkind = text(&meta, "relkind").unwrap_or_else(|| "r".to_string());
    let persistence = text(&meta, "persistence").unwrap_or_else(|| "p".to_string());
    // A boolean crosses `execute_raw_sql_generic` as a JSON bool, but `text()` also accepts the
    // `t`/`true` spellings a driver may hand back as a string, so both readings are covered.
    let is_temp = text(&meta, "is_temp").is_some_and(|s| s == "true" || s == "t");
    let is_view = relkind == "v" || relkind == "m";

    let cols = execute_raw_sql_generic(
        conn,
        format!(
            "SELECT a.attname::text AS column_name, \
                    format_type(a.atttypid, a.atttypmod) AS data_type, \
                    CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable, \
                    pg_get_expr(d.adbin, d.adrelid) AS column_default \
             FROM pg_attribute a \
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             WHERE a.attrelid = {oid} AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum"
        ),
    )
    .await
    .map(|r| rows_of(&r))
    .unwrap_or_default();

    // Ordered by attnum, not by position within the key: this feeds a row of badges, and a
    // composite key's declaration order is carried by the DDL card right below it.
    let primary_keys = column_of(
        conn,
        format!(
            "SELECT a.attname::text AS name FROM pg_index i \
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \
             WHERE i.indrelid = {oid} AND i.indisprimary ORDER BY a.attnum"
        ),
        "name",
    )
    .await;

    let counts = one_row(
        conn,
        format!(
            "SELECT (SELECT COUNT(*) FROM pg_index WHERE indrelid = {oid})::bigint AS idx, \
                    (SELECT COUNT(*) FROM pg_constraint WHERE conrelid = {oid} AND contype = 'f')::bigint AS fk_out, \
                    (SELECT COUNT(*) FROM pg_constraint WHERE confrelid = {oid} AND contype = 'f')::bigint AS fk_in"
        ),
    )
    .await
    .unwrap_or(Value::Null);

    let stats = one_row(
        conn,
        format!(
            "SELECT n_live_tup::bigint AS live, n_dead_tup::bigint AS dead, \
                    seq_scan::bigint AS seq_scan, idx_scan::bigint AS idx_scan, \
                    GREATEST(COALESCE(last_vacuum, '-infinity'), COALESCE(last_autovacuum, '-infinity'))::text AS vacuumed, \
                    GREATEST(COALESCE(last_analyze, '-infinity'), COALESCE(last_autoanalyze, '-infinity'))::text AS analyzed \
             FROM pg_stat_all_tables WHERE relid = {oid}"
        ),
    )
    .await
    .unwrap_or(Value::Null);
    // `-infinity` is the sentinel the GREATEST above folds two never-ran columns into; rendering it
    // as a date would be worse than rendering nothing.
    let never = |s: Option<String>| s.filter(|v| !v.starts_with("-infinity"));

    // The sequence behind a `serial`/`IDENTITY` column, if there is one. Tolerated failure: a
    // server older than 10 has no `pg_sequences`, and then no next value is reported.
    let auto_increment = one_num(
        conn,
        format!(
            "SELECT (SELECT s.last_value FROM pg_sequences s \
                     WHERE s.schemaname = sn.nspname AND s.sequencename = sc.relname) AS n \
             FROM pg_depend d \
             JOIN pg_class sc ON sc.oid = d.objid AND sc.relkind = 'S' \
             JOIN pg_namespace sn ON sn.oid = sc.relnamespace \
             WHERE d.refobjid = {oid} AND d.deptype IN ('a','i') LIMIT 1"
        ),
        "n",
    )
    .await;

    let ddl = if is_view {
        one_row(
            conn,
            format!("SELECT pg_get_viewdef({oid}::oid, true) AS def"),
        )
        .await
        .and_then(|r| text(&r, "def"))
        .map(|body| {
            let kw = if relkind == "m" {
                "MATERIALIZED VIEW"
            } else {
                "VIEW"
            };
            format!(
                "CREATE {kw} \"{}\" AS\n{};",
                table.replace('"', "\"\""),
                body.trim().trim_end_matches(';')
            )
        })
    } else {
        // Rebuilt from the columns already fetched above — Postgres has no SHOW CREATE TABLE, and
        // `get_table_definition` cannot be reused because it looks the table up by the connection's
        // schema and so never finds one in `pg_temp_N`.
        let mut defs: Vec<String> = cols
            .iter()
            .map(|r| {
                let mut def = format!(
                    "  \"{}\" {}",
                    text(r, "column_name")
                        .unwrap_or_default()
                        .replace('"', "\"\""),
                    text(r, "data_type").unwrap_or_else(|| "text".to_string())
                );
                if text(r, "is_nullable").as_deref() == Some("NO") {
                    def.push_str(" NOT NULL");
                }
                if let Some(d) = text(r, "column_default") {
                    def.push_str(&format!(" DEFAULT {d}"));
                }
                def
            })
            .collect();
        if !primary_keys.is_empty() {
            defs.push(format!(
                "  PRIMARY KEY ({})",
                primary_keys
                    .iter()
                    .map(|c| format!("\"{}\"", c.replace('"', "\"\"")))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        let kw = if is_temp {
            "CREATE TEMPORARY TABLE"
        } else {
            "CREATE TABLE"
        };
        Some(format!(
            "{kw} \"{}\" (\n{}\n);",
            table.replace('"', "\"\""),
            defs.join(",\n")
        ))
    };

    let data_size = num(&meta, "data_size");
    let index_size = num(&meta, "index_size");
    let total_size = num(&meta, "total_size");
    let est_rows = num(&meta, "est_rows").unwrap_or(0);
    // What is left after the main fork and the indexes is TOAST plus the free-space and visibility
    // maps — the closest Postgres equivalent of MySQL's DATA_FREE overhead figure.
    let overhead = match (total_size, data_size, index_size) {
        (Some(t), Some(d), Some(i)) => Some((t - d - i).max(0)),
        _ => None,
    };

    Ok(json!({
        "tableName": table,
        "schemaName": jtext(text(&meta, "schema_name")),
        "dbType": dialect,
        "tableType": pg_table_type(&relkind, &persistence),
        "isTemporary": is_temp,
        "isView": is_view,
        "engine": jtext(text(&meta, "engine")),
        "rowFormat": Value::Null,
        "collation": jtext(text(&meta, "collation")),
        "characterSet": jtext(text(&meta, "charset")),
        "comment": jtext(text(&meta, "comment")),
        "tablespace": jtext(text(&meta, "tablespace")),
        "createOptions": Value::Null,
        "filePath": Value::Null,
        "estimatedRows": est_rows,
        // reltuples is -1 until the table is analysed for the first time, and GREATEST clamps that
        // to 0 — "0 rows" in a never-analysed table is a guess, not a fact.
        "rowsExact": false,
        "dataSizeBytes": jnum(data_size),
        "indexSizeBytes": jnum(index_size),
        "totalSizeBytes": jnum(total_size),
        "freeSizeBytes": jnum(overhead),
        "avgRowLengthBytes": jnum(match (data_size, est_rows) {
            (Some(d), r) if r > 0 => Some(d / r),
            _ => None,
        }),
        "autoIncrement": jnum(auto_increment),
        "createTime": Value::Null,
        "updateTime": Value::Null,
        "checkTime": Value::Null,
        "columnCount": cols.len() as i64,
        "primaryKeys": primary_keys,
        "indexCount": jnum(num(&counts, "idx")),
        "foreignKeyCount": jnum(num(&counts, "fk_out")),
        "referencedByCount": jnum(num(&counts, "fk_in")),
        "liveTuples": jnum(num(&stats, "live")),
        "deadTuples": jnum(num(&stats, "dead")),
        "seqScans": jnum(num(&stats, "seq_scan")),
        "indexScans": jnum(num(&stats, "idx_scan")),
        "lastVacuum": jtext(never(text(&stats, "vacuumed"))),
        "lastAnalyze": jtext(never(text(&stats, "analyzed"))),
        "ddl": jtext(ddl),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_numbers_however_the_driver_spelled_them() {
        let row = json!({ "a": 12, "b": "34", "c": 5.9, "d": "6.7", "e": null, "f": "x" });
        assert_eq!(num(&row, "a"), Some(12));
        assert_eq!(num(&row, "b"), Some(34));
        assert_eq!(num(&row, "c"), Some(5));
        assert_eq!(num(&row, "d"), Some(6));
        assert_eq!(num(&row, "e"), None);
        assert_eq!(num(&row, "f"), None);
        assert_eq!(num(&row, "missing"), None);
    }

    #[test]
    fn blank_text_reads_as_absent() {
        // MySQL returns '' for TABLE_COMMENT on a table without one, and the panel must show that
        // row as "-" rather than as an empty comment.
        let row = json!({ "a": "hi", "b": "", "c": "   ", "d": 7, "e": null });
        assert_eq!(text(&row, "a").as_deref(), Some("hi"));
        assert_eq!(text(&row, "b"), None);
        assert_eq!(text(&row, "c"), None);
        assert_eq!(text(&row, "d").as_deref(), Some("7"));
        assert_eq!(text(&row, "e"), None);
    }

    #[test]
    fn charset_is_the_head_of_the_collation() {
        assert_eq!(charset_of("utf8mb4_0900_ai_ci").as_deref(), Some("utf8mb4"));
        assert_eq!(charset_of("latin1_swedish_ci").as_deref(), Some("latin1"));
        assert_eq!(charset_of(""), None);
    }

    #[test]
    fn pg_type_names_carry_the_persistence() {
        assert_eq!(pg_table_type("r", "p"), "BASE TABLE");
        assert_eq!(pg_table_type("r", "t"), "TEMPORARY TABLE");
        assert_eq!(pg_table_type("r", "u"), "UNLOGGED TABLE");
        assert_eq!(pg_table_type("v", "p"), "VIEW");
        assert_eq!(pg_table_type("m", "p"), "MATERIALIZED VIEW");
        assert_eq!(pg_table_type("p", "t"), "TEMPORARY TABLE");
        // A view is never unlogged; the prefix must not leak onto one.
        assert_eq!(pg_table_type("v", "u"), "VIEW");
    }
}
