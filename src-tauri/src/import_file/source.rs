//! What a file IS (CSV, JSON, Excel or a SQL dump; plain, gzipped or inside a zip), and reading
//! its rows in order whatever it is.
//!
//! What a file is comes from its bytes first and its name second, the rule `dump_file.rs` set: a
//! `.gz` is recognised by the gzip magic, an .xlsx by being a zip holding `xl/workbook.xml`, a
//! pg_dump archive by `PGDMP`. The name decides between CSV and JSON inside a container, because
//! the two cannot always be told apart from a few bytes (a one-column CSV of `[1]` lines).

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use flate2::read::MultiGzDecoder;
use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use super::cell::Cell;
use super::csv::{detect_delimiter, read_csv};
use super::json::{JsonRow, read_json};
use super::text::{DecodeReader, encoding_for};
use super::xlsx::read_xlsx;
use crate::database::detect_pg_archive;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Kind {
    Csv,
    Json,
    Xlsx,
    /// A SQL script or a pg_dump archive: not rows, so it goes to the restore path
    /// (`restore_backup`), which already reads a file of any size from disk.
    Sql,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Container {
    Plain,
    Gzip,
    /// The named entry of a .zip.
    Zip(String),
}

#[derive(Debug, Clone)]
pub(crate) struct Detected {
    pub kind: Kind,
    pub container: Container,
    pub file_bytes: u64,
}

impl Detected {
    pub(crate) fn to_json(&self) -> serde_json::Value {
        let (compression, entry) = match &self.container {
            Container::Plain => (None, None),
            Container::Gzip => (Some("gzip"), None),
            Container::Zip(e) => (Some("zip"), Some(e.clone())),
        };
        serde_json::json!({
            "kind": self.kind,
            "compression": compression,
            "entry": entry,
            "fileBytes": self.file_bytes,
        })
    }
}

/// How to read the file, as the dialog's options say.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceOptions {
    /// A text file's encoding label; UTF-8 when absent.
    pub encoding: Option<String>,
    /// `,` `;` `\t` `|`; detected from the first lines when absent.
    pub delimiter: Option<String>,
    /// Whether the first row names the columns (CSV, Excel, a JSON array of arrays).
    pub has_header: Option<bool>,
    /// The Excel sheet, 0-based in workbook order.
    pub sheet: Option<usize>,
}

impl SourceOptions {
    pub(crate) fn has_header(&self) -> bool {
        self.has_header.unwrap_or(true)
    }
}

pub(crate) fn open_error(e: impl std::fmt::Display) -> String {
    format!("Không mở được tệp: {e}")
}

pub(crate) fn read_error(e: impl std::fmt::Display) -> String {
    format!("Không đọc được tệp: {e}")
}

const XLS_UNSUPPORTED: &str =
    "Tệp .xls (Excel 97-2003) không được hỗ trợ — hãy lưu lại thành .xlsx hoặc CSV";
const ZIP_NOTHING_TO_READ: &str = "Tệp nén .zip không chứa tệp CSV/JSON nào";
const UNSUPPORTED: &str = "Định dạng tệp không được hỗ trợ";

fn ext_of(name: &str) -> &str {
    name.rsplit_once('.').map_or("", |(_, e)| e)
}

/// What a file name says, if anything.
fn kind_by_name(name: &str) -> Option<Result<Kind, String>> {
    Some(Ok(match ext_of(name) {
        "csv" | "tsv" | "tab" | "txt" | "psv" => Kind::Csv,
        "json" | "ndjson" | "jsonl" => Kind::Json,
        "xlsx" | "xlsm" => Kind::Xlsx,
        "sql" | "dump" | "backup" | "psql" | "pgsql" | "tar" => Kind::Sql,
        "xls" => return Some(Err(XLS_UNSUPPORTED.to_string())),
        _ => return None,
    }))
}

/// What the first bytes look like, for a name that says nothing.
fn sniff(head: &[u8]) -> Kind {
    let text = String::from_utf8_lossy(head);
    let t = text.trim_start_matches('\u{feff}').trim_start();
    if t.starts_with('[') || t.starts_with('{') {
        return Kind::Json;
    }
    let upper: String = t.chars().take(16).collect::<String>().to_uppercase();
    const SQL_HEADS: [&str; 10] = [
        "--", "/*", "CREATE ", "INSERT ", "SET ", "DROP ", "USE ", "BEGIN", "START ", "COPY ",
    ];
    if SQL_HEADS.iter().any(|h| upper.starts_with(h)) {
        return Kind::Sql;
    }
    Kind::Csv
}

fn read_head(r: &mut dyn Read, max: usize) -> std::io::Result<Vec<u8>> {
    let mut head = Vec::with_capacity(max);
    r.take(max as u64).read_to_end(&mut head)?;
    Ok(head)
}

/// The file name in lower case, `C:\a\B.CSV.GZ` → `b.csv.gz`.
fn lower_name(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_lowercase()
}

pub(crate) fn detect(path: &str) -> Result<Detected, String> {
    let mut file = File::open(path).map_err(open_error)?;
    let file_bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
    let head = read_head(&mut file, 8192).map_err(read_error)?;
    let name = lower_name(path);

    // A zip: an .xlsx, or a zip holding the file to import.
    if head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06") {
        file.seek(SeekFrom::Start(0)).map_err(read_error)?;
        let zip = ZipArchive::new(file).map_err(|e| format!("Tệp Excel không hợp lệ: {e}"))?;
        if zip.index_for_name("xl/workbook.xml").is_some() {
            return Ok(Detected {
                kind: Kind::Xlsx,
                container: Container::Plain,
                file_bytes,
            });
        }
        for i in 0..zip.len() {
            let Some(entry) = zip.name_for_index(i) else {
                continue;
            };
            if entry.ends_with('/') || entry.starts_with("__MACOSX/") {
                continue;
            }
            if let Some(Ok(kind @ (Kind::Csv | Kind::Json))) = kind_by_name(&entry.to_lowercase()) {
                return Ok(Detected {
                    kind,
                    container: Container::Zip(entry.to_string()),
                    file_bytes,
                });
            }
        }
        return Err(ZIP_NOTHING_TO_READ.to_string());
    }

    if detect_pg_archive(&head).is_some() {
        return Ok(Detected {
            kind: Kind::Sql,
            container: Container::Plain,
            file_bytes,
        });
    }

    if head.starts_with(&[0x1f, 0x8b]) {
        file.seek(SeekFrom::Start(0)).map_err(read_error)?;
        let inner =
            read_head(&mut MultiGzDecoder::new(BufReader::new(file)), 8192).map_err(read_error)?;
        let inner_name = name
            .strip_suffix(".gz")
            .or_else(|| name.strip_suffix(".gzip"))
            .unwrap_or(&name);
        let kind = if detect_pg_archive(&inner).is_some() {
            Kind::Sql
        } else {
            match kind_by_name(inner_name) {
                Some(k) => k?,
                None => sniff(&inner),
            }
        };
        if kind == Kind::Xlsx {
            return Err(UNSUPPORTED.to_string());
        }
        return Ok(Detected {
            kind,
            container: Container::Gzip,
            file_bytes,
        });
    }

    let kind = match kind_by_name(&name) {
        // A real .xlsx is a zip, handled above.
        Some(Ok(Kind::Xlsx)) => return Err("Tệp Excel không hợp lệ: not a zip file".to_string()),
        Some(k) => k?,
        None => sniff(&head),
    };
    Ok(Detected {
        kind,
        container: Container::Plain,
        file_bytes,
    })
}

/// Counts the bytes taken from the FILE — before decompression, so progress is a share of the size
/// the user sees.
struct Counting<R> {
    inner: R,
    read: Arc<AtomicU64>,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.read.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

impl<R: Seek> Seek for Counting<R> {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let at = self.inner.seek(pos)?;
        // A zip is read from its END first (the central directory); progress follows the position.
        self.read.store(at, Ordering::Relaxed);
        Ok(at)
    }
}

/// Opens the file's bytes — decompressed when it is a .gz or a zip entry — and hands them to `f`.
/// A closure rather than a returned reader because a zip entry borrows its archive.
fn with_bytes<T>(
    path: &str,
    det: &Detected,
    progress: &Arc<AtomicU64>,
    f: impl FnOnce(&mut dyn Read) -> Result<T, String>,
) -> Result<T, String> {
    let file = File::open(path).map_err(open_error)?;
    let counted = Counting {
        inner: file,
        read: progress.clone(),
    };
    match &det.container {
        Container::Plain => f(&mut BufReader::with_capacity(1 << 20, counted)),
        Container::Gzip => f(&mut MultiGzDecoder::new(BufReader::with_capacity(
            1 << 20,
            counted,
        ))),
        Container::Zip(entry) => {
            let mut zip =
                ZipArchive::new(BufReader::with_capacity(1 << 20, counted)).map_err(read_error)?;
            let mut e = zip.by_name(entry).map_err(read_error)?;
            f(&mut e)
        }
    }
}

/// A row as a reader produced it, before it is lined up with the header.
pub(crate) struct RawRecord {
    /// The number the user would look for: the record in a CSV, the row in Excel, the element in
    /// a JSON file.
    pub row: u64,
    pub cells: RawCells,
}

pub(crate) enum RawCells {
    Positional(Vec<Cell>),
    /// A JSON object: its keys name its columns.
    Keyed(Vec<(String, Cell)>),
}

/// What reading found out about the file on the way.
#[derive(Debug, Default, Clone)]
pub(crate) struct ReadInfo {
    pub delimiter: Option<u8>,
    pub sheets: Vec<String>,
}

pub(crate) fn delimiter_of(opt: Option<&str>) -> Option<u8> {
    match opt? {
        "\\t" | "\t" | "tab" => Some(b'\t'),
        s if s.len() == 1 => Some(s.as_bytes()[0]),
        _ => None,
    }
}

/// Reads every row of the file, in order, handing each to `emit` (which returns false to stop).
pub(crate) fn read_rows(
    path: &str,
    det: &Detected,
    opts: &SourceOptions,
    progress: &Arc<AtomicU64>,
    info: &mut ReadInfo,
    emit: &mut dyn FnMut(RawRecord) -> Result<bool, String>,
) -> Result<(), String> {
    match det.kind {
        Kind::Sql => Err(UNSUPPORTED.to_string()),
        Kind::Xlsx => {
            let file = File::open(path).map_err(open_error)?;
            let counted = Counting {
                inner: file,
                read: progress.clone(),
            };
            read_xlsx(
                BufReader::with_capacity(1 << 20, counted),
                opts.sheet.unwrap_or(0),
                &mut |names| info.sheets = names.to_vec(),
                &mut |row, cells| {
                    emit(RawRecord {
                        row,
                        cells: RawCells::Positional(cells),
                    })
                },
            )
        }
        Kind::Csv | Kind::Json => {
            let encoding = encoding_for(opts.encoding.as_deref())?;
            with_bytes(path, det, progress, |bytes| {
                let mut text =
                    BufReader::with_capacity(1 << 20, DecodeReader::new(bytes, encoding));
                if det.kind == Kind::Json {
                    return read_json(&mut text, &mut |row, el| {
                        let cells = match el {
                            JsonRow::Object(kv) => RawCells::Keyed(
                                kv.into_iter()
                                    .map(|(k, v)| (k, Cell::from_json(v)))
                                    .collect(),
                            ),
                            JsonRow::Array(a) => {
                                RawCells::Positional(a.into_iter().map(Cell::from_json).collect())
                            }
                            JsonRow::Scalar(v) => RawCells::Positional(vec![Cell::from_json(v)]),
                        };
                        emit(RawRecord { row, cells })
                    });
                }
                let delimiter = match delimiter_of(opts.delimiter.as_deref()) {
                    Some(d) => d,
                    None => {
                        let head = text.fill_buf().map_err(read_error)?;
                        detect_delimiter(&String::from_utf8_lossy(head))
                    }
                };
                info.delimiter = Some(delimiter);
                read_csv(&mut text, delimiter, &mut |row, fields| {
                    emit(RawRecord {
                        row,
                        cells: RawCells::Positional(fields.into_iter().map(Cell::Text).collect()),
                    })
                })
            })
        }
    }
}

/// A data row lined up with the header: `cells[i]` is the column `headers[i]`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Record {
    pub row: u64,
    pub cells: Vec<Cell>,
}

/// Turns raw rows into data rows under one header.
///
/// With a header row, the first non-blank row names the columns (a blank name becomes `Column N`,
/// a repeated one `name (2)`, so every source column can be picked). A row wider than the header
/// adds `Column N` columns; a JSON object adds its new keys. Columns are only ever APPENDED, so an
/// index into the header taken early — the dialog's mapping, made from the preview — still means
/// the same column at the end of the file. Rows that are entirely blank are dropped: a trailing
/// empty line, a formatted-but-empty Excel row.
pub(crate) struct Shaper {
    has_header: bool,
    header_taken: bool,
    pub headers: Vec<String>,
    name_count: HashMap<String, usize>,
    key_index: HashMap<String, usize>,
}

impl Shaper {
    pub(crate) fn new(has_header: bool) -> Self {
        Shaper {
            has_header,
            header_taken: false,
            headers: Vec::new(),
            name_count: HashMap::new(),
            key_index: HashMap::new(),
        }
    }

    fn add_header(&mut self, base: String) -> usize {
        let n = self.name_count.entry(base.clone()).or_insert(0);
        *n += 1;
        let name = if *n == 1 {
            base
        } else {
            format!("{base} ({n})")
        };
        self.headers.push(name);
        self.headers.len() - 1
    }

    pub(crate) fn shape(&mut self, raw: RawRecord) -> Option<Record> {
        match raw.cells {
            RawCells::Keyed(kv) => {
                if kv.iter().all(|(_, c)| c.is_blank()) {
                    return None;
                }
                let mut cells = vec![Cell::Null; self.headers.len()];
                for (k, v) in kv {
                    let idx = match self.key_index.get(&k) {
                        Some(&i) => i,
                        None => {
                            let i = self.add_header(k.clone());
                            self.key_index.insert(k, i);
                            i
                        }
                    };
                    if cells.len() <= idx {
                        cells.resize(idx + 1, Cell::Null);
                    }
                    cells[idx] = v;
                }
                cells.resize(self.headers.len(), Cell::Null);
                Some(Record {
                    row: raw.row,
                    cells,
                })
            }
            RawCells::Positional(mut cells) => {
                if cells.iter().all(Cell::is_blank) {
                    return None;
                }
                if self.has_header && !self.header_taken {
                    self.header_taken = true;
                    for (i, c) in cells.iter().enumerate() {
                        let base = if c.is_blank() {
                            format!("Column {}", i + 1)
                        } else {
                            c.text().trim().to_string()
                        };
                        self.add_header(base);
                    }
                    return None;
                }
                while self.headers.len() < cells.len() {
                    let i = self.headers.len();
                    self.add_header(format!("Column {}", i + 1));
                }
                cells.resize(self.headers.len(), Cell::Null);
                Some(Record {
                    row: raw.row,
                    cells,
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn t(s: &str) -> Cell {
        Cell::Text(s.into())
    }
    fn pos(row: u64, cells: &[&str]) -> RawRecord {
        RawRecord {
            row,
            cells: RawCells::Positional(cells.iter().map(|s| t(s)).collect()),
        }
    }

    #[test]
    fn names_blank_and_repeated_headers() {
        let mut s = Shaper::new(true);
        assert!(s.shape(pos(1, &["id", "", "id"])).is_none());
        assert_eq!(s.headers, vec!["id", "Column 2", "id (2)"]);
        let r = s.shape(pos(2, &["1", "2"])).unwrap();
        assert_eq!(r.cells, vec![t("1"), t("2"), Cell::Null]);
    }

    #[test]
    fn without_a_header_the_first_row_is_data_and_wider_rows_add_columns() {
        let mut s = Shaper::new(false);
        assert_eq!(s.shape(pos(1, &["a"])).unwrap().cells, vec![t("a")]);
        assert_eq!(
            s.shape(pos(2, &["b", "c"])).unwrap().cells,
            vec![t("b"), t("c")]
        );
        assert_eq!(s.headers, vec!["Column 1", "Column 2"]);
    }

    #[test]
    fn drops_blank_rows_including_before_the_header() {
        let mut s = Shaper::new(true);
        assert!(s.shape(pos(1, &["", " "])).is_none());
        assert!(s.shape(pos(2, &["name"])).is_none());
        assert_eq!(s.headers, vec!["name"]);
        assert!(s.shape(pos(3, &[""])).is_none());
        assert_eq!(s.shape(pos(4, &["x"])).unwrap().row, 4);
    }

    #[test]
    fn json_objects_add_their_keys_in_order_of_first_appearance() {
        let mut s = Shaper::new(true);
        let obj = |kv: &[(&str, Cell)]| RawRecord {
            row: 1,
            cells: RawCells::Keyed(kv.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()),
        };
        assert_eq!(s.shape(obj(&[("a", t("1"))])).unwrap().cells, vec![t("1")]);
        assert_eq!(
            s.shape(obj(&[("b", t("2")), ("a", t("3"))])).unwrap().cells,
            vec![t("3"), t("2")]
        );
        assert_eq!(s.headers, vec!["a", "b"]);
    }

    fn temp(name: &str, bytes: &[u8]) -> String {
        let dir = std::env::temp_dir().join(format!("tg-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::File::create(&p).unwrap().write_all(bytes).unwrap();
        p.to_string_lossy().into_owned()
    }

    fn gz(bytes: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        e.write_all(bytes).unwrap();
        e.finish().unwrap()
    }

    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut out);
            for (name, body) in entries {
                z.start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                z.write_all(body).unwrap();
            }
            z.finish().unwrap();
        }
        out.into_inner()
    }

    fn rows_of(path: &str, opts: SourceOptions) -> (Vec<String>, Vec<Record>) {
        let det = detect(path).unwrap();
        let mut shaper = Shaper::new(opts.has_header());
        let mut out = Vec::new();
        let mut info = ReadInfo::default();
        read_rows(
            path,
            &det,
            &opts,
            &Arc::new(AtomicU64::new(0)),
            &mut info,
            &mut |raw| {
                if let Some(r) = shaper.shape(raw) {
                    out.push(r);
                }
                Ok(true)
            },
        )
        .unwrap();
        (shaper.headers, out)
    }

    #[test]
    fn detects_by_bytes_then_by_name() {
        let k =
            |name: &str, bytes: &[u8]| detect(&temp(name, bytes)).map(|d| (d.kind, d.container));
        assert_eq!(k("a.csv", b"x,y\n").unwrap(), (Kind::Csv, Container::Plain));
        assert_eq!(
            k("a.csv.gz", &gz(b"x,y\n")).unwrap(),
            (Kind::Csv, Container::Gzip)
        );
        assert_eq!(
            k("a.gz", &gz(b"[{\"a\":1}]")).unwrap(),
            (Kind::Json, Container::Gzip)
        );
        assert_eq!(
            k("a.sql.gz", &gz(b"CREATE TABLE t (a int);")).unwrap(),
            (Kind::Sql, Container::Gzip)
        );
        assert_eq!(
            k("a.dump", b"PGDMP\x01\x10").unwrap(),
            (Kind::Sql, Container::Plain)
        );
        assert_eq!(
            k("noext", b"-- dump\nCREATE TABLE x();").unwrap().0,
            Kind::Sql
        );
        assert_eq!(k("noext", b"  {\"a\":1}").unwrap().0, Kind::Json);
        assert_eq!(
            k(
                "data.zip",
                &zip_of(&[("readme.md", b"hi"), ("dir/rows.CSV", b"a\n1\n")])
            )
            .unwrap(),
            (Kind::Csv, Container::Zip("dir/rows.CSV".into()))
        );
        assert!(k("data.zip", &zip_of(&[("readme.md", b"hi")])).is_err());
        assert_eq!(
            k("b.xlsx", &super::super::xlsx::tests::make_xlsx("", &[]))
                .unwrap()
                .0,
            Kind::Xlsx
        );
        assert!(k("old.xls", b"\xD0\xCF\x11\xE0").is_err());
        assert!(k("fake.xlsx", b"a,b").is_err());
    }

    #[test]
    fn reads_csv_through_gzip_and_zip_alike() {
        let body = "id;name\n1;Ánh\n\n2;\"b;c\"\n";
        let expect = vec![
            Record {
                row: 2,
                cells: vec![t("1"), t("Ánh")],
            },
            Record {
                row: 4,
                cells: vec![t("2"), t("b;c")],
            },
        ];
        for path in [
            temp("p.csv", body.as_bytes()),
            temp("p.csv.gz", &gz(body.as_bytes())),
            temp("p.zip", &zip_of(&[("p.csv", body.as_bytes())])),
        ] {
            let (headers, rows) = rows_of(&path, SourceOptions::default());
            assert_eq!(headers, vec!["id", "name"], "{path}");
            assert_eq!(rows, expect, "{path}");
        }
    }

    #[test]
    fn reads_a_json_array_and_a_windows_1258_csv() {
        let (h, rows) = rows_of(
            &temp("j.json", br#"[{"a":1,"b":"x"},{"b":"y","c":true}]"#),
            SourceOptions::default(),
        );
        assert_eq!(h, vec!["a", "b", "c"]);
        assert_eq!(rows[1].cells, vec![Cell::Null, t("y"), Cell::Bool(true)]);

        let opts = SourceOptions {
            encoding: Some("windows-1258".into()),
            ..Default::default()
        };
        let (_, rows) = rows_of(
            &temp("v.csv", &[b'h', b'\n', b'V', b'i', 0xEA, 0xD2, b't']),
            opts,
        );
        assert_eq!(rows[0].cells, vec![t("Viê\u{309}t")]);
    }
}
