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
  ],
};

serveAgent(card, {
  async assess_risk(req) {
    const i = req.input;
    const paper = paperOf(i.paper_id);
    if (!paper) return { status: "rejected", outcome: "INVALID_INPUT", output: { message: `없는 종이: ${i.paper_id}` } };
    const risks = assess({ paper, finish: (i.finish as FinishId) ?? "unknown", gsm: Number(i.gsm ?? 150), maxTAC: Number(i.max_tac ?? 0),
      tacLimit: Number(i.tac_limit ?? DB.profiles[paper.profile].tac), imageShare: Number(i.image_share ?? 0), hasImages: Boolean(i.has_images) });
    return { status: "completed", output: { paper: { id: paper.id, name: paper.name, maker: paper.maker, warn: paper.warn }, risks },
      evidence: { queries: [], data_summary: `${paper.name}, 후가공 ${i.finish}`, ref_ids: [paper.id] } };
  },
});
