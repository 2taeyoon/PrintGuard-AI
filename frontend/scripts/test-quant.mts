// 사진 PDF 시험에서 앱(16비트 Lab)과 Pillow(8비트 LAB)의 평균 ΔE가 최대 0.035 달랐던 이유가 Lab 양자화인지 확인한다.
// 같은 픽셀(eval/photos를 3칸 간격으로 줄인 것)을 앱과 같은 변환으로 돌리고, Lab을 Pillow 방식(L은 255단계, a·b는 정수)으로 반올림해 다시 잰다.
// 입력: 스크래치의 *.rgb (Python이 저장), 비교 대상: eval/photo_color_result.json. 결과: eval/quant_check.json
import { readFileSync, writeFileSync } from "node:fs";
import { ColorEngine, deltaE2000 } from "../lib/color";

const dir = process.argv[2];
const P = JSON.parse(readFileSync("../eval/photo_color_result.json", "utf8"));
const icc = new Uint8Array(readFileSync("public/icc/RSWOP.icm"));
const out: unknown[] = [];
for (const intent of ["relative", "perceptual"] as const) {
  const eng = await ColorEngine.create(icc, { intent });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = eng as any;
  for (const r of P.rows) {
    const rgb = new Uint8Array(readFileSync(`${dir}/${r.name}.rgb`));
    const n = rgb.length / 3;
    const cmyk = e.lcms.cmsDoTransform(e.toCmyk, rgb, n) as Uint8Array;
    const a = e.lcms.cmsDoTransform(e.cmykToLab, cmyk, n) as Uint16Array;
    const b = e.lcms.cmsDoTransform(e.rgbToLab, rgb, n) as Uint16Array;
    const L = (v: number) => (v / 65535) * 100, AB = (v: number) => v / 257 - 128;
    const qL = (x: number) => (Math.round((x * 255) / 100) * 100) / 255, qAB = (x: number) => Math.round(x);
    let s16 = 0, s8 = 0;
    for (let i = 0; i < n; i++) {
      const l1 = L(b[3 * i]), a1 = AB(b[3 * i + 1]), b1 = AB(b[3 * i + 2]), l2 = L(a[3 * i]), a2 = AB(a[3 * i + 1]), b2 = AB(a[3 * i + 2]);
      s16 += deltaE2000(l1, a1, b1, l2, a2, b2);
      s8 += deltaE2000(qL(l1), qAB(a1), qAB(b1), qL(l2), qAB(a2), qAB(b2));
    }
    const pil = r[intent].pillow_same_pixels.mean;
    out.push({ name: r.name, intent, app16: s16 / n, app_quant8: s8 / n, pillow: pil, diff16: Math.abs(s16 / n - pil), diff8: Math.abs(s8 / n - pil) });
  }
}
const mx = (k: string) => Math.max(...out.map((o) => (o as Record<string, number>)[k]));
console.log("max |앱16 - Pillow|", mx("diff16").toFixed(4), " max |앱(8비트 반올림) - Pillow|", mx("diff8").toFixed(4));
writeFileSync("../eval/quant_check.json", JSON.stringify({ rows: out, max_diff16: mx("diff16"), max_diff8: mx("diff8") }));
