//! Table-level DDL: create / drop / empty / rename, and reading a table's DDL back.

use serde_json::{Value, json};
use sqlx::Row;

use crate::database::{
    DbConnection, DbKind, Exec, all_string_values, execute_raw_sql_generic, fk_checks_sql,
    pg_schema_of, qualified, quote_ident, reject_conn_read_only, sql_str,
};

use super::table_alter::generate_alter_sqls;
use crate::database::introspect::get_primary_key_columns;

#[tauri::command]
pub async fn create_table(conn_id: String, payload: Value) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let (conn_type, schema) = {
            let ctx = state.connections.acquire(&conn_id)?;
            let ct = ctx.conn().clone();
            (ct, ctx.raw_schema().map(str::to_string))
        };

        let table_name = payload
            .get("tableName")
            .and_then(|v| v.as_str())
            .ok_or("Thiếu tên bảng")?;

        let db_type = match &conn_type.kind {
            DbKind::Sqlite(_) => "sqlite",
            DbKind::Postgres(_) => "postgres",
            DbKind::Mysql(_) => "mysql",
        };
        let q = if db_type == "mysql" { '`' } else { '"' };
        // Without qualifying it the new table lands in the first schema of search_path, not the selected schema.
        let table_ref = qualified(&conn_type, &schema, table_name);

        let columns = payload.get("columns").and_then(|v| v.as_array());

        // When no columns are passed -> keep the old behaviour: create a minimal table with one id primary-key column
        let create_sql = match columns {
            Some(cols) if !cols.is_empty() => {
                // The list of primary-key columns
                let pk_cols: Vec<String> = cols
                    .iter()
                    .filter(|c| {
                        c.get("isPrimaryKey")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                    })
                    .filter_map(|c| {
                        c.get("name")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    })
                    .collect();
                // Special case: exactly 1 primary key with auto-increment -> use the auto-increment syntax right on that column
                let single_auto_pk = pk_cols.len() == 1
                    && cols.iter().any(|c| {
                        c.get("isPrimaryKey")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                            && c.get("autoIncrement")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false)
                    });

                let mut defs: Vec<String> = Vec::new();
                for col in cols {
                    let name = match col
                        .get("name")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.trim().is_empty())
                    {
                        Some(n) => n,
                        None => continue,
                    };
                    let col_type = col.get("type").and_then(|v| v.as_str()).unwrap_or("TEXT");
                    let is_pk = col
                        .get("isPrimaryKey")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let nullable = col
                        .get("nullable")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true);
                    let default_val = col
                        .get("defaultValue")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.trim().is_empty());

                    if single_auto_pk && is_pk {
                        // An auto-incrementing primary-key column: the syntax differs per dialect
                        let def = match db_type {
                            "mysql" => format!(
                                "{q}{name}{q} {ty} NOT NULL AUTO_INCREMENT PRIMARY KEY",
                                q = q,
                                name = name,
                                ty = col_type
                            ),
                            "postgres" => {
                                format!("{q}{name}{q} SERIAL PRIMARY KEY", q = q, name = name)
                            }
                            _ => format!(
                                "{q}{name}{q} INTEGER PRIMARY KEY AUTOINCREMENT",
                                q = q,
                                name = name
                            ),
                        };
                        defs.push(def);
                        continue;
                    }

                    let mut def = format!("{q}{name}{q} {ty}", q = q, name = name, ty = col_type);
                    if !nullable {
                        def.push_str(" NOT NULL");
                    }
                    if let Some(d) = default_val {
                        if d.eq_ignore_ascii_case("CURRENT_TIMESTAMP")
                            || d == "0"
                            || d.eq_ignore_ascii_case("true")
                            || d.eq_ignore_ascii_case("false")
                            || d == "''"
                        {
                            def.push_str(&format!(" DEFAULT {}", d));
                        } else {
                            def.push_str(&format!(" DEFAULT '{}'", d.replace('\'', "''")));
                        }
                    }
                    defs.push(def);
                }

                // With several primary keys (or a non-auto-increment primary key) -> add a table-level PRIMARY KEY constraint
                if !single_auto_pk && !pk_cols.is_empty() {
                    let pk_list = pk_cols
                        .iter()
                        .map(|c| format!("{q}{c}{q}", q = q, c = c))
                        .collect::<Vec<_>>()
                        .join(", ");
                    defs.push(format!("PRIMARY KEY ({})", pk_list));
                }

                format!(
                    "CREATE TABLE {name} ({defs})",
                    name = table_ref,
                    defs = defs.join(", ")
                )
            }
            _ => match &conn_type.kind {
                DbKind::Mysql(_) => format!(
                    "CREATE TABLE {} (id INT AUTO_INCREMENT PRIMARY KEY)",
                    table_ref
                ),
                _ => format!("CREATE TABLE {} (id INTEGER PRIMARY KEY)", table_ref),
            },
        };

        execute_raw_sql_generic(&conn_type, create_sql).await?;

        // After creating the table, create the Indexes & Foreign Keys too (when present) — reusing the SQL builder fixed in generate_alter_sqls
        let extra_payload = json!({
            "addedIndexes": payload.get("indexes").cloned().unwrap_or(json!([])),
            "addedFKs": payload.get("foreignKeys").cloned().unwrap_or(json!([])),
        });
        let extra_sqls = generate_alter_sqls(table_name, &extra_payload, db_type, &schema);
        for sql in extra_sqls {
            execute_raw_sql_generic(&conn_type, sql).await?;
        }

        Ok(json!({ "success": true }))
    })
    .await
}

/// Runs a short sequence on ONE connection, optionally with foreign-key checks turned off around it.
///
/// Two requirements, and the pool satisfies neither on its own:
///  - **One connection**, or `SET FOREIGN_KEY_CHECKS` lands on a different session than the
///    statement it is meant to wrap and quietly does nothing.
///  - **The pinned session when the user is in manual-commit mode.** Taking a fresh connection
///    there would run the DROP/TRUNCATE outside their transaction and commit it — "manual commit"
///    that commits by itself. Note this is `use_session()`, not `is_open()`: the transaction does
///    not exist until its first statement, and this may well be that statement.
///
/// `optional` runs only if the main statement succeeded and its own failure is ignored.
async fn run_fk_wrapped(
    conn: &DbConnection,
    disable_fk: bool,
    sql: String,
    optional: Option<String>,
) -> Result<(), String> {
    // Before the FK-disable statement, not after: refusing halfway would leave the session with
    // foreign-key checks off on a connection we just declared untouchable.
    reject_conn_read_only(conn)?;
    if crate::tx::use_session(conn) {
        // execute_raw_sql_generic routes to the pinned session, so all of these share one
        // connection exactly like the `Exec` branch below.
        if disable_fk {
            let _ = execute_raw_sql_generic(conn, fk_checks_sql(conn, false).to_string()).await;
        }
        let result = execute_raw_sql_generic(conn, sql).await;
        if result.is_ok()
            && let Some(extra) = optional
        {
            let _ = execute_raw_sql_generic(conn, extra).await;
        }
        // Restore even on failure: the session lives on and later statements must not inherit a
        // disabled foreign-key check.
        if disable_fk {
            let _ = execute_raw_sql_generic(conn, fk_checks_sql(conn, true).to_string()).await;
        }
        return result.map(|_| ());
    }

    let mut exec = Exec::acquire(conn).await?;
    if disable_fk {
        exec.try_run(fk_checks_sql(conn, false)).await;
    }
    let result = exec.run(sql).await;
    if result.is_ok()
        && let Some(extra) = optional
    {
        exec.try_run(&extra).await;
    }
    // Restore it even on error: the connection goes back to the pool (or is the shared SQLite handle),
    // otherwise the next statement runs on a session that still has foreign-key checking off.
    if disable_fk {
        exec.try_run(fk_checks_sql(conn, true)).await;
    }
    result
}

// Drop a table/view. `cascade` and `ignore_fk` are the 2 options of the sidebar's Delete dialog.
#[tauri::command]
pub async fn drop_table(
    conn_id: String,
    name: String,
    is_view: Option<bool>,
    cascade: Option<bool>,
    ignore_fk: Option<bool>,
    // See `get_table_data`: the sidebar's Temporary section names the `pg_temp_N` schema its rows
    // came from, so the DROP names the relation the user is looking at and not a `public` one.
    schema_override: Option<String>,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let (conn_type, schema) = {
            let ctx = state.connections.acquire(&conn_id)?;
            let ct = ctx.conn().clone();
            let sch = match schema_override.as_deref() {
                Some(s) if !s.is_empty() => Some(s.to_string()),
                _ => ctx.raw_schema().map(str::to_string),
            };
            (ct, sch)
        };
        let is_view = is_view.unwrap_or(false);
        let cascade = cascade.unwrap_or(false);
        // Ignoring foreign keys means nothing for a view: a view takes part in no FK constraint.
        let ignore_fk = ignore_fk.unwrap_or(false) && !is_view;

        // Only Postgres really honours CASCADE: SQLite reports a syntax error and MySQL accepts the keyword
        // then ignores it -> the user believes the cascade happened when it did not. Refusing beats staying silent.
        if cascade && !matches!(conn_type.kind, DbKind::Postgres(_)) {
            return Err("CASCADE chỉ được hỗ trợ trên PostgreSQL".to_string());
        }

        let keyword = if is_view { "DROP VIEW" } else { "DROP TABLE" };
        let sql = format!(
            "{} {}{}",
            keyword,
            qualified(&conn_type, &schema, &name),
            if cascade { " CASCADE" } else { "" }
        );

        run_fk_wrapped(&conn_type, ignore_fk, sql, None).await?;

        Ok(json!({ "success": true }))
    })
    .await
}

// The next AUTO_INCREMENT value of a MySQL table, None when the table has no auto-increment column.
// Read-only (a SELECT), so it can go through execute_raw_sql_generic and does not need to share the session with the TRUNCATE.
async fn mysql_next_auto_increment(conn: &DbConnection, name: &str) -> Option<u64> {
    let sql = format!(
        "SELECT AUTO_INCREMENT AS ai FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{}'",
        name.replace('\'', "''")
    );
    let results = execute_raw_sql_generic(conn, sql).await.ok()?;
    let cell = results
        .first()?
        .get("data")?
        .as_array()?
        .first()?
        .get("ai")?;
    // decode_mysql_cell! returns a u64 as a number, but a string is accepted too for safety.
    cell.as_u64().or_else(|| cell.as_str()?.parse().ok())
}

// Wipe the data but keep the table structure.
// `restart_identity` / `disable_fk` / `cascade` are the 3 options of the sidebar's Truncate dialog.
#[tauri::command]
pub async fn truncate_table(
    conn_id: String,
    name: String,
    restart_identity: Option<bool>,
    disable_fk: Option<bool>,
    cascade: Option<bool>,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let (conn_type, schema) = {
            let ctx = state.connections.acquire(&conn_id)?;
            let ct = ctx.conn().clone();
            (ct, ctx.raw_schema().map(str::to_string))
        };
        let restart_identity = restart_identity.unwrap_or(false);
        let disable_fk = disable_fk.unwrap_or(false);
        let cascade = cascade.unwrap_or(false);
        let quoted = qualified(&conn_type, &schema, &name);

        // Like DROP: only Postgres has TRUNCATE ... CASCADE.
        if cascade && !matches!(conn_type.kind, DbKind::Postgres(_)) {
            return Err("CASCADE chỉ được hỗ trợ trên PostgreSQL".to_string());
        }

        // MySQL always resets the auto-increment counter inside TRUNCATE and offers no way to stop it, so "keep the
        // counter" has to be done by hand: read the value first, set it back afterwards. Read it BEFORE truncating.
        let keep_auto_inc = match (&conn_type.kind, restart_identity) {
            (DbKind::Mysql(_), false) => mysql_next_auto_increment(&conn_type, &name).await,
            _ => None,
        };

        // The mandatory statement + a "best effort" statement to run afterwards (its failure does not count as a failure).
        let (sql, optional): (String, Option<String>) = match &conn_type.kind {
            DbKind::Mysql(_) => (
                format!("TRUNCATE TABLE {}", quoted),
                match (restart_identity, keep_auto_inc) {
                    // InnoDB has already reset it; the statement is still issued so the intent is explicit and other engines
                    // behave the same. A table with no auto-increment column -> ignore the error.
                    (true, _) => Some(format!("ALTER TABLE {} AUTO_INCREMENT = 1", quoted)),
                    // Put the old value back so a new id does not reuse a deleted one.
                    (false, Some(v)) if v > 1 => {
                        Some(format!("ALTER TABLE {} AUTO_INCREMENT = {}", quoted, v))
                    }
                    _ => None,
                },
            ),
            DbKind::Postgres(_) => (
                format!(
                    "TRUNCATE TABLE {}{}{}",
                    quoted,
                    if restart_identity {
                        " RESTART IDENTITY"
                    } else {
                        ""
                    },
                    if cascade { " CASCADE" } else { "" }
                ),
                None,
            ),
            // SQLite has no TRUNCATE -> DELETE FROM, and the auto-increment counter lives in the helper table
            // sqlite_sequence, which DELETE does not touch. That table only exists when the database has
            // at least one AUTOINCREMENT column -> ignore the "no such table" error.
            DbKind::Sqlite(_) => (
                format!("DELETE FROM {}", quoted),
                restart_identity.then(|| {
                    format!(
                        "DELETE FROM sqlite_sequence WHERE name = '{}'",
                        name.replace('\'', "''")
                    )
                }),
            ),
        };

        run_fk_wrapped(&conn_type, disable_fk, sql, optional).await?;

        Ok(json!({ "success": true }))
    })
    .await
}

// Returns the table's CREATE TABLE statement (its definition) per dialect
#[tauri::command]
pub async fn get_table_definition(conn_id: String, name: String) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };
    let sch = sql_str(&pg_schema_of(&schema));

    let ddl: String = match &conn_type.kind {
        DbKind::Sqlite(conn_arc) => {
            let conn = conn_arc.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
                .map_err(|e| e.to_string())?;
            let mut rows = stmt.query([name.as_str()]).map_err(|e| e.to_string())?;
            if let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let s: String = row.get(0).map_err(|e| e.to_string())?;
                format!("{};", s)
            } else {
                return Err("Không tìm thấy định nghĩa bảng".to_string());
            }
        }
        DbKind::Mysql(pool) => {
            let show_sql = format!("SHOW CREATE TABLE `{}`", name);
            let row = sqlx::query(sqlx::AssertSqlSafe(show_sql)).fetch_one(pool).await.map_err(|e| e.to_string())?;
            // Column 2 is "Create Table" (a table) or "Create View" (a view)
            let s: String = row.try_get("Create Table").or_else(|_| row.try_get("Create View")).map_err(|e| e.to_string())?;
            format!("{};", s)
        }
        DbKind::Postgres(_) => {
            // A view is NOT a table here. This branch used to hand-build `CREATE TABLE` for
            // every name it was given, so exporting a Postgres database emitted a CREATE TABLE
            // for each of its views — the re-import then had a real table shadowing the view
            // and none of the view logic. relkind decides: 'v' = view, 'm' = materialized view
            // (which CREATE ... WITH DATA populates on the spot, so no REFRESH is needed as
            // long as it is written after the tables it reads — which the dump order does).
            let relkind = {
                let sql = format!(
                    "SELECT c.relkind::text AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE n.nspname = '{}' AND c.relname = '{}' LIMIT 1",
                    sch, name.replace('\'', "''")
                );
                execute_raw_sql_generic(&conn_type, sql)
                    .await
                    .ok()
                    .and_then(|r| all_string_values(&r).into_iter().next())
                    .unwrap_or_default()
            };
            if relkind == "v" || relkind == "m" {
                // regclass resolves through search_path unless the name is qualified, which would
                // read a same-named view from another schema. The emitted DDL below stays
                // unqualified on purpose: the dump header sets search_path, so the file can be
                // restored into a differently-named schema.
                let sql = format!(
                    "SELECT pg_get_viewdef('\"{}\".\"{}\"'::regclass, true) AS def",
                    sch.replace('"', "\"\""),
                    name.replace('"', "\"\"")
                );
                let results = execute_raw_sql_generic(&conn_type, sql).await?;
                let body = all_string_values(&results)
                    .into_iter()
                    .next()
                    .ok_or("Không lấy được định nghĩa đối tượng")?;
                let body = body.trim().trim_end_matches(';');
                let kw = if relkind == "m" { "MATERIALIZED VIEW" } else { "VIEW" };
                return Ok(json!({
                    "success": true,
                    "sql": format!("CREATE {} \"{}\" AS\n{};", kw, name.replace('"', "\"\""), body)
                }));
            }

            // Postgres has no SHOW CREATE TABLE -> rebuild it from metadata (columns + NOT NULL + DEFAULT + PRIMARY KEY)
            let pk_cols = get_primary_key_columns(&conn_type, &schema, &name).await;
            // format_type() keeps length/precision — see get_table_schema for why.
            let sql = format!(
                "SELECT a.attname::text AS column_name, \
                        format_type(a.atttypid, a.atttypmod) AS data_type, \
                        CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable, \
                        pg_get_expr(d.adbin, d.adrelid) AS column_default \
                 FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 WHERE n.nspname = '{}' AND c.relname = '{}' \
                   AND a.attnum > 0 AND NOT a.attisdropped \
                 ORDER BY a.attnum",
                sch, name.replace('\'', "''")
            );
            let results = execute_raw_sql_generic(&conn_type, sql).await?;
            let mut defs: Vec<String> = Vec::new();
            if let Some(data) = results.first().and_then(|r| r.get("data")).and_then(|v| v.as_array()) {
                for row in data {
                    let o = match row.as_object() { Some(o) => o, None => continue };
                    let col = o.get("column_name").and_then(|v| v.as_str()).unwrap_or("");
                    let ty = o.get("data_type").and_then(|v| v.as_str()).unwrap_or("text");
                    let nullable = o.get("is_nullable").and_then(|v| v.as_str()).unwrap_or("YES") == "YES";
                    let default = o.get("column_default").and_then(|v| v.as_str());
                    let mut def = format!("  \"{}\" {}", col, ty);
                    if !nullable { def.push_str(" NOT NULL"); }
                    if let Some(d) = default { def.push_str(&format!(" DEFAULT {}", d)); }
                    defs.push(def);
                }
            }
            if !pk_cols.is_empty() {
                let pk_list = pk_cols.iter().map(|c| format!("\"{}\"", c)).collect::<Vec<_>>().join(", ");
                defs.push(format!("  PRIMARY KEY ({})", pk_list));
            }
            format!("CREATE TABLE \"{}\" (\n{}\n);", name, defs.join(",\n"))
        }
    };

    Ok(json!({ "success": true, "sql": ddl }))
}).await
}

#[tauri::command]
pub async fn rename_table(
    conn_id: String,
    old_name: String,
    new_name: String,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let (conn_type, schema) = {
            let ctx = state.connections.acquire(&conn_id)?;
            let ct = ctx.conn().clone();
            (ct, ctx.raw_schema().map(str::to_string))
        };

        // Only the source side carries the schema: RENAME TO takes an UNqualified new name (Postgres reports a syntax
        // error if it is qualified), and the renamed table stays in the same schema.
        let sql = match &conn_type.kind {
            DbKind::Mysql(_) => format!("RENAME TABLE `{}` TO `{}`", old_name, new_name),
            _ => format!(
                "ALTER TABLE {} RENAME TO {}",
                qualified(&conn_type, &schema, &old_name),
                quote_ident(&conn_type, &new_name)
            ),
        };
        execute_raw_sql_generic(&conn_type, sql.clone()).await?;

        Ok(json!({ "success": true }))
    })
    .await
}
