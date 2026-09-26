//! pg_dump's archive formats (`-Fc` custom, `-Ft` tar), read by converting them to SQL through the
//! machine's own `pg_restore`.
//!
//! The custom format is compressed table-of-contents + data that only `pg_restore` understands, and
//! re-implementing it here would be a second, wrong copy of Postgres' archiver. Run without `-d`,
//! `pg_restore <file>` writes exactly the plain-format script `pg_dump -Fp` would have written, to
//! stdout — so it is simply another byte stream for `DumpStatements`, and everything the plain path
//! does (COPY blocks, psql meta-commands, the table filter, cancel) applies unchanged.
//!
//! The cost is a dependency on the machine: `pg_restore` has to be installed, and at least as new as
//! the `pg_dump` that wrote the archive (an older one stops with "unsupported version … in file
//! header"). That is why the newest one found is used, and why its version is reported to the UI.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

/// An archive format `pg_restore` reads, recognised by its bytes rather than its file name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PgArchive {
    /// `pg_dump -Fc`: starts with the magic `PGDMP`.
    Custom,
    /// `pg_dump -Ft`: a tar whose first member is `toc.dat`.
    Tar,
}

pub(crate) fn detect_pg_archive(head: &[u8]) -> Option<PgArchive> {
    if head.starts_with(b"PGDMP") {
        return Some(PgArchive::Custom);
    }
    // ustar header: the member name in bytes 0..100, the magic `ustar` at 257.
    if head.len() >= 262 && &head[257..262] == b"ustar" {
        let name_end = head[..100].iter().position(|&c| c == 0).unwrap_or(100);
        if &head[..name_end] == b"toc.dat" {
            return Some(PgArchive::Tar);
        }
    }
    None
}

/// Builds a `Command` that opens no console window on Windows (the app has no console, and a
/// console program started from it would otherwise flash one up). Same as `terminal/docker.rs`.
fn silent_command(program: &Path) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// `pg_restore (PostgreSQL) 18.6` → (18, 6). Development builds say `18beta2`, `19devel`.
pub(crate) fn parse_pg_restore_version(out: &str) -> Option<(u32, u32)> {
    let v = out.split_whitespace().last()?;
    let mut parts = v.split('.');
    let digits = |s: &str| {
        s.chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
    };
    let major: u32 = digits(parts.next()?).parse().ok()?;
    let minor: u32 = parts
        .next()
        .map(digits)
        .and_then(|m| m.parse().ok())
        .unwrap_or(0);
    Some((major, minor))
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Every `bin` directory of every version found under `root/<version>/bin` (or the extra `sub`).
fn versioned_bins(root: &Path, sub: &str, out: &mut Vec<PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            out.push(e.path().join(sub));
        }
    }
}

/// Where `pg_restore` may live: PATH first, then the usual install roots of each OS.
fn candidates() -> Vec<PathBuf> {
    let name = exe("pg_restore");
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    #[cfg(windows)]
    {
        for pf in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(pf) {
                let root = PathBuf::from(root);
                versioned_bins(&root.join("PostgreSQL"), "bin", &mut dirs);
                dirs.push(root.join("pgAdmin 4").join("runtime"));
            }
        }
        versioned_bins(Path::new(r"C:\laragon\bin\postgresql"), "bin", &mut dirs);
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(
                PathBuf::from(local)
                    .join("Programs")
                    .join("pgAdmin 4")
                    .join("runtime"),
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        dirs.push("/opt/homebrew/bin".into());
        dirs.push("/usr/local/bin".into());
        dirs.push("/opt/homebrew/opt/libpq/bin".into());
        versioned_bins(
            Path::new("/Applications/Postgres.app/Contents/Versions"),
            "bin",
            &mut dirs,
        );
        if let Ok(entries) = std::fs::read_dir("/opt/homebrew/opt") {
            for e in entries.flatten() {
                if e.file_name().to_string_lossy().starts_with("postgresql") {
                    dirs.push(e.path().join("bin"));
                }
            }
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        versioned_bins(Path::new("/usr/lib/postgresql"), "bin", &mut dirs);
        dirs.push("/usr/pgsql/bin".into());
    }
    let mut seen = std::collections::HashSet::new();
    dirs.into_iter()
        .map(|d| d.join(&name))
        .filter(|p| p.is_file() && seen.insert(p.clone()))
        .collect()
}

/// The `pg_restore` to use, with its version text.
#[derive(Debug, Clone)]
pub(crate) struct PgRestore {
    pub(crate) path: PathBuf,
    /// "pg_restore 18.6" — shown in the restore dialogs.
    pub(crate) label: String,
    pub(crate) major: u32,
}

/// Found once and remembered (probing runs `--version` on each candidate); a miss is not cached,
/// so installing the client tools while the app is open works on the next pick.
static FOUND: Mutex<Option<PgRestore>> = Mutex::new(None);

/// The newest `pg_restore` on the machine: a newer one reads every older archive, an older one
/// refuses a newer archive.
pub(crate) fn find_pg_restore() -> Option<PgRestore> {
    if let Some(found) = FOUND.lock().ok().and_then(|g| g.clone()) {
        return Some(found);
    }
    let mut best: Option<((u32, u32), PgRestore)> = None;
    for path in candidates() {
        let Ok(out) = silent_command(&path).arg("--version").output() else {
            continue;
        };
        let text = String::from_utf8_lossy(&out.stdout);
        let Some(ver) = parse_pg_restore_version(&text) else {
            continue;
        };
        if best.as_ref().is_none_or(|(b, _)| ver > *b) {
            let label = format!("pg_restore {}.{}", ver.0, ver.1);
            best = Some((
                ver,
                PgRestore {
                    path,
                    label,
                    major: ver.0,
                },
            ));
        }
    }
    let found = best.map(|(_, p)| p)?;
    if let Ok(mut g) = FOUND.lock() {
        *g = Some(found.clone());
    }
    Some(found)
}

/// The most of `pg_restore`'s stderr kept for an error message.
const STDERR_MAX: usize = 4000;

/// `pg_restore`'s SQL output as a `Read`. At the end of the stream it waits for the process, and
/// a non-zero exit becomes a read error carrying pg_restore's own message — otherwise an archive
/// it could not read (too new, corrupt) would look like an empty dump that restored nothing.
/// Dropping it (a cancelled or failed restore) kills the process, so none is left behind.
pub(crate) struct PgRestoreReader {
    child: Child,
    stdout: ChildStdout,
    stderr: Arc<Mutex<Vec<u8>>>,
    /// Set when the archive is fed through stdin and READING it failed (a corrupt gzip). That is
    /// the real cause; pg_restore only sees its input end early and says "unexpected end of file".
    feed_error: Arc<Mutex<Option<String>>>,
    finished: bool,
}

/// Where pg_restore reads the archive from.
pub(crate) enum ArchiveInput {
    /// A file on disk: pg_restore opens it itself, and can seek in it.
    Path(String),
    /// A stream — a gzipped archive decompressed on the fly — copied into pg_restore's stdin by a
    /// thread of its own. pg_restore reads a piped archive front to back, which is the order a
    /// script (no `-d`, no `-j`) is written in anyway.
    Stream(Box<dyn Read + Send>),
}

impl PgRestoreReader {
    pub(crate) fn spawn(tool: &PgRestore, input: ArchiveInput) -> Result<Self, String> {
        let mut cmd = silent_command(&tool.path);
        // From 12 on, pg_restore refuses to run without -d or -f, and `-f -` is stdout. Before 12
        // there was no such rule and `-` would be taken as a file name, so it is left out there.
        if tool.major >= 12 {
            cmd.args(["-f", "-"]);
        }
        // No file argument at all means "read the archive from stdin".
        let (stdin, stream) = match input {
            ArchiveInput::Path(path) => {
                cmd.arg(path);
                (Stdio::null(), None)
            }
            ArchiveInput::Stream(source) => (Stdio::piped(), Some(source)),
        };
        let mut child = cmd
            .stdin(stdin)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("pg_restore báo lỗi: {e}"))?;
        let feed_error = Arc::new(Mutex::new(None));
        if let Some(mut source) = stream {
            let mut sink = child.stdin.take().ok_or("pg_restore báo lỗi: no stdin")?;
            let slot = feed_error.clone();
            std::thread::spawn(move || {
                // A write error is pg_restore having exited (or been killed on drop) — its own
                // stderr says why, so only a READ error is worth keeping. Dropping `sink` at the
                // end closes stdin, which is how pg_restore learns the archive is complete.
                let mut buf = vec![0u8; 256 * 1024];
                loop {
                    let n = match source.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => n,
                        Err(e) => {
                            if let Ok(mut s) = slot.lock() {
                                *s = Some(e.to_string());
                            }
                            break;
                        }
                    };
                    if std::io::Write::write_all(&mut sink, &buf[..n]).is_err() {
                        break;
                    }
                }
            });
        }
        let stdout = child.stdout.take().ok_or("pg_restore báo lỗi: no stdout")?;
        let mut err_pipe = child.stderr.take().ok_or("pg_restore báo lỗi: no stderr")?;
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let sink = stderr.clone();
        // Drained on a thread of its own: a pipe nobody reads fills up and blocks the process.
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = err_pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if let Ok(mut s) = sink.lock()
                    && s.len() < STDERR_MAX
                {
                    let room = STDERR_MAX - s.len();
                    s.extend_from_slice(&buf[..n.min(room)]);
                }
            }
        });
        Ok(Self {
            child,
            stdout,
            stderr,
            feed_error,
            finished: false,
        })
    }
}

impl Read for PgRestoreReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.finished {
            return Ok(0);
        }
        let n = self.stdout.read(buf)?;
        if n > 0 {
            return Ok(n);
        }
        self.finished = true;
        let status = self.child.wait()?;
        let feed_error = self.feed_error.lock().ok().and_then(|mut s| s.take());
        if let Some(e) = feed_error {
            // The archive could not be read to its end; whatever pg_restore wrote before that is
            // a truncated script, even if it happened to exit 0.
            return Err(std::io::Error::other(e));
        }
        if status.success() {
            return Ok(0);
        }
        // Give the stderr thread a moment to see the pipe close.
        std::thread::sleep(std::time::Duration::from_millis(50));
        let text = self
            .stderr
            .lock()
            .map(|s| String::from_utf8_lossy(&s).trim().to_string())
            .unwrap_or_default();
        let text = if text.is_empty() {
            status.to_string()
        } else {
            text
        };
        Err(std::io::Error::other(format!("pg_restore báo lỗi: {text}")))
    }
}

impl Drop for PgRestoreReader {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archives_are_recognised_by_their_bytes() {
        assert_eq!(
            detect_pg_archive(b"PGDMP\x01\x10\x00"),
            Some(PgArchive::Custom)
        );
        let mut tar = vec![0u8; 512];
        tar[..7].copy_from_slice(b"toc.dat");
        tar[257..262].copy_from_slice(b"ustar");
        assert_eq!(detect_pg_archive(&tar), Some(PgArchive::Tar));
        // Some other tar, and plain SQL: not ours.
        tar[..7].copy_from_slice(b"foo.txt");
        assert_eq!(detect_pg_archive(&tar), None);
        assert_eq!(detect_pg_archive(b"-- PostgreSQL database dump\n"), None);
    }

    #[test]
    fn versions_are_read_from_the_banner() {
        assert_eq!(
            parse_pg_restore_version("pg_restore (PostgreSQL) 18.6\n"),
            Some((18, 6))
        );
        assert_eq!(
            parse_pg_restore_version("pg_restore (PostgreSQL) 9.6.24"),
            Some((9, 6))
        );
        assert_eq!(
            parse_pg_restore_version("pg_restore (PostgreSQL) 19beta2"),
            Some((19, 0))
        );
        // Debian's packages append their own build to the banner.
        assert_eq!(
            parse_pg_restore_version("pg_restore (PostgreSQL) 12.4 (Debian 12.4-1)"),
            Some((12, 4))
        );
        assert_eq!(parse_pg_restore_version("garbage"), None);
    }
}
