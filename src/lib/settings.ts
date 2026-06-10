// Persistent settings + writing streak.
//
// Backed by the Tauri store plugin (a small JSON file in the app data dir) with a
// localStorage fallback in the browser. Loaded once into memory on boot so the UI
// can read synchronously; writes are debounced to disk. Nothing here ever leaves
// the machine.

import { load, type Store } from "@tauri-apps/plugin-store";
import { isTauri } from "./env";

export type ThemeName = "paper" | "night" | "sepia" | "ink";
export type FontName = "mono" | "serif" | "sans";
export type FocusMode = "off" | "sentence" | "paragraph";

export interface Settings {
  theme: ThemeName;
  font: FontName;
  fontSize: number; // px
  measure: number; // max line length in ch
  lineHeight: number;
  focusMode: FocusMode;
  typewriter: boolean; // keep the caret line vertically centered
  sound: boolean; // tactile typing/UI sound
  soundVolume: number; // 0..1
  dailyGoal: number; // words/day target for the momentum ring
  hideSyntax: boolean; // dim/hide markdown punctuation when not editing it
  autosave: boolean; // save continuously, or only on explicit save / close
  lastPath: string | null;
  // foqus notebook (a vault folder where .md files live)
  notebookEnabled: boolean;
  notebookPath: string | null;
  sidebarOpen: boolean;
  // version control — keep recoverable snapshots on save
  versionControl: boolean;
  // automatically check for new versions
  autoUpdate: boolean;
  // first-run onboarding seen?
  onboarded: boolean;
  // streak tracking
  streak: number;
  longestStreak: number;
  lastWriteDay: string | null; // YYYY-MM-DD
  totalWords: number;
  // daily momentum
  wordsToday: number;
  wordsTodayDate: string | null;
}

export const DEFAULTS: Settings = {
  theme: "paper",
  font: "mono",
  fontSize: 19,
  measure: 68,
  lineHeight: 1.75,
  focusMode: "off",
  typewriter: false,
  sound: false,
  soundVolume: 0.35,
  dailyGoal: 500,
  hideSyntax: true,
  autosave: true,
  lastPath: null,
  notebookEnabled: false,
  notebookPath: null,
  sidebarOpen: true,
  versionControl: true,
  autoUpdate: true,
  onboarded: false,
  streak: 0,
  longestStreak: 0,
  lastWriteDay: null,
  totalWords: 0,
  wordsToday: 0,
  wordsTodayDate: null,
};

let store: Store | null = null;
let cache: Settings = { ...DEFAULTS };
let saveTimer: number | undefined;

export async function initSettings(): Promise<Settings> {
  if (isTauri()) {
    store = await load("settings.json");
    const saved = (await store.get<Partial<Settings>>("settings")) ?? {};
    cache = { ...DEFAULTS, ...saved };
  } else {
    try {
      cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("foqus.settings") || "{}") };
    } catch {
      cache = { ...DEFAULTS };
    }
  }
  return cache;
}

export function get(): Readonly<Settings> {
  return cache;
}

export function set<K extends keyof Settings>(key: K, value: Settings[K]): void {
  cache = { ...cache, [key]: value };
  persist();
}

export function patch(partial: Partial<Settings>): void {
  cache = { ...cache, ...partial };
  persist();
}

function persist(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    if (store) {
      await store.set("settings", cache);
      await store.save();
    } else {
      localStorage.setItem("foqus.settings", JSON.stringify(cache));
    }
  }, 250);
}

// ---- streak logic ----------------------------------------------------------

function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function dayDiff(a: string, b: string): number {
  const da = new Date(a + "T00:00:00");
  const db = new Date(b + "T00:00:00");
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

/**
 * Record that the writer actually wrote today. Streaks are gentle: a one-day gap
 * doesn't reset to zero (a built-in "rest day" grace), so the streak motivates
 * without punishing. Returns the streak event for the UI to celebrate (or not).
 */
export function recordWritingDay(wordsWrittenNow: number): {
  streak: number;
  isNewDay: boolean;
  isMilestone: boolean;
} {
  const today = todayKey();
  const last = cache.lastWriteDay;
  let isNewDay = false;
  let streak = cache.streak;

  if (last !== today) {
    isNewDay = true;
    if (last === null) {
      streak = 1;
    } else {
      const gap = dayDiff(last, today);
      if (gap === 1) streak += 1;
      else if (gap === 2) streak += 1; // one rest day is forgiven
      else streak = 1; // longer gap: a fresh, kind restart
    }
  }

  const longest = Math.max(cache.longestStreak, streak);
  patch({
    streak,
    longestStreak: longest,
    lastWriteDay: today,
    totalWords: cache.totalWords + Math.max(0, wordsWrittenNow),
  });

  const isMilestone = isNewDay && (streak === 3 || streak === 7 || streak % 30 === 0);
  return { streak, isNewDay, isMilestone };
}

/** Words written today, rolling over at midnight. */
export function getWordsToday(): number {
  return cache.wordsTodayDate === todayKey() ? cache.wordsToday : 0;
}

/** Add to today's word tally (only positive deltas — deletions don't subtract
 *  from your momentum). Returns the new total for today. */
export function addWordsToday(delta: number): number {
  const today = todayKey();
  const base = cache.wordsTodayDate === today ? cache.wordsToday : 0;
  const next = base + Math.max(0, delta);
  patch({ wordsToday: next, wordsTodayDate: today });
  return next;
}
