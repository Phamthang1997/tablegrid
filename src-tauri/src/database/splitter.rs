//! Splitting a multi-statement SQL string into individual statements.
//!
//! **The twin of `src/sql/statements.ts` — change one side and you must change the other.** The TS one decides
//! what Ctrl+Enter runs and what gets highlighted; this one decides what actually executes. A mismatch means
//! the user runs something other than what they saw highlighted.

// Is this line the mysql client's `DELIMITER <token>` command? Returns the new token.
// It uses `get(..9)` rather than `[..9]`: slicing by byte in the middle of a multi-byte character (Vietnamese...)
// would panic, while `get` returns None.
fn delimiter_token_of_line(line: &str) -> Option<&str> {
    let t = line.trim_start_matches([' ', '\t']);
    if !t.get(..9)?.eq_ignore_ascii_case("DELIMITER") {
        return None;
    }
    let rest = &t[9..];
    if !rest.starts_with([' ', '\t']) {
        return None;
    }
    let token = rest.trim(); // trim also strips the '\r' of a CRLF file
    if token.is_empty() || token.contains(char::is_whitespace) {
        return None;
    }
    Some(token)
}

/// Where a statement's first keyword really is, for deciding whether it WRITES.
///
/// `strip_leading_comments` skips MySQL's executable comments (`/*! … */`, MariaDB's `/*M! … */`)
/// like any other comment, which is right for sorting dump lines and wrong for a security decision:
/// MySQL RUNS the text inside them. `/*!DELETE FROM t WHERE 1 IN */ (SELECT 1)` classified as a
/// SELECT and got past both the connection's read-only lock and the MCP read gate, while the server
/// executed a DELETE. Here an executable comment is opened instead of skipped - the marker and its
/// optional version number go, and the classification continues on the code inside it - so that
/// statement reads as `DELETE`, and mysqldump's `/*!40101 SET NAMES utf8 */` still reads as `SET`.
///
/// Dialect-agnostic on purpose: on Postgres/SQLite `/*!` is an ordinary comment, so this can only
/// ever make a statement look MORE like a write there, never less.
pub(crate) fn classification_head(stmt: &str) -> &str {
    let mut rest = strip_leading_comments_until_exec(stmt);
    loop {
        let marker = if rest.starts_with("/*!") {
            3
        } else if rest.starts_with("/*M!") {
            4
        } else {
            return rest;
        };
        let body = rest[marker..].trim_start_matches(|c: char| c.is_ascii_digit());
        // An empty one (`/*!*/`, `/*!50001 */`) closes straight away and hides nothing.
        let body = body.trim_start();
        let body = body.strip_prefix("*/").unwrap_or(body);
        // Whatever follows may itself start with comments or another executable comment.
        rest = strip_leading_comments_until_exec(body);
    }
}

/// `strip_leading_comments`, but stopping in front of an executable comment instead of skipping it.
fn strip_leading_comments_until_exec(stmt: &str) -> &str {
    let mut s = stmt;
    loop {
        let t = s.trim_start();
        if t.starts_with("/*!") || t.starts_with("/*M!") {
            return t;
        }
        let next = strip_one_leading_comment(t);
        if next.len() == t.len() {
            return t;
        }
        s = next;
    }
}

/// Removes exactly one leading `--`/`#` line comment or `/* */` block, or returns the input.
fn strip_one_leading_comment(t: &str) -> &str {
    let b = t.as_bytes();
    if (b.len() >= 2 && b[0] == b'-' && b[1] == b'-') || b.first() == Some(&b'#') {
        return match t.find('\n') {
            Some(i) => &t[i + 1..],
            None => "",
        };
    }
    if let Some(inner) = t.strip_prefix("/*") {
        return match inner.find("*/") {
            Some(i) => &inner[i + 2..],
            None => "",
        };
    }
    t
}

/// Strip the whitespace and comments at the START of a statement, returning the part that begins with a real SQL keyword.
///
/// The splitter keeps comments inside the statement text, so in a mysqldump dump
///     `-- Dumping data for table `store`` + newline + `LOCK TABLES `store` WRITE`
/// is ONE statement beginning with "--". Classifying by the raw text gets all of it wrong:
/// LOCK/UNLOCK TABLES is not skipped, and `SET`/`USE` is not treated as a session-level statement.
pub(crate) fn strip_leading_comments(stmt: &str) -> &str {
    let b = stmt.as_bytes();
    let mut i = 0usize;
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        // Line comment: -- ... or # ...
        if (i + 1 < b.len() && b[i] == b'-' && b[i + 1] == b'-') || (i < b.len() && b[i] == b'#') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // Block comment: /* ... */ (including MySQL's conditional comments /*!40101 ... */)
        if i + 1 < b.len() && b[i] == b'/' && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(b.len());
            continue;
        }
        break;
    }
    // i always stops after '\n' / '*/' / an ASCII space, so it is still a UTF-8 character boundary.
    &stmt[i.min(stmt.len())..]
}

// Statement head is `CREATE [OR REPLACE] [TEMP|TEMPORARY] [DEFINER=...] TRIGGER`.
fn is_create_trigger_head(seg: &str) -> bool {
    let head = strip_leading_comments(seg).trim_start();
    let mut words = head.split_whitespace();
    if !words
        .next()
        .is_some_and(|w| w.eq_ignore_ascii_case("CREATE"))
    {
        return false;
    }
    for w in words.take(4) {
        if w.eq_ignore_ascii_case("TRIGGER") {
            return true;
        }
        let is_modifier = w.eq_ignore_ascii_case("OR")
            || w.eq_ignore_ascii_case("REPLACE")
            || w.eq_ignore_ascii_case("TEMP")
            || w.eq_ignore_ascii_case("TEMPORARY")
            // MySQL writes the whole clause as one token: DEFINER=`root`@`localhost`
            || w.get(..7).is_some_and(|p| p.eq_ignore_ascii_case("DEFINER"));
        if !is_modifier {
            return false;
        }
    }
    false
}

/// Is this `;` still INSIDE a trigger body rather than the end of the statement?
///
/// A `BEGIN ... END` body carries its own `;`, so splitting on the first one yields a truncated
/// `CREATE TRIGGER ... BEGIN UPDATE t SET ...;` — SQLite answers "incomplete input" and the whole
/// restore rolls back. MySQL avoids this with the client-side `DELIMITER` command, SQLite has no
/// such thing, so the rule has to live here. It is what `sqlite3_complete()` does: a statement
/// starting with CREATE TRIGGER only ends at the `;` that directly follows the `END` keyword.
///
/// Requiring `BEGIN` matters: a Postgres trigger (`... EXECUTE FUNCTION f();`) and MySQL's
/// single-statement form (`... FOR EACH ROW SET NEW.a = 1;`) have no BEGIN block, and making
/// them wait for an `END` would swallow the rest of the dump into one statement.
///
/// Twin of `insideTriggerBody()` in src/sql/statements.ts — keep both in sync.
fn trigger_stmt_incomplete(seg: &str) -> bool {
    if !is_create_trigger_head(seg) {
        return false;
    }
    let b: Vec<char> = seg.chars().collect();
    let n = b.len();
    let mut i = 0usize;
    let mut has_begin = false;
    let mut last_word_is_end = false;

    while i < n {
        let c = b[i];
        let peek = if i + 1 < n { Some(b[i + 1]) } else { None };

        if (c == '-' && peek == Some('-')) || (c == '#' && !matches!(peek, Some('>') | Some('-'))) {
            while i < n && b[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && peek == Some('*') {
            i += 2;
            while i + 1 < n && !(b[i] == '*' && b[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(n);
            continue;
        }
        if c == '\'' || c == '"' || c == '`' {
            let quote = c;
            i += 1;
            while i < n {
                if b[i] == '\\' && quote != '`' {
                    i += 2;
                    continue;
                }
                if b[i] == quote {
                    if quote == '\'' && i + 1 < n && b[i + 1] == '\'' {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            last_word_is_end = false;
            continue;
        }
        if c.is_alphabetic() || c == '_' {
            let s = i;
            while i < n && (b[i].is_alphanumeric() || b[i] == '_' || b[i] == '$') {
                i += 1;
            }
            let word: String = b[s..i].iter().collect();
            if word.eq_ignore_ascii_case("BEGIN") {
                has_begin = true;
            }
            last_word_is_end = word.eq_ignore_ascii_case("END");
            continue;
        }
        if !c.is_whitespace() {
            last_word_is_end = false;
        }
        i += 1;
    }

    has_begin && !last_word_is_end
}
// Cheap pre-check for the trigger rule: skip leading whitespace/comments and compare six bytes.
// A dump of INSERTs bails out on the first byte instead of rebuilding every statement into a
// String only to find it is not a trigger. It may only ever say "maybe": a non-ASCII byte where
// whitespace could be answers true, and `trigger_stmt_incomplete` then applies the real rule.
fn seg_may_be_create(b: &[u8], from: usize, to: usize) -> bool {
    let mut i = from;
    loop {
        while i < to && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < to && !b[i].is_ascii() {
            return true;
        }
        if i + 1 < to && b[i] == b'-' && b[i + 1] == b'-' {
            while i < to && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if i + 1 < to && b[i] == b'/' && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < to && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(to);
            continue;
        }
        break;
    }
    i + 6 <= to && b[i..i + 6].eq_ignore_ascii_case(b"CREATE")
}

/// Does `line` hold a whole `DELIMITER` line that has to be waited for? `None` = not enough bytes
/// to tell yet. Only the first ten bytes decide, so a line that is plainly something else (a
/// one-line INSERT of a hundred megabytes) never makes the scanner wait for its newline.
fn delimiter_candidate(b: &[u8], i: usize, eof: bool) -> Option<bool> {
    let mut t = i;
    while t < b.len() && (b[t] == b' ' || b[t] == b'\t') {
        t += 1;
    }
    if t + 10 > b.len() {
        // Too short for `DELIMITER x`: at the end of the input it cannot become one.
        return if eof { Some(false) } else { None };
    }
    Some(b[t..t + 9].eq_ignore_ascii_case(b"DELIMITER") && (b[t + 9] == b' ' || b[t + 9] == b'\t'))
}

/// Position of `needle` in `hay`, or None.
fn find_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    let first = needle[0];
    let last_start = hay.len() - needle.len();
    let mut k = 0;
    while k <= last_start {
        let p = hay[k..=last_start].iter().position(|&c| c == first)?;
        k += p;
        if hay[k..k + needle.len()] == *needle {
            return Some(k);
        }
        k += 1;
    }
    None
}

/// Where the scan stands between two calls — everything `StmtSplitter` needs to resume.
struct ScanState {
    /// `DELIMITER` only appears in MySQL scripts; there `$$` is a statement terminator, not a
    /// dollar quote. Decided for the WHOLE input, before the first byte is scanned.
    mysql_script: bool,
    /// Treat a line starting with `\` as a psql meta-command (`\connect db`, `\restrict key`)
    /// and consume it, as psql does. Only for dump FILES: pg_dump's plain format writes them
    /// between statements, and sent to the server they are a syntax error that kills the restore.
    /// Off for the SQL editor, which is not psql — a typed `\dt` should reach the server and
    /// fail visibly rather than silently vanish from "run all" — and so off for the TS twin too.
    client_commands: bool,
    delim: Vec<u8>,
    /// The start of the statement being gathered.
    start: usize,
    /// How far the scan has got: nothing between `start` and here ends the statement.
    pos: usize,
    at_line_start: bool,
}

enum Scan {
    /// A statement ends at `end`; the next one starts at `resume`.
    Boundary { end: usize, resume: usize },
    /// The bytes run out inside something that cannot be decided yet (a string, a comment, a
    /// dollar block, a DELIMITER line). `pos` is left at its start, to be rescanned with more.
    NeedMore,
    /// `eof` and nothing is left to scan: whatever lies after `start` is the last statement.
    End,
}

/// One step of the splitter over `b`, from `st.pos`.
///
/// Scans BYTES, not chars: every character the rules look at is ASCII, and a UTF-8 multi-byte
/// sequence never contains an ASCII byte, so the answer is the same as scanning chars — at a
/// quarter of the memory (`Vec<char>` is four bytes a character, i.e. 4GB for a 1GB dump).
///
/// Without `eof`, a construct that runs off the end of `b` is not guessed at: the step answers
/// `NeedMore` and the caller feeds more bytes. With `eof`, it behaves exactly like the original
/// whole-string splitter, which treated an unterminated construct as running to the end.
fn scan_step(b: &[u8], st: &mut ScanState, eof: bool) -> Scan {
    let n = b.len();
    let mut i = st.pos;
    let mut at_ls = st.at_line_start;
    // A peek, a two-byte opener or the delimiter itself must fit before anything is decided.
    let guard = st.delim.len().max(2);

    macro_rules! need_more {
        () => {{
            st.pos = i;
            st.at_line_start = at_ls;
            return Scan::NeedMore;
        }};
    }

    while i < n {
        if !eof && i + guard > n {
            need_more!();
        }
        let c = b[i];
        let peek = b.get(i + 1).copied();

        // Line comment: -- ... | # ...  ('#>' and '#-' are Postgres jsonb operators, not comments)
        if (c == b'-' && peek == Some(b'-'))
            || (c == b'#' && !matches!(peek, Some(b'>') | Some(b'-')))
        {
            match b[i..].iter().position(|&x| x == b'\n') {
                Some(p) => i += p + 1,
                None if !eof => need_more!(),
                None => i = n,
            }
            at_ls = true;
            continue;
        }
        // Block comment: /* ... */
        if c == b'/' && peek == Some(b'*') {
            match find_bytes(&b[i + 2..], b"*/") {
                Some(p) => i += 2 + p + 2,
                None if !eof => need_more!(),
                None => i = n,
            }
            at_ls = false;
            continue;
        }
        // A quoted string / quoted identifier: skip the whole block (including \' and '' escapes)
        if c == b'\'' || c == b'"' || c == b'`' {
            let quote = c;
            let mut k = i + 1;
            let mut closed = false;
            while k < n {
                if b[k] == b'\\' && quote != b'`' {
                    k += 2;
                    continue;
                }
                if b[k] == quote {
                    if quote == b'\'' && k + 1 == n && !eof {
                        // `''` or the end of the string: the next byte decides.
                        break;
                    }
                    if quote == b'\'' && k + 1 < n && b[k + 1] == b'\'' {
                        k += 2;
                        continue;
                    }
                    k += 1;
                    closed = true;
                    break;
                }
                k += 1;
            }
            if !closed && !eof {
                need_more!();
            }
            i = k.min(n);
            at_ls = false;
            continue;
        }
        // A Postgres dollar-quoted block: $$ ... $$ or $tag$ ... $tag$ (not $1 or ${x})
        if !st.mysql_script && c == b'$' {
            let mut j = i + 1;
            while j < n && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                j += 1;
            }
            if j == n && !eof {
                need_more!();
            }
            if j < n
                && b[j] == b'$'
                && (j == i + 1 || b[i + 1].is_ascii_alphabetic() || b[i + 1] == b'_')
            {
                let tag = &b[i..=j];
                match find_bytes(&b[j + 1..], tag) {
                    Some(p) => i = j + 1 + p + tag.len(),
                    None if !eof => need_more!(),
                    None => i = n,
                }
                at_ls = false;
                continue;
            }
        }
        // A psql meta-command: the whole line is consumed and ends the statement before it, the
        // same way a DELIMITER line does. pg_dump only writes them between statements.
        if at_ls && st.client_commands {
            let mut t = i;
            while t < n && (b[t] == b' ' || b[t] == b'\t') {
                t += 1;
            }
            if t == n && !eof {
                need_more!();
            }
            if t < n && b[t] == b'\\' {
                let resume = match b[t..].iter().position(|&x| x == b'\n') {
                    Some(p) => t + p + 1,
                    None if !eof => need_more!(),
                    None => n,
                };
                st.pos = resume;
                st.at_line_start = true;
                return Scan::Boundary { end: i, resume };
            }
        }
        // The DELIMITER command (at the start of a line): it changes the statement terminator, and
        // the line itself is not a statement. This command is NOT SQL: sending it to the server errors out.
        if at_ls {
            match delimiter_candidate(b, i, eof) {
                None => need_more!(),
                Some(true) => {
                    let line_end = match b[i..].iter().position(|&x| x == b'\n') {
                        Some(p) => Some(i + p),
                        None if !eof => need_more!(),
                        None => None,
                    };
                    let line = String::from_utf8_lossy(&b[i..line_end.unwrap_or(n)]);
                    if let Some(token) = delimiter_token_of_line(&line) {
                        let resume = line_end.map_or(n, |e| e + 1);
                        st.delim = token.as_bytes().to_vec();
                        st.pos = resume;
                        st.at_line_start = true;
                        return Scan::Boundary { end: i, resume };
                    }
                }
                Some(false) => {}
            }
        }
        // The statement terminator currently in force
        if b[i..].starts_with(&st.delim) {
            // A ';' inside a trigger's BEGIN...END body is not the end of the statement. Only
            // while the delimiter is still ';': a MySQL script that issued DELIMITER already
            // protects the body that way.
            if st.delim == b";"
                && seg_may_be_create(b, st.start, i)
                && trigger_stmt_incomplete(&String::from_utf8_lossy(&b[st.start..i]))
            {
                i += 1;
                at_ls = false;
                continue;
            }
            let resume = i + st.delim.len();
            st.pos = resume;
            st.at_line_start = false;
            return Scan::Boundary { end: i, resume };
        }

        at_ls = c == b'\n';
        i += 1;
    }

    st.pos = i;
    st.at_line_start = at_ls;
    if eof { Scan::End } else { Scan::NeedMore }
}

/// The text of `b[from..to]` as a statement, or None when it is only whitespace.
///
/// Lossy on purpose: a dump with a stray invalid byte used to be read by the webview's
/// `readAsText`, which replaced it with U+FFFD the same way. A boundary is always an ASCII byte, so
/// no valid character is ever cut in half here.
fn stmt_text(b: &[u8], from: usize, to: usize) -> Option<String> {
    let s = String::from_utf8_lossy(&b[from..to]);
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Is this `COPY … FROM stdin`, i.e. a statement whose data follows it in the dump instead of in it?
/// `COPY … FROM '/file'` and `COPY … TO STDOUT` are ordinary statements.
pub(crate) fn is_copy_from_stdin(stmt: &str) -> bool {
    let body = strip_leading_comments(stmt);
    if !body
        .get(..4)
        .is_some_and(|h| h.eq_ignore_ascii_case("COPY"))
    {
        return false;
    }
    let words: Vec<&str> = body.split_whitespace().collect();
    words
        .windows(2)
        .any(|w| w[0].eq_ignore_ascii_case("FROM") && w[1].eq_ignore_ascii_case("STDIN"))
}

/// Does this input issue a `DELIMITER` command anywhere? Decides `mysql_script` for a whole file.
pub(crate) fn line_is_delimiter_command(line: &[u8]) -> bool {
    delimiter_candidate(line, 0, true) == Some(true)
        && delimiter_token_of_line(&String::from_utf8_lossy(line)).is_some()
}

/// The splitter fed a piece at a time — what `restore_backup` uses to read a dump file without
/// holding it in memory.
///
/// Bytes go in through `feed`, whole statements come out of `next_stmt`. Only the statement
/// currently being gathered is buffered: `feed` drops everything before it. `mysql_script` has to
/// be known up front (a `DELIMITER` line late in the file changes what an early `$$` means), which
/// is why a file is probed with `line_is_delimiter_command` before it is split.
pub(crate) struct StmtSplitter {
    buf: Vec<u8>,
    st: ScanState,
    eof: bool,
    done: bool,
    /// In a COPY data block, the rest of the `COPY … FROM stdin;` line is still to be skipped.
    copy_skip_line: bool,
}

impl StmtSplitter {
    pub(crate) fn new(mysql_script: bool) -> Self {
        Self {
            buf: Vec::new(),
            st: ScanState {
                mysql_script,
                client_commands: false,
                delim: b";".to_vec(),
                start: 0,
                pos: 0,
                at_line_start: true,
            },
            eof: false,
            done: false,
            copy_skip_line: false,
        }
    }

    /// The splitter for a dump FILE: psql meta-command lines are consumed (see
    /// `ScanState::client_commands`).
    pub(crate) fn with_client_commands(mut self) -> Self {
        self.st.client_commands = true;
        self
    }

    /// The statement `next_stmt` just returned was a `COPY … FROM stdin`: what follows its line is
    /// data, not SQL, up to a line holding only `\.` — read it with `copy_data`.
    pub(crate) fn begin_copy(&mut self) {
        self.copy_skip_line = true;
    }

    /// The next piece of a COPY data block, whole lines only, about `max` bytes: `Some((bytes,
    /// done))`, or None when more input is needed first. `done` means the `\.` line has been
    /// consumed and `next_stmt` carries on after it.
    ///
    /// The data is never scanned: a data line holding a `'` or a `;` is only data, and scanning
    /// a 150MB block for statements is also what made a pg_dump file one statement of 158MB.
    pub(crate) fn copy_data(&mut self, max: usize) -> Option<(Vec<u8>, bool)> {
        let b = &self.buf;
        let n = b.len();
        let mut at = self.st.start;
        let mut out = Vec::new();
        let mut done = false;
        if self.copy_skip_line {
            match b[at..].iter().position(|&c| c == b'\n') {
                Some(p) => {
                    at += p + 1;
                    self.copy_skip_line = false;
                }
                None if self.eof => {
                    at = n;
                    self.copy_skip_line = false;
                    done = true;
                }
                None => return None,
            }
        }
        while !done && out.len() < max {
            match b[at..].iter().position(|&c| c == b'\n') {
                Some(p) => {
                    let line = &b[at..at + p];
                    if line.strip_suffix(b"\r").unwrap_or(line) == b"\\." {
                        at += p + 1;
                        done = true;
                        break;
                    }
                    out.extend_from_slice(&b[at..=at + p]);
                    at += p + 1;
                }
                None if self.eof => {
                    // A file cut off before its `\.`: what is there is still data.
                    let rest = &b[at..];
                    if rest.strip_suffix(b"\r").unwrap_or(rest) != b"\\." {
                        out.extend_from_slice(rest);
                    }
                    at = n;
                    done = true;
                }
                None => break,
            }
        }
        self.st.start = at;
        self.st.pos = at;
        self.st.at_line_start = true;
        if out.is_empty() && !done {
            return None;
        }
        Some((out, done))
    }

    pub(crate) fn feed(&mut self, bytes: &[u8]) {
        if self.st.start > 0 {
            self.buf.drain(..self.st.start);
            self.st.pos -= self.st.start;
            self.st.start = 0;
        }
        self.buf.extend_from_slice(bytes);
    }

    /// No more bytes will come: what is left is scanned as the end of the input.
    pub(crate) fn finish(&mut self) {
        self.eof = true;
    }

    /// The next whole statement, or None when it needs more bytes (or, after `finish`, when the
    /// input is exhausted).
    pub(crate) fn next_stmt(&mut self) -> Option<String> {
        while !self.done {
            match scan_step(&self.buf, &mut self.st, self.eof) {
                Scan::Boundary { end, resume } => {
                    let s = stmt_text(&self.buf, self.st.start, end);
                    self.st.start = resume;
                    if s.is_some() {
                        return s;
                    }
                }
                Scan::NeedMore => return None,
                Scan::End => {
                    self.done = true;
                    return stmt_text(&self.buf, self.st.start, self.buf.len());
                }
            }
        }
        None
    }
}

// Split a multi-statement SQL string into individual statements. It recognises:
//   - quoted strings ('..', "..", `..`) and '\' escapes
//   - comment `-- ...`, `# ...`, `/* ... */`
//   - Postgres dollar-quoted blocks ($$ ... $$, $tag$ ... $tag$) — a function body contains ';'
//   - MySQL's DELIMITER command — it changes the statement terminator so trigger/procedure bodies can be written
// Without the last two, a file containing a function/trigger would be cut in the middle of the body and could
// run a statement that sits inside it by mistake.
//
// The same scanner as `StmtSplitter`, run over the whole string at once (`eof` from the start), so
// the in-memory and the streamed restore can never split a dump differently.
pub(crate) fn split_sql_statements(sql: &str) -> Vec<String> {
    let b = sql.as_bytes();
    let mut st = ScanState {
        mysql_script: sql.lines().any(|l| delimiter_token_of_line(l).is_some()),
        client_commands: false,
        delim: b";".to_vec(),
        start: 0,
        pos: 0,
        at_line_start: true,
    };
    let mut out = Vec::new();
    loop {
        match scan_step(b, &mut st, true) {
            Scan::Boundary { end, resume } => {
                out.extend(stmt_text(b, st.start, end));
                st.start = resume;
            }
            Scan::NeedMore | Scan::End => {
                out.extend(stmt_text(b, st.start, b.len()));
                return out;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(sql: &str) -> Vec<String> {
        split_sql_statements(sql)
    }

    #[test]
    fn splits_on_the_semicolon_and_trims() {
        assert_eq!(split("SELECT 1; SELECT 2"), ["SELECT 1", "SELECT 2"]);
        assert_eq!(
            split("SELECT 1;\r\nSELECT 2;\r\n"),
            ["SELECT 1", "SELECT 2"]
        );
        assert!(split("   \n\t ").is_empty());
    }

    #[test]
    fn a_semicolon_inside_a_string_or_a_comment_is_not_a_separator() {
        assert_eq!(split("SELECT ';'; SELECT 2"), ["SELECT ';'", "SELECT 2"]);
        assert_eq!(
            split("SELECT 1 -- a;b\n; /* c;d */ SELECT 2"),
            ["SELECT 1 -- a;b", "/* c;d */ SELECT 2"]
        );
    }

    /// Deliberately DIFFERENT from the TS twin (`src/sql/statements.ts`), which drops a segment
    /// that is only a comment. Here they survive: `restore_backup` filters them itself through
    /// `is_skipped_stmt`, and dropping them would lose a dump's own header comments before that
    /// decision is made.
    #[test]
    fn a_comment_only_segment_survives() {
        assert_eq!(
            split("-- hi\nSELECT 1;\n/* block */"),
            ["-- hi\nSELECT 1", "/* block */"]
        );
    }

    #[test]
    fn a_dollar_quoted_body_is_not_split() {
        assert_eq!(
            split(
                "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql; SELECT 1"
            ),
            [
                "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql",
                "SELECT 1"
            ]
        );
        assert_eq!(
            split(
                "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql; SELECT 2"
            ),
            [
                "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql",
                "SELECT 2"
            ]
        );
    }

    /// A bind placeholder and a query parameter both start with `$` and must not open a block —
    /// if they did, everything after `$1` would be swallowed into one statement.
    #[test]
    fn a_bind_placeholder_does_not_open_a_dollar_block() {
        assert_eq!(
            split("SELECT $1; SELECT ${x}"),
            ["SELECT $1", "SELECT ${x}"]
        );
    }

    /// The DELIMITER line is a CLIENT command: it is consumed here and never sent to the server,
    /// which would reject it.
    #[test]
    fn the_delimiter_line_is_consumed_never_emitted() {
        assert_eq!(
            split(
                "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;\nSELECT 2;"
            ),
            ["CREATE PROCEDURE p() BEGIN SELECT 1; END", "SELECT 2"]
        );
        // mysqldump --routines writes `;;`.
        assert_eq!(
            split("DELIMITER ;;\nCREATE PROCEDURE p() BEGIN SELECT 1; END;;\nDELIMITER ;"),
            ["CREATE PROCEDURE p() BEGIN SELECT 1; END"]
        );
    }

    /// In a script that uses DELIMITER, `$$` is the statement terminator — not a Postgres
    /// dollar-quote. Reading it as one would merge the whole file into a single statement.
    #[test]
    fn dollar_dollar_is_a_terminator_in_a_delimiter_script() {
        let sql = "DELIMITER $$\nCREATE PROCEDURE a() BEGIN SELECT 1; END$$\nCREATE PROCEDURE b() BEGIN SELECT 2; END$$";
        assert_eq!(split(sql).len(), 2);
    }

    #[test]
    fn delimiter_is_only_a_command_at_the_start_of_a_line() {
        assert_eq!(
            split("SELECT 'DELIMITER $$'; SELECT 2"),
            ["SELECT 'DELIMITER $$'", "SELECT 2"]
        );
        assert_eq!(
            split("SELECT 1 DELIMITER //;\nSELECT 2;"),
            ["SELECT 1 DELIMITER //", "SELECT 2"]
        );
    }

    /// Outside a script that issued DELIMITER, `$$` is a Postgres dollar-quote and nothing else —
    /// even right after the word DELIMITER. That is why `mysql_script` is decided once for the
    /// WHOLE input rather than per statement: the same two characters cannot mean both things in
    /// one file, and guessing per statement would split a Postgres function body in half.
    #[test]
    fn outside_a_delimiter_script_dollar_dollar_always_opens_a_block() {
        assert_eq!(
            split("SELECT 1 DELIMITER $$;\nSELECT 2;"),
            ["SELECT 1 DELIMITER $$;\nSELECT 2;"]
        );
    }

    /// `sqlite3_complete()`'s rule, and SQLite needs it because it has no DELIMITER: a trigger
    /// whose body contains BEGIN only ends at the `;` that follows END. Without this an exported
    /// trigger came back truncated and killed the whole restore.
    #[test]
    fn a_trigger_body_holds_together() {
        assert_eq!(
            split("CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n = 1; END;\nSELECT 9;"),
            [
                "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n = 1; END",
                "SELECT 9"
            ]
        );
        // END, then a comment, then the terminator.
        assert_eq!(
            split(
                "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n=1; END -- done\n;\nSELECT 9;"
            ),
            [
                "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n=1; END -- done",
                "SELECT 9"
            ]
        );
    }

    /// Requiring the BEGIN word is what keeps the rule from swallowing the rest of a dump: a
    /// Postgres trigger and MySQL's single-statement form both end at their first `;`.
    #[test]
    fn a_trigger_without_begin_ends_at_its_first_semicolon() {
        assert_eq!(
            split("CREATE TRIGGER t AFTER INSERT ON a EXECUTE FUNCTION f();\nSELECT 9;"),
            [
                "CREATE TRIGGER t AFTER INSERT ON a EXECUTE FUNCTION f()",
                "SELECT 9"
            ]
        );
        assert_eq!(
            split("CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW SET NEW.x = 1;\nSELECT 9;"),
            [
                "CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW SET NEW.x = 1",
                "SELECT 9"
            ]
        );
    }

    /// The rule is scoped to triggers: a BEGIN that is only a value, and any other CREATE, must
    /// split normally.
    #[test]
    fn the_trigger_rule_does_not_leak_to_other_statements() {
        assert_eq!(
            split("INSERT INTO t VALUES ('BEGIN'); SELECT 1;"),
            ["INSERT INTO t VALUES ('BEGIN')", "SELECT 1"]
        );
        assert_eq!(
            split("CREATE TABLE t (a INT); SELECT 1;"),
            ["CREATE TABLE t (a INT)", "SELECT 1"]
        );
    }

    #[test]
    fn strip_leading_comments_reaches_the_first_keyword() {
        assert_eq!(
            strip_leading_comments("-- header\n/* x */\n  SELECT 1"),
            "SELECT 1"
        );
        assert_eq!(strip_leading_comments("SELECT 1"), "SELECT 1");
        assert_eq!(strip_leading_comments("  /* only */  ").trim(), "");
    }

    /// MySQL runs what is inside `/*! … */`, so a write hidden there must classify as the write.
    #[test]
    fn classification_head_opens_executable_comments_instead_of_skipping_them() {
        let head = |s: &str| {
            classification_head(s)
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_string()
        };
        assert_eq!(
            head("/*!DELETE FROM orders WHERE 1 IN */ (SELECT 1)"),
            "DELETE"
        );
        assert_eq!(head("/*!50001 DROP TABLE t */"), "DROP");
        assert_eq!(head("/*M!100100 UPDATE t SET a = 1 */"), "UPDATE");
        assert_eq!(head("-- note\n/* plain */ /*!DELETE FROM t */"), "DELETE");
        // mysqldump's own header still reads as the session statement it is.
        assert_eq!(head("/*!40101 SET NAMES utf8 */"), "SET");
        // An empty executable comment hides nothing: what follows it is the statement.
        assert_eq!(head("/*!*/ DELETE FROM t"), "DELETE");
        assert_eq!(head("/*!50001 */ UPDATE t SET a = 1"), "UPDATE");
        // Ordinary comments are still skipped, and an unterminated one leaves nothing to classify.
        assert_eq!(head("/* SELECT */ DELETE FROM t"), "DELETE");
        assert_eq!(head("/* daily report */ SELECT 1"), "SELECT");
        assert_eq!(head("/* never closed SELECT 1"), "");
    }

    /// Feeds `sql` to the streaming splitter `chunk` bytes at a time.
    fn split_streamed(sql: &str, chunk: usize) -> Vec<String> {
        let mysql = sql.lines().any(|l| line_is_delimiter_command(l.as_bytes()));
        let mut sp = StmtSplitter::new(mysql);
        let mut out = Vec::new();
        for piece in sql.as_bytes().chunks(chunk) {
            sp.feed(piece);
            while let Some(s) = sp.next_stmt() {
                out.push(s);
            }
        }
        sp.finish();
        while let Some(s) = sp.next_stmt() {
            out.push(s);
        }
        out
    }

    /// The restore reads a dump in pieces, and a piece may end anywhere — inside a string, between
    /// the two quotes of an `''` escape, halfway through `$tag$`, `DELIMITER` or `*/`. Every piece
    /// size, down to one byte, must give exactly what the whole-string splitter gives.
    #[test]
    fn streaming_gives_the_same_statements_whatever_the_chunk_size() {
        let corpus = [
            "SELECT 1; SELECT 2",
            "SELECT ';'; SELECT 'it''s'; SELECT 'a\'b'; SELECT \"x;y\"; SELECT `c;d`;",
            "SELECT 1 -- a;b\n; /* c;d */ SELECT 2; # hash;\nSELECT 3; SELECT '{}'::jsonb #> '{a}';",
            "-- hi\nSELECT 1;\n/* block */",
            "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql; SELECT $1; SELECT ${x};",
            "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql; SELECT 2",
            "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;\nSELECT 2;",
            "DELIMITER ;;\nCREATE PROCEDURE p() BEGIN SELECT 1; END;;\nDELIMITER ;",
            "  delimiter //\r\nCREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW BEGIN SET NEW.x = 1; END//\r\ndelimiter ;\r\nSELECT 'DELIMITER $$';",
            "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n = 1; END;\nSELECT 9;",
            "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n=1; END -- done\n;\nSELECT 9;",
            "INSERT INTO t VALUES ('Tiếng Việt; có dấu', 'ｘ'), ('日本語;');\nSELECT 'unterminated",
            "SELECT 1 /* never closed ; SELECT 2",
            "INSERT INTO t VALUES ('');SELECT ''''; SELECT '\\';",
        ];
        for sql in corpus {
            let whole = split_sql_statements(sql);
            for chunk in 1..=sql.len() + 1 {
                assert_eq!(
                    split_streamed(sql, chunk),
                    whole,
                    "chunk {chunk} of {sql:?}"
                );
            }
        }
    }

    #[test]
    fn a_delimiter_line_is_recognised_on_its_own_bytes() {
        assert!(line_is_delimiter_command(b"DELIMITER $$"));
        assert!(line_is_delimiter_command(b"  delimiter ;;\r"));
        assert!(!line_is_delimiter_command(b"DELIMITER"));
        assert!(!line_is_delimiter_command(b"SELECT 1 DELIMITER $$"));
        assert!(!line_is_delimiter_command(b"DELIMITERX $$"));
    }
}
