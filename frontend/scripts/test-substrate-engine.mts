// 종이 흰색 보정이 ColorEngine 경로에서 실제로 적용되는지 확인한다.
// (어떤 식을 쓸지 고른 검증은 test-substrate.mts — 여기서는 엔진에 넣은 측정값대로 옮겨지는지만 본다)
// 기대: 측정값을 넣으면 종이 흰색(CMYK 0%)은 그 측정값으로 정확히 옮겨지고, 가장 진한 색은 그대로 남는다.
import { readFileSync } from "node:fs";
import { ColorEngine, deltaE2000 } from "../lib/color";
import type { PaperDb } from "../lib/papers";

const DB: PaperDb = JSON.parse(readFileSync("public/data/papers.json", "utf8"));
const A = DB.profiles.coated, B = DB.profiles.yellowish; // 코팅지 프로파일에 '누런 비코팅지'를 측정값처럼 넣는다
const icc = new Uint8Array(readFileSync(`public/icc/${A.file}`));
const target = B.white as [number, number, number];
const px = new Uint8Array([255, 255, 255, 191, 191, 191, 128, 128, 128, 0, 0, 0]); // 흰색·밝은 회색·중간 회색·검정

const plain = await ColorEngine.create(icc, { paperColor: true, tacLimit: A.tac });
const fixed = await ColorEngine.create(icc, { paperColor: true, tacLimit: A.tac, substrateWhite: target });

console.log(`프로파일 ${A.name}`);
console.log(`  ICC에서 읽은 종이 흰색 Lab ${fixed.substrate!.profileWhite.map((v) => v.toFixed(2)).join(", ")}`);
console.log(`  papers.json에 적힌 값      ${A.white.join(", ")}  (데이터 대조)`);
console.log(`  측정값으로 넣은 종이 흰색  ${target.join(", ")} (${B.name})`);
if (plain.substrate !== null) throw new Error("측정값을 넣지 않았는데 보정이 켜졌다");

// 원본 흰색은 상대 비색 sRGB→Lab에서 (100, 0, 0)이다. 보정 전/후의 ΔE가 각각 '프로파일 종이'·'측정 종이'와 맞아야 한다
const de0 = plain.analyze(px).de, de1 = fixed.analyze(px).de;
const wantPlain = deltaE2000(100, 0, 0, ...fixed.substrate!.profileWhite);
const wantFixed = deltaE2000(100, 0, 0, ...target);
console.log(`\n흰 픽셀 ΔE: 보정 없음 ${de0[0].toFixed(3)} (기대 ${wantPlain.toFixed(3)}) · 보정 ${de1[0].toFixed(3)} (기대 ${wantFixed.toFixed(3)})`);
for (const [i, name] of [[1, "밝은 회색"], [2, "중간 회색"], [3, "검정"]] as [number, string][]) {
  console.log(`${name} ΔE: 보정 없음 ${de0[i].toFixed(3)} → 보정 ${de1[i].toFixed(3)} (차이 ${(de1[i] - de0[i]).toFixed(3)})`);
}

const bad: string[] = [];
if (Math.abs(de0[0] - wantPlain) > 0.3) bad.push(`보정 없음 흰색 ΔE가 프로파일 종이 흰색과 다르다 (${de0[0].toFixed(3)} vs ${wantPlain.toFixed(3)})`);
if (Math.abs(de1[0] - wantFixed) > 0.3) bad.push(`보정한 흰색 ΔE가 측정값과 다르다 (${de1[0].toFixed(3)} vs ${wantFixed.toFixed(3)})`);
if (Math.abs(de1[3] - de0[3]) > 0.5) bad.push(`가장 진한 쪽이 크게 움직였다 (검정 ${de0[3].toFixed(3)} → ${de1[3].toFixed(3)})`);
if (bad.length) {
  console.error("\n[실패]\n - " + bad.join("\n - "));
  process.exit(1);
}
console.log("\n통과: 흰색은 측정값으로 옮겨지고, 진한 쪽은 거의 그대로다");
