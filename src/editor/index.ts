// Editor assembly — composes a lean, writing-first CodeMirror.
//
// No line numbers, no fold gutters, no IDE chrome: just wrapped text, history,
// live Markdown, focus mode, typewriter scrolling and tactile sound. Options are
// read through accessors (live settings) and toggled via compartments so flipping
// focus mode or hiding syntax is instant and never rebuilds the document.

import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";

import { liveMarkdown } from "./liveMarkdown";
import { focusMode, type FocusMode } from "./focus";
import { typewriterPadding, typewriterPaddingTheme, typewriterScroll } from "./typewriter";
import { keySound } from "./keysound";
import { foqusHighlighting, foqusTheme } from "./theme";

export interface EditorAccessors {
  focus: () => FocusMode;
  live: () => { hideSyntax: boolean };
  typewriter: () => boolean;
}

export interface CreateEditorOpts {
  parent: HTMLElement;
  doc: string;
  placeholder?: string;
  accessors: EditorAccessors;
  onChange: (text: string) => void;
}

export interface EditorAPI {
  view: EditorView;
  getText: () => string;
  loadDoc: (text: string) => void;
  refreshFocus: () => void;
  refreshLive: () => void;
  setTypewriter: (on: boolean) => void;
  focus: () => void;
  wrapSelection: (before: string, after?: string) => void;
  toggleHeading: (level: number) => void;
}

export function createEditor(opts: CreateEditorOpts): EditorAPI {
  const liveComp = new Compartment();
  const focusComp = new Compartment();

  const buildState = (text: string) =>
    EditorState.create({
      doc: text,
      extensions: [
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
        foqusHighlighting,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        liveComp.of(liveMarkdown(opts.accessors.live)),
        focusComp.of(focusMode(opts.accessors.focus)),
        typewriterPadding.of(opts.accessors.typewriter() ? typewriterPaddingTheme : []),
        typewriterScroll(opts.accessors.typewriter),
        keySound(),
        foqusTheme,
        cmPlaceholder(opts.placeholder ?? ""),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange(u.state.doc.toString());
        }),
      ],
    });

  const view = new EditorView({ parent: opts.parent, state: buildState(opts.doc) });

  const center = () => {
    requestAnimationFrame(() =>
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }) })
    );
  };

  return {
    view,
    getText: () => view.state.doc.toString(),
    loadDoc: (text: string) => {
      view.setState(buildState(text));
      view.focus();
    },
    refreshFocus: () => view.dispatch({ effects: focusComp.reconfigure(focusMode(opts.accessors.focus)) }),
    refreshLive: () => view.dispatch({ effects: liveComp.reconfigure(liveMarkdown(opts.accessors.live)) }),
    setTypewriter: (on: boolean) => {
      view.dispatch({ effects: typewriterPadding.reconfigure(on ? typewriterPaddingTheme : []) });
      if (on) center();
    },
    focus: () => view.focus(),
    wrapSelection: (before: string, after = before) => {
      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);
      view.dispatch({
        changes: { from, to, insert: `${before}${selected}${after}` },
        selection: { anchor: from + before.length, head: to + before.length },
      });
      view.focus();
    },
    toggleHeading: (level: number) => {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      const stripped = line.text.replace(/^#{1,6}\s+/, "");
      const prefix = "#".repeat(level) + " ";
      const already = line.text.startsWith(prefix);
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: already ? stripped : prefix + stripped },
      });
      view.focus();
    },
  };
}
