// foqus notebook — a vault folder where your .md files live.
//
// It's "just files in folders" (no database, no lock-in): the notebook is a
// folder you choose, and foqus shows its tree in a sidebar. You can nest
// subfolders and organise however you like — in foqus or in Finder/Explorer.
// Deletes go to the system Trash (reversible), never a hard delete.

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { isTauri } from "./env";

export interface TreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: TreeNode[] | null;
}

export async function pickNotebookFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const sel = await openDialog({
    directory: true,
    multiple: false,
    title: "Choose a folder for your foqus notebook",
  });
  return typeof sel === "string" ? sel : null;
}

export async function readTree(path: string): Promise<TreeNode | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<TreeNode>("read_tree", { path });
  } catch {
    return null;
  }
}

export async function createNote(dir: string, name?: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string>("create_note", { dir, name: name ?? null });
  } catch {
    return null;
  }
}

export async function createFolder(dir: string, name?: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string>("create_folder", { dir, name: name ?? null });
  } catch {
    return null;
  }
}

export async function renamePath(from: string, to: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string>("rename_path", { from, to });
  } catch {
    return null;
  }
}

export async function trashPath(path: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await invoke("trash_path", { path });
    return true;
  } catch {
    return false;
  }
}

// ── small path helpers (work for both / and \ separators) ────────────────────

export function sep(path: string): string {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}
export function parentDir(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "") || path;
}
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
export function joinPath(dir: string, name: string): string {
  return `${dir}${sep(dir)}${name}`;
}
/** Replace the file name of `path` with `name`, keeping the same folder. */
export function withName(path: string, name: string): string {
  return joinPath(parentDir(path), name);
}
