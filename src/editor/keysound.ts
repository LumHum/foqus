// Keystroke sound — couples the synthesized "thock" to actual typing.
//
// A CodeMirror dom handler so it fires on the real key, with the right variant
// for space / enter / everything-else, and never on shortcuts (Cmd/Ctrl combos).
// The sound module itself no-ops unless the user turned sound on.

import { EditorView } from "@codemirror/view";
import * as sound from "../lib/sound";

export function keySound() {
  return EditorView.domEventHandlers({
    keydown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      if (e.key === "Enter") sound.enter();
      else if (e.key === " ") sound.space();
      else if (e.key === "Backspace" || e.key === "Delete") sound.key();
      else if (e.key.length === 1) sound.key();
      return false;
    },
  });
}
