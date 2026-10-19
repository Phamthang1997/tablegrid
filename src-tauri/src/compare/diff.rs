//! Comparing two schema descriptions: which columns/indexes/FKs differ, and how.
//!
//! `norm_type` deliberately normalises `int(11)`/`INT` and `character varying`/`varchar` so that
//! MySQL 5.7-vs-8 or MySQL-vs-Postgres does not report noise — lengths still count.

use crate::compare::meta::{ColMeta, FkMeta, IdxMeta};

// ===================== Structure comparison =====================

/// Normalise a data type before comparing, so two sides that merely spell it differently are not
/// reported as different: drop the display width of integer types (MySQL 8 no longer has `int(11)`),
/// and fold synonymous names across dialects.
pub(super) fn norm_type(raw: &str) -> String {
    let mut t = raw.trim().to_ascii_lowercase();
    t = t.split_whitespace().collect::<Vec<_>>().join(" ");

    for base in [
        "tinyint",
        "smallint",
        "mediumint",
        "bigint",
        "int",
        "integer",
    ] {
        if let Some(rest) = t.strip_prefix(base) {
            if rest.starts_with('(')
                && let Some(close) = rest.find(')')
            {
                t = format!("{}{}", base, &rest[close + 1..]);
            }
            break;
        }
    }

    let (head, tail) = match t.find('(') {
        Some(i) => (t[..i].trim().to_string(), t[i..].to_string()),
        None => (t.clone(), String::new()),
    };
    let head = match head.as_str() {
        "integer" | "int4" | "serial" | "serial4" => "int",
        "int8" | "bigserial" | "serial8" => "bigint",
        "int2" | "smallserial" => "smallint",
        "character varying" | "varchar2" => "varchar",
        "character" | "bpchar" => "char",
        "bool" => "boolean",
        "double precision" | "float8" => "double",
        "float4" | "real" => "float",
        "timestamp without time zone" => "timestamp",
        "timestamp with time zone" | "timestamptz" => "timestamptz",
        "time without time zone" => "time",
        "decimal" | "numeric" => "decimal",
        "text" | "longtext" | "mediumtext" | "tinytext" | "clob" => "text",
        "blob" | "bytea" | "longblob" | "mediumblob" | "tinyblob" => "blob",
        other => other,
    };
    format!("{}{}", head, tail)
}

/// Whether two default values count as the same. Strips Postgres' quotes/casts
/// (`'x'::character varying` <-> MySQL's `x`) and ignores the case of constants
/// such as CURRENT_TIMESTAMP.
pub(super) fn norm_default(raw: Option<&str>) -> String {
    let mut d = match raw {
        None => return String::new(),
        Some(s) => s.trim().to_string(),
    };
    if let Some(i) = d.find("::") {
        d = d[..i].trim().to_string();
    }
    let d = d.trim_matches('\'').trim().to_ascii_lowercase();
    match d.as_str() {
        "now()" | "current_timestamp()" => "current_timestamp".to_string(),
        _ => d,
    }
}

pub(super) fn column_changes(a: &ColMeta, b: &ColMeta) -> Vec<&'static str> {
    let mut ch = Vec::new();
    if norm_type(&a.data_type) != norm_type(&b.data_type) {
        ch.push("type");
    }
    if a.nullable != b.nullable {
        ch.push("nullable");
    }
    if norm_default(a.default.as_deref()) != norm_default(b.default.as_deref()) {
        ch.push("default");
    }
    if a.auto_increment != b.auto_increment {
        ch.push("autoIncrement");
    }
    if a.comment.clone().unwrap_or_default() != b.comment.clone().unwrap_or_default() {
        ch.push("comment");
    }
    if a.position != b.position {
        ch.push("position");
    }
    ch
}

pub(super) fn index_changes(a: &IdxMeta, b: &IdxMeta) -> Vec<&'static str> {
    let mut ch = Vec::new();
    if a.columns != b.columns {
        ch.push("columns");
    }
    if a.unique != b.unique {
        ch.push("unique");
    }
    // Both Postgres: the same columns with another method, opclass or WITH (m=…) is a different
    // index. Across dialects there is nothing comparable, so only the columns count.
    if let (Some(x), Some(y)) = (&a.using, &b.using)
        && x != y
    {
        ch.push("definition");
    }
    ch
}

pub(super) fn fk_changes(a: &FkMeta, b: &FkMeta) -> Vec<&'static str> {
    let mut ch = Vec::new();
    if a.columns != b.columns {
        ch.push("columns");
    }
    if a.ref_table != b.ref_table {
        ch.push("refTable");
    }
    if a.ref_columns != b.ref_columns {
        ch.push("refColumns");
    }
    if !a
        .on_delete
        .clone()
        .unwrap_or_default()
        .eq_ignore_ascii_case(&b.on_delete.clone().unwrap_or_default())
    {
        ch.push("onDelete");
    }
    if !a
        .on_update
        .clone()
        .unwrap_or_default()
        .eq_ignore_ascii_case(&b.on_update.clone().unwrap_or_default())
    {
        ch.push("onUpdate");
    }
    ch
}

/// Compares view definitions after stripping whitespace, parentheses, quotes, typecasts and schema qualification —
/// two servers formatting differently is ordinary, only a real difference in the SQL is worth reporting.
pub(super) fn view_def_differs(
    a: Option<&String>,
    b: Option<&String>,
    src_db: &str,
    tgt_db: &str,
    name: &str,
) -> bool {
    fn squash(s: Option<&String>, db_name: &str) -> String {
        let mut str_val = match s {
            Some(v) => v.as_str().trim(),
            None => return String::new(),
        };
        if str_val.is_empty() {
            return String::new();
        }

        let lower = str_val.to_ascii_lowercase();
        // Cut off the "CREATE [OR REPLACE] [ALGORITHM=...] [DEFINER=...] VIEW view_name AS " prefix
        if let Some(v_idx) = lower.find("view ") {
            let after_view = &lower[v_idx + 5..];
            if let Some(as_idx) = after_view.find(" as ") {
                let cut_offset = v_idx + 5 + as_idx + 4;
                if cut_offset < str_val.len() {
                    str_val = &str_val[cut_offset..];
                }
            }
        } else if let Some(as_idx) = lower.find(" as ")
            && (lower.starts_with("create") || lower.starts_with("replace"))
        {
            str_val = &str_val[as_idx + 4..];
        }

        let mut cleaned = str_val
            .replace(['"', '`'], "")
            .replace("public.", "")
            .replace("PUBLIC.", "")
            .replace("dbo.", "")
            .replace("DBO.", "")
            .replace("::text", "")
            .replace("::character varying", "")
            .replace("::varchar", "")
            .replace("::integer", "")
            .replace("::int4", "")
            .replace("::int", "")
            .replace("::bigint", "")
            .replace("::int8", "")
            .replace("::boolean", "")
            .replace("::bool", "");

        if !db_name.is_empty() {
            let pfx1 = format!("{}.", db_name.trim());
            let pfx2 = pfx1.to_ascii_lowercase();
            cleaned = cleaned.replace(&pfx1, "").replace(&pfx2, "");
        }

        cleaned = cleaned.replace(['(', ')'], " ");

        cleaned
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .trim_end_matches(';')
            .to_ascii_lowercase()
    }
    let sa = squash(a, src_db);
    let sb = squash(b, tgt_db);
    if sa.is_empty() || sb.is_empty() {
        return false;
    }
    let differs = sa != sb;
    if differs {
        eprintln!("[VIEW DIFF] {}\n  SA: {}\n  SB: {}", name, sa, sb);
    }
    differs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pg_idx(using: &str) -> IdxMeta {
        IdxMeta {
            name: "i".into(),
            columns: vec!["embedding".into()],
            unique: false,
            using: Some(using.into()),
        }
    }

    /// Same column, another opclass or build parameter: a different index on Postgres.
    #[test]
    fn a_postgres_index_definition_change_is_a_difference() {
        let a = pg_idx(" USING hnsw (embedding vector_cosine_ops)");
        let b = pg_idx(" USING hnsw (embedding vector_l2_ops)");
        assert_eq!(index_changes(&a, &b), vec!["definition"]);
        assert!(index_changes(&a, &a.clone()).is_empty());
        // Across dialects one side has no definition: only the columns are comparable.
        let mysql = IdxMeta {
            using: None,
            ..a.clone()
        };
        assert!(index_changes(&a, &mysql).is_empty());
    }

    /// MySQL 8 dropped the display width, so the same column reads `int(11)` on 5.7 and `int` on
    /// 8. Reporting that as a difference is pure noise.
    #[test]
    fn integer_display_width_is_not_a_difference() {
        assert_eq!(norm_type("int(11)"), "int");
        assert_eq!(norm_type("INT(11) UNSIGNED"), norm_type("int unsigned"));
        assert_eq!(norm_type("bigint(20)"), "bigint");
        assert_eq!(norm_type("tinyint(1)"), "tinyint");
    }

    /// The same type spelled the MySQL way and the Postgres way must fold together, or every
    /// cross-dialect comparison is one big diff.
    #[test]
    fn cross_dialect_synonyms_fold_together() {
        assert_eq!(norm_type("character varying(50)"), norm_type("VARCHAR(50)"));
        assert_eq!(norm_type("integer"), norm_type("int"));
        assert_eq!(norm_type("int8"), norm_type("bigint"));
        assert_eq!(norm_type("bool"), norm_type("BOOLEAN"));
        assert_eq!(norm_type("double precision"), norm_type("double"));
        assert_eq!(
            norm_type("timestamp without time zone"),
            norm_type("TIMESTAMP")
        );
        assert_eq!(norm_type("numeric(10,2)"), norm_type("DECIMAL(10,2)"));
        assert_eq!(norm_type("bytea"), norm_type("BLOB"));
        assert_eq!(norm_type("longtext"), norm_type("TEXT"));
    }

    /// Length still counts — it is a real schema difference, not a spelling one.
    #[test]
    fn length_is_still_a_difference() {
        assert_ne!(norm_type("varchar(50)"), norm_type("varchar(100)"));
        assert_ne!(norm_type("decimal(10,2)"), norm_type("decimal(10,4)"));
    }

    /// A serial IS an int with a sequence attached; the sequence shows up elsewhere in the diff.
    #[test]
    fn serial_normalises_to_its_underlying_integer() {
        assert_eq!(norm_type("serial"), "int");
        assert_eq!(norm_type("bigserial"), "bigint");
        assert_eq!(norm_type("smallserial"), "smallint");
    }

    /// Postgres writes a default as `'x'::character varying`, MySQL as `x`. Same default.
    #[test]
    fn a_postgres_cast_and_quotes_are_stripped_from_a_default() {
        assert_eq!(norm_default(Some("'x'::character varying")), "x");
        assert_eq!(norm_default(Some("'x'")), "x");
        assert_eq!(norm_default(Some("  0  ")), "0");
        assert_eq!(norm_default(None), "");
    }

    #[test]
    fn the_current_timestamp_spellings_are_one_default() {
        let want = "current_timestamp";
        assert_eq!(norm_default(Some("now()")), want);
        assert_eq!(norm_default(Some("CURRENT_TIMESTAMP")), want);
        assert_eq!(norm_default(Some("current_timestamp()")), want);
    }
}
