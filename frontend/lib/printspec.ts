// 인쇄소 납품 규격. 검사 기준(도련·안전 여백·해상도·잉크량·PDF/X·가는 선·작은 검정 글자)을
// 한 묶음으로 고른다.
//
// **왜 묶음인가.** 인쇄소마다 요구가 다르다 — 도련 3mm인 곳과 5mm인 곳, PDF/X-1a만 받는 곳과
// X-4를 받는 곳. 지금까지는 기준이 코드 안에 박혀 있어서(150ppi, 안쪽 3mm) '우리 인쇄소는 다르다'를
// 검사에 넣을 길이 없었다. 받는 쪽 규격으로 검사해야 '통과'가 그 인쇄소에서 통과다.
//
// 여기 있는 프리셋은 **특정 인쇄소의 규격이 아니다.** 인쇄 방식별로 흔히 쓰는 값이다. 실제 납품처의
// 작업 안내(보통 '파일 접수 안내'·'작업 가이드')를 받으면 그 값으로 고쳐 '내 규격'으로 저장해 쓴다.

export type PdfX = "any" | "X-1a" | "X-4";

export type PrintSpec = {
  id: string;
  name: string;
  note: string;
  bleedMm: number;       // 재단선 밖 도련
  safeMm: number;        // 재단선 안쪽, 글자를 두지 말아야 할 너비
  minPpi: number;        // 이보다 낮으면 '해상도 낮음'
  goodPpi: number;       // 권장 해상도. 사진 크기 안내는 이 값으로 계산한다
  tacLimit: number;      // 총 잉크량 한도(%). 사진뿐 아니라 벡터 면·글자에도 쓴다
  pdfx: PdfX;            // 요구하는 PDF/X. any면 보지 않는다
  minLinePt: number;     // 이보다 가는 선은 인쇄에서 끊기거나 사라진다
  richBlackMaxPt: number; // 이 크기보다 작은 글자가 4색 검정이면 경고
};

/** 지금까지 코드에 박혀 있던 값과 같다. 규격을 고르지 않으면 검사 결과가 전과 같아야 한다. */
export const DEFAULT_SPEC: PrintSpec = {
  id: "default", name: "일반 옵셋(기본)", note: "따로 받은 규격이 없을 때 씁니다. 도련 3mm, 안쪽 여백 3mm, 150ppi 이상(권장 300ppi).",
  bleedMm: 3, safeMm: 3, minPpi: 150, goodPpi: 300, tacLimit: 300, pdfx: "any", minLinePt: 0.25, richBlackMaxPt: 12,
};

export const SPECS: PrintSpec[] = [
  DEFAULT_SPEC,
  { ...DEFAULT_SPEC, id: "offset-x1a", name: "옵셋 · PDF/X-1a 접수",
    note: "PDF/X-1a만 받는 곳. X-1a는 RGB와 투명도를 받지 않으므로, 둘 중 하나라도 있으면 막힘으로 봅니다.", pdfx: "X-1a" },
  { ...DEFAULT_SPEC, id: "offset-x4", name: "옵셋 · PDF/X-4 접수",
    note: "PDF/X-4로 받는 곳. 투명도와 RGB를 받지만, 출력 의도(Output Intent)가 들어 있어야 합니다.", pdfx: "X-4" },
  { ...DEFAULT_SPEC, id: "digital", name: "디지털(토너) 인쇄",
    note: "소량 디지털 인쇄. 토너는 잉크보다 적게 올라가므로 잉크량 한도를 낮게 잡습니다.", bleedMm: 2, tacLimit: 260 },
  { ...DEFAULT_SPEC, id: "large", name: "대형 출력(현수막·배너)",
    note: "멀리서 보는 출력물. 해상도 기준이 낮고 도련은 넉넉하게 둡니다.", bleedMm: 5, safeMm: 10, minPpi: 72, goodPpi: 150, minLinePt: 0.5, richBlackMaxPt: 24 },
];

export const PDFX_LABEL: Record<PdfX, string> = { any: "보지 않음", "X-1a": "PDF/X-1a", "X-4": "PDF/X-4" };

// ---------- 내 규격(이 브라우저에만) ----------
// 납품처에서 받은 규격을 이름 붙여 저장한다. 다시 받을 수 있는 열쇠가 아니라 작업 설정이라 브라우저에
// 둔다. 사생활 창·지운 사이트 데이터에서는 비어 있을 수 있다 — 그래도 기본 프리셋으로 검사는 돈다.
const KEY = "pg.printspecs.v1";

export function loadMySpecs(): PrintSpec[] {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter(isSpec) : [];
  } catch { return []; }
}

export function saveMySpecs(list: PrintSpec[]): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; }
}

function isSpec(x: unknown): x is PrintSpec {
  const s = x as PrintSpec;
  return !!s && typeof s.id === "string" && typeof s.name === "string"
    && ["bleedMm", "safeMm", "minPpi", "goodPpi", "tacLimit", "minLinePt", "richBlackMaxPt"].every((k) => typeof (s as never)[k] === "number")
    && (s.pdfx === "any" || s.pdfx === "X-1a" || s.pdfx === "X-4");
}

/** 에이전트로 넘길 때 쓰는 모양. 이름·설명은 검사에 쓰지 않으므로 뺀다. */
export function specOption(s: PrintSpec) {
  const { bleedMm, safeMm, minPpi, goodPpi, tacLimit, pdfx, minLinePt, richBlackMaxPt } = s;
  return { bleedMm, safeMm, minPpi, goodPpi, tacLimit, pdfx, minLinePt, richBlackMaxPt };
}
export type SpecOption = ReturnType<typeof specOption>;
