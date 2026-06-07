// file-over-app I/O + draft autosave.
//
// foqus never traps your words. Every document is a plain .md file you own. While
// a document is untitled, it autosaves to a private *draft* file (crash-safe) and
// you're never asked where to put it — that choice is deferred to the moment you
// close the window or open another file. This module is the only place that talks
// to disk; in a plain browser it falls back to download/open for UI development.

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { isTauri } from "./env";

export interface Doc {
  path: string | null; // real location, null while untitled
  draftPath: string | null; // crash-safe autosave target while untitled
  name: string;
  content: string;
}

const MD_FILTERS = [
  { name: "Markdown & text", extensions: ["md", "markdown", "mdown", "txt", "text"] },
  { name: "All files", extensions: ["*"] },
];

export function newDoc(): Doc {
  return { path: null, draftPath: null, name: "Untitled", content: "" };
}

/** Show the open panel, then read the chosen file. Returns null if cancelled. */
export async function openDocument(): Promise<Doc | null> {
  if (!isTauri()) return browserOpen();
  const selected = await openDialog({ multiple: false, directory: false, filters: MD_FILTERS });
  if (!selected || Array.isArray(selected)) return null;
  return readPath(selected as string);
}

/** Read a known path (used for "open last document" and draft recovery). */
export async function readPath(path: string): Promise<Doc | null> {
  if (!isTauri()) return null;
  try {
    const d = await invoke<{ path: string; name: string; content: string }>("read_document", { path });
    return { path: d.path, draftPath: null, name: d.name, content: d.content };
  } catch {
    return null;
  }
}

/** Write content to a known path (atomic). Used by autosave and explicit Save. */
export async function saveToPath(path: string, content: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("save_document", { path, content });
}

/** Show the save panel and write there. Returns the doc with its new path/name. */
export async function saveAs(content: string, suggestedName: string): Promise<Doc | null> {
  if (!isTauri()) return browserSave(content, suggestedName);
  const name = suggestedName.replace(/[\\/:*?"<>|]/g, "").trim() || "Untitled";
  const path = await saveDialog({
    defaultPath: name.endsWith(".md") ? name : `${name}.md`,
    filters: MD_FILTERS,
  });
  if (!path) return null;
  await invoke("save_document", { path, content });
  return { path, draftPath: null, name: baseName(path), content };
}

// ---- drafts & windows (Tauri only) -----------------------------------------

export async function newDraftPath(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string>("new_draft_path");
  } catch {
    return null;
  }
}

export async function discardDraft(path: string | null): Promise<void> {
  if (!isTauri() || !path) return;
  try {
    await invoke("discard_draft", { path });
  } catch {
    /* non-fatal */
  }
}

export interface DraftInfo {
  path: string;
  content: string;
  modified: number;
}

export async function listDrafts(): Promise<DraftInfo[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<DraftInfo[]>("list_drafts");
  } catch {
    return [];
  }
}

/** Open a brand-new document window. */
export async function newWindow(): Promise<void> {
  if (!isTauri()) {
    // browser: just clear to a blank doc via reload of a fresh state — no-op here
    return;
  }
  await invoke("new_window");
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "Untitled";
}

// ---- browser fallbacks (UI development only) -------------------------------

async function browserOpen(): Promise<Doc | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,.txt,text/plain";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve({ path: null, draftPath: null, name: file.name, content: await file.text() });
    };
    input.click();
  });
}

function browserSave(content: string, suggestedName: string): Doc {
  const name = suggestedName.endsWith(".md") ? suggestedName : `${suggestedName || "Untitled"}.md`;
  const blob = new Blob([content], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  return { path: null, draftPath: null, name, content };
}
