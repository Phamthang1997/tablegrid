//! The work that runs ONCE at app startup: the window's glass material, and the one bridge from
//! Tauri into the layers that never see an `AppState`.
//!
//! **This is the only file outside `app/` that should touch a Tauri handle.** `tx/` and `state/`
//! both used to park an `AppHandle` of their own; that linked Tauri's window layer into everything
//! reachable from the SQL funnels and broke every `cargo test --lib` binary on Windows. See
//! `state::set_emitter` for the whole story.

use tauri::{Emitter, Manager};

/// Runs inside `Builder::setup`. A failure here would be a startup failure, but both pieces of work
/// inside are best-effort, so the function has no failing branch.
pub fn init(app: &tauri::App) {
    apply_window_material(app);

    // Backend layers announce things to the UI through this one closure: `tx/` when a transaction
    // moves, `mcp/` when an AI client makes a request. They have no `AppHandle` and now no
    // knowledge of Tauri at all. They get a closure instead, so the UI can be told by event rather
    // than by threading a transaction-state field through every command's response shape.
    let handle = app.handle().clone();
    crate::state::set_emitter(move |event, payload| {
        let _ = handle.emit(event, payload);
    });

    // The encrypted MCP audit log. Its directory can only be asked of Tauri, and this file is the
    // only one allowed to ask - see the module comment above. A failure to start is deliberately
    // silent here and reported through `mcp_audit_file_status` instead: the app and the MCP server
    // must not fail to start because a log file could not be opened.
    if let Ok(dir) = app.path().app_data_dir() {
        crate::mcp::audit_file::init(dir);
    }
}

/// The window's glass material is applied ONLY here, never through windowEffects in
/// tauri.conf.json — declaring both applies the effect twice. Doing it by hand is deliberate:
/// Tauri handles windowEffects by taking the first matching variant and then ignoring the error it
/// returns, i.e. there is NO real fallback; here, when mica fails we can still fall back to blur.
fn apply_window_material(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = &window;

    #[cfg(target_os = "macos")]
    let _ = window_vibrancy::apply_vibrancy(
        &window,
        window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground,
        // Active: keep the glass fully lit even when the window loses focus
        // (macOS greys it out by default). 12.0: corner radius matching the CSS
        // [data-os='macos'] #root, since decorations = false.
        Some(window_vibrancy::NSVisualEffectState::Active),
        Some(12.0),
    );

    #[cfg(target_os = "windows")]
    {
        // dark = None -> Mica follows the system's light/dark preference.
        // Passing Some(true) used to force dark, so the app's light theme still
        // sat on dark glass. A machine without Mica support (Win 10) falls back
        // to Blur.
        if window_vibrancy::apply_mica(&window, None).is_err() {
            let _ = window_vibrancy::apply_blur(&window, Some((18, 20, 26, 125)));
        }
    }
}

// Do NOT set_menu here. There used to be a hand-built "Edit" menu made of
// MenuItem::with_id, but it was useless and actively harmful:
//  - No on_menu_event existed -> clicking the items did nothing at all,
//    while they still claimed the Ctrl+Z/X/C/V/A accelerators.
//  - On Windows with decorations = false the native menu bar is drawn
//    inside the client area -> a faint "Edit" label on top of our own TitleBar.
//  - On macOS, Tauri already attaches a full Menu::default() (App/File/Edit/
//    View/Window/Help) whose copy/paste items really work when the builder
//    does not call .menu() — see tauri/src/app.rs. set_menu() in setup()
//    runs later, so it was OVERWRITING that good menu with a broken one.
// Dropped entirely: macOS gets its default menu back, and on Windows/Linux
// WebView2/WebKitGTK handle clipboard inside inputs on their own anyway.
