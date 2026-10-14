//! Who is blocking whom — the facts behind the Process Monitor's Lock Tree.
//!
//! Returns the "A waits for B" EDGES, the sessions on either end of one (what they run, how long
//! their transaction has been open), and on MySQL the last deadlock InnoDB recorded. The tree itself
//! — roots, how many sessions sit behind each, a cycle — is built by `src/utils/lockTree.ts`, pure
//! and tested, so this file stays a translation of three dialects' catalogs into one shape.
//!
//! - **Postgres**: `pg_blocking_pids(pid)` is the server's own answer (it includes waits behind a
//!   queued lock request, which a hand-written `pg_locks` self-join gets wrong), and `pg_locks`
//!   only names what the waiter is waiting FOR.
//! - **MySQL 8**: `performance_schema.data_lock_waits` (row locks) + `metadata_locks` (the "Waiting
//!   for table metadata lock" an ALTER causes); **5.7**: `information_schema.innodb_lock_waits`.
//!   A server where neither can be read (no PROCESS privilege, performance_schema off) answers with
//!   `note: "noLockInfo"` instead of an empty graph that would read as "nothing is blocked".
//!
//! Read through `execute_raw_sql_pooled`, like the process list: a diagnostic must not run inside
//! the user's manual transaction.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use crate::database::{DbConnection, DbKind, execute_raw_sql_pooled, rows_of};

fn text(row: &Value, key: &str) -> String {
    match row.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn num(row: &Value, key: &str) -> i64 {
    match row.get(key) {
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .unwrap_or(0)
            .max(0),
        Some(Value::String(s)) => s
            .trim()
            .parse::<f64>()
            .map(|f| f as i64)
            .unwrap_or(0)
            .max(0),
        _ => 0,
    }
}

async fn rows(conn: &DbConnection, sql: &str) -> Result<Vec<Value>, String> {
    Ok(rows_of(
        &execute_raw_sql_pooled(conn, sql.to_string()).await?,
    ))
}

/// The "LATEST DETECTED DEADLOCK" section of `SHOW ENGINE INNODB STATUS`, without its dashes.
pub(crate) fn latest_deadlock(status: &str) -> Option<String> {
    let start = status.find("LATEST DETECTED DEADLOCK")?;
    let body = &status[start..];
    // The section runs until the next section header: a line of dashes followed by a title line.
    let after_title = body.find('\n').map(|i| i + 1).unwrap_or(body.len());
    let rest = &body[after_title..];
    let mut end = rest.len();
    let lines: Vec<&str> = rest.split_inclusive('\n').collect();
    let mut offset = 0;
    for (i, line) in lines.iter().enumerate() {
        if i > 1
            && line.trim_start().starts_with("------------")
            && lines.get(i + 1).is_some_and(|n| {
                let t = n.trim();
                !t.is_empty()
                    && t.chars()
                        .all(|c| c.is_ascii_uppercase() || c == ' ' || c == '/')
            })
        {
            end = offset;
            break;
        }
        offset += line.len();
    }
    let section = rest[..end]
        .trim_matches(|c: char| c == '-' || c.is_whitespace())
        .to_string();
    if section.is_empty() {
        None
    } else {
        Some(section)
    }
}

fn edge(
    waiting: String,
    blocking: String,
    lock_type: String,
    object: String,
    mode: String,
    wait_seconds: i64,
) -> Value {
    json!({ "waiting": waiting, "blocking": blocking, "lockType": lock_type, "object": object, "mode": mode, "waitSeconds": wait_seconds })
}

async fn postgres_graph(conn: &DbConnection) -> Result<Value, String> {
    let rs = rows(
        conn,
        "SELECT a.pid::text AS pid, COALESCE(a.usename, '') AS usr, COALESCE(a.datname, '') AS db, \
            COALESCE(a.state, '') AS state, COALESCE(a.query, '') AS query, \
            COALESCE(EXTRACT(EPOCH FROM clock_timestamp() - a.xact_start)::bigint, 0) AS tx_sec, \
            COALESCE(EXTRACT(EPOCH FROM clock_timestamp() - a.query_start)::bigint, 0) AS query_sec, \
            COALESCE(a.wait_event_type || ': ' || a.wait_event, '') AS wait_event, \
            COALESCE(array_to_string(pg_blocking_pids(a.pid), ','), '') AS blockers, \
            COALESCE((SELECT l.locktype || chr(31) || COALESCE(l.relation::regclass::text, '') || chr(31) || l.mode \
                        FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted LIMIT 1), '') AS waiting_for \
         FROM pg_stat_activity a \
         WHERE a.pid <> pg_backend_pid() AND a.backend_type = 'client backend'",
    )
    .await?;

    let mut edges = Vec::new();
    let mut involved = BTreeSet::new();
    for r in &rs {
        let blockers = text(r, "blockers");
        if blockers.is_empty() {
            continue;
        }
        let wf = text(r, "waiting_for");
        let mut parts = wf.split('\u{1f}');
        let (lt, obj, mode) = (
            parts.next().unwrap_or("").to_string(),
            parts.next().unwrap_or("").to_string(),
            parts.next().unwrap_or("").to_string(),
        );
        let pid = text(r, "pid");
        for b in blockers.split(',').filter(|b| !b.is_empty()) {
            edges.push(edge(
                pid.clone(),
                b.to_string(),
                lt.clone(),
                obj.clone(),
                mode.clone(),
                num(r, "query_sec"),
            ));
            involved.insert(b.to_string());
        }
        involved.insert(pid);
    }
    let sessions: Vec<Value> = rs
        .iter()
        .filter(|r| involved.contains(&text(r, "pid")))
        .map(|r| {
            json!({
                "id": text(r, "pid"),
                "user": text(r, "usr"),
                "db": text(r, "db"),
                "state": text(r, "state"),
                "query": text(r, "query"),
                "txSeconds": num(r, "tx_sec"),
                "stateSeconds": num(r, "query_sec"),
                "waitEvent": text(r, "wait_event"),
            })
        })
        .collect();
    Ok(
        json!({ "dialect": "postgres", "sessions": sessions, "edges": edges, "deadlock": Value::Null, "note": Value::Null }),
    )
}

async fn mysql_graph(conn: &DbConnection) -> Result<Value, String> {
    let mut edges: Vec<Value> = Vec::new();
    let mut have_info = false;

    // Row locks, MySQL 8.
    let row_locks_8 = rows(
        conn,
        "SELECT CAST(r.trx_mysql_thread_id AS CHAR) AS waiting, CAST(b.trx_mysql_thread_id AS CHAR) AS blocking, \
            COALESCE(w.LOCK_TYPE, '') AS ltype, \
            CONCAT_WS('.', w.OBJECT_SCHEMA, w.OBJECT_NAME) AS obj, COALESCE(w.LOCK_MODE, '') AS lmode, \
            COALESCE(TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()), 0) AS wait_sec \
         FROM performance_schema.data_lock_waits dlw \
         JOIN information_schema.INNODB_TRX r ON r.trx_id = dlw.REQUESTING_ENGINE_TRANSACTION_ID \
         JOIN information_schema.INNODB_TRX b ON b.trx_id = dlw.BLOCKING_ENGINE_TRANSACTION_ID \
         JOIN performance_schema.data_locks w ON w.ENGINE_LOCK_ID = dlw.REQUESTING_ENGINE_LOCK_ID",
    )
    .await;
    match row_locks_8 {
        Ok(rs) => {
            have_info = true;
            edges.extend(rs.iter().map(|r| {
                edge(
                    text(r, "waiting"),
                    text(r, "blocking"),
                    text(r, "ltype"),
                    text(r, "obj"),
                    text(r, "lmode"),
                    num(r, "wait_sec"),
                )
            }));
        }
        Err(_) => {
            // MySQL 5.7 / MariaDB.
            if let Ok(rs) = rows(
                conn,
                "SELECT CAST(r.trx_mysql_thread_id AS CHAR) AS waiting, CAST(b.trx_mysql_thread_id AS CHAR) AS blocking, \
                    COALESCE(l.lock_type, '') AS ltype, COALESCE(l.lock_table, '') AS obj, COALESCE(l.lock_mode, '') AS lmode, \
                    COALESCE(TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()), 0) AS wait_sec \
                 FROM information_schema.innodb_lock_waits w \
                 JOIN information_schema.innodb_trx r ON r.trx_id = w.requesting_trx_id \
                 JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_trx_id \
                 LEFT JOIN information_schema.innodb_locks l ON l.lock_id = w.requested_lock_id",
            )
            .await
            {
                have_info = true;
                edges.extend(rs.iter().map(|r| edge(text(r, "waiting"), text(r, "blocking"), text(r, "ltype"), text(r, "obj"), text(r, "lmode"), num(r, "wait_sec"))));
            }
        }
    }

    // Metadata locks (an ALTER TABLE stuck behind an open transaction, and everything queued
    // behind the ALTER). A PENDING request is linked to the sessions GRANTED a lock on the same
    // object — the ones actually holding it; that is where a "kill" helps.
    if let Ok(rs) = rows(
        conn,
        "SELECT CAST(tw.PROCESSLIST_ID AS CHAR) AS waiting, CAST(tb.PROCESSLIST_ID AS CHAR) AS blocking, \
            CONCAT_WS('.', w.OBJECT_SCHEMA, w.OBJECT_NAME) AS obj, w.LOCK_TYPE AS lmode, \
            COALESCE(tw.PROCESSLIST_TIME, 0) AS wait_sec \
         FROM performance_schema.metadata_locks w \
         JOIN performance_schema.metadata_locks g \
           ON g.OBJECT_TYPE = w.OBJECT_TYPE AND g.OBJECT_SCHEMA <=> w.OBJECT_SCHEMA AND g.OBJECT_NAME <=> w.OBJECT_NAME \
          AND g.LOCK_STATUS = 'GRANTED' AND g.OWNER_THREAD_ID <> w.OWNER_THREAD_ID \
         JOIN performance_schema.threads tw ON tw.THREAD_ID = w.OWNER_THREAD_ID \
         JOIN performance_schema.threads tb ON tb.THREAD_ID = g.OWNER_THREAD_ID \
         WHERE w.LOCK_STATUS = 'PENDING' AND w.OBJECT_TYPE = 'TABLE' \
           AND tw.PROCESSLIST_ID IS NOT NULL AND tb.PROCESSLIST_ID IS NOT NULL",
    )
    .await
    {
        have_info = true;
        let mut seen = BTreeSet::new();
        for r in &rs {
            let key = (text(r, "waiting"), text(r, "blocking"), text(r, "obj"));
            if seen.insert(key) {
                edges.push(edge(text(r, "waiting"), text(r, "blocking"), "METADATA".into(), text(r, "obj"), text(r, "lmode"), num(r, "wait_sec")));
            }
        }
    }

    let mut involved = BTreeSet::new();
    for e in &edges {
        involved.insert(text(e, "waiting"));
        involved.insert(text(e, "blocking"));
    }

    let mut sessions: Vec<Value> = Vec::new();
    if !involved.is_empty() {
        let rs = rows(
            conn,
            "SELECT CAST(p.ID AS CHAR) AS pid, COALESCE(p.USER, '') AS usr, COALESCE(p.DB, '') AS db, \
                COALESCE(p.COMMAND, '') AS cmd, COALESCE(p.STATE, '') AS state, COALESCE(p.INFO, '') AS query, \
                COALESCE(t.trx_query, '') AS trx_query, \
                COALESCE(TIMESTAMPDIFF(SECOND, t.trx_started, NOW()), 0) AS tx_sec, COALESCE(p.TIME, 0) AS state_sec \
             FROM information_schema.PROCESSLIST p \
             LEFT JOIN information_schema.INNODB_TRX t ON t.trx_mysql_thread_id = p.ID",
        )
        .await
        .unwrap_or_default();
        let by_id: BTreeMap<String, &Value> = rs.iter().map(|r| (text(r, "pid"), r)).collect();
        for id in &involved {
            let Some(r) = by_id.get(id) else {
                sessions.push(json!({ "id": id, "user": "", "db": "", "state": "", "query": "", "txSeconds": 0, "stateSeconds": 0, "waitEvent": "" }));
                continue;
            };
            let state = text(r, "state");
            let cmd = text(r, "cmd");
            let query = {
                let q = text(r, "query");
                if q.is_empty() {
                    text(r, "trx_query")
                } else {
                    q
                }
            };
            sessions.push(json!({
                "id": id,
                "user": text(r, "usr"),
                "db": text(r, "db"),
                // "Sleep" with an open transaction is the classic blocker: say so plainly.
                "state": if state.is_empty() { cmd } else { state },
                "query": query,
                "txSeconds": num(r, "tx_sec"),
                "stateSeconds": num(r, "state_sec"),
                "waitEvent": "",
            }));
        }
    }

    let deadlock = rows(conn, "SHOW ENGINE INNODB STATUS")
        .await
        .ok()
        .and_then(|r| r.into_iter().next())
        .and_then(|r| r.get("Status").and_then(Value::as_str).map(str::to_string))
        .and_then(|s| latest_deadlock(&s));

    Ok(json!({
        "dialect": "mysql",
        "sessions": sessions,
        "edges": edges,
        "deadlock": deadlock,
        "note": if have_info { Value::Null } else { Value::String("noLockInfo".into()) },
    }))
}

#[tauri::command]
pub async fn get_lock_graph(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let conn = {
            let ctx = state.connections.acquire(&conn_id)?;
            ctx.conn().clone()
        };
        match &conn.kind {
            DbKind::Postgres(_) => postgres_graph(&conn).await,
            DbKind::Mysql(_) => mysql_graph(&conn).await,
            // One process, one writer: nothing can wait on another session here.
            DbKind::Sqlite(_) | DbKind::DuckDb(_) => Ok(json!({
                "dialect": "embedded", "sessions": [], "edges": [], "deadlock": Value::Null, "note": "embedded"
            })),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATUS: &str = "\n=====================================\n2026-10-05 INNODB MONITOR OUTPUT\n=====================================\n------------------------\nLATEST DETECTED DEADLOCK\n------------------------\n2026-10-05 21:00:01 0x7f\n*** (1) TRANSACTION:\nTRANSACTION 1234, ACTIVE 5 sec starting index read\nUPDATE film SET title='x' WHERE film_id=1\n*** (2) TRANSACTION:\nUPDATE film SET title='y' WHERE film_id=2\n*** WE ROLL BACK TRANSACTION (2)\n------------\nTRANSACTIONS\n------------\nTrx id counter 5678\n";

    #[test]
    fn the_latest_deadlock_section_is_cut_out_whole() {
        let d = latest_deadlock(STATUS).expect("a deadlock section");
        assert!(d.starts_with("2026-10-05 21:00:01"), "{d}");
        assert!(d.contains("*** WE ROLL BACK TRANSACTION (2)"));
        assert!(
            !d.contains("Trx id counter"),
            "stops before the next section"
        );
        assert!(!d.contains("LATEST DETECTED"));
    }

    #[test]
    fn no_section_means_no_deadlock() {
        assert_eq!(
            latest_deadlock("------------\nTRANSACTIONS\n------------\n"),
            None
        );
    }
}
