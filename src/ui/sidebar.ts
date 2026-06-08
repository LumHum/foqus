// The foqus notebook sidebar — a quiet file tree.
//
// Shows the notebook folder as a tree: click a note to open it, expand folders,
// and right-click for new note / new folder / rename / move to Trash. It stays
// calm and out of the way (it can be toggled off entirely). Organising is just
// moving files — in foqus or in your file manager.

import * as nb from "../lib/notebook";
import type { TreeNode } from "../lib/notebook";
import * as sound from "../lib/sound";

export interface SidebarOpts {
  getNotebookPath: () => string | null;
  getActivePath: () => string | null;
  onOpenFile: (path: string) => void;
  onRenamed: (oldPath: string, newPath: string) => void;
  onTrashed: (path: string) => void;
}

const FOLDER = `<svg viewBox="0 0 24 24" class="sb-svg"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h7A1.5 1.5 0 0 1 19 8.5v9A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z"/></svg>`;
const NOTE = `<svg viewBox="0 0 24 24" class="sb-svg"><path d="M7 3.5h7L18.5 8v12.5h-12z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9 12h6M9 15.5h6" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>`;
const PLUS = `<svg viewBox="0 0 24 24" class="ic"><path d="M12 5v14M5 12h14"/></svg>`;
const NEWFOLDER = `<svg viewBox="0 0 24 24" class="ic"><path d="M3 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h7A1.5 1.5 0 0 1 19 9v8.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z"/><path d="M14.5 13h-4M12.5 11v4"/></svg>`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export class Sidebar {
  readonly el: HTMLElement;
  private treeEl: HTMLElement;
  private expanded = new Set<string>();
  private root: TreeNode | null = null;
  private menu: HTMLElement | null = null;

  constructor(private opts: SidebarOpts) {
    this.el = document.createElement("aside");
    this.el.className = "sidebar";
    this.el.innerHTML = `
      <div class="sidebar-head" data-tauri-drag-region>
        <span class="sidebar-title" id="sb-title">Notebook</span>
        <div class="sidebar-actions">
          <button class="icon-btn sb-new-note" title="New note" aria-label="New note">${PLUS}</button>
          <button class="icon-btn sb-new-folder" title="New folder" aria-label="New folder">${NEWFOLDER}</button>
        </div>
      </div>
      <div class="sidebar-tree" id="sb-tree"></div>`;
    this.treeEl = this.el.querySelector("#sb-tree")!;
    this.el.querySelector(".sb-new-note")!.addEventListener("click", () => this.newNote(this.rootPath()));
    this.el.querySelector(".sb-new-folder")!.addEventListener("click", () => this.newFolder(this.rootPath()));
    window.addEventListener("click", () => this.closeMenu());
  }

  private rootPath(): string {
    return this.opts.getNotebookPath() ?? "";
  }

  async refresh(): Promise<void> {
    const path = this.opts.getNotebookPath();
    if (!path) {
      this.treeEl.innerHTML = "";
      return;
    }
    this.root = await nb.readTree(path);
    this.el.querySelector("#sb-title")!.textContent = this.root ? this.root.name : "Notebook";
    this.render();
  }

  setActive(): void {
    this.render();
  }

  private render(): void {
    if (!this.root) {
      this.treeEl.innerHTML = `<div class="sb-empty">No notebook folder yet.</div>`;
      return;
    }
    const active = this.opts.getActivePath();
    const kids = this.root.children ?? [];
    this.treeEl.replaceChildren(
      ...(kids.length ? kids.map((c) => this.node(c, 0, active)) : [emptyMsg()])
    );
  }

  private node(n: TreeNode, depth: number, active: string | null): HTMLElement {
    const wrap = document.createElement("div");
    const row = document.createElement("div");
    row.className = "sb-item" + (n.is_dir ? " is-dir" : "") + (!n.is_dir && n.path === active ? " is-active" : "");
    row.style.paddingLeft = `${8 + depth * 14}px`;
    const open = this.expanded.has(n.path);
    row.innerHTML = `
      <span class="sb-caret">${n.is_dir ? (open ? "▾" : "▸") : ""}</span>
      <span class="sb-icon">${n.is_dir ? FOLDER : NOTE}</span>
      <span class="sb-name">${esc(n.name)}</span>`;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (n.is_dir) this.toggle(n.path);
      else {
        sound.click();
        this.opts.onOpenFile(n.path);
      }
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openMenu(e as MouseEvent, n, row);
    });
    wrap.appendChild(row);
    if (n.is_dir && open && n.children) {
      for (const c of n.children) wrap.appendChild(this.node(c, depth + 1, active));
    }
    return wrap;
  }

  private toggle(path: string): void {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else this.expanded.add(path);
    this.render();
  }

  // ── actions ──
  private async newNote(dir: string): Promise<void> {
    if (!dir) return;
    sound.click();
    const p = await nb.createNote(dir);
    if (p) {
      this.expanded.add(dir);
      await this.refresh();
      this.opts.onOpenFile(p);
    }
  }
  private async newFolder(dir: string): Promise<void> {
    if (!dir) return;
    sound.click();
    const p = await nb.createFolder(dir);
    if (p) {
      this.expanded.add(dir);
      await this.refresh();
    }
  }
  private async doRename(n: TreeNode, row: HTMLElement): Promise<void> {
    const nameEl = row.querySelector(".sb-name") as HTMLElement;
    const input = document.createElement("input");
    input.className = "sb-rename";
    input.value = n.name;
    nameEl.replaceWith(input);
    input.focus();
    const dot = n.name.lastIndexOf(".");
    input.setSelectionRange(0, n.is_dir || dot <= 0 ? n.name.length : dot);
    const commit = async () => {
      const val = input.value.trim();
      if (val && val !== n.name) {
        const np = await nb.renamePath(n.path, nb.withName(n.path, val));
        if (np && this.opts.getActivePath() === n.path) this.opts.onRenamed(n.path, np);
      }
      await this.refresh();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      else if (e.key === "Escape") {
        input.value = n.name;
        input.blur();
      }
    });
    input.addEventListener("blur", () => void commit(), { once: true });
  }
  private async doTrash(n: TreeNode): Promise<void> {
    const ok = await nb.trashPath(n.path);
    if (ok) {
      if (this.opts.getActivePath() === n.path) this.opts.onTrashed(n.path);
      await this.refresh();
    }
  }

  // ── context menu ──
  private openMenu(e: MouseEvent, n: TreeNode, row: HTMLElement): void {
    this.closeMenu();
    const targetDir = n.is_dir ? n.path : nb.parentDir(n.path);
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    const items: Array<[string, () => void]> = [
      ["New note", () => this.newNote(targetDir)],
      ["New folder", () => this.newFolder(targetDir)],
      ["Rename", () => this.doRename(n, row)],
      ["Move to Trash", () => this.doTrash(n)],
    ];
    menu.innerHTML = items
      .map(([label], i) => `<button class="ctx-item${label === "Move to Trash" ? " is-danger" : ""}" data-i="${i}">${label}</button>`)
      .join("");
    document.body.appendChild(menu);
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - items.length * 34 - 12);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.querySelectorAll<HTMLButtonElement>(".ctx-item").forEach((b) =>
      b.addEventListener("click", () => {
        sound.click();
        this.closeMenu();
        items[Number(b.dataset.i)][1]();
      })
    );
    this.menu = menu;
  }
  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }
}

function emptyMsg(): HTMLElement {
  const d = document.createElement("div");
  d.className = "sb-empty";
  d.textContent = "Empty — make your first note with +";
  return d;
}
