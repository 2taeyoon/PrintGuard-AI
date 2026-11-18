// 쪽의 내용 스트림을 직접 읽어 **잉크로 사고가 나는 자리**를 찾는다.
//
// 왜 pdf.js로 하지 않나: pdf.js는 화면에 그리기 위해 CMYK 색을 RGB로 바꿔서 넘겨준다. 그러면
// 'C60 M50 Y50 K100인 7pt 글자'(리치 블랙)도, 'K100'도 똑같이 검정으로 보인다. 잉크량·오버프린트·
// 별색은 화면 색에는 없고 **원래 색 연산자**에만 있다. 그래서 연산자를 직접 읽는다.
//
// 찾는 것(모두 인쇄소에서 실제로 자주 되돌아오는 것):
//   richblack    작은 글자가 4색 검정 — 판이 조금만 어긋나도 글자 테두리에 색이 번진다
//   rgbblack     RGB 검정 글자 — CMYK로 바꾸면 4색 검정이 된다(위와 같은 사고)
//   tac          벡터 면·글자의 총 잉크량이 한도를 넘는다 — 뒷묻음·마름 불량
//   overprint    흰색에 오버프린트 — 화면에는 보이고 인쇄하면 사라진다
//   registration 레지스트레이션 색(별색 'All') — 모든 판에 100%씩, 400% 잉크가 올라간다
//   hairline     너무 가는 선(또는 두께 0) — 인쇄에서 끊기거나 사라진다
//   rgbvector    RGB로 칠한 면·글자 — PDF/X-1a는 받지 않는다
// 그리고 문서 전체에서 별색 이름과 투명도 사용 여부를 모은다.
//
// 이 검사는 **알려 주기만 한다.** 고치지 않는다. '작은 검정 글자를 K100으로'는 사람이 하는 일이
// 정해져 있어 보이지만, 인디자인에서 그 색은 견본(swatch) 하나를 여러 곳이 같이 쓴다 — 큰 제목이나
// 배경의 리치 블랙은 일부러 쓴 것이다. 견본을 바꾸면 그쪽까지 바뀐다. 저해상도 사진을 줄여 '고쳤던'
// 일과 같은 자리라 기계가 정하지 않는다.
import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, StandardFontEmbedder, StandardFonts, decodePDFRawStream,
} from "pdf-lib";

export type InkKind = "richblack" | "rgbblack" | "tac" | "overprint" | "registration" | "hairline" | "rgbvector";
export type InkFinding = {
  kind: InkKind; page: number; count: number;
  rect: number[];      // PDF 사용자 공간 [x0,y0,x1,y1] (아래가 0)
  minSize?: number;    // 가장 작은 글자 크기(pt)
  maxTac?: number;     // 가장 큰 잉크량(%)
  minWidth?: number;   // 가장 가는 선(pt). 0이면 '두께 0'
  sample?: string;     // 예: 'C60 M50 Y50 K100'
};
export type InkSpec = { tacLimit: number; minLinePt: number; richBlackMaxPt: number };
export type InkReport = { findings: InkFinding[]; spots: string[]; transparency: boolean; truncated: boolean };

type Mat = number[];
type Color = { fam: "gray" | "rgb" | "cmyk" | "sep" | "devn" | "other"; comps: number[]; names?: string[] };
type CS = { fam: Color["fam"]; n: number; names?: string[] };
type GState = { ctm: Mat; fill: Color; stroke: Color; fillCS: CS; strokeCS: CS; lw: number; opFill: boolean; opStroke: boolean };
// 문자열은 바이트 그대로(한 글자 = 한 바이트인 latin1 문자열) 들고 간다 — 글자 폭을 글꼴 표에서 찾으려면 코드 값이 필요하다
type Tok = { t: "num"; v: number } | { t: "name"; v: string } | { t: "str"; s: string } | { t: "arr"; v: Tok[] } | { t: "dict" } | { t: "mark"; v: "[" | "<<" };
// 글꼴에서 글자 폭(1/1000 글자 크기)을 읽는 법. 2바이트 글꼴(Type0, 한글 글꼴 대부분)은 두 바이트가 한 글자다
type FontInfo = { twoByte: boolean; width: (code: number) => number };
const STD14 = new Set<string>(Object.values(StandardFonts));
const FALLBACK: FontInfo = { twoByte: false, width: () => 500 };

const N = (s: string) => PDFName.of(s);
const ID: Mat = [1, 0, 0, 1, 0, 0];
// 사용 순서는 analyze.ts의 mul과 같다: mul(m, n)은 n을 먼저 적용하고 m을 적용한다(PDF의 `n × m`).
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m: Mat, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const scaleOf = (m: Mat) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

const BLACK: Color = { fam: "gray", comps: [0] };
const GRAY: CS = { fam: "gray", n: 1 };
// 내용 스트림이 아주 큰 문서(지도·도표 수만 개)에서 검사가 멈추지 않게 연산 수를 자른다. 자르면 그렇다고 알린다.
const MAX_OPS = 1_500_000;

const isWS = (c: number) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDelim = (c: number) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

/** 색을 CMYK 판 농도(0~1)로. 알 수 없으면 null. 별색은 이름이 공정색일 때만 판으로 친다. */
function plates(c: Color): { c: number; m: number; y: number; k: number; other: number } | null {
  if (c.fam === "cmyk") return { c: c.comps[0] ?? 0, m: c.comps[1] ?? 0, y: c.comps[2] ?? 0, k: c.comps[3] ?? 0, other: 0 };
  if (c.fam === "sep" || c.fam === "devn") {
    const p = { c: 0, m: 0, y: 0, k: 0, other: 0 };
    (c.names ?? []).forEach((nm, i) => {
      const v = c.comps[i] ?? 0;
      const key = ({ Cyan: "c", Magenta: "m", Yellow: "y", Black: "k" } as const)[nm as "Cyan"];
      if (key) p[key] += v; else p.other += v;
    });
    return p;
  }
  return null;
}

function isWhite(c: Color): boolean {
  if (c.fam === "gray") return (c.comps[0] ?? 0) >= 0.995;
  if (c.fam === "rgb") return c.comps.length >= 3 && c.comps.every((v) => v >= 0.995);
  if (c.fam === "cmyk" || c.fam === "sep" || c.fam === "devn") return c.comps.length > 0 && c.comps.every((v) => v <= 0.005);
  return false;
}

const pct = (v: number) => Math.round(v * 100);
const sampleOf = (p: NonNullable<ReturnType<typeof plates>>) =>
  `C${pct(p.c)} M${pct(p.m)} Y${pct(p.y)} K${pct(p.k)}${p.other ? ` + 별색 ${pct(p.other)}%` : ""}`;

export function inspectInk(doc: PDFDocument, spec: InkSpec): InkReport {
  const look = <T,>(o: unknown): T => doc.context.lookup(o as PDFRef) as T;
  const findings: InkFinding[] = [];
  const spots = new Set<string>();
  let transparency = false;
  let ops = 0;
  let truncated = false;

  const numOf = (o: unknown): number | undefined => { const v = look<unknown>(o); return v instanceof PDFNumber ? v.asNumber() : undefined; };
  const nameOf = (o: unknown): string | undefined => { const v = look<unknown>(o); return v instanceof PDFName ? v.decodeText() : undefined; };

  function resolveCS(o: unknown, res: PDFDict | undefined, depth = 0): CS {
    const v = look<unknown>(o);
    if (v instanceof PDFName) {
      const n = v.decodeText();
      if (n === "DeviceGray" || n === "G" || n === "CalGray") return GRAY;
      if (n === "DeviceRGB" || n === "RGB" || n === "CalRGB") return { fam: "rgb", n: 3 };
      if (n === "DeviceCMYK" || n === "CMYK") return { fam: "cmyk", n: 4 };
      if (n === "Pattern") return { fam: "other", n: 0 };
      const named = res?.lookupMaybe(N("ColorSpace"), PDFDict)?.get(N(n));
      return named && depth < 4 ? resolveCS(named, res, depth + 1) : { fam: "other", n: 0 };
    }
    if (v instanceof PDFArray) {
      const head = nameOf(v.get(0));
      if (head === "ICCBased") {
        const s = look<unknown>(v.get(1));
        const d = s instanceof PDFRawStream || s instanceof PDFStream ? (s as PDFRawStream).dict : null;
        const n = d ? numOf(d.get(N("N"))) : undefined;
        return n === 4 ? { fam: "cmyk", n: 4 } : n === 1 ? GRAY : { fam: "rgb", n: 3 };
      }
      if (head === "CalRGB") return { fam: "rgb", n: 3 };
      if (head === "CalGray") return GRAY;
      if (head === "Separation") {
        const nm = nameOf(v.get(1)) ?? "?";
        if (nm !== "All" && nm !== "None") spots.add(nm);
        return { fam: "sep", n: 1, names: [nm] };
      }
      if (head === "DeviceN") {
        const arr = look<unknown>(v.get(1));
        const names = arr instanceof PDFArray ? arr.asArray().map((x) => nameOf(x) ?? "?") : [];
        names.filter((nm) => !["Cyan", "Magenta", "Yellow", "Black", "None", "All"].includes(nm)).forEach((nm) => spots.add(nm));
        return { fam: "devn", n: names.length, names };
      }
    }
    return { fam: "other", n: 0 };
  }

  const initial = (cs: CS): Color => ({ fam: cs.fam, names: cs.names,
    comps: cs.fam === "cmyk" ? [0, 0, 0, 1] : cs.fam === "sep" || cs.fam === "devn" ? new Array(cs.n).fill(1) : cs.fam === "rgb" ? [0, 0, 0] : [0] });

  // 쪽마다 [종류] → 모은 것
  type Acc = InkFinding;
  let acc = new Map<InkKind, Acc>();
  let pageNo = 0;
  function hit(kind: InkKind, box: number[], extra: Partial<InkFinding> = {}) {
    const a = acc.get(kind);
    if (!a) { acc.set(kind, { kind, page: pageNo, count: 1, rect: box.slice(), ...extra }); return; }
    a.count++;
    a.rect = [Math.min(a.rect[0], box[0]), Math.min(a.rect[1], box[1]), Math.max(a.rect[2], box[2]), Math.max(a.rect[3], box[3])];
    if (extra.minSize !== undefined) a.minSize = Math.min(a.minSize ?? Infinity, extra.minSize);
    if (extra.minWidth !== undefined) a.minWidth = Math.min(a.minWidth ?? Infinity, extra.minWidth);
    if (extra.maxTac !== undefined && extra.maxTac > (a.maxTac ?? -1)) { a.maxTac = extra.maxTac; a.sample = extra.sample ?? a.sample; }
  }

  /** 칠하는 색 하나를 보고 맞는 항목에 적는다. text면 글자 크기를 같이 본다. */
  function checkPaint(c: Color, overprint: boolean, box: number[], text: number | null) {
    const white = isWhite(c);
    if (overprint && white) hit("overprint", box);
    if (white) return;
    const p = plates(c);
    if ((c.fam === "sep" || c.fam === "devn") && c.names?.includes("All") && c.comps[c.names.indexOf("All")] > 0.005) {
      hit("registration", box);
      return;
    }
    if (c.fam === "rgb") {
      hit("rgbvector", box);
      if (text !== null && text < spec.richBlackMaxPt && c.comps.every((v) => v <= 0.05)) hit("rgbblack", box, { minSize: text });
      return;
    }
    if (!p) return;
    const tac = (p.c + p.m + p.y + p.k + p.other) * 100;
    if (tac > spec.tacLimit + 0.5) hit("tac", box, { maxTac: tac, sample: sampleOf(p) });
    if (text !== null && text < spec.richBlackMaxPt && p.k >= 0.95 && p.c + p.m + p.y >= 0.15)
      hit("richblack", box, { minSize: text, maxTac: tac, sample: sampleOf(p) });
  }

  /** 글꼴 사전에서 글자 폭 표를 꺼낸다. 표가 없으면 표준 14글꼴은 pdf-lib의 폭 표를, 그 밖은 글자 크기의 절반을 쓴다. */
  const fontCache = new Map<unknown, FontInfo>();
  function fontOf(name: string, res: PDFDict | undefined): FontInfo {
    const ref = res?.lookupMaybe(N("Font"), PDFDict)?.get(N(name));
    if (!ref) return FALLBACK;
    const hit = fontCache.get(ref);
    if (hit) return hit;
    let info = FALLBACK;
    try {
      const f = look<unknown>(ref);
      if (f instanceof PDFDict) {
        const sub = nameOf(f.get(N("Subtype")));
        if (sub === "Type0") {
          // 한글 글꼴은 거의 이쪽이다. 폭은 자손 글꼴의 /W([첫CID [폭…]] 또는 [첫 끝 폭])와 /DW(기본 1000)
          const d = look<unknown>(f.get(N("DescendantFonts")));
          const cid = d instanceof PDFArray ? look<unknown>(d.get(0)) : undefined;
          const widths = new Map<number, number>();
          let dw = 1000;
          if (cid instanceof PDFDict) {
            dw = numOf(cid.get(N("DW"))) ?? 1000;
            const w = look<unknown>(cid.get(N("W")));
            const arr = w instanceof PDFArray ? w.asArray().map((x) => look<unknown>(x)) : [];
            for (let i = 0; i < arr.length;) {
              const first = arr[i] instanceof PDFNumber ? (arr[i] as PDFNumber).asNumber() : NaN;
              const next = arr[i + 1];
              if (next instanceof PDFArray) {
                next.asArray().forEach((x, k) => widths.set(first + k, numOf(x) ?? dw));
                i += 2;
              } else {
                const last = next instanceof PDFNumber ? next.asNumber() : first;
                const v = numOf(arr[i + 2]) ?? dw;
                for (let c = first; c <= last && c - first < 70000; c++) widths.set(c, v);
                i += 3;
              }
            }
          }
          // CID와 코드가 같다고 본다(Identity-H — 인디자인·워드가 내는 PDF가 그렇다). 다른 CMap이면 기본 폭으로 어림한다
          info = { twoByte: true, width: (c) => widths.get(c) ?? dw };
        } else {
          const wArr = look<unknown>(f.get(N("Widths")));
          const firstChar = numOf(f.get(N("FirstChar"))) ?? 0;
          const desc = f.lookupMaybe(N("FontDescriptor"), PDFDict);
          const missing = (desc && numOf(desc.get(N("MissingWidth")))) || 0;
          if (wArr instanceof PDFArray) {
            const ws = wArr.asArray().map((x) => numOf(x) ?? 0);
            info = { twoByte: false, width: (c) => ws[c - firstChar] ?? (missing || 500) };
          } else {
            const base = (nameOf(f.get(N("BaseFont"))) ?? "").replace(/^[A-Z]{6}\+/, "");
            if (STD14.has(base)) {
              // 표준 14글꼴은 폭 표를 싣지 않아도 된다(뷰어가 안다). pdf-lib에 같은 표가 있다
              const emb = StandardFontEmbedder.for(base as unknown as Parameters<typeof StandardFontEmbedder.for>[0]);
              info = { twoByte: false, width: (c) => { try { return emb.widthOfTextAtSize(String.fromCharCode(c), 1000); } catch { return 500; } } };
            }
          }
        }
      }
    } catch { info = FALLBACK; }
    fontCache.set(ref, info);
    return info;
  }

  function contentOf(o: unknown): string {
    const parts: string[] = [];
    const one = (x: unknown) => {
      const s = look<unknown>(x);
      let bytes: Uint8Array | null = null;
      if (s instanceof PDFRawStream) {
        try { bytes = decodePDFRawStream(s).decode(); } catch { bytes = null; }
      } else if (s instanceof PDFStream) {
        try { bytes = (s as unknown as { getContents(): Uint8Array }).getContents(); } catch { bytes = null; }
      }
      if (bytes) parts.push(latin1(bytes));
    };
    const v = look<unknown>(o);
    if (v instanceof PDFArray) v.asArray().forEach(one); else if (v) one(o);
    return parts.join("\n");
  }

  function run(src: string, res: PDFDict | undefined, start: GState, depth: number) {
    let g: GState = { ...start };
    const stack: GState[] = [];
    const tstack: { fontSize: number; font: FontInfo; charSp: number; wordSp: number; hScale: number; leading: number; rise: number; mode: number }[] = [];
    let operands: Tok[] = [];
    // 글자 상태
    let fontSize = 0, Tm: Mat = ID, Tlm: Mat = ID, leading = 0, mode = 0, rise = 0;
    let charSp = 0, wordSp = 0, hScale = 1, font: FontInfo = FALLBACK;
    // 경로
    let pathBox: number[] | null = null;
    const addPt = (x: number, y: number) => {
      const [px, py] = apply(g.ctm, x, y);
      pathBox = pathBox ? [Math.min(pathBox[0], px), Math.min(pathBox[1], py), Math.max(pathBox[2], px), Math.max(pathBox[3], py)] : [px, py, px, py];
    };
    const nums = () => operands.filter((o): o is { t: "num"; v: number } => o.t === "num").map((o) => o.v);
    /** 글자를 찍는다. 폭은 글꼴의 폭 표로 잰다(PDF 32000 9.4.4 — 글자 폭·글자 간격 Tc·낱말 간격 Tw·가로 비율 Tz·TJ의 조정값).
     *  처음에는 '한 바이트 ≈ 글자 크기 절반'으로 어림해서 쪽 위 네모가 글줄과 어긋났다. */
    const showText = (t: Tok | undefined) => {
      if (!t) return;
      const parts: (string | number)[] = t.t === "str" ? [t.s]
        : t.t === "arr" ? t.v.flatMap((x): (string | number)[] => (x.t === "str" ? [x.s] : x.t === "num" ? [x.v] : [])) : [];
      if (!parts.some((p) => typeof p === "string" && p.length)) return;
      const start = Tm;
      let adv = 0;
      for (const p of parts) {
        if (typeof p === "number") { adv -= (p / 1000) * fontSize * hScale; continue; }
        const step = font.twoByte ? 2 : 1;
        for (let k = 0; k + step <= p.length; k += step) {
          const code = step === 2 ? (p.charCodeAt(k) << 8) | p.charCodeAt(k + 1) : p.charCodeAt(k);
          adv += ((font.width(code) / 1000) * fontSize + charSp + (!font.twoByte && code === 32 ? wordSp : 0)) * hScale;
        }
      }
      Tm = mul(Tm, [1, 0, 0, 1, adv, 0]);
      if (mode === 3 || mode === 7) return; // 안 보이는 글자(스캔 문서의 OCR 층)는 잉크가 없다
      const m = mul(g.ctm, start);
      const size = Math.abs(fontSize) * Math.hypot(m[2], m[3]);
      // 위아래는 글꼴마다 다르지만 대개 글자 크기의 0.9 위, 0.2 아래다. 돌아간 글줄도 네 귀퉁이를 옮겨 감싼다
      const lo = rise - 0.2 * fontSize, hi = rise + 0.9 * fontSize;
      const pts = [[0, lo], [adv, lo], [0, hi], [adv, hi]].map(([x, y]) => apply(m, x, y));
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
      const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      if (mode === 0 || mode === 2 || mode === 4 || mode === 6) checkPaint(g.fill, g.opFill, box, size);
    };
    const paint = (fill: boolean, stroke: boolean) => {
      const box = pathBox;
      pathBox = null;
      if (!box) return;
      if (fill) checkPaint(g.fill, g.opFill, box, null);
      if (stroke) {
        if (g.opStroke && isWhite(g.stroke)) hit("overprint", box);
        const eff = g.lw * scaleOf(g.ctm);
        if (!isWhite(g.stroke) && eff < spec.minLinePt - 1e-6 && (box[2] - box[0] > 2 || box[3] - box[1] > 2))
          hit("hairline", [box[0] - 2, box[1] - 2, box[2] + 2, box[3] + 2], { minWidth: eff });
        // 선의 잉크량·레지스트레이션도 면과 같이 본다(흰 선 오버프린트는 위에서 봤다)
        if (!isWhite(g.stroke)) checkPaint(g.stroke, false, box, null);
      }
    };

    const exec = (op: string) => {
      const a = nums();
      switch (op) {
        // 글자 상태(크기·글꼴·간격·비율·행간·올림·찍는 방식)도 그래픽 상태의 일부라 q/Q가 같이 저장·복원한다(PDF 32000 8.4.1)
        case "q": stack.push({ ...g }); tstack.push({ fontSize, font, charSp, wordSp, hScale, leading, rise, mode }); break;
        case "Q": {
          g = stack.pop() ?? g;
          const ts = tstack.pop();
          if (ts) ({ fontSize, font, charSp, wordSp, hScale, leading, rise, mode } = ts);
          break;
        }
        case "cm": if (a.length >= 6) g.ctm = mul(g.ctm, a.slice(-6)); break;
        case "w": if (a.length) g.lw = a[a.length - 1]; break;
        case "gs": {
          const nm = operands.find((o) => o.t === "name") as { v: string } | undefined;
          const gsd = nm ? res?.lookupMaybe(N("ExtGState"), PDFDict)?.lookupMaybe(N(nm.v), PDFDict) : undefined;
          if (gsd) {
            const bool = (k: string) => { const v = look<unknown>(gsd.get(N(k))); return v === undefined ? undefined : String(v) === "true"; };
            const OP = bool("OP"), opf = bool("op");
            if (OP !== undefined) { g.opStroke = OP; if (opf === undefined) g.opFill = OP; }
            if (opf !== undefined) g.opFill = opf;
            const lw = numOf(gsd.get(N("LW"))); if (lw !== undefined) g.lw = lw;
            const sm = look<unknown>(gsd.get(N("SMask")));
            const ca = numOf(gsd.get(N("ca"))), CA = numOf(gsd.get(N("CA"))), bm = nameOf(gsd.get(N("BM")));
            if ((sm && !(sm instanceof PDFName && sm.decodeText() === "None")) || (ca !== undefined && ca < 1) || (CA !== undefined && CA < 1)
              || (bm && bm !== "Normal" && bm !== "Compatible")) transparency = true;
          }
          break;
        }
        // 색
        case "g": g.fill = { fam: "gray", comps: a.slice(-1) }; g.fillCS = GRAY; break;
        case "G": g.stroke = { fam: "gray", comps: a.slice(-1) }; g.strokeCS = GRAY; break;
        case "rg": g.fill = { fam: "rgb", comps: a.slice(-3) }; g.fillCS = { fam: "rgb", n: 3 }; break;
        case "RG": g.stroke = { fam: "rgb", comps: a.slice(-3) }; g.strokeCS = { fam: "rgb", n: 3 }; break;
        case "k": g.fill = { fam: "cmyk", comps: a.slice(-4) }; g.fillCS = { fam: "cmyk", n: 4 }; break;
        case "K": g.stroke = { fam: "cmyk", comps: a.slice(-4) }; g.strokeCS = { fam: "cmyk", n: 4 }; break;
        case "cs": case "CS": {
          const nm = operands.find((o) => o.t === "name") as { v: string } | undefined;
          const cs = nm ? resolveCS(N(nm.v), res) : { fam: "other" as const, n: 0 };
          if (op === "cs") { g.fillCS = cs; g.fill = initial(cs); } else { g.strokeCS = cs; g.stroke = initial(cs); }
          break;
        }
        case "sc": case "scn": g.fill = { fam: g.fillCS.fam, names: g.fillCS.names, comps: g.fillCS.n ? a.slice(-g.fillCS.n) : a }; break;
        case "SC": case "SCN": g.stroke = { fam: g.strokeCS.fam, names: g.strokeCS.names, comps: g.strokeCS.n ? a.slice(-g.strokeCS.n) : a }; break;
        // 경로
        case "m": case "l": if (a.length >= 2) addPt(a[a.length - 2], a[a.length - 1]); break;
        case "c": if (a.length >= 6) { addPt(a[0], a[1]); addPt(a[2], a[3]); addPt(a[4], a[5]); } break;
        case "v": case "y": if (a.length >= 4) { addPt(a[0], a[1]); addPt(a[2], a[3]); } break;
        case "re": if (a.length >= 4) { addPt(a[0], a[1]); addPt(a[0] + a[2], a[1] + a[3]); addPt(a[0], a[1] + a[3]); addPt(a[0] + a[2], a[1]); } break;
        case "S": case "s": paint(false, true); break;
        case "f": case "F": case "f*": paint(true, false); break;
        case "B": case "B*": case "b": case "b*": paint(true, true); break;
        case "n": pathBox = null; break;
        // 글자
        case "BT": Tm = ID; Tlm = ID; break;
        case "Tf": {
          if (a.length) fontSize = a[a.length - 1];
          const nm = operands.find((o) => o.t === "name") as { v: string } | undefined;
          font = nm ? fontOf(nm.v, res) : FALLBACK;
          break;
        }
        case "Tc": if (a.length) charSp = a[0]; break;
        case "Tw": if (a.length) wordSp = a[0]; break;
        case "Tz": if (a.length) hScale = a[0] / 100; break;
        case "TL": if (a.length) leading = a[0]; break;
        case "Tr": if (a.length) mode = a[0]; break;
        case "Ts": if (a.length) rise = a[0]; break;
        case "Td": if (a.length >= 2) { Tlm = mul(Tlm, [1, 0, 0, 1, a[0], a[1]]); Tm = Tlm; } break;
        case "TD": if (a.length >= 2) { leading = -a[1]; Tlm = mul(Tlm, [1, 0, 0, 1, a[0], a[1]]); Tm = Tlm; } break;
        case "Tm": if (a.length >= 6) { Tlm = a.slice(-6); Tm = Tlm; } break;
        case "T*": Tlm = mul(Tlm, [1, 0, 0, 1, 0, -leading]); Tm = Tlm; break;
        case "Tj": case "TJ": showText(operands[operands.length - 1]); break;
        case "'": Tlm = mul(Tlm, [1, 0, 0, 1, 0, -leading]); Tm = Tlm; showText(operands[operands.length - 1]); break;
        case "\"": // aw ac string " — 낱말·글자 간격을 정하고 다음 줄에 찍는다
          if (a.length >= 2) { wordSp = a[0]; charSp = a[1]; }
          Tlm = mul(Tlm, [1, 0, 0, 1, 0, -leading]); Tm = Tlm; showText(operands[operands.length - 1]); break;
        // 그림·양식
        case "Do": {
          const nm = operands.find((o) => o.t === "name") as { v: string } | undefined;
          const xo = nm ? res?.lookupMaybe(N("XObject"), PDFDict)?.get(N(nm.v)) : undefined;
          const s = xo ? look<unknown>(xo) : undefined;
          const d = s instanceof PDFRawStream || s instanceof PDFStream ? (s as PDFRawStream).dict : null;
          if (!d) break;
          const sub = nameOf(d.get(N("Subtype")));
          if (sub === "Image") {
            const sm = look<unknown>(d.get(N("SMask")));
            if (sm && !(sm instanceof PDFName)) transparency = true;
          } else if (sub === "Form" && depth < 4) {
            const mat = look<unknown>(d.get(N("Matrix")));
            const fm = mat instanceof PDFArray ? mat.asArray().map((x) => numOf(x) ?? 0) : ID;
            const fres = d.lookupMaybe(N("Resources"), PDFDict) ?? res;
            run(contentOf(xo), fres, { ...g, ctm: mul(g.ctm, fm) }, depth + 1);
          }
          break;
        }
      }
    };

    // ---------- 낱말 읽기 ----------
    const L = src.length;
    let i = 0;
    while (i < L) {
      if (++ops > MAX_OPS) { truncated = true; return; }
      const c = src.charCodeAt(i);
      if (isWS(c)) { i++; continue; }
      if (c === 37) { while (i < L && src.charCodeAt(i) !== 10 && src.charCodeAt(i) !== 13) i++; continue; } // %
      if (c === 40) { // ( 문자열 ) — 이스케이프를 풀어 바이트 그대로 모은다
        let depthP = 1; i++;
        const out: number[] = [];
        const ESC: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 }; // \n \r \t \b \f
        while (i < L && depthP > 0) {
          const d = src.charCodeAt(i);
          if (d === 92) { // \
            const e = src.charCodeAt(i + 1);
            if (e >= 48 && e <= 55) {
              let k = 1; while (k < 3 && src.charCodeAt(i + 1 + k) >= 48 && src.charCodeAt(i + 1 + k) <= 55) k++;
              out.push(parseInt(src.slice(i + 1, i + 1 + k), 8) & 255); i += 1 + k; continue;
            }
            if (e === 13) { i += src.charCodeAt(i + 2) === 10 ? 3 : 2; continue; } // 줄 이음
            if (e === 10) { i += 2; continue; }
            out.push(ESC[e] ?? e); i += 2; continue;
          }
          if (d === 40) depthP++;
          else if (d === 41 && --depthP === 0) { i++; break; }
          out.push(d); i++;
        }
        operands.push({ t: "str", s: String.fromCharCode(...out.slice(0, 20000)) });
        continue;
      }
      if (c === 60) { // < 16진 문자열 > 또는 << 사전
        if (src.charCodeAt(i + 1) === 60) { operands.push({ t: "mark", v: "<<" }); i += 2; continue; }
        const j = src.indexOf(">", i);
        let hex = src.slice(i + 1, j < 0 ? L : j).replace(/[^0-9a-fA-F]/g, "");
        if (hex.length % 2) hex += "0"; // 홀수면 뒤에 0을 붙인다(PDF 규칙)
        let s = "";
        for (let k = 0; k < hex.length && k < 40000; k += 2) s += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
        operands.push({ t: "str", s });
        i = j < 0 ? L : j + 1;
        continue;
      }
      if (c === 62 && src.charCodeAt(i + 1) === 62) { // >>
        const k = operands.map((o) => o.t === "mark" && o.v === "<<").lastIndexOf(true);
        operands = k >= 0 ? operands.slice(0, k) : [];
        operands.push({ t: "dict" });
        i += 2; continue;
      }
      if (c === 91) { operands.push({ t: "mark", v: "[" }); i++; continue; }
      if (c === 93) {
        const k = operands.map((o) => o.t === "mark" && o.v === "[").lastIndexOf(true);
        const inner = k >= 0 ? operands.slice(k + 1) : [];
        operands = k >= 0 ? operands.slice(0, k) : [];
        operands.push({ t: "arr", v: inner });
        i++; continue;
      }
      if (c === 47) { // /이름
        let j = i + 1;
        while (j < L && !isWS(src.charCodeAt(j)) && !isDelim(src.charCodeAt(j))) j++;
        operands.push({ t: "name", v: src.slice(i + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) });
        i = j; continue;
      }
      let j = i;
      while (j < L && !isWS(src.charCodeAt(j)) && !isDelim(src.charCodeAt(j))) j++;
      if (j === i) { i++; continue; } // 짝 없는 구분자 — 건너뛴다
      const word = src.slice(i, j);
      i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { operands.push({ t: "num", v: parseFloat(word) }); continue; }
      if (word === "true" || word === "false" || word === "null") continue;
      if (word === "ID") { // 인라인 그림의 이진 자료는 연산자가 아니다 — EI까지 건너뛴다
        const m = /\sEI(?=\s|$)/g; m.lastIndex = i + 1;
        const r = m.exec(src);
        i = r ? r.index + r[0].length : L;
        operands = [];
        continue;
      }
      exec(word);
      operands = [];
    }
  }

  const pages = doc.getPages();
  pages.forEach((p, idx) => {
    pageNo = idx + 1;
    acc = new Map();
    const res = p.node.Resources();
    // 쪽의 색 공간을 미리 한 번 훑는다 — 쓰지 않아도 이름이 겹친 별색은 출력소에서 판이 갈린다
    const csd = res?.lookupMaybe(N("ColorSpace"), PDFDict);
    if (csd) for (const [, v] of csd.entries()) resolveCS(v, res);
    const grp = p.node.lookupMaybe(N("Group"), PDFDict);
    void grp; // 쪽 투명 그룹은 인디자인이 투명도가 없어도 넣는 경우가 있어 '투명도 사용'으로 세지 않는다
    if (!truncated) run(contentOf(p.node.get(N("Contents"))), res,
      { ctm: ID, fill: BLACK, stroke: BLACK, fillCS: GRAY, strokeCS: GRAY, lw: 1, opFill: false, opStroke: false }, 0);
    findings.push(...acc.values());
  });
  return { findings, spots: [...spots].sort(), transparency, truncated };
}

/** 이름이 다른데 같은 별색으로 보이는 것들(대소문자·띄어쓰기·'PANTONE' 접두만 다른 것). */
export function spotDuplicates(spots: string[]): string[][] {
  const key = (s: string) => s.toLowerCase().replace(/^pantone\s*/, "").replace(/[\s_-]+/g, "");
  const groups = new Map<string, string[]>();
  for (const s of spots) groups.set(key(s), [...(groups.get(key(s)) ?? []), s]);
  return [...groups.values()].filter((g) => g.length > 1);
}

function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}
