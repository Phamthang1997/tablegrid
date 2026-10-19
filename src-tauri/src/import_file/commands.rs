//! The import dialog's commands: what a file is (`import_file_detect`), its columns and first rows
//! (`import_file_probe`), and a dry run over all of it (`import_file_check`). The write itself is
//! `table_import.rs`, which reads the file through `FileFeed` below.
//!
//! None of these send the file across IPC. The dialog holds a PATH; what comes back is a header, a
//! sample of 20 rows, counts and at most 50 problems — the same shape whatever the file's size.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::ipc::Channel;

use super::cell::Cell;
use super::coerce::{CoerceOptions, Inference, Issue, Prepared, Target, coerce_cell};
use super::source::{Detected, Kind, ReadInfo, Record, Shaper, SourceOptions, detect, read_rows};

/// Rows read for the preview: enough for a JSON file's keys to show up and for a sample value per
/// column, few enough to answer at once.
const PROBE_ROWS: usize = 200;
/// Rows shown in the preview grid.
const SAMPLE_ROWS: usize = 20;
/// Problems described by the dry run (all of them are counted).
const ISSUES_KEPT: usize = 50;

/// A target column and the source column (index into the header) that feeds it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappedColumn {
    pub target: Target,
    pub source: usize,
}

/// One cell that cannot go into its column.
fn issue_json(row: u64, column: &str, issue: Issue, value: &Cell) -> Value {
    json!({ "row": row, "column": column, "issue": issue, "value": value.display() })
}

/// One record through the mapping: the values to bind, or the problems that stop it.
pub(crate) fn convert(
    rec: &Record,
    cols: &[(usize, Prepared)],
    opts: CoerceOptions,
) -> Result<Vec<Value>, Vec<(usize, Issue)>> {
    let mut values = Vec::with_capacity(cols.len());
    let mut problems = Vec::new();
    for (i, (src, target)) in cols.iter().enumerate() {
        let cell = rec.cells.get(*src).unwrap_or(&Cell::Null);
        match coerce_cell(cell, target, opts) {
            Ok(v) => values.push(v),
            Err(issue) => problems.push((i, issue)),
        }
    }
    if problems.is_empty() {
        Ok(values)
    } else {
        Err(problems)
    }
}

fn prepare(columns: &[MappedColumn]) -> Vec<(usize, Prepared)> {
    columns
        .iter()
        .map(|c| (c.source, Prepared::new(&c.target)))
        .collect()
}

#[tauri::command]
pub async fn import_file_detect(path: String) -> Result<Value, String> {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || detect(&path).map(|d| d.to_json()))
            .await
            .map_err(|e| e.to_string())?
    })
    .await
}

fn probe(path: &str, opts: &SourceOptions) -> Result<Value, String> {
    let det = detect(path)?;
    if det.kind == Kind::Sql {
        return Ok(det.to_json());
    }
    let mut shaper = Shaper::new(opts.has_header());
    let mut info = ReadInfo::default();
    let mut rows: Vec<Record> = Vec::new();
    let mut complete = true;
    read_rows(
        path,
        &det,
        opts,
        &Arc::new(AtomicU64::new(0)),
        &mut info,
        &mut |raw| {
            if let Some(r) = shaper.shape(raw) {
                rows.push(r);
            }
            if rows.len() >= PROBE_ROWS {
                complete = false;
                return Ok(false);
            }
            Ok(true)
        },
    )?;
    // A value to show beside each column in the mapping table: its first non-blank one.
    let first_values: Vec<String> = (0..shaper.headers.len())
        .map(|i| {
            rows.iter()
                .filter_map(|r| r.cells.get(i))
                .find(|c| !c.is_blank())
                .map(Cell::display)
                .unwrap_or_default()
        })
        .collect();
    let sample: Vec<Value> = rows
        .iter()
        .take(SAMPLE_ROWS)
        .map(|r| {
            let cells: Vec<Value> = (0..shaper.headers.len())
                .map(|i| match r.cells.get(i) {
                    None | Some(Cell::Null) => Value::Null,
                    Some(c) => Value::String(c.display()),
                })
                .collect();
            json!({ "row": r.row, "cells": cells })
        })
        .collect();
    // A first guess at each column's type for a NEW table, from the rows read here; the dry run
    // replaces it with a guess from the whole file.
    let mut inferred = vec![Inference::default(); shaper.headers.len()];
    for r in &rows {
        for (i, c) in r.cells.iter().enumerate() {
            inferred[i].see(c);
        }
    }
    let mut out = det.to_json();
    out["inferred"] = json!(inferred.iter().map(Inference::family).collect::<Vec<_>>());
    out["delimiter"] = json!(info.delimiter.map(|d| (d as char).to_string()));
    out["sheets"] = json!(info.sheets);
    out["headers"] = json!(shaper.headers);
    out["firstValues"] = json!(first_values);
    out["sample"] = json!(sample);
    out["complete"] = json!(complete);
    out["sampleRows"] = json!(rows.len());
    Ok(out)
}

/// The file's kind, header and first rows. For a SQL dump only the kind comes back — the caller
/// sends it to the restore dialog.
#[tauri::command]
pub async fn import_file_probe(path: String, options: SourceOptions) -> Result<Value, String> {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || probe(&path, &options))
            .await
            .map_err(|e| e.to_string())?
    })
    .await
}

/// Dry runs in flight, by the id the dialog gave them: changing an option starts a new one and
/// cancels the old, and closing the dialog cancels whatever is left.
static CHECKS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSpec {
    pub columns: Vec<MappedColumn>,
    pub coerce: CoerceOptions,
    /// Also guess each source column's type — for a NEW table, whose columns come from the file.
    #[serde(default)]
    pub infer: bool,
}

fn check(
    path: &str,
    opts: &SourceOptions,
    spec: &CheckSpec,
    cancel: &AtomicBool,
    on_progress: &Channel<Value>,
) -> Result<Value, String> {
    let det = detect(path)?;
    let cols = prepare(&spec.columns);
    let mut shaper = Shaper::new(opts.has_header());
    let mut info = ReadInfo::default();
    let progress = Arc::new(AtomicU64::new(0));
    let mut rows: u64 = 0;
    let mut bad_rows: u64 = 0;
    let mut issues: Vec<Value> = Vec::new();
    let mut by_column: HashMap<String, u64> = HashMap::new();
    let mut inferred: Vec<Inference> = Vec::new();
    let mut last = Instant::now();
    let mut cancelled = false;

    read_rows(path, &det, opts, &progress, &mut info, &mut |raw| {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            return Ok(false);
        }
        let Some(rec) = shaper.shape(raw) else {
            return Ok(true);
        };
        rows += 1;
        if spec.infer {
            if inferred.len() < rec.cells.len() {
                inferred.resize(rec.cells.len(), Inference::default());
            }
            for (i, c) in rec.cells.iter().enumerate() {
                inferred[i].see(c);
            }
        }
        if let Err(problems) = convert(&rec, &cols, spec.coerce) {
            bad_rows += 1;
            for (i, issue) in problems {
                let (src, target) = &cols[i];
                *by_column.entry(target.name.clone()).or_insert(0) += 1;
                if issues.len() < ISSUES_KEPT {
                    issues.push(issue_json(
                        rec.row,
                        &target.name,
                        issue,
                        rec.cells.get(*src).unwrap_or(&Cell::Null),
                    ));
                }
            }
        }
        if last.elapsed() >= Duration::from_millis(200) {
            last = Instant::now();
            let _ = on_progress.send(json!({
                "bytesDone": progress.load(Ordering::Relaxed),
                "bytesTotal": det.file_bytes,
                "rows": rows,
            }));
        }
        Ok(true)
    })?;
    if cancelled {
        return Ok(json!({ "cancelled": true }));
    }
    // A column seen in the header but never with a value still needs a type.
    inferred.resize(shaper.headers.len(), Inference::default());
    Ok(json!({
        "cancelled": false,
        "rows": rows,
        "badRows": bad_rows,
        "issues": issues,
        "issuesByColumn": by_column,
        "headers": shaper.headers,
        "inferred": if spec.infer { json!(inferred.iter().map(Inference::family).collect::<Vec<_>>()) } else { Value::Null },
    }))
}

/// A dry run over the whole file: how many rows, how many would be refused and why. Answers
/// `{ cancelled: true }` when `import_file_check_cancel(check_id)` stopped it.
#[tauri::command]
pub async fn import_file_check(
    check_id: String,
    path: String,
    options: SourceOptions,
    spec: CheckSpec,
    on_progress: Channel<Value>,
) -> Result<Value, String> {
    Box::pin(async move {
        let flag = Arc::new(AtomicBool::new(false));
        CHECKS
            .lock()
            .map_err(|e| e.to_string())?
            .insert(check_id.clone(), flag.clone());
        let res =
            tokio::task::spawn_blocking(move || check(&path, &options, &spec, &flag, &on_progress))
                .await
                .map_err(|e| e.to_string());
        if let Ok(mut m) = CHECKS.lock() {
            m.remove(&check_id);
        }
        res?
    })
    .await
}

#[tauri::command]
pub async fn import_file_check_cancel(check_id: String) -> Result<(), String> {
    Box::pin(async move {
        if let Some(f) = CHECKS.lock().map_err(|e| e.to_string())?.get(&check_id) {
            f.store(true, Ordering::Relaxed);
        }
        Ok(())
    })
    .await
}

// ---------------------------------------------------------------------------------------------
// The feed an import job reads from
// ---------------------------------------------------------------------------------------------

/// What `import_begin` is given to read rows from a file itself.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSource {
    pub path: String,
    pub options: SourceOptions,
    /// One per INSERT column, in the order of `import_begin`'s `columns`.
    pub columns: Vec<MappedColumn>,
    pub coerce: CoerceOptions,
}

/// Records per message from the reader thread.
const BATCH: usize = 1000;

/// Rows of a file, converted, for an import in progress. The file is read on a thread of its own
/// into a bounded channel — a few thousand rows ahead of the INSERTs, never the file — and dropping
/// the feed (the import ending, however it ends) ends the thread at its next send.
pub(crate) struct FileFeed {
    rx: tokio::sync::mpsc::Receiver<Result<Vec<Record>, String>>,
    pending: VecDeque<Record>,
    cols: Vec<(usize, Prepared)>,
    coerce: CoerceOptions,
    progress: Arc<AtomicU64>,
    bytes_total: u64,
    rows_read: u64,
    done: bool,
}

/// One step's worth of rows.
pub(crate) struct Step {
    /// (row number, values) for the rows that converted.
    pub rows: Vec<(u64, Vec<Value>)>,
    /// Rows refused by the conversion.
    pub bad_rows: u64,
    /// The first of their problems.
    pub issues: Vec<Value>,
}

impl FileFeed {
    pub(crate) fn open(src: FileSource) -> Result<FileFeed, String> {
        let det: Detected = detect(&src.path)?;
        if det.kind == Kind::Sql {
            return Err("Định dạng tệp không được hỗ trợ".to_string());
        }
        let progress = Arc::new(AtomicU64::new(0));
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<Record>, String>>(8);
        let thread_progress = progress.clone();
        let path = src.path.clone();
        let opts = src.options.clone();
        let det_thread = det.clone();
        std::thread::spawn(move || {
            let mut shaper = Shaper::new(opts.has_header());
            let mut info = ReadInfo::default();
            let mut batch: Vec<Record> = Vec::with_capacity(BATCH);
            let res = read_rows(
                &path,
                &det_thread,
                &opts,
                &thread_progress,
                &mut info,
                &mut |raw| {
                    if let Some(r) = shaper.shape(raw) {
                        batch.push(r);
                        if batch.len() >= BATCH
                            && tx.blocking_send(Ok(std::mem::take(&mut batch))).is_err()
                        {
                            // The import is gone; stop reading.
                            return Ok(false);
                        }
                    }
                    Ok(true)
                },
            );
            let _ = match res {
                Ok(()) if !batch.is_empty() => tx.blocking_send(Ok(batch)),
                Ok(()) => Ok(()),
                Err(e) => tx.blocking_send(Err(e)),
            };
        });
        Ok(FileFeed {
            rx,
            pending: VecDeque::new(),
            cols: prepare(&src.columns),
            coerce: src.coerce,
            progress,
            bytes_total: det.file_bytes,
            rows_read: 0,
            done: false,
        })
    }

    /// The next `max` rows of the file, converted. An empty step with `done()` true is the end.
    pub(crate) async fn next(&mut self, max: usize, issue_cap: usize) -> Result<Step, String> {
        let mut step = Step {
            rows: Vec::new(),
            bad_rows: 0,
            issues: Vec::new(),
        };
        let mut taken = 0;
        while taken < max {
            let rec = match self.pending.pop_front() {
                Some(r) => r,
                None => match self.rx.recv().await {
                    Some(Ok(batch)) => {
                        self.pending.extend(batch);
                        continue;
                    }
                    Some(Err(e)) => return Err(e),
                    None => {
                        self.done = true;
                        break;
                    }
                },
            };
            taken += 1;
            self.rows_read += 1;
            match convert(&rec, &self.cols, self.coerce) {
                Ok(values) => step.rows.push((rec.row, values)),
                Err(problems) => {
                    step.bad_rows += 1;
                    for (i, issue) in problems {
                        if step.issues.len() < issue_cap {
                            let (src, target) = &self.cols[i];
                            step.issues.push(issue_json(
                                rec.row,
                                &target.name,
                                issue,
                                rec.cells.get(*src).unwrap_or(&Cell::Null),
                            ));
                        }
                    }
                }
            }
        }
        Ok(step)
    }

    pub(crate) fn done(&self) -> bool {
        self.done && self.pending.is_empty()
    }
    pub(crate) fn rows_read(&self) -> u64 {
        self.rows_read
    }
    pub(crate) fn bytes_done(&self) -> u64 {
        self.progress.load(Ordering::Relaxed)
    }
    pub(crate) fn bytes_total(&self) -> u64 {
        self.bytes_total
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp(name: &str, bytes: &[u8]) -> String {
        let dir = std::env::temp_dir().join(format!("tg-import-cmd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::File::create(&p).unwrap().write_all(bytes).unwrap();
        p.to_string_lossy().into_owned()
    }

    fn mapped(name: &str, ty: &str, nullable: bool, source: usize) -> MappedColumn {
        MappedColumn {
            target: Target {
                name: name.into(),
                ty: ty.into(),
                nullable,
            },
            source,
        }
    }

    const COERCE: CoerceOptions = CoerceOptions {
        empty_as_empty: false,
        trim: true,
    };

    #[test]
    fn probe_reports_header_sample_and_delimiter() {
        let p = temp("a.csv", b"id;name\n1;ann\n2;\n");
        let v = probe(&p, &SourceOptions::default()).unwrap();
        assert_eq!(v["kind"], "csv");
        assert_eq!(v["delimiter"], ";");
        assert_eq!(v["headers"], json!(["id", "name"]));
        assert_eq!(v["sample"][0], json!({ "row": 2, "cells": ["1", "ann"] }));
        assert_eq!(v["sample"][1]["cells"], json!(["2", ""]));
        assert_eq!(v["firstValues"], json!(["1", "ann"]));
        assert_eq!(v["complete"], true);
    }

    #[test]
    fn a_sql_file_is_only_identified() {
        let v = probe(
            &temp("d.sql", b"CREATE TABLE t (a int);"),
            &SourceOptions::default(),
        )
        .unwrap();
        assert_eq!(v["kind"], "sql");
        assert!(v.get("headers").is_none());
    }

    #[test]
    fn check_counts_bad_rows_names_them_and_infers_types() {
        let p = temp("c.csv", b"id,name\n1,ann\nx,toolongname\n3,bo\n\n4,\n");
        let spec = CheckSpec {
            columns: vec![
                mapped("id", "int", false, 0),
                mapped("name", "varchar(5)", false, 1),
            ],
            coerce: COERCE,
            infer: true,
        };
        let flag = AtomicBool::new(false);
        let v = check(
            &p,
            &SourceOptions::default(),
            &spec,
            &flag,
            &Channel::new(|_| Ok(())),
        )
        .unwrap();
        assert_eq!(v["rows"], 4);
        assert_eq!(v["badRows"], 2);
        assert_eq!(
            v["issues"],
            json!([
                { "row": 3, "column": "id", "issue": "notInteger", "value": "x" },
                { "row": 3, "column": "name", "issue": "tooLong", "value": "toolongname" },
                { "row": 6, "column": "name", "issue": "required", "value": "" },
            ])
        );
        assert_eq!(v["issuesByColumn"], json!({ "id": 1, "name": 2 }));
        assert_eq!(v["inferred"], json!(["text", "text"]));
    }

    #[test]
    fn a_cancelled_check_says_so() {
        let p = temp("c.csv", b"a\n1\n");
        let spec = CheckSpec {
            columns: vec![],
            coerce: COERCE,
            infer: false,
        };
        let flag = AtomicBool::new(true);
        let v = check(
            &p,
            &SourceOptions::default(),
            &spec,
            &flag,
            &Channel::new(|_| Ok(())),
        )
        .unwrap();
        assert_eq!(v, json!({ "cancelled": true }));
    }

    #[tokio::test]
    async fn the_feed_streams_converted_rows_in_steps() {
        let mut body = String::from("n,label\n");
        for i in 1..=2500 {
            body.push_str(&format!("{i},r{i}\n"));
        }
        body.push_str("bad,x\n");
        let p = temp("f.csv", body.as_bytes());
        let mut feed = FileFeed::open(FileSource {
            path: p,
            options: SourceOptions::default(),
            columns: vec![
                mapped("n", "int", true, 0),
                mapped("label", "text", true, 1),
            ],
            coerce: COERCE,
        })
        .unwrap();
        let mut good = 0;
        let mut bad = 0;
        let mut last_row = 0;
        loop {
            let s = feed.next(1000, 5).await.unwrap();
            good += s.rows.len();
            bad += s.bad_rows;
            if let Some((r, v)) = s.rows.last() {
                last_row = *r;
                assert_eq!(v[0], json!(*r - 1), "row numbers count the header line");
            }
            if feed.done() {
                break;
            }
        }
        assert_eq!((good, bad, last_row), (2500, 1, 2501));
        assert_eq!(feed.rows_read(), 2501);
        assert_eq!(feed.bytes_done(), feed.bytes_total());
    }
}

/// A dry run over a real file, for measuring: `IMPORT_FILE=big.csv cargo test --release --lib
/// dry_run_a_real_file -- --ignored --nocapture`. Prints rows, time and peak-free throughput.
#[cfg(test)]
mod replay {
    use super::*;

    #[test]
    #[ignore]
    fn dry_run_a_real_file() {
        let path = std::env::var("IMPORT_FILE").expect("IMPORT_FILE");
        let started = Instant::now();
        let probe = probe(&path, &SourceOptions::default()).unwrap();
        println!("probe: {:?} in {:?}", probe["headers"], started.elapsed());
        let n = probe["headers"].as_array().unwrap().len();
        let columns = (0..n)
            .map(|i| MappedColumn {
                target: Target {
                    name: format!("c{i}"),
                    ty: "text".into(),
                    nullable: true,
                },
                source: i,
            })
            .collect();
        let spec = CheckSpec {
            columns,
            coerce: CoerceOptions {
                empty_as_empty: false,
                trim: true,
            },
            infer: std::env::var("INFER").is_ok(),
        };
        let started = Instant::now();
        let v = check(
            &path,
            &SourceOptions::default(),
            &spec,
            &AtomicBool::new(false),
            &Channel::new(|_| Ok(())),
        )
        .unwrap();
        let secs = started.elapsed().as_secs_f64();
        let bytes = std::fs::metadata(&path).unwrap().len() as f64;
        println!(
            "check: {} rows, {} bad, inferred {:?} in {secs:.1}s ({:.0} MB/s)",
            v["rows"],
            v["badRows"],
            v["inferred"],
            bytes / secs / 1e6
        );
    }
}
