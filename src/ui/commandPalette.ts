// Command palette (⌘K) — every action, one keystroke away, no menus to hunt.
//
// Keyboard-first by design: type to fuzzy-filter, ↑/↓ to move, ↵ to run, esc to
// dismiss. It keeps the chrome empty (the writing stays front and center) while
// making the whole app reachable without lifting your hands from the keys.

import * as sound from "../lib/sound";

export interface Command {
  id: string;
  title: string;
  hint?: string; // right-aligned subtitle (e.g. current value)
  keywords?: string;
  shortcut?: string;
  run: () => void;
}

// Subsequence fuzzy score: rewards contiguous, early, word-start matches.
function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let s = 0;
  let streak = 0;
  let prev = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      streak++;
      s += streak; // contiguous runs are worth more
      if (ti === 0 || /\s/.test(t[ti - 1])) s += 3; // word-start bonus
      if (prev === ti - 1) s += 1;
      prev = ti;
      qi++;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? s : 0;
}

export class CommandPalette {
  private root: HTMLDivElement;
  private input: HTMLInputElement;
  private list: HTMLUListElement;
  private items: Command[] = [];
  private active = 0;
  private open = false;

  constructor(private getCommands: () => Command[]) {
    this.root = document.createElement("div");
    this.root.className = "palette-backdrop";
    this.root.innerHTML = `
      <div class="palette" role="dialog" aria-label="Command palette">
        <input class="palette-input" placeholder="Type a command…" spellcheck="false" autocomplete="off" />
        <ul class="palette-list" role="listbox"></ul>
      </div>`;
    this.input = this.root.querySelector(".palette-input")!;
    this.list = this.root.querySelector(".palette-list")!;
    document.body.appendChild(this.root);

    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });
    this.input.addEventListener("input", () => this.render());
    this.input.addEventListener("keydown", (e) => this.onKey(e));
  }

  toggle(): void {
    this.open ? this.close() : this.show();
  }

  show(): void {
    this.open = true;
    this.active = 0;
    this.input.value = "";
    this.render();
    this.root.classList.add("is-open");
    requestAnimationFrame(() => this.input.focus());
  }

  close(): void {
    this.open = false;
    this.root.classList.remove("is-open");
  }

  isOpen(): boolean {
    return this.open;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      this.active = Math.min(this.active + 1, this.items.length - 1);
      this.highlight();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.active = Math.max(this.active - 1, 0);
      this.highlight();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.runActive();
    }
  }

  private render(): void {
    const q = this.input.value.trim();
    this.items = this.getCommands()
      .map((c) => ({ c, s: score(q, `${c.title} ${c.keywords ?? ""}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
    this.active = 0;
    this.list.innerHTML = this.items
      .map(
        (c, i) => `
        <li class="palette-item${i === 0 ? " is-active" : ""}" data-i="${i}" role="option">
          <span class="palette-title">${escapeHtml(c.title)}</span>
          ${c.hint ? `<span class="palette-hint">${escapeHtml(c.hint)}</span>` : ""}
          ${c.shortcut ? `<kbd class="palette-kbd">${escapeHtml(c.shortcut)}</kbd>` : ""}
        </li>`
      )
      .join("");
    this.list.querySelectorAll<HTMLLIElement>(".palette-item").forEach((el) => {
      el.addEventListener("pointerenter", () => {
        this.active = Number(el.dataset.i);
        this.highlight();
      });
      el.addEventListener("click", () => {
        this.active = Number(el.dataset.i);
        this.runActive();
      });
    });
  }

  private highlight(): void {
    this.list.querySelectorAll<HTMLLIElement>(".palette-item").forEach((el, i) => {
      el.classList.toggle("is-active", i === this.active);
      if (i === this.active) el.scrollIntoView({ block: "nearest" });
    });
  }

  private runActive(): void {
    const cmd = this.items[this.active];
    if (!cmd) return;
    sound.click();
    this.close();
    cmd.run();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
