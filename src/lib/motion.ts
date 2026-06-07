// Spring physics for the parts of foqus that move.
//
// The tactile button "press" lives in CSS (:active) for 60fps cheapness. This
// module handles *value* animation that has to follow a moving target smoothly —
// the momentum ring chasing your word count, counters easing to a new number —
// using a real critically-tunable spring rather than a fixed-duration tween, so
// motion feels physical, not scripted. Honors prefers-reduced-motion (snaps).

import { prefersReducedMotion } from "./env";

export interface SpringOpts {
  stiffness?: number; // higher = snappier   (default 170)
  damping?: number; // higher = less bounce (default 22)
  mass?: number; // higher = heavier      (default 1)
  precision?: number; // settle threshold
}

/**
 * A re-targetable spring. Call `set(target)` any time; it animates the current
 * value toward it with semi-implicit Euler integration and calls `onUpdate`
 * each frame. Cheap, GC-friendly, and stops itself when it settles.
 */
export class Spring {
  private value: number;
  private velocity = 0;
  private target: number;
  private raf = 0;
  private last = 0;
  private readonly k: number;
  private readonly c: number;
  private readonly m: number;
  private readonly precision: number;

  constructor(initial: number, private onUpdate: (v: number) => void, opts: SpringOpts = {}) {
    this.value = initial;
    this.target = initial;
    this.k = opts.stiffness ?? 170;
    this.c = opts.damping ?? 22;
    this.m = opts.mass ?? 1;
    this.precision = opts.precision ?? 0.01;
  }

  get current(): number {
    return this.value;
  }

  set(target: number): void {
    this.target = target;
    if (prefersReducedMotion()) {
      this.value = target;
      this.velocity = 0;
      this.onUpdate(this.value);
      return;
    }
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  /** Jump instantly with no animation. */
  jump(value: number): void {
    this.stop();
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.onUpdate(value);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private tick = (now: number): void => {
    // Clamp dt so a backgrounded tab doesn't explode the integration.
    const dt = Math.min((now - this.last) / 1000, 1 / 30);
    this.last = now;

    const force = -this.k * (this.value - this.target);
    const damping = -this.c * this.velocity;
    const accel = (force + damping) / this.m;
    this.velocity += accel * dt;
    this.value += this.velocity * dt;

    this.onUpdate(this.value);

    if (Math.abs(this.velocity) < this.precision && Math.abs(this.value - this.target) < this.precision) {
      this.value = this.target;
      this.velocity = 0;
      this.onUpdate(this.value);
      this.raf = 0;
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };
}

/** One-shot eased tween for a number (used for quick count-ups). */
export function tween(
  from: number,
  to: number,
  durationMs: number,
  onUpdate: (v: number) => void,
  onDone?: () => void
): () => void {
  if (prefersReducedMotion() || durationMs <= 0) {
    onUpdate(to);
    onDone?.();
    return () => {};
  }
  const start = performance.now();
  let raf = requestAnimationFrame(function step(now) {
    const t = Math.min((now - start) / durationMs, 1);
    // easeOutCubic — fast then gently settling
    const eased = 1 - Math.pow(1 - t, 3);
    onUpdate(from + (to - from) * eased);
    if (t < 1) raf = requestAnimationFrame(step);
    else onDone?.();
  });
  return () => cancelAnimationFrame(raf);
}
