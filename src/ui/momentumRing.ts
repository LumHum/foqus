// Momentum ring — a quiet, spring-driven progress ring toward today's word goal.
//
// This is the one piece of "gamification" foqus allows into the writing surface,
// and it's deliberately gentle: it fills smoothly as you write (goal-gradient
// effect — progress motivates most as the end nears), glows once when you arrive,
// and otherwise stays out of the way. No numbers shouting at you, no streak-loss
// dread. Tooltip on hover for the details.

import { Spring } from "../lib/motion";

const R = 19;
const C = 2 * Math.PI * R;

export class MomentumRing {
  readonly el: HTMLDivElement;
  private fillEl: SVGCircleElement;
  private countEl: HTMLSpanElement;
  private fractionSpring: Spring;
  private countSpring: Spring;
  private complete = false;

  constructor(private onComplete?: () => void) {
    this.el = document.createElement("div");
    this.el.className = "ring";
    this.el.setAttribute("role", "img");
    this.el.innerHTML = `
      <svg viewBox="0 0 44 44" aria-hidden="true">
        <circle class="ring-track" cx="22" cy="22" r="${R}" />
        <circle class="ring-fill" cx="22" cy="22" r="${R}"
          stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${C.toFixed(2)}"
          transform="rotate(-90 22 22)" />
      </svg>
      <span class="ring-count">0</span>`;
    this.fillEl = this.el.querySelector(".ring-fill")!;
    this.countEl = this.el.querySelector(".ring-count")!;

    this.fractionSpring = new Spring(0, (f) => {
      const clamped = Math.max(0, Math.min(1, f));
      this.fillEl.style.strokeDashoffset = (C * (1 - clamped)).toFixed(2);
    }, { stiffness: 210, damping: 26 });

    this.countSpring = new Spring(0, (v) => {
      this.countEl.textContent = String(Math.round(v));
    }, { stiffness: 170, damping: 24 });
  }

  /** Update the ring to a new word count against the goal. */
  set(words: number, goal: number): void {
    const fraction = goal > 0 ? words / goal : 0;
    this.fractionSpring.set(fraction);
    this.countSpring.set(words);
    this.el.title = `${words} of ${goal} words today`;

    const done = fraction >= 1;
    if (done && !this.complete) {
      this.complete = true;
      this.el.classList.add("is-complete");
      this.onComplete?.();
    } else if (!done && this.complete) {
      this.complete = false;
      this.el.classList.remove("is-complete");
    }
  }

  /** Jump without animation (e.g. on load / document switch). */
  reset(words: number, goal: number): void {
    const fraction = goal > 0 ? words / goal : 0;
    this.fractionSpring.jump(fraction);
    this.countSpring.jump(words);
    this.complete = fraction >= 1;
    this.el.classList.toggle("is-complete", this.complete);
    this.el.title = `${words} of ${goal} words today`;
  }

  /** A single celebratory spin — the peak moment when the goal is reached. */
  celebrate(): void {
    this.el.classList.remove("is-spin");
    void this.el.offsetWidth; // restart the animation
    this.el.classList.add("is-spin");
    window.setTimeout(() => this.el.classList.remove("is-spin"), 720);
  }
}
