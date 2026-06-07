// Focus mode — fade the world, keep the words.
//
// In sentence mode everything dims to a low contrast except the sentence the
// caret is in; in paragraph mode the whole current paragraph stays lit. This is
// iA Writer's single most-loved feature: it pins your attention to the thought
// you're forming and quiets the wall of finished text above it. Implemented with
// cheap viewport-only decorations so it stays smooth in a 50-page document.

import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

export type FocusMode = "off" | "sentence" | "paragraph";

const dim = Decoration.mark({ class: "cm-focusDim" });

const SENTENCE_END = /[.!?…]/;

function sentenceRange(text: string, pos: number): { start: number; end: number } {
  let start = pos;
  while (start > 0) {
    const ch = text[start - 1];
    if (ch === "\n" && text[start - 2] === "\n") break; // paragraph boundary
    if (SENTENCE_END.test(ch)) break;
    start--;
  }
  while (start < pos && /\s/.test(text[start])) start++; // trim leading space
  let end = pos;
  while (end < text.length) {
    const ch = text[end];
    if (SENTENCE_END.test(ch)) {
      end++;
      break;
    }
    if (ch === "\n" && text[end + 1] === "\n") break;
    end++;
  }
  return { start, end };
}

export function focusMode(getMode: () => FocusMode) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged) {
          this.decorations = this.build(u.view);
        }
      }
      build(view: EditorView): DecorationSet {
        const mode = getMode();
        const builder = new RangeSetBuilder<Decoration>();
        if (mode === "off") return builder.finish();

        const head = view.state.selection.main.head;

        let litFrom: number;
        let litTo: number;
        if (mode === "paragraph") {
          // Expand across contiguous non-empty lines around the caret.
          const doc = view.state.doc;
          let topLine = doc.lineAt(head).number;
          let botLine = topLine;
          while (topLine > 1 && doc.line(topLine - 1).text.trim() !== "") topLine--;
          while (botLine < doc.lines && doc.line(botLine + 1).text.trim() !== "") botLine++;
          litFrom = doc.line(topLine).from;
          litTo = doc.line(botLine).to;
        } else {
          const text = view.state.doc.toString();
          const r = sentenceRange(text, head);
          litFrom = r.start;
          litTo = r.end;
        }

        // Dim everything in the viewport except [litFrom, litTo].
        const ranges: Array<{ from: number; to: number }> = [];
        for (const { from, to } of view.visibleRanges) {
          if (litFrom > from) ranges.push({ from, to: Math.min(litFrom, to) });
          if (litTo < to) ranges.push({ from: Math.max(litTo, from), to });
        }
        ranges.sort((a, b) => a.from - b.from);
        for (const r of ranges) if (r.to > r.from) builder.add(r.from, r.to, dim);
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}
