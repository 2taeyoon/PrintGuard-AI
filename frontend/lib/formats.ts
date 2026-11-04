// 완성 크기(판형) 목록과 "이 치수가 어느 판형인가" 되찾기.
//
// 처음에는 A5·A4·B5 셋뿐이었다. 쓰는 사람이 고를 것이 없으면 전부 '직접 입력'으로 가는데,
// 그러면 검수가 숫자 두 개를 사람 손에 맡기게 된다 — 오타 한 번에 "페이지 크기가 설정과 다름"이
// 모든 쪽에 뜬다. 그래서 국내에서 실제로 주문이 들어오는 판형을 모아 두고, 파일에서 읽은
// 치수에 맞는 것을 자동으로 고른다(lib/pagesize.ts).
//
// 치수의 출처
// - ISO 계열(A·B)은 ISO 216 값이다. 재단 공차 없이 딱 맞는 수다.
// - 국내 판형(신국판·46판·크라운판 등)은 **인쇄소·출판사마다 몇 mm씩 다르다.** 여기 적은 값은
//   널리 쓰이는 값이고, 주문서에 적힌 값이 다르면 그 값을 '직접 입력'으로 넣는 쪽이 맞다.
//   그래서 되찾기 허용 오차를 1mm로 좁게 잡는다 — 2mm 차이인 크라운판(176×248)과
//   B5(176×250)를 같은 것으로 뭉개면 도련 판정이 조용히 틀린다.

export type Format = { label: string; w: number; h: number };
export type Group = { name: string; items: Format[] };

/** 같은 치수에 이름이 둘인 것(A5=국판, A4=국배판)은 한 줄로 합쳤다. 따로 두면 자동 선택이 둘 중 하나를 임의로 고른다. */
export const GROUPS: Group[] = [
  {
    name: "책·소책자",
    items: [
      { label: "신국판 (152×225)", w: 152, h: 225 },
      { label: "46판 (127×188)", w: 127, h: 188 },
      { label: "크라운판 (176×248)", w: 176, h: 248 },
      { label: "46배판 (188×257)", w: 188, h: 257 },
      { label: "문고판 (103×182)", w: 103, h: 182 },
    ],
  },
  {
    name: "ISO A",
    items: [
      { label: "A7 (74×105)", w: 74, h: 105 },
      { label: "A6 (105×148)", w: 105, h: 148 },
      { label: "A5 · 국판 (148×210)", w: 148, h: 210 },
      { label: "A4 · 국배판 (210×297)", w: 210, h: 297 },
      { label: "A3 (297×420)", w: 297, h: 420 },
      { label: "A2 (420×594)", w: 420, h: 594 },
      { label: "A1 (594×841)", w: 594, h: 841 },
      { label: "A0 (841×1189)", w: 841, h: 1189 },
    ],
  },
  {
    name: "ISO B",
    items: [
      { label: "B6 (125×176)", w: 125, h: 176 },
      { label: "B5 (176×250)", w: 176, h: 250 },
      { label: "B4 (250×353)", w: 250, h: 353 },
      { label: "B3 (353×500)", w: 353, h: 500 },
      { label: "B2 (500×707)", w: 500, h: 707 },
    ],
  },
  {
    name: "카드·엽서",
    items: [
      { label: "명함 (90×50)", w: 90, h: 50 },
      { label: "엽서 (100×148)", w: 100, h: 148 },
      { label: "초대장 (105×150)", w: 105, h: 150 },
      { label: "포토카드 (55×85)", w: 55, h: 85 },
    ],
  },
  {
    name: "정사각",
    items: [
      { label: "정사각 (120×120)", w: 120, h: 120 },
      { label: "정사각 (150×150)", w: 150, h: 150 },
      { label: "정사각 (180×180)", w: 180, h: 180 },
      { label: "정사각 (210×210)", w: 210, h: 210 },
    ],
  },
];

/** 목록에 없는 치수를 넣는 칸. 이 값이 골라져 있으면 가로·세로를 사람이 적는다. */
export const CUSTOM = "직접 입력";

export const ALL: Format[] = GROUPS.flatMap((g) => g.items);
const BY_LABEL = new Map(ALL.map((f) => [f.label, f]));

/** 라벨로 치수를 꺼낸다. '직접 입력'이거나 모르는 라벨이면 null */
export function dims(label: string): [number, number] | null {
  const f = BY_LABEL.get(label);
  return f ? [f.w, f.h] : null;
}

/** 치수에 맞는 판형. 세로·가로가 뒤집힌 파일도 같은 판형으로 본다(rotated로 알린다).
 *  오차 안에 둘 이상 들어오면 **가장 가까운 것**을 고른다. */
export function match(wMm: number, hMm: number, tol = 1): { format: Format; rotated: boolean } | null {
  let best: { format: Format; rotated: boolean; off: number } | null = null;
  for (const f of ALL) {
    for (const rotated of [false, true]) {
      const [fw, fh] = rotated ? [f.h, f.w] : [f.w, f.h];
      const off = Math.max(Math.abs(wMm - fw), Math.abs(hMm - fh));
      if (off > tol) continue;
      if (!best || off < best.off) best = { format: f, rotated, off };
    }
  }
  return best ? { format: best.format, rotated: best.rotated } : null;
}
