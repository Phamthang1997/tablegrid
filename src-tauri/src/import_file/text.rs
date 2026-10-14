//! Turning the bytes of a CSV / JSON file into UTF-8 as they stream past.

use std::io::Read;

use encoding_rs::{CoderResult, Decoder, Encoding};

/// The encoding for a label the dialog offers (`utf-8`, `windows-1258`, `shift_jis`, …).
pub(crate) fn encoding_for(label: Option<&str>) -> Result<&'static Encoding, String> {
    let label = label.unwrap_or("utf-8");
    Encoding::for_label(label.trim().as_bytes())
        .ok_or_else(|| format!("Bảng mã không được hỗ trợ: {label}"))
}

/// A `Read` that yields the inner stream as UTF-8.
///
/// The decoder sniffs a BOM (a UTF-8 BOM is dropped, a UTF-16 one switches the encoding), which is
/// what the browser's `TextDecoder` did for the old import. Malformed input becomes U+FFFD rather
/// than an error — the conversion rules then reject the cell, and the dialog shows it, instead of
/// a 1GB import dying on one byte.
pub(crate) struct DecodeReader<R: Read> {
    inner: R,
    decoder: Decoder,
    input: Vec<u8>,
    in_start: usize,
    in_end: usize,
    output: Vec<u8>,
    out_start: usize,
    out_end: usize,
    eof: bool,
    done: bool,
}

const IN_CHUNK: usize = 1 << 16;

impl<R: Read> DecodeReader<R> {
    pub(crate) fn new(inner: R, encoding: &'static Encoding) -> Self {
        DecodeReader {
            inner,
            decoder: encoding.new_decoder(),
            input: vec![0; IN_CHUNK],
            in_start: 0,
            in_end: 0,
            // Worst case UTF-8 output for a chunk of input is ~3 bytes per input byte.
            output: vec![0; IN_CHUNK * 3 + 16],
            out_start: 0,
            out_end: 0,
            eof: false,
            done: false,
        }
    }
}

impl<R: Read> Read for DecodeReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if self.out_start < self.out_end {
                let n = buf.len().min(self.out_end - self.out_start);
                buf[..n].copy_from_slice(&self.output[self.out_start..self.out_start + n]);
                self.out_start += n;
                return Ok(n);
            }
            if self.done {
                return Ok(0);
            }
            if self.in_start == self.in_end && !self.eof {
                let n = self.inner.read(&mut self.input)?;
                self.in_start = 0;
                self.in_end = n;
                if n == 0 {
                    self.eof = true;
                }
            }
            let (result, read, written, _) = self.decoder.decode_to_utf8(
                &self.input[self.in_start..self.in_end],
                &mut self.output,
                self.eof,
            );
            self.in_start += read;
            self.out_start = 0;
            self.out_end = written;
            if self.eof && self.in_start == self.in_end && result == CoderResult::InputEmpty {
                self.done = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(bytes: &[u8], label: &str) -> String {
        let mut out = String::new();
        DecodeReader::new(bytes, encoding_for(Some(label)).unwrap())
            .read_to_string(&mut out)
            .unwrap();
        out
    }

    #[test]
    fn utf8_bom_is_dropped_and_text_kept() {
        assert_eq!(
            decode("\u{feff}Tiếng Việt".as_bytes(), "utf-8"),
            "Tiếng Việt"
        );
    }

    #[test]
    fn windows_1258_vietnamese() {
        // "Vi" + e + combining hook-above (0xD2) + "t": Windows-1258 writes tone marks combining.
        assert_eq!(
            decode(&[b'V', b'i', 0xEA, 0xD2, b't'], "windows-1258"),
            "Viê\u{309}t"
        );
    }

    #[test]
    fn utf16_with_a_bom_is_read_whatever_the_label() {
        let mut bytes = vec![0xFF, 0xFE];
        for u in "a,b".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode(&bytes, "utf-8"), "a,b");
    }

    #[test]
    fn unknown_label_is_refused() {
        assert!(encoding_for(Some("klingon")).is_err());
    }

    #[test]
    fn a_long_input_crosses_chunk_boundaries_intact() {
        let s = "ắ".repeat(IN_CHUNK); // 3 bytes each, so characters straddle every chunk edge
        assert_eq!(decode(s.as_bytes(), "utf-8"), s);
    }
}
