// foqus writer — app wiring.
//
// Boots settings, builds the editor, and connects everything. The saving model
// is the heart of this file:
//   • Write instantly into a new untitled doc — no upfront dialog (protect flow).
//   • Autosave continuously: titled docs → their file; untitled docs → a crash-
//     safe draft file (never lose work).
//   • Choose a location only at a boundary — closing the window or opening another
//     file — via the tactile "Save your work?" prompt.
//   • File ▸ New (⌘N) opens a new window; two files can be open in two windows.

import "./styles.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { createEditor, type EditorAPI } from "./editor";
import * as settings from "./lib/settings";
import type { FontName, Settings, ThemeName } from "./lib/settings";
import type { FocusMode } from "./lib/settings";
import * as files from "./lib/files";
import type { Doc } from "./lib/files";
import { isTauri } from "./lib/env";
import * as sound from "./lib/sound";
import { CommandPalette, type Command } from "./ui/commandPalette";
import { SettingsPanel } from "./ui/settingsPanel";
import { MomentumRing } from "./ui/momentumRing";
import { celebrate } from "./ui/celebrate";
import { confirmSave } from "./ui/confirmDialog";

const WELCOME = `# Welcome to foqus

You're looking at a writing surface that tries to *disappear*. Just type — your
words autosave the instant you write them, safely, as a plain Markdown file.

## A few things to try

- Press **⌘N** for a new page in its own window — keep two pieces open at once.
- Press **⌘K** for everything foqus can do.
- Hit **⌘⇧F** to cycle **Focus mode**; **⌘⇧T** for typewriter scrolling.
- You'll only be asked *where* to keep a piece when you close its window or open
  another file. Until then, write freely.

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
  });

  const panel = new SettingsPanel({ get: settings.get, onChange: (p) => applyPatch(p) });
  const palette = new CommandPalette(() => buildCommands());

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

  // ── autosave (continuous; untitled → draft, titled → file) ──
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    if (pristine) return;
    autosaveTimer = window.setTimeout(() => void flush(), 500);
  }
  async function flush() {
    if (pristine) return;
    const text = editor.getText();
    doc.content = text;
    if (doc.path) {
      await files.saveToPath(doc.path, text);
      markClean();
      return;
    }
    if (!text.trim()) {
      markClean();
      return;
    }
    if (!doc.draftPath) doc.draftPath = await files.newDraftPath();
    if (doc.draftPath) await files.saveToPath(doc.draftPath, text);
    markClean();
  }

  // ── finalize: called when closing / opening another file ──
  // Returns "ok" to proceed, "cancel" to abort (stay).
  async function finalize(): Promise<"ok" | "cancel"> {
    clearTimeout(autosaveTimer);
    const text = editor.getText();
    doc.content = text;

    if (pristine) return "ok"; // unedited welcome — nothing to keep
    if (doc.path) {
      await files.saveToPath(doc.path, text);
      return "ok";
    }
    if (!text.trim()) {
      await files.discardDraft(doc.draftPath);
      return "ok";
    }

    const choice = await confirmSave(deriveName(text));
    if (choice === "cancel") return "cancel";
    if (choice === "discard") {
      await files.discardDraft(doc.draftPath);
      return "ok";
    }
    // save → native location picker
    const saved = await files.saveAs(text, deriveName(text));
    if (!saved) return "cancel"; // user cancelled the picker → don't close
    await files.discardDraft(doc.draftPath);
    doc = saved;
    settings.set("lastPath", saved.path!);
    refreshTitle();
    markClean();
    return "ok";
  }

  // ── explicit Save / Save As (⌘S / ⌘⇧S, also from menu) ──
  async function saveExplicit() {
    clearTimeout(autosaveTimer);
    pristine = false;
    const text = editor.getText();
    doc.content = text;
    if (doc.path) {
      await files.saveToPath(doc.path, text);
      markClean();
      flashStatus("Saved");
      return;
    }
    if (!text.trim()) return;
    const saved = await files.saveAs(text, deriveName(text));
    if (!saved) return;
    await files.discardDraft(doc.draftPath);
    doc = saved;
    settings.set("lastPath", saved.path!);
    refreshTitle();
    markClean();
    flashStatus("Saved");
  }
  async function saveAsExplicit() {
    pristine = false;
    const text = editor.getText();
    const wasUntitled = !doc.path;
    const saved = await files.saveAs(text, doc.path ? doc.name : deriveName(text));
    if (!saved) return;
    if (wasUntitled) await files.discardDraft(doc.draftPath);
    doc = saved;
    settings.set("lastPath", saved.path!);
    refreshTitle();
    markClean();
    flashStatus("Saved");
  }

  // ── open another file (⌘O / menu) — finalizes current first ──
  async function openFile() {
    if ((await finalize()) === "cancel") return;
    const opened = await files.openDocument();
    if (opened) {
      setDoc(opened, opened.content);
      if (opened.path) settings.set("lastPath", opened.path);
    }
  }

  // ── new file = new window ──
  function newFile() {
    void files.newWindow();
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
    if (p.dailyGoal !== undefined) {
      goalCelebrated = settings.getWordsToday() >= p.dailyGoal && p.dailyGoal > 0;
      ring.set(settings.getWordsToday(), p.dailyGoal);
    }
  }
  function syncButtons() {
    const cur = settings.get();
    document.getElementById("btn-focus")!.classList.toggle("is-on", cur.focusMode !== "off");
    document.getElementById("btn-typewriter")!.classList.toggle("is-on", cur.typewriter);
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
      if (!panel.isOpen() && !palette.isOpen()) app.classList.remove("chrome-visible");
    }, 2400);
  }
  function immerse() {
    clearTimeout(chromeTimer);
    if (!panel.isOpen() && !palette.isOpen()) app.classList.remove("chrome-visible");
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
      { id: "focus-off", title: "Focus: Off", keywords: "focus mode", run: () => applyPatch({ focusMode: "off" }) },
      { id: "focus-sentence", title: "Focus: Sentence", keywords: "focus mode", run: () => applyPatch({ focusMode: "sentence" }) },
      { id: "focus-paragraph", title: "Focus: Paragraph", keywords: "focus mode", run: () => applyPatch({ focusMode: "paragraph" }) },
      { id: "typewriter", title: `Typewriter scrolling: ${cur.typewriter ? "On" : "Off"}`, shortcut: "⌘⇧T", keywords: "center caret", run: () => applyPatch({ typewriter: !cur.typewriter }) },
      { id: "syntax", title: `Hide Markdown syntax: ${cur.hideSyntax ? "On" : "Off"}`, keywords: "conceal markup", run: () => applyPatch({ hideSyntax: !cur.hideSyntax }) },
      { id: "sound", title: `Typing sound: ${cur.sound ? "On" : "Off"}`, keywords: "audio feel", run: () => applyPatch({ sound: !cur.sound }) },
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
  onClick("btn-focus", () => cycleFocus());
  onClick("btn-typewriter", () => applyPatch({ typewriter: !settings.get().typewriter }));
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
      if (palette.isOpen()) return;
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
      // In a plain browser there's no native menu — keep the file shortcuts working.
      if (k === "n" && !e.shiftKey) (e.preventDefault(), newFile());
      else if (k === "o" && !e.shiftKey) (e.preventDefault(), void openFile());
      else if (k === "s" && !e.shiftKey) (e.preventDefault(), void saveExplicit());
      else if (k === "s" && e.shiftKey) (e.preventDefault(), void saveAsExplicit());
      else if (k === ",") (e.preventDefault(), panel.toggle());
    }
  });

  // ── native window + menu wiring ──
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
    listen("menu:settings", () => panel.toggle());
  }

  // ── initial document ──
  ring.reset(settings.getWordsToday(), s.dailyGoal);
  renderStreak(s.streak);
  syncButtons();
  editor.setTypewriter(s.typewriter);

  const label = isTauri() ? getCurrentWindow().label : "main";
  if (label === "main") {
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
    setDoc(files.newDoc(), ""); // a fresh blank window
  }
  editor.focus();
  showChrome();
}

boot();
