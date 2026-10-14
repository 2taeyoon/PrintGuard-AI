// 종이 데이터는 eval/papers/build_papers.py가 만든 public/data/papers.json에서 읽는다.
// 기본 종류(kind: "type")는 한국제지연합회 분류 등 원문을 확인한 설명이고, 브랜드 종이(kind: "brand")는 두성종이·삼원페이퍼·국내 제지사 자료다.
// 프로파일은 종류 단위로 연결하며, 그 종이를 직접 측정한 프로파일이 아니면 approx(근사)다.

export type Profile = {
  file: string; name: string; condition: string; tac: number; tacSource: string;
  white: [number, number, number]; blackL: number; tacMeasured: number;
};

export type Paper = {
  id: string; name: string; kind: "type" | "brand"; group: string; type: string;
  coated: boolean | null; // null: 펄·합성·색지처럼 일반 코팅/비코팅으로 나누기 어려움
  profile: string; approx: boolean; note: string; use: string; src: string; warn: string | null;
  maker: string; gsm: string; url: string;
};

export type PaperDb = { generated: string; sources: Record<string, string>; profiles: Record<string, Profile>; papers: Paper[] };

export const GROUPS = ["코팅지", "비코팅지", "판지", "특수지"] as const;

let cache: Promise<PaperDb> | null = null;
export function loadPapers(): Promise<PaperDb> {
  cache ??= fetch("/data/papers.json").then((r) => {
    if (!r.ok) throw new Error(`종이 데이터를 읽지 못했습니다 (${r.status})`);
    return r.json() as Promise<PaperDb>;
  });
  return cache;
}

export const surface = (p: Paper) => (p.coated === true ? "코팅" : p.coated === false ? "비코팅" : "특수");

// 후가공은 PDF 안에 정보가 없어 자동으로 알 수 없다. 사용자가 고르지 않으면(unknown) 눌림 위험은 '판단 불가'로 둔다.
export const FINISHES = [
  { id: "unknown", name: "모름 (선택 안 함)" },
  { id: "none", name: "후가공 없음" },
  { id: "fold", name: "접지·오시(접는 선)" },
  { id: "bind", name: "중철·무선 제본" },
  { id: "foil", name: "박·형압(눌러 찍는 후가공)" },
] as const;
export type FinishId = (typeof FINISHES)[number]["id"];
