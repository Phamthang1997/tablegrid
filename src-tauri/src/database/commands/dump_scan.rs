//! `scan_dump_file` — what the two restore screens need to know about a dump, read from disk.
//!
//! Both screens used to read the whole file into the webview and work it out in TypeScript
//! (`splitStatements` + `parseDumpTableNames` + `parseDumpObjects` + `parseDumpDatabase`, a dozen
//! passes over the text on the main thread) — for a 130MB `.sql.gz` that froze the window the
//! moment the file was picked, and Connection Manager did not even gunzip it. Here one streamed
//! pass answers all of it and the webview never holds the dump; `restore_backup` then reads the
//! same file itself (`file_path`).
//!
//! Names are read from the HEAD of each statement only. The TypeScript regexes searched the whole
//! text, which is what made them pick up an `INSERT INTO tmp` inside a procedure body (and need a
//! temporary-table exclusion to undo it), and what made each of them a full pass over the dump.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{Value, json};
use tauri::ipc::Channel;

use super::restore::{is_skipped_stmt, upper_head, use_db_name};
use crate::database::{
    DumpItem, DumpStatements, classification_head, open_dump, strip_leading_comments,
};

/// An identifier, quoted or not, with an optional schema prefix; group 1 is the bare name.
const IDENT: &str = r#"(?:[`"\[]?[\w$]+[`"\]]?\s*\.\s*)?[`"\[]?([\w$]+)[`"\]]?"#;

/// A statement that names one of the dump's objects right after its verb — the Rust form of
/// `OBJECT_NAME_SRC` in `dumpPreview.ts`, plus the spellings it missed (`MATERIALIZED VIEW`, which
/// this app's own Postgres dump writes, `UNLOGGED TABLE`, `INSERT IGNORE`/`OR REPLACE`/`REPLACE INTO`,
/// and pg_dump's `COPY t (…) FROM stdin`, which is where a plain pg_dump file keeps every row).
static OBJECT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)^\s*(?:COPY|CREATE\s+(?:UNLOGGED\s+)?TABLE|(?:INSERT|REPLACE)\s+(?:IGNORE\s+|OR\s+\w+\s+)?INTO|DROP\s+(?:TABLE|(?:MATERIALIZED\s+)?VIEW|TRIGGER|PROCEDURE|FUNCTION)\s+IF\s+EXISTS|CREATE\s+(?:OR\s+REPLACE\s+)?(?:ALGORITHM\s*=\s*\S+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?(?:(?:MATERIALIZED\s+)?VIEW|TRIGGER|PROCEDURE|FUNCTION))\s+(?:IF\s+NOT\s+EXISTS\s+)?{IDENT}"
    ))
    .expect("OBJECT_RE")
});

/// What a statement CREATES — the input to the overwrite option's `DROP … IF EXISTS` list
/// (`parseDumpObjects`). Group 1 is the kind, group 2 the name.
static CREATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:UNLOGGED\s+)?(?:ALGORITHM\s*=\s*\S+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?(TABLE|(?:MATERIALIZED\s+)?VIEW|TRIGGER|PROCEDURE|FUNCTION)\s+(?:IF\s+NOT\s+EXISTS\s+)?{IDENT}"
    ))
    .expect("CREATE_RE")
});

/// A temporary table the dump creates at top level: its INSERTs are not a table of the database.
static TEMP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)^\s*CREATE\s+(?:GLOBAL\s+|LOCAL\s+)?TEMP(?:ORARY)?\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?{IDENT}"
    ))
    .expect("TEMP_RE")
});

static CREATE_DB_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)^\s*CREATE\s+(?:DATABASE|SCHEMA)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"\[]?([\w$-]+)[`"\]]?"#)
        .expect("CREATE_DB_RE")
});

/// mysqldump wraps half a statement in version comments —
/// `/*!50001 CREATE ALGORITHM=UNDEFINED */ /*!50013 DEFINER=… */ /*!50001 VIEW v AS …`. MySQL runs
/// what is inside them, so for naming they are erased rather than skipped.
static EXEC_MARKER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\*/|/\*M?!\d*").expect("EXEC_MARKER_RE"));

/// Enough of a statement to find its verb and its object's name.
const HEAD_BYTES: usize = 512;

/// The most statements the preview carries, per kind.
const PREVIEW_MAX: usize = 2000;
/// A structure statement longer than this is clipped (the preview shows it, it does not run it).
const PREVIEW_STRUCTURE_BYTES: usize = 20_000;
/// How much of a COPY block's data is kept with its statement in the preview.
const PREVIEW_COPY_BYTES: usize = 4_000;
/// A data statement is clipped here — enough for the few rows per table the Data tab shows.
const PREVIEW_DATA_BYTES: usize = 64_000;
/// INSERT statements kept per table.
const PREVIEW_DATA_PER_TABLE: usize = 2;

fn clip(s: &str, max: usize) -> (&str, bool) {
    if s.len() <= max {
        return (s, false);
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    (&s[..end], true)
}

/// The statement's head with executable-comment markers erased, as far as naming needs it.
fn naming_head(stmt: &str) -> String {
    let (head, _) = clip(classification_head(stmt), HEAD_BYTES);
    EXEC_MARKER_RE.replace_all(head, " ").into_owned()
}

fn push_unique(list: &mut Vec<String>, seen: &mut HashSet<String>, name: &str) {
    if seen.insert(name.to_string()) {
        list.push(name.to_string());
    }
}

/// Everything the scan learns, statement by statement. Pure, so it is tested without a file.
#[derive(Default)]
pub(crate) struct DumpSummary {
    statements: usize,
    names: Vec<String>,
    names_seen: HashSet<String>,
    temps: HashSet<String>,
    objects: [Vec<String>; 5],
    objects_seen: [HashSet<String>; 5],
    use_db: Option<String>,
    create_db: Option<String>,
    /// Statements that run whatever the selection is.
    plan_always: usize,
    /// Statements that run only when their table is selected.
    plan_by_table: HashMap<String, usize>,
    structure: Vec<Value>,
    data: Vec<Value>,
    data_per_table: HashMap<String, usize>,
    preview_complete: bool,
    /// The last data preview item is a COPY still waiting for a few lines of its data.
    copy_sample_open: bool,
}

/// Index into `DumpSummary::objects`.
const OBJ_KINDS: [&str; 5] = ["tables", "views", "triggers", "procedures", "functions"];

impl DumpSummary {
    pub(crate) fn new() -> Self {
        Self {
            preview_complete: true,
            ..Default::default()
        }
    }

    /// The first lines of a COPY block's data, appended to its statement in the preview the way
    /// pg_dump writes them, so the SQL view shows what the rows look like.
    pub(crate) fn add_copy_data(&mut self, data: &[u8]) {
        if !std::mem::take(&mut self.copy_sample_open) {
            return;
        }
        let Some(item) = self.data.last_mut() else {
            return;
        };
        let mut end = data.len().min(PREVIEW_COPY_BYTES);
        if end < data.len() {
            // Whole lines only; a single line longer than the cap is shown clipped.
            end = data[..end]
                .iter()
                .rposition(|&c| c == b'\n')
                .map_or(end, |p| p + 1);
            self.preview_complete = false;
            item["clipped"] = json!(true);
        }
        let sample = String::from_utf8_lossy(&data[..end]);
        let text = format!("{};\n{}\\.", item["text"].as_str().unwrap_or(""), sample);
        item["text"] = json!(text);
    }

    pub(crate) fn add(&mut self, stmt: &str) {
        self.statements += 1;
        self.copy_sample_open = false;
        // The same classification as `restore_backup`, so the counts match what it will run.
        let body = strip_leading_comments(stmt);
        let upper = upper_head(body);
        let skipped = is_skipped_stmt(&upper);
        let comment_only = body.is_empty();
        let comment_runs = comment_only && stmt.contains("/*!");

        let head = naming_head(stmt);
        let table = OBJECT_RE.captures(&head).map(|c| c[1].to_string());

        if let Some(c) = TEMP_RE.captures(&head) {
            self.temps.insert(c[1].to_lowercase());
        }
        if let Some(name) = &table {
            push_unique(&mut self.names, &mut self.names_seen, name);
        }
        if let Some(c) = CREATE_RE.captures(&head) {
            let word = c[1].to_ascii_uppercase();
            let k = if word == "TABLE" {
                0
            } else if word.ends_with("VIEW") {
                1
            } else if word == "TRIGGER" {
                2
            } else if word == "PROCEDURE" {
                3
            } else {
                4
            };
            push_unique(&mut self.objects[k], &mut self.objects_seen[k], &c[2]);
        }
        if self.use_db.is_none() && upper.starts_with("USE ") {
            self.use_db = use_db_name(body);
        }
        if self.create_db.is_none()
            && let Some(c) = CREATE_DB_RE.captures(&head)
        {
            self.create_db = Some(c[1].to_string());
        }

        // The statement count behind the time estimate — `brPlannedStatements`' rule.
        if !skipped {
            if comment_only {
                if comment_runs {
                    self.plan_always += 1;
                }
            } else {
                match &table {
                    Some(t) => *self.plan_by_table.entry(t.clone()).or_default() += 1,
                    None => self.plan_always += 1,
                }
            }
        }

        // The preview: every structure statement (clipped), and the first INSERTs of each table.
        let hu: String = head
            .trim_start()
            .chars()
            .take(6)
            .collect::<String>()
            .to_ascii_uppercase();
        let kind = if hu.starts_with("CREATE") || hu.starts_with("ALTER") || hu.starts_with("DROP")
        {
            "structure"
        } else if hu.starts_with("INSERT") || hu.starts_with("COPY") {
            "data"
        } else {
            return;
        };
        let (list, max_bytes) = if kind == "structure" {
            (&mut self.structure, PREVIEW_STRUCTURE_BYTES)
        } else {
            let per = self
                .data_per_table
                .entry(table.clone().unwrap_or_default())
                .or_default();
            if *per >= PREVIEW_DATA_PER_TABLE {
                self.preview_complete = false;
                return;
            }
            *per += 1;
            (&mut self.data, PREVIEW_DATA_BYTES)
        };
        if list.len() >= PREVIEW_MAX {
            self.preview_complete = false;
            return;
        }
        let (text, clipped) = clip(stmt, max_bytes);
        if clipped {
            self.preview_complete = false;
        }
        list.push(json!({
            "text": text,
            "table": table,
            "kind": kind,
            "skipped": skipped,
            "commentOnly": comment_only,
            "commentRuns": comment_runs,
            "clipped": clipped,
        }));
        self.copy_sample_open = kind == "data" && hu.starts_with("COPY");
    }

    pub(crate) fn into_json(self) -> Value {
        let temps = &self.temps;
        let tables: Vec<&String> = self
            .names
            .iter()
            .filter(|n| !temps.contains(&n.to_lowercase()))
            .collect();
        let mut objects = serde_json::Map::new();
        for (k, list) in self.objects.into_iter().enumerate() {
            objects.insert(OBJ_KINDS[k].to_string(), json!(list));
        }
        json!({
            "statements": self.statements,
            "tables": tables,
            "objects": objects,
            // `parseDumpDatabase`'s order: a USE anywhere wins over a CREATE DATABASE/SCHEMA.
            "database": self.use_db.or(self.create_db),
            "plan": { "always": self.plan_always, "byTable": self.plan_by_table },
            "preview": { "structure": self.structure, "data": self.data, "complete": self.preview_complete },
        })
    }
}

/// Bumped by every scan; a scan that sees it move on stops, because a newer file was picked and
/// nobody is waiting for this answer any more.
static SCAN_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Streams through the file once (twice for a MySQL script with `DELIMITER`, see below).
fn scan_file(path: &str, on_progress: &Channel<Value>) -> Result<Value, String> {
    let generation = SCAN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    // `mysql_script` is a property of the whole file. Splitting with `false` is exactly right for
    // any dump that has no DELIMITER line — every Postgres and SQLite dump — and the probe riding
    // along says whether it had one; only then is the file split again with `true`. So the dumps
    // that can be huge on this path pay one decompression, not two.
    let mut mysql_script = false;
    loop {
        let dump = open_dump(path)?;
        let (bytes_read, bytes_total, gzip) =
            (dump.bytes_read.clone(), dump.bytes_total, dump.gzip);
        let mut stmts = DumpStatements::new(dump.reader, mysql_script);
        let mut summary = DumpSummary::new();
        let mut last = Instant::now();
        for item in stmts.by_ref() {
            match item? {
                DumpItem::Stmt(stmt) | DumpItem::CopyStart(stmt) => summary.add(&stmt),
                DumpItem::CopyData(data) => summary.add_copy_data(&data),
                DumpItem::CopyEnd => {}
            }
            if last.elapsed() >= Duration::from_millis(200) {
                if SCAN_GENERATION.load(Ordering::SeqCst) != generation {
                    return Ok(json!({ "superseded": true }));
                }
                last = Instant::now();
                let _ = on_progress.send(json!({
                    "bytesDone": bytes_read.load(Ordering::Relaxed),
                    "bytesTotal": bytes_total,
                }));
            }
        }
        if stmts.saw_delimiter_line() && !mysql_script {
            mysql_script = true;
            continue;
        }
        let mut out = summary.into_json();
        if let Some(obj) = out.as_object_mut() {
            obj.insert("fileBytes".into(), json!(bytes_total));
            obj.insert("gzip".into(), json!(gzip));
            obj.insert("mysqlScript".into(), json!(mysql_script));
        }
        return Ok(out);
    }
}

/// Reads a dump file from disk and reports its objects, target database, planned statement
/// counts and a preview — without the file ever entering the webview.
///
/// `on_progress` gets `{bytesDone, bytesTotal}` every ~200ms. Answers `{superseded: true}` when a
/// newer scan started before this one finished.
#[tauri::command]
pub async fn scan_dump_file(path: String, on_progress: Channel<Value>) -> Result<Value, String> {
    Box::pin(async move {
        tokio::task::spawn_blocking(move || scan_file(&path, &on_progress))
            .await
            .map_err(|e| e.to_string())?
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(stmts: &[&str]) -> Value {
        let mut s = DumpSummary::new();
        for q in stmts {
            s.add(q);
        }
        s.into_json()
    }

    #[test]
    fn names_objects_and_the_database_come_from_statement_heads() {
        let v = summary(&[
            "-- header\nSET NAMES utf8mb4",
            "USE `sakila`",
            "DROP TABLE IF EXISTS `actor`",
            "CREATE TABLE `actor` (id int)",
            "INSERT INTO `actor` VALUES (1),(2)",
            "CREATE TABLE public.\"film\" (id int)",
            "CREATE MATERIALIZED VIEW mv AS SELECT 1",
            "/*!50001 DROP VIEW IF EXISTS `actor_info`*/",
            "/*!50001 CREATE ALGORITHM=UNDEFINED */ /*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */ /*!50001 VIEW `actor_info` AS select 1 */",
            "CREATE DEFINER=`root`@`localhost` TRIGGER `upd` AFTER UPDATE ON actor FOR EACH ROW BEGIN SET @a = 1; END",
            "CREATE PROCEDURE p() BEGIN CREATE TEMPORARY TABLE tmp (x int); INSERT INTO tmp VALUES (1); END",
            "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql",
        ]);
        assert_eq!(
            v["tables"],
            json!(["actor", "film", "mv", "actor_info", "upd", "p", "f"])
        );
        assert_eq!(v["objects"]["tables"], json!(["actor", "film"]));
        assert_eq!(v["objects"]["views"], json!(["mv", "actor_info"]));
        assert_eq!(v["objects"]["triggers"], json!(["upd"]));
        assert_eq!(v["objects"]["procedures"], json!(["p"]));
        assert_eq!(v["objects"]["functions"], json!(["f"]));
        assert_eq!(v["database"], json!("sakila"));
        assert_eq!(v["statements"], json!(12));
    }

    #[test]
    fn a_top_level_temporary_table_is_not_listed() {
        let v = summary(&[
            "CREATE TEMPORARY TABLE tmp (x int)",
            "INSERT INTO tmp VALUES (1)",
            "INSERT INTO real_t VALUES (1)",
        ]);
        assert_eq!(v["tables"], json!(["real_t"]));
    }

    #[test]
    fn create_database_is_the_fallback_target() {
        let v = summary(&[
            "CREATE DATABASE /*!32312 IF NOT EXISTS*/ `shop` /*!40100 DEFAULT CHARACTER SET utf8mb4 */",
        ]);
        assert_eq!(v["database"], json!("shop"));
        assert_eq!(summary(&["SELECT 1"])["database"], Value::Null);
    }

    /// The same rule the UI's estimate used: skipped statements do not count, a plain comment does
    /// not count, an executable comment and a statement naming no table always count.
    #[test]
    fn the_plan_counts_what_the_restore_will_run() {
        let v = summary(&[
            "LOCK TABLES `actor` WRITE",
            "INSERT INTO actor VALUES (1)",
            "INSERT INTO actor VALUES (2)",
            "UNLOCK TABLES",
            "-- just a comment",
            "/*!40101 SET NAMES utf8 */",
            "SET FOREIGN_KEY_CHECKS = 0",
            "INSERT INTO film VALUES (1)",
            "COMMIT",
        ]);
        assert_eq!(v["plan"]["always"], json!(2));
        assert_eq!(v["plan"]["byTable"]["actor"], json!(2));
        assert_eq!(v["plan"]["byTable"]["film"], json!(1));
    }

    #[test]
    fn the_preview_keeps_structure_and_the_first_inserts_of_each_table() {
        let mut stmts = vec!["CREATE TABLE a (x int)".to_string()];
        for i in 0..5 {
            stmts.push(format!("INSERT INTO a VALUES ({i})"));
        }
        stmts.push("INSERT INTO b VALUES (1)".into());
        stmts.push("SELECT 1".into());
        let refs: Vec<&str> = stmts.iter().map(String::as_str).collect();
        let v = summary(&refs);
        assert_eq!(v["preview"]["structure"].as_array().unwrap().len(), 1);
        let data = v["preview"]["data"].as_array().unwrap();
        assert_eq!(data.len(), PREVIEW_DATA_PER_TABLE + 1);
        assert_eq!(data[0]["table"], json!("a"));
        assert_eq!(v["preview"]["complete"], json!(false));
    }

    /// Split first, the way a file is: the cases `dumpPreview.test.ts` pinned for the TypeScript
    /// detectors this replaced (`parseDumpTableNames`, `parseDumpObjects`, `parseDumpDatabase`).
    fn scan_text(sql: &str) -> Value {
        let stmts = crate::database::split_sql_statements(sql);
        summary(&stmts.iter().map(String::as_str).collect::<Vec<_>>())
    }

    const SAKILA_LIKE: &str = "
USE sakila;
CREATE TABLE actor (actor_id SMALLINT NOT NULL);
CREATE TABLE film_text (film_id SMALLINT NOT NULL);
DELIMITER ;;
CREATE TRIGGER `ins_film` AFTER INSERT ON `film` FOR EACH ROW BEGIN
  INSERT INTO film_text (film_id) VALUES (new.film_id);
END;;
DELIMITER ;
CREATE VIEW customer_list AS SELECT 1;
CREATE DEFINER=CURRENT_USER SQL SECURITY INVOKER VIEW actor_info AS SELECT 1;
CREATE PROCEDURE rewards_report (IN x INT) BEGIN SELECT 1; END;
CREATE FUNCTION get_customer_balance(p INT) RETURNS DECIMAL(5,2) BEGIN RETURN 0; END;
";

    #[test]
    fn a_sakila_like_dump_lists_every_object_kind() {
        let v = scan_text(SAKILA_LIKE);
        assert_eq!(v["objects"]["tables"], json!(["actor", "film_text"]));
        // A view carrying DEFINER / SQL SECURITY is still named correctly.
        assert_eq!(
            v["objects"]["views"],
            json!(["customer_list", "actor_info"])
        );
        assert_eq!(v["objects"]["triggers"], json!(["ins_film"]));
        assert_eq!(v["objects"]["procedures"], json!(["rewards_report"]));
        assert_eq!(v["objects"]["functions"], json!(["get_customer_balance"]));
        assert_eq!(v["database"], json!("sakila"));
    }

    /// A view is written with CREATE VIEW / DROP VIEW, not DROP TABLE; undetected, it never reaches
    /// the selection list and the restore's filter drops its statements. Only the CREATED name
    /// counts, never a table read in the body (`from film`).
    #[test]
    fn views_are_named_in_every_spelling() {
        let v = scan_text(
            "DROP VIEW IF EXISTS `actor_info`;\n\
             CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY INVOKER VIEW `actor_info` AS select 1;\n\
             CREATE VIEW `film_list` AS select * from film;\n\
             CREATE OR REPLACE VIEW \"staff_list\" AS select 1;",
        );
        assert_eq!(
            v["tables"],
            json!(["actor_info", "film_list", "staff_list"])
        );
    }

    /// The routine's own name is listed — the restore only runs statements mentioning a listed name
    /// — while the temporary table inside its body is not an object of the database.
    #[test]
    fn a_routine_is_listed_but_not_the_temporary_table_in_its_body() {
        let v = scan_text(
            "CREATE TABLE `real_table` (id int);\n\
             DELIMITER $$\n\
             CREATE PROCEDURE p() BEGIN CREATE TEMPORARY TABLE tmp_x (id int); INSERT INTO tmp_x VALUES (1); END$$\n\
             DELIMITER ;",
        );
        assert_eq!(v["tables"], json!(["real_table", "p"]));
    }

    /// What this app's own export writes: routines in one DELIMITER block with DEFINER stripped,
    /// and on Postgres a schema header that is not a table to pick.
    #[test]
    fn the_apps_own_dump_shapes_are_read_back() {
        let v = scan_text(
            "DELIMITER $$\n\
             CREATE PROCEDURE `film_in_stock`(IN id INT) BEGIN SELECT 1; END$$\n\
             CREATE FUNCTION `get_balance`(id INT) RETURNS DECIMAL(5,2) RETURN 0$$\n\
             CREATE TRIGGER `ins_film` AFTER INSERT ON `film` FOR EACH ROW BEGIN END$$\n\
             DELIMITER ;",
        );
        assert_eq!(v["objects"]["procedures"], json!(["film_in_stock"]));
        assert_eq!(v["objects"]["functions"], json!(["get_balance"]));
        assert_eq!(v["objects"]["triggers"], json!(["ins_film"]));

        let pg = scan_text(
            "CREATE SCHEMA IF NOT EXISTS \"sales\";\nSET search_path TO \"sales\";\n\
             CREATE TABLE \"film\" (id int);\nINSERT INTO \"film\" VALUES (1);",
        );
        assert_eq!(pg["tables"], json!(["film"]));
    }

    #[test]
    fn names_are_unique_and_in_file_order() {
        let v = scan_text(
            "INSERT INTO b VALUES (1); INSERT INTO a VALUES (1); INSERT INTO b VALUES (2);",
        );
        assert_eq!(v["tables"], json!(["b", "a"]));
    }

    #[test]
    fn the_target_database_prefers_use_and_loses_its_quotes() {
        assert_eq!(
            scan_text(
                "DROP SCHEMA IF EXISTS sakila;\nCREATE SCHEMA sakila2;\nUSE sakila;\nCREATE TABLE a (id INT);"
            )["database"],
            json!("sakila")
        );
        assert_eq!(
            scan_text("CREATE DATABASE IF NOT EXISTS `shop_v2`;")["database"],
            json!("shop_v2")
        );
        assert_eq!(scan_text("USE `my-db`;")["database"], json!("my-db"));
        assert_eq!(scan_text("USE \"My_DB\";")["database"], json!("My_DB"));
        assert_eq!(
            scan_text("CREATE TABLE a (id INT);\nINSERT INTO a VALUES (1);")["database"],
            Value::Null
        );
    }

    #[test]
    fn a_statement_naming_no_object_is_untagged_in_the_preview() {
        let v =
            scan_text("-- x\nCREATE TABLE IF NOT EXISTS x (id int);\nDROP FUNCTION IF EXISTS `f`;");
        assert_eq!(v["preview"]["structure"][0]["table"], json!("x"));
        assert_eq!(v["preview"]["structure"][1]["table"], json!("f"));
        assert_eq!(
            scan_text("ALTER TABLE a ADD b int;")["preview"]["structure"][0]["table"],
            Value::Null
        );
    }

    /// pg_dump keeps every row in `COPY … FROM stdin` blocks: the table has to be named from the
    /// COPY, and the preview shows its first data lines the way the file writes them.
    #[test]
    fn a_copy_block_names_its_table_and_shows_a_sample() {
        let mut s = DumpSummary::new();
        s.add("COPY bookings.flights (id, no) FROM stdin");
        s.add_copy_data(b"1\tPG0001\n2\tPG0002\n");
        s.add_copy_data(b"3\tPG0003\n");
        let v = s.into_json();
        assert_eq!(v["tables"], json!(["flights"]));
        assert_eq!(v["plan"]["byTable"]["flights"], json!(1));
        let item = &v["preview"]["data"][0];
        assert_eq!(
            item["text"],
            json!("COPY bookings.flights (id, no) FROM stdin;\n1\tPG0001\n2\tPG0002\n\\.")
        );
    }

    #[test]
    fn a_long_statement_is_clipped_on_a_character_boundary() {
        let big = format!(
            "CREATE TABLE t (note text DEFAULT '{}')",
            "ệ".repeat(20_000)
        );
        let v = summary(&[&big]);
        let item = &v["preview"]["structure"][0];
        assert_eq!(item["clipped"], json!(true));
        assert!(item["text"].as_str().unwrap().len() <= PREVIEW_STRUCTURE_BYTES);
    }
}
