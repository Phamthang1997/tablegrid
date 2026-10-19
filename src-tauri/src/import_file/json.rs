//! JSON read an element at a time: a top-level array (`[{…}, {…}]`) or NDJSON / JSON Lines
//! (`{…}\n{…}`), so a 1GB array never has to be one parsed value.
//!
//! The scanner only finds where each element ENDS — depth, strings, escapes — and hands that slice
//! to serde_json. Every byte it looks at is ASCII, so it works on bytes of UTF-8.

use std::fmt;
use std::io::BufRead;

use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::Value;

/// One element of the file.
pub(crate) enum JsonRow {
    /// An object, its keys IN FILE ORDER — serde_json's own map sorts them (the crate is built
    /// without `preserve_order`), and the order of first appearance is the column order the user
    /// expects.
    Object(Vec<(String, Value)>),
    /// An array: a row of positional cells (`[["id","name"],[1,"a"]]`).
    Array(Vec<Value>),
    /// Anything else: a one-cell row.
    Scalar(Value),
}

impl<'de> serde::Deserialize<'de> for JsonRow {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = JsonRow;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<JsonRow, A::Error> {
                let mut out = Vec::new();
                while let Some((k, v)) = m.next_entry::<String, Value>()? {
                    out.push((k, v));
                }
                Ok(JsonRow::Object(out))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<JsonRow, A::Error> {
                let mut out = Vec::new();
                while let Some(v) = s.next_element::<Value>()? {
                    out.push(v);
                }
                Ok(JsonRow::Array(out))
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<JsonRow, E> {
                Ok(JsonRow::Scalar(Value::Bool(v)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<JsonRow, E> {
                Ok(JsonRow::Scalar(Value::from(v)))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<JsonRow, E> {
                Ok(JsonRow::Scalar(Value::from(v)))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<JsonRow, E> {
                Ok(JsonRow::Scalar(
                    serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number),
                ))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<JsonRow, E> {
                Ok(JsonRow::Scalar(Value::String(v.to_string())))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<JsonRow, E> {
                Ok(JsonRow::Scalar(Value::String(v)))
            }
            fn visit_unit<E: de::Error>(self) -> Result<JsonRow, E> {
                Ok(JsonRow::Scalar(Value::Null))
            }
        }
        d.deserialize_any(V)
    }
}

#[derive(PartialEq)]
enum Top {
    /// Nothing but whitespace (and a BOM) seen yet.
    Start,
    /// Inside a top-level `[`: elements are separated by `,` and the `]` ends the file.
    Array,
    /// A stream of values separated by whitespace (NDJSON, or values just concatenated).
    Stream,
    /// The top-level array has been closed.
    Done,
}

/// Reads every element and hands it to `emit` with its 1-based position. `emit` returns false to
/// stop early.
pub(crate) fn read_json(
    input: &mut dyn BufRead,
    emit: &mut dyn FnMut(u64, JsonRow) -> Result<bool, String>,
) -> Result<(), String> {
    let mut top = Top::Start;
    let mut elem: Vec<u8> = Vec::new();
    let mut depth: u32 = 0;
    let mut in_str = false;
    let mut escape = false;
    let mut n: u64 = 0;

    // Parses the collected element, if any. Returns false when `emit` asked to stop.
    let mut flush = |elem: &mut Vec<u8>, n: &mut u64| -> Result<bool, String> {
        if elem.is_empty() {
            return Ok(true);
        }
        *n += 1;
        let row: JsonRow = serde_json::from_slice(elem)
            .map_err(|e| format!("JSON không hợp lệ ở phần tử thứ {}: {e}", *n))?;
        elem.clear();
        emit(*n, row)
    };

    loop {
        let buf = input
            .fill_buf()
            .map_err(|e| format!("Không đọc được tệp: {e}"))?;
        if buf.is_empty() {
            break;
        }
        let len = buf.len();
        let mut i = 0;
        while i < len {
            let b = buf[i];
            if in_str {
                // Copy up to the next quote or backslash in one go.
                if escape {
                    escape = false;
                    elem.push(b);
                    i += 1;
                    continue;
                }
                let end = buf[i..]
                    .iter()
                    .position(|&c| c == b'"' || c == b'\\')
                    .map_or(len, |p| i + p);
                elem.extend_from_slice(&buf[i..end]);
                i = end;
                if i < len {
                    elem.push(buf[i]);
                    if buf[i] == b'"' {
                        in_str = false;
                    } else {
                        escape = true;
                    }
                    i += 1;
                }
                continue;
            }
            match b {
                b' ' | b'\t' | b'\r' | b'\n' if depth == 0 => {
                    // Whitespace ends a top-level scalar (`1 2` in a stream).
                    if !elem.is_empty() && !flush(&mut elem, &mut n)? {
                        return Ok(());
                    }
                }
                0xEF | 0xBB | 0xBF if top == Top::Start && elem.is_empty() => {} // a UTF-8 BOM
                b'[' if top == Top::Start && elem.is_empty() => top = Top::Array,
                b',' if depth == 0 && top == Top::Array => {
                    if !flush(&mut elem, &mut n)? {
                        return Ok(());
                    }
                }
                b']' if depth == 0 && top == Top::Array => {
                    if !flush(&mut elem, &mut n)? {
                        return Ok(());
                    }
                    top = Top::Done;
                }
                _ if top == Top::Done => {
                    return Err(format!(
                        "JSON không hợp lệ ở phần tử thứ {}: trailing characters after the array",
                        n + 1
                    ));
                }
                _ => {
                    if top == Top::Start {
                        top = Top::Stream;
                    }
                    match b {
                        b'"' => in_str = true,
                        b'{' | b'[' => depth += 1,
                        b'}' | b']' => depth = depth.saturating_sub(1),
                        _ => {}
                    }
                    elem.push(b);
                    // A container closing at depth 0 is a whole element in a stream.
                    if depth == 0
                        && matches!(b, b'}' | b']')
                        && top == Top::Stream
                        && !flush(&mut elem, &mut n)?
                    {
                        return Ok(());
                    }
                }
            }
            i += 1;
        }
        input.consume(len);
    }
    if in_str || depth > 0 || top == Top::Array {
        return Err(format!(
            "JSON không hợp lệ ở phần tử thứ {}: unexpected end of file",
            n + 1
        ));
    }
    flush(&mut elem, &mut n)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::BufReader;

    fn read_with(text: &str, cap: usize) -> Result<Vec<Value>, String> {
        let mut out = Vec::new();
        let mut r = BufReader::with_capacity(cap, text.as_bytes());
        read_json(&mut r, &mut |_, row| {
            out.push(match row {
                JsonRow::Object(kv) => {
                    Value::Array(kv.into_iter().map(|(k, v)| json!([k, v])).collect())
                }
                JsonRow::Array(a) => json!({ "arr": a }),
                JsonRow::Scalar(v) => json!({ "scalar": v }),
            });
            Ok(true)
        })?;
        Ok(out)
    }

    fn read(text: &str) -> Vec<Value> {
        let whole = read_with(text, 1 << 16).unwrap();
        for cap in 1..6 {
            assert_eq!(read_with(text, cap).unwrap(), whole, "buffer of {cap}");
        }
        whole
    }

    #[test]
    fn an_array_of_objects_keeps_key_order() {
        let got = read(r#" [ {"b": 1, "a": "x,]}"}, {"a": [1, {"c": "\"]"}]} ] "#);
        assert_eq!(
            got,
            vec![
                json!([["b", 1], ["a", "x,]}"]]),
                json!([["a", [1, {"c": "\"]"}]]])
            ]
        );
    }

    #[test]
    fn ndjson_and_a_bom() {
        let got = read("\u{feff}{\"a\":1}\n{\"a\":2}\r\n\n{\"a\":3}");
        assert_eq!(got.len(), 3);
        assert_eq!(got[2], json!([["a", 3]]));
    }

    #[test]
    fn arrays_and_scalars_are_rows_too() {
        assert_eq!(
            read("[[1,\"a\"],[2]]"),
            vec![json!({"arr": [1, "a"]}), json!({"arr": [2]})]
        );
        assert_eq!(read("[1, \"x\", null]").len(), 3);
        assert_eq!(read("[]").len(), 0);
    }

    #[test]
    fn a_broken_element_names_its_position() {
        let e = read_with(r#"[{"a":1},{"a":}]"#, 64).unwrap_err();
        assert!(e.contains("thứ 2"), "{e}");
        assert!(read_with(r#"[{"a":1}"#, 64).is_err());
        assert!(read_with(r#"[{"a":1}] x"#, 64).is_err());
    }
}
