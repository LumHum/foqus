// A calm update banner.
//
// Slides up from the bottom, off to the side of your writing. It states the new
// version and offers one tactile button; while installing it shows progress, then
// foqus relaunches itself. Dismissible, and never in the way.

import * as sound from "../lib/sound";

export class UpdateBanner {
  readonly el: HTMLDivElement;
  private label: HTMLSpanElement;
  private button: HTMLButtonElement;
  private bar: HTMLDivElement;
  private onUpdate: (() => void) | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "update-banner";
    this.el.innerHTML = `
      <div class="update-bar"></div>
      <span class="update-label">A new version of foqus is ready.</span>
      <button class="btn btn-small update-go" type="button">Update &amp; Relaunch</button>
      <button class="update-dismiss" type="button" aria-label="Later">Later</button>`;
    this.label = this.el.querySelector(".update-label")!;
    this.button = this.el.querySelector(".update-go")!;
    this.bar = this.el.querySelector(".update-bar")!;
    this.el.querySelector(".update-dismiss")!.addEventListener("click", () => this.hide());
    this.button.addEventListener("click", () => {
      sound.click();
      this.onUpdate?.();
    });
    document.body.appendChild(this.el);
  }

  show(version: string, onUpdate: () => void): void {
    this.onUpdate = onUpdate;
    this.label.textContent = `foqus ${version} is ready.`;
    this.button.disabled = false;
    this.button.textContent = "Update & Relaunch";
    this.bar.style.transform = "scaleX(0)";
    requestAnimationFrame(() => this.el.classList.add("is-open"));
  }

  setProgress(fraction: number): void {
    this.button.disabled = true;
    this.button.textContent = `Updating… ${Math.round(fraction * 100)}%`;
    this.bar.style.transform = `scaleX(${Math.max(0, Math.min(1, fraction))})`;
  }

  hide(): void {
    this.el.classList.remove("is-open");
  }
}
