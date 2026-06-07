// Celebration — a short, soft burst when you reach your daily goal or hit a
// streak milestone. Deliberately restrained: a writing tool earns delight by
// being rare and quiet, not by raining confetti every save. Honors reduced-motion
// (skips entirely) and uses the theme's accent colours so it never feels bolted-on.

import { prefersReducedMotion } from "../lib/env";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  size: number;
  color: string;
  life: number;
}

function themeColors(): string[] {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return [
    pick("--accent", "#3b82f6"),
    pick("--accent-2", "#8b5cf6"),
    pick("--ok", "#22c55e"),
    pick("--gold", "#f5b301"),
  ];
}

/**
 * Confetti burst originating near `origin` (defaults to screen center-top).
 * `intensity` 0..1 scales particle count for small vs milestone celebrations.
 */
export function celebrate(intensity = 1, origin?: { x: number; y: number }): void {
  if (prefersReducedMotion()) return;

  const canvas = document.createElement("canvas");
  canvas.className = "celebrate-canvas";
  const dpr = window.devicePixelRatio || 1;
  const W = window.innerWidth;
  const H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.cssText = `position:fixed;inset:0;width:${W}px;height:${H}px;pointer-events:none;z-index:9999;`;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  const colors = themeColors();
  const ox = origin?.x ?? W / 2;
  const oy = origin?.y ?? H * 0.32;
  const count = Math.round(70 * intensity) + 20;
  const parts: Particle[] = Array.from({ length: count }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.7;
    const speed = 6 + Math.random() * 9 * intensity;
    return {
      x: ox,
      y: oy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      size: 5 + Math.random() * 6,
      color: colors[(Math.random() * colors.length) | 0],
      life: 1,
    };
  });

  const gravity = 0.28;
  const drag = 0.985;
  let raf = 0;

  const tick = () => {
    ctx.clearRect(0, 0, W, H);
    let alive = false;
    for (const p of parts) {
      p.vx *= drag;
      p.vy = p.vy * drag + gravity;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.life -= 0.012;
      if (p.life > 0 && p.y < H + 40) {
        alive = true;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
    }
    if (alive) raf = requestAnimationFrame(tick);
    else {
      cancelAnimationFrame(raf);
      canvas.remove();
    }
  };
  raf = requestAnimationFrame(tick);
}
