//! Reading a SQLite schema from `sqlite_master` + the PRAGMAs.

use std::collections::BTreeMap;

use crate::compare::ident::q_ident;
use crate::compare::meta::{ColMeta, FkMeta, IdxMeta, SchemaMeta, TableMeta};
use crate::compare::side::{f_bool, f_opt_str, f_str, query_rows, query_rows_soft};
use crate::database::DbConnection;

// ---- SQLite ----

pub(super) async fn read_sqlite(conn: &DbConnection) -> Result<SchemaMeta, String> {
    let mut out: SchemaMeta = BTreeMap::new();

    let sql = "SELECT name AS table_name, type AS table_type, sql AS create_sql \
               FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' \
               ORDER BY name"
        .to_string();
    for row in query_rows(conn, sql).await? {
        let name = f_str(&row, "table_name");
        if name.is_empty() {
            continue;
        }
        let is_view = f_str(&row, "table_type") == "view";
        let create_sql = f_opt_str(&row, "create_sql");
        out.insert(
            name.clone(),
            TableMeta {
                name,
                is_view,
                view_def: if is_view { create_sql.clone() } else { None },
                create_sql,
                ..Default::default()
            },
        );
    }

    let names: Vec<String> = out.keys().cloned().collect();
    for name in names {
        let quoted = q_ident("sqlite", &name);

        // (column, position in the PK) — PRAGMA returns `pk` = 0 when not part of the PK, 1..n when it is.
        let mut pk: Vec<(i64, String)> = Vec::new();
        for row in query_rows_soft(conn, format!("PRAGMA table_info({quoted})")).await {
            let col = ColMeta {
                name: f_str(&row, "name"),
                data_type: f_str(&row, "type"),
                nullable: !f_bool(&row, "notnull"),
                default: f_opt_str(&row, "dflt_value"),
                auto_increment: false,
                comment: None,
                position: 0,
            };
            let pk_ord = row.get("pk").and_then(|v| v.as_i64()).unwrap_or(0);
            if pk_ord > 0 {
                pk.push((pk_ord, col.name.clone()));
            }
            if let Some(t) = out.get_mut(&name) {
                let position = t.columns.len() + 1;
                t.columns.push(ColMeta { position, ..col });
            }
        }
        pk.sort_by_key(|(ord, _)| *ord);

        let mut indexes: Vec<IdxMeta> = Vec::new();
        for row in query_rows_soft(conn, format!("PRAGMA index_list({quoted})")).await {
            let idx_name = f_str(&row, "name");
            // origin = 'pk' -> the implicit index of the PRIMARY KEY, already covered by `pk`.
            if idx_name.is_empty() || f_str(&row, "origin") == "pk" {
                continue;
            }
            let unique = f_bool(&row, "unique");
            let info_sql = format!("PRAGMA index_info({})", q_ident("sqlite", &idx_name));
            let cols: Vec<String> = query_rows_soft(conn, info_sql)
                .await
                .iter()
                .map(|r| f_str(r, "name"))
                .filter(|c| !c.is_empty())
                .collect();
            indexes.push(IdxMeta {
                name: idx_name,
                columns: cols,
                unique,
                using: None,
            });
        }

        let mut fks: Vec<FkMeta> = Vec::new();
        for row in query_rows_soft(conn, format!("PRAGMA foreign_key_list({quoted})")).await {
            let id = row.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
            // SQLite does not name its FKs -> a synthesised name, stable enough to compare the two sides.
            let fk_name = format!("fk_{}_{}", name, id);
            let from = f_str(&row, "from");
            let to = f_str(&row, "to");
            match fks.iter_mut().find(|f| f.name == fk_name) {
                Some(f) => {
                    f.columns.push(from);
                    f.ref_columns.push(to);
                }
                None => fks.push(FkMeta {
                    name: fk_name,
                    columns: vec![from],
                    ref_table: f_str(&row, "table"),
                    ref_columns: vec![to],
                    on_delete: f_opt_str(&row, "on_delete"),
                    on_update: f_opt_str(&row, "on_update"),
                }),
            }
        }

        if let Some(t) = out.get_mut(&name) {
            t.pk = pk.into_iter().map(|(_, c)| c).collect();
            t.indexes = indexes;
            t.fks = fks;
        }
    }

    Ok(out)
}
