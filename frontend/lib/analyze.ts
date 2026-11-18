// 브라우저(또는 Node)에서 PDF를 직접 분석하는 규칙 기반 프리플라이트. 서버 없이 동작한다.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFStream } from "pdf-lib";
import { heatRGBA, type ColorEngine, type ColorStats } from "./color";
import MISUSE_JSON from "@/public/data/korean-misuse.json";
import { inspectInk, spotDuplicates, type InkFinding } from "./inkcheck";
import { DEFAULT_SPEC, type SpecOption } from "./printspec";

export type Sev = "high" | "medium" | "low";
export type Issue = {
  id: number; kind: string; severity: Sev; page: number; title: string; detail: string; fix: string;
  rect: number[] | null; // 페이지 좌상단 기준 [x0,y0,x1,y1] (pt)
  source: "rule" | "heuristic" | "proofread";
  metrics?: ColorMetrics; // 색 차이 측정값 (RGB 이미지)
  // 기계가 그대로 적용할 수 있는 교정(교정 에이전트의 제안). 원본 파일에서 이 글자를 찾아 바꾼다.
  // 사람이 판단해야 하는 항목(여백 부족, 수치 불일치 등)에는 없다 — 그래서 선택이다.
  edit?: { original: string; suggestion: string };
  heat?: { w: number; h: number; rgba: Uint8ClampedArray }; // ΔE 지도
  // **사람이 고칠 것**에 붙이는 판단 재료. '해상도 낮음'만 말하면 사람은 다시 계산해야 한다 —
  // 몇 px짜리 원본이 필요한지, 지금 사진으로 어디까지 키울 수 있는지를 숫자로 같이 준다.
  advice?: { label: string; value: string }[];
};
/** 브랜드 키트의 '우리 회사 표기'. 틀린 표기 → 맞는 표기. */
export type HouseTerm = { wrong: string; right: string };
export type PageInfo = { w: number; h: number };
export type Analysis = {
  pages: number; pageSizes: PageInfo[]; issues: Issue[]; colorSummary: Record<string, number>; texts: string[];
  colorReport: ColorReport | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfJs = any;
const MM = 72 / 25.4;
const SEV: Record<Sev, number> = { high: 0, medium: 1, low: 2 };
const N = (s: string) => PDFName.of(s);

function mk(kind: string, severity: Sev, page: number, title: string, detail: string, fix: string,
  rect: number[] | null = null, source: Issue["source"] = "rule"): Issue {
  return { id: 0, kind, severity, page, title, detail, fix, rect, source };
}

type Box = { x: number; y: number; width: number; height: number };
function boxOf(arr: PDFArray | undefined): Box | null {
  if (!arr) return null;
  const r = arr.asRectangle();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

type ImgMeta = { w: number; h: number; cs: string };

function csName(cs: unknown, ctxLookup: (o: unknown) => unknown): string {
  const v = ctxLookup(cs);
  if (v instanceof PDFName) return v.decodeText().replace(/^\//, "");
  if (v instanceof PDFArray) {
    const head = ctxLookup(v.get(0));
    const hn = head instanceof PDFName ? head.decodeText() : "";
    if (hn === "ICCBased") {
      const s = ctxLookup(v.get(1));
      const dict = s instanceof PDFRawStream || s instanceof PDFStream ? (s as PDFRawStream).dict : null;
      const n = dict ? (ctxLookup(dict.get(N("N"))) as PDFNumber | undefined)?.asNumber() : undefined;
      return n === 4 ? "DeviceCMYK" : n === 1 ? "DeviceGray" : "DeviceRGB";
    }
    if (hn === "Indexed") return csName(v.get(1), ctxLookup) + "(Indexed)";
    return hn;
  }
  return "unknown";
}

function collectImages(doc: PDFDocument, res: PDFDict | undefined, out: ImgMeta[], depth = 0, seen = new Set<unknown>()) {
  if (!res || depth > 2) return;
  const look = (o: unknown) => doc.context.lookup(o as never);
  const xo = res.lookupMaybe(N("XObject"), PDFDict);
  if (!xo) return;
  for (const [, ref] of xo.entries()) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const s = look(ref);
    const dict = s instanceof PDFRawStream || s instanceof PDFStream ? (s as PDFRawStream).dict : null;
    if (!dict) continue;
    const sub = dict.get(N("Subtype"));
    if (sub === N("Image")) {
      const w = (look(dict.get(N("Width"))) as PDFNumber | undefined)?.asNumber() ?? 0;
      const h = (look(dict.get(N("Height"))) as PDFNumber | undefined)?.asNumber() ?? 0;
      const isMask = look(dict.get(N("ImageMask"))) !== undefined && String(look(dict.get(N("ImageMask")))) === "true";
      out.push({ w, h, cs: isMask ? "Mask" : csName(dict.get(N("ColorSpace")), look) });
    } else if (sub === N("Form")) {
      collectImages(doc, dict.lookupMaybe(N("Resources"), PDFDict), out, depth + 1, seen);
    }
  }
}

function checkFonts(doc: PDFDocument): Issue[] {
  const out: Issue[] = [];
  const pages = doc.getPages();
  const reported = new Set<string>();
  pages.forEach((page, i) => {
    const res = page.node.Resources();
    const fonts = res?.lookupMaybe(N("Font"), PDFDict);
    if (!fonts) return;
    for (const [name, ref] of fonts.entries()) {
      const f = doc.context.lookup(ref, PDFDict);
      let base = (f.get(N("BaseFont")) as PDFName | undefined)?.decodeText() ?? name.decodeText();
      base = base.replace(/^[A-Z]{6}\+/, "");
      const subtype = (f.get(N("Subtype")) as PDFName | undefined)?.decodeText();
      if (subtype === "Type3") continue;
      let target: PDFDict | undefined = f;
      if (subtype === "Type0") {
        const d = f.lookupMaybe(N("DescendantFonts"), PDFArray);
        target = d ? doc.context.lookup(d.get(0), PDFDict) : undefined;
      }
      const desc = target?.lookupMaybe(N("FontDescriptor"), PDFDict);
      const embedded = !!desc && (desc.has(N("FontFile")) || desc.has(N("FontFile2")) || desc.has(N("FontFile3")));
      const key = `${i}:${base}`;
      if (!embedded && !reported.has(key)) {
        reported.add(key);
        out.push(mk("font", "high", i + 1, `폰트 미임베딩: ${base}`,
          "PDF에 폰트가 포함되지 않아 인쇄소에서 대체 폰트로 출력될 수 있습니다.",
          "내보내기 옵션에서 폰트 포함(Embed) 또는 아웃라인 처리하세요."));
      }
    }
  });
  return out;
}

type Placed = { w: number; h: number; rect: number[]; widthPt: number; obj?: PdfImage };
// pdf.js가 디코드한 이미지 객체 (kind 2 = RGB 24비트, 3 = RGBA 32비트, 브라우저에서는 bitmap일 수 있음)
type PdfImage = { width: number; height: number; kind?: number; data?: Uint8ClampedArray; bitmap?: ImageBitmap };

const MAX_SAMPLE_PIXELS = 60000;

/** 이미지 객체에서 RGB 픽셀을 꺼내 최대 MAX_SAMPLE_PIXELS 개로 줄인다(최근접). */
function sampleRGB(obj: PdfImage): { w: number; h: number; rgb: Uint8Array } | null {
  let src: Uint8ClampedArray | undefined, stride = 3;
  if (obj.data && obj.kind === 2) src = obj.data;
  else if (obj.data && obj.kind === 3) { src = obj.data; stride = 4; }
  else if (obj.bitmap && typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = obj.width; c.height = obj.height;
    const g = c.getContext("2d");
    if (!g) return null;
    g.drawImage(obj.bitmap, 0, 0);
    src = g.getImageData(0, 0, obj.width, obj.height).data; stride = 4;
  }
  if (!src) return null;
  const f = Math.max(1, Math.ceil(Math.sqrt((obj.width * obj.height) / MAX_SAMPLE_PIXELS)));
  const w = Math.ceil(obj.width / f), h = Math.ceil(obj.height / f);
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((y * f) * obj.width + x * f) * stride, d = (y * w + x) * 3;
    rgb[d] = src[s]; rgb[d + 1] = src[s + 1]; rgb[d + 2] = src[s + 2];
  }
  return { w, h, rgb };
}

export type ColorMetrics = ColorStats & { areaShare: number; widthPx: number; heightPx: number; profile: string; sampled: number };
export type ColorReport = {
  profile: string; images: number; areaShare: number; weightedMeanDE: number; areaOver5: number; areaOver10: number; areaOverTAC: number;
};

async function placedImages(pdfjs: PdfJs, page: PdfJs): Promise<Placed[]> {
  const OPS = pdfjs.OPS;
  const ol = await page.getOperatorList();
  const out: Placed[] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const mul = (m: number[], n: number[]) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], args = ol.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args?.[0]) ctm = mul(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      let w = 0, h = 0;
      if (fn === OPS.paintImageXObject) {
        const id = args[0];
        const obj = page.objs.has(id) ? page.objs.get(id) : page.commonObjs.has(id) ? page.commonObjs.get(id) : null;
        w = args[1] ?? obj?.width ?? 0; h = args[2] ?? obj?.height ?? 0;
      } else { w = args[0]?.width ?? 0; h = args[0]?.height ?? 0; }
      const xs = [0, 1, 0, 1].map((u, k) => ctm[0] * u + ctm[2] * [0, 0, 1, 1][k] + ctm[4]);
      const ys = [0, 1, 0, 1].map((u, k) => ctm[1] * u + ctm[3] * [0, 0, 1, 1][k] + ctm[5]);
      let obj: PdfImage | undefined;
      if (fn === OPS.paintImageXObject) {
        const id = args[0];
        obj = page.objs.has(id) ? page.objs.get(id) : page.commonObjs.has(id) ? page.commonObjs.get(id) : undefined;
      } else if (fn === OPS.paintInlineImageXObject) obj = args[0];
      out.push({ w, h, rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        widthPt: Math.hypot(ctm[0], ctm[1]), obj });
    }
  }
  return out;
}

export async function analyze(
  data: Uint8Array, pdfjs: PdfJs,
  // misuse: 맞춤법 사전을 여기서 돌릴지. 에이전트 검사에서는 **교정 에이전트가 같은 사전을 돌리므로**
  // preflight가 또 돌리면 같은 교정이 두 번 나온다. 브라우저 혼자 검사할 때만 켠다.
  // spec: 인쇄소 규격(lib/printspec). 비우면 전과 같은 기준(DEFAULT_SPEC)으로 본다.
  // terms: 브랜드 키트의 표기 사전. misuse와 같이 움직인다 — 에이전트 검사에서는 교정 에이전트가 같은 사전을 돌린다.
  opts: { widthMm: number; heightMm: number; bleedMm: number; color?: ColorEngine | null; misuse?: boolean;
    spec?: Partial<SpecOption> | null; terms?: HouseTerm[] },
): Promise<Analysis> {
  const spec: SpecOption = { ...DEFAULT_SPEC, ...(opts.spec ?? {}) };
  // 잉크량 한도는 색 엔진(종이 프로파일)이 정한 값이 있으면 그것을 따른다 — 사진과 벡터가 서로 다른 한도로 재이면 안 된다
  const tacLimit = opts.color?.tacLimit ?? spec.tacLimit;
  const issues: Issue[] = [];
  const colorImgs: { area: number; pageArea: number; stats: ColorStats }[] = [];
  const doc = await PDFDocument.load(data, { ignoreEncryption: false, updateMetadata: false });
  const pages = doc.getPages();
  const task = pdfjs.getDocument({ data: data.slice(), useSystemFonts: false, isEvalSupported: false });
  const pjs = await task.promise;
  const pageSizes: PageInfo[] = [];
  const texts: string[] = [];
  const summary: Record<string, number> = {};
  const expect = opts.widthMm && opts.heightMm ? [opts.widthMm * MM, opts.heightMm * MM] : null;
  const views: number[][] = []; // 쪽마다 [vx0, vy0, vh, vw] — 잉크 검사의 자리를 화면 좌표로 옮길 때 쓴다

  for (let i = 0; i < pages.length; i++) {
    const p = i + 1;
    const lp = pages[i];
    const media = boxOf(lp.node.MediaBox()) ?? lp.getMediaBox();
    const trimArr = boxOf(lp.node.TrimBox());
    const jsPage = await pjs.getPage(p);
    const [vx0, vy0, vx1, vy1] = jsPage.view as number[];
    const vw = vx1 - vx0, vh = vy1 - vy0;
    pageSizes.push({ w: vw, h: vh });
    views.push([vx0, vy0, vh, vw]);

    // 크기·도련
    const tw = trimArr ? trimArr.width : media.width, th = trimArr ? trimArr.height : media.height;
    if (expect) {
      const tol = 1.5 * MM;
      const okTrim = Math.abs(tw - expect[0]) < tol && Math.abs(th - expect[1]) < tol;
      const okBleed = !trimArr && Math.abs(media.width - expect[0] - 2 * opts.bleedMm * MM) < tol
        && Math.abs(media.height - expect[1] - 2 * opts.bleedMm * MM) < tol;
      if (!okTrim && !okBleed) {
        issues.push(mk("size", "high", p, "페이지 크기가 설정과 다름",
          `${(tw / MM).toFixed(1)}x${(th / MM).toFixed(1)}mm (설정 ${opts.widthMm}x${opts.heightMm}mm, 도련 ${opts.bleedMm}mm)`,
          "완성 크기와 도련 설정을 확인하거나 PDF를 다시 내보내세요."));
      }
    }
    if (opts.bleedMm > 0) {
      if (!trimArr) {
        if (p === 1) issues.push(mk("bleed", "medium", 1, "TrimBox 정보 없음",
          "재단선(TrimBox)이 없어 도련 영역을 판정할 수 없습니다.",
          "내보내기 시 '재단선/도련 포함'을 켜거나 완성 크기를 입력하세요."));
      } else {
        const b = Math.min(trimArr.x - media.x, trimArr.y - media.y,
          media.x + media.width - (trimArr.x + trimArr.width), media.y + media.height - (trimArr.y + trimArr.height));
        if (b < opts.bleedMm * MM - 0.5) {
          issues.push(mk("bleed", "high", p, "도련 부족", `실제 도련 ${(b / MM).toFixed(1)}mm < 요구 ${opts.bleedMm}mm`,
            "배경·이미지를 도련 영역까지 확장해 다시 내보내세요."));
        }
      }
    }

    // 이미지: 색 공간·해상도
    const metas: ImgMeta[] = [];
    collectImages(doc, lp.node.Resources(), metas);
    const placed = await placedImages(pdfjs, jsPage);
    for (const im of placed) {
      const meta = metas.find((m) => m.w === im.w && m.h === im.h);
      const cs = meta?.cs ?? "unknown";
      const rect = [im.rect[0] - vx0, vh - (im.rect[3] - vy0), im.rect[2] - vx0, vh - (im.rect[1] - vy0)];
      if (cs.startsWith("DeviceRGB") || cs.startsWith("CalRGB")) {
        summary.rgb = (summary.rgb ?? 0) + 1;
        const sm = opts.color && im.obj ? sampleRGB(im.obj) : null;
        if (opts.color && sm) {
          const { stats, de } = opts.color.analyze(sm.rgb);
          const area = (rect[2] - rect[0]) * (rect[3] - rect[1]);
          const pageArea = vw * vh;
          colorImgs.push({ area, pageArea, stats });
          const sev: Sev = stats.shareOver10 >= 0.2 || stats.shareOverTAC > 0.01 ? "high"
            : stats.p95DE >= 5 || stats.shareOver5 >= 0.1 ? "medium" : "low";
          const issue = mk("color", sev, p,
            `인쇄 색 차이 예상: 평균 ΔE ${stats.meanDE.toFixed(1)}, 상위 5% ${stats.p95DE.toFixed(1)}`,
            `${im.w}x${im.h}px RGB 이미지를 ${opts.color.description || "선택한 CMYK 프로파일"}로 바꾸면 ${(stats.shareOver5 * 100).toFixed(0)}%의 픽셀이 ΔE00 5를 넘게 달라집니다`
            + `(10 초과 ${(stats.shareOver10 * 100).toFixed(0)}%). 총 잉크량 최대 ${stats.maxTAC.toFixed(0)}%`
            + (stats.shareOverTAC > 0 ? `, 한도 ${stats.tacLimit}% 초과 ${(stats.shareOverTAC * 100).toFixed(1)}%.` : "."),
            "채도가 높은 영역을 소프트 프루프로 확인하고, 인쇄소 프로파일로 CMYK 변환한 뒤 색을 조정하세요.", rect);
          issue.metrics = { ...stats, areaShare: area / pageArea, widthPx: im.w, heightPx: im.h, profile: opts.color.description, sampled: sm.w * sm.h };
          issue.heat = { w: sm.w, h: sm.h, rgba: heatRGBA(de) };
          issues.push(issue);
        } else {
          issues.push(mk("color", "medium", p, "RGB 이미지 포함",
            `${im.w}x${im.h}px RGB 이미지. 출력 조건에 따라 변환 시 색이 달라질 수 있습니다.`,
            "인쇄소 ICC로 소프트 프루프 후 CMYK 변환 여부를 결정하세요.", rect));
        }
      } else if (cs.startsWith("DeviceCMYK")) summary.cmyk = (summary.cmyk ?? 0) + 1;
      if (im.w && im.widthPt > 0 && cs !== "Mask") {
        const dpi = im.w / (im.widthPt / 72);
        if (dpi < spec.minPpi) issues.push(lowRes(p, dpi, im, rect, spec));
      }
    }

    // 텍스트: 추출, 페이지 이탈, 안전 영역
    const tc = await jsPage.getTextContent();
    let text = "";
    let clip: number[] | null = null;
    let safe: number[] | null = null;
    const safePt = spec.safeMm * MM;
    for (const it of tc.items as { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean }[]) {
      text += it.str + (it.hasEOL ? "\n" : "");
      if (!it.str.trim()) continue;
      const x0 = it.transform[4], y0 = it.transform[5], x1 = x0 + it.width, y1 = y0 + (it.height || Math.abs(it.transform[3]));
      const top = [x0 - vx0, vh - (y1 - vy0), x1 - vx0, vh - (y0 - vy0)];
      if (x0 < vx0 - 1 || y0 < vy0 - 1 || x1 > vx1 + 1 || y1 > vy1 + 1) {
        clip = clip ? [Math.min(clip[0], top[0]), Math.min(clip[1], top[1]), Math.max(clip[2], top[2]), Math.max(clip[3], top[3])] : top;
      } else if (trimArr && (x0 < trimArr.x + safePt || x1 > trimArr.x + trimArr.width - safePt
        || y0 < trimArr.y + safePt || y1 > trimArr.y + trimArr.height - safePt)) {
        safe = safe ? [Math.min(safe[0], top[0]), Math.min(safe[1], top[1]), Math.max(safe[2], top[2]), Math.max(safe[3], top[3])] : top;
      }
    }
    texts.push(text);
    if (clip) issues.push(mk("clip", "high", p, "텍스트가 페이지 밖으로 나감",
      "텍스트가 페이지 경계를 넘어 잘릴 수 있습니다.", "텍스트 박스 위치·크기를 조정하세요.", clip));
    if (safe) issues.push(mk("safe", "medium", p, "안전 영역 침범 의심",
      `글자가 재단선 안쪽 ${spec.safeMm}mm 이내에 있어 재단 오차로 잘릴 수 있습니다.`,
      `중요한 글자는 재단선에서 ${spec.safeMm}mm보다 안쪽에 두세요.`, safe));
  }

  // 출력 의도
  if (!doc.catalog.has(N("OutputIntents"))) {
    // 종류를 'intent'로 따로 둔다. 'color'로 묶어 두면 RGB 이미지와 구별되지 않아, **기계가
    // 고칠 수 있는 것**(PDF/X로 다시 내보내기)과 사람이 봐야 하는 것이 한 이름으로 섞인다.
    issues.push(mk("intent", "low", 1, "출력 의도(Output Intent) 미지정",
      "PDF에 출력 프로파일이 지정되지 않았습니다.", "인쇄소가 지정한 PDF/X 프로파일로 내보내세요."));
  }
  issues.push(...checkFonts(doc));
  issues.push(...checkInk(doc, spec, tacLimit, views));
  issues.push(...checkPdfx(doc, spec, summary));
  issues.push(...checkText(texts, { misuse: opts.misuse !== false, terms: opts.terms }));
  issues.sort((a, b) => SEV[a.severity] - SEV[b.severity] || a.page - b.page);
  issues.forEach((x, k) => (x.id = k + 1));
  await task.destroy?.();
  let colorReport: ColorReport | null = null;
  if (opts.color && colorImgs.length) {
    const totalPage = pageSizes.reduce((s, p) => s + p.w * p.h, 0);
    const A = colorImgs.reduce((s, c) => s + c.area, 0);
    const wsum = (f: (s: ColorStats) => number) => colorImgs.reduce((s, c) => s + c.area * f(c.stats), 0);
    colorReport = {
      profile: opts.color.description, images: colorImgs.length, areaShare: A / totalPage,
      weightedMeanDE: wsum((s) => s.meanDE) / A, areaOver5: wsum((s) => s.shareOver5) / totalPage,
      areaOver10: wsum((s) => s.shareOver10) / totalPage, areaOverTAC: wsum((s) => s.shareOverTAC) / totalPage,
    };
  }
  return { pages: pages.length, pageSizes, issues, colorSummary: summary, texts, colorReport };
}

const f0 = (n: number) => n.toFixed(0);

/** 저해상도 사진. **고치지 않는다** — 사진을 줄여 ppi를 맞추면 지면이 망가진다(PR #121).
 *  대신 사람이 바로 판단할 숫자를 준다: 이 자리에 맞는 원본은 몇 px인지, 지금 사진으로는 어디까지인지. */
function lowRes(p: number, dpi: number, im: Placed, rect: number[], spec: SpecOption): Issue {
  const wMm = im.widthPt / MM, hMm = Math.abs(rect[3] - rect[1]) / MM;
  const px = (mm: number, ppi: number) => Math.ceil((mm / 25.4) * ppi);
  const mm = (pxs: number, ppi: number) => (pxs / ppi) * 25.4;
  const it = mk("resolution", dpi < spec.minPpi * 2 / 3 ? "high" : "medium", p, `이미지 해상도 낮음 (${f0(dpi)}ppi)`,
    `${f0(wMm)}×${f0(hMm)}mm 자리에 ${im.w}×${im.h}px 사진이 놓여 유효 해상도가 ${f0(dpi)}ppi입니다(권장 ${spec.goodPpi}ppi, 최소 ${spec.minPpi}ppi).`,
    "같은 사진의 원본(카메라·스톡 원본 파일)으로 바꾸세요. 크기를 줄여 맞출지는 디자인을 정하는 사람이 판단할 일이라 자동으로 하지 않습니다. "
    + "프로그램으로 키운(업스케일한) 사진은 px만 늘고 선명해지지 않습니다.", rect);
  it.advice = [
    { label: `이 자리에 필요한 원본(${spec.goodPpi}ppi)`, value: `${px(wMm, spec.goodPpi)}×${px(hMm, spec.goodPpi)}px 이상` },
    { label: `최소 기준(${spec.minPpi}ppi)`, value: `${px(wMm, spec.minPpi)}×${px(hMm, spec.minPpi)}px 이상` },
    { label: "지금 사진으로 키울 수 있는 가로", value: `권장 ${f0(mm(im.w, spec.goodPpi))}mm · 최소 기준 ${f0(mm(im.w, spec.minPpi))}mm까지` },
  ];
  return it;
}

// 잉크 검사 결과를 화면의 항목으로. 문구는 '무엇이 왜 사고인지'와 '사람이 무엇을 하면 되는지'를 같이 쓴다.
const INK_TEXT: Record<InkFinding["kind"], (f: InkFinding, s: SpecOption, tac: number) => { sev: Sev; title: string; detail: string; fix: string } | null> = {
  richblack: (f, s) => ({ sev: "medium", title: `작은 글자가 4색 검정 (${f.minSize?.toFixed(1)}pt, ${f.sample})`,
    detail: `${s.richBlackMaxPt}pt보다 작은 글자 ${f.count}곳이 C·M·Y가 섞인 검정입니다. 네 판이 조금만 어긋나도 글자 테두리에 색이 번지고 획이 두꺼워집니다.`,
    fix: "본문 검정은 K100(먹 1도)으로 바꾸세요. 인디자인에서는 [검정] 견본을 쓰면 됩니다. 큰 제목·배경의 리치 블랙은 일부러 쓴 것일 수 있어 그대로 둡니다 — 그래서 기계가 견본을 바꾸지 않습니다." }),
  rgbblack: (f, s) => ({ sev: "medium", title: `작은 글자가 RGB 검정 (${f.minSize?.toFixed(1)}pt)`,
    detail: `${s.richBlackMaxPt}pt보다 작은 글자 ${f.count}곳이 RGB(0,0,0)입니다. 인쇄용 CMYK로 바꾸면 보통 C·M·Y·K가 다 들어간 4색 검정이 되어 글자가 번집니다.`,
    fix: "글자 색을 CMYK의 K100으로 지정하세요. 워드·파워포인트에서 만든 PDF에서 자주 생깁니다." }),
  tac: (f, _s, tac) => ({ sev: (f.maxTac ?? 0) > tac + 20 ? "high" : "medium", title: `면·글자 잉크량 한도 초과 (최대 ${f0(f.maxTac ?? 0)}%, 한도 ${tac}%)`,
    detail: `사진이 아닌 면이나 글자 ${f.count}곳의 네 판 합이 한도를 넘습니다(예: ${f.sample}). 잉크가 마르지 않아 뒷묻음이 생기거나 종이가 울 수 있습니다.`,
    fix: `그 색 견본을 한도(${tac}%) 안으로 낮추세요. 진한 검정 면이라면 C40 M30 Y30 K100(200%)처럼 잡는 경우가 많습니다. 정확한 값은 인쇄소에 물으세요.` }),
  overprint: (f) => ({ sev: "high", title: "흰색에 오버프린트 — 인쇄하면 사라짐",
    detail: `흰색으로 칠한 글자·면·선 ${f.count}곳에 오버프린트(중복 인쇄)가 켜져 있습니다. 흰색은 잉크가 없어서, 아래 색 위에 겹쳐 찍으면 화면과 달리 아무것도 남지 않습니다.`,
    fix: "인디자인 [속성] 패널에서 그 개체의 '칠 중복 인쇄'·'선 중복 인쇄'를 끄세요. [출력 미리 보기 → 분판]으로 사라지는지 확인할 수 있습니다." }),
  registration: (f) => ({ sev: "high", title: "레지스트레이션 색 사용",
    detail: `레지스트레이션 색(모든 판에 100%)으로 칠한 것이 ${f.count}곳 있습니다. 재단 표시용 색이라, 글자나 면에 쓰면 네 판이 다 찍혀 잉크가 400%가 됩니다.`,
    fix: "그 개체의 색을 [검정](K100)으로 바꾸세요. 재단선·맞춤표 말고는 레지스트레이션 색을 쓰지 않습니다." }),
  hairline: (f, s) => ({ sev: f.minWidth === 0 ? "medium" : "low",
    title: f.minWidth === 0 ? "두께 0인 선" : `너무 가는 선 (${(f.minWidth ?? 0).toFixed(2)}pt)`,
    detail: f.minWidth === 0
      ? `두께가 0으로 지정된 선 ${f.count}곳은 출력기마다 '가장 가는 선'으로 찍어 거의 보이지 않거나 사라집니다.`
      : `${s.minLinePt}pt보다 가는 선 ${f.count}곳은 인쇄에서 끊기거나 흐리게 나옵니다.`,
    fix: `선 두께를 ${s.minLinePt}pt 이상으로 지정하세요. 일부러 가는 선이면 인쇄소에 출력 가능한 최소 두께를 물으세요.` }),
  rgbvector: (f, s) => s.pdfx !== "X-1a" ? null : ({ sev: "high", title: "RGB로 칠한 면·글자 (PDF/X-1a 불가)",
    detail: `RGB 색으로 칠한 면·글자가 ${f.count}곳 있습니다. PDF/X-1a는 CMYK·별색만 받기 때문에 이 파일은 접수에서 막힙니다.`,
    fix: "그 색 견본을 CMYK로 바꾸거나, PDF/X-1a로 내보낼 때 '대상 프로파일로 변환'을 고르세요." }),
};

function checkInk(doc: PDFDocument, spec: SpecOption, tacLimit: number, views: number[][]): Issue[] {
  let rep;
  try { rep = inspectInk(doc, { tacLimit, minLinePt: spec.minLinePt, richBlackMaxPt: spec.richBlackMaxPt }); }
  catch { return []; } // 내용 스트림이 깨졌어도 나머지 검사는 산다
  const out: Issue[] = [];
  for (const f of rep.findings) {
    const t = INK_TEXT[f.kind](f, spec, tacLimit);
    if (!t) continue;
    const [vx0, vy0, vh, vw] = views[f.page - 1] ?? [0, 0, 0, 0];
    const cl = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
    const rect = [cl(f.rect[0] - vx0, vw), cl(vh - (f.rect[3] - vy0), vh), cl(f.rect[2] - vx0, vw), cl(vh - (f.rect[1] - vy0), vh)];
    out.push(mk(f.kind, t.sev, f.page, t.title, t.detail, t.fix, rect[2] - rect[0] > 0.5 && rect[3] - rect[1] > 0.5 ? rect : null));
  }
  for (const g of spotDuplicates(rep.spots)) {
    out.push(mk("spot", "medium", 1, `별색 이름 중복: ${g.map((x) => `'${x}'`).join(", ")}`,
      "같은 별색으로 보이는 이름이 글자만 다르게 여러 개 있습니다. 출력소는 이름이 다르면 판을 따로 만듭니다 — 판이 하나 더 생기거나 한쪽이 공정색으로 바뀝니다.",
      "인디자인 [견본] 패널에서 하나로 합치거나(견본 병합) [잉크 관리자]에서 별칭을 하나로 지정하세요."));
  }
  if (rep.spots.length && !spotDuplicates(rep.spots).length && rep.spots.length > 2) {
    out.push(mk("spot", "low", 1, `별색 ${rep.spots.length}개 사용`, `쓰인 별색: ${rep.spots.join(", ")}. 별색 하나가 판 하나입니다.`,
      "견적에 넣은 도수와 맞는지 확인하세요. 의도하지 않은 별색은 [잉크 관리자]에서 공정색으로 바꿀 수 있습니다."));
  }
  if (spec.pdfx === "X-1a" && rep.transparency) {
    out.push(mk("transparency", "high", 1, "투명도 사용 (PDF/X-1a 불가)",
      "그림자·투명도·혼합 모드·투명 배경 사진이 있습니다. PDF/X-1a는 투명도를 받지 않습니다.",
      "PDF/X-1a로 내보내면 인디자인이 투명도를 병합합니다. 병합 뒤 글자가 래스터로 바뀌지 않았는지 [병합 미리 보기]로 확인하세요."));
  }
  if (rep.truncated) out.push(mk("ink", "low", 1, "잉크 검사를 끝까지 하지 못함",
    "내용이 너무 많아 앞부분만 잉크 검사를 했습니다. 뒷부분의 잉크량·오버프린트는 보지 못했습니다.", "인디자인 [출력 미리 보기]로 나머지를 확인하세요."));
  return out;
}

/** 납품처가 요구한 PDF/X로 내보냈는지. 규격을 '보지 않음'으로 두면 묻지 않는다. */
function checkPdfx(doc: PDFDocument, spec: SpecOption, summary: Record<string, number>): Issue[] {
  if (spec.pdfx === "any") return [];
  const out: Issue[] = [];
  let ver = "";
  try {
    const info = doc.context.lookup(doc.context.trailerInfo.Info);
    const v = info instanceof PDFDict ? info.get(N("GTS_PDFXVersion")) : undefined;
    ver = v ? String((v as { decodeText?: () => string }).decodeText?.() ?? v).replace(/^\(|\)$/g, "") : "";
  } catch { ver = ""; }
  const want = spec.pdfx === "X-1a" ? /^PDF\/X-1/ : /^PDF\/X-4/;
  if (!want.test(ver)) {
    out.push(mk("pdfx", "medium", 1, `${spec.pdfx === "X-1a" ? "PDF/X-1a" : "PDF/X-4"}로 내보내지 않음`,
      ver ? `이 PDF는 ${ver}입니다. 납품처는 ${spec.pdfx === "X-1a" ? "PDF/X-1a" : "PDF/X-4"}를 요구합니다.` : "PDF/X 표시가 없습니다(일반 PDF로 내보냄).",
      `인디자인 [파일 → Adobe PDF 사전 설정]에서 '${spec.pdfx === "X-1a" ? "PDF/X-1a:2001" : "PDF/X-4:2008"}'을 골라 다시 내보내세요.`));
  }
  if (spec.pdfx === "X-1a" && (summary.rgb ?? 0) > 0) {
    out.push(mk("pdfx", "high", 1, `RGB 사진 ${summary.rgb}장 (PDF/X-1a 불가)`,
      "PDF/X-1a는 RGB 사진을 받지 않습니다. 이대로 보내면 접수에서 되돌아옵니다.",
      "PDF/X-1a로 내보낼 때 '대상 프로파일로 변환'을 고르거나, 인쇄소 프로파일로 미리 CMYK로 바꾸세요. 바꾼 뒤 색 차이는 위 '인쇄 색 차이' 항목을 보세요."));
  }
  return out;
}

const HG = "가-힣";

// 흔한 오용·외래어 표기. 파이썬 교정 에이전트(pg_agents/proofread/detectors.py)와 **같은 파일**을 본다.
// 한쪽에만 낱말을 더하면 바로 검사와 에이전트 검사의 결과가 갈린다.
// JSON에서 읽은 배열은 길이를 모르므로([string, string]이 아니라 string[]) 여기서 한 번 확인하고 좁힌다.
const MISUSE: [string, string, string][] = Object.entries(MISUSE_JSON.entries)
  .flatMap(([bad, v]) => (Array.isArray(v) && v.length >= 2 ? [[bad, v[0], v[1]] as [string, string, string]] : []));

/** 사전에 있는 오용을 찾아 '원래 내용 → 수정할 내용' 짝까지 만든다.
 *  짝이 있어야 인디자인 원본 수정 화면이 그 글자를 찾아 고칠 수 있다(제목 문자열만으로는 못 한다). */
function checkMisuse(pages: string[]): Issue[] {
  const out: Issue[] = [];
  pages.forEach((text, i) => {
    for (const [bad, good, why] of MISUSE) {
      if (!text.includes(bad)) continue;
      const n = text.split(bad).length - 1;
      const it = mk("typo", "medium", i + 1, `맞춤법·표준어: '${bad}' → '${good}'`,
        `${why}${n > 1 ? ` (이 쪽에 ${n}번)` : ""}`,
        "원본 편집 파일에서 고치세요. 자동으로 고치지 않습니다.", null, "proofread");
      it.edit = { original: bad, suggestion: good };
      out.push(it);
    }
  });
  return out;
}

/** 브랜드 키트의 '우리 회사 표기'. 사전 오용과 같이 '찾아 바꿀 짝'까지 만든다 — 회사가 정한 표기라
 *  어느 쪽이 맞는지 기계가 판단할 일이 없다. 그래서 자동 수정 대상이다. */
function checkHouse(pages: string[], terms: HouseTerm[]): Issue[] {
  const out: Issue[] = [];
  pages.forEach((text, i) => {
    for (const { wrong, right } of terms) {
      if (!wrong || wrong === right || !text.includes(wrong)) continue;
      // '맞는 표기'가 '틀린 표기'를 품고 있으면(틀림 '사이트' → 맞음 '웹사이트') 이미 맞게 쓴 곳까지 잡힌다. 그만큼 뺀다
      const n = text.split(wrong).length - 1 - (right.includes(wrong) ? text.split(right).length - 1 : 0);
      if (n <= 0) continue;
      const it = mk("typo", "medium", i + 1, `표기 통일(브랜드 키트): '${wrong}' → '${right}'`,
        `브랜드 키트에서 '${right}'로 쓰기로 정했습니다${n > 1 ? ` (이 쪽에 ${n}번)` : ""}.`,
        "원본 편집 파일에서 고치세요. 편집 파일로 맡기시면 검수 끝에 묻고 바꿔 드립니다.", null, "proofread");
      it.edit = { original: wrong, suggestion: right };
      out.push(it);
    }
  });
  return out;
}

// 조사를 떼고 비교한다 — '웹사이트를'과 '웹 사이트를'은 같은 말이 다르게 쓰인 것이다
const JOSA = /(으로|에서|에게|까지|부터|처럼|보다|입니다|이다|을|를|이|가|은|는|의|에|로|와|과|도|만)$/;
const stem = (w: string) => (w.length > 2 ? w.replace(JOSA, "") : w);
const MAX_PER_KIND = 15; // 문서 전체가 흔들리는 경우 목록이 이것으로 덮이지 않게
const UNIT_RE = /\d(\s?)(%|mm|cm|kg|pt|px|ppi|dpi|원|쪽|개|명)(?![A-Za-z])/g;

/** **표기 통일.** 맞춤법이 틀린 것은 아니지만 한 문서 안에서 같은 말을 두 가지로 쓴 곳.
 *  인쇄물 교정에서 가장 많이 나오는 지적이다. 어느 쪽으로 맞출지는 사람이 정한다(자동 수정 없음). */
export function checkConsistency(pages: string[]): Issue[] {
  const out: Issue[] = [];
  const pageOf = (pred: (t: string) => boolean) => Math.max(1, pages.findIndex(pred) + 1);
  // 1) 띄어쓰기만 다른 낱말: '웹사이트' ↔ '웹 사이트'
  const runs = new Map<string, number>();
  for (const t of pages) for (const m of t.matchAll(new RegExp(`[${HG}]+`, "g"))) { const k = stem(m[0]); runs.set(k, (runs.get(k) ?? 0) + 1); }
  const spaced = new Map<string, { shown: string; n: number }>();
  for (const t of pages) for (const m of t.matchAll(new RegExp(`(?<![${HG}])([${HG}]+) ([${HG}]+)`, "g"))) {
    const joined = stem(m[1] + m[2]);
    if (joined.length < 3 || !runs.has(joined)) continue;
    const e = spaced.get(joined) ?? { shown: `${m[1]} ${stem(m[2])}`, n: 0 };
    e.n++; spaced.set(joined, e);
  }
  let k = 0;
  for (const [joined, e] of spaced) {
    if (k++ >= MAX_PER_KIND) break;
    out.push(mk("consistency", "low", pageOf((t) => t.includes(e.shown)), `띄어쓰기 통일: '${joined}' ${runs.get(joined)}번 vs '${e.shown}' ${e.n}번`,
      "같은 말을 붙여 쓴 곳과 띄어 쓴 곳이 섞여 있습니다. 둘 다 허용되는 말도 있지만, 한 문서 안에서는 하나로 맞춥니다.",
      "어느 쪽으로 쓸지 정해 문서 전체를 맞추세요. 회사 표기로 정해 두려면 브랜드 키트의 '우리 회사 표기'에 넣으세요.", null, "heuristic"));
  }
  // 2) 숫자와 단위 사이 띄어쓰기: '10%'와 '10 %'
  const units = new Map<string, { tight: number; loose: number; page: number }>();
  pages.forEach((t, i) => {
    for (const m of t.matchAll(UNIT_RE)) {
      const e = units.get(m[2]) ?? { tight: 0, loose: 0, page: 0 };
      if (m[1]) { e.loose++; e.page ||= i + 1; } else e.tight++;
      units.set(m[2], e);
    }
  });
  for (const [u, e] of units) {
    if (!e.tight || !e.loose) continue;
    out.push(mk("consistency", "low", e.page, `숫자·단위 표기 통일: '10${u}' 꼴 ${e.tight}번 vs '10 ${u}' 꼴 ${e.loose}번`,
      `숫자와 '${u}' 사이를 붙인 곳과 띄운 곳이 섞여 있습니다.`,
      "한 가지로 맞추세요. 아라비아 숫자 뒤의 단위는 붙여 쓰는 것이 흔합니다.", null, "heuristic"));
  }
  // 3) 영문 대소문자: 'InDesign'과 'Indesign'. 문장 첫 글자만 다른 것('Print'·'print')은 뺀다
  const latin = new Map<string, Map<string, number>>();
  for (const t of pages) for (const m of t.matchAll(/(?<![A-Za-z])[A-Za-z][A-Za-z0-9]{2,}(?![A-Za-z])/g)) {
    const low = m[0].toLowerCase();
    const v = latin.get(low) ?? new Map<string, number>();
    v.set(m[0], (v.get(m[0]) ?? 0) + 1); latin.set(low, v);
  }
  k = 0;
  for (const [, v] of latin) {
    const forms = [...v.keys()];
    if (forms.length < 2 || new Set(forms.map((f) => f.slice(1))).size < 2) continue;
    if (k++ >= MAX_PER_KIND) break;
    out.push(mk("consistency", "low", pageOf((t) => t.includes(forms[1])), `영문 표기 통일: ${forms.map((f) => `'${f}' ${v.get(f)}번`).join(" vs ")}`,
      "같은 영문 낱말의 대소문자가 섞여 있습니다. 제품·회사 이름이면 그 회사가 쓰는 표기가 맞습니다.",
      "공식 표기를 확인해 하나로 맞추세요.", null, "heuristic"));
  }
  return out;
}

export function checkText(pages: string[], opts: { misuse?: boolean; terms?: HouseTerm[] } = {}): Issue[] {
  const out: Issue[] = opts.misuse === false ? [] : [...checkMisuse(pages), ...checkHouse(pages, opts.terms ?? [])];
  out.push(...checkConsistency(pages));
  const full = pages.join("\n");
  const cnt = new Map<string, number>();
  for (const m of full.matchAll(new RegExp(`(?<![${HG}])[${HG}]{2,}`, "g"))) cnt.set(m[0], (cnt.get(m[0]) ?? 0) + 1);
  for (const w of cnt.keys()) {
    if (!w.includes("율")) continue;
    const alt = w.replace("율", "률");
    if (alt !== w && cnt.has(alt)) {
      const pg = pages.findIndex((t) => t.includes(w)) + 1;
      out.push(mk("typo", "medium", pg, `표기 불일치: '${w}' vs '${alt}'`,
        `'${alt}' ${cnt.get(alt)}회, '${w}' ${cnt.get(w)}회 사용. 의도적 표현일 수 있어 자동 수정하지 않습니다.`,
        "문서 전체 표기를 하나로 통일하세요.", null, "heuristic"));
    }
  }
  pages.forEach((t, i) => {
    const m = t.match(new RegExp(`(?<![${HG}])([${HG}]+)\\s+\\1(?![${HG}])`));
    if (m && m[1].length >= 1) {
      out.push(mk("typo", "low", i + 1, `단어 반복 의심: '${m[1]}'`, "같은 단어가 연속으로 나타납니다.",
        "중복 입력인지 확인하세요.", null, "heuristic"));
    }
  });
  const lab = new Map<string, Map<string, number>>();
  pages.forEach((t, i) => {
    for (const m of t.matchAll(new RegExp(`([${HG}]{2,6})\\s*[:：]?\\s*(\\d[\\d,.]*)\\s*(%|원|개|명|kg|g|mm|cm)`, "g"))) {
      const k = `${m[1]}|${m[3]}`;
      if (!lab.has(k)) lab.set(k, new Map());
      const mm = lab.get(k)!;
      if (!mm.has(m[2])) mm.set(m[2], i + 1);
    }
  });
  for (const [k, vals] of lab) {
    if (vals.size > 1) {
      const [name, unit] = k.split("|");
      out.push(mk("number", "medium", Math.min(...vals.values()), `수치 불일치 의심: ${name}`,
        `'${name}'에 대해 ${[...vals.keys()].map((v) => v + unit).join(", ")} 값이 함께 등장합니다.`,
        "본문·표·캡션의 수치를 대조하세요.", null, "heuristic"));
    }
  }
  return out;
}
