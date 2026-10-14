//! Reads the metadata of the target tables (columns, types, foreign keys) and computes the FK-safe INSERTION ORDER.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::database::{DbConnection, execute_raw_sql_generic};

use super::spec::{opt_i64, rows_of, s};

// ===================== Database metadata =====================

#[derive(Debug, Clone)]
pub struct ColMeta {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_pk: bool,
    pub auto_inc: bool,
    pub has_default: bool,
    pub max_len: Option<i64>,
    pub scale: Option<i64>,
    pub enum_values: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct FkMeta {
    pub column: String,
    pub ref_table: String,
    pub ref_column: String,
}

#[derive(Debug, Clone)]
pub struct TableMeta {
    pub name: String,
    pub columns: Vec<ColMeta>,
    pub fks: Vec<FkMeta>,
}

impl TableMeta {
    pub(super) fn fk_of(&self, column: &str) -> Option<&FkMeta> {
        self.fks.iter().find(|f| f.column == column)
    }
}

pub(super) fn parse_enum_type(column_type: &str) -> Vec<String> {
    // MySQL COLUMN_TYPE looks like: enum('a','b') / set('x','y')
    let lower = column_type.to_lowercase();
    if !(lower.starts_with("enum(") || lower.starts_with("set(")) {
        return Vec::new();
    }
    let inner = match (column_type.find('('), column_type.rfind(')')) {
        (Some(a), Some(b)) if b > a => &column_type[a + 1..b],
        _ => return Vec::new(),
    };
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_str = false;
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' if in_str && chars.peek() == Some(&'\'') => {
                cur.push('\'');
                chars.next();
            }
            '\'' => {
                if in_str {
                    out.push(std::mem::take(&mut cur));
                }
                in_str = !in_str;
            }
            _ if in_str => cur.push(c),
            _ => {}
        }
    }
    out
}

pub(super) async fn query_rows(conn: &DbConnection, sql: &str) -> Result<Vec<Value>, String> {
    Ok(rows_of(
        &execute_raw_sql_generic(conn, sql.to_string()).await?,
    ))
}

/// Reads columns + foreign keys of the base tables. `only` limits the work for SQLite, whose
/// metadata needs one PRAGMA per table.
pub async fn collect_meta(
    conn: &DbConnection,
    dialect: &str,
    schema: &Option<String>,
    only: Option<&[String]>,
) -> Result<Vec<TableMeta>, String> {
    // Postgres only; the MySQL branch below filters by DATABASE() and SQLite has no schema.
    let sch = schema
        .clone()
        .unwrap_or_else(|| "public".to_string())
        .replace('\'', "''");
    let mut metas: Vec<TableMeta> = Vec::new();

    match dialect {
        "mysql" => {
            let tables = query_rows(
                conn,
                "SELECT TABLE_NAME AS tname FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
            )
            .await?;
            let mut order: Vec<String> = tables.iter().map(|r| s(r, "tname")).collect();
            if let Some(keep) = only {
                order.retain(|t| keep.iter().any(|k| k == t));
            }
            let mut cols: HashMap<String, Vec<ColMeta>> = HashMap::new();
            for r in query_rows(
                conn,
                "SELECT TABLE_NAME AS tname, COLUMN_NAME AS cname, DATA_TYPE AS dtype, \
                        COLUMN_TYPE AS ctype, IS_NULLABLE AS nullable, COLUMN_KEY AS ckey, \
                        EXTRA AS extra, COLUMN_DEFAULT AS cdefault, \
                        CHARACTER_MAXIMUM_LENGTH AS maxlen, NUMERIC_SCALE AS nscale \
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() \
                 ORDER BY TABLE_NAME, ORDINAL_POSITION",
            )
            .await?
            {
                let ctype = s(&r, "ctype");
                cols.entry(s(&r, "tname")).or_default().push(ColMeta {
                    name: s(&r, "cname"),
                    data_type: ctype.clone(),
                    nullable: s(&r, "nullable").eq_ignore_ascii_case("YES"),
                    is_pk: s(&r, "ckey") == "PRI",
                    auto_inc: s(&r, "extra").to_lowercase().contains("auto_increment"),
                    has_default: r.get("cdefault").map(|v| !v.is_null()).unwrap_or(false),
                    max_len: opt_i64(&r, "maxlen"),
                    scale: opt_i64(&r, "nscale"),
                    enum_values: parse_enum_type(&ctype),
                });
            }
            let mut fks: HashMap<String, Vec<FkMeta>> = HashMap::new();
            for r in query_rows(
                conn,
                "SELECT TABLE_NAME AS tname, COLUMN_NAME AS cname, \
                        REFERENCED_TABLE_NAME AS rtable, REFERENCED_COLUMN_NAME AS rcolumn \
                 FROM information_schema.KEY_COLUMN_USAGE \
                 WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL",
            )
            .await?
            {
                fks.entry(s(&r, "tname")).or_default().push(FkMeta {
                    column: s(&r, "cname"),
                    ref_table: s(&r, "rtable"),
                    ref_column: s(&r, "rcolumn"),
                });
            }
            for t in order {
                metas.push(TableMeta {
                    columns: cols.remove(&t).unwrap_or_default(),
                    fks: fks.remove(&t).unwrap_or_default(),
                    name: t,
                });
            }
        }
        "postgres" => {
            let tables = query_rows(
                conn,
                &format!(
                    "SELECT table_name AS tname FROM information_schema.tables \
                     WHERE table_schema = '{sch}' AND table_type = 'BASE TABLE' ORDER BY table_name"
                ),
            )
            .await?;
            let mut order: Vec<String> = tables.iter().map(|r| s(r, "tname")).collect();
            if let Some(keep) = only {
                order.retain(|t| keep.iter().any(|k| k == t));
            }

            // Enum labels per user type, so an enum column offers its real values.
            let mut enum_labels: HashMap<String, Vec<String>> = HashMap::new();
            for r in query_rows(
                conn,
                "SELECT t.typname AS tname, e.enumlabel AS label FROM pg_type t \
                 JOIN pg_enum e ON e.enumtypid = t.oid ORDER BY e.enumsortorder",
            )
            .await
            .unwrap_or_default()
            {
                enum_labels
                    .entry(s(&r, "tname"))
                    .or_default()
                    .push(s(&r, "label"));
            }

            let mut pks: HashMap<String, HashSet<String>> = HashMap::new();
            for r in query_rows(
                conn,
                &format!(
                    "SELECT tc.table_name AS tname, kcu.column_name AS cname \
                     FROM information_schema.table_constraints tc \
                     JOIN information_schema.key_column_usage kcu \
                       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
                     WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = '{sch}'"
                ),
            )
            .await?
            {
                pks.entry(s(&r, "tname")).or_default().insert(s(&r, "cname"));
            }

            let mut cols: HashMap<String, Vec<ColMeta>> = HashMap::new();
            for r in query_rows(
                conn,
                &format!(
                    // `ftype` is `format_type()`: for an extension type `udt_name` says `vector`
                    // and drops the dimension (`vector(1536)`), which the generator needs.
                    "SELECT c.table_name AS tname, c.column_name AS cname, c.data_type AS dtype, \
                            c.udt_name AS udt, c.is_nullable AS nullable, c.column_default AS cdefault, \
                            c.is_identity AS identity, c.character_maximum_length AS maxlen, \
                            c.numeric_scale AS nscale, \
                            (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a \
                              WHERE a.attrelid = format('%I.%I', c.table_schema, c.table_name)::regclass \
                                AND a.attname = c.column_name) AS ftype \
                     FROM information_schema.columns c WHERE c.table_schema = '{sch}' \
                     ORDER BY c.table_name, c.ordinal_position"
                ),
            )
            .await?
            {
                let tname = s(&r, "tname");
                let cname = s(&r, "cname");
                let default = s(&r, "cdefault");
                let dtype = s(&r, "dtype");
                let udt = s(&r, "udt");
                let enum_values = if dtype == "USER-DEFINED" {
                    enum_labels.get(&udt).cloned().unwrap_or_default()
                } else {
                    Vec::new()
                };
                let is_pk = pks
                    .get(&tname)
                    .map(|set| set.contains(&cname))
                    .unwrap_or(false);
                cols.entry(tname).or_default().push(ColMeta {
                    name: cname,
                    data_type: if dtype == "USER-DEFINED" {
                        Some(s(&r, "ftype")).filter(|f| !f.is_empty()).unwrap_or(udt)
                    } else {
                        dtype
                    },
                    nullable: s(&r, "nullable").eq_ignore_ascii_case("YES"),
                    is_pk,
                    auto_inc: default.contains("nextval")
                        || s(&r, "identity").eq_ignore_ascii_case("YES"),
                    has_default: !default.is_empty(),
                    max_len: opt_i64(&r, "maxlen"),
                    scale: opt_i64(&r, "nscale"),
                    enum_values,
                });
            }

            let mut fks: HashMap<String, Vec<FkMeta>> = HashMap::new();
            for r in query_rows(
                conn,
                &format!(
                    "SELECT tc.table_name AS tname, kcu.column_name AS cname, \
                            ccu.table_name AS rtable, ccu.column_name AS rcolumn \
                     FROM information_schema.table_constraints tc \
                     JOIN information_schema.key_column_usage kcu \
                       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
                     JOIN information_schema.constraint_column_usage ccu \
                       ON ccu.constraint_name = tc.constraint_name \
                     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = '{sch}'"
                ),
            )
            .await?
            {
                fks.entry(s(&r, "tname")).or_default().push(FkMeta {
                    column: s(&r, "cname"),
                    ref_table: s(&r, "rtable"),
                    ref_column: s(&r, "rcolumn"),
                });
            }
            for t in order {
                metas.push(TableMeta {
                    columns: cols.remove(&t).unwrap_or_default(),
                    fks: fks.remove(&t).unwrap_or_default(),
                    name: t,
                });
            }
        }
        _ => {
            // SQLite: one PRAGMA pair per table, so `only` really matters here.
            let tables = query_rows(
                conn,
                "SELECT name AS tname FROM sqlite_master WHERE type = 'table' \
                 AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .await?;
            let mut order: Vec<String> = tables.iter().map(|r| s(r, "tname")).collect();
            if let Some(keep) = only {
                order.retain(|t| keep.iter().any(|k| k == t));
            }
            for t in order {
                let mut columns = Vec::new();
                for r in query_rows(
                    conn,
                    &format!("PRAGMA table_info(\"{}\")", t.replace('"', "\"\"")),
                )
                .await?
                {
                    let dtype = s(&r, "type");
                    let is_pk = opt_i64(&r, "pk").unwrap_or(0) > 0;
                    let default = r.get("dflt_value").map(|v| !v.is_null()).unwrap_or(false);
                    columns.push(ColMeta {
                        name: s(&r, "name"),
                        // INTEGER PRIMARY KEY is the rowid alias -> effectively auto-increment.
                        auto_inc: is_pk && dtype.to_uppercase().contains("INT"),
                        data_type: dtype,
                        nullable: opt_i64(&r, "notnull").unwrap_or(0) == 0,
                        is_pk,
                        has_default: default,
                        max_len: None,
                        scale: None,
                        enum_values: Vec::new(),
                    });
                }
                let mut fks = Vec::new();
                for r in query_rows(
                    conn,
                    &format!("PRAGMA foreign_key_list(\"{}\")", t.replace('"', "\"\"")),
                )
                .await
                .unwrap_or_default()
                {
                    fks.push(FkMeta {
                        column: s(&r, "from"),
                        ref_table: s(&r, "table"),
                        ref_column: s(&r, "to"),
                    });
                }
                metas.push(TableMeta {
                    name: t,
                    columns,
                    fks,
                });
            }
        }
    }

    Ok(metas)
}

/// Insertion order: parents before children. Kahn's algorithm, keeping the caller's order as
/// the tie-break so the result is stable. Returns the tables that are still part of a cycle.
pub fn topo_order(
    tables: &[String],
    fks: &HashMap<String, Vec<FkMeta>>,
) -> (Vec<String>, Vec<String>) {
    let in_scope: HashSet<&String> = tables.iter().collect();
    // deps[child] = parents that must be inserted first (self-references ignored: a row can
    // point at another row of the same table, which no ordering can fix).
    let mut deps: HashMap<String, HashSet<String>> = HashMap::new();
    for t in tables {
        let mut set = HashSet::new();
        for fk in fks.get(t).map(|v| v.as_slice()).unwrap_or(&[]) {
            if fk.ref_table != *t && in_scope.contains(&fk.ref_table) {
                set.insert(fk.ref_table.clone());
            }
        }
        deps.insert(t.clone(), set);
    }

    let mut out: Vec<String> = Vec::with_capacity(tables.len());
    let mut done: HashSet<String> = HashSet::new();
    loop {
        let mut progressed = false;
        for t in tables {
            if done.contains(t) {
                continue;
            }
            let ready = deps
                .get(t)
                .map(|d| d.iter().all(|p| done.contains(p)))
                .unwrap_or(true);
            if ready {
                out.push(t.clone());
                done.insert(t.clone());
                progressed = true;
            }
        }
        if !progressed {
            break;
        }
    }

    let cyclic: Vec<String> = tables
        .iter()
        .filter(|t| !done.contains(*t))
        .cloned()
        .collect();
    // Cyclic tables still have to be generated; they go last and need constraints turned off.
    let mut order = out;
    order.extend(cyclic.iter().cloned());
    (order, cyclic)
}
