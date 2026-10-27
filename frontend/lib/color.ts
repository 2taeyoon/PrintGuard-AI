// 인쇄 색 차이 추정: sRGB 이미지를 CMYK ICC 프로파일로 변환(LittleCMS, wasm)한 뒤 다시 Lab으로 읽어 원본과의 ΔE2000을 잰다.
// "실제 인쇄 색 보장"이 아니라 지정한 프로파일 기준의 소프트 프루프 예측이다.

import { correctSubstrate, labToXyz, xyzToLab, type Xyz } from "./substrate";

export type IntentName = "relative" | "perceptual" | "saturation";
export type Lab = [number, number, number];
/** 종이 흰색 보정 상태. profileWhite: 프로파일이 가정한 종이, targetWhite: 측정해서 넣은 실제 종이 */
export type SubstrateFix = { profileWhite: Lab; targetWhite: Lab; method: "linear" };
export type ColorStats = {
  pixels: number; meanDE: number; medianDE: number; p95DE: number; maxDE: number;
  shareOver2: number; shareOver5: number; shareOver10: number;
  meanTAC: number; maxTAC: number; shareOverTAC: number; tacLimit: number;
};
export type ColorResult = { stats: ColorStats; de: Float32Array };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Lcms = any;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** CIEDE2000 (Sharma, Wu, Dalal 2005) */
export function deltaE2000(L1: number, a1: number, b1: number, L2: number, a2: number, b2: number): number {
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (b: number, a: number) => { if (b === 0 && a === 0) return 0; const x = deg(Math.atan2(b, a)); return x >= 0 ? x : x + 360; };
  const h1p = h(b1, a1p), h2p = h(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p === 0) hbp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
  else hbp = (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2;
  const T = 1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp)) + 0.32 * Math.cos(rad(3 * hbp + 6)) - 0.2 * Math.cos(rad(4 * hbp - 63));
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  const x = dLp / Sl, y = dCp / Sc, z = dHp / Sh;
  return Math.sqrt(x * x + y * y + z * z + Rt * y * z);
}

export function iccInfo(bytes: Uint8Array): { space: string; cls: string } {
  const s = (o: number) => String.fromCharCode(...bytes.slice(o, o + 4));
  return { space: s(16).trim(), cls: s(12) };
}

export class ColorEngine {
  private constructor(
    private lcms: Lcms, private toCmyk: number, private cmykToLab: number, private rgbToLab: number,
    public description: string, public tacLimit: number,
    /** 측정한 종이 흰색을 받았을 때만 채운다(null이면 보정하지 않는다) */
    public substrate: SubstrateFix | null = null,
    private sub: { wA: Xyz; wB: Xyz; k: Xyz } | null = null,
  ) {}

  static async create(
    iccBytes: Uint8Array,
    opts: { intent?: IntentName; tacLimit?: number; wasmUrl?: string; moduleUrl?: string; paperColor?: boolean;
      /** 실제 종이의 흰색을 측정한 절대 Lab. 프로파일이 가정한 종이와 다를 때 인쇄 색을 이 종이 기준으로 옮긴다(절대 비색일 때만). */
      substrateWhite?: Lab } = {},
  ): Promise<ColorEngine> {
    const info = iccInfo(iccBytes);
    if (info.space !== "CMYK") throw new Error(`CMYK ICC 프로파일이 아닙니다 (색 공간: ${info.space || "알 수 없음"})`);
    // 번들러가 lcms.js의 Node 전용 코드를 해석하지 못하므로 브라우저에서는 public의 파일을 런타임에 직접 불러온다.
    const spec: string = opts.moduleUrl ?? "lcms-wasm";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ spec);
    const lcms: Lcms = await mod.instantiate(opts.wasmUrl ? { locateFile: () => opts.wasmUrl } : undefined);
    const intent = { relative: mod.INTENT_RELATIVE_COLORIMETRIC, perceptual: mod.INTENT_PERCEPTUAL, saturation: mod.INTENT_SATURATION }[opts.intent ?? "relative"];
    const flags = mod.cmsFLAGS_BLACKPOINTCOMPENSATION;
    const cmyk = lcms.cmsOpenProfileFromMem(iccBytes, iccBytes.byteLength);
    if (!cmyk) throw new Error("ICC 프로파일을 읽지 못했습니다");
    const srgb = lcms.cmsCreate_sRGBProfile();
    const lab = lcms.cmsCreateLab4Profile(null);
    let description = "";
    try { description = lcms.cmsGetProfileInfoASCII(cmyk, mod.cmsInfoDescription, "en", "US"); } catch { /* 이름 없음 */ }
    const toCmyk = lcms.cmsCreateTransform(srgb, mod.TYPE_RGB_8, cmyk, mod.TYPE_CMYK_8, intent, flags);
    // lcms-wasm은 double 출력을 지원하지 않아 16비트 Lab(v4 인코딩)으로 읽는다.
    // paperColor: 인쇄 결과를 절대 비색으로 읽어 종이 흰색(색조·밝기)까지 차이에 넣는다. 눈이 종이 흰색에 적응하므로 상한 참고용이다.
    const cmykToLab = lcms.cmsCreateTransform(cmyk, mod.TYPE_CMYK_8, lab, mod.TYPE_Lab_16,
      opts.paperColor ? mod.INTENT_ABSOLUTE_COLORIMETRIC : intent, opts.paperColor ? 0 : flags);
    const rgbToLab = lcms.cmsCreateTransform(srgb, mod.TYPE_RGB_8, lab, mod.TYPE_Lab_16, mod.INTENT_RELATIVE_COLORIMETRIC, flags);
    if (!toCmyk || !cmykToLab || !rgbToLab) throw new Error("색 변환을 만들지 못했습니다");
    // 종이 흰색 보정: 프로파일이 가정한 종이 흰색(CMYK 0%)과 가장 진한 색(CMYK 400%)을 읽어 둔다.
    // 절대 비색으로 읽을 때만 뜻이 있다(상대 비색은 종이 흰색을 이미 흰색으로 맞춰 버린다).
    let fix: SubstrateFix | null = null, sub: { wA: Xyz; wB: Xyz; k: Xyz } | null = null;
    if (opts.substrateWhite && opts.paperColor !== false) {
      const c = lcms.cmsDoTransform(cmykToLab, new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255]), 2) as Uint16Array;
      const at = (i: number): Lab => [(c[3 * i] / 65535) * 100, c[3 * i + 1] / 257 - 128, c[3 * i + 2] / 257 - 128];
      fix = { profileWhite: at(0), targetWhite: opts.substrateWhite, method: "linear" };
      sub = { wA: labToXyz(at(0)), wB: labToXyz(opts.substrateWhite), k: labToXyz(at(1)) };
    }
    return new ColorEngine(lcms, toCmyk, cmykToLab, rgbToLab, description, opts.tacLimit ?? 300, fix, sub);
  }

  /** rgb: 픽셀당 3바이트(RGB) 배열. 반환 de는 픽셀별 ΔE2000. */
  analyze(rgb: Uint8Array | Uint8ClampedArray): ColorResult {
    const n = Math.floor(rgb.length / 3);
    const input = rgb instanceof Uint8Array ? rgb : new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.byteLength);
    const cmyk = this.lcms.cmsDoTransform(this.toCmyk, input, n) as Uint8Array;
    const labPrint = this.lcms.cmsDoTransform(this.cmykToLab, cmyk, n) as Uint16Array;
    const labSrc = this.lcms.cmsDoTransform(this.rgbToLab, input, n) as Uint16Array;
    const L = (v: number) => (v / 65535) * 100, AB = (v: number) => v / 257 - 128;
    const de = new Float32Array(n);
    let tacSum = 0, tacMax = 0, overTac = 0;
    for (let i = 0; i < n; i++) {
      let pr: Lab = [L(labPrint[3 * i]), AB(labPrint[3 * i + 1]), AB(labPrint[3 * i + 2])];
      // 측정한 종이 흰색을 받았으면 인쇄 결과를 그 종이 기준으로 옮긴다(선형: 종이 흰색은 옮기고 가장 진한 색은 고정)
      if (this.sub) pr = xyzToLab(correctSubstrate(labToXyz(pr), this.sub.wA, this.sub.wB, this.sub.k, this.substrate!.method)) as Lab;
      de[i] = deltaE2000(L(labSrc[3 * i]), AB(labSrc[3 * i + 1]), AB(labSrc[3 * i + 2]), pr[0], pr[1], pr[2]);
      const tac = ((cmyk[4 * i] + cmyk[4 * i + 1] + cmyk[4 * i + 2] + cmyk[4 * i + 3]) / 255) * 100;
      tacSum += tac; if (tac > tacMax) tacMax = tac; if (tac > this.tacLimit) overTac++;
    }
    const sorted = Float32Array.from(de).sort();
    const q = (p: number) => sorted[Math.min(n - 1, Math.floor(p * (n - 1)))];
    let s = 0, o2 = 0, o5 = 0, o10 = 0;
    for (let i = 0; i < n; i++) { s += de[i]; if (de[i] > 2) o2++; if (de[i] > 5) o5++; if (de[i] > 10) o10++; }
    return {
      de,
      stats: {
        pixels: n, meanDE: s / n, medianDE: q(0.5), p95DE: q(0.95), maxDE: sorted[n - 1],
        shareOver2: o2 / n, shareOver5: o5 / n, shareOver10: o10 / n,
        meanTAC: tacSum / n, maxTAC: tacMax, shareOverTAC: overTac / n, tacLimit: this.tacLimit,
      },
    };
  }
}

/** ΔE → 색 지도(RGBA). 5 이하 투명, 5 초과부터 노랑, 15 이상 진한 빨강 */
export function heatRGBA(de: Float32Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(de.length * 4);
  for (let i = 0; i < de.length; i++) {
    const v = de[i];
    if (v <= 5) continue;
    const t = Math.min(1, (v - 5) / 10);
    out[4 * i] = 240; out[4 * i + 1] = Math.round(210 * (1 - t) + 30 * t); out[4 * i + 2] = 20; out[4 * i + 3] = Math.round(110 + 120 * t);
  }
  return out;
}
