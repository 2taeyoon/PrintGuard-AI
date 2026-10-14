// 실제 사진(Kodak) PDF를 앱과 같은 분석 코드로 돌려 색 차이를 잰다. 결과는 eval/photo_color_js.json
import { readFileSync, writeFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { analyze } from "../lib/analyze";
import { ColorEngine, type IntentName } from "../lib/color";

const icc = new Uint8Array(readFileSync("../eval/icc/RSWOP.icm"));
const data = new Uint8Array(readFileSync("../samples/kodak_photos_a5.pdf"));
const out: Record<string, unknown> = {};
for (const intent of ["relative", "perceptual"] as IntentName[]) {
  const eng = await ColorEngine.create(icc, { intent, tacLimit: 300 });
  const t0 = performance.now();
  const r = await analyze(data, pdfjs, { widthMm: 148, heightMm: 210, bleedMm: 0, color: eng });
  const ms = performance.now() - t0;
  const imgs = r.issues.filter((i) => i.metrics).sort((a, b) => a.page - b.page).map((i) => ({
    page: i.page, severity: i.severity, title: i.title, metrics: i.metrics,
    heat: { w: i.heat!.w, h: i.heat!.h, rgba: Buffer.from(i.heat!.rgba).toString("base64") },
  }));
  out[intent] = { ms, colorReport: r.colorReport, images: imgs };
  console.log(intent, `${ms.toFixed(0)}ms`, JSON.stringify(r.colorReport));
  for (const i of imgs) {
    const m = i.metrics!;
    console.log(" p" + i.page, i.severity, "mean", m.meanDE.toFixed(2), "p95", m.p95DE.toFixed(2), ">5", (m.shareOver5 * 100).toFixed(1) + "%", ">10", (m.shareOver10 * 100).toFixed(1) + "%", "TACmax", m.maxTAC.toFixed(0), "sampled", m.sampled);
  }
}
writeFileSync("../eval/photo_color_js.json", JSON.stringify(out));
