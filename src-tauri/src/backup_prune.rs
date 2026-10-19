//! "Keep the N newest" for scheduled backups (`utils/backupScheduler.ts`).
//!
//! This is the one place the app deletes files the user did not pick one by one, so it is narrow on
//! purpose: it only ever touches files in `dir` itself (never a subdirectory) whose name is EXACTLY
//! what the scheduler writes — `<prefix>-YYYYMMDD-HHMMSS.sql` or `.sql.gz`. A file the user dropped
//! into the backup folder, a `.part` still being written, another schedule's backups under another
//! prefix: none of them match, so none of them can go. The timestamp is in the name, so the newest
//! are simply the ones that sort last — no mtime, which a copy or a sync tool can rewrite.

use serde_json::{Value, json};

/// Characters a prefix may hold. Mirrors `sanitizePrefix` in `utils/backupSchedule.ts`; anything
/// else (a path separator above all) is refused rather than cleaned, since the frontend already
/// cleaned it and a mismatch means something is wrong.
fn valid_prefix(prefix: &str) -> bool {
    !prefix.is_empty()
        && prefix.len() <= 120
        && prefix
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
        && !prefix.starts_with('.')
}

/// `<prefix>-YYYYMMDD-HHMMSS.sql[.gz]`, nothing more and nothing less.
fn is_backup_name(name: &str, prefix: &str) -> bool {
    let Some(rest) = name.strip_prefix(prefix).and_then(|r| r.strip_prefix('-')) else {
        return false;
    };
    let stamp = match rest
        .strip_suffix(".sql.gz")
        .or_else(|| rest.strip_suffix(".sql"))
    {
        Some(s) => s.as_bytes(),
        None => return false,
    };
    stamp.len() == 15
        && stamp[8] == b'-'
        && stamp[..8].iter().all(u8::is_ascii_digit)
        && stamp[9..].iter().all(u8::is_ascii_digit)
}

/// Which of `names` to delete so that `keep` backups remain.
fn to_delete(mut names: Vec<String>, prefix: &str, keep: usize) -> Vec<String> {
    names.retain(|n| is_backup_name(n, prefix));
    // By timestamp, not by the whole name: `x-…sql` and `x-…sql.gz` of one run compare by stamp.
    names.sort_by(|a, b| {
        let stamp = |n: &str| n[prefix.len() + 1..prefix.len() + 16].to_string();
        stamp(a).cmp(&stamp(b)).then_with(|| a.cmp(b))
    });
    let excess = names.len().saturating_sub(keep);
    names.truncate(excess);
    names
}

/// Deletes the oldest scheduled backups in `dir` beyond the newest `keep`. Returns the names removed.
/// `keep` below 1 is refused: "keep none" would delete the backup that was just written.
#[tauri::command]
pub async fn prune_backups(dir: String, prefix: String, keep: u32) -> Result<Value, String> {
    Box::pin(async move {
        if !valid_prefix(&prefix) {
            return Err(format!("Tiền tố tên bản sao lưu không hợp lệ: {prefix}"));
        }
        if keep < 1 {
            return Err("Phải giữ lại ít nhất một bản sao lưu".to_string());
        }
        tokio::task::spawn_blocking(move || {
            let dir_path = std::path::PathBuf::from(&dir);
            let entries = std::fs::read_dir(&dir_path)
                .map_err(|e| format!("Không đọc được thư mục sao lưu: {e}"))?;
            let names: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .filter_map(|e| e.file_name().into_string().ok())
                .collect();
            let mut deleted = Vec::new();
            let mut failed = Vec::new();
            for name in to_delete(names, &prefix, keep as usize) {
                match std::fs::remove_file(dir_path.join(&name)) {
                    Ok(()) => deleted.push(name),
                    // One locked file (an antivirus scan, a sync client) must not stop the rest.
                    Err(e) => failed.push(json!({ "name": name, "error": e.to_string() })),
                }
            }
            Ok(json!({ "deleted": deleted, "failed": failed }))
        })
        .await
        .map_err(|e| e.to_string())?
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_schedulers_own_names_match() {
        assert!(is_backup_name("sakila-20260926-020000.sql.gz", "sakila"));
        assert!(is_backup_name("sakila-20260926-020000.sql", "sakila"));
        assert!(!is_backup_name(
            "sakila-20260926-020000.sql.gz.part",
            "sakila"
        ));
        assert!(!is_backup_name("sakila-20260926-0200.sql.gz", "sakila"));
        assert!(!is_backup_name("sakila-notes.sql", "sakila"));
        assert!(!is_backup_name("sakila.sql.gz", "sakila"));
        // Another schedule's prefix that merely starts the same way.
        assert!(!is_backup_name(
            "sakila_test-20260926-020000.sql.gz",
            "sakila"
        ));
        assert!(!is_backup_name(
            "my-sakila-20260926-020000.sql.gz",
            "sakila"
        ));
    }

    #[test]
    fn the_newest_are_kept_and_nothing_else_is_touched() {
        let names = [
            "db-20260920-020000.sql.gz",
            "db-20260926-020000.sql.gz",
            "db-20260922-020000.sql.gz",
            "db-20260924-020000.sql",
            "readme.txt",
            "db-20260901-020000.sql.gz.part",
            "other-20260101-000000.sql.gz",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            to_delete(names.clone(), "db", 2),
            vec!["db-20260920-020000.sql.gz", "db-20260922-020000.sql.gz"]
        );
        assert!(to_delete(names.clone(), "db", 4).is_empty());
        assert!(to_delete(names, "db", 10).is_empty());
    }

    /// The command itself, on a real folder: only the oldest of this prefix go, a subdirectory named
    /// like a backup and every other file stay.
    #[tokio::test]
    async fn prunes_a_real_folder() {
        let dir = std::env::temp_dir().join(format!("tg-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("db-20260101-000000.sql.gz")).unwrap();
        for name in [
            "db-20260920-020000.sql.gz",
            "db-20260921-020000.sql.gz",
            "db-20260922-020000.sql.gz",
            "db-20260923-020000.sql.gz.part",
            "notes.txt",
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let out = prune_backups(dir.to_string_lossy().into_owned(), "db".into(), 1)
            .await
            .unwrap();
        assert_eq!(
            out["deleted"],
            json!(["db-20260920-020000.sql.gz", "db-20260921-020000.sql.gz"])
        );
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "db-20260101-000000.sql.gz",
                "db-20260922-020000.sql.gz",
                "db-20260923-020000.sql.gz.part",
                "notes.txt"
            ]
        );
        assert!(
            prune_backups(dir.to_string_lossy().into_owned(), "db".into(), 0)
                .await
                .is_err()
        );
        assert!(
            prune_backups(dir.to_string_lossy().into_owned(), "../db".into(), 1)
                .await
                .is_err()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_prefix_cannot_reach_outside_the_folder() {
        assert!(valid_prefix("sakila_prod.v2"));
        assert!(!valid_prefix("../x"));
        assert!(!valid_prefix("a/b"));
        assert!(!valid_prefix("a\\b"));
        assert!(!valid_prefix(".hidden"));
        assert!(!valid_prefix(""));
    }
}
