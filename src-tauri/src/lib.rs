// foqus writer — Rust backend.
//
// Plain-text, file-over-app, never-lose-work. Documents are UTF-8 Markdown on
// disk, owned by the user. Rust handles all disk I/O with full filesystem access
// (it isn't bound by the JS permission scope), the native menu, multi-window, the
// "foqus notebook" vault, lightweight version history, and OS integration
// (default-editor + opening .md files).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

static WIN_SEQ: AtomicU32 = AtomicU32::new(1);
static DRAFT_SEQ: AtomicU32 = AtomicU32::new(0);

/// A file path handed to us at launch (double-click / `foqus file.md`), consumed
/// once by the first window that boots.
struct Launch(Mutex<Option<String>>);

// ── shared helpers ──────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled.md")
        .to_string()
}

fn is_text_ext(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|s| s.to_lowercase()).as_deref(),
        Some("md" | "markdown" | "mdown" | "txt" | "text")
    )
}

// FNV-1a hash → a stable per-path folder name for version history.
fn key_for(path: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

// ── documents ───────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct Document {
    path: String,
    name: String,
    content: String,
}

#[tauri::command]
fn read_document(path: String) -> Result<Document, String> {
    let content = fs::read_to_string(&path).map_err(|e| format!("Couldn't open file: {e}"))?;
    Ok(Document { name: file_name(&path), path, content })
}

/// Atomic save: write a sibling temp file, then rename over the target so a crash
/// mid-write can never corrupt existing words.
#[tauri::command]
fn save_document(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let dir = target.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
    let file = target.file_name().and_then(|s| s.to_str()).unwrap_or("untitled.md");
    let tmp = dir.join(format!(".{file}.foqus.tmp"));
    fs::write(&tmp, content.as_bytes()).map_err(|e| format!("Couldn't write: {e}"))?;
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Couldn't save: {e}")
    })
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

// ── drafts (crash-safe autosave target for untitled docs) ────────────────────

fn drafts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("drafts");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
fn new_draft_path(app: AppHandle) -> Result<String, String> {
    let dir = drafts_dir(&app)?;
    let seq = DRAFT_SEQ.fetch_add(1, Ordering::Relaxed);
    Ok(dir.join(format!("draft-{}-{}.md", now_ms(), seq)).to_string_lossy().to_string())
}

#[tauri::command]
fn discard_draft(app: AppHandle, path: String) -> Result<(), String> {
    let dir = drafts_dir(&app)?;
    let p = PathBuf::from(&path);
    if p.starts_with(&dir) && p.exists() {
        let _ = fs::remove_file(&p);
    }
    Ok(())
}

#[derive(Serialize)]
struct Draft {
    path: String,
    content: String,
    modified: u64,
}

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
                    let _ = fs::remove_file(&p);
                    continue;
                }
                let modified = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                out.push(Draft { path: p.to_string_lossy().to_string(), content, modified });
            }
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

// ── foqus notebook (an Obsidian-style vault folder) ──────────────────────────

#[derive(Serialize)]
struct TreeNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Option<Vec<TreeNode>>,
}

fn build_tree(p: &Path) -> Option<TreeNode> {
    let name = p.file_name().and_then(|s| s.to_str())?.to_string();
    if name.starts_with('.') {
        return None; // skip hidden files/folders (incl. our own metadata)
    }
    if p.is_dir() {
        let mut children: Vec<TreeNode> = Vec::new();
        if let Ok(rd) = fs::read_dir(p) {
            for e in rd.flatten() {
                if let Some(node) = build_tree(&e.path()) {
                    children.push(node);
                }
            }
        }
        children.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Some(TreeNode { name, path: p.to_string_lossy().to_string(), is_dir: true, children: Some(children) })
    } else if is_text_ext(p) {
        Some(TreeNode { name, path: p.to_string_lossy().to_string(), is_dir: false, children: None })
    } else {
        None
    }
}

#[tauri::command]
fn read_tree(path: String) -> Result<TreeNode, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("That folder doesn't exist.".into());
    }
    build_tree(&p).ok_or_else(|| "Couldn't read the notebook folder.".into())
}

/// A unique path inside `dir` for `base` (+ optional extension), e.g. "Untitled",
/// "Untitled 1", "Untitled 2"…
fn unique_path(dir: &Path, base: &str, ext: Option<&str>) -> PathBuf {
    let mk = |n: usize| -> PathBuf {
        let stem = if n == 0 { base.to_string() } else { format!("{base} {n}") };
        match ext {
            Some(e) => dir.join(format!("{stem}.{e}")),
            None => dir.join(stem),
        }
    };
    let mut n = 0;
    loop {
        let candidate = mk(n);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

#[tauri::command]
fn create_note(dir: String, name: Option<String>) -> Result<String, String> {
    let d = PathBuf::from(&dir);
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let base = name.unwrap_or_else(|| "Untitled".into());
    let path = unique_path(&d, &base, Some("md"));
    fs::write(&path, "").map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn create_folder(dir: String, name: Option<String>) -> Result<String, String> {
    let d = PathBuf::from(&dir);
    let base = name.unwrap_or_else(|| "New Folder".into());
    let path = unique_path(&d, &base, None);
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Rename/move a file or folder. `to` may be a new name in the same folder.
#[tauri::command]
fn rename_path(from: String, to: String) -> Result<String, String> {
    let from_p = PathBuf::from(&from);
    let to_p = PathBuf::from(&to);
    if to_p.exists() {
        return Err("A file with that name already exists.".into());
    }
    fs::rename(&from_p, &to_p).map_err(|e| e.to_string())?;
    Ok(to_p.to_string_lossy().to_string())
}

/// Move to the system trash — reversible, never a hard delete.
#[tauri::command]
fn trash_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| format!("Couldn't move to Trash: {e}"))
}

// ── images ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct ImportedImage {
    src: String, // what to write in the doc (relative to the doc, or absolute)
    abs: String, // absolute path, for immediate rendering
}

fn sanitize(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '-' })
        .collect();
    let t = out.trim().to_string();
    if t.is_empty() { "image".into() } else { t }
}

/// Where to keep images: an `assets/` folder beside the document (so they travel
/// with it), or the app data dir for an untitled draft.
fn asset_dir(app: &AppHandle, doc_path: &Option<String>) -> Result<(PathBuf, bool), String> {
    if let Some(dp) = doc_path {
        if let Some(parent) = Path::new(dp).parent() {
            let dir = parent.join("assets");
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            return Ok((dir, true));
        }
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("images");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok((dir, false))
}

/// Copy an image file that the user dropped into the doc's asset folder.
#[tauri::command]
fn import_image(app: AppHandle, source: String, doc_path: Option<String>) -> Result<ImportedImage, String> {
    let src_p = PathBuf::from(&source);
    let stem = src_p.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = src_p.extension().and_then(|s| s.to_str()).unwrap_or("png");
    let (dir, relative) = asset_dir(&app, &doc_path)?;
    let dest = unique_path(&dir, &sanitize(stem), Some(ext));
    fs::copy(&src_p, &dest).map_err(|e| format!("Couldn't copy image: {e}"))?;
    let abs = dest.to_string_lossy().to_string();
    let file = dest.file_name().and_then(|s| s.to_str()).unwrap_or("image").to_string();
    let src = if relative { format!("assets/{file}") } else { abs.clone() };
    Ok(ImportedImage { src, abs })
}

/// Save pasted image bytes (clipboard) into the doc's asset folder.
#[tauri::command]
fn save_image_bytes(app: AppHandle, bytes: Vec<u8>, ext: Option<String>, doc_path: Option<String>) -> Result<ImportedImage, String> {
    let (dir, relative) = asset_dir(&app, &doc_path)?;
    let e = ext.filter(|s| !s.is_empty()).unwrap_or_else(|| "png".into());
    let dest = unique_path(&dir, "pasted", Some(&e));
    fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    let abs = dest.to_string_lossy().to_string();
    let file = dest.file_name().and_then(|s| s.to_str()).unwrap_or("image").to_string();
    let src = if relative { format!("assets/{file}") } else { abs.clone() };
    Ok(ImportedImage { src, abs })
}

// ── version control (recoverable snapshots on save) ──────────────────────────

fn history_dir(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("history").join(key_for(path));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn version_ids(dir: &Path) -> Vec<u64> {
    let mut ids: Vec<u64> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) == Some("md") {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    if let Ok(id) = stem.parse::<u64>() {
                        ids.push(id);
                    }
                }
            }
        }
    }
    ids.sort_unstable();
    ids
}

/// Save a snapshot of `content` for `path` — but only if it differs from the most
/// recent snapshot. Keeps the last 200 versions.
#[tauri::command]
fn save_version(app: AppHandle, path: String, content: String) -> Result<(), String> {
    let dir = history_dir(&app, &path)?;
    let mut ids = version_ids(&dir);
    if let Some(&last) = ids.last() {
        if let Ok(prev) = fs::read_to_string(dir.join(format!("{last}.md"))) {
            if prev == content {
                return Ok(());
            }
        }
    }
    let id = now_ms();
    fs::write(dir.join(format!("{id}.md")), &content).map_err(|e| e.to_string())?;
    let src = dir.join("source.txt");
    if !src.exists() {
        let _ = fs::write(src, &path);
    }
    ids.push(id);
    if ids.len() > 200 {
        for old in &ids[..ids.len() - 200] {
            let _ = fs::remove_file(dir.join(format!("{old}.md")));
        }
    }
    Ok(())
}

#[derive(Serialize)]
struct Version {
    id: u64,
    size: u64,
}

#[tauri::command]
fn list_versions(app: AppHandle, path: String) -> Result<Vec<Version>, String> {
    let dir = history_dir(&app, &path)?;
    let mut out: Vec<Version> = version_ids(&dir)
        .into_iter()
        .map(|id| {
            let size = fs::metadata(dir.join(format!("{id}.md"))).map(|m| m.len()).unwrap_or(0);
            Version { id, size }
        })
        .collect();
    out.reverse(); // newest first
    Ok(out)
}

#[tauri::command]
fn read_version(app: AppHandle, path: String, id: u64) -> Result<String, String> {
    let dir = history_dir(&app, &path)?;
    fs::read_to_string(dir.join(format!("{id}.md"))).map_err(|e| e.to_string())
}

// ── OS integration ───────────────────────────────────────────────────────────

#[tauri::command]
fn os_platform() -> String {
    std::env::consts::OS.to_string() // "macos" | "windows" | "linux"
}

#[tauri::command]
fn take_launch_file(state: State<Launch>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

/// Best-effort: make foqus the default app for Markdown. Returns a friendly
/// message (Ok = done, Err = guidance the UI shows the user).
#[tauri::command]
fn set_default_md_editor() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        set_default_macos("com.foqus.writer")
    }
    #[cfg(target_os = "linux")]
    {
        let ok = std::process::Command::new("xdg-mime")
            .args(["default", "foqus.desktop", "text/markdown", "text/x-markdown", "text/plain"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            Ok("foqus is now your default for Markdown.".into())
        } else {
            Err("Couldn't set it automatically (is foqus installed as an app?).".into())
        }
    }
    #[cfg(target_os = "windows")]
    {
        Err("On Windows, open Settings → Apps → Default apps and choose foqus for .md files.".into())
    }
}

#[cfg(target_os = "macos")]
fn set_default_macos(bundle_id: &str) -> Result<String, String> {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSSetDefaultRoleHandlerForContentType(
            in_content_type: CFStringRef,
            in_role: u32,
            in_handler_bundle_id: CFStringRef,
        ) -> i32;
    }

    const K_LS_ROLES_ALL: u32 = 0xFFFF_FFFF;
    let bid = CFString::new(bundle_id);
    let mut all_ok = true;
    for uti in ["net.daringfireball.markdown", "public.markdown"] {
        let ct = CFString::new(uti);
        let status = unsafe {
            LSSetDefaultRoleHandlerForContentType(
                ct.as_concrete_TypeRef(),
                K_LS_ROLES_ALL,
                bid.as_concrete_TypeRef(),
            )
        };
        if status != 0 {
            all_ok = false;
        }
    }
    if all_ok {
        Ok("foqus is now your default Markdown editor.".into())
    } else {
        Err("Couldn't set it automatically. In Finder: right-click a .md file → Get Info → Open with → foqus → Change All.".into())
    }
}

// ── windows & menu ───────────────────────────────────────────────────────────

fn create_doc_window(app: &AppHandle) {
    let n = WIN_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("doc-{n}");
    let off = (n % 7) as f64 * 28.0;
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("foqus")
        .inner_size(1000.0, 720.0)
        .min_inner_size(480.0, 420.0)
        .position(150.0 + off, 120.0 + off);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    let _ = builder.build();
}

#[tauri::command]
fn new_window(app: AppHandle) {
    create_doc_window(&app);
}

fn emit_focused(app: &AppHandle, event: &str) {
    for (_, w) in app.webview_windows() {
        if w.is_focused().unwrap_or(false) {
            let _ = w.emit(event, ());
            return;
        }
    }
}

/// Quit: close every window through the normal save flow, then exit when the last
/// one is gone (handled in on_window_event).
fn request_quit(app: &AppHandle) {
    if app.webview_windows().is_empty() {
        app.exit(0);
        return;
    }
    for (_, w) in app.webview_windows() {
        let _ = w.close();
    }
}

fn initial_launch_file() -> Option<String> {
    std::env::args().skip(1).find(|a| {
        let p = Path::new(a);
        p.is_file() && is_text_ext(p)
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(Launch(Mutex::new(initial_launch_file())))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let h = app.handle();

            // Frameless custom chrome on Windows/Linux (macOS uses the Overlay style).
            #[cfg(not(target_os = "macos"))]
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.set_decorations(false);
            }

            let settings_i = MenuItemBuilder::with_id("settings", "Settings…").accelerator("CmdOrCtrl+,").build(h)?;
            let quit_i = MenuItemBuilder::with_id("quit", "Quit foqus").accelerator("CmdOrCtrl+Q").build(h)?;
            let app_menu = SubmenuBuilder::new(h, "foqus")
                .about(Some(AboutMetadata { name: Some("foqus".into()), ..Default::default() }))
                .separator()
                .item(&settings_i)
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .item(&quit_i)
                .build()?;

            let new_i = MenuItemBuilder::with_id("new", "New").accelerator("CmdOrCtrl+N").build(h)?;
            let open_i = MenuItemBuilder::with_id("open", "Open…").accelerator("CmdOrCtrl+O").build(h)?;
            let save_i = MenuItemBuilder::with_id("save", "Save").accelerator("CmdOrCtrl+S").build(h)?;
            let saveas_i = MenuItemBuilder::with_id("saveas", "Save As…").accelerator("CmdOrCtrl+Shift+S").build(h)?;
            let history_i = MenuItemBuilder::with_id("history", "Version History…").accelerator("CmdOrCtrl+Shift+H").build(h)?;
            let file_menu = SubmenuBuilder::new(h, "File")
                .item(&new_i)
                .item(&open_i)
                .separator()
                .item(&save_i)
                .item(&saveas_i)
                .separator()
                .item(&history_i)
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

            let menu = MenuBuilder::new(h).items(&[&app_menu, &file_menu, &edit_menu]).build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "new" => create_doc_window(app),
            "open" => emit_focused(app, "menu:open"),
            "save" => emit_focused(app, "menu:save"),
            "saveas" => emit_focused(app, "menu:saveas"),
            "history" => emit_focused(app, "menu:history"),
            "settings" => emit_focused(app, "menu:settings"),
            "quit" => request_quit(app),
            _ => {}
        })
        .on_window_event(|window, event| {
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
            read_tree,
            create_note,
            create_folder,
            rename_path,
            trash_path,
            import_image,
            save_image_bytes,
            save_version,
            list_versions,
            read_version,
            os_platform,
            take_launch_file,
            set_default_md_editor,
            new_window
        ])
        .build(tauri::generate_context!())
        .expect("error while building foqus");

    app.run(|_app_handle, _event| {
        // Files opened from Finder / "Open With" arrive here — macOS only.
        // (RunEvent::Opened doesn't exist on Windows/Linux, so it's cfg-gated.)
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            for url in urls {
                if let Ok(p) = url.to_file_path() {
                    let path = p.to_string_lossy().to_string();
                    let mut delivered = false;
                    for (_, w) in _app_handle.webview_windows() {
                        if w.is_focused().unwrap_or(false) {
                            let _ = w.emit("open-file", path.clone());
                            delivered = true;
                            break;
                        }
                    }
                    if !delivered {
                        if let Some(state) = _app_handle.try_state::<Launch>() {
                            *state.0.lock().unwrap() = Some(path.clone());
                        }
                        if _app_handle.webview_windows().is_empty() {
                            create_doc_window(_app_handle);
                        }
                    }
                }
            }
        }
    });
}
