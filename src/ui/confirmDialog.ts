// The "Save your work?" prompt.
//
// Shown only at a boundary — closing a window or opening another file — when an
// untitled draft has content. This is the one moment foqus asks where to keep
// your words. It's a calm, tactile three-way choice (the "Save…" button leads to
// the native location picker); Esc keeps you writing, ⏎ saves. Never deletes
// under pressure — discard is explicit and secondary.

import * as sound from "../lib/sound";

export type SaveChoice = "save" | "discard" | "cancel";

export function confirmSave(name: string): Promise<SaveChoice> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "confirm-backdrop";
    backdrop.innerHTML = `
      <div class="confirm" role="dialog" aria-modal="true" aria-label="Save your work">
        <div class="confirm-title">Save your work?</div>
        <div class="confirm-body">“${escapeHtml(name)}” hasn’t been saved to a location yet.</div>
        <div class="confirm-actions">
          <button class="btn btn-ghost confirm-discard" type="button">Discard</button>
          <button class="btn confirm-save" type="button">Save…</button>
        </div>
        <button class="confirm-cancel" type="button">Keep writing</button>
      </div>`;
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("is-open"));

    const finish = (choice: SaveChoice) => {
      sound.click();
      backdrop.classList.remove("is-open");
      window.removeEventListener("keydown", onKey, true);
      setTimeout(() => backdrop.remove(), 180);
      resolve(choice);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish("cancel");
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        finish("save");
      }
    };
    window.addEventListener("keydown", onKey, true);

    backdrop.querySelector(".confirm-save")!.addEventListener("click", () => finish("save"));
    backdrop.querySelector(".confirm-discard")!.addEventListener("click", () => finish("discard"));
    backdrop.querySelector(".confirm-cancel")!.addEventListener("click", () => finish("cancel"));
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) finish("cancel");
    });

    requestAnimationFrame(() => (backdrop.querySelector(".confirm-save") as HTMLButtonElement)?.focus());
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
