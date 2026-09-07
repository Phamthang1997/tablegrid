//! The list of EVERY `#[tauri::command]` in the app. Add a command but forget to declare it here and
//! the frontend call fails at runtime with "unknown command"; the compiler cannot catch it.

/// Returns the handler for `Builder::invoke_handler`.
///
/// `generate_handler!` expands to a closure; wrapping it in a function keeps `lib.rs` from carrying
/// 150 lines of paths.
pub fn handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        crate::database::connect_db,
        crate::database::disconnect_db,
        crate::database::list_connections,
        crate::database::set_connection_read_only,
        crate::database::set_connection_mcp_exposed,
        crate::database::set_connection_mcp_write,
        crate::database::get_connection_status,
        crate::database::ping_connections,
        crate::database::get_tables,
        crate::database::get_temporary_tables,
        crate::database::get_full_catalog,
        crate::database::get_table_data,
        crate::database::set_statement_timeout,
        crate::database::get_table_schema,
        crate::database::alter_table_schema,
        crate::database::preview_alter_schema,
        crate::database::execute_query,
        crate::database::execute_multi_query,
        crate::database::execute_query_stream,
        crate::database::cancel_query,
        crate::database::get_process_list,
        crate::database::kill_process_query,
        crate::database::kill_process_connection,
        crate::tx::tx_status,
        crate::tx::tx_any_pending,
        crate::tx::tx_set_autocommit,
        crate::tx::tx_set_isolation,
        crate::tx::tx_commit,
        crate::tx::tx_rollback,
        crate::tx::tx_savepoint,
        crate::tx::tx_rollback_to,
        crate::terminal::ssh::open_ssh_terminal,
        crate::terminal::ssh::send_ssh_input,
        crate::terminal::ssh::resize_ssh_terminal,
        crate::terminal::ssh::close_ssh_terminal,
        crate::terminal::local::open_local_terminal,
        crate::terminal::local::send_local_input,
        crate::terminal::local::resize_local_terminal,
        crate::terminal::local::close_local_terminal,
        crate::database::commit_changes,
        crate::app::ai::ai_chat,
        crate::database::restore_backup,
        crate::database::import_new_table,
        crate::database::create_table,
        crate::database::drop_table,
        crate::database::truncate_table,
        crate::database::get_table_definition,
        crate::database::rename_table,
        crate::database::import_table_data,
        crate::database::get_databases_list,
        crate::database::list_databases,
        crate::database::open_database,
        crate::database::list_schemas,
        crate::database::set_current_schema,
        crate::database::create_database,
        crate::database::drop_database,
        crate::database::rename_database,
        crate::database::get_db_charsets,
        crate::database::get_database_objects,
        crate::database::get_object_definition,
        crate::database::get_table_triggers,
        crate::database::get_all_triggers,
        crate::database::get_table_ddl_extras,
        crate::database::save_trigger,
        crate::database::drop_trigger,
        crate::database::save_routine_definition,
        crate::database::get_sequences,
        crate::database::alter_sequence,
        crate::database::drop_sequence,
        crate::database::get_table_partitions,
        crate::database::get_check_constraints,
        crate::database::save_view_definition,
        crate::mcp::commands::mcp_status,
        crate::mcp::commands::mcp_start,
        crate::mcp::commands::mcp_stop,
        crate::mcp::commands::mcp_get_token,
        crate::mcp::commands::mcp_regenerate_token,
        crate::mcp::commands::mcp_audit_log,
        crate::mcp::commands::mcp_audit_clear,
        crate::mcp::commands::mcp_approval_respond,
        crate::mcp::commands::mcp_audit_file_read,
        crate::app::shell::open_url,
        crate::credentials::oauth::start_google_oauth_flow,
        crate::app::shell::set_app_window_size,
        crate::credentials::secret_store::secret_set,
        crate::credentials::secret_store::secret_get,
        crate::credentials::secret_store::secret_delete,
        crate::credentials::secret_store::secret_get_many,
        crate::credentials::secret_store::secret_set_many,
        crate::credentials::secret_store::secret_delete_many,
        crate::datagen::get_generation_targets,
        crate::datagen::preview_generated_data,
        crate::datagen::generate_data,
        crate::datagen::cancel_data_generation,
        crate::compare::compare_schemas,
        crate::compare::compare_data_overview,
        crate::compare::compare_table_data,
        crate::stats::get_database_stats,
        crate::stats::get_all_databases_stats,
        crate::stats::get_all_databases_sizes,
        crate::stats::get_exact_table_row_count,
        crate::stats::get_table_properties,
        crate::redis_db::redis_connect,
        crate::redis_db::redis_disconnect,
        crate::redis_db::redis_select_db,
        crate::redis_db::redis_scan_keys,
        crate::redis_db::redis_scan_stream,
        crate::redis_db::redis_get_key,
        crate::redis_db::redis_set_key,
        crate::redis_db::redis_hash_set,
        crate::redis_db::redis_hash_del,
        crate::redis_db::redis_list_set,
        crate::redis_db::redis_list_push,
        crate::redis_db::redis_list_del,
        crate::redis_db::redis_set_member,
        crate::redis_db::redis_set_del_member,
        crate::redis_db::redis_zset_add,
        crate::redis_db::redis_zset_del,
        crate::redis_db::redis_stream_add,
        crate::redis_db::redis_stream_del,
        crate::redis_db::redis_delete_keys,
        crate::redis_db::redis_set_ttl,
        crate::redis_db::redis_rename_key,
        crate::redis_db::redis_flush_db,
        crate::redis_db::redis_info,
        crate::redis_db::redis_execute_cmd,
        crate::redis_db::redis_set_read_only,
        crate::redis_db::redis_get_elements,
        crate::redis_db::redis_delete_by_pattern,
        crate::redis_db::redis_slowlog_get,
        crate::redis_db::redis_slowlog_reset,
        crate::redis_db::redis_slowlog_config,
        crate::redis_db::redis_pubsub_start,
        crate::redis_db::redis_publish,
        crate::redis_db::redis_monitor_start,
        crate::redis_db::redis_json_get,
        crate::redis_db::redis_json_set,
        crate::redis_db::redis_json_del,
        crate::redis_db::redis_set_key_bytes,
        crate::redis_db::redis_stream_groups,
        crate::redis_db::redis_stream_consumers,
        crate::redis_db::redis_stream_pending,
        crate::redis_db::redis_stream_ack,
        crate::redis_db::redis_stream_claim,
        crate::redis_db::redis_analyze_db,
        crate::redis_db::redis_dump_keys,
        crate::redis_db::redis_restore_keys
    ]
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("read_dir") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    /// Everything an `async` command must do to survive a release build, checked against the source
    /// rather than trusted to reviewers — because the failure is invisible in `tauri dev` and shows
    /// up as `STATUS_STACK_OVERFLOW` on `thread 'main'` in the packaged app, with no console to
    /// print it. See CLAUDE.md for the mechanism; both halves cost a long investigation to find.
    ///
    /// This reads the text instead of using the type system because neither rule is expressible as a
    /// type: `State<'_, _>` is a perfectly good parameter that merely happens to make the future
    /// non-`'static`, and "the body starts with `Box::pin`" is a statement about a body.
    ///
    /// Sync commands are exempt from both: no future is built, so there is no state machine to place
    /// and nothing to spawn.
    #[test]
    fn every_async_command_is_boxed_and_reads_state_globally() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_files(&root, &mut files);
        files.sort();

        let mut borrows_state = Vec::new();
        let mut not_boxed = Vec::new();
        let mut checked = 0usize;

        for file in &files {
            let text = std::fs::read_to_string(file).expect("read");
            let lines: Vec<&str> = text.lines().collect();
            let shown = file
                .strip_prefix(&root)
                .unwrap_or(file)
                .display()
                .to_string();

            for (i, line) in lines.iter().enumerate() {
                // Anchored at the start of a line so the attribute NAMED in a doc comment (this
                // module's own header does exactly that) is not mistaken for one applied to a fn.
                if !line.trim_start().starts_with("#[tauri::command]") {
                    continue;
                }

                // Gather the signature: from the `fn` line up to the `{` that opens the body.
                //
                // Comments are stripped first, and that is not tidiness — `restore_backup` documents
                // its progress channel as `{type:'start'|...}` INSIDE its parameter list, and taking
                // that brace for the body's made this test report a correctly-wrapped command.
                // Stripping also keeps a `State<'_` mentioned in prose from being read as a
                // parameter. A return type cannot contain a brace, so the first surviving one opens
                // the body.
                let code_of = |l: &str| l.split("//").next().unwrap_or("").to_string();
                let mut signature = String::new();
                let mut body_line = None;
                for (j, l) in lines.iter().enumerate().skip(i + 1) {
                    let code = code_of(l);
                    signature.push_str(&code);
                    signature.push(' ');
                    if code.contains('{') {
                        body_line = Some(j);
                        break;
                    }
                }
                let Some(body_line) = body_line else { continue };
                if !signature.contains("async fn") {
                    continue; // sync command
                }
                checked += 1;

                let name = signature
                    .split("fn ")
                    .nth(1)
                    .and_then(|s| s.split('(').next())
                    .unwrap_or("?")
                    .trim()
                    .to_string();

                if signature.contains("State<'_") {
                    borrows_state.push(format!("{shown}: {name}"));
                }

                // First real statement of the body: the rest of the opening line if it carries one,
                // otherwise the next line that is neither blank nor a comment.
                let opening = code_of(lines[body_line]);
                let after_brace = opening
                    .split_once('{')
                    .map(|(_, rest)| rest.trim().to_string())
                    .unwrap_or_default();
                let first_stmt = if !after_brace.is_empty() {
                    after_brace.to_string()
                } else {
                    lines
                        .iter()
                        .skip(body_line + 1)
                        .map(|l| l.trim())
                        .find(|l| !l.is_empty() && !l.starts_with("//"))
                        .unwrap_or("")
                        .to_string()
                };
                if !first_stmt.starts_with("Box::pin(") {
                    not_boxed.push(format!("{shown}: {name}"));
                }
            }
        }

        // A source-scanning test whose parser silently matches nothing passes for the wrong reason
        // and guards nothing. The floor is well below the ~132 commands that exist, so it survives
        // ordinary churn while still failing loudly if the scan itself breaks.
        assert!(
            checked >= 100,
            "only {checked} async commands were found — the scan is broken, not the code"
        );

        assert!(
            borrows_state.is_empty(),
            "These async commands take `State<'_, _>`, which makes their future non-'static so \
             Tauri runs it on the MAIN thread (1MB of stack on Windows) instead of spawning it. \
             Use `crate::state::require_state()?` in the body instead:\n  {}",
            borrows_state.join("\n  ")
        );
        assert!(
            not_boxed.is_empty(),
            "These async command bodies are not wrapped in `Box::pin(async move {{ .. }}).await`, \
             so the command's whole state machine is a field of the block `#[tauri::command]` \
             generates and is allocated on the caller's stack:\n  {}",
            not_boxed.join("\n  ")
        );
    }
}
