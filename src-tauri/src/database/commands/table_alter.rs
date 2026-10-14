//! Translating the structure editor's diff payload into ALTER TABLE — and either running it or only previewing it.

use serde_json::{Value, json};

use crate::database::{DbKind, execute_raw_sql_generic};

// Build the SQL statements that change a table's structure from the DDL payload the frontend sent
pub(super) fn generate_alter_sqls(
    table_name: &str,
    payload: &Value,
    db_type: &str,
    schema: &Option<String>,
) -> Vec<String> {
    let mut sqls = Vec::new();

    // Identifier quoting per dialect. Several statements below are shared by all three dialects
    // and used to hardcode backticks, which Postgres rejects outright — qualifying with a
    // backticked schema would have kept that broken, so they take this token instead.
    let quote = |ident: &str| -> String {
        if db_type == "postgres" {
            format!("\"{}\"", ident.replace('"', "\"\""))
        } else {
            format!("`{}`", ident.replace('`', "``"))
        }
    };
    // Postgres resolves an unqualified name through search_path, which need not contain the
    // schema the user picked, so every table reference here carries it.
    let qual = |ident: &str| -> String {
        match (db_type, schema.as_deref()) {
            ("postgres", Some(s)) if !s.is_empty() => format!("{}.{}", quote(s), quote(ident)),
            _ => quote(ident),
        }
    };
    let tbl = qual(table_name);

    let added = payload.get("added").and_then(|v| v.as_array());
    let dropped = payload.get("dropped").and_then(|v| v.as_array());
    let renamed = payload.get("renamed").and_then(|v| v.as_array());
    let modified = payload.get("modified").and_then(|v| v.as_array());

    let added_indexes = payload.get("addedIndexes").and_then(|v| v.as_array());
    let dropped_indexes = payload.get("droppedIndexes").and_then(|v| v.as_array());

    let added_fks = payload.get("addedFKs").and_then(|v| v.as_array());
    let dropped_fks = payload.get("droppedFKs").and_then(|v| v.as_array());

    // 1. Add new columns
    if let Some(arr) = added {
        for col in arr {
            if let Some(col_name) = col.get("name").and_then(|v| v.as_str()) {
                let col_type = col.get("type").and_then(|v| v.as_str()).unwrap_or("TEXT");
                let is_nullable = col
                    .get("nullable")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let default_val = col.get("defaultValue").and_then(|v| {
                    if v.is_null() {
                        None
                    } else {
                        Some(v.to_string())
                    }
                });

                let null_str = if is_nullable { "NULL" } else { "NOT NULL" };
                let default_str = if let Some(d) = default_val {
                    if d.trim().is_empty() || d == "null" {
                        "".to_string()
                    } else if d.to_uppercase() == "CURRENT_TIMESTAMP" {
                        format!(" DEFAULT {}", d)
                    } else {
                        format!(" DEFAULT '{}'", d.replace("'", "''"))
                    }
                } else {
                    "".to_string()
                };

                let sql = format!(
                    "ALTER TABLE {} ADD COLUMN {} {}{} {}",
                    tbl,
                    quote(col_name),
                    col_type,
                    default_str,
                    null_str
                );
                sqls.push(sql);
            }
        }
    }

    // 2. Drop columns
    if let Some(arr) = dropped {
        for col_name in arr {
            if let Some(name) = col_name.as_str() {
                // Some older SQLite builds do not support DROP COLUMN directly, but current sqlite3 does support ALTER TABLE DROP COLUMN
                sqls.push(format!("ALTER TABLE {} DROP COLUMN {}", tbl, quote(name)));
            }
        }
    }

    // 3. Rename columns
    if let Some(arr) = renamed {
        for item in arr {
            let old_name = item.get("oldName").and_then(|v| v.as_str()).unwrap_or("");
            let new_name = item.get("newName").and_then(|v| v.as_str()).unwrap_or("");
            if !old_name.is_empty() && !new_name.is_empty() {
                sqls.push(format!(
                    "ALTER TABLE {} RENAME COLUMN {} TO {}",
                    tbl,
                    quote(old_name),
                    quote(new_name)
                ));
            }
        }
    }

    // 4. Modify columns (data type / nullability)
    if let Some(arr) = modified {
        for col in arr {
            if let Some(col_name) = col.get("name").and_then(|v| v.as_str()) {
                let col_type = col.get("type").and_then(|v| v.as_str()).unwrap_or("TEXT");
                let is_nullable = col
                    .get("nullable")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let null_str = if is_nullable { "NULL" } else { "NOT NULL" };

                if db_type == "mysql" {
                    sqls.push(format!(
                        "ALTER TABLE {} MODIFY COLUMN {} {} {}",
                        tbl,
                        quote(col_name),
                        col_type,
                        null_str
                    ));
                } else if db_type == "postgres" {
                    sqls.push(format!(
                        "ALTER TABLE {} ALTER COLUMN {} TYPE {}",
                        tbl,
                        quote(col_name),
                        col_type
                    ));
                    let null_action = if is_nullable {
                        "DROP NOT NULL"
                    } else {
                        "SET NOT NULL"
                    };
                    sqls.push(format!(
                        "ALTER TABLE {} ALTER COLUMN {} {}",
                        tbl,
                        quote(col_name),
                        null_action
                    ));
                } else {
                    // SQLite cannot change column attributes directly, so warn the user
                }
            }
        }
    }

    // 5. Drop indexes
    if let Some(arr) = dropped_indexes {
        for idx in arr {
            if let Some(idx_name) = idx.as_str() {
                if db_type == "mysql" {
                    sqls.push(format!(
                        "ALTER TABLE {} DROP INDEX {}",
                        tbl,
                        quote(idx_name)
                    ));
                } else {
                    // Postgres: an index lives in its table's schema, so the DROP must name it.
                    sqls.push(format!("DROP INDEX {}", qual(idx_name)));
                }
            }
        }
    }

    // 6. Add indexes
    if let Some(arr) = added_indexes {
        for idx in arr {
            if let Some(idx_name) = idx.get("name").and_then(|v| v.as_str()) {
                let cols = idx.get("columns").and_then(|v| v.as_str()).unwrap_or("");
                let is_unique = idx.get("unique").and_then(|v| v.as_bool()).unwrap_or(false);
                let idx_type = idx.get("type").and_then(|v| v.as_str()).unwrap_or("INDEX");
                let method = idx
                    .get("method")
                    .and_then(|v| v.as_str())
                    .unwrap_or("BTREE");

                let unique_str = if is_unique || idx_type == "UNIQUE" {
                    "UNIQUE"
                } else {
                    ""
                };

                // The new index name is never schema-qualified — Postgres puts it in its table's
                // schema and rejects a qualified name here — but the table it is ON must be.
                if db_type == "mysql" {
                    let sql = match idx_type {
                        "FULLTEXT" => format!(
                            "CREATE FULLTEXT INDEX {} ON {} ({})",
                            quote(idx_name),
                            tbl,
                            cols
                        ),
                        "SPATIAL" => format!(
                            "CREATE SPATIAL INDEX {} ON {} ({})",
                            quote(idx_name),
                            tbl,
                            cols
                        ),
                        _ => format!(
                            "CREATE {} INDEX {} ON {} ({}) USING {}",
                            unique_str,
                            quote(idx_name),
                            tbl,
                            cols,
                            method
                        ),
                    };
                    sqls.push(sql);
                } else if db_type == "postgres" {
                    sqls.push(format!(
                        "CREATE {} INDEX {} ON {} USING {} ({})",
                        unique_str,
                        quote(idx_name),
                        tbl,
                        method.to_lowercase(),
                        cols
                    ));
                } else {
                    sqls.push(format!(
                        "CREATE {} INDEX {} ON {} ({})",
                        unique_str,
                        quote(idx_name),
                        tbl,
                        cols
                    ));
                }
            }
        }
    }

    // 7. Drop foreign keys
    if let Some(arr) = dropped_fks {
        for fk in arr {
            if let Some(fk_name) = fk.get("name").and_then(|v| v.as_str()) {
                if db_type == "mysql" {
                    sqls.push(format!(
                        "ALTER TABLE {} DROP FOREIGN KEY {}",
                        tbl,
                        quote(fk_name)
                    ));
                } else if db_type == "postgres" {
                    sqls.push(format!(
                        "ALTER TABLE {} DROP CONSTRAINT {}",
                        tbl,
                        quote(fk_name)
                    ));
                }
            }
        }
    }

    // 8. Add foreign keys (with On Update / On Delete)
    if let Some(arr) = added_fks {
        for fk in arr {
            let col = fk.get("column").and_then(|v| v.as_str()).unwrap_or("");
            let ref_table = fk.get("refTable").and_then(|v| v.as_str()).unwrap_or("");
            let ref_col = fk.get("refColumn").and_then(|v| v.as_str()).unwrap_or("");
            let on_update = fk
                .get("onUpdate")
                .and_then(|v| v.as_str())
                .unwrap_or("NO ACTION");
            let on_delete = fk
                .get("onDelete")
                .and_then(|v| v.as_str())
                .unwrap_or("NO ACTION");

            if !col.is_empty() && !ref_table.is_empty() && !ref_col.is_empty() {
                let fk_name = format!("fk_{}_{}_{}", table_name, col, ref_table);
                // The referenced table is qualified too: it is in the schema the user is working
                // in, which search_path need not cover.
                match db_type {
                    "mysql" => sqls.push(format!(
                        "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON UPDATE {} ON DELETE {}",
                        tbl, quote(&fk_name), quote(col), qual(ref_table), quote(ref_col), on_update, on_delete
                    )),
                    "postgres" => sqls.push(format!(
                        "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON UPDATE {} ON DELETE {}",
                        tbl, quote(&fk_name), quote(col), qual(ref_table), quote(ref_col), on_update, on_delete
                    )),
                    // SQLite cannot add a foreign key through ALTER TABLE — skipped (the table would have to be recreated)
                    _ => {}
                }
            }
        }
    }

    sqls
}

#[tauri::command]
pub async fn alter_table_schema(
    conn_id: String,
    name: String,
    payload: Value,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let (conn_type, schema) = {
            let ctx = state.connections.acquire(&conn_id)?;
            let ct = ctx.conn().clone();
            (ct, ctx.raw_schema().map(str::to_string))
        };

        let db_type = match &conn_type.kind {
            DbKind::Sqlite(_) => "sqlite",
            DbKind::Postgres(_) => "postgres",
            DbKind::Mysql(_) => "mysql",
            DbKind::DuckDb(_) => return Err(crate::database::DUCK_UNSUPPORTED.to_string()),
        };

        let sqls = generate_alter_sqls(&name, &payload, db_type, &schema);
        for sql in sqls {
            execute_raw_sql_generic(&conn_type, sql).await?;
        }

        Ok(json!({ "success": true }))
    })
    .await
}

#[tauri::command]
pub async fn preview_alter_schema(
    conn_id: String,
    name: String,
    payload: Value,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let (conn_type, schema) = {
            let ctx = state.connections.acquire(&conn_id)?;
            let ct = ctx.conn().clone();
            (ct, ctx.raw_schema().map(str::to_string))
        };

        let db_type = match &conn_type.kind {
            DbKind::Sqlite(_) => "sqlite",
            DbKind::Postgres(_) => "postgres",
            DbKind::Mysql(_) => "mysql",
            DbKind::DuckDb(_) => return Err(crate::database::DUCK_UNSUPPORTED.to_string()),
        };

        // The same SQL as alter_table_schema — the user previews exactly the statements that will run.
        let sqls = generate_alter_sqls(&name, &payload, db_type, &schema);
        Ok(json!({ "success": true, "sql": sqls.join(";\n") }))
    })
    .await
}
