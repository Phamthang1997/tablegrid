//! Reading a dump FILE a statement at a time, so a restore never holds the dump in memory.
//!
//! A restore used to be handed the whole dump as one IPC string: the webview read the file into a
//! JS string (and did not even gunzip a `.gz` in Connection Manager), split it on the main thread
//! to list the tables, then sent it across as JSON, where Rust split it again into a `Vec<char>` —
//! four bytes a character. A 130MB `.sql.gz` froze the window while it was picked and sat in
//! "Preparing…" for minutes, and a dump past ~512M characters cannot be a JS string at all.
//!
//! Here the file is read from disk, gunzipped on the fly when it starts with the gzip magic bytes
//! (never by its extension — a `.sql` that is really gzip, or a `.gz` that is not, both work), and
//! split by `StmtSplitter`, the SAME scanner `split_sql_statements` runs, so a streamed restore and
//! an in-memory one can never cut a dump differently.

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use flate2::read::MultiGzDecoder;

use super::splitter::{StmtSplitter, is_copy_from_stdin, line_is_delimiter_command};

/// How much is read from the file per step. Big enough that syscalls are not the cost, small
/// enough that the buffered unfinished statement stays the only large allocation.
const READ_CHUNK: usize = 1 << 20;

/// Counts the bytes taken from the FILE — before decompression, so progress is a fraction of the
/// file size the user sees, which is also the only total known before the end.
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

/// An open dump: the decompressed byte stream plus what progress needs.
pub(crate) struct DumpFile {
    pub(crate) reader: Box<dyn Read + Send>,
    /// Bytes read from the file so far.
    pub(crate) bytes_read: Arc<AtomicU64>,
    /// Size of the file on disk.
    pub(crate) bytes_total: u64,
    pub(crate) gzip: bool,
}

pub(crate) fn open_dump(path: &str) -> Result<DumpFile, String> {
    let file = File::open(path).map_err(|e| format!("Không mở được tệp dump: {e}"))?;
    let bytes_total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let bytes_read = Arc::new(AtomicU64::new(0));
    let mut buffered = BufReader::with_capacity(
        READ_CHUNK,
        Counting {
            inner: file,
            read: bytes_read.clone(),
        },
    );
    let head = buffered
        .fill_buf()
        .map_err(|e| format!("Không mở được tệp dump: {e}"))?;
    let gzip = head.len() >= 2 && head[0] == 0x1f && head[1] == 0x8b;
    // `MultiGz`: `cat a.sql.gz b.sql.gz` is a valid gzip file of two members, and the single-member
    // decoder would silently stop after the first.
    let reader: Box<dyn Read + Send> = if gzip {
        Box::new(MultiGzDecoder::new(buffered))
    } else {
        Box::new(buffered)
    };
    Ok(DumpFile {
        reader,
        bytes_read,
        bytes_total,
        gzip,
    })
}

fn read_error(e: std::io::Error) -> String {
    format!("Không đọc được tệp dump: {e}")
}

/// Watches raw dump bytes for a `DELIMITER` line, a chunk at a time.
///
/// That decides whether `$$` is a terminator or a Postgres dollar quote for the WHOLE file (see
/// `ScanState::mysql_script`), so it has to be known before the first statement is split. Only a
/// line's first bytes can make it a DELIMITER line, so a one-line INSERT of a hundred megabytes is
/// skipped through rather than collected.
pub(crate) struct DelimiterProbe {
    head: Vec<u8>,
    at_line_start: bool,
    found: bool,
}

impl DelimiterProbe {
    pub(crate) fn new() -> Self {
        Self {
            head: Vec::with_capacity(64),
            at_line_start: true,
            found: false,
        }
    }

    pub(crate) fn found(&self) -> bool {
        self.found
    }

    pub(crate) fn feed(&mut self, buf: &[u8]) {
        let len = buf.len();
        let mut i = 0;
        while i < len && !self.found {
            if self.at_line_start {
                // Gather up to 64 bytes of the line's head, possibly across two chunks.
                while i < len && buf[i] != b'\n' && self.head.len() < 64 {
                    self.head.push(buf[i]);
                    i += 1;
                }
                if i == len {
                    return;
                }
                self.found = line_is_delimiter_command(&self.head);
                self.head.clear();
                self.at_line_start = false;
            }
            match buf[i..].iter().position(|&c| c == b'\n') {
                Some(p) => {
                    i += p + 1;
                    self.at_line_start = true;
                }
                None => return,
            }
        }
    }

    /// The last line has no newline after it.
    pub(crate) fn finish(&mut self) {
        if self.at_line_start && !self.head.is_empty() {
            self.found = self.found || line_is_delimiter_command(&self.head);
        }
        self.head.clear();
    }
}

/// Reads the whole dump once to decide `mysql_script` — for a caller that has no answer from
/// `scan_dump_file` to go on.
pub(crate) fn probe_mysql_script(path: &str) -> Result<bool, String> {
    let mut reader = open_dump(path)?.reader;
    let mut probe = DelimiterProbe::new();
    let mut chunk = vec![0; READ_CHUNK];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                probe.feed(&chunk[..n]);
                if probe.found() {
                    return Ok(true);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(read_error(e)),
        }
    }
    probe.finish();
    Ok(probe.found())
}

/// How much COPY data one `DumpItem::CopyData` carries at most (whole lines, so a little more).
pub(crate) const COPY_CHUNK: usize = 1 << 20;

/// One piece of a dump file, in file order.
#[derive(Debug, PartialEq)]
pub(crate) enum DumpItem {
    /// An ordinary statement.
    Stmt(String),
    /// A `COPY … FROM stdin` statement. Its data follows as `CopyData` pieces and then `CopyEnd` —
    /// always, even when the data block is empty or the file is cut off inside it.
    CopyStart(String),
    /// Raw data lines of the COPY in progress, each ending in `\n`, the `\.` line excluded.
    CopyData(Vec<u8>),
    CopyEnd,
}

/// The pieces of a dump file, one at a time: statements, and pg_dump's COPY data blocks in
/// chunks of about `COPY_CHUNK` — so a 150MB table's data never has to be one string either.
pub(crate) struct DumpStatements {
    reader: Box<dyn Read + Send>,
    splitter: StmtSplitter,
    /// Watches the same bytes for a DELIMITER line, so one pass can find out whether the
    /// `mysql_script` it was split with was the right guess (`scan_dump_file` splits with `false`
    /// and redoes the pass only when this fires).
    probe: DelimiterProbe,
    chunk: Vec<u8>,
    finished: bool,
    /// Inside a COPY data block.
    copying: bool,
    /// The last data piece came with the `\.` line; `CopyEnd` is owed on the next call.
    end_owed: bool,
}

impl DumpStatements {
    pub(crate) fn new(reader: Box<dyn Read + Send>, mysql_script: bool) -> Self {
        Self {
            reader,
            splitter: StmtSplitter::new(mysql_script).with_client_commands(),
            probe: DelimiterProbe::new(),
            chunk: vec![0; READ_CHUNK],
            finished: false,
            copying: false,
            end_owed: false,
        }
    }

    /// Did the bytes read so far contain a DELIMITER line? Final once the iterator is exhausted.
    pub(crate) fn saw_delimiter_line(&self) -> bool {
        self.probe.found()
    }

    /// One read from the file into the splitter. `Err` is a read error, already worded.
    fn fill(&mut self) -> Result<(), String> {
        loop {
            match self.reader.read(&mut self.chunk) {
                Ok(0) => {
                    self.finished = true;
                    self.probe.finish();
                    self.splitter.finish();
                    return Ok(());
                }
                Ok(n) => {
                    if !self.probe.found() {
                        self.probe.feed(&self.chunk[..n]);
                    }
                    self.splitter.feed(&self.chunk[..n]);
                    return Ok(());
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => {
                    self.finished = true;
                    return Err(read_error(e));
                }
            }
        }
    }
}

impl Iterator for DumpStatements {
    type Item = Result<DumpItem, String>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if self.end_owed {
                self.end_owed = false;
                return Some(Ok(DumpItem::CopyEnd));
            }
            if self.copying {
                if let Some((data, done)) = self.splitter.copy_data(COPY_CHUNK) {
                    if done {
                        self.copying = false;
                        if data.is_empty() {
                            return Some(Ok(DumpItem::CopyEnd));
                        }
                        self.end_owed = true;
                    }
                    return Some(Ok(DumpItem::CopyData(data)));
                }
                if self.finished {
                    // Cannot happen (see below), but a loop must not spin on it if it ever does.
                    self.copying = false;
                    return Some(Ok(DumpItem::CopyEnd));
                }
            } else if let Some(s) = self.splitter.next_stmt() {
                if is_copy_from_stdin(&s) {
                    self.splitter.begin_copy();
                    self.copying = true;
                    return Some(Ok(DumpItem::CopyStart(s)));
                }
                return Some(Ok(DumpItem::Stmt(s)));
            } else if self.finished {
                return None;
            }
            // At the end of the file `copy_data` always answers, so this is never reached with
            // `finished` set while copying.
            if let Err(e) = self.fill() {
                return Some(Err(e));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_file(name: &str, bytes: &[u8]) -> String {
        let p =
            std::env::temp_dir().join(format!("tablegrid_dump_test_{}_{name}", std::process::id()));
        std::fs::write(&p, bytes).unwrap();
        p.to_string_lossy().into_owned()
    }

    fn gz(bytes: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        e.write_all(bytes).unwrap();
        e.finish().unwrap()
    }

    fn statements(path: &str) -> Vec<String> {
        let mysql = probe_mysql_script(path).unwrap();
        let dump = open_dump(path).unwrap();
        DumpStatements::new(dump.reader, mysql)
            .map(Result::unwrap)
            .map(|item| match item {
                DumpItem::Stmt(s) => s,
                other => panic!("unexpected {other:?}"),
            })
            .collect()
    }

    const SQL: &str = "CREATE TABLE a (x int);\nINSERT INTO a VALUES (1),(2);\nCREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;\n";

    /// Gzip is recognised by its first two bytes, not the file name.
    #[test]
    fn plain_and_gzip_files_give_the_same_statements() {
        let plain = temp_file("plain.gz", SQL.as_bytes());
        let packed = temp_file("packed.sql", &gz(SQL.as_bytes()));
        assert!(!open_dump(&plain).unwrap().gzip);
        assert!(open_dump(&packed).unwrap().gzip);
        assert_eq!(
            statements(&plain),
            crate::database::split_sql_statements(SQL)
        );
        assert_eq!(
            statements(&packed),
            crate::database::split_sql_statements(SQL)
        );
        let _ = std::fs::remove_file(plain);
        let _ = std::fs::remove_file(packed);
    }

    /// Two gzip members back to back are one file (`cat a.gz b.gz`), not the first member alone.
    #[test]
    fn a_multi_member_gzip_is_read_to_the_end() {
        let mut bytes = gz(b"SELECT 1;\n");
        bytes.extend(gz(b"SELECT 2;\n"));
        let p = temp_file("multi.gz", &bytes);
        assert_eq!(statements(&p), ["SELECT 1", "SELECT 2"]);
        let _ = std::fs::remove_file(p);
    }

    /// A DELIMITER line anywhere — here after a megabyte of other lines — makes `$$` a terminator
    /// for the whole file, exactly as `split_sql_statements` decides it.
    #[test]
    fn the_delimiter_probe_sees_the_whole_file() {
        let mut sql = "SELECT 'x';\n".repeat(100_000);
        sql.push_str("DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;\n");
        let p = temp_file("delim.sql", sql.as_bytes());
        assert!(probe_mysql_script(&p).unwrap());
        assert_eq!(statements(&p), crate::database::split_sql_statements(&sql));
        let _ = std::fs::remove_file(p);

        let q = temp_file("nodelim.sql", SQL.as_bytes());
        assert!(!probe_mysql_script(&q).unwrap());
        let _ = std::fs::remove_file(q);
    }

    /// The probe riding along with the split sees the DELIMITER line too, whichever chunk it lands in.
    #[test]
    fn the_split_reports_a_delimiter_line_it_read() {
        let sql = format!(
            "{}DELIMITER ;;\nSELECT 1;;\n",
            "SELECT 2;\n".repeat(200_000)
        );
        let p = temp_file("ride.sql", sql.as_bytes());
        let dump = open_dump(&p).unwrap();
        let mut it = DumpStatements::new(dump.reader, false);
        for s in it.by_ref() {
            s.unwrap();
        }
        assert!(it.saw_delimiter_line());
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn a_missing_file_is_an_error_not_a_panic() {
        assert!(open_dump("Z:/definitely/not/here.sql").is_err());
    }

    /// What pg_dump's plain format looks like: psql meta-commands between statements, and each
    /// table's data as `COPY … FROM stdin;` followed by tab-separated lines up to `\.`.
    const PG_DUMP: &str = concat!(
        "\\restrict AbC123\n",
        "SET statement_timeout = 0;\n",
        "DROP DATABASE demo;\n",
        "CREATE DATABASE demo;\n",
        "\\connect -reuse-previous=on \"dbname='demo'\"\n",
        "SET client_encoding = 'UTF8';\n",
        "CREATE TABLE bookings.t (id int, note text);\n",
        "COPY bookings.t (id, note) FROM stdin;\n",
        "1\tit's; not SQL\n",
        "2\t\\N\n",
        "\\.\n",
        "COPY bookings.empty (id) FROM stdin;\n",
        "\\.\n",
        "ALTER TABLE ONLY bookings.t ADD CONSTRAINT t_pkey PRIMARY KEY (id);\n",
        "\\unrestrict AbC123\n",
    );

    fn items_of(bytes: &[u8]) -> Vec<DumpItem> {
        // Tests run in parallel and several call this with the same bytes: one file each.
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let p = temp_file(
            &format!("pg{}.sql", SEQ.fetch_add(1, Ordering::Relaxed)),
            bytes,
        );
        let dump = open_dump(&p).unwrap();
        let out: Vec<DumpItem> = DumpStatements::new(dump.reader, false)
            .map(Result::unwrap)
            .collect();
        let _ = std::fs::remove_file(p);
        out
    }

    /// Data pieces merged, so the expectation does not depend on where the chunks fall.
    fn merged(items: Vec<DumpItem>) -> Vec<DumpItem> {
        let mut out: Vec<DumpItem> = Vec::new();
        for it in items {
            match (out.last_mut(), it) {
                (Some(DumpItem::CopyData(acc)), DumpItem::CopyData(more)) => acc.extend(more),
                (_, it) => out.push(it),
            }
        }
        out
    }

    #[test]
    fn a_pg_dump_file_gives_statements_and_copy_blocks() {
        use DumpItem::*;
        let expected = vec![
            Stmt("SET statement_timeout = 0".into()),
            Stmt("DROP DATABASE demo".into()),
            Stmt("CREATE DATABASE demo".into()),
            Stmt("SET client_encoding = 'UTF8'".into()),
            Stmt("CREATE TABLE bookings.t (id int, note text)".into()),
            CopyStart("COPY bookings.t (id, note) FROM stdin".into()),
            CopyData(b"1\tit's; not SQL\n2\t\\N\n".to_vec()),
            CopyEnd,
            CopyStart("COPY bookings.empty (id) FROM stdin".into()),
            CopyEnd,
            Stmt("ALTER TABLE ONLY bookings.t ADD CONSTRAINT t_pkey PRIMARY KEY (id)".into()),
        ];
        assert_eq!(merged(items_of(PG_DUMP.as_bytes())), expected);
        assert_eq!(merged(items_of(&gz(PG_DUMP.as_bytes()))), expected);
        // CRLF line ends: the terminator line is `\.\r`.
        let crlf = PG_DUMP.replace('\n', "\r\n");
        let got = merged(items_of(crlf.as_bytes()));
        assert_eq!(got.iter().filter(|i| **i == CopyEnd).count(), 2);
        assert_eq!(
            got.last(),
            Some(&Stmt(
                "ALTER TABLE ONLY bookings.t ADD CONSTRAINT t_pkey PRIMARY KEY (id)".into()
            ))
        );
    }

    /// A chunk boundary can fall anywhere in a COPY block — inside a line, between `\` and `.` —
    /// so the splitter is driven byte by byte here, the worst case there is.
    #[test]
    fn a_copy_block_survives_any_chunk_boundary() {
        let whole = merged(items_of(PG_DUMP.as_bytes()));
        for chunk in [1usize, 2, 3, 7] {
            let mut sp = StmtSplitter::new(false).with_client_commands();
            let mut got = Vec::new();
            let mut copying = false;
            let bytes = PG_DUMP.as_bytes();
            let mut fed = 0;
            loop {
                let item = if copying {
                    sp.copy_data(COPY_CHUNK)
                        .map(|(d, done)| {
                            if done {
                                copying = false;
                            }
                            (d, done)
                        })
                        .map(|(d, done)| {
                            if !d.is_empty() {
                                got.push(DumpItem::CopyData(d));
                            }
                            if done {
                                got.push(DumpItem::CopyEnd);
                            }
                        })
                } else {
                    sp.next_stmt().map(|s| {
                        if is_copy_from_stdin(&s) {
                            sp.begin_copy();
                            copying = true;
                            got.push(DumpItem::CopyStart(s));
                        } else {
                            got.push(DumpItem::Stmt(s));
                        }
                    })
                };
                if item.is_some() {
                    continue;
                }
                if fed >= bytes.len() {
                    sp.finish();
                    if !copying && sp.next_stmt().is_none() {
                        break;
                    }
                    continue;
                }
                let end = (fed + chunk).min(bytes.len());
                sp.feed(&bytes[fed..end]);
                fed = end;
            }
            assert_eq!(merged(got), whole, "chunk {chunk}");
        }
    }

    #[test]
    fn only_copy_from_stdin_is_a_copy_block() {
        assert!(is_copy_from_stdin("COPY public.t (a, b) FROM stdin"));
        assert!(is_copy_from_stdin(
            "-- Data for t\ncopy t from STDIN with (format text)"
        ));
        assert!(!is_copy_from_stdin("COPY t FROM '/tmp/t.csv'"));
        assert!(!is_copy_from_stdin("COPY (SELECT 1) TO STDOUT"));
        assert!(!is_copy_from_stdin("SELECT 'COPY t FROM stdin'"));
    }
}
