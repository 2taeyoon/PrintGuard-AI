// 종이 흰색 보정 방법 검증: 같은 등급인데 종이 흰색이 다른 공개 측정 프로파일 쌍(A→B)에서,
// A의 인쇄 결과(절대 비색 Lab)에 B의 종이 흰색으로 보정을 적용했을 때 B의 실제 값에 얼마나 가까워지는지 잰다.
//  M0: 보정 없음, M1: 비례(X' = X·Xw_B/Xw_A), M2: 선형(종이 흰색은 B로, A의 가장 진한 색은 고정)
// CMYK 격자 6^4 = 1296색. 결과: eval/substrate_check.json
import { readFileSync, writeFileSync } from "node:fs";
import { deltaE2000 } from "../lib/color";
import { xyzToLab, labToXyz, correctSubstrate, type Xyz } from "../lib/substrate";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod: any = await import("lcms-wasm");
const lcms = await mod.instantiate();
const lab = lcms.cmsCreateLab4Profile(null);
const lv = [0, 51, 102, 153, 204, 255];
const grid: number[] = [];
for (const c of lv) for (const m of lv) for (const y of lv) for (const k of lv) grid.push(c, m, y, k);
const N = grid.length / 4;

function absLab(file: string): number[][] {
  const b = new Uint8Array(readFileSync(`../eval/icc/${file}`));
  const p = lcms.cmsOpenProfileFromMem(b, b.byteLength);
  const t = lcms.cmsCreateTransform(p, mod.TYPE_CMYK_8, lab, mod.TYPE_Lab_16, mod.INTENT_ABSOLUTE_COLORIMETRIC, 0);
  const o = lcms.cmsDoTransform(t, new Uint8Array(grid), N) as Uint16Array;
  return Array.from({ length: N }, (_, i) => [(o[3 * i] / 65535) * 100, o[3 * i + 1] / 257 - 128, o[3 * i + 2] / 257 - 128]);
}

const P: Record<string, string> = {
  fogra39: "ISOcoated_v2_eci.icc", fogra51: "PSOcoated_v3.icc", fogra47: "Uncoated_Fogra47L_VIGC_300.icc", fogra52: "PSOuncoated_v3_FOGRA52.icc",
  fogra30: "ISOuncoatedyellowish.icc", fogra45: "PSO_LWC_Improved_eci.icc", fogra46: "PSO_LWC_Standard_eci.icc", fogra42: "PSO_SNP_Paper_eci.icc", fogra48: "PSO_INP_Paper_eci.icc",
};
const L: Record<string, number[][]> = {};
for (const [k, f] of Object.entries(P)) L[k] = absLab(f);

const pairs = [["fogra39", "fogra51"], ["fogra47", "fogra52"], ["fogra47", "fogra30"], ["fogra52", "fogra30"], ["fogra45", "fogra46"], ["fogra42", "fogra48"]];
const out: unknown[] = [];
for (const [a0, b0] of [...pairs, ...pairs.map(([x, y]) => [y, x])]) {
  const A = L[a0], B = L[b0];
  const xa = A.map((v) => labToXyz(v)), xb = B.map((v) => labToXyz(v));
  const wA = xa[0], wB = xb[0]; // CMYK 0,0,0,0 = 종이 흰색 (격자 첫 항목)
  const kA = xa.reduce((m, v) => (v[1] < m[1] ? v : m)); // 가장 어두운 색
  const paperDE = deltaE2000(...(A[0] as [number, number, number]), ...(B[0] as [number, number, number]));
  const res: Record<string, number> = {};
  for (const method of ["none", "ratio", "linear"] as const) {
    let s = 0, mx = 0;
    const ds: number[] = [];
    for (let i = 0; i < N; i++) {
      const c = method === "none" ? xa[i] : correctSubstrate(xa[i] as Xyz, wA as Xyz, wB as Xyz, kA as Xyz, method);
      const l = xyzToLab(c);
      const d = deltaE2000(l[0], l[1], l[2], B[i][0], B[i][1], B[i][2]);
      s += d; mx = Math.max(mx, d); ds.push(d);
    }
    ds.sort((x, y) => x - y);
    res[`${method}_mean`] = s / N; res[`${method}_p95`] = ds[Math.floor(0.95 * (N - 1))]; res[`${method}_max`] = mx;
  }
  out.push({ from: a0, to: b0, paperWhiteDE: paperDE, whiteA: A[0], whiteB: B[0], ...res });
  console.log(`${a0}→${b0} 종이흰색 ΔE ${paperDE.toFixed(2)} | 보정없음 ${res.none_mean.toFixed(2)} | 비례 ${res.ratio_mean.toFixed(2)} | 선형 ${res.linear_mean.toFixed(2)} (p95 ${res.none_p95.toFixed(2)}/${res.ratio_p95.toFixed(2)}/${res.linear_p95.toFixed(2)})`);
}
writeFileSync("../eval/substrate_check.json", JSON.stringify(out));
