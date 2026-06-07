// Live Markdown rendering — the heart of the editor.
//
// You write plain Markdown, but it *looks* formatted as you type: headings grow,
// **bold** is bold, *italic* leans, links tint. The punctuation that makes it
// Markdown (the #, the **, the []()) is dimmed to a whisper — and, when you turn
// on "hide syntax", fully concealed on every line except the one your cursor is
// on, so the markup reveals itself only when you go to edit it. This is the
// iA-Writer / Typora trick, done with CodeMirror decorations over the Lezer parse
// tree so it stays fast on long documents (we only decorate the viewport).

import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";

// Heading containers → a class that sizes them (styled in CSS).
const HEADING: Record<string, string> = {
  ATXHeading1: "cm-h1",
  ATXHeading2: "cm-h2",
  ATXHeading3: "cm-h3",
  ATXHeading4: "cm-h4",
  ATXHeading5: "cm-h5",
  ATXHeading6: "cm-h6",
  SetextHeading1: "cm-h1",
  SetextHeading2: "cm-h2",
};

// Inline emphasis containers → a class.
const INLINE: Record<string, string> = {
  StrongEmphasis: "cm-strong",
  Emphasis: "cm-em",
  Strikethrough: "cm-strike",
  InlineCode: "cm-code",
  Link: "cm-link",
  Image: "cm-link",
};

// The punctuation nodes that should be dimmed / concealed.
const MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "LinkMark",
  "QuoteMark",
  "ListMark",
]);

const headingLine = Decoration.line({ class: "cm-headingLine" });
const blockquoteLine = Decoration.line({ class: "cm-blockquoteLine" });
const dimMark = Decoration.mark({ class: "cm-mdMark" });
const concealed = Decoration.replace({});

// Replace a bullet "list mark" with a real bullet glyph when syntax is hidden —
// keeps lists feeling like lists, not raw text.
class BulletWidget extends WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-bullet";
    span.textContent = "•";
    return span;
  }
  ignoreEvent() {
    return false;
  }
}
const bullet = Decoration.replace({ widget: new BulletWidget() });

export interface LiveMdOptions {
  hideSyntax: boolean;
}

export function liveMarkdown(getOptions: () => LiveMdOptions) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.geometryChanged) {
          this.decorations = this.build(u.view);
        }
      }
      build(view: EditorView): DecorationSet {
        const { hideSyntax } = getOptions();
        const doc = view.state.doc;
        const ranges: Range<Decoration>[] = [];

        // Lines that currently hold a cursor/selection — never conceal marks on
        // these, so editing markup is always direct and visible.
        const activeLines = new Set<number>();
        for (const r of view.state.selection.ranges) {
          const from = doc.lineAt(r.from).number;
          const to = doc.lineAt(r.to).number;
          for (let n = from; n <= to; n++) activeLines.add(n);
        }

        for (const { from, to } of view.visibleRanges) {
          syntaxTree(view.state).iterate({
            from,
            to,
            enter: (node) => {
              const name = node.name;

              if (HEADING[name]) {
                ranges.push(headingLine.range(doc.lineAt(node.from).from));
                ranges.push(Decoration.mark({ class: HEADING[name] }).range(node.from, node.to));
                return;
              }
              if (name === "Blockquote") {
                ranges.push(blockquoteLine.range(doc.lineAt(node.from).from));
                return;
              }
              if (INLINE[name] && node.to > node.from) {
                ranges.push(Decoration.mark({ class: INLINE[name] }).range(node.from, node.to));
                return;
              }
              if (MARKS.has(name) && node.to > node.from) {
                const lineNo = doc.lineAt(node.from).number;
                const isActive = activeLines.has(lineNo);
                if (hideSyntax && !isActive) {
                  if (name === "ListMark") {
                    ranges.push(bullet.range(node.from, node.to));
                  } else {
                    // also swallow the space after a heading "#", so the heading
                    // text isn't left looking indented
                    let end = node.to;
                    if (name === "HeaderMark" && doc.sliceString(end, end + 1) === " ") end += 1;
                    ranges.push(concealed.range(node.from, end));
                  }
                } else {
                  ranges.push(dimMark.range(node.from, node.to));
                }
              }
            },
          });
        }

        // sort:true lets CodeMirror order by `from` and `startSide` for us —
        // essential when line, mark and replace decorations share positions.
        return Decoration.set(ranges, true);
      }
    },
    { decorations: (v) => v.decorations }
  );
}
