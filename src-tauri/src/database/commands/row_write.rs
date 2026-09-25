//! Writing data: saving the grid's edits, and bulk loading (import).

use serde_json::{Value, json};

use crate::database::{
    DbConnection, DbKind, Exec, execute_raw_sql_generic, qualified, reject_conn_read_only,
    sql_literal,
};

use super::catalog::detect_primary_key;

#[tauri::command]
pub async fn commit_changes(conn_id: String, payload: Value) -> Result<Value, String> {
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
        let changes = payload
            .get("changes")
            .and_then(|v| v.as_array())
            .ok_or("Thiếu danh sách thay đổi")?;
        // Preview mode: only build the SQL, do not execute it
        let preview = payload
            .get("preview")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        // Determine the primary-key column: prefer the value the frontend sent, otherwise detect it from the schema, and only then fall back to "id"
        // The same schema as the write statements below — see the note on get_primary_key_columns.
        let pk_col = match payload
            .get("primaryKey")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
        {
            Some(pk) => pk.to_string(),
            None => detect_primary_key(&conn_type, &schema, table_name)
                .await
                .unwrap_or_else(|| "id".to_string()),
        };

        let is_pg = matches!(&conn_type.kind, DbKind::Postgres(_));
        // Written with backticks like every other identifier below, because the Postgres branch turns
        // the whole statement's backticks into double quotes at the end.
        let table_ref = match (is_pg, schema.as_deref()) {
            (true, Some(s)) if !s.is_empty() => format!("`{}`.`{}`", s, table_name),
            _ => format!("`{}`", table_name),
        };
        let mut sqls: Vec<String> = Vec::new();

        for change in changes {
            let change_type = change.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let row_id = change
                .get("rowId")
                .map(|v| {
                    if v.is_string() {
                        v.as_str().unwrap().to_string()
                    } else {
                        v.to_string()
                    }
                })
                .unwrap_or_default();

            match change_type {
                "delete" => {
                    let sql = format!(
                        "DELETE FROM {} WHERE `{}` = '{}'",
                        table_ref,
                        pk_col,
                        row_id.replace("'", "''")
                    );
                    sqls.push(if is_pg { sql.replace("`", "\"") } else { sql });
                }
                "insert" => {
                    if let Some(new_data) = change.get("newData").and_then(|v| v.as_object()) {
                        let mut cols = Vec::new();
                        let mut vals = Vec::new();
                        for (k, v) in new_data {
                            cols.push(format!("`{}`", k));
                            if v.is_null() {
                                vals.push("NULL".to_string());
                            } else if v.is_string() {
                                vals.push(format!("'{}'", v.as_str().unwrap().replace("'", "''")));
                            } else {
                                vals.push(v.to_string());
                            }
                        }
                        let sql = format!(
                            "INSERT INTO {} ({}) VALUES ({})",
                            table_ref,
                            cols.join(", "),
                            vals.join(", ")
                        );
                        sqls.push(if is_pg { sql.replace("`", "\"") } else { sql });
                    }
                }
                "update" => {
                    if let Some(new_data) = change.get("newData").and_then(|v| v.as_object()) {
                        let mut sets = Vec::new();
                        for (k, v) in new_data {
                            let val_str = if v.is_null() {
                                "NULL".to_string()
                            } else if v.is_string() {
                                format!("'{}'", v.as_str().unwrap().replace("'", "''"))
                            } else {
                                v.to_string()
                            };
                            sets.push(format!("`{}` = {}", k, val_str));
                        }
                        if !sets.is_empty() {
                            let sql = format!(
                                "UPDATE {} SET {} WHERE `{}` = '{}'",
                                table_ref,
                                sets.join(", "),
                                pk_col,
                                row_id.replace("'", "''")
                            );
                            sqls.push(if is_pg { sql.replace("`", "\"") } else { sql });
                        }
                    }
                }
                _ => {}
            }
        }

        // Preview: return the list of SQL statements without running them
        if preview {
            return Ok(json!({ "success": true, "preview": true, "sqls": sqls }));
        }

        // After the preview return, deliberately: showing someone the SQL their edits would produce is
        // not a write, and refusing it would make read-only mean "you may not look either".
        reject_conn_read_only(&conn_type)?;

        // Manual-commit mode: join the user's transaction instead of opening a nested one. They own the
        // commit point, so a failure here leaves the earlier statements pending for them to roll back —
        // which is the whole reason they turned auto-commit off.
        //
        // `use_session()`, NOT `is_open()`: the transaction does not exist until its first statement,
        // and pressing Save right after switching to manual is exactly that case. Checking `is_open()`
        // sent it down the auto-commit branch below and committed it.
        if crate::tx::use_session(&conn_type) {
            for sql in sqls {
                execute_raw_sql_generic(&conn_type, sql).await?;
            }
            return Ok(json!({ "success": true }));
        }

        // Auto-commit: the whole grid commit is one transaction, all or nothing.
        //
        // It used to run the statements one by one through `execute_raw_sql_generic`, which acquires a
        // NEW pooled connection per call — so a `BEGIN` sent that way would have landed on a different
        // session than the INSERT/UPDATEs and done nothing. `Exec` holds ONE connection for the whole
        // batch, which is what makes the rollback below real.
        //
        // Only DML gets built above. Do not add DDL to this batch: MySQL commits implicitly on DDL, so
        // the rollback would no longer undo everything.
        let mut exec = Exec::acquire(&conn_type).await?;
        let begin = if matches!(&conn_type.kind, DbKind::Mysql(_)) {
            "START TRANSACTION;"
        } else {
            "BEGIN;"
        };
        exec.run(begin.to_string()).await?;
        for sql in sqls {
            if let Err(e) = exec.run(sql.clone()).await {
                exec.try_run("ROLLBACK;").await;
                return Err(format!("Lỗi tại câu lệnh:\n{}\n\nChi tiết: {}", sql, e));
            }
        }
        exec.run("COMMIT;".to_string()).await?;

        Ok(json!({ "success": true }))
    })
    .await
}

#[tauri::command]
pub async fn import_new_table(
    conn_id: String,
    table_name: String,
    rows: Vec<Value>,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let (conn_type, schema) = {
            let ctx = state.connections.acquire(&conn_id)?;
            let ct = ctx.conn().clone();
            (ct, ctx.raw_schema().map(str::to_string))
        };
        if rows.is_empty() {
            return Err("Không có dữ liệu để tạo bảng".to_string());
        }
        let is_mysql = matches!(&conn_type.kind, DbKind::Mysql(_));
        let is_pg = matches!(&conn_type.kind, DbKind::Postgres(_));
        let q = if is_mysql { '`' } else { '"' };

        // Columns = the union of the keys (in order of first appearance).
        let mut col_order: Vec<String> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for row in &rows {
            if let Some(obj) = row.as_object() {
                for k in obj.keys() {
                    if seen.insert(k.clone()) {
                        col_order.push(k.clone());
                    }
                }
            }
        }
        if col_order.is_empty() {
            return Err("Dữ liệu import không có cột nào".to_string());
        }

        // Infer each column's type: every non-null value an integer -> INT; a number (with a fractional part) -> REAL/DOUBLE; anything else -> TEXT.
        let mut defs: Vec<String> = Vec::new();
        for c in &col_order {
            let (mut all_int, mut all_num, mut any) = (true, true, false);
            for row in &rows {
                if let Some(v) = row.as_object().and_then(|o| o.get(c)) {
                    if v.is_null() {
                        continue;
                    }
                    any = true;
                    if !(v.is_i64() || v.is_u64()) {
                        all_int = false;
                    }
                    if !v.is_number() {
                        all_num = false;
                    }
                }
            }
            let ty = if any && all_int {
                if is_pg || is_mysql {
                    "BIGINT"
                } else {
                    "INTEGER"
                }
            } else if any && all_num {
                if is_pg {
                    "DOUBLE PRECISION"
                } else if is_mysql {
                    "DOUBLE"
                } else {
                    "REAL"
                }
            } else {
                "TEXT"
            };
            defs.push(format!("{q}{}{q} {}", c, ty));
        }

        let create_sql = format!(
            "CREATE TABLE {} ({})",
            qualified(&conn_type, &schema, &table_name),
            defs.join(", ")
        );
        execute_raw_sql_generic(&conn_type, create_sql).await?;

        let inserted = bulk_insert(&conn_type, &schema, &table_name, &rows).await?;
        Ok(json!({ "success": true, "inserted": inserted }))
    })
    .await
}

// Bulk-insert rows into an existing table. Every BATCH rows are folded into one multi-VALUES INSERT.
// The columns come from the union of the rows' keys, in order of first appearance.
async fn bulk_insert(
    conn: &DbConnection,
    schema: &Option<String>,
    table: &str,
    rows: &[Value],
) -> Result<usize, String> {
    if rows.is_empty() {
        return Ok(0);
    }
    let is_mysql = matches!(conn.kind, DbKind::Mysql(_));
    let q = if is_mysql { '`' } else { '"' };

    let mut col_order: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        if let Some(obj) = row.as_object() {
            for k in obj.keys() {
                if seen.insert(k.clone()) {
                    col_order.push(k.clone());
                }
            }
        }
    }
    if col_order.is_empty() {
        return Err("Dữ liệu import không có cột nào".to_string());
    }

    let quoted_table = qualified(conn, schema, table);
    let cols_sql = col_order
        .iter()
        .map(|c| format!("{q}{}{q}", c))
        .collect::<Vec<_>>()
        .join(", ");

    const BATCH: usize = 500;
    let mut inserted = 0usize;
    for chunk in rows.chunks(BATCH) {
        let mut values_list: Vec<String> = Vec::with_capacity(chunk.len());
        for row in chunk {
            let obj = row.as_object();
            let vals: Vec<String> = col_order
                .iter()
                .map(|c| sql_literal(obj.and_then(|o| o.get(c))))
                .collect();
            values_list.push(format!("({})", vals.join(", ")));
        }
        // MySQL/SQLite/PG all accept the multi-VALUES INSERT syntax.
        let sql = format!(
            "INSERT INTO {} ({}) VALUES {};",
            quoted_table,
            cols_sql,
            values_list.join(", ")
        );
        execute_raw_sql_generic(conn, sql).await?;
        inserted += chunk.len();
    }
    Ok(inserted)
}
