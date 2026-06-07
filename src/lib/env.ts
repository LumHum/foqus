// Are we running inside the Tauri shell, or a plain browser (e.g. `vite` preview)?
// foqus degrades gracefully in the browser so the UI can be developed without the
// native shell — file I/O falls back to in-memory / download behaviour.
export const isTauri = (): boolean =>
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

// Respect the OS "reduce motion" accessibility setting. Every spring, bounce and
// celebration in foqus checks this — joy must never come at the cost of access.
export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
