// 에이전트 모드: 로컬 오케스트레이터(agents/, 기본 http://127.0.0.1:8700)에 검수를 맡기고 결과를 앱 화면 형식으로 바꾼다.
// 바로 검사 모드(브라우저 안에서만)와 화면은 같고, 계산은 각 에이전트가 한다.
import type { Analysis, Issue } from "./analyze";
import type { Hit } from "./guide";
import type { Risk } from "./risk";

export const ORCH = process.env.NEXT_PUBLIC_PG_ORCHESTRATOR ?? "http://127.0.0.1:8700";

export type Step = { agent: string; skill: string; key: string; status: string; outcome: string | null; ms: number; fallback: boolean };
export type Question = { field: string; text: string; options: { value: string; label: string; hint?: string }[]; agent: string; skill: string; why?: string };
export type JobView = { context_id: string; status: string; filename: string; steps: Step[]; question: Question | null; results: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
export type AgentInfo = { status: "on" | "off" | "fake"; card: { name: string; description: string; skills: { id: string; description: string; grade: string; allowed_requesters: string[]; verifier?: string | null }[] } | null };
export type LogRow = { id: number; at: string; context_id: string; kind: string; source: string; requester: string | null; skill: string | null; status: string | null; outcome: string | null; grade: string | null; payload: Record<string, unknown> };

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => "")}`.slice(0, 200));
  return (await r.json()).data as T;
}

export async function orchestratorUp(): Promise<boolean> {
  try { return (await fetch(`${ORCH}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}
export const listAgents = async () => j<Record<string, AgentInfo>>(await fetch(`${ORCH}/agents`));
export const listLogs = async (ctx?: string) => j<LogRow[]>(await fetch(`${ORCH}/logs${ctx ? `?context_id=${encodeURIComponent(ctx)}` : ""}`));
export const getJob = async (ctx: string) => j<JobView>(await fetch(`${ORCH}/jobs/${ctx}`));
export const answerJob = async (ctx: string, value: string) =>
  j<unknown>(await fetch(`${ORCH}/jobs/${ctx}/answer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) }));

export async function createJob(file: File, options: Record<string, unknown>): Promise<{ context_id: string; duplicate: boolean }> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("options", JSON.stringify(options));
  return j(await fetch(`${ORCH}/jobs`, { method: "POST", body: fd }));
}

/** 끝나거나(completed·failed) 질문이 생길 때까지 상태를 받아 온다. 진행 중에는 onStep으로 단계를 알린다. */
export async function waitJob(ctx: string, onUpdate: (j: JobView) => void, timeoutMs = 300000): Promise<JobView> {
  const t0 = Date.now();
  for (;;) {
    const v = await getJob(ctx);
    onUpdate(v);
    if (v.status !== "working") return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("에이전트 응답 시간이 초과되었습니다");
    await new Promise((r) => setTimeout(r, 400));
  }
}

const b64 = (s: string) => Uint8ClampedArray.from(atob(s), (c) => c.charCodeAt(0));

/** 에이전트 결과 → 화면 형식. 색 결과가 있으면 사전 검사의 'RGB 이미지 포함' 경고는 ΔE 결과로 대체되므로 뺀다. */
export function toScreen(v: JobView): { analysis: Analysis; risks: (Risk & { hits: Hit[] })[]; hits: Record<number, Hit[]>; texts: string[] } {
  const pf = v.results.preflight ?? {}, co = v.results.color ?? {}, gd = v.results.guide?.hits ?? {};
  const colorIssues = (co.issues ?? []) as (Issue & { key: string; heat?: { w: number; h: number; rgba: string } })[];
  const base = ((pf.issues ?? []) as (Issue & { key: string })[]).filter((it) => !(colorIssues.length && it.title === "RGB 이미지 포함"));
  const toHit = (h: { doc: string; title: string; text: string; child: string; score: number }): Hit => ({ section: { doc: h.doc, title: h.title, text: h.text }, score: h.score, child: h.child });
  // 교정 에이전트의 제안: 자동으로 고치지 않으므로 '수정 제안'으로만 보여 준다
  type Sug = { key: string; page: number; original: string; suggestion: string; reason: string; kind: string; kind_label: string; source: string; rect: number[] | null };
  const proof = ((v.results.proofread?.suggestions ?? []) as Sug[]).map((s) => ({
    key: s.key, id: 0, kind: "typo", severity: s.kind === "typo" || s.kind === "llm" ? "low" : "medium", page: s.page,
    title: `${s.kind_label}: '${s.original}' → '${s.suggestion}'`, detail: `${s.reason} (탐지: ${s.source === "rules" ? "규칙" : s.source === "kiwi_typo" ? "Kiwi 오타 모델" : s.source})`,
    fix: "원본 파일에서 직접 고치세요. 자동으로 고치지 않습니다.", rect: s.rect, source: "proofread" as const, heat: undefined,
  })) as unknown as (Issue & { key: string })[];
  const all = [...base.map((it) => ({ ...it, heat: undefined })), ...colorIssues.map((it) => ({ ...it, heat: it.heat ? { w: it.heat.w, h: it.heat.h, rgba: b64(it.heat.rgba) } : undefined })), ...proof];
  const order = { high: 0, medium: 1, low: 2 } as const;
  all.sort((a, b) => order[a.severity] - order[b.severity] || a.page - b.page);
  const hits: Record<number, Hit[]> = {};
  const issues: Issue[] = all.map((it, i) => {
    hits[i + 1] = (gd[`issue:${it.key}`] ?? gd[`proof:${it.key}`] ?? []).map(toHit);
    const rest: Partial<typeof it> = { ...it };
    delete rest.key;
    return { ...rest, id: i + 1 } as Issue;
  });
  const risks = ((v.results.risk?.risks ?? []) as Risk[]).map((r) => ({ ...r, hits: (gd[`risk:${r.id}`] ?? []).slice(0, 1).map(toHit) }));
  const analysis: Analysis = { pages: pf.pages ?? 0, pageSizes: pf.page_sizes ?? [], issues, colorSummary: pf.color_summary ?? {}, texts: pf.texts ?? [], colorReport: co.color_report ?? null };
  return { analysis, risks, hits, texts: pf.texts ?? [] };
}
export type JobRow = { context_id: string; status: string; filename: string; created: number };
export const listJobs = async () => j<JobRow[]>(await fetch(`${ORCH}/jobs`));
