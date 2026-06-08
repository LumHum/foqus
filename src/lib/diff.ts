// A small line + character diff, for the version-history view.
//
// Produces an Xcode-style unified diff: line gutters (old / new), added and
// removed lines, intra-line character highlights for edited lines, and summary
// counts (lines and characters changed). Pure functions, no dependencies.

export interface Seg {
  t: string;
  kind: "same" | "add" | "del";
}
export interface DiffRow {
  type: "equal" | "add" | "del" | "gap";
  oldNo: number | null;
  newNo: number | null;
  text: string;
  segs?: Seg[]; // intra-line character diff (for edited lines)
  gapCount?: number; // for collapsed "… N unchanged …" rows
}
export interface DiffResult {
  rows: DiffRow[];
  linesAdded: number;
  linesRemoved: number;
  charsAdded: number;
  charsRemoved: number;
  identical: boolean;
}

interface Op {
  type: "equal" | "add" | "del";
  text: string;
  oldNo: number | null;
  newNo: number | null;
  segs?: Seg[];
}

function lcsDiff(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // Guard against pathological sizes — fall back to a whole-block replace.
  if (n * m > 4_000_000) {
    return [
      ...a.map((t, i) => ({ type: "del" as const, text: t, oldNo: i + 1, newNo: null })),
      ...b.map((t, i) => ({ type: "add" as const, text: t, oldNo: null, newNo: i + 1 })),
    ];
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", text: a[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", text: a[i], oldNo: i + 1, newNo: null });
      i++;
    } else {
      ops.push({ type: "add", text: b[j], oldNo: null, newNo: j + 1 });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", text: a[i], oldNo: i++ + 1, newNo: null });
  while (j < m) ops.push({ type: "add", text: b[j], oldNo: null, newNo: j++ + 1 });
  return ops;
}

function merge(arr: Seg[], t: string, kind: Seg["kind"]) {
  const last = arr[arr.length - 1];
  if (last && last.kind === kind) last.t += t;
  else arr.push({ t, kind });
}

function charDiff(o: string, n: string): { oldSegs: Seg[]; newSegs: Seg[] } {
  const a = [...o];
  const b = [...n];
  const N = a.length;
  const M = b.length;
  if (N * M > 500_000) {
    return { oldSegs: [{ t: o, kind: "del" }], newSegs: [{ t: n, kind: "add" }] };
  }
  const dp: Uint32Array[] = Array.from({ length: N + 1 }, () => new Uint32Array(M + 1));
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const oldSegs: Seg[] = [];
  const newSegs: Seg[] = [];
  let i = 0;
  let j = 0;
  while (i < N && j < M) {
    if (a[i] === b[j]) {
      merge(oldSegs, a[i], "same");
      merge(newSegs, b[j], "same");
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      merge(oldSegs, a[i], "del");
      i++;
    } else {
      merge(newSegs, b[j], "add");
      j++;
    }
  }
  while (i < N) merge(oldSegs, a[i++], "del");
  while (j < M) merge(newSegs, b[j++], "add");
  return { oldSegs, newSegs };
}

const segLen = (segs: Seg[], kind: Seg["kind"]) =>
  segs.filter((s) => s.kind === kind).reduce((a, s) => a + [...s.t].length, 0);

export function diffLines(oldText: string, newText: string): DiffResult {
  if (oldText === newText) {
    return { rows: [], linesAdded: 0, linesRemoved: 0, charsAdded: 0, charsRemoved: 0, identical: true };
  }
  const ops = lcsDiff(oldText.split("\n"), newText.split("\n"));

  // Pair del/add runs to compute intra-line character highlights.
  const detailed: Op[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  let charsAdded = 0;
  let charsRemoved = 0;
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === "equal") {
      detailed.push(ops[k]);
      k++;
      continue;
    }
    const start = k;
    while (k < ops.length && ops[k].type !== "equal") k++;
    const hunk = ops.slice(start, k);
    const dels = hunk.filter((o) => o.type === "del");
    const adds = hunk.filter((o) => o.type === "add");
    const pairs = Math.min(dels.length, adds.length);
    dels.forEach((d, p) => {
      linesRemoved++;
      if (p < pairs) {
        const { oldSegs } = charDiff(dels[p].text, adds[p].text);
        d.segs = oldSegs;
        charsRemoved += segLen(oldSegs, "del");
      } else {
        charsRemoved += [...d.text].length + 1;
      }
      detailed.push(d);
    });
    adds.forEach((ad, p) => {
      linesAdded++;
      if (p < pairs) {
        const { newSegs } = charDiff(dels[p].text, adds[p].text);
        ad.segs = newSegs;
        charsAdded += segLen(newSegs, "add");
      } else {
        charsAdded += [...ad.text].length + 1;
      }
      detailed.push(ad);
    });
  }

  // Collapse long unchanged runs to keep the view focused (Xcode-style context).
  const rows: DiffRow[] = [];
  let run: Op[] = [];
  const flush = () => {
    if (run.length > 6) {
      rows.push(run[0], run[1], run[2]);
      rows.push({ type: "gap", oldNo: null, newNo: null, text: "", gapCount: run.length - 6 });
      rows.push(run[run.length - 3], run[run.length - 2], run[run.length - 1]);
    } else {
      rows.push(...run);
    }
    run = [];
  };
  for (const op of detailed) {
    if (op.type === "equal") run.push(op);
    else {
      flush();
      rows.push(op);
    }
  }
  flush();

  return { rows, linesAdded, linesRemoved, charsAdded, charsRemoved, identical: false };
}
