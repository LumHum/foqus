// First-run onboarding — short, warm, and human.
//
// Three tiny choices, each a single friendly sentence and a tactile button. It
// offers the foqus notebook, version history, and default-editor — but every step
// is skippable, because foqus should never make you do anything before you write.

import * as sound from "../lib/sound";

export interface OnboardingHandlers {
  pickFolder: () => Promise<string | null>;
  setDefaultEditor: () => Promise<string>; // resolves with a message, rejects with guidance
}

export interface OnboardingResult {
  notebookPath: string | null;
  versionControl: boolean;
  defaultEditor: boolean;
}

interface Step {
  title: string;
  body: string;
  primary: { label: string; act: () => void | Promise<void> };
  secondary?: { label: string; act: () => void };
  note?: string;
}

export function runOnboarding(handlers: OnboardingHandlers): Promise<OnboardingResult> {
  return new Promise((resolve) => {
    const result: OnboardingResult = { notebookPath: null, versionControl: true, defaultEditor: false };

    const backdrop = document.createElement("div");
    backdrop.className = "onboard-backdrop";
    backdrop.innerHTML = `
      <div class="onboard-card" role="dialog" aria-modal="true" aria-label="Welcome to foqus">
        <div class="onboard-mark">foqus</div>
        <div class="onboard-title"></div>
        <div class="onboard-body"></div>
        <div class="onboard-note"></div>
        <div class="onboard-actions"></div>
        <div class="onboard-dots"></div>
      </div>`;
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("is-open"));

    const titleEl = backdrop.querySelector(".onboard-title") as HTMLElement;
    const bodyEl = backdrop.querySelector(".onboard-body") as HTMLElement;
    const noteEl = backdrop.querySelector(".onboard-note") as HTMLElement;
    const actionsEl = backdrop.querySelector(".onboard-actions") as HTMLElement;
    const dotsEl = backdrop.querySelector(".onboard-dots") as HTMLElement;

    let i = 0;
    const finish = () => {
      backdrop.classList.remove("is-open");
      setTimeout(() => backdrop.remove(), 220);
      resolve(result);
    };

    const steps: Step[] = [
      {
        title: "Hello — welcome to foqus.",
        body: "A calm place to write. Two tiny choices and you're in.",
        primary: { label: "Let's go", act: () => go(1) },
      },
      {
        title: "Want a home for your writing?",
        body: "foqus notebook keeps your notes together in one folder you can arrange however you like — a tidy drawer for everything you write.",
        primary: {
          label: "Choose a folder…",
          act: async () => {
            const path = await handlers.pickFolder();
            if (path) {
              result.notebookPath = path;
              go(2);
            }
          },
        },
        secondary: { label: "Maybe later", act: () => go(2) },
      },
      {
        title: "Keep a safety net?",
        body: "foqus can quietly remember every version of your work — so if you write something and change your mind, you can always go back.",
        primary: {
          label: "Yes, keep history",
          act: () => {
            result.versionControl = true;
            go(3);
          },
        },
        secondary: {
          label: "No thanks",
          act: () => {
            result.versionControl = false;
            go(3);
          },
        },
      },
      {
        title: "Open Markdown with foqus?",
        body: "Make foqus your default for .md files, so a double-click opens it here.",
        primary: {
          label: "Make it default",
          act: async () => {
            try {
              const msg = await handlers.setDefaultEditor();
              result.defaultEditor = true;
              noteEl.textContent = msg;
            } catch (e) {
              noteEl.textContent = String(e);
            }
            setTimeout(() => go(4), 900);
          },
        },
        secondary: { label: "Skip", act: () => go(4) },
      },
      {
        title: "You're all set.",
        body: "That's everything. Now — write freely.",
        primary: { label: "Start writing", act: finish },
      },
    ];

    function go(n: number) {
      sound.click();
      i = n;
      render();
    }

    function render() {
      const s = steps[i];
      titleEl.textContent = s.title;
      bodyEl.textContent = s.body;
      noteEl.textContent = s.note ?? "";
      actionsEl.replaceChildren();
      if (s.secondary) {
        const b = document.createElement("button");
        b.className = "btn btn-ghost";
        b.textContent = s.secondary.label;
        b.addEventListener("click", () => s.secondary!.act());
        actionsEl.appendChild(b);
      }
      const p = document.createElement("button");
      p.className = "btn";
      p.textContent = s.primary.label;
      p.addEventListener("click", () => void s.primary.act());
      actionsEl.appendChild(p);
      dotsEl.replaceChildren(
        ...steps.map((_, idx) => {
          const dot = document.createElement("span");
          dot.className = "onboard-dot" + (idx === i ? " is-on" : "");
          return dot;
        })
      );
      requestAnimationFrame(() => p.focus());
    }

    render();
  });
}
