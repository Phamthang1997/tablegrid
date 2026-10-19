//! An .xlsx sheet read a row at a time.
//!
//! An .xlsx is a zip of XML parts. The small ones (workbook, its relationships, styles) are read
//! whole; the shared-string table is read into memory because any cell may point anywhere in it;
//! the SHEET — which is where the size is — is inflated and parsed as a stream of XML events, so a
//! sheet of a few million rows is never a document in memory. The old reader (`xlsxReader.ts`)
//! inflated every sheet and parsed each into a tree in the webview.
//!
//! The cell rules are the old reader's: shared/inline strings, booleans, numbers, and a number in a
//! date-formatted cell turned into `YYYY-MM-DD[ HH:MM:SS]` (1900 or 1904 date system).

use std::io::{BufRead, BufReader, Read, Seek};

use chrono::{Duration, NaiveDate};
use quick_xml::Reader;
use quick_xml::events::{BytesRef, BytesStart, Event};
use zip::ZipArchive;

use super::cell::Cell;

fn xml_error(e: impl std::fmt::Display) -> String {
    format!("Tệp Excel không hợp lệ: {e}")
}

/// Built-in Excel date/time number format ids.
const BUILTIN_DATE_FMT: [u32; 31] = [
    14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
    52, 53, 54, 55, 56, 57, 58,
];

/// A custom format code is a date when it has an unescaped y/m/d/h/s outside quoted text.
fn looks_like_date_format(code: &str) -> bool {
    let mut quoted = false;
    let mut chars = code.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '\\' if !quoted => {
                chars.next();
            }
            // `[Red]`, `[$-409]`: colour and locale tags, not date parts.
            '[' if !quoted => {
                for c2 in chars.by_ref() {
                    if c2 == ']' {
                        break;
                    }
                }
            }
            _ if !quoted && matches!(c.to_ascii_lowercase(), 'y' | 'm' | 'd' | 'h' | 's') => {
                return true;
            }
            _ => {}
        }
    }
    false
}

/// An Excel serial day number as `YYYY-MM-DD`, with the time when it has one.
pub(crate) fn excel_serial_to_date(serial: f64, date1904: bool) -> Option<String> {
    // 1899-12-30 rather than 12-31 absorbs Excel's 1900 leap-year bug for every date after March 1900.
    let epoch = if date1904 {
        NaiveDate::from_ymd_opt(1904, 1, 1)?
    } else {
        NaiveDate::from_ymd_opt(1899, 12, 30)?
    }
    .and_hms_opt(0, 0, 0)?;
    if !serial.is_finite() || serial.abs() > 3_000_000.0 {
        return None;
    }
    let d = epoch.checked_add_signed(Duration::milliseconds(
        (serial * 86_400_000.0).round() as i64
    ))?;
    let has_time = (serial - serial.floor()).abs() > 1e-9;
    Some(if has_time {
        d.format("%Y-%m-%d %H:%M:%S").to_string()
    } else {
        d.format("%Y-%m-%d").to_string()
    })
}

/// `B3` → 1 (0-based column).
fn col_index(cell_ref: &[u8]) -> Option<usize> {
    let mut i: usize = 0;
    let mut any = false;
    for &c in cell_ref {
        let v = match c {
            b'A'..=b'Z' => c - b'A' + 1,
            b'a'..=b'z' => c - b'a' + 1,
            _ => break,
        };
        i = i.checked_mul(26)?.checked_add(v as usize)?;
        any = true;
    }
    (any && i > 0).then(|| i - 1)
}

fn attr(e: &BytesStart, name: &str) -> Option<String> {
    e.attributes().with_checks(false).flatten().find_map(|a| {
        (a.key.local_name().as_ref() == name).then(|| {
            a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                .map(|v| v.into_owned())
                .unwrap_or_else(|_| a.value.clone().into_owned())
        })
    })
}

/// `&amp;`, `&#233;` — text arrives as Text events with the references as separate events.
fn push_ref(out: &mut String, r: &BytesRef) {
    if let Ok(Some(c)) = r.resolve_char_ref() {
        out.push(c);
        return;
    }
    let name: &str = r;
    match quick_xml::escape::resolve_predefined_entity(name) {
        Some(s) => out.push_str(s),
        None => {
            out.push('&');
            out.push_str(name);
            out.push(';');
        }
    }
}

fn read_part<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    name: &str,
) -> Result<Option<Vec<u8>>, String> {
    let mut entry = match zip.by_name(name) {
        Ok(e) => e,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(xml_error(e)),
    };
    let mut out = Vec::new();
    entry.read_to_end(&mut out).map_err(xml_error)?;
    Ok(Some(out))
}

fn xml_reader<R: BufRead>(r: R) -> Reader<R> {
    let mut reader = Reader::from_reader(r);
    // `<c r="A1" s="3"/>` then reads as Start + End, so one code path handles both forms.
    reader.config_mut().expand_empty_elements = true;
    reader
}

/// What the workbook says about its sheets and how to read their numbers.
pub(crate) struct Workbook {
    /// (name, zip path) in workbook order.
    pub sheets: Vec<(String, String)>,
    date1904: bool,
    /// For each cell style (`s="N"`), whether its number format is a date.
    xf_is_date: Vec<bool>,
}

fn read_workbook<R: Read + Seek>(zip: &mut ZipArchive<R>) -> Result<Workbook, String> {
    // Relationship id → part path.
    let mut targets: Vec<(String, String)> = Vec::new();
    if let Some(rels) = read_part(zip, "xl/_rels/workbook.xml.rels")? {
        let mut r = xml_reader(&rels[..]);
        let mut buf = Vec::new();
        loop {
            match r.read_event_into(&mut buf).map_err(xml_error)? {
                Event::Start(e) if e.local_name().as_ref() == "Relationship" => {
                    if let (Some(id), Some(target)) = (attr(&e, "Id"), attr(&e, "Target")) {
                        let t = target.trim_start_matches('/');
                        let path = if t.starts_with("xl/") {
                            t.to_string()
                        } else {
                            format!("xl/{t}")
                        };
                        targets.push((id, path));
                    }
                }
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }
    }

    let mut sheets = Vec::new();
    let mut date1904 = false;
    if let Some(wb) = read_part(zip, "xl/workbook.xml")? {
        let mut r = xml_reader(&wb[..]);
        let mut buf = Vec::new();
        loop {
            match r.read_event_into(&mut buf).map_err(xml_error)? {
                Event::Start(e) if e.local_name().as_ref() == "workbookPr" => {
                    date1904 = matches!(attr(&e, "date1904").as_deref(), Some("1" | "true"));
                }
                Event::Start(e) if e.local_name().as_ref() == "sheet" => {
                    let n = sheets.len() + 1;
                    let name = attr(&e, "name").unwrap_or_else(|| format!("Sheet{n}"));
                    // `r:id` — the only attribute of <sheet> whose local name is `id`.
                    let rid = attr(&e, "id").unwrap_or_default();
                    let path = targets
                        .iter()
                        .find(|(id, _)| *id == rid)
                        .map(|(_, p)| p.clone())
                        .unwrap_or_else(|| format!("xl/worksheets/sheet{n}.xml"));
                    sheets.push((name, path));
                }
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }
    }
    if sheets.is_empty() {
        sheets.push(("Sheet1".to_string(), "xl/worksheets/sheet1.xml".to_string()));
    }

    let mut xf_is_date = Vec::new();
    if let Some(styles) = read_part(zip, "xl/styles.xml")? {
        let mut custom: Vec<(u32, bool)> = Vec::new();
        let mut in_cell_xfs = false;
        let mut r = xml_reader(&styles[..]);
        let mut buf = Vec::new();
        loop {
            match r.read_event_into(&mut buf).map_err(xml_error)? {
                Event::Start(e) => match e.local_name().as_ref() {
                    "numFmt" => {
                        if let Some(id) = attr(&e, "numFmtId").and_then(|v| v.parse().ok()) {
                            let code = attr(&e, "formatCode").unwrap_or_default();
                            custom.push((id, looks_like_date_format(&code)));
                        }
                    }
                    "cellXfs" => in_cell_xfs = true,
                    "xf" if in_cell_xfs => {
                        let id: u32 = attr(&e, "numFmtId")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(0);
                        let is_date = BUILTIN_DATE_FMT.contains(&id)
                            || custom.iter().any(|&(cid, d)| cid == id && d);
                        xf_is_date.push(is_date);
                    }
                    _ => {}
                },
                Event::End(e) if e.local_name().as_ref() == "cellXfs" => in_cell_xfs = false,
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }
    }
    Ok(Workbook {
        sheets,
        date1904,
        xf_is_date,
    })
}

/// The shared-string table: one string per `<si>`, its `<t>` runs concatenated, phonetic guides
/// (`<rPh>`) left out.
fn read_shared_strings<R: Read + Seek>(zip: &mut ZipArchive<R>) -> Result<Vec<String>, String> {
    let entry = match zip.by_name("xl/sharedStrings.xml") {
        Ok(e) => e,
        Err(zip::result::ZipError::FileNotFound) => return Ok(Vec::new()),
        Err(e) => return Err(xml_error(e)),
    };
    let mut r = xml_reader(BufReader::with_capacity(1 << 16, entry));
    let mut buf = Vec::new();
    let mut out = Vec::new();
    let mut cur = String::new();
    let (mut in_t, mut in_rph) = (false, false);
    loop {
        match r.read_event_into(&mut buf).map_err(xml_error)? {
            Event::Start(e) => match e.local_name().as_ref() {
                "si" => cur.clear(),
                "t" if !in_rph => in_t = true,
                "rPh" => in_rph = true,
                _ => {}
            },
            Event::End(e) => match e.local_name().as_ref() {
                "si" => out.push(std::mem::take(&mut cur)),
                "t" => in_t = false,
                "rPh" => in_rph = false,
                _ => {}
            },
            Event::Text(t) if in_t => cur.push_str(&t.xml10_content()),
            Event::CData(t) if in_t => cur.push_str(&t),
            Event::GeneralRef(g) if in_t => push_ref(&mut cur, &g),
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

struct PendingCell {
    col: usize,
    t: Option<String>,
    style: Option<usize>,
}

fn cell_value(p: &PendingCell, text: String, shared: &[String], wb: &Workbook) -> Cell {
    match p.t.as_deref() {
        Some("inlineStr") => Cell::Text(text),
        Some("s") => Cell::Text(
            text.trim()
                .parse::<usize>()
                .ok()
                .and_then(|i| shared.get(i))
                .cloned()
                .unwrap_or_default(),
        ),
        Some("b") => Cell::Bool(text.trim() == "1"),
        // A formula's string result, an error (`#N/A`), an ISO date cell.
        Some("str" | "e" | "d") => Cell::Text(text),
        _ => {
            let raw = text.trim();
            if raw.is_empty() {
                return Cell::Null;
            }
            let Ok(value) = raw.parse::<f64>() else {
                return Cell::Text(text);
            };
            if p.style
                .is_some_and(|s| wb.xf_is_date.get(s).copied().unwrap_or(false))
                && let Some(d) = excel_serial_to_date(value, wb.date1904)
            {
                return Cell::Text(d);
            }
            Cell::Number {
                value,
                raw: raw.to_string(),
            }
        }
    }
}

/// Reads sheet `sheet` (0-based, workbook order) and hands every row to `emit` with its Excel row
/// number. Rows Excel does not store (never touched) are simply absent. `on_sheets` receives the
/// sheet names first. `emit` returns false to stop early.
pub(crate) fn read_xlsx<R: Read + Seek>(
    reader: R,
    sheet: usize,
    on_sheets: &mut dyn FnMut(&[String]),
    emit: &mut dyn FnMut(u64, Vec<Cell>) -> Result<bool, String>,
) -> Result<(), String> {
    let mut zip = ZipArchive::new(reader).map_err(xml_error)?;
    let wb = read_workbook(&mut zip)?;
    let names: Vec<String> = wb.sheets.iter().map(|(n, _)| n.clone()).collect();
    on_sheets(&names);
    let (_, path) = wb
        .sheets
        .get(sheet)
        .ok_or_else(|| "Tệp Excel không có trang tính nào".to_string())?;
    let path = path.clone();
    let shared = read_shared_strings(&mut zip)?;

    let entry = match zip.by_name(&path) {
        Ok(e) => e,
        Err(zip::result::ZipError::FileNotFound) => {
            return Err("Tệp Excel không có trang tính nào".to_string());
        }
        Err(e) => return Err(xml_error(e)),
    };
    let mut r = xml_reader(BufReader::with_capacity(1 << 16, entry));
    let mut buf = Vec::new();
    let mut row: Vec<Cell> = Vec::new();
    let mut row_no: u64 = 0;
    let mut pending: Option<PendingCell> = None;
    let mut text = String::new();
    let (mut capture, mut in_is, mut in_rph) = (false, false, false);
    loop {
        match r.read_event_into(&mut buf).map_err(xml_error)? {
            Event::Start(e) => match e.local_name().as_ref() {
                "row" => {
                    row_no = attr(&e, "r")
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(row_no + 1);
                    row.clear();
                }
                "c" => {
                    let col = attr(&e, "r")
                        .and_then(|v| col_index(v.as_bytes()))
                        .unwrap_or(row.len());
                    pending = Some(PendingCell {
                        col,
                        t: attr(&e, "t"),
                        style: attr(&e, "s").and_then(|v| v.parse().ok()),
                    });
                    text.clear();
                }
                "v" => capture = pending.is_some(),
                "is" => in_is = true,
                "rPh" => in_rph = true,
                "t" if in_is && !in_rph => capture = true,
                _ => {}
            },
            Event::End(e) => match e.local_name().as_ref() {
                "v" | "t" => capture = false,
                "is" => in_is = false,
                "rPh" => in_rph = false,
                "c" => {
                    if let Some(p) = pending.take() {
                        // A sheet past column XFD is not a real sheet; refuse to allocate for it.
                        if p.col < 16_384 {
                            let v = cell_value(&p, std::mem::take(&mut text), &shared, &wb);
                            if row.len() <= p.col {
                                row.resize(p.col + 1, Cell::Null);
                            }
                            row[p.col] = v;
                        }
                    }
                }
                "row" => {
                    if !emit(row_no, std::mem::take(&mut row))? {
                        return Ok(());
                    }
                }
                "sheetData" => break,
                _ => {}
            },
            Event::Text(t) if capture => text.push_str(&t.xml10_content()),
            Event::CData(t) if capture => text.push_str(&t),
            Event::GeneralRef(g) if capture => push_ref(&mut text, &g),
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    /// A minimal .xlsx with one sheet, a shared-string table, a date style and the given sheet XML.
    pub(crate) fn make_xlsx(sheet_rows: &str, shared: &[&str]) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut out);
            let o: zip::write::SimpleFileOptions = Default::default();
            let mut put = |name: &str, body: String| {
                z.start_file(name, o).unwrap();
                z.write_all(body.as_bytes()).unwrap();
            };
            put(
                "xl/workbook.xml",
                r#"<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId2"/></sheets></workbook>"#.into(),
            );
            put(
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>"#.into(),
            );
            put(
                "xl/styles.xml",
                r#"<styleSheet><numFmts><numFmt numFmtId="164" formatCode="[Red]0.00"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy hh:mm"/></numFmts><cellStyleXfs><xf numFmtId="14"/></cellStyleXfs><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>"#.into(),
            );
            let si: String = shared
                .iter()
                .map(|s| format!("<si><t>{s}</t></si>"))
                .collect();
            put(
                "xl/sharedStrings.xml",
                format!(
                    "<sst>{si}<si><r><t>rich </t></r><r><t>text</t></r><rPh><t>ignored</t></rPh></si></sst>"
                ),
            );
            put(
                "xl/worksheets/sheet1.xml",
                format!("<worksheet><sheetData>{sheet_rows}</sheetData></worksheet>"),
            );
            put("xl/worksheets/sheet2.xml", "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>second</t></is></c></row></sheetData></worksheet>".into());
            z.finish().unwrap();
        }
        out.into_inner()
    }

    fn read(bytes: Vec<u8>, sheet: usize) -> (Vec<String>, Vec<(u64, Vec<Cell>)>) {
        let mut names = Vec::new();
        let mut rows = Vec::new();
        read_xlsx(
            Cursor::new(bytes),
            sheet,
            &mut |n| names = n.to_vec(),
            &mut |r, cells| {
                rows.push((r, cells));
                Ok(true)
            },
        )
        .unwrap();
        (names, rows)
    }

    #[test]
    fn reads_every_cell_kind() {
        let sheet = concat!(
            r#"<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row>"#,
            r#"<row r="3"><c r="A3"><v>42</v></c><c r="B3" t="b"><v>1</v></c><c r="C3" s="1"><v>46000</v></c>"#,
            r#"<c r="D3" s="3"><v>46000.5</v></c><c r="E3" s="2"><v>1.5</v></c><c r="F3" t="str"><f>A1</f><v>a &amp; b</v></c>"#,
            r#"<c r="G3" t="e"><v>#N/A</v></c><c r="H3"/></row>"#,
        );
        let (names, rows) = read(make_xlsx(sheet, &["id", "unused"]), 0);
        assert_eq!(names, vec!["Data", "Other"]);
        assert_eq!(rows[0].0, 1);
        assert_eq!(
            rows[0].1,
            vec![
                Cell::Text("id".into()),
                Cell::Null,
                Cell::Text("rich text".into())
            ]
        );
        assert_eq!(rows[1].0, 3, "the Excel row number, gaps included");
        let r = &rows[1].1;
        assert_eq!(
            r[0],
            Cell::Number {
                value: 42.0,
                raw: "42".into()
            }
        );
        assert_eq!(r[1], Cell::Bool(true));
        assert_eq!(r[2], Cell::Text("2025-12-09".into()));
        assert_eq!(r[3], Cell::Text("2025-12-09 12:00:00".into()));
        // `[Red]0.00` is a colour tag on a number format, not a date.
        assert_eq!(
            r[4],
            Cell::Number {
                value: 1.5,
                raw: "1.5".into()
            }
        );
        assert_eq!(r[5], Cell::Text("a & b".into()));
        assert_eq!(r[6], Cell::Text("#N/A".into()));
        assert_eq!(r[7], Cell::Null);
    }

    #[test]
    fn picks_a_sheet_by_position() {
        let (_, rows) = read(make_xlsx("", &[]), 1);
        assert_eq!(rows, vec![(1, vec![Cell::Text("second".into())])]);
    }

    #[test]
    fn serial_dates() {
        assert_eq!(excel_serial_to_date(1.0, false).unwrap(), "1899-12-31");
        assert_eq!(excel_serial_to_date(61.0, false).unwrap(), "1900-03-01");
        assert_eq!(excel_serial_to_date(0.0, true).unwrap(), "1904-01-01");
        assert!(excel_serial_to_date(1e12, false).is_none());
    }

    #[test]
    fn column_letters() {
        assert_eq!(col_index(b"A1"), Some(0));
        assert_eq!(col_index(b"AA10"), Some(26));
        assert_eq!(col_index(b"XFD1"), Some(16_383));
        assert_eq!(col_index(b"1"), None);
    }

    #[test]
    fn format_codes() {
        assert!(looks_like_date_format("dd/mm/yyyy"));
        assert!(looks_like_date_format("[$-409]h:mm AM/PM"));
        assert!(!looks_like_date_format("[Red]0.00"));
        assert!(!looks_like_date_format("\"days\" 0"));
        assert!(!looks_like_date_format("0.00\\d"));
    }
}
