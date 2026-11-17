// 교정 회차 비교 — 이전본과 수정본, 무엇이 바뀌었나.
//
// 인쇄 일에서 가장 자주 반복되는 장면이다. "수정본 보냅니다"를 받으면 두 PDF를 눈으로 대조하는데,
// 고친다던 곳이 안 고쳐져 있거나 손대지 말라던 곳이 바뀌어 있는 일이 흔하다. 그래서 둘을 나눠 본다.
//
// - 글자: 쪽마다 낱말 단위로 비교한다. 지운 것은 이전본에, 넣은 것은 수정본에 표시한다.
// - 그림: 두 쪽을 같은 배율로 그려 화소를 대조한다. 사진 교체·자리 이동처럼 글자에 안 잡히는 변화가 여기 걸린다.
// - 요청: "깨끗히 → 깨끗이" 같은 수정 요청이 반영됐는지 센다.
//
// 이 파일은 계산만 한다(브라우저·pdf.js 없이 돈다). 시험: `npx tsx lib/compare.check.ts`.

/** 쪽 위의 상자(pt). 왼쪽 위가 원점이다 — 화면에 겹쳐 그리기 쉽게. */
export type Box = [number, number, number, number];
export type Word = { s: string; box: Box };
export type Change = { kind: "del" | "ins" | "rep"; before: string; after: string; oldBoxes: Box[]; newBoxes: Box[] };
export type PageDiff = {
  page: number;
  changes: Change[];
  visual: Box[];                    // 글자 변경과 겹치지 않는 그림 변화(pt, 수정본 기준)
  only?: "old" | "new";             // 한쪽에만 있는 쪽
  sizeChanged?: boolean;            // 판형이 달라 그림 비교를 건너뜀
};
export type RequestStatus = "반영" | "누락" | "확인 필요";
export type RequestCheck = { from: string; to: string; status: RequestStatus; note: string; page?: number };

type Item = { str: string; transform: number[]; width: number; height: number };

/** pdf.js 글 조각을 낱말로 나눈다. 조각 안의 낱말 자리는 글자 수 비율로 나눠 잡는다(대략이면 충분하다 —
 *  표시용이지 측정용이 아니다). `origin`은 보이는 영역의 왼쪽 아래(pt), `height`는 그 높이다. */
export function wordsFromItems(items: Item[], origin: [number, number], height: number): Word[] {
  const out: Word[] = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x0 = it.transform[4] - origin[0];
    const yb = it.transform[5] - origin[1];
    const h = it.height || Math.abs(it.transform[3]) || 10;
    const chars = [...it.str];
    const per = chars.length ? it.width / chars.length : 0;
    let i = 0;
    for (const m of it.str.matchAll(/\S+/g)) {
      const start = [...it.str.slice(0, m.index)].length;
      const len = [...m[0]].length;
      i = start;
      const a = x0 + per * i, b = x0 + per * (i + len);
      out.push({ s: m[0], box: [a, height - (yb + h), b, height - yb] });
    }
  }
  return out;
}

export type Op = { op: "eq" | "del" | "ins"; a?: number; b?: number };

/** 낱말 두 줄을 맞춰 본다(최장 공통 부분열). 앞뒤 같은 부분은 먼저 잘라 계산량을 줄인다 —
 *  교정본은 대부분 그대로이고 몇 군데만 바뀌므로, 남는 가운데가 작다. */
export function diffWords(A: string[], B: string[]): Op[] {
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  const a = A.slice(p, A.length - s), b = B.slice(p, B.length - s);
  const n = a.length, m = b.length;
  const ops: Op[] = [];
  for (let i = 0; i < p; i++) ops.push({ op: "eq", a: i, b: i });
  if (n * m > 8_000_000) {
    // 너무 크면(쪽 전체가 바뀐 경우) 통째로 지우고 넣은 것으로 본다. 맞춰 볼 의미가 거의 없다.
    for (let i = 0; i < n; i++) ops.push({ op: "del", a: p + i });
    for (let j = 0; j < m; j++) ops.push({ op: "ins", b: p + j });
  } else {
    const W = m + 1;
    const L = new Int32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i * W + j] = a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ op: "eq", a: p + i, b: p + j }); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) { ops.push({ op: "del", a: p + i }); i++; }
      else { ops.push({ op: "ins", b: p + j }); j++; }
    }
    for (; i < n; i++) ops.push({ op: "del", a: p + i });
    for (; j < m; j++) ops.push({ op: "ins", b: p + j });
  }
  for (let k = 0; k < s; k++) ops.push({ op: "eq", a: A.length - s + k, b: B.length - s + k });
  return ops;
}

/** 이어진 지움·넣음을 한 덩어리로 묶는다. 둘 다 있으면 '바꿈'이다. */
export function groupChanges(ops: Op[], A: Word[], B: Word[]): Change[] {
  const out: Change[] = [];
  let cur: { del: number[]; ins: number[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const before = cur.del.map((i) => A[i].s).join(" "), after = cur.ins.map((j) => B[j].s).join(" ");
    out.push({
      kind: cur.del.length && cur.ins.length ? "rep" : cur.del.length ? "del" : "ins",
      before, after, oldBoxes: cur.del.map((i) => A[i].box), newBoxes: cur.ins.map((j) => B[j].box),
    });
    cur = null;
  };
  for (const o of ops) {
    if (o.op === "eq") { flush(); continue; }
    cur ??= { del: [], ins: [] };
    if (o.op === "del") cur.del.push(o.a!); else cur.ins.push(o.b!);
  }
  flush();
  return out;
}

/** 두 쪽 그림의 화소를 칸(cell px) 단위로 대조해 바뀐 자리를 상자로 돌려준다(px).
 *  JPEG 잡티와 글꼴 다듬기 차이는 문턱(thr)으로 거른다. 붙어 있는 칸은 하나로 합친다. */
export function changedRegions(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number, cell = 10, thr = 22): Box[] {
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const hot = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let sum = 0, n = 0;
      for (let y = gy * cell; y < Math.min(h, (gy + 1) * cell); y++) {
        for (let x = gx * cell; x < Math.min(w, (gx + 1) * cell); x++) {
          const k = (y * w + x) * 4;
          sum += Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]);
          n++;
        }
      }
      if (n && sum / (n * 3) > thr) hot[gy * gw + gx] = 1;
    }
  }
  const seen = new Uint8Array(gw * gh);
  const boxes: Box[] = [];
  for (let s0 = 0; s0 < hot.length; s0++) {
    if (!hot[s0] || seen[s0]) continue;
    let x0 = gw, y0 = gh, x1 = -1, y1 = -1, cnt = 0;
    const stack = [s0];
    seen[s0] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % gw, cy = (c / gw) | 0;
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy); cnt++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const q = ny * gw + nx;
        if (hot[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    if (cnt >= 2) boxes.push([x0 * cell, y0 * cell, Math.min(w, (x1 + 1) * cell), Math.min(h, (y1 + 1) * cell)]);
  }
  return boxes;
}

const overlaps = (p: Box, q: Box, pad = 4) => p[0] - pad < q[2] && q[0] - pad < p[2] && p[1] - pad < q[3] && q[1] - pad < p[3];

/** 그림 변화 가운데 글자 변경 자리와 겹치는 것은 뺀다 — 같은 변화를 두 번 세지 않게. */
export function visualOnly(visual: Box[], changes: Change[]): Box[] {
  const textBoxes = changes.flatMap((c) => [...c.oldBoxes, ...c.newBoxes]);
  return visual.filter((v) => !textBoxes.some((t) => overlaps(v, t)));
}

// ---------------------------------------------------------------- 요청 대조

/** "이전 → 이후" 한 줄에 하나. 화살표는 →, ->, =>, ⇒ 모두 받는다. 화살표 없는 줄은 건너뛴다. */
export function parseRequests(text: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // 줄 앞의 목록 표시('- ', '• ', '1. ', '2) ')만 지운다. 숫자·점을 통째로 지웠더니
    // '3mm → 5mm'가 'mm → 5mm'이 되고 '2026 → 2027'은 요청째 사라졌다.
    const line = raw.replace(/^\s*(?:[-•*]|\d+[.)])\s+/, "").trim();
    const m = line.match(/^(.+?)\s*(?:→|->|=>|⇒)\s*(.*)$/);
    if (!m) continue;
    const from = unquote(m[1]), to = unquote(m[2]);
    if (from) out.push({ from, to });
  }
  return out;
}
const unquote = (s: string) => s.trim().replace(/^['"‘“「]+|['"’”」]+$/g, "").trim();

const norm = (s: string) => s.replace(/\s+/g, " ");
function count(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}
/** `from`이 `to` 안에 들어 있으면("Inc" → "Inc.") 고친 자리도 `from`으로 세어진다. 그만큼 뺀다. */
function countAlone(hay: string, from: string, to: string): number {
  const raw = count(hay, from);
  return to && to.includes(from) ? raw - count(hay, to) * count(to, from) : raw;
}

/** 요청마다 반영·누락·확인 필요를 가린다. 쪽 글은 띄어쓰기를 하나로 줄여 비교한다
 *  (PDF는 줄 끝·자간 때문에 띄어쓰기가 흔들린다). 띄어쓰기만 고치는 요청은 그래서 '확인 필요'로 남을 수 있다. */
export function checkRequests(reqs: { from: string; to: string }[], oldPages: string[], newPages: string[]): RequestCheck[] {
  const O = norm(oldPages.join(" ")), N = norm(newPages.join(" "));
  return reqs.map(({ from, to }) => {
    const f = norm(from), t = norm(to);
    const oldFrom = countAlone(O, f, t), newFrom = countAlone(N, f, t);
    const oldTo = count(O, t), newTo = count(N, t);
    const pageIdx = oldPages.findIndex((p) => norm(p).includes(f));
    const page = pageIdx >= 0 ? pageIdx + 1 : undefined;
    if (oldFrom === 0)
      return { from, to, status: "확인 필요", page, note: "이전본에서 고칠 글을 찾지 못했습니다. 요청 글자를 확인해 주세요." };
    if (newFrom === 0 && (!t || newTo > oldTo))
      return { from, to, status: "반영", page, note: `${oldFrom}곳 모두 고쳐졌습니다.` };
    if (newFrom >= oldFrom)
      return { from, to, status: "누락", page, note: `수정본에 '${from}'이(가) 그대로 ${newFrom}곳 남아 있습니다.` };
    return { from, to, status: "확인 필요", page, note: `${oldFrom}곳 중 ${oldFrom - newFrom}곳만 고쳐졌습니다.` };
  });
}
