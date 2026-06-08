// Platform detection + window controls.
//
// macOS uses the native Overlay title bar (traffic lights). On Windows/Linux the
// window is frameless and foqus draws its own minimize / maximize / close
// controls, so the chrome stays consistent and calm everywhere.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "./env";

export type OS = "macos" | "windows" | "linux" | "web";

export async function osPlatform(): Promise<OS> {
  if (!isTauri()) return "web";
  try {
    return await invoke<OS>("os_platform");
  } catch {
    return "macos";
  }
}

export const windowControls = {
  minimize: async () => {
    if (isTauri()) await getCurrentWindow().minimize();
  },
  toggleMaximize: async () => {
    if (isTauri()) await getCurrentWindow().toggleMaximize();
  },
  close: async () => {
    if (isTauri()) await getCurrentWindow().close();
  },
};
