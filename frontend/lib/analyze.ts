// 브라우저(또는 Node)에서 PDF를 직접 분석하는 규칙 기반 프리플라이트. 서버 없이 동작한다.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFStream } from "pdf-lib";
import { heatRGBA, type ColorEngine, type ColorStats } from "./color";

export type Sev = "high" | "medium" | "low";
export type Issue = {
  id: number; kind: string; severity: Sev; page: number; title: string; detail: string; fix: string;
  rect: number[] | null; // 페이지 좌상단 기준 [x0,y0,x1,y1] (pt)
  source: "rule" | "heuristic" | "proofread";
  metrics?: ColorMetrics; // 색 차이 측정값 (RGB 이미지)
  heat?: { w: number; h: number; rgba: Uint8ClampedArray }; // ΔE 지도
};
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
  opts: { widthMm: number; heightMm: number; bleedMm: number; color?: ColorEngine | null },
): Promise<Analysis> {
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

  for (let i = 0; i < pages.length; i++) {
    const p = i + 1;
    const lp = pages[i];
    const media = boxOf(lp.node.MediaBox()) ?? lp.getMediaBox();
    const trimArr = boxOf(lp.node.TrimBox());
    const jsPage = await pjs.getPage(p);
    const [vx0, vy0, vx1, vy1] = jsPage.view as number[];
    const vw = vx1 - vx0, vh = vy1 - vy0;
    pageSizes.push({ w: vw, h: vh });

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
        if (dpi < 150) {
          issues.push(mk("resolution", dpi < 100 ? "high" : "medium", p, `이미지 해상도 낮음 (${dpi.toFixed(0)}dpi)`,
            "유효 해상도가 인쇄 권장치(300dpi, 최소 150dpi)보다 낮습니다.",
            "원본 고해상도 이미지로 교체하거나 크기를 줄이세요.", rect));
        }
      }
    }

    // 텍스트: 추출, 페이지 이탈, 안전 영역
    const tc = await jsPage.getTextContent();
    let text = "";
    let clip: number[] | null = null;
    let safe: number[] | null = null;
    const safePt = 3 * MM;
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
      "글자가 재단선 안쪽 3mm 이내에 있어 재단 오차로 잘릴 수 있습니다.",
      "중요한 글자는 재단선에서 3~5mm 안쪽에 두세요.", safe));
  }

  // 출력 의도
  if (!doc.catalog.has(N("OutputIntents"))) {
    issues.push(mk("color", "low", 1, "출력 의도(Output Intent) 미지정",
      "PDF에 출력 프로파일이 지정되지 않았습니다.", "인쇄소가 지정한 PDF/X 프로파일로 내보내세요."));
  }
  issues.push(...checkFonts(doc));
  issues.push(...checkText(texts));
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

const HG = "가-힣";

export function checkText(pages: string[]): Issue[] {
  const out: Issue[] = [];
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
