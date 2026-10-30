// 종이(프로파일)별 색 차이: 같은 8장 사진 PDF를 SWOP/PSO Coated v3/PSO Uncoated v3로 변환해 비교하고,
// 위험도 규칙(lib/risk.ts)을 합성 시나리오에 돌려 의도한 방향으로 움직이는지 확인한다. 결과는 eval/paper_result.json
import { readFileSync, writeFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { analyze } from "../lib/analyze";
import { ColorEngine, type IntentName } from "../lib/color";
import type { PaperDb } from "../lib/papers";
import { assess } from "../lib/risk";

const PAPER_COLOR = process.argv[2] === "paper";
const data = new Uint8Array(readFileSync("../samples/kodak_photos_a5.pdf"));
const PROFILES = [
  { key: "swop", name: "Agfa SWOP", file: "../frontend/public/icc/RSWOP.icm", tac: 300 },
  { key: "coated", name: "PSO Coated v3 (FOGRA51)", file: "../frontend/public/icc/PSOcoated_v3.icc", tac: 300 },
  { key: "uncoated", name: "PSO Uncoated v3 (FOGRA52)", file: "../frontend/public/icc/PSOuncoated_v3_FOGRA52.icc", tac: 300 },
];
const out: Record<string, unknown> = { profiles: [] };
for (const p of PROFILES) {
  const icc = new Uint8Array(readFileSync(p.file));
  const row: Record<string, unknown> = { key: p.key, name: p.name, tacLimit: p.tac };
  for (const intent of ["relative", "perceptual"] as IntentName[]) {
    const eng = await ColorEngine.create(icc, { intent, tacLimit: p.tac, paperColor: PAPER_COLOR });
    const r = await analyze(data, pdfjs, { widthMm: 148, heightMm: 210, bleedMm: 0, color: eng });
    const imgs = r.issues.filter((i) => i.metrics).sort((a, b) => a.page - b.page).map((i) => ({
      page: i.page, mean: i.metrics!.meanDE, p95: i.metrics!.p95DE, over5: i.metrics!.shareOver5, over10: i.metrics!.shareOver10,
      maxTAC: i.metrics!.maxTAC, overTAC: i.metrics!.shareOverTAC, severity: i.severity,
    }));
    row[intent] = { report: r.colorReport, images: imgs };
    console.log(p.key, intent, JSON.stringify(r.colorReport));
  }
  (out.profiles as unknown[]).push(row);
}

// 위험도 규칙: 기본 종류 × 후가공 × (잉크량 낮음/높음) 시나리오
const DB: PaperDb = JSON.parse(readFileSync("public/data/papers.json", "utf8"));
const scen: unknown[] = [];
for (const paper of DB.papers.filter((p) => p.kind === "type")) {
  for (const finish of ["unknown", "none", "fold", "bind", "foil"] as const) {
    for (const [label, maxTAC, share] of [["이미지 적음·잉크 낮음", 180, 0.05], ["사진 많음·잉크 높음", 290, 0.6]] as const) {
      const r = assess({ paper, finish, gsm: finish === "fold" ? 250 : 120, maxTAC, tacLimit: DB.profiles[paper.profile].tac, imageShare: share, hasImages: true });
      scen.push({ paper: paper.id, name: paper.name, finish, label, gsm: finish === "fold" ? 250 : 120, risks: Object.fromEntries(r.map((x) => [x.id, { level: x.level, reasons: x.reasons.length }])) });
    }
  }
}
out.scenarios = scen;
writeFileSync(PAPER_COLOR ? "../eval/paper_result_abs.json" : "../eval/paper_result.json", JSON.stringify(out));
