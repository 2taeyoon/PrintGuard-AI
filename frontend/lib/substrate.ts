// 종이 흰색 보정(substrate correction). 프로파일이 가정한 종이(A)와 실제 종이(B)의 흰색이 다를 때,
// 인쇄 결과의 XYZ를 B 종이 기준으로 옮긴다. 규격을 확인하고 옮긴 식이 아니라,
// 어떤 식을 쓸지는 공개 측정 프로파일 쌍으로 검증해 골랐다(frontend/scripts/test-substrate.mts, eval/substrate_check.json).
export type Xyz = [number, number, number];
const D50: Xyz = [0.9642, 1.0, 0.8249];

const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const fi = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));

export function labToXyz([L, a, b]: number[]): Xyz {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  return [D50[0] * fi(fx), D50[1] * (L > 8 ? fy ** 3 : L / (24389 / 27)), D50[2] * fi(fz)];
}
export function xyzToLab([X, Y, Z]: number[]): Xyz {
  const fx = f(X / D50[0]), fy = f(Y / D50[1]), fz = f(Z / D50[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** ratio: 모든 색을 종이 흰색 비율로 곱한다. linear: 종이 흰색은 B로 옮기고 가장 진한 색(k)은 고정, 그 사이는 선형. */
export function correctSubstrate(x: Xyz, wA: Xyz, wB: Xyz, k: Xyz, method: "ratio" | "linear"): Xyz {
  return [0, 1, 2].map((i) => {
    if (method === "ratio") return x[i] * (wB[i] / wA[i]);
    const t = (x[i] - k[i]) / (wA[i] - k[i]);
    return x[i] + (wB[i] - wA[i]) * Math.max(0, t);
  }) as Xyz;
}
