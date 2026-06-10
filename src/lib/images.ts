// Image helpers — copy images onto disk and turn stored paths into URLs the
// webview can actually load (via Tauri's asset protocol).
//
// Images live in an `assets/` folder beside the document (file-over-app), so they
// travel with it. In the Markdown they're a portable HTML <img> tag carrying
// alignment/width as data-* attributes (CommonMark's ![]() can't hold those).

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { isTauri } from "./env";

export interface ImportedImage {
  src: string; // what to write in the doc (relative to the doc, or absolute)
  abs: string; // absolute path, for immediate rendering
}

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic"];

export function isImageFile(path: string): boolean {
  const e = path.split(".").pop()?.toLowerCase();
  return !!e && IMAGE_EXTS.includes(e);
}

export async function importImage(source: string, docPath: string | null): Promise<ImportedImage | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<ImportedImage>("import_image", { source, docPath });
  } catch {
    return null;
  }
}

export async function saveImageBytes(bytes: number[], ext: string, docPath: string | null): Promise<ImportedImage | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<ImportedImage>("save_image_bytes", { bytes, ext, docPath });
  } catch {
    return null;
  }
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p);
}
function dirOf(p: string): string {
  return p.replace(/[\\/][^\\/]*$/, "");
}

/** Turn a stored image src (relative to the doc, or absolute) into a URL the
 *  webview can load. */
export function resolveImageUrl(src: string, docPath: string | null): string {
  if (/^(https?:|data:|asset:|blob:|tauri:)/i.test(src)) return src;
  let abs = src;
  if (!isAbsolute(src) && docPath) {
    const sep = docPath.includes("\\") && !docPath.includes("/") ? "\\" : "/";
    abs = `${dirOf(docPath)}${sep}${src.replace(/\//g, sep)}`;
  }
  return isTauri() ? convertFileSrc(abs) : abs;
}

/** The portable on-disk form. */
export function buildImgTag(src: string, alt: string, align: string, width?: number): string {
  const safeAlt = alt.replace(/"/g, "&quot;");
  const w = width ? ` data-width="${Math.round(width)}"` : "";
  return `<img src="${src}" alt="${safeAlt}" data-align="${align}"${w}>`;
}
