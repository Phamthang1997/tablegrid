//! CSV (RFC 4180) read a record at a time from a UTF-8 stream.
//!
//! Fields may be quoted, `""` inside quotes is one `"`, and a quoted field may hold the delimiter or
//! a line break. Nothing is trimmed and a tab is not a delimiter unless chosen, so `"a, b"` and a
//! value meant to start with a space survive. CRLF, LF and a lone CR all end a record. Every rule
//! here looks at an ASCII byte, and a UTF-8 multi-byte sequence never contains one, so the scan
//! works on bytes.

use std::io::BufRead;

pub(crate) const DELIMITERS: [u8; 4] = *b",;\t|";

/// The delimiter a CSV-ish text uses: the candidate that splits the first lines into the same
/// number of fields most consistently. Quoted text is skipped, so `"a,b";c` counts one `;` and no
/// `,`. A file that fits none (a single column) gets `,`.
pub(crate) fn detect_delimiter(head: &str) -> u8 {
    let lines: Vec<&str> = head
        .trim_start_matches('\u{feff}')
        .split(['\n', '\r'])
        .filter(|l| !l.trim().is_empty())
        .take(20)
        .collect();
    let mut best = b',';
    let mut best_score = 0usize;
    for d in DELIMITERS {
        let counts: Vec<usize> = lines.iter().map(|l| count_outside_quotes(l, d)).collect();
        let Some(&first) = counts.first() else {
            continue;
        };
        if first == 0 {
            continue;
        }
        // Lines whose count matches the first line's — a real delimiter is consistent across rows.
        let consistent = counts.iter().filter(|&&c| c == first).count();
        let score = consistent * 1000 + first;
        if score > best_score {
            best_score = score;
            best = d;
        }
    }
    best
}

fn count_outside_quotes(line: &str, d: u8) -> usize {
    let mut n = 0;
    let mut quoted = false;
    for &b in line.as_bytes() {
        if b == b'"' {
            quoted = !quoted;
        } else if b == d && !quoted {
            n += 1;
        }
    }
    n
}

/// Reads every record and hands it to `emit` with its 1-based record number. `emit` returns false
/// to stop early (the preview needs a few rows, not the file).
pub(crate) fn read_csv(
    input: &mut dyn BufRead,
    delimiter: u8,
    emit: &mut dyn FnMut(u64, Vec<String>) -> Result<bool, String>,
) -> Result<(), String> {
    let mut field: Vec<u8> = Vec::new();
    let mut record: Vec<String> = Vec::new();
    let mut quoted = false;
    // Inside quotes, a `"` was the last byte of a buffer: it is `""` or the closing quote, and only
    // the next byte says which.
    let mut quote_pending = false;
    // A `\r` was the last byte seen: a `\n` right after it belongs to the same line end.
    let mut skip_lf = false;
    // Something has been read since the last record ended — what decides whether the file's tail
    // is one more record or just its final line break.
    let mut dirty = false;
    let mut n: u64 = 0;

    let finish_field = |field: &mut Vec<u8>, record: &mut Vec<String>| {
        let bytes = std::mem::take(field);
        // The stream is UTF-8 by construction (`DecodeReader`); lossy only as a guard.
        record.push(
            String::from_utf8(bytes)
                .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()),
        );
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
            if skip_lf {
                skip_lf = false;
                if b == b'\n' {
                    i += 1;
                    continue;
                }
            }
            if quote_pending {
                quote_pending = false;
                if b == b'"' {
                    field.push(b'"');
                    i += 1;
                    continue;
                }
                quoted = false;
                // Fall through: this byte is read outside the quotes.
            }
            if quoted {
                // Copy up to the next quote in one go.
                match buf[i..].iter().position(|&c| c == b'"') {
                    Some(p) => {
                        field.extend_from_slice(&buf[i..i + p]);
                        i += p + 1;
                        if i < len {
                            if buf[i] == b'"' {
                                field.push(b'"');
                                i += 1;
                            } else {
                                quoted = false;
                            }
                        } else {
                            quote_pending = true;
                        }
                    }
                    None => {
                        field.extend_from_slice(&buf[i..]);
                        i = len;
                    }
                }
                continue;
            }
            if b == b'"' && field.is_empty() {
                quoted = true;
                dirty = true;
                i += 1;
            } else if b == delimiter {
                finish_field(&mut field, &mut record);
                dirty = true;
                i += 1;
            } else if b == b'\r' || b == b'\n' {
                finish_field(&mut field, &mut record);
                n += 1;
                dirty = false;
                // The next record is sized like this one: most files are rectangular, and growing a
                // fresh Vec field by field is several allocations per row of a multi-million-row file.
                let width = record.len();
                if !emit(n, std::mem::replace(&mut record, Vec::with_capacity(width)))? {
                    return Ok(());
                }
                skip_lf = b == b'\r';
                i += 1;
            } else {
                // Copy the run of ordinary bytes up to the next special one.
                let end = buf[i..]
                    .iter()
                    .position(|&c| c == delimiter || c == b'\r' || c == b'\n' || c == b'"')
                    .map_or(len, |p| i + p);
                let end = if end == i { i + 1 } else { end };
                field.extend_from_slice(&buf[i..end]);
                dirty = true;
                i = end;
            }
        }
        input.consume(len);
    }
    // The last record, unless the file ended right after a line break.
    if dirty || !field.is_empty() || !record.is_empty() || quote_pending {
        finish_field(&mut field, &mut record);
        n += 1;
        emit(n, record)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    /// Parses `text` read through a buffer of `cap` bytes, so every case also runs with records,
    /// quotes and CRLFs split across reads.
    fn parse_with(text: &str, d: u8, cap: usize) -> Vec<Vec<String>> {
        let mut out = Vec::new();
        let mut r = BufReader::with_capacity(cap, text.as_bytes());
        read_csv(&mut r, d, &mut |_, rec| {
            out.push(rec);
            Ok(true)
        })
        .unwrap();
        out
    }

    fn parse(text: &str, d: u8) -> Vec<Vec<String>> {
        let whole = parse_with(text, d, 1 << 16);
        for cap in 1..8 {
            assert_eq!(parse_with(text, d, cap), whole, "buffer of {cap} bytes");
        }
        whole
    }

    fn rows(r: &[&[&str]]) -> Vec<Vec<String>> {
        r.iter()
            .map(|x| x.iter().map(|s| s.to_string()).collect())
            .collect()
    }

    #[test]
    fn quotes_doubled_quotes_delimiters_and_line_breaks_inside_a_field() {
        let text = "id,note\r\n1,\"a, \"\"quoted\"\" note\"\n2,\"two\nlines\"\n";
        assert_eq!(
            parse(text, b','),
            rows(&[
                &["id", "note"],
                &["1", "a, \"quoted\" note"],
                &["2", "two\nlines"]
            ])
        );
    }

    #[test]
    fn keeps_spaces_and_empty_fields() {
        assert_eq!(
            parse("a;b;c\n x ;;z", b';'),
            rows(&[&["a", "b", "c"], &[" x ", "", "z"]])
        );
    }

    #[test]
    fn a_tab_is_only_a_delimiter_when_chosen() {
        assert_eq!(parse("a\tb,c", b','), rows(&[&["a\tb", "c"]]));
    }

    #[test]
    fn ends_on_a_lone_cr_and_on_a_last_line_without_newline() {
        assert_eq!(parse("a\rb", b','), rows(&[&["a"], &["b"]]));
        assert_eq!(
            parse("a\r\n\r\nb\r\n", b','),
            rows(&[&["a"], &[""], &["b"]])
        );
    }

    #[test]
    fn a_trailing_empty_field_and_a_quoted_empty_one_are_kept() {
        assert_eq!(parse("a,\n", b','), rows(&[&["a", ""]]));
        assert_eq!(parse("\"\"", b','), rows(&[&[""]]));
        assert_eq!(parse("x,\"\"", b','), rows(&[&["x", ""]]));
    }

    #[test]
    fn record_numbers_count_records_not_lines() {
        let mut seen = Vec::new();
        let mut r = BufReader::new("h\n\"a\nb\"\nc\n".as_bytes());
        read_csv(&mut r, b',', &mut |n, rec| {
            seen.push((n, rec.join("|")));
            Ok(true)
        })
        .unwrap();
        assert_eq!(
            seen,
            vec![(1, "h".into()), (2, "a\nb".into()), (3, "c".into())]
        );
    }

    #[test]
    fn stops_when_asked() {
        let mut count = 0;
        let mut r = BufReader::new("1\n2\n3\n".as_bytes());
        read_csv(&mut r, b',', &mut |_, _| {
            count += 1;
            Ok(count < 2)
        })
        .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn detects_the_delimiter() {
        assert_eq!(detect_delimiter("a;b;c\n1;2;3\n4;5;6"), b';');
        assert_eq!(detect_delimiter("a\tb\n1\t2"), b'\t');
        assert_eq!(detect_delimiter("a|b\n1|2"), b'|');
        assert_eq!(detect_delimiter("\"x,y\";z\n\"1,2\";3"), b';');
        assert_eq!(detect_delimiter("name\nalice\nbob"), b',');
    }
}
