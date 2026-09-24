//! Tauri bootstrap: builds the `Builder`, attaches plugins, `manage`s state and wires the handler.
//!
//! `setup.rs` and `handlers.rs` are two pieces of this very Builder, so it has to sit next to them
//! rather than in `lib.rs` — `lib.rs` only does what nothing else can: declare the modules.

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // BEFORE the Builder, and it never comes back: `--mcp-stdio` turns this launch into a plain
    // stdio<->HTTP proxy for an AI client, and must not touch the window layer at all. That is the
    // bootstrap-level change `docs/mcp-server-plan.md` §0.4 was wary of - contained here to one
    // early `if`, because a proxy needs no window, no plugins and no state.
    if let Some(port) = crate::mcp::stdio::requested_port(&std::env::args().collect::<Vec<_>>()) {
        crate::mcp::stdio::serve(port);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            super::setup::init(app);
            Ok(())
        })
        .manage(AppState::new())
        .invoke_handler(super::handlers::handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
