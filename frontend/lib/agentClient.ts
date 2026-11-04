// 에이전트 모드: 로컬 오케스트레이터(agents/, 기본 http://127.0.0.1:8700)에 검수를 맡기고 결과를 앱 화면 형식으로 바꾼다.
// 바로 검사 모드(브라우저 안에서만)와 화면은 같고, 계산은 각 에이전트가 한다.
import type { Analysis, Issue } from "./analyze";
import type { Fix } from "./fixlist";
import type { Hit } from "./guide";
import type { Risk } from "./risk";

/** 빌드할 때 박히는 주소. 비워 두면 내 PC의 에이전트를 부른다. */
export const ORCH_BUILT = process.env.NEXT_PUBLIC_PG_ORCHESTRATOR ?? "http://127.0.0.1:8700";
const ORCH_KEY = "pg.orchestrator";
let typed: string | null = null; // null = 아직 저장된 값을 읽지 않음, "" = 저장된 값 없음

/** 지금 부를 에이전트 주소. 화면에서 넣어 둔 값이 있으면 그것, 없으면 빌드할 때 박힌 값.
 *  터널 주소는 켤 때마다 바뀌는데 NEXT_PUBLIC_ 값은 빌드 때 박혀서, 화면에서 바꿀 길을 둔다. */
export function orchUrl(): string {
  if (typed === null) {
    try { typed = typeof window === "undefined" ? "" : localStorage.getItem(ORCH_KEY) ?? ""; } catch { typed = ""; }
  }
  return trimUrl(typed || ORCH_BUILT);
}
/** 주소를 이 브라우저에만 저장한다(빈 값이면 지우고 빌드할 때 박힌 값으로 돌아간다). 주소 꼴이 아니면 false */
export function setOrchUrl(v: string): boolean {
  const s = trimUrl(v);
  if (s && !/^https?:\/\/[^\s/?#]+$/.test(s)) return false;
  typed = s;
  try {
    if (s) localStorage.setItem(ORCH_KEY, s);
    else localStorage.removeItem(ORCH_KEY);
  } catch { /* 저장을 막아 둔 브라우저 */ }
  subs.forEach((f) => f());
  return true;
}

/* 주소를 React의 useSyncExternalStore로 읽게 해 둔다. 저장된 값을 첫 그림에서 바로 읽으면
   서버가 그린 화면(저장소가 없으니 빌드 값)과 브라우저가 그린 화면(저장된 값)이 어긋나
   hydration이 깨진다 — 주소를 한 번이라도 저장한 사람에게만 나던 오류다.
   서버 쪽 스냅샷으로 빌드 값을 주면 첫 그림이 양쪽 같아지고, 저장된 값은 그 직후에 반영된다. */
const subs = new Set<() => void>();
export function subscribeOrch(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
export const orchBuiltSnapshot = () => ORCH_BUILT;
const trimUrl = (s: string) => s.trim().replace(/\/+$/, "");

/* ---------- 이 세션의 토큰 ----------
   에이전트는 PC 한 대인데 공개 주소로 누구나 들어온다. 그래서 오케스트레이터는 토큰 안의
   주인이 맞는 의뢰만 돌려준다. **로그인이 아니다** — 누구인지는 묻지도 담지도 않는다.

   전에는 이 값을 브라우저가 `crypto.randomUUID()`로 스스로 만들어 `localStorage`에 넣어 두었다.
   서버가 발급하지 않으니 기한도 회수도 없고, 자격증명이 영구 저장소에 남아 스크립트 하나가
   새면 그 브라우저의 지난 의뢰가 영구히 열렸다. 지금은 서버가 기한을 붙여 발급하고(`POST
   /auth/session`), 브라우저는 **`sessionStorage`**에만 둔다 — 새로 고쳐도 남고 탭을 닫으면
   사라지는 수명이라 이 값에 딱 맞는다. 탭을 닫으면 지난 의뢰는 다시 못 본다(남도 못 본다). */
const TOKEN_KEY = "pg.session";
let tok: string | null = null;
let minting: Promise<string> | null = null;

const stored = () => { try { return sessionStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } };

/** 토큰을 버린다(만료되었을 때. 다음 요청에서 새로 받는다). */
export function forgetSession(): void {
  tok = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* 저장을 막아 둔 브라우저 */ }
}

async function mintSession(): Promise<string> {
  const r = await fetch(`${orchUrl()}/auth/session`, { method: "POST" });
  // 이 기능이 생기기 전에 켠 에이전트는 이 주소를 모른다. '세션 오류'로 뭉개면 아무도 못 고친다
  if (r.status === 404) throw new Error("에이전트가 옛 버전입니다. 에이전트를 돌리는 PC에서 다시 켜 주세요");
  if (!r.ok) throw new Error(`세션을 받지 못했습니다(${r.status})`);
  const t = (await r.json())?.data?.token;
  if (typeof t !== "string" || !t) throw new Error("세션을 받지 못했습니다");
  tok = t;
  try { sessionStorage.setItem(TOKEN_KEY, t); } catch { /* 저장을 막아 둔 브라우저 — 이 탭에서만 */ }
  return t;
}

/** 지금 쓸 토큰. 없으면 받아 온다. 동시에 여러 요청이 와도 발급은 한 번만 한다. */
async function token(): Promise<string> {
  if (tok) return tok;
  const s = stored();
  if (s) { tok = s; return s; }
  if (!minting) {
    minting = mintSession();
    void minting.catch(() => undefined).then(() => { minting = null; });
  }
  return minting;
}

/** 토큰을 붙여 오케스트레이터를 부른다. 만료되면(401) **한 번만** 새로 받아 다시 부른다.
 *  이 재시도가 없으면 탭을 오래 열어 둔 사람은 모든 화면이 빈 채로 멈춘다. */
async function call(path: string, init: RequestInit = {}, extra: Record<string, string> = {}): Promise<Response> {
  const go = async () => fetch(`${orchUrl()}${path}`, {
    ...init, headers: { ...extra, Authorization: `Bearer ${await token()}` },
  });
  const r = await go();
  if (r.status !== 401) return r;
  forgetSession();
  return go();
}
export const isLocalOrch = (u: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(u);
/** 에이전트가 내 PC가 아니라 다른 서버에 있는가(공개 배포·터널). 화면 문구와 기본 모드가 달라진다. */
export const hostedOrch = () => !isLocalOrch(orchUrl());

export type Step = { agent: string; skill: string; key: string; status: string; outcome: string | null; ms: number; fallback: boolean };
export type Question = { field: string; text: string; options: { value: string; label: string; hint?: string }[]; agent: string; skill: string; why?: string };
export type JobView = { context_id: string; status: string; filename: string; steps: Step[]; question: Question | null; results: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
export type AgentInfo = { status: "on" | "off" | "fake"; card: { name: string; description: string; skills: { id: string; description: string; grade: string; allowed_requesters: string[]; verifier?: string | null }[] } | null };
export type LogRow = { id: number; at: string; context_id: string; kind: string; source: string; requester: string | null; skill: string | null; status: string | null; outcome: string | null; grade: string | null; payload: Record<string, unknown> };

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => "")}`.slice(0, 200));
  return (await r.json()).data as T;
}

/** 살아 있는지 확인한다. 기다려 주는 시간은 에이전트가 어디 있느냐에 따라 다르다.
 *  내 PC면 1~2ms에 돌아오지만, 터널 너머면 실측 0.5초가 기본이고 연결을 새로 맺을 때는 1.3초,
 *  느릴 때는 4초까지 갔다. 1.5초로 재면 터널이 멀쩡한데도 꺼진 것으로 읽힌다. */
export async function orchestratorUp(): Promise<boolean> {
  const ms = isLocalOrch(orchUrl()) ? 2000 : 8000;
  try { return (await fetch(`${orchUrl()}/health`, { signal: AbortSignal.timeout(ms) })).ok; } catch { return false; }
}
export const listAgents = async () => j<Record<string, AgentInfo>>(await fetch(`${orchUrl()}/agents`));
export const listLogs = async (ctx?: string) => j<LogRow[]>(await call(`/logs${ctx ? `?context_id=${encodeURIComponent(ctx)}` : ""}`));
export const getJob = async (ctx: string) => j<JobView>(await call(`/jobs/${ctx}`));
export const answerJob = async (ctx: string, value: string) =>
  j<unknown>(await call(`/jobs/${ctx}/answer`, { method: "POST", body: JSON.stringify({ value }) }, { "Content-Type": "application/json" }));

export async function createJob(file: File, options: Record<string, unknown>): Promise<{ context_id: string; duplicate: boolean }> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("options", JSON.stringify(options));
  return j(await call("/jobs", { method: "POST", body: fd }));
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
    // 제목 문자열로 녹여 버리지 않고 따로 들고 간다 — 인디자인 원본 수정이 이 두 값으로 글자를 찾는다
    edit: { original: s.original, suggestion: s.suggestion },
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
export const listJobs = async () => j<JobRow[]>(await call("/jobs"));

// ---- 6단계: 추적(공통 로그의 요청↔결과 짝으로 만든 구간·관문·사건). 로그에 있는 것만 담긴다 ----
export type TraceSpan = { agent: string; skill: string | null; requester: string | null; start_ms: number; end_ms: number | null; ms: number | null;
  status: string | null; outcome: string | null; grade: string | null; open: boolean; unpaired?: boolean };
export type TraceGate = { at_ms: number; kind: string; source: string; requester: string | null; action: string | null; decision: string | null;
  grade: string | null; reason: string | null; amount: number | null; review_id: string | null; execution_id: string | null };
export type Trace = { context_id: string; t0: string | null; total_ms: number; spans: TraceSpan[]; gates: TraceGate[];
  events: { at_ms: number; kind: string; source: string; skill: string | null; status: string | null; outcome: string | null }[];
  agents: { agent: string; calls: number; ms: number; open: number }[]; lines: number };
export const getTrace = async (ctx: string) => j<Trace>(await call(`/trace?context_id=${encodeURIComponent(ctx)}`));

/** 에이전트 모드의 가이드 검색: guide 에이전트가 찾은 절을 앱 형식(Hit)으로 바꾼다 */
export async function searchGuideViaAgent(q: string, k = 5): Promise<Hit[]> {
  const rows = await j<{ doc: string; title: string; text: string; child: string; score: number }[]>(
    await fetch(`${orchUrl()}/guide?q=${encodeURIComponent(q)}&k=${k}`));
  return rows.map((h) => ({ section: { doc: h.doc, title: h.title, text: h.text }, score: h.score, child: h.child }));
}

// ---- 보고서(A 등급). 상태를 바꾸는 일은 safety 관문을 거친다 ----
export type AgentReply = { status: string; outcome: string | null; output: Record<string, any>; question: Record<string, any> | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
const post = async <T,>(path: string, body?: unknown, headers: Record<string, string> = {}) =>
  j<T>(await call(path, { method: "POST", body: JSON.stringify(body ?? {}) }, { "Content-Type": "application/json", ...headers }));
export const compileReport = (ctx: string) => post<AgentReply>(`/jobs/${ctx}/report`);

// ---- 인디자인 원본 수정(DesignCraft MCP). 검수는 PDF로 하지만 고칠 수 있는 것은 원본뿐이다 ----
export type McpStatus = {
  available: boolean; reason?: string; hint?: string; cli?: string | null; version?: string; mode?: string;
  protocol?: string; server?: string; server_version?: string; tools?: string[];
};
export const mcpStatus = async () => j<McpStatus>(await call("/designcraft/status"));

export type PreflightIssue = { severity: string; kind: string; message: string; page: number | null };
export type SourceView = {
  context_id: string; filename: string; pages: number; pdf_ref: string;
  stories: { id: number; length: number; overset: boolean; pages: number[]; preview: string }[];
  preflight: PreflightIssue[]; missing_fonts: string[]; open_warnings: string[];
  paragraph_styles: number; swatches: number; png: string; uploaded_files?: number;
};

/** 편집 파일을 올리고 바로 들여다본다(쪽·스토리·preflight + 검수용 PDF).
 *  파일 하나도 되고 **폴더째**도 된다 — 폴더로 주면 IDML 옆의 `Links/` 사진과 `Document fonts/`
 *  글꼴까지 같이 올라가, 끊긴 링크와 대체 글꼴 문제가 사라진다. 서버는 둘을 같은 방식으로 다룬다. */
export async function uploadSource(files: File[] | FileList): Promise<SourceView> {
  const list = Array.from(files);
  const fd = new FormData();
  // 폴더로 고르면 webkitRelativePath에 폴더 안 경로가 담긴다. 서버가 그 구조 그대로 풀어야
  // DesignCraft가 Links/에서 사진을 찾는다.
  for (const f of list) fd.append("files", f);
  fd.append("paths", JSON.stringify(list.map((f) => f.webkitRelativePath || f.name)));
  return j<SourceView>(await call("/designcraft/source", { method: "POST", body: fd }));
}

export type ApplyResult = {
  applied: { key?: string; page: number | null; original: string; suggestion: string; story: number; at: [number, number] }[];
  failed: { key?: string; page: number | null; original: string; suggestion: string; reason: string }[];
  pdf_ref: string; source_out: string | null;
  shots: { page: number; before: string; after: string }[];  // 바뀐 쪽만 찍는다
  shots_total: number;                                        // 바뀐 쪽이 더 있으면 이 수가 더 크다
  preflight_after: PreflightIssue[];
};
export const applyFixes = (ctx: string, fixes: Fix[]) =>
  post<AgentReply>(`/designcraft/${ctx}/apply`, { fixes });

/** 작업 폴더의 결과물 주소(전후 PNG, 고친 PDF/IDML). 주인만 받을 수 있다. */
const dcFilePath = (ctx: string, name: string) => `/designcraft/${ctx}/file/${encodeURIComponent(name)}`;
export const dcFileUrl = (ctx: string, name: string) => `${orchUrl()}${dcFilePath(ctx, name)}`;

/** 이미지·파일은 <img src>로 바로 못 건다 — 열쇠 헤더가 필요해서 받아서 blob URL로 바꾼다. */
export async function dcFileBlob(ctx: string, name: string): Promise<string> {
  const r = await call(dcFilePath(ctx, name));
  if (!r.ok) throw new Error(`${name}을 받지 못했습니다(${r.status})`);
  return URL.createObjectURL(await r.blob());
}
