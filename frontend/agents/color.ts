// color 에이전트(:8703) — 종이별 ICC 프로파일로 인쇄 색 차이(ΔE2000)·총 잉크량 예측. lib/color.ts·lib/analyze.ts를 그대로 쓴다.
// recompute_delta_e: 다른 에이전트(보고서 등)가 적은 ΔE 수치를 코드로 다시 계산해 대조하는 검증자 skill.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { analyze } from "../lib/analyze";
import { ColorEngine, type IntentName } from "../lib/color";
import type { PaperDb } from "../lib/papers";
import { loadPdf, serveAgent, ROOT, type AgentCard } from "./lib/agent";

const DB: PaperDb = JSON.parse(readFileSync(resolve(ROOT, "frontend/public/data/papers.json"), "utf8"));

export const card: AgentCard = {
  name: "color", description: "종이·인쇄 조건별 CMYK 변환 색 차이(ΔE2000)·총 잉크량·색 차이 지도. 상태를 바꾸지 않는다.", url: "http://127.0.0.1:8703",
  skills: [
    { id: "predict_color", description: "PDF 안 RGB 이미지를 고른 종이의 프로파일로 바꿨을 때 색 차이를 잰다", grade: "read", allowed_requesters: ["orchestrator", "report"],
      input_schema: { pdf_ref: "sha256", paper_id: "string", profile: "auto|프로파일 키", intent: "relative|perceptual|saturation", tac_limit: "number?", paper_color: "boolean",
        substrate_white: "[L,a,b]? 측정한 종이 흰색(절대 Lab). 넣으면 프로파일이 가정한 종이 대신 이 종이 기준으로 옮긴다" },
      output_schema: { color_report: "ColorReport", issues: "Issue[] (heat: base64 RGBA)", max_tac: "number", tac_limit: "number", profile: "string", substrate: "{profileWhite,targetWhite,method}|null" } },
    { id: "recompute_delta_e", description: "주장된 면적 가중 평균 ΔE를 다시 계산해 일치 여부를 돌려준다(검증자)", grade: "read", allowed_requesters: ["report", "safety", "orchestrator"],
      input_schema: { pdf_ref: "sha256", paper_id: "string", profile: "string", claimed_mean_de: "number", tolerance: "number" }, output_schema: { match: "boolean", recomputed: "number" } },
  ],
};

/** 측정한 종이 흰색은 Lab 3개 숫자만 받는다(범위 밖이면 무시하지 않고 거절한다 — 조용히 틀린 수치를 쓰지 않는다) */
function substrateWhite(v: unknown): [number, number, number] | undefined {
  if (v === undefined || v === null) return undefined;
  const a = (Array.isArray(v) ? v : []).map(Number);
  if (a.length !== 3 || a.some((x) => !Number.isFinite(x)) || a[0] < 0 || a[0] > 100 || Math.abs(a[1]) > 128 || Math.abs(a[2]) > 128)
    throw new Error("substrate_white는 [L,a,b] 3개 숫자여야 합니다(L 0~100, a·b ±128)");
  return [a[0], a[1], a[2]];
}

async function run(i: Record<string, unknown>) {
  const paper = DB.papers.find((p) => p.id === i.paper_id) ?? DB.papers.find((p) => p.id === "art")!;
  const key = !i.profile || i.profile === "auto" ? paper.profile : String(i.profile);
  const prof = DB.profiles[key];
  if (!prof) throw new Error(`없는 프로파일: ${key}`);
  const tac = Number(i.tac_limit ?? prof.tac);
  const eng = await ColorEngine.create(new Uint8Array(readFileSync(resolve(ROOT, "frontend/public/icc", prof.file))),
    { intent: (i.intent as IntentName) ?? "relative", tacLimit: tac, paperColor: i.paper_color !== false,
      substrateWhite: substrateWhite(i.substrate_white) });
  const r = await analyze(loadPdf(i.pdf_ref), pdfjs, { widthMm: Number(i.width_mm ?? 148), heightMm: Number(i.height_mm ?? 210), bleedMm: Number(i.bleed_mm ?? 0), color: eng });
  return { r, prof, key, tac, paper, eng };
}

serveAgent(card, {
  async predict_color(req) {
    const { r, prof, key, tac, paper, eng } = await run(req.input);
    const issues = r.issues.filter((it) => it.metrics).map((it) => ({ ...it, key: `co-${it.id}`,
      heat: it.heat ? { w: it.heat.w, h: it.heat.h, rgba: Buffer.from(it.heat.rgba).toString("base64") } : undefined }));
    const maxTac = Math.max(0, ...issues.map((it) => it.metrics?.maxTAC ?? 0));
    return { status: "completed", output: { color_report: r.colorReport, issues, max_tac: maxTac, tac_limit: tac, profile: prof.name, profile_key: key, paper_id: paper.id, substrate: eng.substrate },
      evidence: { queries: [], data_summary: `${prof.name}, 이미지 ${issues.length}개`, ref_ids: [String(req.input.pdf_ref).slice(0, 12)] } };
  },
  async recompute_delta_e(req) {
    const { r } = await run({ ...req.input, paper_color: req.input.paper_color ?? true });
    const got = r.colorReport?.weightedMeanDE ?? 0;
    const tol = Number(req.input.tolerance ?? 0.05);
    return { status: "completed", output: { match: Math.abs(got - Number(req.input.claimed_mean_de)) <= tol, recomputed: got } };
  },
});
