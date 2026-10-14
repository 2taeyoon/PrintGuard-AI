// 인쇄 불량 위험도 (뒷묻음, 눌림, 색판 어긋남, 농도 얼룩, 줄무늬). 학습 모델이 아니라 점수표 규칙이다.
// 각 요인은 원문을 직접 확인한 자료(eval/kb/print_guide_defects.md 6장)에 근거하고, 근거가 없는 요인은 "(추정)"을 붙인다.
// 점수·임계값은 가설이며 실제 불량 데이터로 보정하지 않았다.
import type { Analysis } from "./analyze";
import type { FinishId, Paper } from "./papers";

export type Level = "low" | "medium" | "high" | "na"; // na: 입력이 없거나 PDF로 판단할 수 없음
export type RiskId = "setoff" | "indent" | "misreg" | "mottle" | "banding";
export type Risk = { id: RiskId; name: string; level: Level; score: number; reasons: string[]; query: string; weak?: boolean };
export type RiskInput = { paper: Paper; finish: FinishId; gsm: number; maxTAC: number; tacLimit: number; imageShare: number; hasImages: boolean };

const lv = (score: number, mid: number, high: number): Level => (score >= high ? "high" : score >= mid ? "medium" : "low");

export function inputFrom(a: Analysis, paper: Paper, finish: FinishId, gsm: number, tacLimit: number): RiskInput {
  const maxTAC = Math.max(0, ...a.issues.map((i) => i.metrics?.maxTAC ?? 0));
  return { paper, finish, gsm, maxTAC, tacLimit, imageShare: a.colorReport?.areaShare ?? 0, hasImages: (a.colorReport?.images ?? 0) > 0 };
}

export function assess(x: RiskInput): Risk[] {
  const { paper: p } = x;
  const heavy = x.hasImages && x.maxTAC >= x.tacLimit * 0.95;
  const warm = x.hasImages && x.maxTAC >= x.tacLimit * 0.8;

  // 뒷묻음: Sappi(잉크막 두께, 잉크 면적), Schwegmann(코팅지는 분말이 더 필요, 비코팅지는 건조 2배)
  const so: string[] = []; let s1 = 0;
  if (heavy) { s1 += 2; so.push(`이미지 최대 총 잉크량 ${x.maxTAC.toFixed(0)}%가 한도 ${x.tacLimit}%에 가깝다 — 잉크막이 두꺼우면 뒷묻음이 생긴다 (Sappi)`); }
  else if (warm) { s1 += 1; so.push(`이미지 최대 총 잉크량 ${x.maxTAC.toFixed(0)}%로 한도의 80% 이상이다 (Sappi)`); }
  const special = `${p.name}는 펄·합성·색지 같은 특수 종이라 코팅/비코팅 근거를 적용하지 않았다`;
  if (p.coated === true) { s1 += 1; so.push(`${p.name}는 코팅지라 비코팅지보다 뒷묻음 방지 분말이 더 필요하다 (Schwegmann)`); }
  else if (p.coated === false) so.push(`${p.name}는 비코팅지라 잉크가 마르는 데 코팅지의 약 2배가 걸린다 — 쌓기 전 건조 시간을 둔다 (Schwegmann, 점수에는 넣지 않음)`);
  else so.push(special);
  if (x.imageShare >= 0.3) { s1 += 1; so.push(`이미지가 쪽 면적의 ${(x.imageShare * 100).toFixed(0)}%로 잉크 면적이 넓다 — 분말 입자는 잉크 면적에 맞춰야 한다 (Sappi)`); }

  // 눌림: Müller Martini(제본 압력·마찰, 코팅·라미네이팅이 도움), 한국펄프종이공학회지 2008(오시 압력, 코팅 판지 갈라짐, 인쇄가 갈라짐을 키움)
  const ind: string[] = []; let s2 = 0;
  if (x.finish === "unknown") ind.push("후가공(접지·제본·박·형압)은 PDF에 들어 있지 않아 자동으로 알 수 없습니다. 후가공을 직접 고르면 판단합니다.");
  if (x.finish === "foil") { s2 += 2; ind.push("박·형압은 종이를 눌러 찍는 후가공이라 눌림이 직접 생긴다 (정의상)"); }
  if (x.finish === "bind") { s2 += 1; ind.push("제본 공정의 압력·마찰·이송이 눌림 자국을 만든다 (Müller Martini)"); }
  if (x.finish === "fold") {
    s2 += 1; ind.push("오시 압력이 낮으면 접는 선이 얕고 높으면 섬유가 깨져 갈라진다 (한국펄프종이공학회지 2008)");
    if (p.coated === true) { s2 += 1; ind.push("코팅지는 접힌 선을 따라 흰 줄 갈라짐이 생긴다 (같은 논문)"); }
    if (warm) { s2 += 1; ind.push("잉크를 많이 찍은 면은 유연성이 떨어져 갈라짐이 커진다 (같은 논문)"); }
    if (x.gsm >= 170) { s2 += 1; ind.push(`평량 ${x.gsm}g로 두꺼워 접을 때 힘이 크게 걸린다 (추정)`); }
  }

  // 색판 어긋남: 주원인은 인쇄기·판·축임물 양(Wikipedia Trap, US6253678, JPMTR 2015). 종이 종류 차이는 직접 비교 자료가 없다.
  const mr: string[] = ["어긋남의 주원인은 판·인쇄기·축임물 양과 종이 섬유 방향이라 PDF와 종이 종류만으로는 근거가 약하다 (Wikipedia, JPMTR 2015)"];
  let s3 = 0;
  if (p.coated === false) { s3 += 1; mr.push(`${p.name}는 비코팅지라 축임물을 더 흡수해 늘어날 수 있다 (추정: 코팅지와 직접 비교한 자료를 찾지 못함)`); }

  // 농도 얼룩: 종이 관련 얼룩은 대부분 코팅지, 비코팅지는 드물다(이학래 2008). 넓은 단색 면에서 잘 보인다(Lee 외 2021).
  const mt: string[] = []; let s4 = 0;
  if (p.coated === true) { s4 += 2; mt.push(`${p.name}는 코팅지라 종이 관련 얼룩 문제가 주로 생기는 쪽이다 (이학래 2008)`); }
  else if (p.coated === false) mt.push(`${p.name}는 비코팅지라 얼룩 문제가 드물다 (이학래 2008)`);
  else mt.push(special);
  mt.push("넓은 단색 면에서 잘 보인다 (Lee 외 2021) — PDF의 단색 면적은 아직 재지 않아 점수에 넣지 않았다");

  const bd = ["줄무늬(기어 줄)는 기어 유격·롤러·블랭킷 같은 인쇄기 기계 요인이 주원인이라 PDF로 예측하지 않는다 (Valente 외 WACV 2020, US4962705)"];

  return [
    { id: "setoff", name: "뒷묻음 (Set-off)", level: lv(s1, 2, 4), score: s1, reasons: so, query: "뒷묻음 잉크막이 두꺼울 때 건조 분말 쌓은 높이" },
    { id: "indent", name: "눌림·압흔 (Indentation)", level: x.finish === "unknown" ? "na" : lv(s2, 2, 4), score: s2, reasons: ind, query: "눌림 압흔 오시 괘선 압력 코팅 판지 갈라짐" },
    { id: "misreg", name: "핀트 불량·색판 어긋남 (Misregistration)", level: p.coated === null ? "na" : lv(s3, 1, 9), score: s3, reasons: p.coated === null ? [...mr, special] : mr, query: "색판 어긋남 축임물 종이가 늘어남 트래핑", weak: true },
    { id: "mottle", name: "농도 얼룩 (Mottling)", level: p.coated === null ? "na" : lv(s4, 2, 9), score: s4, reasons: mt, query: "농도 얼룩 mottle 코팅지 잉크 흡수성 단색 면" },
    { id: "banding", name: "줄무늬 (Banding)", level: "na", score: 0, reasons: bd, query: "줄무늬 banding 기어 줄 인쇄기 기계 요인" },
  ];
}
