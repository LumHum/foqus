// foqus writer — app wiring.
//
// Connects everything around the saving model:
//   • Write instantly; autosave continuously (toggle-able) — titled docs → their
//     file, untitled docs → a crash-safe draft. With the notebook on, new docs
//     become files in the notebook folder automatically.
//   • Choose a location only at a boundary (close / open / quit) when there's no
//     home yet — via the "Save your work?" dialog.
//   • Every save records a recoverable version (Version History, ⌘⇧H).
//   • File ▸ New (⌘N) opens a new window; two files can be open at once.

import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { importImage, saveImageBytes, resolveImageUrl, buildImgTag, isImageFile, IMAGE_EXTS } from "./lib/images";
import { createEditor, type EditorAPI } from "./editor";
import * as settings from "./lib/settings";
import type { FocusMode, FontName, Settings, ThemeName } from "./lib/settings";
import * as files from "./lib/files";
import type { Doc } from "./lib/files";
import * as nb from "./lib/notebook";
import { saveVersion } from "./lib/versions";
import { isTauri } from "./lib/env";
import { osPlatform, windowControls } from "./lib/platform";
import * as sound from "./lib/sound";
import { CommandPalette, type Command } from "./ui/commandPalette";
import { SettingsPanel } from "./ui/settingsPanel";
import { Sidebar } from "./ui/sidebar";
import { MomentumRing } from "./ui/momentumRing";
import { HistoryPanel } from "./ui/historyPanel";
import { celebrate } from "./ui/celebrate";
import { confirmSave } from "./ui/confirmDialog";
import { runOnboarding } from "./ui/onboarding";
import { checkForUpdate, installUpdate } from "./lib/updater";
import { UpdateBanner } from "./ui/updateBanner";

const WELCOME = `# Welcome to foqus

You're looking at a writing surface that tries to *disappear*. Just type — your
words autosave the instant you write them, safely, as a plain Markdown file.

## A few things to try

- Press **⌘N** for a new page in its own window — keep two pieces open at once.
- Press **⌘K** for everything foqus can do, or **⌘⇧H** for version history.
- Hit **⌘⇧F** to cycle **Focus mode**; **⌘⇧T** for typewriter scrolling.
- Turn on the **foqus notebook** in Settings (**⌘,**) to keep all your writing in
  one tidy folder.

> Your words live as a plain \`.md\` file you own. foqus never locks them away.

Clear this out, and begin.
`;

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}
function deriveName(text: string): string {
  const first = text.split("\n").find((l) => l.trim());
  if (!first) return "Untitled";
  return first.replace(/^#{1,6}\s*/, "").replace(/[*_`>#]/g, "").trim().slice(0, 60) || "Untitled";
}

async function boot() {
  const s = await settings.initSettings();

  applyTheme(s.theme);
  applyTypography(s);
  sound.setSoundEnabled(s.sound);
  sound.setSoundVolume(s.soundVolume);

  const app = document.getElementById("app")!;
  const editorHost = document.getElementById("editor")!;
  const docNameEl = document.getElementById("doc-name")!;
  const statusPathEl = document.getElementById("status-path")!;
  const wordcountEl = document.getElementById("wordcount")!;
  const streakEl = document.getElementById("streak")!;
  const streakNEl = document.getElementById("streak-n")!;
  const ringMount = document.getElementById("ring-mount")!;

  // ── platform chrome ──
  const os = await osPlatform();
  app.setAttribute("data-os", os);
  if (os === "windows" || os === "linux") {
    const wc = document.getElementById("win-controls")!;
    wc.hidden = false;
    document.getElementById("win-min")!.addEventListener("click", () => void windowControls.minimize());
    document.getElementById("win-max")!.addEventListener("click", () => void windowControls.toggleMaximize());
    document.getElementById("win-close")!.addEventListener("click", () => void windowControls.close());
  }

  // ── state ──
  let doc: Doc = files.newDoc();
  let dirty = false;
  let pristine = false; // the unedited welcome doc — never autosaved or prompted
  let lastWordCount = 0;
  let recordedToday = false;
  let goalCelebrated = settings.getWordsToday() >= s.dailyGoal && s.dailyGoal > 0;
  let autosaveTimer: number | undefined;

  const ring = new MomentumRing(() => onGoalReached());
  ringMount.appendChild(ring.el);

  const editor: EditorAPI = createEditor({
    parent: editorHost,
    doc: "",
    placeholder: "Begin writing…",
    accessors: {
      focus: () => settings.get().focusMode,
      live: () => ({ hideSyntax: settings.get().hideSyntax }),
      typewriter: () => settings.get().typewriter,
    },
    onChange: (text) => onDocChange(text),
    resolveImageSrc: (src) => resolveImageUrl(src, doc.path),
  });

  // ── images: paste from clipboard ──
  editor.view.contentDOM.addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        e.preventDefault();
        const file = it.getAsFile();
        if (!file) continue;
        const buf = new Uint8Array(await file.arrayBuffer());
        const imp = await saveImageBytes(Array.from(buf), it.type.split("/")[1] || "png", doc.path);
        if (imp) editor.insertImage(buildImgTag(imp.src, "pasted image", "center"));
        return;
      }
    }
  });

  async function insertImageFromDisk() {
    if (!isTauri()) {
      flashStatus("Drag an image in, or use the desktop app");
      return;
    }
    const sel = await openFileDialog({ multiple: true, filters: [{ name: "Images", extensions: IMAGE_EXTS }] });
    const paths = Array.isArray(sel) ? sel : sel ? [sel] : [];
    for (const p of paths) {
      const imp = await importImage(p as string, doc.path);
      if (imp) editor.insertImage(buildImgTag(imp.src, fileLabel(p as string), "center"));
    }
  }
  function fileLabel(p: string): string {
    return (p.split(/[\\/]/).pop() ?? "image").replace(/\.[^.]+$/, "");
  }

  const sidebar = new Sidebar({
    getNotebookPath: () => (settings.get().notebookEnabled ? settings.get().notebookPath : null),
    getActivePath: () => doc.path,
    onOpenFile: (p) => void openPath(p),
    onRenamed: (_old, np) => {
      doc = { ...doc, path: np, name: nb.baseName(np) };
      settings.set("lastPath", np);
      refreshTitle();
      refreshStatus();
    },
    onTrashed: (p) => {
      if (doc.path === p) setDoc(files.newDoc(), "");
    },
  });
  document.getElementById("sidebar-slot")!.appendChild(sidebar.el);

  const panel = new SettingsPanel({
    get: settings.get,
    onChange: (p) => applyPatch(p),
    onPickNotebook: () => void pickNotebook(),
    onMakeDefaultEditor: () => void makeDefaultEditor(),
  });
  const palette = new CommandPalette(() => buildCommands());
  const history = new HistoryPanel({
    getActivePath: () => doc.path ?? doc.draftPath,
    getCurrentContent: () => editor.getText(),
    onRestore: (content) => void restoreVersion(content),
  });
  const updateBanner = new UpdateBanner();

  async function runUpdateCheck(manual = false) {
    if (!isTauri()) {
      if (manual) flashStatus("Updates aren't available in the browser");
      return;
    }
    const update = await checkForUpdate();
    if (update) {
      updateBanner.show(update.version, () => void installUpdate(update, (p) => updateBanner.setProgress(p)));
    } else if (manual) {
      flashStatus("foqus is up to date");
    }
  }

  // ── theme / typography ──
  function applyTheme(name: ThemeName) {
    document.documentElement.setAttribute("data-theme", name);
    try {
      localStorage.setItem("foqus.theme", name);
    } catch {
      /* private mode — non-fatal */
    }
  }
  function applyTypography(cfg: Pick<Settings, "font" | "fontSize" | "lineHeight" | "measure">) {
    const fonts: Record<FontName, string> = { mono: "var(--mono)", serif: "var(--serif)", sans: "var(--sans)" };
    const root = document.documentElement.style;
    root.setProperty("--editor-font", fonts[cfg.font]);
    root.setProperty("--editor-font-size", `${cfg.fontSize}px`);
    root.setProperty("--editor-line-height", String(cfg.lineHeight));
    root.setProperty("--measure", `${cfg.measure}ch`);
  }

  // ── document display ──
  function displayName(): string {
    return doc.path ? doc.name : deriveName(doc.content);
  }
  function refreshTitle() {
    const name = displayName();
    docNameEl.textContent = name;
    document.title = name === "Untitled" ? "foqus" : `${name} — foqus`;
    if (isTauri()) getCurrentWindow().setTitle(name || "foqus").catch(() => {});
  }
  function refreshStatus() {
    statusPathEl.textContent = doc.path
      ? doc.path
      : doc.content.trim()
      ? "Draft · autosaved"
      : "Not yet saved";
  }
  function markDirty() {
    if (!dirty) {
      dirty = true;
      app.classList.add("is-dirty");
    }
  }
  function markClean() {
    dirty = false;
    app.classList.remove("is-dirty");
    refreshStatus();
  }

  function setDoc(next: Doc, text: string, isPristine = false) {
    clearTimeout(autosaveTimer);
    doc = { ...next, content: text };
    pristine = isPristine;
    editor.loadDoc(text);
    dirty = false;
    app.classList.remove("is-dirty");
    lastWordCount = wordCount(text);
    wordcountEl.textContent = `${lastWordCount} word${lastWordCount === 1 ? "" : "s"}`;
    refreshTitle();
    refreshStatus();
    sidebar.setActive();
  }

  function onDocChange(text: string) {
    pristine = false;
    doc.content = text;
    const wc = wordCount(text);
    const added = Math.max(0, wc - lastWordCount);
    lastWordCount = wc;
    wordcountEl.textContent = `${wc} word${wc === 1 ? "" : "s"}`;
    markDirty();
    refreshTitle();
    immerse();
    if (added > 0) {
      const total = settings.addWordsToday(added);
      ring.set(total, settings.get().dailyGoal);
      maybeRecordDay(total);
    }
    scheduleAutosave();
  }

  // ── saving ──
  function snapshot(path: string | null, text: string) {
    if (path && settings.get().versionControl) void saveVersion(path, text);
  }
  function defaultDir(): string | undefined {
    const cur = settings.get();
    return cur.notebookEnabled && cur.notebookPath ? cur.notebookPath : undefined;
  }
  /** Turn an untitled doc into a real file inside the notebook (named from its
   *  first line). Used when the notebook is on — no "where?" prompt needed. */
  async function homeInNotebook(text: string): Promise<boolean> {
    const dir = settings.get().notebookPath;
    if (!dir) return false;
    const p = await nb.createNote(dir, deriveName(text) || "Untitled");
    if (!p) return false;
    await files.saveToPath(p, text);
    await files.discardDraft(doc.draftPath);
    doc = { path: p, draftPath: null, name: nb.baseName(p), content: text };
    settings.set("lastPath", p);
    snapshot(p, text);
    refreshTitle();
    markClean();
    void sidebar.refresh();
    return true;
  }

  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    if (pristine || !settings.get().autosave) return;
    autosaveTimer = window.setTimeout(() => void flush(), 500);
  }
  async function flush() {
    if (pristine || !settings.get().autosave) return;
    const text = editor.getText();
    doc.content = text;
    if (doc.path) {
      await files.saveToPath(doc.path, text);
      snapshot(doc.path, text);
      markClean();
      return;
    }
    if (!text.trim()) {
      markClean();
      return;
    }
    if (settings.get().notebookEnabled && settings.get().notebookPath) {
      await homeInNotebook(text);
      return;
    }
    if (!doc.draftPath) doc.draftPath = await files.newDraftPath();
    if (doc.draftPath) {
      await files.saveToPath(doc.draftPath, text);
      snapshot(doc.draftPath, text);
    }
    markClean();
  }

  // finalize at a boundary (close / open). Returns "ok" or "cancel".
  async function finalize(): Promise<"ok" | "cancel"> {
    clearTimeout(autosaveTimer);
    const text = editor.getText();
    doc.content = text;
    if (pristine) return "ok";
    if (doc.path) {
      await files.saveToPath(doc.path, text);
      snapshot(doc.path, text);
      return "ok";
    }
    if (!text.trim()) {
      await files.discardDraft(doc.draftPath);
      return "ok";
    }
    if (settings.get().notebookEnabled && settings.get().notebookPath) {
      await homeInNotebook(text);
      return "ok";
    }
    const choice = await confirmSave(deriveName(text));
    if (choice === "cancel") return "cancel";
    if (choice === "discard") {
      await files.discardDraft(doc.draftPath);
      return "ok";
    }
    const saved = await files.saveAs(text, deriveName(text), defaultDir());
    if (!saved) return "cancel";
    await files.discardDraft(doc.draftPath);
    doc = saved;
    settings.set("lastPath", saved.path!);
    snapshot(saved.path!, text);
    refreshTitle();
    markClean();
    void sidebar.refresh();
    return "ok";
  }

  async function saveExplicit() {
    clearTimeout(autosaveTimer);
    pristine = false;
    const text = editor.getText();
    doc.content = text;
    if (doc.path) {
      await files.saveToPath(doc.path, text);
      snapshot(doc.path, text);
      markClean();
      flashStatus("Saved");
      return;
    }
    if (!text.trim()) return;
    if (settings.get().notebookEnabled && settings.get().notebookPath) {
      await homeInNotebook(text);
      flashStatus("Saved");
      return;
    }
    const saved = await files.saveAs(text, deriveName(text), defaultDir());
    if (!saved) return;
    await files.discardDraft(doc.draftPath);
    doc = saved;
    settings.set("lastPath", saved.path!);
    snapshot(saved.path!, text);
    refreshTitle();
    markClean();
    flashStatus("Saved");
    void sidebar.refresh();
  }
  async function saveAsExplicit() {
    pristine = false;
    const text = editor.getText();
    const wasUntitled = !doc.path;
    const saved = await files.saveAs(text, doc.path ? doc.name : deriveName(text), defaultDir());
    if (!saved) return;
    if (wasUntitled) await files.discardDraft(doc.draftPath);
    doc = saved;
    settings.set("lastPath", saved.path!);
    snapshot(saved.path!, text);
    refreshTitle();
    markClean();
    flashStatus("Saved");
    void sidebar.refresh();
  }

  async function openFile() {
    if ((await finalize()) === "cancel") return;
    const opened = await files.openDocument();
    if (opened) {
      setDoc(opened, opened.content);
      if (opened.path) settings.set("lastPath", opened.path);
    }
  }
  async function openPath(path: string) {
    if (doc.path === path) return;
    if ((await finalize()) === "cancel") return;
    const d = await files.readPath(path);
    if (d) {
      setDoc(d, d.content);
      settings.set("lastPath", path);
    }
  }
  function newFile() {
    void files.newWindow();
  }

  // ── version control ──
  async function restoreVersion(content: string) {
    const key = doc.path ?? doc.draftPath;
    if (key && settings.get().versionControl) await saveVersion(key, editor.getText()); // keep current recoverable
    editor.loadDoc(content);
    doc.content = content;
    lastWordCount = wordCount(content);
    wordcountEl.textContent = `${lastWordCount} word${lastWordCount === 1 ? "" : "s"}`;
    pristine = false;
    if (doc.path) {
      await files.saveToPath(doc.path, content);
      snapshot(doc.path, content);
    } else if (doc.draftPath) {
      await files.saveToPath(doc.draftPath, content);
      snapshot(doc.draftPath, content);
    }
    markClean();
    refreshTitle();
    flashStatus("Restored");
  }

  // ── momentum / streak ──
  function maybeRecordDay(total: number) {
    if (!recordedToday && total >= 5) {
      recordedToday = true;
      const r = settings.recordWritingDay(0);
      renderStreak(r.streak);
      if (r.isMilestone) {
        celebrate(1.2);
        sound.success();
      }
    }
  }
  function onGoalReached() {
    const goal = settings.get().dailyGoal;
    if (goal <= 0 || goalCelebrated) return;
    goalCelebrated = true;
    ring.celebrate();
    celebrate(1);
    sound.success();
    flashStatus("Daily goal reached ✶");
  }
  function renderStreak(n: number) {
    if (n > 1) {
      streakEl.hidden = false;
      streakNEl.textContent = String(n);
    } else {
      streakEl.hidden = true;
    }
  }

  // ── settings changes ──
  function applyPatch(p: Partial<Settings>) {
    settings.patch(p);
    if (p.theme) applyTheme(p.theme);
    if (p.font || p.fontSize !== undefined || p.lineHeight !== undefined || p.measure !== undefined) {
      applyTypography(settings.get());
    }
    if (p.focusMode !== undefined) {
      editor.refreshFocus();
      syncButtons();
    }
    if (p.hideSyntax !== undefined) editor.refreshLive();
    if (p.typewriter !== undefined) {
      editor.setTypewriter(p.typewriter);
      syncButtons();
    }
    if (p.sound !== undefined) {
      sound.setSoundEnabled(p.sound);
      if (p.sound) sound.click();
    }
    if (p.soundVolume !== undefined) sound.setSoundVolume(p.soundVolume);
    if (p.autosave === true) void flush();
    if (p.dailyGoal !== undefined) {
      goalCelebrated = settings.getWordsToday() >= p.dailyGoal && p.dailyGoal > 0;
      ring.set(settings.getWordsToday(), p.dailyGoal);
    }
    if (p.notebookEnabled !== undefined) {
      if (p.notebookEnabled && !settings.get().notebookPath) {
        void pickNotebook();
      } else {
        updateLayout();
        void sidebar.refresh();
        panel.refresh();
      }
    }
    if (p.sidebarOpen !== undefined) updateLayout();
  }

  async function pickNotebook() {
    const path = await nb.pickNotebookFolder();
    if (path) {
      settings.patch({ notebookPath: path, notebookEnabled: true, sidebarOpen: true });
    } else if (!settings.get().notebookPath) {
      settings.set("notebookEnabled", false);
    }
    updateLayout();
    await sidebar.refresh();
    panel.refresh();
  }
  async function makeDefaultEditor() {
    try {
      const msg = await invoke<string>("set_default_md_editor");
      flashStatus(msg.length > 44 ? "Set as default ✓" : msg);
    } catch (e) {
      flashStatus(String(e).slice(0, 56));
    }
  }

  function syncButtons() {
    const cur = settings.get();
    document.getElementById("btn-focus")!.classList.toggle("is-on", cur.focusMode !== "off");
    document.getElementById("btn-typewriter")!.classList.toggle("is-on", cur.typewriter);
  }
  function updateLayout() {
    const cur = settings.get();
    const hasNotebook = cur.notebookEnabled && !!cur.notebookPath;
    app.classList.toggle("has-sidebar", hasNotebook && cur.sidebarOpen);
    const btn = document.getElementById("btn-sidebar")!;
    btn.hidden = !hasNotebook;
    btn.classList.toggle("is-on", cur.sidebarOpen);
  }

  let flashTimer: number | undefined;
  function flashStatus(msg: string) {
    statusPathEl.textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(refreshStatus, 1500);
  }

  // ── calm auto-hiding chrome ──
  let chromeTimer: number | undefined;
  function showChrome() {
    app.classList.add("chrome-visible");
    clearTimeout(chromeTimer);
    chromeTimer = window.setTimeout(() => {
      if (!panel.isOpen() && !palette.isOpen() && !history.isOpen()) app.classList.remove("chrome-visible");
    }, 2400);
  }
  function immerse() {
    clearTimeout(chromeTimer);
    if (!panel.isOpen() && !palette.isOpen() && !history.isOpen()) app.classList.remove("chrome-visible");
  }
  window.addEventListener("mousemove", showChrome, { passive: true });

  // ── command palette ──
  function buildCommands(): Command[] {
    const cur = settings.get();
    const cmds: Command[] = [
      { id: "new", title: "New page", hint: "new window", shortcut: "⌘N", run: () => newFile() },
      { id: "open", title: "Open…", shortcut: "⌘O", run: () => void openFile() },
      { id: "save", title: "Save", shortcut: "⌘S", run: () => void saveExplicit() },
      { id: "saveas", title: "Save As…", shortcut: "⌘⇧S", run: () => void saveAsExplicit() },
      { id: "image", title: "Insert image…", keywords: "picture photo drag drop", run: () => void insertImageFromDisk() },
      { id: "history", title: "Version history…", shortcut: "⌘⇧H", keywords: "versions revert diff", run: () => void history.show() },
      { id: "notebook", title: `foqus notebook: ${cur.notebookEnabled ? "On" : "Off"}`, keywords: "vault folder", run: () => applyPatch({ notebookEnabled: !cur.notebookEnabled }) },
      { id: "autosave", title: `Autosave: ${cur.autosave ? "On" : "Off"}`, keywords: "save", run: () => applyPatch({ autosave: !cur.autosave }) },
      { id: "default", title: "Make foqus the default Markdown editor", keywords: "open with", run: () => void makeDefaultEditor() },
      { id: "update", title: "Check for updates…", keywords: "upgrade version new", run: () => void runUpdateCheck(true) },
      { id: "focus-off", title: "Focus: Off", keywords: "focus mode", run: () => applyPatch({ focusMode: "off" }) },
      { id: "focus-sentence", title: "Focus: Sentence", keywords: "focus mode", run: () => applyPatch({ focusMode: "sentence" }) },
      { id: "focus-paragraph", title: "Focus: Paragraph", keywords: "focus mode", run: () => applyPatch({ focusMode: "paragraph" }) },
      { id: "typewriter", title: `Typewriter scrolling: ${cur.typewriter ? "On" : "Off"}`, shortcut: "⌘⇧T", run: () => applyPatch({ typewriter: !cur.typewriter }) },
      { id: "syntax", title: `Hide Markdown syntax: ${cur.hideSyntax ? "On" : "Off"}`, run: () => applyPatch({ hideSyntax: !cur.hideSyntax }) },
      { id: "sound", title: `Typing sound: ${cur.sound ? "On" : "Off"}`, run: () => applyPatch({ sound: !cur.sound }) },
      { id: "settings", title: "Open Settings…", shortcut: "⌘,", run: () => panel.show() },
    ];
    (["paper", "night", "sepia", "ink"] as ThemeName[]).forEach((t) =>
      cmds.push({ id: `theme-${t}`, title: `Theme: ${t[0].toUpperCase()}${t.slice(1)}`, keywords: "appearance color", run: () => applyPatch({ theme: t }) })
    );
    (["mono", "serif", "sans"] as FontName[]).forEach((f) =>
      cmds.push({ id: `font-${f}`, title: `Typeface: ${f[0].toUpperCase()}${f.slice(1)}`, keywords: "font typography", run: () => applyPatch({ font: f }) })
    );
    return cmds;
  }

  // ── titlebar buttons ──
  const onClick = (sel: string, fn: () => void) =>
    document.getElementById(sel)!.addEventListener("click", () => {
      sound.click();
      fn();
    });
  onClick("btn-sidebar", () => applyPatch({ sidebarOpen: !settings.get().sidebarOpen }));
  onClick("btn-focus", () => cycleFocus());
  onClick("btn-typewriter", () => applyPatch({ typewriter: !settings.get().typewriter }));
  onClick("btn-history", () => void history.show());
  onClick("btn-theme", () => cycleTheme());
  onClick("btn-cmd", () => palette.toggle());
  onClick("btn-settings", () => panel.toggle());

  function cycleFocus() {
    const order: FocusMode[] = ["off", "sentence", "paragraph"];
    const next = order[(order.indexOf(settings.get().focusMode) + 1) % order.length];
    applyPatch({ focusMode: next });
    flashStatus(`Focus: ${next}`);
  }
  function cycleTheme() {
    const order: ThemeName[] = ["paper", "night", "sepia", "ink"];
    const next = order[(order.indexOf(settings.get().theme) + 1) % order.length];
    applyPatch({ theme: next });
  }

  // ── keyboard (File/Edit/Settings accelerators are owned by the native menu) ──
  window.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") {
      if (palette.isOpen() || history.isOpen()) return;
      if (panel.isOpen()) {
        panel.close();
        return;
      }
    }
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "k") {
      e.preventDefault();
      palette.toggle();
    } else if (k === "h" && e.shiftKey) {
      e.preventDefault();
      void history.show();
    } else if (k === "f" && e.shiftKey) {
      e.preventDefault();
      cycleFocus();
    } else if (k === "t" && e.shiftKey) {
      e.preventDefault();
      applyPatch({ typewriter: !settings.get().typewriter });
    } else if (k === "l" && e.shiftKey) {
      e.preventDefault();
      cycleTheme();
    } else if (!isTauri()) {
      // Browser dev has no native menu — keep file shortcuts working.
      if (k === "n" && !e.shiftKey) (e.preventDefault(), newFile());
      else if (k === "o" && !e.shiftKey) (e.preventDefault(), void openFile());
      else if (k === "s" && !e.shiftKey) (e.preventDefault(), void saveExplicit());
      else if (k === "s" && e.shiftKey) (e.preventDefault(), void saveAsExplicit());
      else if (k === ",") (e.preventDefault(), panel.toggle());
    }
  });

  // ── native window + menu + file-open wiring ──
  if (isTauri()) {
    const w = getCurrentWindow();
    w.onCloseRequested(async (event) => {
      event.preventDefault();
      const r = await finalize();
      if (r !== "cancel") await w.destroy();
    });
    listen("menu:open", () => void openFile());
    listen("menu:save", () => void saveExplicit());
    listen("menu:saveas", () => void saveAsExplicit());
    listen("menu:history", () => void history.show());
    listen("menu:settings", () => panel.toggle());
    listen<string>("open-file", (e) => {
      if (e.payload) void openPath(e.payload);
    });

    // Drop image files anywhere on the page — they land where you dropped them.
    getCurrentWebview().onDragDropEvent(async (e) => {
      if (e.payload.type !== "drop") return;
      const imgs = e.payload.paths.filter(isImageFile);
      if (!imgs.length) return;
      const dpr = window.devicePixelRatio || 1;
      let at =
        editor.view.posAtCoords({ x: e.payload.position.x / dpr, y: e.payload.position.y / dpr }) ??
        editor.view.state.selection.main.head;
      for (const p of imgs) {
        const imp = await importImage(p, doc.path);
        if (imp) {
          editor.insertImage(buildImgTag(imp.src, fileLabel(p), "center"), at);
          at = editor.view.state.selection.main.head;
        }
      }
    });
  }

  // ── initial state ──
  ring.reset(settings.getWordsToday(), s.dailyGoal);
  renderStreak(s.streak);
  syncButtons();
  updateLayout();
  editor.setTypewriter(s.typewriter);
  void sidebar.refresh();

  // First-run onboarding (main window only) — offers notebook, history, default.
  if (isTauri() && !settings.get().onboarded && getCurrentWindow().label === "main") {
    const res = await runOnboarding({
      pickFolder: () => nb.pickNotebookFolder(),
      setDefaultEditor: () => invoke<string>("set_default_md_editor"),
    });
    const patch: Partial<Settings> = { onboarded: true, versionControl: res.versionControl };
    if (res.notebookPath) {
      patch.notebookEnabled = true;
      patch.notebookPath = res.notebookPath;
      patch.sidebarOpen = true;
    }
    settings.patch(patch);
    updateLayout();
    await sidebar.refresh();
  }

  // Load the initial document.
  let launchFile: string | null = null;
  if (isTauri()) {
    try {
      launchFile = await invoke<string | null>("take_launch_file");
    } catch {
      /* ignore */
    }
  }
  const label = isTauri() ? getCurrentWindow().label : "main";
  if (launchFile) {
    const d = await files.readPath(launchFile);
    if (d) setDoc(d, d.content);
    else setDoc(files.newDoc(), WELCOME, true);
  } else if (label === "main") {
    const drafts = await files.listDrafts();
    if (drafts.length) {
      const d = drafts[0];
      setDoc({ path: null, draftPath: d.path, name: deriveName(d.content), content: d.content }, d.content);
    } else if (s.lastPath) {
      const last = await files.readPath(s.lastPath);
      if (last) setDoc(last, last.content);
      else setDoc(files.newDoc(), WELCOME, true);
    } else {
      setDoc(files.newDoc(), WELCOME, true);
    }
  } else {
    setDoc(files.newDoc(), "");
  }
  editor.focus();
  showChrome();

  // Quietly check for an update a few seconds after launch (main window only).
  if (isTauri() && label === "main" && settings.get().autoUpdate) {
    window.setTimeout(() => void runUpdateCheck(), 3000);
  }
}

boot();
