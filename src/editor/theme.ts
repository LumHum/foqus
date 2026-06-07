// The editor's *structural* theme. Every colour and metric is a CSS variable
// (set per-palette in styles.css), so re-theming foqus or changing font/size/
// measure never requires reconfiguring CodeMirror — we just change a variable and
// the editor reflows. Token *appearance* (headings, bold, dimmed marks, focus
// dimming) is styled in styles.css for the same reason.

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const foqusTheme = EditorView.theme({
  "&": {
    color: "var(--fg)",
    backgroundColor: "transparent",
    height: "100%",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--editor-font)",
    fontSize: "var(--editor-font-size)",
    lineHeight: "var(--editor-line-height)",
    overflow: "auto",
    // a touch of negative letter spacing reads as "crafted" at body sizes
    letterSpacing: "var(--editor-tracking, 0)",
  },
  ".cm-content": {
    caretColor: "var(--accent)",
    maxWidth: "var(--measure)",
    margin: "0 auto",
    padding: "12px 0",
    color: "var(--fg)",
  },
  ".cm-line": { padding: "0 2px" },
  // The caret: a confident 2px stroke in the accent colour — foqus's blue cursor.
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
    borderLeftWidth: "2px",
    marginLeft: "-1px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--selection)",
  },
  ".cm-placeholder": {
    color: "var(--faint)",
    fontStyle: "normal",
  },
  ".cm-gutters": { display: "none" },
});

// Subtle syntax tint inside fenced code blocks only — kept quiet on purpose.
const foqusHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--accent)" },
  { tag: [t.string, t.special(t.string)], color: "var(--ok)" },
  { tag: t.comment, color: "var(--faint)", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null], color: "var(--accent)" },
  { tag: [t.typeName, t.className], color: "var(--accent-2)" },
  { tag: t.propertyName, color: "var(--fg)" },
]);

export const foqusHighlighting = syntaxHighlighting(foqusHighlight);
