//! Converting a file's cell into the value bound for a column — and, for a NEW table, guessing the
//! column's type from the file.
//!
//! These rules used to be TypeScript (`utils/tableImport.ts`), run over the whole file in the
//! webview. They moved here with the reading, because the dry run is a pass over the WHOLE file and
//! a 1GB file cannot be in the webview at all. There is no TS twin left: the dialog only shows what
//! `import_file_check` reports, and the import job only reports what `import_step` did.
//!
//! Errors are returned as keys (`Issue`, serialized camelCase), never text — the dialog translates
//! them, the same split `CellIssue` had.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::cell::Cell;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Family {
    Integer,
    Decimal,
    Float,
    Boolean,
    Date,
    Datetime,
    Time,
    Json,
    Uuid,
    Text,
    Other,
}

fn re(p: &str) -> Regex {
    Regex::new(p).expect("static regex")
}

static BOOL_TY: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(bool|boolean)\b|^tinyint\(1\)|^bit\(1\)$"));
static INT_TY: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^(tinyint|smallint|mediumint|int|integer|bigint|int2|int4|int8|serial|bigserial|smallserial)\b",
    )
});
static DEC_TY: LazyLock<Regex> = LazyLock::new(|| re(r"^(decimal|numeric|money|dec)\b"));
static FLOAT_TY: LazyLock<Regex> = LazyLock::new(|| re(r"^(real|float|double|float4|float8)\b"));
static DATETIME_TY: LazyLock<Regex> = LazyLock::new(|| re(r"^(timestamp|datetime)\b"));
static DATE_TY: LazyLock<Regex> = LazyLock::new(|| re(r"^date\b"));
static TIME_TY: LazyLock<Regex> = LazyLock::new(|| re(r"^time\b"));
static JSON_TY: LazyLock<Regex> = LazyLock::new(|| re(r"^jsonb?\b"));
static UUID_TY: LazyLock<Regex> = LazyLock::new(|| re(r"^uuid\b"));
static TEXT_TY: LazyLock<Regex> = LazyLock::new(|| re(r"(char|text|string|clob|enum|set\()"));
static MAX_LEN: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)^\s*(?:var)?char(?:acter)?(?:\s+varying)?\s*\(\s*(\d+)\s*\)|^\s*n?varchar\s*\(\s*(\d+)\s*\)",
    )
});

/// The kind of value a column holds, from its SQL type as `get_table_schema` reports it.
pub(crate) fn type_family(ty: &str) -> Family {
    let ty = ty.trim().to_lowercase();
    // MySQL spells BOOLEAN as tinyint(1).
    if BOOL_TY.is_match(&ty) {
        Family::Boolean
    } else if INT_TY.is_match(&ty) {
        Family::Integer
    } else if DEC_TY.is_match(&ty) {
        Family::Decimal
    } else if FLOAT_TY.is_match(&ty) {
        Family::Float
    } else if DATETIME_TY.is_match(&ty) {
        Family::Datetime
    } else if DATE_TY.is_match(&ty) {
        Family::Date
    } else if TIME_TY.is_match(&ty) {
        Family::Time
    } else if JSON_TY.is_match(&ty) {
        Family::Json
    } else if UUID_TY.is_match(&ty) {
        Family::Uuid
    } else if ty.is_empty() || TEXT_TY.is_match(&ty) {
        Family::Text
    } else {
        Family::Other
    }
}

/// The declared maximum length of a character column (`varchar(50)` → 50).
pub(crate) fn max_length_of(ty: &str) -> Option<usize> {
    let c = MAX_LEN.captures(ty)?;
    let n: usize = c.get(1).or_else(|| c.get(2))?.as_str().parse().ok()?;
    (n > 0).then_some(n)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Issue {
    Required,
    NotInteger,
    NotNumber,
    NotBoolean,
    NotDate,
    NotDateTime,
    NotTime,
    NotJson,
    NotUuid,
    TooLong,
}

/// A column as the conversion needs it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub nullable: bool,
}

/// A target with its type already classified — `type_family` is a run of regexes, and it would
/// otherwise run once per CELL.
pub(crate) struct Prepared {
    pub name: String,
    family: Family,
    max_len: Option<usize>,
    nullable: bool,
}

impl Prepared {
    pub(crate) fn new(t: &Target) -> Self {
        Prepared {
            name: t.name.clone(),
            family: type_family(&t.ty),
            max_len: max_length_of(&t.ty),
            nullable: t.nullable,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoerceOptions {
    /// An empty cell in a TEXT column is '' rather than NULL. Every other type reads it as NULL.
    #[serde(default)]
    pub empty_as_empty: bool,
    /// Trim blanks around every text value.
    #[serde(default = "yes")]
    pub trim: bool,
}

fn yes() -> bool {
    true
}

const TRUE_WORDS: [&str; 6] = ["true", "t", "yes", "y", "1", "on"];
const FALSE_WORDS: [&str; 6] = ["false", "f", "no", "n", "0", "off"];
/// 2^53 - 1: the last integer a JS number — and so the dialog — represents exactly.
const SAFE_INT: i64 = 9_007_199_254_740_991;

static INT_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^[+-]?\d+$"));
static NUM_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$"));
static DATE_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]00:00(?::00(?:\.0+)?)?)?$"));
static DATETIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$",
    )
});
static TIME_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$"));
static UUID_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$"));

pub(crate) fn valid_date(y: i32, m: u32, d: u32) -> bool {
    chrono::NaiveDate::from_ymd_opt(y, m, d).is_some()
}

fn num(n: &str) -> u32 {
    n.parse().unwrap_or(u32::MAX)
}

fn f64_value(v: f64) -> Option<Value> {
    serde_json::Number::from_f64(v).map(Value::Number)
}

/// One cell as the value to bind for a column, or why it cannot be.
///
/// Numbers that must stay exact travel as STRINGS: a DECIMAL (`0.1 + 0.2` has no exact double), and
/// an integer beyond 2^53. They are bound as text and — on Postgres — cast to the column's type, so
/// nothing is rounded on the way. Dates are only accepted in ISO order (`2026-09-25`): `03/04/2026`
/// is April or March depending on who wrote it, and guessing is how a whole column of dates goes in
/// silently wrong.
pub(crate) fn coerce_cell(raw: &Cell, col: &Prepared, opts: CoerceOptions) -> Result<Value, Issue> {
    let trimmed;
    let cell = match raw {
        Cell::Text(s) if opts.trim && s.trim().len() != s.len() => {
            trimmed = Cell::Text(s.trim().to_string());
            &trimmed
        }
        other => other,
    };

    let empty = matches!(cell, Cell::Null) || matches!(cell, Cell::Text(s) if s.is_empty());
    if empty {
        if col.family == Family::Text && matches!(cell, Cell::Text(_)) && opts.empty_as_empty {
            return Ok(Value::String(String::new()));
        }
        // An explicit NULL into a NOT NULL column fails even when the column has a default — the
        // default only applies to a column left OUT of the INSERT. So it is flagged either way.
        return if col.nullable {
            Ok(Value::Null)
        } else {
            Err(Issue::Required)
        };
    }

    match col.family {
        Family::Integer => match cell {
            Cell::Number { value, raw } => {
                if !value.is_finite() || value.fract() != 0.0 {
                    return Err(Issue::NotInteger);
                }
                if value.abs() <= SAFE_INT as f64 {
                    Ok(Value::from(*value as i64))
                } else if INT_RE.is_match(raw) {
                    Ok(Value::String(raw.trim_start_matches('+').to_string()))
                } else {
                    f64_value(*value).ok_or(Issue::NotInteger)
                }
            }
            Cell::Bool(b) => Ok(Value::from(i64::from(*b))),
            _ => {
                let s = cell.text();
                if !INT_RE.is_match(&s) {
                    return Err(Issue::NotInteger);
                }
                match s.parse::<i64>() {
                    Ok(n) if n.abs() <= SAFE_INT => Ok(Value::from(n)),
                    _ => Ok(Value::String(s.trim_start_matches('+').to_string())),
                }
            }
        },
        Family::Decimal => {
            let s = cell.text();
            if !NUM_RE.is_match(&s) {
                return Err(Issue::NotNumber);
            }
            Ok(Value::String(s.trim_start_matches('+').to_string()))
        }
        Family::Float => match cell {
            Cell::Number { value, .. } => f64_value(*value).ok_or(Issue::NotNumber),
            _ => {
                let s = cell.text();
                if !NUM_RE.is_match(&s) {
                    return Err(Issue::NotNumber);
                }
                s.parse::<f64>()
                    .ok()
                    .and_then(f64_value)
                    .ok_or(Issue::NotNumber)
            }
        },
        Family::Boolean => {
            if let Cell::Bool(b) = cell {
                return Ok(Value::Bool(*b));
            }
            let s = cell.text().to_lowercase();
            if TRUE_WORDS.contains(&s.as_str()) {
                Ok(Value::Bool(true))
            } else if FALSE_WORDS.contains(&s.as_str()) {
                Ok(Value::Bool(false))
            } else {
                Err(Issue::NotBoolean)
            }
        }
        Family::Date => {
            let s = cell.text();
            let c = DATE_RE.captures(&s).ok_or(Issue::NotDate)?;
            let (y, m, d) = (&c[1], &c[2], &c[3]);
            if !valid_date(y.parse().unwrap_or(0), num(m), num(d)) {
                return Err(Issue::NotDate);
            }
            Ok(Value::String(format!("{y}-{m:0>2}-{d:0>2}")))
        }
        Family::Datetime => {
            let s = cell.text();
            let c = DATETIME_RE.captures(&s).ok_or(Issue::NotDateTime)?;
            if !valid_date(c[1].parse().unwrap_or(0), num(&c[2]), num(&c[3])) {
                return Err(Issue::NotDateTime);
            }
            if let (Some(h), Some(mi)) = (c.get(4), c.get(5)) {
                let sec_bad = c.get(6).is_some_and(|x| num(x.as_str()) > 59);
                if num(h.as_str()) > 23 || num(mi.as_str()) > 59 || sec_bad {
                    return Err(Issue::NotDateTime);
                }
            }
            Ok(Value::String(s))
        }
        Family::Time => {
            let s = cell.text();
            let c = TIME_RE.captures(&s).ok_or(Issue::NotTime)?;
            let sec_bad = c.get(3).is_some_and(|x| num(x.as_str()) > 59);
            if num(&c[1]) > 23 || num(&c[2]) > 59 || sec_bad {
                return Err(Issue::NotTime);
            }
            Ok(Value::String(s))
        }
        Family::Json => match cell {
            Cell::Json(v) => Ok(Value::String(v.to_string())),
            _ => {
                let s = cell.text();
                if serde_json::from_str::<serde::de::IgnoredAny>(&s).is_err() {
                    return Err(Issue::NotJson);
                }
                Ok(Value::String(s))
            }
        },
        Family::Uuid => {
            let s = cell.text();
            if !UUID_RE.is_match(&s) {
                return Err(Issue::NotUuid);
            }
            Ok(Value::String(s))
        }
        Family::Text => {
            let s = cell.text();
            // Counted in characters, as the database counts them — not bytes.
            if col.max_len.is_some_and(|max| s.chars().count() > max) {
                return Err(Issue::TooLong);
            }
            Ok(Value::String(s))
        }
        // A type this module does not model (blob, geometry, an array, a domain): passed through
        // for the database to judge, rather than refused by a rule that might be wrong.
        Family::Other => Ok(match cell {
            Cell::Bool(b) => Value::Bool(*b),
            Cell::Number { value, raw } => {
                f64_value(*value).unwrap_or_else(|| Value::String(raw.clone()))
            }
            other => Value::String(other.text()),
        }),
    }
}

// ---------------------------------------------------------------------------------------------
// Type inference for a NEW table
// ---------------------------------------------------------------------------------------------

// The shapes below are checked byte by byte rather than with regexes: they run once per cell of the
// whole file, and a regex per cell was most of the time a type guess over a large file took.

/// `-?(0|[1-9][0-9]*)` at the start of `b`: (bytes used, digits). No leading zero and no `+`:
/// `0042` is a code and `+84…` a phone number, and a number column would drop what makes them so.
fn int_part(b: &[u8]) -> Option<(usize, usize)> {
    let neg = usize::from(b.first() == Some(&b'-'));
    let digits = b[neg..].iter().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 || (digits > 1 && b[neg] == b'0') {
        return None;
    }
    Some((neg + digits, digits))
}

fn infer_int(s: &str) -> bool {
    matches!(int_part(s.as_bytes()), Some((n, _)) if n == s.len()) && s.parse::<i64>().is_ok()
}

/// More significant digits than a double holds: a 20-digit id stored as a number would be rounded.
const INFER_MAX_DIGITS: usize = 15;

fn infer_num(s: &str) -> bool {
    let b = s.as_bytes();
    let digits_from = |i: usize| {
        b.get(i..)
            .map_or(0, |r| r.iter().take_while(|c| c.is_ascii_digit()).count())
    };
    let Some((mut i, mut digits)) = int_part(b) else {
        return false;
    };
    if b.get(i) == Some(&b'.') {
        let f = digits_from(i + 1);
        if f == 0 {
            return false;
        }
        i += 1 + f;
        digits += f;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let e = digits_from(i);
        if e == 0 {
            return false;
        }
        i += e;
    }
    i == b.len() && digits <= INFER_MAX_DIGITS
}

/// Starts with `dddd-dd-dd`.
fn date_shaped(b: &[u8]) -> bool {
    b.len() >= 10
        && b[..10].iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

/// `dddd-dd-dd`, optionally followed by `[ T]dd:dd[:dd[.d+]]`.
fn datetime_shaped(b: &[u8]) -> bool {
    if !date_shaped(b) {
        return false;
    }
    if b.len() == 10 {
        return true;
    }
    let digit = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    if !(matches!(b[10], b' ' | b'T')
        && digit(11)
        && digit(12)
        && b.get(13) == Some(&b':')
        && digit(14)
        && digit(15))
    {
        return false;
    }
    let mut i = 16;
    if b.get(i) == Some(&b':') {
        if !(digit(i + 1) && digit(i + 2)) {
            return false;
        }
        i += 3;
        if b.get(i) == Some(&b'.') {
            let f = b[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
            if f == 0 {
                return false;
            }
            i += 1 + f;
        }
    }
    i == b.len()
}

/// The time part of `YYYY-MM-DD HH:MM[:SS]`, if any, is a real time.
fn time_ok(s: &str) -> bool {
    let Some(t) = s.get(11..) else { return true };
    let mut parts = t.split([':', '.']).map(|p| p.parse::<u32>().unwrap_or(99));
    let (h, m, sec) = (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    );
    h <= 23 && m <= 59 && sec <= 59
}

/// What every non-empty value of one column has looked like so far.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Inference {
    any: bool,
    int: bool,
    num: bool,
    boolean: bool,
    date: bool,
    datetime: bool,
}

impl Default for Inference {
    fn default() -> Self {
        Inference {
            any: false,
            int: true,
            num: true,
            boolean: true,
            date: true,
            datetime: true,
        }
    }
}

impl Inference {
    pub(crate) fn see(&mut self, cell: &Cell) {
        if cell.is_blank() {
            return;
        }
        self.any = true;
        match cell {
            Cell::Bool(_) => {
                self.int = false;
                self.num = false;
                self.date = false;
                self.datetime = false;
            }
            Cell::Number { value, .. } => {
                if value.fract() != 0.0 || value.abs() > SAFE_INT as f64 {
                    self.int = false;
                }
                self.boolean = false;
                self.date = false;
                self.datetime = false;
            }
            Cell::Json(_) => {
                *self = Inference {
                    any: true,
                    int: false,
                    num: false,
                    boolean: false,
                    date: false,
                    datetime: false,
                };
            }
            Cell::Text(s) => {
                // Every flag is checked only while it can still be true: this runs once per cell of
                // the whole file, and most columns rule most types out on their first value.
                let s = s.trim();
                if self.int && !infer_int(s) {
                    self.int = false;
                }
                if self.num && !infer_num(s) {
                    self.num = false;
                }
                if self.boolean {
                    self.boolean =
                        s.eq_ignore_ascii_case("true") || s.eq_ignore_ascii_case("false");
                }
                if self.date || self.datetime {
                    // The same validity the conversion checks — a guessed DATE column that then
                    // refuses `2026-02-30` would fail an import the dry run never warned about.
                    // `date_shaped` first: it is ASCII, so slicing at 10 is then safe.
                    let real_date = date_shaped(s.as_bytes())
                        && chrono::NaiveDate::parse_from_str(&s[..10], "%Y-%m-%d").is_ok();
                    if self.date && !(real_date && s.len() == 10) {
                        self.date = false;
                    }
                    if self.datetime && !(real_date && datetime_shaped(s.as_bytes()) && time_ok(s))
                    {
                        self.datetime = false;
                    }
                }
            }
            Cell::Null => {}
        }
    }

    pub(crate) fn family(&self) -> Family {
        if !self.any {
            Family::Text
        } else if self.int {
            Family::Integer
        } else if self.num {
            Family::Float
        } else if self.boolean {
            Family::Boolean
        } else if self.date {
            Family::Date
        } else if self.datetime {
            Family::Datetime
        } else {
            Family::Text
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn col(ty: &str, nullable: bool) -> Prepared {
        Prepared::new(&Target {
            name: "c".into(),
            ty: ty.into(),
            nullable,
        })
    }
    const OPTS: CoerceOptions = CoerceOptions {
        empty_as_empty: false,
        trim: true,
    };
    fn t(s: &str) -> Cell {
        Cell::Text(s.into())
    }
    fn n(v: f64) -> Cell {
        Cell::Number {
            value: v,
            raw: v.to_string(),
        }
    }
    fn ok(cell: Cell, ty: &str) -> Value {
        coerce_cell(&cell, &col(ty, true), OPTS).unwrap()
    }
    fn bad(cell: Cell, ty: &str) -> Issue {
        coerce_cell(&cell, &col(ty, true), OPTS).unwrap_err()
    }

    #[test]
    fn families() {
        for (ty, fam) in [
            ("int(11)", Family::Integer),
            ("bigint unsigned", Family::Integer),
            ("serial", Family::Integer),
            ("interval", Family::Other),
            ("tinyint(1)", Family::Boolean),
            ("boolean", Family::Boolean),
            ("numeric(10,2)", Family::Decimal),
            ("double precision", Family::Float),
            ("timestamp without time zone", Family::Datetime),
            ("datetime", Family::Datetime),
            ("date", Family::Date),
            ("time", Family::Time),
            ("jsonb", Family::Json),
            ("uuid", Family::Uuid),
            ("character varying(50)", Family::Text),
            ("enum('a','b')", Family::Text),
            ("bytea", Family::Other),
        ] {
            assert_eq!(type_family(ty), fam, "{ty}");
        }
        assert_eq!(max_length_of("varchar(50)"), Some(50));
        assert_eq!(max_length_of("character varying(12)"), Some(12));
        assert_eq!(max_length_of("char(3)"), Some(3));
        assert_eq!(max_length_of("text"), None);
    }

    #[test]
    fn empty_is_null_except_in_a_text_column_when_asked() {
        assert_eq!(ok(t(""), "int"), Value::Null);
        assert_eq!(ok(t(""), "text"), Value::Null);
        let keep = CoerceOptions {
            empty_as_empty: true,
            trim: true,
        };
        assert_eq!(
            coerce_cell(&t(""), &col("text", true), keep).unwrap(),
            json!("")
        );
        // Blanks trimmed away are empty too.
        assert_eq!(ok(t("   "), "int"), Value::Null);
    }

    #[test]
    fn null_for_a_not_null_column_is_flagged() {
        assert_eq!(
            coerce_cell(&Cell::Null, &col("int", false), OPTS),
            Err(Issue::Required)
        );
        assert_eq!(
            coerce_cell(&t(""), &col("int", false), OPTS),
            Err(Issue::Required)
        );
    }

    #[test]
    fn integers_are_exact_and_big_ones_stay_text() {
        assert_eq!(ok(t(" 42 "), "int"), json!(42));
        assert_eq!(
            ok(t("9007199254740993"), "bigint"),
            json!("9007199254740993")
        );
        assert_eq!(ok(t("+7"), "int"), json!(7));
        assert_eq!(bad(t("4.5"), "int"), Issue::NotInteger);
        assert_eq!(bad(n(4.5), "int"), Issue::NotInteger);
        assert_eq!(ok(n(3.0), "int"), json!(3));
        assert_eq!(ok(Cell::Bool(true), "int"), json!(1));
    }

    #[test]
    fn decimals_stay_text_floats_become_numbers() {
        assert_eq!(ok(t("0.1"), "decimal(10,2)"), json!("0.1"));
        assert_eq!(ok(t("1e3"), "double"), json!(1000.0));
        assert_eq!(bad(t("1,5"), "numeric"), Issue::NotNumber);
        assert_eq!(
            ok(
                Cell::Number {
                    value: 0.1,
                    raw: "0.1".into()
                },
                "numeric"
            ),
            json!("0.1")
        );
    }

    #[test]
    fn booleans_in_the_usual_spellings() {
        for s in ["true", "Yes", "y", "1", "ON"] {
            assert_eq!(ok(t(s), "boolean"), json!(true), "{s}");
        }
        for s in ["false", "no", "0"] {
            assert_eq!(ok(t(s), "tinyint(1)"), json!(false), "{s}");
        }
        assert_eq!(ok(n(1.0), "boolean"), json!(true));
        assert_eq!(bad(t("maybe"), "boolean"), Issue::NotBoolean);
    }

    #[test]
    fn dates_only_in_iso_order_and_only_real_ones() {
        assert_eq!(ok(t("2026-9-5"), "date"), json!("2026-09-05"));
        assert_eq!(ok(t("2026-09-05 00:00:00"), "date"), json!("2026-09-05"));
        assert_eq!(bad(t("03/04/2026"), "date"), Issue::NotDate);
        assert_eq!(bad(t("2026-02-30"), "date"), Issue::NotDate);
        assert_eq!(ok(t("2024-02-29"), "date"), json!("2024-02-29"));
    }

    #[test]
    fn datetimes_and_times() {
        assert!(coerce_cell(&t("2026-09-05T10:20:30Z"), &col("timestamp", true), OPTS).is_ok());
        assert_eq!(bad(t("2026-09-05 25:00"), "datetime"), Issue::NotDateTime);
        assert!(coerce_cell(&t("23:59:59"), &col("time", true), OPTS).is_ok());
        assert_eq!(bad(t("24:00"), "time"), Issue::NotTime);
    }

    #[test]
    fn json_uuid_and_text_length() {
        assert_eq!(
            ok(Cell::Json(json!({"a": 1})), "jsonb"),
            json!(r#"{"a":1}"#)
        );
        assert_eq!(bad(t("{bad"), "json"), Issue::NotJson);
        assert_eq!(ok(t("42"), "json"), json!("42"));
        assert_eq!(bad(t("not-a-uuid"), "uuid"), Issue::NotUuid);
        assert_eq!(bad(t("abcd"), "varchar(3)"), Issue::TooLong);
        // Characters, not bytes or UTF-16 units: an emoji is one character.
        assert_eq!(ok(t("ab😀"), "varchar(3)"), json!("ab😀"));
        assert_eq!(
            ok(
                Cell::Number {
                    value: 12.0,
                    raw: "12".into()
                },
                "text"
            ),
            json!("12")
        );
    }

    #[test]
    fn a_type_it_does_not_model_passes_through() {
        assert_eq!(ok(t("\\x0102"), "bytea"), json!("\\x0102"));
    }

    fn infer(values: &[Cell]) -> Family {
        let mut i = Inference::default();
        for v in values {
            i.see(v);
        }
        i.family()
    }

    #[test]
    fn inference_keeps_codes_and_phone_numbers_as_text() {
        assert_eq!(infer(&[t("1"), t("-20"), t("")]), Family::Integer);
        assert_eq!(infer(&[t("1"), t("2.5")]), Family::Float);
        assert_eq!(infer(&[t("0042"), t("17")]), Family::Text);
        assert_eq!(infer(&[t("+84901234567")]), Family::Text);
        assert_eq!(infer(&[t("12345678901234567890")]), Family::Text);
        assert_eq!(infer(&[t("true"), t("FALSE")]), Family::Boolean);
        assert_eq!(infer(&[t("2026-01-02"), t("2026-01-03")]), Family::Date);
        assert_eq!(
            infer(&[t("2026-01-02"), t("2026-01-03 10:00")]),
            Family::Datetime
        );
        assert_eq!(infer(&[t("2026-02-30")]), Family::Text);
        assert_eq!(infer(&[t("2026-01-03 25:00")]), Family::Text);
        assert_eq!(infer(&[t("2026-01-03T10:00:05.123")]), Family::Datetime);
        assert_eq!(infer(&[t("2026-01-03 10:0")]), Family::Text);
        assert_eq!(infer(&[t("1.5e3"), t("-0.25"), t("0")]), Family::Float);
        assert_eq!(infer(&[t("1."), t("2")]), Family::Text);
        assert_eq!(infer(&[t("-0")]), Family::Integer);
        assert_eq!(infer(&[t("Nguyễn Văn A")]), Family::Text);
        assert_eq!(infer(&[n(1.0), n(2.5)]), Family::Float);
        assert_eq!(infer(&[Cell::Bool(true)]), Family::Boolean);
        assert_eq!(infer(&[t(""), Cell::Null]), Family::Text);
    }
}
