// Auto-update.
//
// foqus quietly checks for a new version on launch (and on demand). If one's
// ready, it offers it in a calm banner — never a blocking modal mid-sentence.
// Updates are signed; the public key lives in tauri.conf.json and only a build
// signed with the matching private key will ever install.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isTauri } from "./env";

export type { Update };

/** Returns an Update if a newer signed version is available, else null. */
export async function checkForUpdate(): Promise<Update | null> {
  if (!isTauri()) return null;
  try {
    return await check();
  } catch {
    return null; // offline / no manifest — never bother the writer about it
  }
}

/** Download + install the update (reporting 0..1 progress), then relaunch. */
export async function installUpdate(update: Update, onProgress?: (fraction: number) => void): Promise<void> {
  let total = 0;
  let got = 0;
  await update.downloadAndInstall((e) => {
    switch (e.event) {
      case "Started":
        total = e.data.contentLength ?? 0;
        onProgress?.(0);
        break;
      case "Progress":
        got += e.data.chunkLength;
        if (total > 0) onProgress?.(Math.min(0.99, got / total));
        break;
      case "Finished":
        onProgress?.(1);
        break;
    }
  });
  await relaunch();
}
