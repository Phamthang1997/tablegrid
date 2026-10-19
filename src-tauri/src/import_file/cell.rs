//! One value read from a file, before it is converted for a column.

use serde_json::Value;

/// A cell as the FILE holds it. CSV only ever produces `Text`; Excel and JSON also carry numbers,
/// booleans and (JSON) nested values, and the conversion rules treat those differently from the
/// same characters in a string — a JSON `1.5` into an integer column is "not an integer", a cell
/// `"1.5"` too, but a JSON `true` into an integer column is 1.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Cell {
    Null,
    Text(String),
    /// A number, with the text the file wrote it as. `raw` is what a DECIMAL column is given, so
    /// `0.1` stays `0.1` instead of going through a double.
    Number {
        value: f64,
        raw: String,
    },
    Bool(bool),
    /// A JSON object or array.
    Json(Value),
}

impl Cell {
    /// The cell as text — what JavaScript's `String(v)` gave the old TypeScript rules, which is
    /// the form every text-matching rule reads.
    pub(crate) fn text(&self) -> String {
        match self {
            Cell::Null => String::new(),
            Cell::Text(s) => s.clone(),
            Cell::Number { raw, .. } => raw.clone(),
            Cell::Bool(b) => b.to_string(),
            Cell::Json(v) => v.to_string(),
        }
    }

    /// Empty, or only blanks — a row made only of these is not a row anyone meant to import.
    pub(crate) fn is_blank(&self) -> bool {
        match self {
            Cell::Null => true,
            Cell::Text(s) => s.trim().is_empty(),
            _ => false,
        }
    }

    /// A short form for the dialog: the problem list and the sample grid.
    pub(crate) fn display(&self) -> String {
        clip(&self.text(), 80)
    }

    /// A JSON value from a JSON file as a cell.
    pub(crate) fn from_json(v: Value) -> Cell {
        match v {
            Value::Null => Cell::Null,
            Value::Bool(b) => Cell::Bool(b),
            Value::String(s) => Cell::Text(s),
            Value::Number(n) => Cell::Number {
                value: n.as_f64().unwrap_or(f64::NAN),
                raw: n.to_string(),
            },
            other => Cell::Json(other),
        }
    }
}

/// At most `max` characters (not bytes — a Vietnamese or Japanese value must not be cut inside a
/// character), with `…` when something was dropped.
pub(crate) fn clip(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &s[..at]),
        None => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clip_counts_characters_not_bytes() {
        assert_eq!(clip("Tiếng Việt", 5), "Tiếng…");
        assert_eq!(clip("abc", 3), "abc");
    }

    #[test]
    fn json_values_keep_their_kind() {
        assert_eq!(Cell::from_json(json!(true)), Cell::Bool(true));
        assert_eq!(Cell::from_json(json!(null)), Cell::Null);
        let Cell::Number { value, raw } = Cell::from_json(json!(42)) else {
            panic!()
        };
        assert_eq!((value, raw.as_str()), (42.0, "42"));
        assert_eq!(Cell::from_json(json!({"a": 1})).text(), r#"{"a":1}"#);
    }

    #[test]
    fn blank_is_whitespace_or_null_only() {
        assert!(Cell::Text("  ".into()).is_blank());
        assert!(Cell::Null.is_blank());
        assert!(!Cell::Bool(false).is_blank());
        assert!(!Cell::Text("0".into()).is_blank());
    }
}
