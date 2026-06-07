// Settings — a slide-over panel of tactile controls.
//
// This is where foqus shows its "feel": segmented pills that press in like real
// buttons, switches whose knobs spring across, steppers that click. Each control
// is small, immediate (<16ms), and audible (if sound is on). Changing anything
// here is reversible and instant — no "apply", no modal, no friction.

import type { FocusMode, FontName, Settings, ThemeName } from "../lib/settings";
import * as sound from "../lib/sound";

export interface SettingsPanelOpts {
  get: () => Readonly<Settings>;
  onChange: (patch: Partial<Settings>) => void;
}

export class SettingsPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private open = false;

  constructor(private opts: SettingsPanelOpts) {
    // Same visual language as the loved "Save your work?" dialog: a blurred
    // backdrop with a centered, spring-in card and tactile buttons.
    this.el = document.createElement("div");
    this.el.className = "settings-backdrop";
    this.el.innerHTML = `
      <div class="settings-card" role="dialog" aria-modal="true" aria-label="Settings">
        <header class="settings-head">
          <span>Settings</span>
          <button class="icon-btn settings-close" title="Close (esc)" aria-label="Close">${X_ICON}</button>
        </header>
        <div class="settings-body"></div>
        <footer class="settings-foot">
          <span class="settings-tag">foqus — your words, your files.</span>
          <button class="btn settings-done" type="button">Done</button>
        </footer>
      </div>`;
    this.body = this.el.querySelector(".settings-body")!;
    this.el.querySelector(".settings-close")!.addEventListener("click", () => this.close());
    this.el.querySelector(".settings-done")!.addEventListener("click", () => {
      sound.click();
      this.close();
    });
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.close();
    });
    document.body.appendChild(this.el);
  }

  toggle(): void {
    this.open ? this.close() : this.show();
  }
  show(): void {
    this.render();
    this.open = true;
    requestAnimationFrame(() => this.el.classList.add("is-open"));
  }
  close(): void {
    this.open = false;
    this.el.classList.remove("is-open");
  }
  isOpen(): boolean {
    return this.open;
  }

  private render(): void {
    const s = this.opts.get();
    this.body.replaceChildren(
      section("Appearance", [
        segmented<ThemeName>("Theme", [
          ["paper", "Paper"],
          ["night", "Night"],
          ["sepia", "Sepia"],
          ["ink", "Ink"],
        ], s.theme, (v) => this.opts.onChange({ theme: v })),
        segmented<FontName>("Typeface", [
          ["mono", "Mono"],
          ["serif", "Serif"],
          ["sans", "Sans"],
        ], s.font, (v) => this.opts.onChange({ font: v })),
        stepper("Text size", s.fontSize, 13, 28, 1, (v) => `${v}px`, (v) => this.opts.onChange({ fontSize: v })),
        stepper("Line spacing", s.lineHeight, 1.3, 2.4, 0.05, (v) => v.toFixed(2), (v) => this.opts.onChange({ lineHeight: round2(v) })),
        stepper("Line width", s.measure, 48, 110, 2, (v) => `${v} ch`, (v) => this.opts.onChange({ measure: v })),
      ]),
      section("Focus", [
        segmented<FocusMode>("Focus mode", [
          ["off", "Off"],
          ["sentence", "Sentence"],
          ["paragraph", "Paragraph"],
        ], s.focusMode, (v) => this.opts.onChange({ focusMode: v })),
        toggle("Typewriter scrolling", s.typewriter, (v) => this.opts.onChange({ typewriter: v })),
        toggle("Hide Markdown syntax", s.hideSyntax, (v) => this.opts.onChange({ hideSyntax: v })),
      ]),
      section("Feel", [
        toggle("Typing & UI sound", s.sound, (v) => this.opts.onChange({ sound: v })),
        slider("Sound volume", s.soundVolume, 0, 1, 0.05, (v) => this.opts.onChange({ soundVolume: round2(v) })),
      ]),
      section("Momentum", [
        stepper("Daily goal", s.dailyGoal, 0, 5000, 50, (v) => (v === 0 ? "off" : `${v} words`), (v) => this.opts.onChange({ dailyGoal: v })),
      ])
    );
  }
}

// ---- control factories -----------------------------------------------------

function section(title: string, rows: HTMLElement[]): HTMLElement {
  const sec = document.createElement("section");
  sec.className = "settings-section";
  const h = document.createElement("h3");
  h.textContent = title;
  sec.append(h, ...rows);
  return sec;
}

function row(label: string, control: HTMLElement): HTMLElement {
  const r = document.createElement("div");
  r.className = "setting-row";
  const l = document.createElement("label");
  l.className = "setting-label";
  l.textContent = label;
  r.append(l, control);
  return r;
}

function segmented<T extends string>(
  label: string,
  options: Array<[T, string]>,
  current: T,
  onPick: (v: T) => void
): HTMLElement {
  const seg = document.createElement("div");
  seg.className = "seg";
  options.forEach(([value, text]) => {
    const b = document.createElement("button");
    b.className = "seg-item" + (value === current ? " is-active" : "");
    b.textContent = text;
    b.addEventListener("click", () => {
      sound.click();
      seg.querySelectorAll(".seg-item").forEach((x) => x.classList.remove("is-active"));
      b.classList.add("is-active");
      onPick(value);
    });
    seg.appendChild(b);
  });
  return row(label, seg);
}

function toggle(label: string, current: boolean, onToggle: (v: boolean) => void): HTMLElement {
  const b = document.createElement("button");
  b.className = "switch" + (current ? " is-on" : "");
  b.setAttribute("role", "switch");
  b.setAttribute("aria-checked", String(current));
  b.innerHTML = `<span class="switch-knob"></span>`;
  b.addEventListener("click", () => {
    const next = !b.classList.contains("is-on");
    b.classList.toggle("is-on", next);
    b.setAttribute("aria-checked", String(next));
    sound.click();
    onToggle(next);
  });
  return row(label, b);
}

function stepper(
  label: string,
  current: number,
  min: number,
  max: number,
  step: number,
  fmt: (v: number) => string,
  onChange: (v: number) => void
): HTMLElement {
  let value = current;
  const wrap = document.createElement("div");
  wrap.className = "stepper";
  const minus = document.createElement("button");
  minus.className = "step-btn";
  minus.textContent = "−";
  const val = document.createElement("span");
  val.className = "step-val";
  val.textContent = fmt(value);
  const plus = document.createElement("button");
  plus.className = "step-btn";
  plus.textContent = "+";
  const apply = (delta: number) => {
    value = Math.min(max, Math.max(min, round2(value + delta)));
    val.textContent = fmt(value);
    sound.click();
    onChange(value);
  };
  minus.addEventListener("click", () => apply(-step));
  plus.addEventListener("click", () => apply(step));
  wrap.append(minus, val, plus);
  return row(label, wrap);
}

function slider(label: string, current: number, min: number, max: number, step: number, onChange: (v: number) => void): HTMLElement {
  const input = document.createElement("input");
  input.type = "range";
  input.className = "slider";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(current);
  input.addEventListener("input", () => onChange(parseFloat(input.value)));
  return row(label, input);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const X_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
