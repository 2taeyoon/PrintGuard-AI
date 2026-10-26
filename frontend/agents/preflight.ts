// preflight 에이전트(:8702) — PDF 구조 검사. 앱의 lib/analyze.ts를 그대로 쓴다(색 엔진 없이).
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { analyze } from "../lib/analyze";
import { loadPdf, serveAgent, type AgentCard } from "./lib/agent";

export const card: AgentCard = {
  name: "preflight", description: "PDF 구조 검사(판형·도련·폰트 포함·해상도·안전 영역·문구 휴리스틱). 상태를 바꾸지 않는다.", url: "http://127.0.0.1:8702",
  skills: [{ id: "check_structure", description: "pdf_ref와 완성 크기·도련으로 구조 문제를 찾는다", grade: "read", allowed_requesters: ["orchestrator", "report"],
    input_schema: { pdf_ref: "sha256", width_mm: "number", height_mm: "number", bleed_mm: "number" },
    output_schema: { pages: "number", page_sizes: "[{w,h}]", issues: "Issue[]", texts: "string[] (쪽별 본문, untrusted)" } },
    // B 등급 shop.request_quote의 검증자: 견적에 적힌 사양(쪽수·완성 크기)이 실제 PDF와 맞는지 코드로 대조한다
    { id: "verify_spec", description: "주문 사양(쪽수·완성 크기)이 PDF와 맞는지 대조한다(검증자)", grade: "read", allowed_requesters: ["safety"],
      input_schema: { pdf_ref: "sha256", spec: "{pages, width_mm, height_mm, bleed_mm}" }, output_schema: { match: "boolean", mismatches: "string[]" } }],
};

const MM = 72 / 25.4;


serveAgent(card, {
  async check_structure(req) {
    const i = req.input as { pdf_ref: string; width_mm: number; height_mm: number; bleed_mm: number };
    const r = await analyze(loadPdf(i.pdf_ref), pdfjs, { widthMm: i.width_mm, heightMm: i.height_mm, bleedMm: i.bleed_mm });
    const issues = r.issues.map((it) => ({ ...it, heat: undefined, key: `pf-${it.id}` }));
    return { status: "completed", output: { pages: r.pages, page_sizes: r.pageSizes, issues, texts: r.texts, color_summary: r.colorSummary },
      evidence: { queries: [], data_summary: `${r.pages}쪽, 이슈 ${issues.length}건`, ref_ids: [i.pdf_ref.slice(0, 12)] } };
  },
  async verify_spec(req) {
    const i = req.input as { pdf_ref: string; spec: { pages: number; width_mm: number; height_mm: number; bleed_mm?: number } };
    const doc = await pdfjs.getDocument({ data: loadPdf(i.pdf_ref) }).promise;
    const [x0, y0, x1, y1] = (await doc.getPage(1)).view as number[];
    const w = (x1 - x0) / MM, h = (y1 - y0) / MM, s = i.spec, tol = 2 * (s.bleed_mm ?? 0) + 1;
    const fits = (a: number, b: number) => a >= s.width_mm - 1 && a <= s.width_mm + tol && b >= s.height_mm - 1 && b <= s.height_mm + tol;
    const mismatches: string[] = [];
    if (doc.numPages !== Number(s.pages)) mismatches.push(`쪽수: 주문 ${s.pages}쪽, PDF ${doc.numPages}쪽`);
    if (!fits(w, h) && !fits(h, w)) mismatches.push(`크기: 주문 ${s.width_mm}×${s.height_mm}mm, PDF ${w.toFixed(1)}×${h.toFixed(1)}mm`);
    return { status: "completed", output: { match: mismatches.length === 0, mismatches, pdf: { pages: doc.numPages, width_mm: +w.toFixed(1), height_mm: +h.toFixed(1) } } };
  },
});
