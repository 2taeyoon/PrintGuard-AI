// preflight 에이전트(:8702) — PDF 구조 검사. 앱의 lib/analyze.ts를 그대로 쓴다(색 엔진 없이).
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { analyze } from "../lib/analyze";
import { loadPdf, serveAgent, type AgentCard } from "./lib/agent";

export const card: AgentCard = {
  name: "preflight", description: "PDF 구조 검사(판형·도련·폰트 포함·해상도·안전 영역·문구 휴리스틱). 상태를 바꾸지 않는다.", url: "http://127.0.0.1:8702",
  skills: [{ id: "check_structure", description: "pdf_ref와 완성 크기·도련으로 구조 문제를 찾는다", grade: "read", allowed_requesters: ["orchestrator", "report"],
    input_schema: { pdf_ref: "sha256", width_mm: "number", height_mm: "number", bleed_mm: "number" },
    output_schema: { pages: "number", page_sizes: "[{w,h}]", issues: "Issue[]", texts: "string[] (쪽별 본문, untrusted)" } }],
};


serveAgent(card, {
  async check_structure(req) {
    const i = req.input as { pdf_ref: string; width_mm: number; height_mm: number; bleed_mm: number };
    const r = await analyze(loadPdf(i.pdf_ref), pdfjs, { widthMm: i.width_mm, heightMm: i.height_mm, bleedMm: i.bleed_mm });
    const issues = r.issues.map((it) => ({ ...it, heat: undefined, key: `pf-${it.id}` }));
    return { status: "completed", output: { pages: r.pages, page_sizes: r.pageSizes, issues, texts: r.texts, color_summary: r.colorSummary },
      evidence: { queries: [], data_summary: `${r.pages}쪽, 이슈 ${issues.length}건`, ref_ids: [i.pdf_ref.slice(0, 12)] } };
  },
});
