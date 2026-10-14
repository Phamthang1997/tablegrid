//! `notify_os` — an OS notification, for a background job that finished while the window was not
//! focused (`src/utils/jobNotify.ts`).
//!
//! `notify-rust` directly rather than `tauri-plugin-notification`, which this replaced, and the
//! reason is the one thing that decides whether Windows shows anything at all: the **AppUserModelID**.
//! Windows only displays a toast for an AUMID it knows — one registered by a Start-menu shortcut,
//! which the installer creates — and silently drops one for an unknown AUMID. No error, nothing.
//!
//! The plugin chose between the app's own identifier and `notify-rust`'s default by looking at the
//! EXECUTABLE PATH: only an exe inside `…\target\debug` or `…\target\release` counted as a dev build.
//! This repo builds into `C:\cargo-targets\tablegrid\debug` (`dev-start.bat` moves `CARGO_TARGET_DIR`
//! out of the workspace), so every dev run was taken for an installed app, used the unregistered
//! `com.tablegrid.desktop`, and every notification vanished — and the plugin discards the error
//! (`let _ = notification.show()`), so nothing said so.
//!
//! Here the question is asked of the build itself (`tauri::is_dev()`): a dev build uses
//! `notify-rust`'s default, PowerShell's AUMID, which is always registered (the toast is labelled
//! "Windows PowerShell" — the price of having no installer); a release build uses the identifier the
//! installer registered. And the error comes back to the caller.

use serde_json::{Value, json};

#[tauri::command]
pub async fn notify_os(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<Value, String> {
    Box::pin(async move {
        let identifier = app.config().identifier.clone();
        // The WinRT call is synchronous and can take a moment the first time; it does not belong
        // on an async worker.
        tokio::task::spawn_blocking(move || show(&identifier, &title, &body))
            .await
            .map_err(|e| e.to_string())??;
        Ok(json!({ "success": true }))
    })
    .await
}

fn show(identifier: &str, title: &str, body: &str) -> Result<(), String> {
    let mut n = notify_rust::Notification::new();
    n.summary(title).body(body);
    #[cfg(windows)]
    if !tauri::is_dev() {
        n.app_id(identifier);
    }
    // macOS needs the same choice made process-wide; this is what the plugin did there too.
    #[cfg(target_os = "macos")]
    let _ = notify_rust::set_application(if tauri::is_dev() {
        "com.apple.Terminal"
    } else {
        identifier
    });
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = identifier;
    n.show().map(|_| ()).map_err(|e| e.to_string())
}
