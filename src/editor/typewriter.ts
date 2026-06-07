// Typewriter mode — the line you're writing stays put.
//
// Instead of your eyes chasing the caret down the screen, the caret holds at the
// vertical center and the text scrolls up beneath it, like paper rolling through
// a typewriter. Big top/bottom padding lets the very first and very last lines
// reach the middle. Loved for long-form flow; we keep it buttery by only
// re-centering on caret moves and letting the browser do a smooth scroll.

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { Compartment } from "@codemirror/state";

export const typewriterPadding = new Compartment();

// Half-viewport padding so line 1 and the last line can sit at center.
export const typewriterPaddingTheme = EditorView.theme({
  ".cm-content": { paddingTop: "44vh", paddingBottom: "44vh" },
});

export function typewriterScroll(isOn: () => boolean) {
  return ViewPlugin.fromClass(
    class {
      update(u: ViewUpdate) {
        if (!isOn()) return;
        if (u.selectionSet || u.docChanged || u.geometryChanged) {
          const view = u.view;
          // Can't dispatch during an update; schedule for the next frame.
          requestAnimationFrame(() => {
            if (!isOn()) return;
            const head = view.state.selection.main.head;
            view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) });
          });
        }
      }
    }
  );
}
