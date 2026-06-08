// Version history — browse past versions and see, visually, what changed.
//
// Xcode-style: a list of snapshots on the left; on the right, a unified diff with
// old/new line gutters, added/removed lines, intra-line character highlights, and
// a summary of lines & characters changed. "Restore" brings a version back (and
// because the current state is itself snapshotted on save, restoring is always
// reversible).

import { listVersions, readVersion, type Version } from "../lib/versions";
import { diffLines, type DiffRow } from "../lib/diff";
import * as sound from "../lib/sound";

export interface HistoryOpts {
  getActivePath: () => string | null;
  getCurrentContent: () => string;
  onRestore: (content: string) => void;
}

const X = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function relTime(ms: number): string {
  const d = Math.max(0, Date.now() - ms);
  const s = Math.round(d / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const day = Math.round(h / 24);
  if (day < 7) return `${day} day${day === 1 ? "" : "s"} ago`;
  return new Date(ms).toLocaleDateString();
}

export class HistoryPanel {
  readonly el: HTMLElement;
  private listEl: HTMLElement;
  private diffEl: HTMLElement;
  private summaryEl: HTMLElement;
  private titleEl: HTMLElement;
  private restoreBtn: HTMLButtonElement;
  private open = false;
  private versions: Version[] = [];
  private selectedId: number | null = null;
  private selectedContent = "";

  constructor(private opts: HistoryOpts) {
    this.el = document.createElement("div");
    this.el.className = "history-backdrop";
    this.el.innerHTML = `
      <div class="history-card" role="dialog" aria-modal="true" aria-label="Version history">
        <header class="history-head">
          <span class="history-title" id="hist-title">Version history</span>
          <span class="history-summary" id="hist-summary"></span>
          <button class="icon-btn history-close" title="Close (esc)" aria-label="Close">${X}</button>
        </header>
        <div class="history-body">
          <div class="history-list" id="hist-list"></div>
          <div class="history-diff" id="hist-diff"></div>
        </div>
        <footer class="history-foot">
          <span class="history-hint">Restoring is reversible — your current text is saved as a version too.</span>
          <button class="btn history-restore" id="hist-restore" type="button" disabled>Restore this version</button>
        </footer>
      </div>`;
    this.listEl = this.el.querySelector("#hist-list")!;
    this.diffEl = this.el.querySelector("#hist-diff")!;
    this.summaryEl = this.el.querySelector("#hist-summary")!;
    this.titleEl = this.el.querySelector("#hist-title")!;
    this.restoreBtn = this.el.querySelector("#hist-restore")!;
    this.el.querySelector(".history-close")!.addEventListener("click", () => this.close());
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.close();
    });
    this.restoreBtn.addEventListener("click", () => this.restore());
    document.body.appendChild(this.el);
  }

  isOpen(): boolean {
    return this.open;
  }
  close(): void {
    this.open = false;
    this.el.classList.remove("is-open");
  }

  async show(): Promise<void> {
    const path = this.opts.getActivePath();
    this.open = true;
    requestAnimationFrame(() => this.el.classList.add("is-open"));
    this.titleEl.textContent = path ? `Version history — ${path.split(/[\\/]/).pop()}` : "Version history";
    this.summaryEl.textContent = "";
    this.restoreBtn.disabled = true;

    if (!path) {
      this.listEl.innerHTML = "";
      this.diffEl.innerHTML = `<div class="hist-empty">Save this piece to a location first — then every save becomes a version you can return to.</div>`;
      return;
    }
    this.versions = await listVersions(path);
    if (!this.versions.length) {
      this.listEl.innerHTML = "";
      this.diffEl.innerHTML = `<div class="hist-empty">No versions yet. Keep writing — foqus saves a version each time your text changes.</div>`;
      return;
    }
    this.renderList();
    void this.select(this.versions[0].id); // newest
  }

  private renderList(): void {
    this.listEl.replaceChildren(
      ...this.versions.map((v, i) => {
        const item = document.createElement("button");
        item.className = "hist-item" + (v.id === this.selectedId ? " is-active" : "");
        item.dataset.id = String(v.id);
        item.innerHTML = `
          <span class="hist-when">${i === 0 ? "Latest" : relTime(v.id)}</span>
          <span class="hist-meta">${new Date(v.id).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${formatBytes(v.size)}</span>`;
        item.addEventListener("click", () => {
          sound.click();
          void this.select(v.id);
        });
        return item;
      })
    );
  }

  private async select(id: number): Promise<void> {
    this.selectedId = id;
    const versionContent = (await readVersion(this.opts.getActivePath()!, id)) ?? "";
    this.selectedContent = versionContent;
    this.restoreBtn.disabled = false;
    this.listEl.querySelectorAll(".hist-item").forEach((el) => {
      (el as HTMLElement).classList.toggle("is-active", el.getAttribute("data-id") === String(id));
    });

    // Diff this (older) version → current content.
    const current = this.opts.getCurrentContent();
    const result = diffLines(versionContent, current);
    if (result.identical) {
      this.summaryEl.textContent = "identical to current";
      this.diffEl.innerHTML = `<div class="hist-empty">This version is identical to what's open now.</div>`;
      return;
    }
    const cd = (result.charsAdded - result.charsRemoved >= 0 ? "+" : "") + (result.charsAdded - result.charsRemoved);
    this.summaryEl.textContent = `+${result.linesAdded} −${result.linesRemoved} lines · ${cd} chars vs. now`;
    this.diffEl.innerHTML = this.renderDiff(result.rows);
    this.diffEl.scrollTop = 0;
  }

  private renderDiff(rows: DiffRow[]): string {
    const cell = (r: DiffRow): string => {
      if (r.type === "gap") {
        return `<div class="diff-row diff-gap"><span class="diff-gut"></span><span class="diff-gut"></span><span class="diff-text">⋯ ${r.gapCount} unchanged line${r.gapCount === 1 ? "" : "s"}</span></div>`;
      }
      const sign = r.type === "add" ? "+" : r.type === "del" ? "−" : "";
      const body = r.segs
        ? r.segs.map((s) => (s.kind === "same" ? esc(s.t) : `<span class="seg-${s.kind}">${esc(s.t)}</span>`)).join("")
        : esc(r.text) || "&nbsp;";
      return `<div class="diff-row diff-${r.type}">
        <span class="diff-gut">${r.oldNo ?? ""}</span>
        <span class="diff-gut">${r.newNo ?? ""}</span>
        <span class="diff-sign">${sign}</span>
        <span class="diff-text">${body}</span>
      </div>`;
    };
    return rows.map(cell).join("");
  }

  private restore(): void {
    if (this.selectedId == null) return;
    sound.success();
    this.opts.onRestore(this.selectedContent);
    this.close();
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
