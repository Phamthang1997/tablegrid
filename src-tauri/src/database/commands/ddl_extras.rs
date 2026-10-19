//! `get_table_ddl_extras` — the DDL a hand-built `CREATE TABLE` is missing (indexes, FKs, CHECKs,
//! comments, sequences). The dump export calls this per table.

use serde_json::{Value, json};

use crate::database::{DbConnection, DbKind, all_string_values, execute_raw_sql_generic, sql_str};

/// Everything that belongs to a table but does NOT live inside that dialect's CREATE TABLE.
///
/// MySQL needs nothing: `SHOW CREATE TABLE` already carries indexes, foreign keys, CHECKs and
/// AUTO_INCREMENT. SQLite keeps indexes as their own `sqlite_master` rows. Postgres has no
/// SHOW CREATE TABLE at all, so `get_table_definition` hand-builds one from columns + PK only —
/// index, FK/UNIQUE/CHECK, comments and the sequence behind a `serial` column are all missing,
/// and a dump without the sequence fails to restore outright ("relation x_id_seq does not exist").
///
/// Grouped by WHERE the statement has to run, which is the whole point:
///   - `sequences`  before its CREATE TABLE (the column DEFAULT references it),
///   - `indexes` / `comments`  right after CREATE TABLE,
///   - `constraints`  after EVERY table (a foreign key points at another table),
///   - `sequence_values`  after the data (setval reads MAX() of the rows just inserted),
///   - `extensions`  before the first table needing one (a column typed `vector` or `citext`).
#[tauri::command]
pub async fn get_table_ddl_extras(conn_id: String, table_name: String) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.schema().to_string())
    };
    let esc = table_name.replace('\'', "''");
    // Only the catalog lookups take the schema. The statements these build stay unqualified so a
    // dump can be restored into a differently-named schema — the header's SET search_path decides.
    let sch = sql_str(&schema);

    // Runs a query whose single column is a ready-to-run statement; a dialect that does not
    // support one of these (older server, missing catalog) yields an empty list instead of
    // failing the whole export.
    async fn ddl_list(conn: &DbConnection, sql: String) -> Vec<String> {
        match execute_raw_sql_generic(conn, sql).await {
            Ok(results) => all_string_values(&results),
            Err(_) => Vec::new(),
        }
    }

    let mut sequences: Vec<String> = Vec::new();
    let mut indexes: Vec<String> = Vec::new();
    let mut constraints: Vec<String> = Vec::new();
    let mut comments: Vec<String> = Vec::new();
    let mut sequence_values: Vec<String> = Vec::new();
    let mut extensions: Vec<String> = Vec::new();

    match &conn_type.kind {
        // DuckDB keeps a table's whole definition in its own CREATE (duckdb_tables().sql).
        DbKind::Mysql(_) | DbKind::DuckDb(_) => {}
        DbKind::Sqlite(_) => {
            // sql IS NULL for the indexes SQLite creates itself (UNIQUE / AUTOINCREMENT):
            // they come back with the table and must not be replayed.
            indexes = ddl_list(
                &conn_type,
                format!(
                    "SELECT sql || ';' FROM sqlite_master WHERE type = 'index' AND tbl_name = '{}' AND sql IS NOT NULL",
                    esc
                ),
            )
            .await;
        }
        DbKind::Postgres(_) => {
            sequences = ddl_list(&conn_type, format!(
                "SELECT 'CREATE SEQUENCE IF NOT EXISTS ' || quote_ident(s.relname) || ';' \
                 FROM pg_class s JOIN pg_depend d ON d.objid = s.oid AND d.deptype = 'a' \
                 JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace n ON n.oid = t.relnamespace \
                 WHERE s.relkind = 'S' AND n.nspname = '{sch}' AND t.relname = '{esc}'")).await;

            // Skip every index that merely backs a constraint — PRIMARY KEY is already inside
            // CREATE TABLE and UNIQUE comes back below as ALTER TABLE ADD CONSTRAINT.
            indexes = ddl_list(&conn_type, format!(
                "SELECT pg_get_indexdef(i.indexrelid) || ';' \
                 FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = '{sch}' AND c.relname = '{esc}' \
                   AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)")).await;

            // contype: f = foreign key, u = unique, c = check. 'p' (primary key) is skipped.
            constraints = ddl_list(&conn_type, format!(
                "SELECT 'ALTER TABLE ' || quote_ident(c.relname) || ' ADD CONSTRAINT ' \
                     || quote_ident(con.conname) || ' ' || pg_get_constraintdef(con.oid) || ';' \
                 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = '{sch}' AND c.relname = '{esc}' AND con.contype IN ('f','u','c') \
                 ORDER BY con.contype DESC, con.conname")).await;

            comments = ddl_list(&conn_type, format!(
                "SELECT 'COMMENT ON TABLE ' || quote_ident(c.relname) || ' IS ' \
                     || quote_literal(obj_description(c.oid)) || ';' \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = '{sch}' AND c.relname = '{esc}' AND obj_description(c.oid) IS NOT NULL \
                 UNION ALL \
                 SELECT 'COMMENT ON COLUMN ' || quote_ident(c.relname) || '.' || quote_ident(a.attname) \
                     || ' IS ' || quote_literal(col_description(c.oid, a.attnum)) || ';' \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
                 WHERE n.nspname = '{sch}' AND c.relname = '{esc}' \
                   AND col_description(c.oid, a.attnum) IS NOT NULL")).await;

            // setval computed from the restored rows instead of the value read at export time:
            // the dump stays correct no matter how long it sits on disk before being replayed.
            sequence_values = ddl_list(&conn_type, format!(
                "SELECT 'SELECT setval(' || quote_literal(quote_ident(s.relname)) || ', COALESCE((SELECT MAX(' \
                     || quote_ident(a.attname) || ') FROM ' || quote_ident(t.relname) || '), 1), true);' \
                 FROM pg_class s JOIN pg_depend d ON d.objid = s.oid AND d.deptype = 'a' \
                 JOIN pg_class t ON t.oid = d.refobjid \
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid \
                 JOIN pg_namespace n ON n.oid = t.relnamespace \
                 WHERE s.relkind = 'S' AND n.nspname = '{sch}' AND t.relname = '{esc}'")).await;

            // The extensions a column type belongs to (`deptype = 'e'` on the type, or on the element
            // type of an array like `vector[]`). The hand-built CREATE TABLE names `vector(1536)`, which a
            // fresh database does not know until the extension is created. One statement per row, the
            // schema first when the extension lives outside `public`, so the order survives the list.
            extensions = ddl_list(&conn_type, format!(
                "SELECT stmt FROM ( \
                   SELECT DISTINCT e.extname, en.nspname FROM pg_class c \
                   JOIN pg_namespace n ON n.oid = c.relnamespace \
                   JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
                   JOIN pg_type ty ON ty.oid = a.atttypid \
                   JOIN pg_depend d ON d.classid = 'pg_type'::regclass AND d.deptype = 'e' \
                     AND d.objid IN (ty.oid, NULLIF(ty.typelem, 0)) \
                   JOIN pg_extension e ON e.oid = d.refobjid \
                   JOIN pg_namespace en ON en.oid = e.extnamespace \
                   WHERE n.nspname = '{sch}' AND c.relname = '{esc}') x \
                 CROSS JOIN LATERAL (VALUES \
                   (0, CASE WHEN x.nspname NOT IN ('public', 'pg_catalog') \
                            THEN 'CREATE SCHEMA IF NOT EXISTS ' || quote_ident(x.nspname) || ';' END), \
                   (1, 'CREATE EXTENSION IF NOT EXISTS ' || quote_ident(x.extname) \
                       || CASE WHEN x.nspname NOT IN ('public', 'pg_catalog') \
                               THEN ' WITH SCHEMA ' || quote_ident(x.nspname) ELSE '' END || ';')) v(ord, stmt) \
                 WHERE stmt IS NOT NULL ORDER BY x.extname, v.ord")).await;
        }
    }

    Ok(json!({
        "success": true,
        "sequences": sequences,
        "indexes": indexes,
        "constraints": constraints,
        "comments": comments,
        "sequenceValues": sequence_values,
        "extensions": extensions,
    }))
}).await
}
