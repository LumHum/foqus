// Version control — recoverable snapshots of every file.
//
// "Never lose work," taken further: each meaningful save records a snapshot, so
// if you wrote a lot and don't like it, you can always go back. Snapshots live in
// the app data dir (not cluttering your folders) and are de-duplicated, so
// identical saves don't pile up. The UI (historyPanel) shows the visual diff and
// lets you revert.

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./env";

export interface Version {
  id: number; // unix-ms timestamp, also the snapshot id
  size: number; // bytes
}

export async function saveVersion(path: string, content: string): Promise<void> {
  if (!isTauri() || !path) return;
  try {
    await invoke("save_version", { path, content });
  } catch {
    /* non-fatal — history is a safety net, never blocks writing */
  }
}

export async function listVersions(path: string): Promise<Version[]> {
  if (!isTauri() || !path) return [];
  try {
    return await invoke<Version[]>("list_versions", { path });
  } catch {
    return [];
  }
}

export async function readVersion(path: string, id: number): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string>("read_version", { path, id });
  } catch {
    return null;
  }
}
