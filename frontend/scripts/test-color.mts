import { readFileSync, writeFileSync } from "node:fs";
import { ColorEngine, deltaE2000 } from "../lib/color";

// 1) CIEDE2000 공식: Sharma 등의 공개 검증 쌍
const pairs: [number[], number[], number][] = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
  [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
  [[50, -1, 2], [50, 0, 0], 2.3669],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
];
for (const [a, b, want] of pairs) {
  const got = deltaE2000(a[0], a[1], a[2], b[0], b[1], b[2]);
  console.log(Math.abs(got - want) < 1e-3 ? "OK  " : "FAIL", got.toFixed(4), "expected", want);
}

// 2) 파이프라인: 8x8x8 RGB 격자를 RSWOP.icm으로 변환
const icc = new Uint8Array(readFileSync("../eval/icc/RSWOP.icm"));
const eng = await ColorEngine.create(icc, { intent: "relative", tacLimit: 300 });
console.log("profile:", eng.description);
const steps = [0, 36, 73, 109, 146, 182, 219, 255];
const px: number[] = [];
for (const r of steps) for (const g of steps) for (const b of steps) px.push(r, g, b);
const res = eng.analyze(new Uint8Array(px));
console.log(JSON.stringify(res.stats));
writeFileSync("../eval/color_check_js.json", JSON.stringify({ steps, de: Array.from(res.de), stats: res.stats }));
