//! Reading a Postgres schema from `information_schema` + Postgres' own catalogs.

use std::collections::BTreeMap;

use crate::compare::meta::{ColMeta, FkMeta, IdxMeta, SchemaMeta, TableMeta};
use crate::compare::side::{f_bool, f_opt_str, f_str, query_rows, query_rows_soft};
use crate::database::DbConnection;

// ---- Postgres ----

pub(super) async fn read_pg(conn: &DbConnection, schema: &str) -> Result<SchemaMeta, String> {
    let s = schema.replace('\'', "''");
    let mut out: SchemaMeta = BTreeMap::new();

    // relkind is of type "char" — sqlx cannot decode it into a String, so map it right there in the SQL.
    let sql = format!(
        "SELECT c.relname AS table_name, \
                CASE WHEN c.relkind IN ('v','m') THEN 1 ELSE 0 END AS is_view \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = '{s}' AND c.relkind IN ('r','p','v','m')"
    );
    for row in query_rows(conn, sql).await? {
        let name = f_str(&row, "table_name");
        if name.is_empty() {
            continue;
        }
        let is_view = f_bool(&row, "is_view");
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
        "SELECT c.relname AS table_name, a.attname AS column_name, \
                format_type(a.atttypid, a.atttypmod) AS data_type, \
                (NOT a.attnotnull) AS is_nullable, \
                pg_get_expr(d.adbin, d.adrelid) AS column_default, \
                (a.attidentity <> '')::bool AS is_identity, \
                col_description(c.oid, a.attnum) AS column_comment \
         FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
         LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum \
         WHERE n.nspname = '{s}' AND c.relkind IN ('r','p','v','m') \
         ORDER BY c.relname, a.attnum"
    );
    for row in query_rows(conn, sql).await? {
        let table = f_str(&row, "table_name");
        if let Some(t) = out.get_mut(&table) {
            let default = f_opt_str(&row, "column_default");
            let position = t.columns.len() + 1;
            t.columns.push(ColMeta {
                name: f_str(&row, "column_name"),
                data_type: f_str(&row, "data_type"),
                nullable: f_bool(&row, "is_nullable"),
                auto_increment: f_bool(&row, "is_identity")
                    || default
                        .as_deref()
                        .map(|d| d.contains("nextval("))
                        .unwrap_or(false),
                default,
                comment: f_opt_str(&row, "column_comment"),
                position,
            });
        }
    }

    let sql = format!(
        "SELECT c.relname AS table_name, i.relname AS index_name, ix.indisunique AS is_unique, \
                ix.indisprimary AS is_primary, \
                (SELECT string_agg(pg_get_indexdef(ix.indexrelid, k, true), chr(31) ORDER BY k) \
                   FROM generate_series(1, ix.indnkeyatts) AS k) AS index_keys, \
                substring(pg_get_indexdef(ix.indexrelid) from ' USING .*$') AS index_using \
         FROM pg_index ix \
         JOIN pg_class c ON c.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = '{s}' \
         ORDER BY c.relname, i.relname"
    );
    for row in query_rows_soft(conn, sql).await {
        let table = f_str(&row, "table_name");
        if let Some(t) = out.get_mut(&table) {
            // One key per call rather than the text inside the last parentheses of the whole
            // definition, which is the `WITH (m=…)` of an HNSW index or a partial index's WHERE.
            // Joined on U+001F because an expression key (`coalesce(a, b)`) holds commas.
            let cols: Vec<String> = f_str(&row, "index_keys")
                .split('\u{1f}')
                .map(|p| p.trim().trim_matches('"').to_string())
                .filter(|p| !p.is_empty())
                .collect();
            if f_bool(&row, "is_primary") {
                t.pk = cols;
                continue;
            }
            t.indexes.push(IdxMeta {
                name: f_str(&row, "index_name"),
                columns: cols,
                unique: f_bool(&row, "is_unique"),
                using: f_opt_str(&row, "index_using"),
            });
        }
    }

    let sql = format!(
        "SELECT con.conname AS constraint_name, c.relname AS table_name, rc.relname AS ref_table, \
                (SELECT string_agg(a.attname, ',' ORDER BY x.ord) \
                   FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord) \
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS columns, \
                (SELECT string_agg(a.attname, ',' ORDER BY x.ord) \
                   FROM unnest(con.confkey) WITH ORDINALITY AS x(attnum, ord) \
                   JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = x.attnum) AS ref_columns, \
                CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' \
                     WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS delete_rule, \
                CASE con.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' \
                     WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS update_rule \
         FROM pg_constraint con \
         JOIN pg_class c ON c.oid = con.conrelid \
         JOIN pg_class rc ON rc.oid = con.confrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE con.contype = 'f' AND n.nspname = '{s}' \
         ORDER BY c.relname, con.conname"
    );
    for row in query_rows_soft(conn, sql).await {
        let table = f_str(&row, "table_name");
        if let Some(t) = out.get_mut(&table) {
            t.fks.push(FkMeta {
                name: f_str(&row, "constraint_name"),
                columns: split_csv(&f_str(&row, "columns")),
                ref_table: f_str(&row, "ref_table"),
                ref_columns: split_csv(&f_str(&row, "ref_columns")),
                on_delete: f_opt_str(&row, "delete_rule"),
                on_update: f_opt_str(&row, "update_rule"),
            });
        }
    }

    let sql = format!(
        "SELECT c.relname AS table_name, pg_get_viewdef(c.oid, true) AS view_definition \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = '{s}' AND c.relkind IN ('v','m')"
    );
    for row in query_rows_soft(conn, sql).await {
        let table = f_str(&row, "table_name");
        if let Some(t) = out.get_mut(&table) {
            t.view_def = f_opt_str(&row, "view_definition");
        }
    }

    Ok(out)
}

pub(super) fn split_csv(s: &str) -> Vec<String> {
    s.split(',')
        .map(|p| p.trim().trim_matches('"').to_string())
        .filter(|p| !p.is_empty())
        .collect()
}
