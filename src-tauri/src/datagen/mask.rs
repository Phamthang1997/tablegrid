//! Masking: rewriting the sensitive columns of rows that are being EXPORTED (a dump, a CSV, a
//! copy into another database), so a production dump can be handed to a developer.
//!
//! It lives in `datagen/` because its `fake` rule IS the data generator: the same `ColState` /
//! `base_cell` that fills a table produces the replacement, so there is one set of generators and
//! no TypeScript twin (see the module comment in `mod.rs`).
//!
//! Three properties are the point of this file, and each has a test:
//!
//! 1. **Deterministic per value, keyed per export.** A replacement is derived from
//!    HMAC-SHA256(key, rule domain ‖ value): the same e-mail becomes the same fake e-mail in
//!    `customer.email` and in `orders.customer_email`, so a JOIN or a UNIQUE index in the dump
//!    still holds. Pure randomness would break both. The key is chosen per export (the frontend
//!    draws it from the OS RNG), so without it the mapping cannot be recomputed — and a
//!    dictionary of likely e-mails cannot be checked against the output.
//! 2. **Fail closed.** An unknown rule, a binary value or an empty key is an ERROR, never a
//!    pass-through: an export that silently writes the original value of a column the user asked
//!    to mask is the one failure this feature must not have.
//! 3. **NULL stays NULL.** A missing value reveals nothing, and turning it into a value could
//!    break a NOT NULL-free column's meaning (and an `IS NULL` test in the developer's code).

use std::collections::HashMap;

use chrono::{Duration, NaiveDate};
use hmac::{Hmac, KeyInit, Mac};
use serde::Deserialize;
use serde_json::Value;
use sha2::Sha256;

use super::column::ColState;
use super::rng::Rng;
use super::spec::{Cell, GenColumnSpec, o_i64, o_str};
use super::text::luhn_complete;

/// Error literals (Vietnamese, like the rest of the backend) — translated by `backendErrors.ts`.
pub const MASK_KEY_EMPTY: &str = "Thiếu khoá che dữ liệu";

/// One column's rule, as the frontend sends it (`utils/masking.ts` `MaskRule`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskRule {
    pub kind: String,
    #[serde(default)]
    pub options: Option<Value>,
}

enum Kind {
    Null,
    Redact(String),
    Partial { start: usize, end: usize, ch: char },
    EmailMask { keep_domain: bool },
    HashEmail { domain: String },
    Hash { prefix: String, len: usize },
    Digits { keep_end: usize },
    Card { keep_start: usize },
    Fake(Box<ColState>),
    DateShift { days: i64 },
}

struct Compiled {
    column: String,
    kind: Kind,
    /// What goes into the HMAC next to the value. Two columns with the same rule share it, which
    /// is what makes the same value mask the same way in both.
    domain: String,
}

pub struct Masker {
    key: Vec<u8>,
    rules: Vec<Compiled>,
}

fn opt_usize(o: &Option<Value>, key: &str, default: usize) -> usize {
    o_i64(o, key)
        .map(|v| v.clamp(0, 1000) as usize)
        .unwrap_or(default)
}

impl Masker {
    pub fn new(key: &str, columns: &HashMap<String, MaskRule>) -> Result<Self, String> {
        if key.trim().is_empty() {
            return Err(MASK_KEY_EMPTY.to_string());
        }
        let mut rules = Vec::with_capacity(columns.len());
        // Sorted so the build is deterministic whatever order the map iterates in.
        let mut names: Vec<&String> = columns.keys().collect();
        names.sort();
        for column in names {
            let rule = &columns[column];
            let o = &rule.options;
            let kind = match rule.kind.as_str() {
                "keep" => continue,
                "null" => Kind::Null,
                "redact" => Kind::Redact(o_str(o, "text").unwrap_or_else(|| "***".to_string())),
                "partial" => Kind::Partial {
                    start: opt_usize(o, "keepStart", 1),
                    end: opt_usize(o, "keepEnd", 0),
                    ch: o_str(o, "maskChar")
                        .and_then(|s| s.chars().next())
                        .unwrap_or('*'),
                },
                "emailMask" => Kind::EmailMask {
                    keep_domain: o
                        .as_ref()
                        .and_then(|v| v.get("keepDomain"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                },
                "hashEmail" => Kind::HashEmail {
                    domain: o_str(o, "domain").unwrap_or_else(|| "example.com".to_string()),
                },
                "hash" => Kind::Hash {
                    prefix: o_str(o, "prefix").unwrap_or_default(),
                    len: opt_usize(o, "length", 12).clamp(4, 64),
                },
                "digits" => Kind::Digits {
                    keep_end: opt_usize(o, "keepEnd", 0),
                },
                "card" => Kind::Card {
                    keep_start: opt_usize(o, "keepStart", 0),
                },
                "dateShift" => Kind::DateShift {
                    days: o_i64(o, "days").unwrap_or(30).clamp(1, 36_500),
                },
                "fake" => {
                    let generator = o_str(o, "generator").unwrap_or_default();
                    if generator.is_empty()
                        || matches!(
                            generator.as_str(),
                            "foreignKey" | "sequence" | "expression" | "skip"
                        )
                    {
                        return Err(format!(
                            "Quy tắc che dữ liệu của cột '{}' không hợp lệ: {}",
                            column, rule.kind
                        ));
                    }
                    let spec = GenColumnSpec {
                        column: column.clone(),
                        generator,
                        options: rule.options.clone(),
                        ..Default::default()
                    };
                    Kind::Fake(Box::new(ColState::new(0, "mask", &spec)?))
                }
                other => {
                    return Err(format!(
                        "Quy tắc che dữ liệu của cột '{}' không hợp lệ: {}",
                        column, other
                    ));
                }
            };
            let domain = match &kind {
                // A fake value depends on the generator AND its options (locale, domains…).
                Kind::Fake(s) => format!(
                    "fake:{}:{}",
                    s.generator,
                    rule.options
                        .as_ref()
                        .map(|v| v.to_string())
                        .unwrap_or_default()
                ),
                _ => format!(
                    "{}:{}",
                    rule.kind,
                    rule.options
                        .as_ref()
                        .map(|v| v.to_string())
                        .unwrap_or_default()
                ),
            };
            rules.push(Compiled {
                column: column.clone(),
                kind,
                domain,
            });
        }
        Ok(Masker {
            key: key.as_bytes().to_vec(),
            rules,
        })
    }

    fn digest(&self, domain: &str, value: &str) -> [u8; 32] {
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&self.key)
            .expect("HMAC takes a key of any length");
        mac.update(domain.as_bytes());
        mac.update(&[0]);
        mac.update(value.as_bytes());
        mac.finalize().into_bytes().into()
    }

    fn rng_for(&self, domain: &str, value: &str) -> Rng {
        let d = self.digest(domain, value);
        Rng::new(u64::from_le_bytes(d[..8].try_into().unwrap()))
    }

    fn hex(&self, domain: &str, value: &str, len: usize) -> String {
        let mut out = String::new();
        let mut round = 0u32;
        while out.len() < len {
            let d = self.digest(domain, &format!("{value}\u{0}{round}"));
            for b in d {
                out.push_str(&format!("{b:02x}"));
            }
            round += 1;
        }
        out.truncate(len);
        out
    }

    /// Masks every rule's column in each row, in place. Rows without the column are left alone.
    pub fn mask_rows(&mut self, rows: &mut [Value]) -> Result<(), String> {
        for i in 0..self.rules.len() {
            for row in rows.iter_mut() {
                let Some(obj) = row.as_object_mut() else {
                    continue;
                };
                let column = self.rules[i].column.clone();
                let Some(v) = obj.get(&column) else { continue };
                if v.is_null() {
                    continue;
                }
                let masked = self.mask_value(i, v)?;
                obj.insert(column, masked);
            }
        }
        Ok(())
    }

    fn mask_value(&mut self, i: usize, v: &Value) -> Result<Value, String> {
        let column = &self.rules[i].column;
        // A byte array is how a BLOB reaches the frontend; no text rule means anything there, and
        // passing it through would be exactly the leak this refuses.
        if matches!(&self.rules[i].kind, Kind::Null) {
            return Ok(Value::Null);
        }
        if v.is_array() && v.as_array().is_some_and(|a| a.iter().all(Value::is_u64)) {
            return Err(format!("Không che được cột nhị phân '{}'", column));
        }
        let was_number = v.is_number();
        let text = match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            other => other.to_string(),
        };
        let domain = self.rules[i].domain.clone();
        let out = match &self.rules[i].kind {
            Kind::Null => unreachable!(),
            Kind::Redact(r) => r.clone(),
            Kind::Partial { start, end, ch } => partial(&text, *start, *end, *ch),
            Kind::EmailMask { keep_domain } => match text.rsplit_once('@') {
                Some((local, dom)) => {
                    let first: String = local.chars().take(1).collect();
                    let dom = if *keep_domain { dom } else { "example.com" };
                    format!("{first}****@{dom}")
                }
                None => partial(&text, 1, 0, '*'),
            },
            Kind::HashEmail { domain: d } => {
                format!("user_{}@{}", self.hex(&domain, &text.to_lowercase(), 12), d)
            }
            Kind::Hash { prefix, len } => format!("{prefix}{}", self.hex(&domain, &text, *len)),
            Kind::Digits { keep_end } => {
                let mut rng = self.rng_for(&domain, &text);
                let total = text.chars().filter(char::is_ascii_digit).count();
                let mut seen = 0usize;
                text.chars()
                    .map(|c| {
                        if !c.is_ascii_digit() {
                            return c;
                        }
                        seen += 1;
                        if seen > total.saturating_sub(*keep_end) {
                            return c;
                        }
                        // The first digit of a number never becomes 0, so 1234 stays a 4-digit number.
                        let d = if seen == 1 && was_number {
                            1 + rng.below(9)
                        } else {
                            rng.below(10)
                        };
                        char::from(b'0' + d as u8)
                    })
                    .collect()
            }
            Kind::Card { keep_start } => {
                card(&text, *keep_start, &mut self.rng_for(&domain, &text))
            }
            Kind::DateShift { days } => {
                let mut rng = self.rng_for(&domain, &text);
                let mut shift = rng.range_i64(-*days, *days);
                if shift == 0 {
                    shift = 1;
                }
                match text
                    .get(..10)
                    .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
                {
                    Some(d) => format!(
                        "{}{}",
                        (d + Duration::days(shift)).format("%Y-%m-%d"),
                        &text[10..]
                    ),
                    None => {
                        return Err(format!(
                            "Cột '{}' không phải ngày tháng (YYYY-MM-DD…), không dịch ngày được",
                            column
                        ));
                    }
                }
            }
            Kind::Fake(_) => {
                let rng = self.rng_for(&domain, &text);
                let Kind::Fake(state) = &mut self.rules[i].kind else {
                    unreachable!()
                };
                state.rng = rng;
                return Ok(match state.base_cell("postgres")? {
                    Cell::Null => Value::Null,
                    Cell::Bool(b) => Value::Bool(b),
                    Cell::Num(n) => n
                        .parse::<serde_json::Number>()
                        .map(Value::Number)
                        .unwrap_or(Value::String(n)),
                    Cell::Text(s) | Cell::Raw(s) => Value::String(s),
                });
            }
        };
        // A number masked digit by digit is still a number: the dump writes it unquoted and an
        // integer column accepts it back.
        if was_number && let Ok(n) = out.parse::<serde_json::Number>() {
            return Ok(Value::Number(n));
        }
        Ok(Value::String(out))
    }
}

/// `abcdef` with start 1 / end 1 → `a****f`. Too short to keep both ends: everything is masked.
fn partial(text: &str, start: usize, end: usize, ch: char) -> String {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    if n <= start + end {
        return std::iter::repeat_n(ch, n.max(1)).collect();
    }
    chars
        .iter()
        .enumerate()
        .map(|(i, c)| if i < start || i >= n - end { *c } else { ch })
        .collect()
}

/// A card number of the same length and layout (spaces, dashes kept), Luhn-valid, keeping the
/// first `keep_start` digits (the issuer prefix) when asked.
fn card(text: &str, keep_start: usize, rng: &mut Rng) -> String {
    let digits: Vec<char> = text.chars().filter(char::is_ascii_digit).collect();
    if digits.len() < 2 {
        return digits
            .iter()
            .map(|_| char::from(b'0' + rng.below(10) as u8))
            .collect();
    }
    let keep = keep_start.min(digits.len() - 1);
    let mut body: String = digits[..keep].iter().collect();
    while body.len() < digits.len() - 1 {
        body.push(char::from(b'0' + rng.below(10) as u8));
    }
    let full: Vec<char> = luhn_complete(&body).chars().collect();
    let mut k = 0;
    text.chars()
        .map(|c| {
            if c.is_ascii_digit() {
                k += 1;
                full[k - 1]
            } else {
                c
            }
        })
        .collect()
}

/// Masks a page of rows. Pure CPU, so it runs off the async runtime's worker threads.
#[tauri::command]
pub async fn mask_rows(
    key: String,
    columns: HashMap<String, MaskRule>,
    rows: Vec<Value>,
) -> Result<Vec<Value>, String> {
    Box::pin(async move {
        tauri::async_runtime::spawn_blocking(move || {
            let mut masker = Masker::new(&key, &columns)?;
            let mut rows = rows;
            masker.mask_rows(&mut rows)?;
            Ok(rows)
        })
        .await
        .map_err(|e| e.to_string())?
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules(pairs: &[(&str, Value)]) -> HashMap<String, MaskRule> {
        pairs
            .iter()
            .map(|(c, r)| {
                (
                    c.to_string(),
                    serde_json::from_value::<MaskRule>(r.clone()).unwrap(),
                )
            })
            .collect()
    }

    fn mask(key: &str, r: &HashMap<String, MaskRule>, rows: Value) -> Vec<Value> {
        let mut rows: Vec<Value> = serde_json::from_value(rows).unwrap();
        Masker::new(key, r).unwrap().mask_rows(&mut rows).unwrap();
        rows
    }

    /// The property a dump depends on: the same value masks the same way in two columns (and two
    /// tables) under one key, so JOINs and UNIQUE indexes still hold — and another key gives
    /// another mapping.
    #[test]
    fn the_same_value_masks_the_same_way_under_one_key() {
        let r = rules(&[
            ("email", json!({"kind": "hashEmail"})),
            ("customer_email", json!({"kind": "hashEmail"})),
        ]);
        let a = mask(
            "k1",
            &r,
            json!([{"email": "Mary@x.org", "customer_email": "mary@x.org"}, {"email": "bob@x.org"}]),
        );
        assert_eq!(
            a[0]["email"], a[0]["customer_email"],
            "case-insensitive for e-mail, across columns"
        );
        assert_ne!(a[0]["email"], a[1]["email"]);
        assert!(a[0]["email"].as_str().unwrap().ends_with("@example.com"));
        let b = mask("k2", &r, json!([{"email": "mary@x.org"}]));
        assert_ne!(a[0]["email"], b[0]["email"], "the key decides the mapping");
        let again = mask("k1", &r, json!([{"email": "mary@x.org"}]));
        assert_eq!(
            a[0]["email"], again[0]["email"],
            "and is stable across pages and calls"
        );
    }

    #[test]
    fn null_stays_null_and_columns_without_a_rule_are_untouched() {
        let r = rules(&[("email", json!({"kind": "redact"}))]);
        let out = mask("k", &r, json!([{"email": null, "id": 7, "name": "Mary"}]));
        assert_eq!(out[0], json!({"email": null, "id": 7, "name": "Mary"}));
    }

    #[test]
    fn partial_and_email_masks_keep_what_they_say() {
        let r = rules(&[
            (
                "a",
                json!({"kind": "partial", "options": {"keepStart": 2, "keepEnd": 2}}),
            ),
            ("b", json!({"kind": "emailMask"})),
            (
                "c",
                json!({"kind": "emailMask", "options": {"keepDomain": true}}),
            ),
            ("d", json!({"kind": "partial"})),
        ]);
        let out = mask(
            "k",
            &r,
            json!([{"a": "0912345678", "b": "mary@corp.vn", "c": "mary@corp.vn", "d": "a"}]),
        );
        assert_eq!(out[0]["a"], "09******78");
        assert_eq!(out[0]["b"], "m****@example.com");
        assert_eq!(out[0]["c"], "m****@corp.vn");
        assert_eq!(
            out[0]["d"], "*",
            "too short to keep the first character: all masked"
        );
    }

    #[test]
    fn digits_keep_the_layout_and_the_type() {
        let r = rules(&[
            (
                "phone",
                json!({"kind": "digits", "options": {"keepEnd": 2}}),
            ),
            ("n", json!({"kind": "digits"})),
        ]);
        let out = mask("k", &r, json!([{"phone": "+84 (91) 234-5678", "n": 1234}]));
        let p = out[0]["phone"].as_str().unwrap();
        assert_eq!(p.len(), "+84 (91) 234-5678".len());
        assert!(
            p.starts_with('+') && p.contains(" (") && p.ends_with("78"),
            "{p}"
        );
        assert_ne!(p, "+84 (91) 234-5678");
        let n = out[0]["n"].as_i64().expect("a number stays a number");
        assert!((1000..10_000).contains(&n), "{n}");
    }

    fn luhn_ok(s: &str) -> bool {
        let digits: Vec<u32> = s.chars().filter_map(|c| c.to_digit(10)).collect();
        let sum: u32 = digits
            .iter()
            .rev()
            .enumerate()
            .map(|(i, &d)| {
                if i % 2 == 1 {
                    let x = d * 2;
                    if x > 9 { x - 9 } else { x }
                } else {
                    d
                }
            })
            .sum();
        sum.is_multiple_of(10)
    }

    #[test]
    fn card_numbers_stay_luhn_valid_with_their_layout_and_prefix() {
        let r = rules(&[("card", json!({"kind": "card", "options": {"keepStart": 4}}))]);
        let out = mask(
            "k",
            &r,
            json!([{"card": "4111 1111 1111 1111"}, {"card": "5500-0000-0000-0004"}]),
        );
        for (i, orig) in ["4111 1111 1111 1111", "5500-0000-0000-0004"]
            .iter()
            .enumerate()
        {
            let c = out[i]["card"].as_str().unwrap();
            assert_eq!(c.len(), orig.len());
            assert_eq!(&c[..4], &orig[..4], "issuer prefix kept");
            assert!(luhn_ok(c), "{c}");
            assert_ne!(&c, orig);
        }
    }

    #[test]
    fn fake_uses_the_data_generator_and_is_deterministic() {
        let r = rules(&[
            (
                "first_name",
                json!({"kind": "fake", "options": {"generator": "firstName"}}),
            ),
            (
                "ip",
                json!({"kind": "fake", "options": {"generator": "ipv4"}}),
            ),
        ]);
        let a = mask("k", &r, json!([{"first_name": "Mary", "ip": "10.0.0.1"}]));
        let b = mask("k", &r, json!([{"first_name": "Mary", "ip": "10.0.0.1"}]));
        assert_eq!(a, b);
        assert_eq!(a[0]["ip"].as_str().unwrap().split('.').count(), 4);
        assert!(!a[0]["first_name"].as_str().unwrap().is_empty());
    }

    #[test]
    fn date_shift_moves_a_date_and_keeps_the_time() {
        let r = rules(&[("d", json!({"kind": "dateShift", "options": {"days": 10}}))]);
        let out = mask("k", &r, json!([{"d": "1990-05-17 08:30:00"}]));
        let s = out[0]["d"].as_str().unwrap();
        assert!(s.ends_with(" 08:30:00"), "{s}");
        let d = NaiveDate::parse_from_str(&s[..10], "%Y-%m-%d").unwrap();
        let delta = (d - NaiveDate::from_ymd_opt(1990, 5, 17).unwrap()).num_days();
        assert!(delta != 0 && delta.abs() <= 10, "{delta}");
    }

    /// Fail closed: none of these may let the original value through.
    #[test]
    fn what_cannot_be_masked_is_an_error_not_a_pass_through() {
        assert!(
            Masker::new("", &rules(&[("a", json!({"kind": "redact"}))])).is_err(),
            "no key"
        );
        assert!(
            Masker::new("k", &rules(&[("a", json!({"kind": "rot13"}))])).is_err(),
            "unknown rule"
        );
        assert!(
            Masker::new(
                "k",
                &rules(&[(
                    "a",
                    json!({"kind": "fake", "options": {"generator": "foreignKey"}})
                )])
            )
            .is_err()
        );
        let mut m = Masker::new("k", &rules(&[("blob", json!({"kind": "hash"}))])).unwrap();
        let mut rows = vec![json!({"blob": [137, 80, 78, 71]})];
        assert!(m.mask_rows(&mut rows).is_err(), "binary");
        let mut m = Masker::new("k", &rules(&[("d", json!({"kind": "dateShift"}))])).unwrap();
        assert!(m.mask_rows(&mut [json!({"d": "not a date"})]).is_err());
        // `null` on a binary column is fine: nothing of the original survives.
        let mut m = Masker::new("k", &rules(&[("blob", json!({"kind": "null"}))])).unwrap();
        let mut rows = vec![json!({"blob": [1, 2]})];
        m.mask_rows(&mut rows).unwrap();
        assert!(rows[0]["blob"].is_null());
    }

    #[test]
    fn keep_is_no_rule_at_all() {
        let r = rules(&[("a", json!({"kind": "keep"}))]);
        assert_eq!(mask("k", &r, json!([{"a": "x"}])), vec![json!({"a": "x"})]);
    }
}
