// foqus writer — Rust backend.
//
// Philosophy: "file over app". Documents are plain UTF-8 Markdown on disk, owned
// by the user. The frontend picks a path with the dialog plugin; these commands
// do the actual disk I/O with full filesystem access (Rust isn't bound by the JS
// permission scope), so foqus can open and save any `.md` anywhere — no lock-in.
//
// Saving model:
//   • New docs are untitled. While untitled, the editor autosaves continuously to
//     a private *draft* file in the app data dir, so a crash/quit never loses
//     words. The user is NEVER prompted for a location while writing.
//   • The location is chosen only at a boundary — closing the window or opening
//     another file — at which point the draft is finalized to the chosen path.
//   • Drafts are recovered on next launch.
//
// This file also owns the native macOS menu (File ▸ New / Open / Save / Save As /
// Close, plus a real Edit menu so copy/paste work) and multi-window creation.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};

static WIN_SEQ: AtomicU32 = AtomicU32::new(1);
static DRAFT_SEQ: AtomicU32 = AtomicU32::new(0);

#[derive(Serialize)]
struct Document {
    path: String,
    name: String,
    content: String,
}

#[derive(Serialize)]
struct Draft {
    path: String,
    content: String,
    modified: u64,
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled.md")
        .to_string()
}

fn drafts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("drafts");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Read a document from disk.
#[tauri::command]
fn read_document(path: String) -> Result<Document, String> {
    let content = fs::read_to_string(&path).map_err(|e| format!("Couldn't open file: {e}"))?;
    Ok(Document {
        name: file_name(&path),
        path,
        content,
    })
}

/// Atomically save: write to a sibling temp file, then rename over the target.
/// A crash mid-write can never corrupt existing words.
#[tauri::command]
fn save_document(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let dir = target
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let file = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled.md");
    let tmp = dir.join(format!(".{file}.foqus.tmp"));

    fs::write(&tmp, content.as_bytes()).map_err(|e| format!("Couldn't write: {e}"))?;
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Couldn't save: {e}")
    })?;
    Ok(())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// Return a fresh, unique draft file path (and ensure the drafts dir exists).
#[tauri::command]
fn new_draft_path(app: AppHandle) -> Result<String, String> {
    let dir = drafts_dir(&app)?;
    let seq = DRAFT_SEQ.fetch_add(1, Ordering::Relaxed);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(dir.join(format!("draft-{ts}-{seq}.md")).to_string_lossy().to_string())
}

/// Delete a draft — but ONLY a file inside our own drafts dir, so this can never
/// remove a user's real document.
#[tauri::command]
fn discard_draft(app: AppHandle, path: String) -> Result<(), String> {
    let dir = drafts_dir(&app)?;
    let p = PathBuf::from(&path);
    if p.starts_with(&dir) && p.exists() {
        let _ = fs::remove_file(&p);
    }
    Ok(())
}

/// List non-empty drafts, newest first — used to recover unfinished work on launch.
#[tauri::command]
fn list_drafts(app: AppHandle) -> Result<Vec<Draft>, String> {
    let dir = drafts_dir(&app)?;
    let mut out: Vec<Draft> = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            if let Ok(content) = fs::read_to_string(&p) {
                if content.trim().is_empty() {
                    let _ = fs::remove_file(&p); // prune empties
                    continue;
                }
                let modified = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                out.push(Draft {
                    path: p.to_string_lossy().to_string(),
                    content,
                    modified,
                });
            }
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

/// Open a new document window (File ▸ New / ⌘N). Each window is an independent doc.
fn create_doc_window(app: &AppHandle) {
    let n = WIN_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("doc-{n}");
    let off = (n % 7) as f64 * 28.0;
    let _ = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("foqus")
        .inner_size(1000.0, 720.0)
        .min_inner_size(480.0, 420.0)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .position(150.0 + off, 120.0 + off)
        .build();
}

#[tauri::command]
fn new_window(app: AppHandle) {
    create_doc_window(&app);
}

/// Send a menu action to whichever window is focused (save logic lives in the JS).
fn emit_focused(app: &AppHandle, event: &str) {
    for (_, w) in app.webview_windows() {
        if w.is_focused().unwrap_or(false) {
            let _ = w.emit(event, ());
            return;
        }
    }
}

/// Quit (⌘Q): close every window through the normal close flow, so each one runs
/// its "Save your work?" prompt. When the last window is gone, the app exits
/// (handled in on_window_event). Cancelling a prompt leaves that window open.
fn request_quit(app: &AppHandle) {
    if app.webview_windows().is_empty() {
        app.exit(0);
        return;
    }
    for (_, w) in app.webview_windows() {
        let _ = w.close();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .setup(|app| {
            let h = app.handle();

            let settings_i = MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(h)?;
            let quit_i = MenuItemBuilder::with_id("quit", "Quit foqus")
                .accelerator("CmdOrCtrl+Q")
                .build(h)?;
            let app_menu = SubmenuBuilder::new(h, "foqus")
                .about(Some(AboutMetadata {
                    name: Some("foqus".into()),
                    ..Default::default()
                }))
                .separator()
                .item(&settings_i)
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .item(&quit_i)
                .build()?;

            let new_i = MenuItemBuilder::with_id("new", "New")
                .accelerator("CmdOrCtrl+N")
                .build(h)?;
            let open_i = MenuItemBuilder::with_id("open", "Open…")
                .accelerator("CmdOrCtrl+O")
                .build(h)?;
            let save_i = MenuItemBuilder::with_id("save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(h)?;
            let saveas_i = MenuItemBuilder::with_id("saveas", "Save As…")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(h)?;
            let file_menu = SubmenuBuilder::new(h, "File")
                .item(&new_i)
                .item(&open_i)
                .separator()
                .item(&save_i)
                .item(&saveas_i)
                .separator()
                .close_window()
                .build()?;

            let edit_menu = SubmenuBuilder::new(h, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let menu = MenuBuilder::new(h)
                .items(&[&app_menu, &file_menu, &edit_menu])
                .build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "new" => create_doc_window(app),
            "open" => emit_focused(app, "menu:open"),
            "save" => emit_focused(app, "menu:save"),
            "saveas" => emit_focused(app, "menu:saveas"),
            "settings" => emit_focused(app, "menu:settings"),
            "quit" => request_quit(app),
            _ => {}
        })
        .on_window_event(|window, event| {
            // When the last window closes, quit the app.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let app = window.app_handle();
                if app.webview_windows().is_empty() {
                    app.exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_document,
            save_document,
            path_exists,
            new_draft_path,
            discard_draft,
            list_drafts,
            new_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running foqus");
}
