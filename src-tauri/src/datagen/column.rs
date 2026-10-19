//! `ColState` — the value generator of ONE column: it keeps that column's state across the whole run
//! (the incrementing counter, the set of values already used for a UNIQUE constraint, the foreign-key pool).

use std::collections::HashSet;

use chrono::{NaiveTime, TimeDelta};
use serde_json::{Map, Value, json};

use crate::datagen::datasets as ds;

use super::regex::{Rx, parse_regex, sample_regex};
use super::rng::{Rng, mix_seed};
use super::spec::{
    Cell, GenColumnSpec, charset_of, date_bounds, datetime_bounds, o_arr, o_f64, o_i64, o_str,
    o_usize, o_val,
};
use super::template::expand_template;
use super::text::{
    cities, first_names, full_name, last_names, lorem_paragraph, lorem_sentence, lorem_words,
    luhn_complete, slug, streets, title_case, vi_deaccent,
};

/// Retries before giving up on a `unique` column.
pub(super) const UNIQUE_RETRIES: usize = 100;

// ===================== Column runtime state =====================

pub(super) struct ColState {
    /// `table.column` — used in every error message so it never needs an outer wrapper (a
    /// wrapped Vietnamese message could not be matched by `backendErrors.ts`).
    pub(super) name: String,
    pub(super) generator: String,
    pub(super) spec: GenColumnSpec,
    pub(super) rng: Rng,
    pub(super) unique: bool,
    pub(super) seen: HashSet<String>,
    pub(super) seq: i64,
    pub(super) seq_step: i64,
    pub(super) locale: String,
    pub(super) dist: String,
    /// `foreignKey`, `list`, `enumValues`
    pub(super) pool: Vec<Cell>,
    /// `weightedList` — cumulative weights so a pick is a binary search.
    pub(super) weighted: Vec<(Cell, f64)>,
    pub(super) rx: Option<Vec<Rx>>,
}

impl ColState {
    pub(super) fn new(seed: u64, table: &str, spec: &GenColumnSpec) -> Result<Self, String> {
        let qualified = format!("{}.{}", table, spec.column);
        let mut rx = None;
        if spec.generator == "regex" {
            let pattern = o_str(&spec.options, "pattern").unwrap_or_default();
            if pattern.is_empty() {
                return Err(format!("Cột '{}' thiếu biểu thức regex", qualified));
            }
            rx = Some(
                parse_regex(&pattern)
                    .map_err(|e| format!("Regex của cột '{}' không hợp lệ: {}", qualified, e))?,
            );
        }

        let mut pool: Vec<Cell> = Vec::new();
        if spec.generator == "list" || spec.generator == "enumValues" {
            pool = o_arr(&spec.options, "values")
                .iter()
                .map(Cell::from_json)
                .collect();
            if pool.is_empty() {
                return Err(format!("Cột '{}' chưa có danh sách giá trị", qualified));
            }
        }

        let mut weighted: Vec<(Cell, f64)> = Vec::new();
        if spec.generator == "weightedList" {
            let mut acc = 0.0;
            for item in o_arr(&spec.options, "values") {
                // Accepts [value, weight] or {value, weight}.
                let (v, w) = match &item {
                    Value::Array(a) => (
                        a.first().cloned().unwrap_or(Value::Null),
                        a.get(1).and_then(|w| w.as_f64()).unwrap_or(1.0),
                    ),
                    Value::Object(o) => (
                        o.get("value").cloned().unwrap_or(Value::Null),
                        o.get("weight").and_then(|w| w.as_f64()).unwrap_or(1.0),
                    ),
                    other => (other.clone(), 1.0),
                };
                if w <= 0.0 {
                    continue;
                }
                acc += w;
                weighted.push((Cell::from_json(&v), acc));
            }
            if weighted.is_empty() {
                return Err(format!(
                    "Cột '{}' chưa có danh sách giá trị có trọng số",
                    qualified
                ));
            }
        }

        Ok(ColState {
            name: qualified,
            generator: spec.generator.clone(),
            spec: spec.clone(),
            rng: Rng::new(mix_seed(seed, table, &spec.column)),
            unique: spec.unique.unwrap_or(false),
            seen: HashSet::new(),
            seq: o_i64(&spec.options, "start").unwrap_or(1),
            seq_step: o_i64(&spec.options, "step").unwrap_or(1).max(1),
            locale: o_str(&spec.options, "locale").unwrap_or_else(|| "en".to_string()),
            dist: o_str(&spec.options, "distribution").unwrap_or_else(|| "uniform".to_string()),
            pool,
            weighted,
            rx,
        })
    }

    /// One value, honouring nullPercent / unique / prefix / suffix / case.
    pub(super) fn next_cell(&mut self, dialect: &str) -> Result<Cell, String> {
        if let Some(p) = self.spec.null_percent
            && self.rng.chance(p)
        {
            return Ok(Cell::Null);
        }
        let attempts = if self.unique { UNIQUE_RETRIES } else { 1 };
        for _ in 0..attempts {
            let base = self.base_cell(dialect)?;
            let cell = self.decorate(base);
            if !self.unique {
                return Ok(cell);
            }
            if self.seen.insert(cell.key()) {
                return Ok(cell);
            }
        }
        Err(format!(
            "Không sinh đủ giá trị khác nhau cho cột '{}' sau {} lần thử",
            self.name, UNIQUE_RETRIES
        ))
    }

    pub(super) fn decorate(&mut self, cell: Cell) -> Cell {
        // Only text is decorated; a number keeps its exact literal. A vector is text only because
        // its literal is quoted: a prefix, a case change or an empty string would make it invalid.
        if self.generator == "vector" {
            return cell;
        }
        let text = match cell {
            Cell::Text(t) => t,
            other => return other,
        };
        if let Some(p) = self.spec.empty_percent
            && self.rng.chance(p)
        {
            return Cell::Text(String::new());
        }
        let mut out = match self.spec.case.as_deref() {
            Some("upper") => text.to_uppercase(),
            Some("lower") => text.to_lowercase(),
            Some("title") => title_case(&text),
            _ => text,
        };
        if let Some(p) = &self.spec.prefix {
            out = format!("{p}{out}");
        }
        if let Some(s) = &self.spec.suffix {
            out.push_str(s);
        }
        Cell::Text(out)
    }

    /// Unit sample in `[0, 1)` shaped by the `distribution` option.
    pub(super) fn shaped_unit(&mut self) -> f64 {
        match self.dist.as_str() {
            "normal" => (self.rng.normal() * 0.18 + 0.5).clamp(0.0, 0.999_999),
            "exponential" => {
                let u = 1.0 - self.rng.unit();
                (-u.ln() / 4.0).clamp(0.0, 0.999_999)
            }
            _ => self.rng.unit(),
        }
    }

    pub(super) fn base_cell(&mut self, dialect: &str) -> Result<Cell, String> {
        let opts = self.spec.options.clone();
        let g = self.generator.clone();
        let loc = self.locale.clone();

        let cell = match g.as_str() {
            "null" => Cell::Null,

            // ---- numbers ----
            "integer" | "smallint" | "bigint" => {
                let min = o_i64(&opts, "min").unwrap_or(1);
                let max = o_i64(&opts, "max").unwrap_or(if g == "bigint" {
                    1_000_000_000
                } else {
                    100_000
                });
                let unit = self.shaped_unit();
                let span = (max as i128 - min as i128).unsigned_abs() as f64;
                Cell::Num(((min.min(max) as f64) + unit * span).round().to_string())
            }
            "decimal" => {
                let min = o_f64(&opts, "min").unwrap_or(0.0);
                let max = o_f64(&opts, "max").unwrap_or(10_000.0);
                let scale = o_usize(&opts, "scale").unwrap_or(2).min(10);
                let unit = self.shaped_unit();
                let v = min + unit * (max - min);
                Cell::Num(format!("{v:.scale$}"))
            }
            "float" => {
                let min = o_f64(&opts, "min").unwrap_or(0.0);
                let max = o_f64(&opts, "max").unwrap_or(1.0);
                let unit = self.shaped_unit();
                Cell::Num(format!("{:.6}", min + unit * (max - min)))
            }
            "bool" => {
                let p = o_f64(&opts, "truePercent").unwrap_or(50.0);
                Cell::Bool(self.rng.chance(p))
            }
            "sequence" => {
                let v = self.seq;
                self.seq = self.seq.saturating_add(self.seq_step);
                Cell::Num(v.to_string())
            }
            "year" => {
                let min = o_i64(&opts, "min").unwrap_or(1990);
                let max = o_i64(&opts, "max").unwrap_or(2030);
                Cell::Num(self.rng.range_i64(min, max).to_string())
            }
            "latitude" => Cell::Num(format!("{:.6}", -90.0 + self.rng.unit() * 180.0)),
            "longitude" => Cell::Num(format!("{:.6}", -180.0 + self.rng.unit() * 360.0)),

            // ---- date / time ----
            "date" => {
                let (min, max) = date_bounds(&opts);
                let days = (max - min).num_days().max(0);
                let d = min
                    .checked_add_signed(TimeDelta::days(self.rng.range_i64(0, days)))
                    .unwrap_or(min);
                Cell::Text(d.format("%Y-%m-%d").to_string())
            }
            "time" => {
                let secs = self.rng.below(86_400) as u32;
                let t = NaiveTime::from_num_seconds_from_midnight_opt(secs, 0)
                    .unwrap_or_else(|| NaiveTime::from_hms_opt(0, 0, 0).unwrap());
                Cell::Text(t.format("%H:%M:%S").to_string())
            }
            "datetime" | "timestamp" => {
                let (min, max) = datetime_bounds(&opts);
                let secs = (max - min).num_seconds().max(0);
                let dt = min
                    .checked_add_signed(TimeDelta::seconds(self.rng.range_i64(0, secs)))
                    .unwrap_or(min);
                Cell::Text(dt.format("%Y-%m-%d %H:%M:%S").to_string())
            }

            // ---- text ----
            "string" => {
                let charset = charset_of(&opts);
                let min_len = o_usize(&opts, "minLength").unwrap_or(5);
                let max_len = o_usize(&opts, "maxLength")
                    .unwrap_or(min_len.max(12))
                    .max(min_len);
                let len = min_len + self.rng.below((max_len - min_len + 1) as u64) as usize;
                let mut out = String::with_capacity(len);
                for _ in 0..len {
                    out.push(*self.rng.pick(&charset));
                }
                Cell::Text(out)
            }
            "password" => {
                const CS: &[u8] =
                    b"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*";
                let len = o_usize(&opts, "length").unwrap_or(12).clamp(4, 64);
                let mut out = String::with_capacity(len);
                for _ in 0..len {
                    out.push(*self.rng.pick(CS) as char);
                }
                Cell::Text(out)
            }
            "word" => Cell::Text(lorem_words(&mut self.rng, 1)),
            "title" => {
                // Word count first: `lorem_words(&mut self.rng, self.rng...)` would borrow
                // `self.rng` twice in one expression.
                let n = 2 + self.rng.below(3) as usize;
                Cell::Text(title_case(&lorem_words(&mut self.rng, n)))
            }
            "sentence" => Cell::Text(lorem_sentence(&mut self.rng)),
            "paragraph" | "text" => {
                let max_len = o_usize(&opts, "maxLength").unwrap_or(0);
                let mut out = if g == "text" {
                    lorem_sentence(&mut self.rng)
                } else {
                    lorem_paragraph(&mut self.rng)
                };
                if max_len > 0 && out.chars().count() > max_len {
                    out = out.chars().take(max_len).collect();
                }
                Cell::Text(out)
            }
            "template" => {
                let pattern = o_str(&opts, "pattern").unwrap_or_else(|| "??-####".to_string());
                Cell::Text(expand_template(&pattern, &mut self.rng))
            }
            "regex" => {
                let mut out = String::new();
                // take/put back instead of clone: the AST would otherwise be cloned per row.
                if let Some(rx) = self.rx.take() {
                    sample_regex(&rx, &mut self.rng, &mut out);
                    self.rx = Some(rx);
                }
                Cell::Text(out)
            }
            "uuid" => {
                let mut b = [0u8; 16];
                for chunk in b.chunks_mut(8) {
                    let v = self.rng.next_u64().to_le_bytes();
                    chunk.copy_from_slice(&v[..chunk.len()]);
                }
                // Version 4 + RFC 4122 variant bits.
                b[6] = (b[6] & 0x0f) | 0x40;
                b[8] = (b[8] & 0x3f) | 0x80;
                let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
                Cell::Text(format!(
                    "{}-{}-{}-{}-{}",
                    &hex[0..8],
                    &hex[8..12],
                    &hex[12..16],
                    &hex[16..20],
                    &hex[20..32]
                ))
            }
            "json" => {
                let keys = o_arr(&opts, "keys");
                let mut map = Map::new();
                if keys.is_empty() {
                    map.insert("id".into(), json!(self.rng.range_i64(1, 100_000)));
                    map.insert("name".into(), json!(lorem_words(&mut self.rng, 2)));
                    map.insert("active".into(), json!(self.rng.chance(70.0)));
                } else {
                    for k in keys {
                        let key = k.as_str().unwrap_or("key").to_string();
                        map.insert(key, json!(lorem_words(&mut self.rng, 1)));
                    }
                }
                Cell::Text(Value::Object(map).to_string())
            }
            "blob" => {
                let len = o_usize(&opts, "length").unwrap_or(8).clamp(1, 4096);
                let mut hex = String::with_capacity(len * 2);
                for _ in 0..len {
                    hex.push_str(&format!("{:02x}", self.rng.below(256) as u8));
                }
                Cell::Raw(match dialect {
                    "postgres" => format!("'\\x{hex}'::bytea"),
                    _ => format!("X'{hex}'"),
                })
            }
            "expression" => {
                let sql = o_str(&opts, "sql").unwrap_or_default();
                if sql.trim().is_empty() {
                    return Err(format!("Cột '{}' chưa có biểu thức SQL", self.name));
                }
                Cell::Raw(sql)
            }

            // ---- lists ----
            "list" | "enumValues" => {
                let idx = self.rng.below(self.pool.len() as u64) as usize;
                self.pool[idx].clone()
            }
            "weightedList" => {
                let total = self.weighted.last().map(|(_, w)| *w).unwrap_or(1.0);
                let target = self.rng.unit() * total;
                let idx = self
                    .weighted
                    .partition_point(|(_, cum)| *cum <= target)
                    .min(self.weighted.len() - 1);
                self.weighted[idx].0.clone()
            }
            "foreignKey" => {
                if self.pool.is_empty() {
                    Cell::Null
                } else {
                    let idx = self.rng.below(self.pool.len() as u64) as usize;
                    self.pool[idx].clone()
                }
            }

            // ---- meaningful ----
            "firstName" => Cell::Text(self.rng.pick(first_names(&loc)).to_string()),
            "lastName" => Cell::Text(self.rng.pick(last_names(&loc)).to_string()),
            "fullName" => Cell::Text(full_name(&mut self.rng, &loc)),
            "gender" => Cell::Text(if self.rng.chance(50.0) {
                "male".into()
            } else {
                "female".into()
            }),
            "email" => {
                let domains = {
                    let custom: Vec<String> = o_arr(&opts, "domains")
                        .iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect();
                    if custom.is_empty() {
                        ds::EMAIL_DOMAINS.iter().map(|d| d.to_string()).collect()
                    } else {
                        custom
                    }
                };
                let first = self.rng.pick(first_names(&loc)).to_string();
                let last = self.rng.pick(last_names(&loc)).to_string();
                let local = slug(&vi_deaccent(&format!("{first} {last}")));
                let n = self.rng.below(1000);
                let domain = self.rng.pick(&domains).clone();
                Cell::Text(format!("{local}{n}@{domain}"))
            }
            "username" => {
                let first = self.rng.pick(first_names(&loc)).to_string();
                let n = self.rng.below(10_000);
                Cell::Text(format!("{}{}", vi_deaccent(&first), n))
            }
            "phone" => {
                if loc == "vi" {
                    const PREFIX: &[&str] = &[
                        "032", "033", "034", "035", "036", "037", "038", "039", "070", "076",
                        "077", "078", "079", "081", "082", "083", "084", "085", "086", "088",
                        "090", "091", "094", "096", "097", "098",
                    ];
                    Cell::Text(format!(
                        "{}{:07}",
                        self.rng.pick(PREFIX),
                        self.rng.below(10_000_000)
                    ))
                } else {
                    Cell::Text(format!(
                        "+1-{:03}-{:03}-{:04}",
                        200 + self.rng.below(700),
                        self.rng.below(1000),
                        self.rng.below(10_000)
                    ))
                }
            }
            "city" => Cell::Text(self.rng.pick(cities(&loc)).to_string()),
            "country" => Cell::Text(self.rng.pick(ds::COUNTRIES).to_string()),
            "countryCode" => Cell::Text(self.rng.pick(ds::COUNTRY_CODES).to_string()),
            "street" => {
                let no = 1 + self.rng.below(300);
                Cell::Text(format!("{no} {}", self.rng.pick(streets(&loc))))
            }
            "address" => {
                let no = 1 + self.rng.below(300);
                let street = self.rng.pick(streets(&loc)).to_string();
                let city = self.rng.pick(cities(&loc)).to_string();
                Cell::Text(format!("{no} {street}, {city}"))
            }
            "zipCode" => Cell::Text(format!("{:05}", self.rng.below(100_000))),
            "timezone" => Cell::Text(self.rng.pick(ds::TIMEZONES).to_string()),
            "company" => Cell::Text(format!(
                "{} {}",
                self.rng.pick(ds::COMPANY_WORDS),
                self.rng.pick(ds::COMPANY_SUFFIX)
            )),
            "department" => Cell::Text(self.rng.pick(ds::DEPARTMENTS).to_string()),
            "jobTitle" => Cell::Text(self.rng.pick(ds::JOB_TITLES).to_string()),
            "productName" => Cell::Text(format!(
                "{} {}",
                self.rng.pick(ds::PRODUCT_ADJECTIVES),
                self.rng.pick(ds::PRODUCT_NOUNS)
            )),
            "sku" => Cell::Text(format!(
                "{}{}-{:05}",
                (b'A' + self.rng.below(26) as u8) as char,
                (b'A' + self.rng.below(26) as u8) as char,
                self.rng.below(100_000)
            )),
            "currencyCode" => Cell::Text(self.rng.pick(ds::CURRENCY_CODES).to_string()),
            "orderStatus" => Cell::Text(self.rng.pick(ds::ORDER_STATUSES).to_string()),
            "creditCard" => {
                let mut digits = String::with_capacity(15);
                digits.push('4');
                for _ in 0..14 {
                    digits.push_str(&self.rng.below(10).to_string());
                }
                Cell::Text(luhn_complete(&digits))
            }
            "ipv4" => Cell::Text(format!(
                "{}.{}.{}.{}",
                1 + self.rng.below(223),
                self.rng.below(256),
                self.rng.below(256),
                1 + self.rng.below(254)
            )),
            "ipv6" => {
                let groups: Vec<String> = (0..8)
                    .map(|_| format!("{:04x}", self.rng.below(65_536)))
                    .collect();
                Cell::Text(groups.join(":"))
            }
            "macAddress" => {
                let bytes: Vec<String> = (0..6)
                    .map(|_| format!("{:02x}", self.rng.below(256)))
                    .collect();
                Cell::Text(bytes.join(":"))
            }
            "domain" => Cell::Text(self.rng.pick(ds::URL_HOSTS).to_string()),
            "url" => {
                let host = self.rng.pick(ds::URL_HOSTS).to_string();
                let path = self.rng.pick(ds::URL_PATHS).to_string();
                Cell::Text(if path.is_empty() {
                    format!("https://{host}")
                } else {
                    format!("https://{host}/{path}")
                })
            }
            "hexColor" => Cell::Text(format!("#{:06x}", self.rng.below(0x100_0000))),
            "mimeType" => Cell::Text(self.rng.pick(ds::MIME_TYPES).to_string()),
            "fileName" => Cell::Text(format!(
                "{}-{}.{}",
                lorem_words(&mut self.rng, 1),
                self.rng.below(1000),
                self.rng.pick(ds::FILE_EXTENSIONS)
            )),

            // ---- pgvector ----
            "vector" => {
                let dims = o_usize(&opts, "dimensions").unwrap_or(3);
                let non_zero = if o_val(&opts, "sparse")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    Some(o_usize(&opts, "nonZero").unwrap_or(10))
                } else {
                    None
                };
                let normalize = o_val(&opts, "normalize")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                Cell::Text(super::vector::random_vector(
                    &mut self.rng,
                    dims,
                    non_zero,
                    normalize,
                ))
            }

            other => return Err(format!("Generator '{other}' không được hỗ trợ")),
        };
        Ok(cell)
    }
}
