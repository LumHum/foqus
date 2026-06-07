// Procedural tactile sound — no audio files, all synthesized with Web Audio.
//
// The goal is *feel*, not noise: a soft, slightly-randomized mechanical "thock"
// under the fingers, a crisp click for buttons, and a warm chime when a goal is
// reached. Everything is gentle and gated behind a setting (off by default —
// calm first). Sound is "primary delight": it makes typing itself pleasurable.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = false;
let volume = 0.35;

function ensure(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
  }
  // Browsers suspend audio until a user gesture; resume opportunistically.
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  if (on) ensure();
}

export function setSoundVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  if (master) master.gain.value = volume;
}

// Tiny deterministic-ish jitter so repeated keys never sound identical (the thing
// that makes fake mechanical sound feel cheap is exact repetition).
let seed = 0.137;
function rnd(): number {
  seed = (seed * 9301 + 49297) % 233280;
  return seed / 233280;
}

function noiseBurst(c: AudioContext, dur: number, freq: number, q: number, gain: number): void {
  const frames = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = freq;
  bp.Q.value = q;
  const g = c.createGain();
  const t = c.currentTime;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp).connect(g).connect(master!);
  src.start(t);
  src.stop(t + dur);
}

function tone(c: AudioContext, freq: number, dur: number, gain: number, type: OscillatorType = "sine", delay = 0): void {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t = c.currentTime + delay;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master!);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** The keystroke sound: a filtered noise tick + a tiny low "body". */
export function key(): void {
  if (!enabled) return;
  const c = ensure();
  if (!c) return;
  const j = rnd();
  noiseBurst(c, 0.022, 1700 + j * 900, 6 + j * 3, 0.5);
  tone(c, 150 + j * 40, 0.05, 0.10, "sine");
}

/** A softer, deeper sound for space — gives typing a subtle rhythm. */
export function space(): void {
  if (!enabled) return;
  const c = ensure();
  if (!c) return;
  noiseBurst(c, 0.03, 900 + rnd() * 300, 4, 0.4);
  tone(c, 110, 0.06, 0.09, "sine");
}

/** A deeper, rounder return for enter / new paragraph. */
export function enter(): void {
  if (!enabled) return;
  const c = ensure();
  if (!c) return;
  noiseBurst(c, 0.035, 1200, 5, 0.45);
  tone(c, 92, 0.08, 0.12, "sine");
}

/** A crisp, satisfying click for buttons & toggles (always plays a touch even
 *  when typing-sound is off feels wrong, so this also respects `enabled`). */
export function click(): void {
  if (!enabled) return;
  const c = ensure();
  if (!c) return;
  noiseBurst(c, 0.018, 2600, 8, 0.5);
  tone(c, 320, 0.04, 0.10, "triangle");
}

/** A warm little major arpeggio when a goal / milestone is reached. */
export function success(): void {
  if (!enabled) return;
  const c = ensure();
  if (!c) return;
  const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
  notes.forEach((f, i) => tone(c, f, 0.5, 0.16, "sine", i * 0.085));
}
