// Images in the editor — block widgets, the calm/predictable model.
//
// An image on its own line (a portable <img …> tag, or a plain ![](…)) renders as
// a block figure: snap it left / center / right, drag its edges to resize (it
// snaps to clean widths), and you write freely above and below. No anchor, no
// pixel-fighting — none of Word's jank. The Markdown stays portable plain text.
//
// Block decorations must come from editor state (not a view plugin), so this is a
// StateField; the same set is registered as atomic so the caret treats each image
// as one unit.

import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { StateField, type Range, type Text } from "@codemirror/state";
import { buildImgTag } from "../lib/images";

export interface ImageOptions {
  resolveSrc: (src: string) => string;
}

type Align = "left" | "center" | "right";

interface ParsedImage {
  src: string;
  alt: string;
  align: Align;
  width?: number;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag) || new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i").exec(tag);
  return m ? m[1] : undefined;
}

function parseImageLine(text: string): ParsedImage | null {
  const t = text.trim();
  const html = /^<img\s[^>]*>$/i.exec(t);
  if (html) {
    const src = attr(t, "src") ?? "";
    if (!src) return null;
    const align = (attr(t, "data-align") as Align) ?? "center";
    const w = attr(t, "data-width");
    return {
      src,
      alt: attr(t, "alt") ?? "",
      align: align === "left" || align === "right" ? align : "center",
      width: w ? parseInt(w, 10) || undefined : undefined,
    };
  }
  const md = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)$/.exec(t);
  if (md) return { src: md[2], alt: md[1], align: "center" };
  return null;
}

const SNAP_FRACTIONS = [0.25, 0.33, 0.5, 0.66, 0.8, 1];

class ImageWidget extends WidgetType {
  constructor(private p: ParsedImage, private opts: ImageOptions) {
    super();
  }
  eq(o: ImageWidget): boolean {
    return o.p.src === this.p.src && o.p.alt === this.p.alt && o.p.align === this.p.align && o.p.width === this.p.width;
  }
  get estimatedHeight(): number {
    return this.p.width ? Math.round(this.p.width * 0.62) + 30 : 240;
  }
  ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const p = this.p;
    const fig = document.createElement("figure");
    fig.className = `cm-image cm-image--${p.align}`;

    const img = document.createElement("img");
    img.src = this.opts.resolveSrc(p.src);
    img.alt = p.alt;
    img.draggable = false;
    if (p.width) img.style.width = `${p.width}px`;
    img.addEventListener("error", () => fig.classList.add("is-broken"));

    // ── controls (appear on hover) ──
    const bar = document.createElement("div");
    bar.className = "cm-image-bar";
    const seg = document.createElement("div");
    seg.className = "cm-image-seg";
    (["left", "center", "right"] as Align[]).forEach((a) => {
      const b = document.createElement("button");
      b.className = "cm-image-segbtn" + (a === p.align ? " is-active" : "");
      b.title = `Align ${a}`;
      b.innerHTML = ALIGN_ICON[a];
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        rewrite(view, fig, buildImgTag(p.src, p.alt, a, p.width));
      });
      seg.appendChild(b);
    });
    const del = document.createElement("button");
    del.className = "cm-image-del";
    del.title = "Remove image";
    del.innerHTML = X_ICON;
    del.addEventListener("mousedown", (e) => e.preventDefault());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeLine(view, fig);
    });
    bar.append(seg, del);

    const pill = document.createElement("div");
    pill.className = "cm-image-pill";

    // ── edge resize handles ──
    const onHandle = (side: "left" | "right") => {
      const handle = document.createElement("div");
      handle.className = `cm-image-handle cm-image-handle--${side}`;
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = img.getBoundingClientRect().width;
        const colW = Math.max(120, view.contentDOM.clientWidth - 12);
        handle.setPointerCapture(e.pointerId);
        fig.classList.add("is-resizing");
        let current = startW;
        const move = (ev: PointerEvent) => {
          const dx = ev.clientX - startX;
          let w = side === "right" ? startW + dx : startW - dx;
          w = Math.max(80, Math.min(colW, w));
          // gentle magnet to clean fractions of the column
          for (const f of SNAP_FRACTIONS) {
            const target = colW * f;
            if (Math.abs(w - target) < 14) {
              w = target;
              break;
            }
          }
          current = Math.round(w);
          img.style.width = `${current}px`;
          pill.textContent = `${current}px · ${Math.round((current / colW) * 100)}%`;
          pill.classList.add("is-on");
        };
        const up = (ev: PointerEvent) => {
          handle.releasePointerCapture(ev.pointerId);
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          fig.classList.remove("is-resizing");
          pill.classList.remove("is-on");
          rewrite(view, fig, buildImgTag(p.src, p.alt, p.align, current));
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
      });
      return handle;
    };

    fig.append(img, onHandle("left"), onHandle("right"), bar, pill);
    return fig;
  }
}

// Replace the image's source line with new tag text (computed at the live position).
function rewrite(view: EditorView, dom: HTMLElement, newText: string): void {
  const pos = view.posAtDOM(dom);
  const line = view.state.doc.lineAt(pos);
  view.dispatch({ changes: { from: line.from, to: line.to, insert: newText } });
  view.focus();
}
function removeLine(view: EditorView, dom: HTMLElement): void {
  const pos = view.posAtDOM(dom);
  const line = view.state.doc.lineAt(pos);
  const to = Math.min(view.state.doc.length, line.to + 1); // also eat the trailing newline
  view.dispatch({ changes: { from: line.from, to, insert: "" } });
  view.focus();
}

function build(docText: Text, opts: ImageOptions): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (let i = 1; i <= docText.lines; i++) {
    const line = docText.line(i);
    if (line.length === 0) continue;
    const parsed = parseImageLine(line.text);
    if (parsed) {
      ranges.push(Decoration.replace({ widget: new ImageWidget(parsed, opts), block: true }).range(line.from, line.to));
    }
  }
  return Decoration.set(ranges, true);
}

export function imageBlocks(opts: ImageOptions) {
  const field = StateField.define<DecorationSet>({
    create(state) {
      return build(state.doc, opts);
    },
    update(value, tr) {
      return tr.docChanged ? build(tr.state.doc, opts) : value;
    },
    provide: (f) => [
      EditorView.decorations.from(f),
      EditorView.atomicRanges.of((view) => view.state.field(f)),
    ],
  });
  return field;
}

const ALIGN_ICON: Record<Align, string> = {
  left: `<svg viewBox="0 0 24 24"><path d="M4 6h16M4 10h9M4 14h16M4 18h9"/></svg>`,
  center: `<svg viewBox="0 0 24 24"><path d="M4 6h16M7 10h10M4 14h16M7 18h10"/></svg>`,
  right: `<svg viewBox="0 0 24 24"><path d="M4 6h16M11 10h9M4 14h16M11 18h9"/></svg>`,
};
const X_ICON = `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
