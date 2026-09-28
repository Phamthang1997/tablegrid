//! Reading a MySQL schema from `information_schema`.

use std::collections::BTreeMap;

use crate::compare::meta::{ColMeta, FkMeta, IdxMeta, SchemaMeta, TableMeta};
use crate::compare::side::{f_bool, f_opt_str, f_str, query_rows, query_rows_soft};
use crate::database::DbConnection;

// ---- MySQL ----

pub(super) async fn read_mysql(conn: &DbConnection, schema: &str) -> Result<SchemaMeta, String> {
    let s = schema.replace('\'', "''");
    let mut out: SchemaMeta = BTreeMap::new();

    let sql = format!(
        "SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type \
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = '{s}'"
    );
    for row in query_rows(conn, sql).await? {
        let name = f_str(&row, "table_name");
        if name.is_empty() {
            continue;
        }
        let is_view = f_str(&row, "table_type")
            .to_ascii_uppercase()
            .contains("VIEW");
        out.insert(
            name.clone(),
            TableMeta {
                name,
                is_view,
                ..Default::default()
            },
        );
    }

    let sql = format!(
        "SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLUMN_TYPE AS data_type, \
                IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default, EXTRA AS extra, \
                COLUMN_COMMENT AS column_comment, ORDINAL_POSITION AS ordinal_position \
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '{s}' \
         ORDER BY TABLE_NAME, ORDINAL_POSITION"
    );
    for row in query_rows(conn, sql).await? {
        let table = f_str(&row, "table_name");
        if let Some(t) = out.get_mut(&table) {
            let position = t.columns.len() + 1;
            t.columns.push(ColMeta {
                name: f_str(&row, "column_name"),
                data_type: f_str(&row, "data_type"),
                nullable: f_bool(&row, "is_nullable"),
                default: f_opt_str(&row, "column_default"),
                auto_increment: f_str(&row, "extra")
                    .to_ascii_lowercase()
                    .contains("auto_increment"),
                comment: f_opt_str(&row, "column_comment").filter(|c| !c.is_empty()),
                position,
            });
        }
    }

    // STATISTICS contains PRIMARY as well: split it out into `pk`, the rest are ordinary indexes.
    let sql = format!(
        "SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, COLUMN_NAME AS column_name, \
                NON_UNIQUE AS non_unique \
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = '{s}' \
         ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX"
    );
    for row in query_rows_soft(conn, sql).await {
        let table = f_str(&row, "table_name");
        let idx_name = f_str(&row, "index_name");
        let col = f_str(&row, "column_name");
        if let Some(t) = out.get_mut(&table) {
            if idx_name == "PRIMARY" {
                t.pk.push(col);
                continue;
            }
            let unique = !f_bool(&row, "non_unique");
            match t.indexes.iter_mut().find(|i| i.name == idx_name) {
                Some(i) => i.columns.push(col),
                None => t.indexes.push(IdxMeta {
                    name: idx_name,
                    columns: vec![col],
                    unique,
                    using: None,
                }),
            }
        }
    }

    let sql = format!(
        "SELECT k.TABLE_NAME AS table_name, k.CONSTRAINT_NAME AS constraint_name, \
                k.COLUMN_NAME AS column_name, k.REFERENCED_TABLE_NAME AS ref_table, \
                k.REFERENCED_COLUMN_NAME AS ref_column, r.DELETE_RULE AS delete_rule, \
                r.UPDATE_RULE AS update_rule \
         FROM information_schema.KEY_COLUMN_USAGE k \
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA \
          AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME \
          AND r.TABLE_NAME = k.TABLE_NAME \
         WHERE k.TABLE_SCHEMA = '{s}' AND k.REFERENCED_TABLE_NAME IS NOT NULL \
         ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION"
    );
    for row in query_rows_soft(conn, sql).await {
        let table = f_str(&row, "table_name");
        let name = f_str(&row, "constraint_name");
        if let Some(t) = out.get_mut(&table) {
            let col = f_str(&row, "column_name");
            let ref_col = f_str(&row, "ref_column");
            match t.fks.iter_mut().find(|f| f.name == name) {
                Some(f) => {
                    f.columns.push(col);
                    f.ref_columns.push(ref_col);
                }
                None => t.fks.push(FkMeta {
                    name,
                    columns: vec![col],
                    ref_table: f_str(&row, "ref_table"),
                    ref_columns: vec![ref_col],
                    on_delete: f_opt_str(&row, "delete_rule"),
                    on_update: f_opt_str(&row, "update_rule"),
                }),
            }
        }
    }

    let sql = format!(
        "SELECT TABLE_NAME AS table_name, VIEW_DEFINITION AS view_definition \
         FROM information_schema.VIEWS WHERE TABLE_SCHEMA = '{s}'"
    );
    for row in query_rows_soft(conn, sql).await {
        let table = f_str(&row, "table_name");
        if let Some(t) = out.get_mut(&table) {
            t.view_def = f_opt_str(&row, "view_definition");
        }
    }

    Ok(out)
}
