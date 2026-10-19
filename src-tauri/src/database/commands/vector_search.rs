//! `pg_vector_search` — a k-NN query run with the search-time settings of an approximate index
//! (`hnsw.ef_search`, `ivfflat.probes`) applied to it and to nothing else.
//!
//! Those settings are session GUCs, and a pooled connection is not a session the user owns: a plain
//! `SET` would stay on whichever connection the pool handed out and quietly change every later
//! query that lands there. So the query runs inside a transaction that is always rolled back, with
//! `SET LOCAL`, which lasts exactly as long as that transaction. The same statement is also safe on
//! the manual-transaction session: there it runs in a savepoint, and `ROLLBACK TO` undoes a
//! `SET LOCAL` too, leaving the user's transaction as it was.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::database::{DbKind, pg_bound, pg_raw, reject_if_read_only, stmt_timeout, with_timeout};

/// Search-time knobs. `None` leaves the server's value (40 for `ef_search`, 1 for `probes`).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorSearchSettings {
    pub ef_search: Option<i64>,
    pub probes: Option<i64>,
}

/// pgvector's own bounds: `hnsw.ef_search` is 1..1000; `ivfflat.probes` 1..32768 (a value above
/// `lists` is accepted and just scans every list).
const EF_SEARCH_MAX: i64 = 1000;
const PROBES_MAX: i64 = 32_768;

/// The `SET LOCAL` statements for these settings. Only integers checked against the bounds are
/// written into the SQL, so nothing the frontend sends is spliced as text.
pub(crate) fn settings_sql(s: &VectorSearchSettings) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    if let Some(v) = s.ef_search {
        if !(1..=EF_SEARCH_MAX).contains(&v) {
            return Err("hnsw.ef_search phải là số nguyên từ 1 đến 1000".to_string());
        }
        out.push(format!("SET LOCAL hnsw.ef_search = {v}"));
    }
    if let Some(v) = s.probes {
        if !(1..=PROBES_MAX).contains(&v) {
            return Err("ivfflat.probes phải là số nguyên từ 1 đến 32768".to_string());
        }
        out.push(format!("SET LOCAL ivfflat.probes = {v}"));
    }
    Ok(out)
}

/// Only a read belongs here. Everything this command runs is rolled back, so a write would vanish
/// without a word, and on the manual-transaction session it would still be counted as a pending
/// change that no longer exists.
pub(crate) fn is_search_stmt(sql: &str) -> bool {
    let head = crate::database::strip_leading_comments(sql).trim_start();
    let word: String = head
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect();
    matches!(word.to_ascii_uppercase().as_str(), "SELECT" | "EXPLAIN")
}

#[tauri::command]
pub async fn pg_vector_search(
    conn_id: String,
    sql: String,
    params: Option<Vec<Value>>,
    settings: Option<VectorSearchSettings>,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let (conn, limit) = {
            let ctx = state.connections.acquire(&conn_id)?;
            (ctx.conn().clone(), stmt_timeout(&ctx.server().config()))
        };
        let DbKind::Postgres(pool) = &conn.kind else {
            return Err("Tìm kiếm vector chỉ hỗ trợ PostgreSQL".to_string());
        };
        if !is_search_stmt(&sql) {
            return Err("Tìm kiếm vector chỉ chạy câu SELECT hoặc EXPLAIN".to_string());
        }
        reject_if_read_only(&conn, &sql)?;
        let setup = settings_sql(&settings.unwrap_or_default())?;
        let params = params.unwrap_or_default();

        let run = async {
            if crate::tx::should_route(&conn, &sql) {
                return crate::tx::run_bound_scoped(&conn, &setup, sql.clone(), &params).await;
            }
            // Dropping a `Transaction` rolls it back, so an error or a timeout between here and
            // the explicit rollback still leaves nothing behind on the pooled connection.
            let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
            for stmt in &setup {
                pg_raw(&mut tx, stmt).await?;
            }
            let out = pg_bound(&mut tx, &sql, &params).await;
            tx.rollback().await.map_err(|e| e.to_string())?;
            out
        };
        let results = with_timeout(limit, run).await?;
        Ok(json!({ "success": true, "results": results }))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(ef: Option<i64>, probes: Option<i64>) -> VectorSearchSettings {
        VectorSearchSettings {
            ef_search: ef,
            probes,
        }
    }

    #[test]
    fn only_reads_are_accepted() {
        assert!(is_search_stmt("SELECT 1"));
        assert!(is_search_stmt("  explain SELECT 1"));
        assert!(is_search_stmt(
            "-- k-NN
SELECT 1"
        ));
        assert!(!is_search_stmt("DELETE FROM t"));
        assert!(!is_search_stmt(
            "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"
        ));
        assert!(!is_search_stmt("SELECTX"));
        assert!(!is_search_stmt(""));
    }

    #[test]
    fn nothing_set_means_no_statement() {
        assert!(settings_sql(&s(None, None)).unwrap().is_empty());
    }

    #[test]
    fn both_settings_become_set_local() {
        assert_eq!(
            settings_sql(&s(Some(400), Some(10))).unwrap(),
            vec![
                "SET LOCAL hnsw.ef_search = 400",
                "SET LOCAL ivfflat.probes = 10"
            ]
        );
    }

    #[test]
    fn values_outside_pgvector_bounds_are_refused() {
        for (ef, pr) in [
            (Some(0), None),
            (Some(1001), None),
            (None, Some(0)),
            (None, Some(40_000)),
            (Some(-5), None),
        ] {
            assert!(settings_sql(&s(ef, pr)).is_err(), "{ef:?} {pr:?}");
        }
        assert!(settings_sql(&s(Some(1), Some(1))).is_ok());
        assert!(settings_sql(&s(Some(1000), Some(32_768))).is_ok());
    }
}
