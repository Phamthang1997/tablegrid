//! Streaming an export to disk, a chunk at a time (docs/background-jobs-plan.md, Phase 3).
//!
//! A dump used to be built as ONE JavaScript string, gzipped as a whole, then written in one call:
//! peak memory around three times the dump, and a multi-gigabyte database simply killed the webview
//! with nothing said. Here the frontend opens a sink, appends text as it produces it (a table, a page
//! of rows), and closes it. Only the chunk in flight is ever in memory, on either side.
//!
//! The dump is still BUILT in TypeScript (`dumpBuilder.ts`) — rewriting it in Rust would add a fourth
//! hand-synced twin (plan §4.3). This file only moves bytes.
//!
//! Three properties are load-bearing:
//! - **Written to `<path>.part`, renamed on close.** A job that fails or is cancelled halfway must not
//!   leave a file at the chosen name that looks like a finished backup; `export_abort` deletes the
//!   partial one. The rename is also what makes "overwrite the old backup" safe: the old file is
//!   replaced only once the new one is complete.
//! - **gzip happens here, incrementally**, through `flate2` — the webview's `CompressionStream` needs
//!   the whole input in one `Blob`, which is the thing being removed.
//! - **Blocking I/O runs on `spawn_blocking`.** Writing a chunk is milliseconds, but compressing one is
//!   CPU work, and neither belongs on an async worker thread.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};

use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::{Value, json};

enum Writer {
    Plain(BufWriter<File>),
    Gzip(GzEncoder<BufWriter<File>>),
}

impl Writer {
    fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        match self {
            Writer::Plain(w) => w.write_all(bytes),
            Writer::Gzip(w) => w.write_all(bytes),
        }
    }

    /// Finishes the gzip stream (its trailer carries the CRC and length) and flushes to disk.
    fn finish(self) -> std::io::Result<()> {
        match self {
            Writer::Plain(mut w) => w.flush(),
            Writer::Gzip(w) => w.finish()?.flush(),
        }
    }
}

struct Sink {
    writer: Writer,
    part: PathBuf,
    target: PathBuf,
    /// Uncompressed bytes appended so far, reported back on close.
    bytes: u64,
}

/// Open sinks by handle. A module-level map rather than an `AppState` field: nothing else ever needs
/// to reach it, and a sink is owned by the one job that opened it.
///
/// Each sink sits behind its own `Mutex` inside an `Arc`, so a write holds only ITS sink's lock —
/// two exports running side by side never wait on each other's disk.
static SINKS: LazyLock<Mutex<HashMap<String, SharedSink>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// One open sink. `None` once it has been closed or aborted, so a late append fails cleanly.
type SharedSink = Arc<Mutex<Option<Sink>>>;

fn part_path(target: &std::path::Path) -> PathBuf {
    let mut name = target.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

fn sink_of(handle: &str) -> Result<SharedSink, String> {
    let map = SINKS.lock().map_err(|e| e.to_string())?;
    map.get(handle)
        .cloned()
        .ok_or_else(|| "internal: unknown export handle".to_string())
}

/// Starts an export file at `path` (written as `path.part` until `export_close`).
///
/// `path` must be absolute: it comes from the folder picker joined with a file name, and a relative
/// one would land wherever the process happens to be running from.
#[tauri::command]
pub async fn export_open(path: String, gzip: bool) -> Result<Value, String> {
    Box::pin(async move {
        let target = PathBuf::from(&path);
        if !target.is_absolute() {
            return Err("internal: export path must be absolute".to_string());
        }
        let part = part_path(&target);
        let file = tokio::task::spawn_blocking({
            let part = part.clone();
            move || File::create(part)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        // 1MB of buffering: the frontend already batches its chunks, this only evens out the writes.
        let buffered = BufWriter::with_capacity(1 << 20, file);
        let writer = if gzip {
            Writer::Gzip(GzEncoder::new(buffered, Compression::default()))
        } else {
            Writer::Plain(buffered)
        };
        let handle = uuid::Uuid::new_v4().to_string();
        SINKS.lock().map_err(|e| e.to_string())?.insert(
            handle.clone(),
            Arc::new(Mutex::new(Some(Sink {
                writer,
                part,
                target,
                bytes: 0,
            }))),
        );
        Ok(json!({ "success": true, "handle": handle }))
    })
    .await
}

/// Appends one chunk of text. Chunks arrive in order: the frontend awaits each call before the next.
#[tauri::command]
pub async fn export_append(handle: String, chunk: String) -> Result<Value, String> {
    Box::pin(async move {
        let sink = sink_of(&handle)?;
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let mut guard = sink.lock().map_err(|e| e.to_string())?;
            let s = guard
                .as_mut()
                .ok_or_else(|| "internal: export already closed".to_string())?;
            s.writer
                .write_all(chunk.as_bytes())
                .map_err(|e| e.to_string())?;
            s.bytes += chunk.len() as u64;
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(json!({ "success": true }))
    })
    .await
}

/// Finishes the file and moves it into place, replacing whatever was at the target name.
#[tauri::command]
pub async fn export_close(handle: String) -> Result<Value, String> {
    Box::pin(async move {
        let sink = SINKS
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&handle)
            .ok_or_else(|| "internal: unknown export handle".to_string())?;
        let (path, bytes) =
            tokio::task::spawn_blocking(move || -> Result<(PathBuf, u64), String> {
                let s = sink
                    .lock()
                    .map_err(|e| e.to_string())?
                    .take()
                    .ok_or_else(|| "internal: export already closed".to_string())?;
                let finished = s.writer.finish();
                if let Err(e) = finished {
                    let _ = std::fs::remove_file(&s.part);
                    return Err(e.to_string());
                }
                // `std::fs::rename` REPLACES an existing target, Windows included (it is `MoveFileExW`
                // with `MOVEFILE_REPLACE_EXISTING` there), so the old backup is swapped for the new
                // one in a single step — there is no moment where neither file exists.
                std::fs::rename(&s.part, &s.target).map_err(|e| e.to_string())?;
                Ok((s.target, s.bytes))
            })
            .await
            .map_err(|e| e.to_string())??;
        Ok(json!({ "success": true, "path": path.to_string_lossy(), "bytes": bytes }))
    })
    .await
}

/// Drops an export that will not be finished — failed or cancelled — and deletes the partial file.
/// Never an error: it runs in a `finally`, after the job's real outcome, and an unknown handle means
/// there is nothing left to clean.
#[tauri::command]
pub async fn export_abort(handle: String) -> Result<Value, String> {
    Box::pin(async move {
        let sink = SINKS.lock().ok().and_then(|mut m| m.remove(&handle));
        if let Some(sink) = sink {
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(mut guard) = sink.lock()
                    && let Some(s) = guard.take()
                {
                    drop(s.writer);
                    let _ = std::fs::remove_file(&s.part);
                }
            })
            .await;
        }
        Ok(json!({ "success": true }))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn temp_target(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tablegrid-sink-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[tokio::test]
    async fn plain_chunks_arrive_in_order_and_the_part_file_is_renamed() {
        let target = temp_target("dump.sql");
        let open = export_open(target.to_string_lossy().into(), false)
            .await
            .unwrap();
        let h = open["handle"].as_str().unwrap().to_string();
        assert!(part_path(&target).exists());
        assert!(!target.exists(), "nothing at the real name until close");
        for chunk in ["CREATE TABLE a (x int);\n", "INSERT INTO a VALUES (1);\n"] {
            export_append(h.clone(), chunk.into()).await.unwrap();
        }
        let closed = export_close(h).await.unwrap();
        assert_eq!(closed["bytes"], 50);
        assert!(!part_path(&target).exists());
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "CREATE TABLE a (x int);\nINSERT INTO a VALUES (1);\n"
        );
    }

    #[tokio::test]
    async fn gzip_output_decompresses_to_the_input() {
        let target = temp_target("dump.sql.gz");
        let h = export_open(target.to_string_lossy().into(), true)
            .await
            .unwrap()["handle"]
            .as_str()
            .unwrap()
            .to_string();
        let big = "INSERT INTO t VALUES (1, 'x');\n".repeat(10_000);
        export_append(h.clone(), big.clone()).await.unwrap();
        export_append(h.clone(), "-- end\n".into()).await.unwrap();
        export_close(h).await.unwrap();
        let mut out = String::new();
        flate2::read::GzDecoder::new(File::open(&target).unwrap())
            .read_to_string(&mut out)
            .unwrap();
        assert_eq!(out, format!("{big}-- end\n"));
    }

    #[tokio::test]
    async fn close_replaces_an_existing_file_and_abort_leaves_it_alone() {
        let target = temp_target("dump.sql");
        std::fs::write(&target, "old backup").unwrap();

        // An aborted export must not touch the old file, and must leave no `.part` behind.
        let h = export_open(target.to_string_lossy().into(), false)
            .await
            .unwrap()["handle"]
            .as_str()
            .unwrap()
            .to_string();
        export_append(h.clone(), "half".into()).await.unwrap();
        export_abort(h.clone()).await.unwrap();
        assert!(!part_path(&target).exists());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "old backup");
        // A second abort, or an append after it, is harmless / a clean error.
        export_abort(h.clone()).await.unwrap();
        assert!(export_append(h, "x".into()).await.is_err());

        let h = export_open(target.to_string_lossy().into(), false)
            .await
            .unwrap()["handle"]
            .as_str()
            .unwrap()
            .to_string();
        export_append(h.clone(), "new backup".into()).await.unwrap();
        export_close(h).await.unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new backup");
    }

    #[tokio::test]
    async fn a_relative_path_is_refused() {
        assert!(export_open("dump.sql".into(), false).await.is_err());
    }
}
