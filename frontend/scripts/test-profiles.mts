// public/data/papers.json의 모든 프로파일로 같은 사진 PDF(Kodak 8장)의 색 차이를 잰다(상대 비색, 종이 색 제외/포함).
// 결과: eval/profiles_result.json
import { readFileSync, writeFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { analyze } from "../lib/analyze";
import { ColorEngine } from "../lib/color";
import type { PaperDb } from "../lib/papers";

const DB: PaperDb = JSON.parse(readFileSync("public/data/papers.json", "utf8"));
const data = new Uint8Array(readFileSync("../samples/kodak_photos_a5.pdf"));
const out: Record<string, unknown>[] = [];
for (const [key, pr] of Object.entries(DB.profiles)) {
  const icc = new Uint8Array(readFileSync(`public/icc/${pr.file}`));
  const row: Record<string, unknown> = { key, name: pr.name, condition: pr.condition, tac: pr.tac, white: pr.white, blackL: pr.blackL,
    papers: DB.papers.filter((p) => p.profile === key).length };
  for (const paperColor of [false, true]) {
    const eng = await ColorEngine.create(icc, { intent: "relative", tacLimit: pr.tac, paperColor });
    const r = await analyze(data, pdfjs, { widthMm: 148, heightMm: 210, bleedMm: 0, color: eng });
    row[paperColor ? "withPaper" : "noPaper"] = r.colorReport;
  }
  out.push(row);
  const w = row.withPaper as { weightedMeanDE: number; areaOver10: number; areaOverTAC: number };
  console.log(key.padEnd(12), pr.name.padEnd(36), "with paper ΔE", w.weightedMeanDE.toFixed(2), ">10", (w.areaOver10 * 100).toFixed(1) + "%", "overTAC", (w.areaOverTAC * 100).toFixed(2) + "%");
}
writeFileSync("../eval/profiles_result.json", JSON.stringify(out));
