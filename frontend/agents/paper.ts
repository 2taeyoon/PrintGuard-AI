// paper 에이전트(:8705) — 종이 데이터(public/data/papers.json)와 불량 위험도 점수표(lib/risk.ts).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FinishId, PaperDb } from "../lib/papers";
import { assess } from "../lib/risk";
import { serveAgent, ROOT, type AgentCard } from "./lib/agent";

const DB: PaperDb = JSON.parse(readFileSync(resolve(ROOT, "frontend/public/data/papers.json"), "utf8"));
const paperOf = (id: unknown) => DB.papers.find((p) => p.id === id);

export const card: AgentCard = {
  name: "paper", description: "종이 491종 데이터와 인쇄 불량 위험도(뒷묻음·눌림·어긋남·얼룩·줄무늬) 점수표. 상태를 바꾸지 않는다.", url: "http://127.0.0.1:8705",
  skills: [
    { id: "assess_risk", description: "종이·후가공·평량과 색 결과(최대 잉크량·이미지 면적)로 불량 위험도를 매긴다", grade: "read", allowed_requesters: ["orchestrator", "report"],
      input_schema: { paper_id: "string", finish: "unknown|none|fold|bind|foil", gsm: "number", max_tac: "number", tac_limit: "number", image_share: "number", has_images: "boolean" },
      output_schema: { paper: "Paper", risks: "Risk[]" } },
    { id: "recommend_paper", description: "종이를 모를 때 PDF 특징(쪽수·판형·이미지·글 양)으로 종이 후보 3개를 근거와 함께 묻는다(input-required)", grade: "read",
      allowed_requesters: ["orchestrator"], input_schema: { pages: "number", width_mm: "number", height_mm: "number", images: "number", text_chars: "number", chosen: "string?" },
      output_schema: { paper_id: "string" } },
  ],
};

// 후가공 질문: 눌림 위험은 후가공에 따라 정해지는데 PDF에는 그 정보가 없다(근거: KB 6.4)
const FINISH_Q = {
  field: "finish", text: "후가공이 있나요?",
  why: "눌림·갈라짐 위험은 후가공에 따라 달라지는데, PDF 파일에는 후가공 정보가 없어 자동으로 알 수 없습니다. 답하시면 눌림 위험만 다시 계산합니다.",
  options: [
    { value: "none", label: "후가공 없음" },
    { value: "fold", label: "접지·오시", hint: "접는 선을 따라 갈라짐 위험" },
    { value: "bind", label: "중철·무선 제본", hint: "제본 압력·마찰 자국" },
    { value: "foil", label: "박·형압", hint: "눌러 찍는 후가공" },
  ],
};

/** 종이 후보: 근거는 한국제지연합회 분류·프린트올데이 종이 상식의 용도 설명(papers.json의 use·note) */
function recommend(i: Record<string, unknown>) {
  const pages = Number(i.pages ?? 1), w = Number(i.width_mm ?? 148), h = Number(i.height_mm ?? 210), images = Number(i.images ?? 0), chars = Number(i.text_chars ?? 0);
  const small = Math.max(w, h) <= 150, perPageChars = chars / Math.max(pages, 1), imagePerPage = images / Math.max(pages, 1);
  let ids: string[]; let basis: string;
  if (small && pages <= 2) { ids = ["coated_brand", "board1", "art"]; basis = `작은 판형(${w}×${h}mm)·${pages}쪽이라 카드·명함류로 보고 두꺼운 고급지·판지를 먼저 권합니다`; }
  else if (imagePerPage >= 0.5 && perPageChars < 1500) { ids = ["art", "snow", "mfc"]; basis = `쪽당 이미지 ${imagePerPage.toFixed(1)}개로 이미지 중심이라 색 표현이 좋은 코팅지를 권합니다`; }
  else if (pages >= 16 && perPageChars >= 800) { ids = ["woodfree_yellow", "woodfree", "bulk"]; basis = `${pages}쪽·쪽당 글자 약 ${Math.round(perPageChars)}자로 글 중심 책자라 본문용 비코팅지를 권합니다`; }
  else { ids = ["snow", "art", "woodfree"]; basis = "글과 이미지가 섞인 일반 인쇄물이라 범용 코팅지와 백상지를 권합니다"; }
  const opts = ids.map((id) => DB.papers.find((p) => p.id === id)!).filter(Boolean)
    .map((p) => ({ value: p.id, label: p.name, hint: p.use && p.use !== "—" ? `용도: ${p.use}` : p.note.slice(0, 40) }));
  return { field: "paper_id", text: "어떤 종이에 인쇄하나요?", why: `종이를 정하지 않으셨습니다. ${basis}. (근거: 종이 데이터의 용도 설명)`, options: opts };
}

serveAgent(card, {
  async recommend_paper(req) {
    const chosen = req.input.chosen;
    if (typeof chosen === "string" && paperOf(chosen)) return { status: "completed", output: { paper_id: chosen } };
    return { status: "input-required", reason_code: "customer_input", question: recommend(req.input), output: {} };
  },
  async assess_risk(req) {
    const i = req.input;
    if (i.finish === "unknown" && i.ask_finish !== false)
      return { status: "input-required", reason_code: "customer_input", question: FINISH_Q, output: {} };
    const paper = paperOf(i.paper_id);
    if (!paper) return { status: "rejected", outcome: "INVALID_INPUT", output: { message: `없는 종이: ${i.paper_id}` } };
    const risks = assess({ paper, finish: (i.finish as FinishId) ?? "unknown", gsm: Number(i.gsm ?? 150), maxTAC: Number(i.max_tac ?? 0),
      tacLimit: Number(i.tac_limit ?? DB.profiles[paper.profile].tac), imageShare: Number(i.image_share ?? 0), hasImages: Boolean(i.has_images) });
    return { status: "completed", output: { paper: { id: paper.id, name: paper.name, maker: paper.maker, warn: paper.warn }, risks },
      evidence: { queries: [], data_summary: `${paper.name}, 후가공 ${i.finish}`, ref_ids: [paper.id] } };
  },
});
