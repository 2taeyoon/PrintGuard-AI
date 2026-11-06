// 에이전트 모드: 오케스트레이터(agents/, 기본 http://127.0.0.1:8700)에 검수를 맡기고 결과를 앱 화면 형식으로 바꾼다.
// 바로 검사 모드(브라우저 안에서만)와 화면은 같고, 계산은 각 에이전트가 한다.
import type { Analysis, Issue } from "./analyze";
import { forgetSession, requireToken } from "./auth";
import { isLocalOrch as isLocal, orchUrl } from "./orch";
import type { Fix } from "./fixlist";
import type { Hit } from "./guide";
import type { Risk } from "./risk";

export { ORCH_BUILT, hostedOrch, isLocalOrch, orchUrl } from "./orch";

/* ---------- 이 세션의 토큰 ----------
   에이전트는 PC 한 대인데 공개 주소로 누구나 들어온다. 그래서 오케스트레이터는 토큰 안의
   주인이 맞는 의뢰만 돌려주고, 그 주인은 **구글 로그인**으로 정한다(`lib/auth.ts`).
   토큰은 어떤 저장소에도 넣지 않는다 — 잃어도 다시 로그인하면 같은 주인으로 돌아오기 때문이다. */
async function call(path: string, init: RequestInit = {}, extra: Record<string, string> = {}): Promise<Response> {
  const go = async () => fetch(`${orchUrl()}${path}`, {
    ...init, headers: { ...extra, Authorization: `Bearer ${await requireToken()}` },
  });
  const r = await go();
  if (r.status !== 401) return r;
  // 기한이 지났다. 한 번만 조용히 다시 로그인해서 같은 요청을 보낸다 —
  // 이 재시도가 없으면 오래 열어 둔 탭은 모든 화면이 빈 채로 멈춘다.
  forgetSession();
  return go();
}

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
  const ms = isLocal(orchUrl()) ? 2000 : 8000;
  try { return (await fetch(`${orchUrl()}/health`, { signal: AbortSignal.timeout(ms) })).ok; } catch { return false; }
}
export const listAgents = async () => j<Record<string, AgentInfo>>(await fetch(`${orchUrl()}/agents`));
export const listLogs = async (ctx?: string) => j<LogRow[]>(await call(`/logs${ctx ? `?context_id=${encodeURIComponent(ctx)}` : ""}`));
export const getJob = async (ctx: string) => j<JobView>(await call(`/jobs/${ctx}`));
export const answerJob = async (ctx: string, value: string) =>
  j<unknown>(await call(`/jobs/${ctx}/answer`, { method: "POST", body: JSON.stringify({ value }) }, { "Content-Type": "application/json" }));

/** 검수를 맡긴다. 들어가는 길이 둘이다.
 *  - `file`: PDF를 그대로 올리는 길.
 *  - `source`: **편집 파일(IDML)로 먼저 올린** 뒤 그 원본 의뢰 번호로 맡기는 길. 이때만 검수가
 *    끝난 뒤 원본 수정까지 이어진다(고칠 원본이 서버에 있으므로). PDF로 맡기면 그 단계가 없다. */
export async function createJob(file: File | null, options: Record<string, unknown>, source = ""): Promise<{ context_id: string; duplicate: boolean }> {
  const fd = new FormData();
  if (source) fd.append("source", source);
  else if (file) fd.append("file", file);
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
  /** 창 없이 도는가(headless), 켜 둔 DesignCraft 앱에 붙었는가(app). */
  app_port?: number | null; app_running?: boolean;
};
/** 토큰을 붙이지 않는다 — 주인이 따로 없는 정보(에이전트가 DesignCraft에 닿는가)라서,
 *  연결 상태를 보려고 로그인부터 하게 만들 이유가 없다. */
export const mcpStatus = async () => j<McpStatus>(await fetch(`${orchUrl()}/designcraft/status`));

export type PreflightIssue = { severity: string; kind: string; message: string; page: number | null };

/** 문서가 쓰는 글꼴 하나와 그 처지.
 *
 *  글꼴은 편집 파일에 **담겨 오지 않는다** — 이름으로만 가리키고, 그 이름을 글자꼴로 바꾸는 일은
 *  파일을 여는 쪽 PC가 한다. 그래서 올린 사람 PC에는 있고 검수하는 PC에는 없을 수 있다.
 *  - `missing`      : 그 글꼴이 없어 `resolved`로 **대체해서** 그렸다
 *  - `substituted`  : 글꼴 가족은 있는데 그 굵기·기울기가 없어 가까운 것으로 그렸다
 *  - `source`       : `document`면 올린 **패키지의 `Document Fonts/`에서 실려 온 것**이다 */
export type DocFont = {
  family: string; style: string; status: "ok" | "missing" | "substituted";
  resolved: string; resolved_style: string; chars: number;
  source: "bundled" | "installed" | "document" | "added" | null; restricted_licence: boolean;
};
/** 글꼴 상태와, 그 때문에 **미리보기를 어디까지 믿을 수 있는지**.
 *  수치를 지우지 않고 믿을 수 있는 범위를 같이 말한다 — 글꼴이 대체되면 줄이 밀려서,
 *  넘친 글을 그대로 '원본의 문제'라고 말할 수 없기 때문이다. */
export type FontState = {
  fonts: DocFont[]; missing_fonts: string[]; substituted_styles: string[];
  document_fonts: number; glyph_blocked: string[];
  trust: { text_readable: boolean; layout_faithful: boolean };
};
export type SourceView = FontState & {
  context_id: string; filename: string; pages: number; pdf_ref: string;
  stories: { id: number; length: number; overset: boolean; pages: number[]; preview: string }[];
  preflight: PreflightIssue[]; open_warnings: string[]; text_chars: number;
  paragraph_styles: number; swatches: number; png: string; uploaded_files?: number;
};

/** 편집 파일을 올리고 바로 들여다본다(쪽·스토리·preflight + 검수용 PDF).
 *  파일 하나도 되고 **폴더째**도 된다 — 폴더로 주면 IDML 옆의 `Links/` 사진과 `Document Fonts/`
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

export type ApplyResult = FontState & {
  applied: { key?: string; page: number | null; original: string; suggestion: string; story: number; at: [number, number] }[];
  failed: { key?: string; page: number | null; original: string; suggestion: string; reason: string }[];
  pdf_ref: string; source_out: string | null;
  shots: { page: number; before: string; after: string }[];  // 바뀐 쪽만 찍는다
  shots_total: number;                                        // 바뀐 쪽이 더 있으면 이 수가 더 크다
  preflight_after: PreflightIssue[];
};
export const applyFixes = (ctx: string, fixes: Fix[]) =>
  post<AgentReply>(`/designcraft/${ctx}/apply`, { fixes });

/** 검수 흐름 안에서 원본을 고친 결과(`job.results.fix`). 고치지 않기로 했으면 `skipped`만 온다. */
export type FixResult = Partial<ApplyResult> & { skipped?: boolean; asked?: number };

/* ---------- 인디자인이 하는 일 전부 ----------
   DesignCraft 엔진은 547개 명령을 받는다. 우리가 그중 몇 개를 코드로 감싸면 감싼 것만 할 수 있는
   앱이 된다. 그래서 **명령표를 그대로 받아** 화면에 펼치고, 고른 명령을 그대로 얹는다.
   할 수 있는 일의 범위를 우리 코드가 아니라 엔진이 정하게 하는 쪽이 맞다. */

/** 엔진 명령 하나. `params`는 **엔진이 적어 준 인자 설명을 그대로** 들고 온다 —
 *  우리가 547개를 번역해 둘 수는 없고, 번역해 두면 엔진이 바뀔 때 거짓말이 된다. */
export type EngineCommand = { id: string; label: string; menu: string[]; params: string; enabled: boolean };
/** 명령표는 **화면에서 쓰지 않는다** — 명령을 찾아 쓰는 칸을 없앴다(적어서 부탁하면 되는 일이었다).
 *  창구(`GET /designcraft/commands`)는 그대로 둔다: 클로드·커서가 MCP로 붙을 때 그쪽이 쓴다. */

export type EngineStep = { command: string; params: Record<string, unknown> };

/** 말로 부탁한 것을 명령으로 **짜 준** 결과. 짜 주기만 하고 고치지는 않는다 —
 *  LLM이 틀릴 수 있으니 사람이 무엇이 일어날지 보고 누르는 틈을 둔다. */
export type Composed = {
  available: boolean; commands: EngineStep[]; says: string; dropped: string[]; reason?: string;
};
/** 만드는 동안의 한 걸음. 화면이 이걸 되풀이해 물어 **실시간으로** 따라간다 —
 *  한 번에 다 하고 끝에 보여 주면, 20초 동안 멈춘 것인지 도는 것인지 알 수가 없다. */
export type MakeStep = {
  id: number; at: string; kind: string;
  payload: { phase: string; at?: number; total?: number; command?: string; error?: string;
    result?: Record<string, unknown> | null; params?: Record<string, unknown>;
    pages?: number; items?: number };
};
export const makeProgress = (ctx: string) => call(`/designcraft/${ctx}/progress`).then((r) => j<MakeStep[]>(r));

/** 지켜보기 — 에이전트가 만들고 있는 문서의 지금 모습. 클로드·커서가 MCP로 만든 것도
 *  **번호만 알면** 볼 수 있다(그 번호는 난수라 찍어 맞힐 수 없다). 보는 것만 되고,
 *  고치는 창구는 그대로 주인만 들어간다. */
export type Watch = {
  context_id: string; filename: string; pages: number | null; shots: string[];
  preflight: number; width_mm?: number | null; height_mm?: number | null; steps: MakeStep[];
};
export const watchDoc = (ctx: string) => call(`/designcraft/${ctx}/watch`).then((r) => j<Watch>(r));
export const myDocs = () =>
  call("/designcraft/jobs").then((r) => j<{ context_id: string; filename: string; created: number;
    pages: number | null; made: boolean }[]>(r));
/** 지켜보기용 쪽 그림. 열쇠 헤더가 필요해 blob으로 받아 쓴다. */
export async function watchShot(ctx: string, name: string) {
  const r = await call(`/designcraft/${ctx}/watch/${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(`${r.status}`);
  return URL.createObjectURL(await r.blob());
}

export const composeDocument = (ctx: string, request: string) =>
  post<Composed>(`/designcraft/${ctx}/compose`, { request });
/** 올려 둔 그림은 서버가 그 의뢰에 적어 두고, 다음 `composeDocument`에 같이 넘긴다 —
 *  브라우저의 사진은 에이전트 PC에 없으므로 **먼저 올려야** 말로 부탁할 때 쓸 수 있다. */

/** 한 단계를 얹은 뒤의 문서. 실패하면 `ok:false`이고 **아무것도 저장되지 않는다**(전부 아니면 전무). */
export type EditResult = FontState & {
  ok: boolean;
  applied: { command: string; result: Record<string, unknown> | null }[];
  failed: { command: string; reason: string; not_run: number } | null;
  undone?: boolean; can_undo: boolean;
  pages: number; shots: string[]; items: number; stories: number;
  preflight: PreflightIssue[]; pdf_ref?: string;
};
export const editDocument = (ctx: string, commands: EngineStep[]) =>
  post<EditResult>(`/designcraft/${ctx}/edit`, { commands });
/** 바로 앞 단계로. **한 단계만** 간다 — 어디까지 돌아갔는지 모르는 것이 더 무섭다. */
export const undoEdit = (ctx: string) => post<EditResult>(`/designcraft/${ctx}/edit`, { undo: true });

/** 문서에 넣을 사진을 의뢰 폴더에 둔다. 돌려주는 `path`를 `file.place`에 그대로 쓴다.
 *  브라우저의 사진은 에이전트 PC에 없으므로, 먼저 그 폴더 안으로 올려야 엔진이 읽는다. */
export async function uploadAsset(ctx: string, file: File) {
  const fd = new FormData();
  fd.append("file", file);
  return j<{ path: string; name: string; bytes: number; original: string }>(
    await call(`/designcraft/${ctx}/asset`, { method: "POST", body: fd }));
}

/** 새 문서를 만든다(빈 판형 또는 샘플 잡지). 돌아오는 것이 **올린 원본과 같은 모양**이라
 *  그대로 검수에 넘길 수 있다(`createJob(null, opts, context_id)`). */
export type MadeDoc = SourceView & { made: true; width_mm: number; height_mm: number };
export type MakeSpec = {
  start: "blank" | "sample"; width_mm?: number; height_mm?: number; pages?: number; facing?: boolean;
  columns?: number; gutter_mm?: number; margin_mm?: number; bleed_mm?: number; text?: string;
};
export const createDocument = (spec: MakeSpec) => post<MadeDoc>("/designcraft/create", spec);

/** 올려 둔(또는 만들어 둔) 원본을 다시 집어 온다. '작업 만들기'에서 검수로 넘어올 때 쓴다. */
export const getSource = async (ctx: string) => j<SourceView>(await call(`/designcraft/${ctx}`));

/** 작업 폴더의 결과물 주소(전후 PNG, 고친 PDF/IDML). 주인만 받을 수 있다. */
const dcFilePath = (ctx: string, name: string) => `/designcraft/${ctx}/file/${encodeURIComponent(name)}`;
export const dcFileUrl = (ctx: string, name: string) => `${orchUrl()}${dcFilePath(ctx, name)}`;

/** 이미지·파일은 <img src>로 바로 못 건다 — 열쇠 헤더가 필요해서 받아서 blob URL로 바꾼다. */
export async function dcFileBlob(ctx: string, name: string): Promise<string> {
  return URL.createObjectURL(await dcFile(ctx, name));
}

/** 같은 파일을 바이트로. 원본에서 뽑은 검수용 PDF는 화면에서도 읽어야 한다 —
 *  크기를 재고(lib/pagesize) 쪽을 그린다(pdf.js). 그래서 blob 주소가 아니라 파일이 필요하다. */
export async function dcFile(ctx: string, name: string): Promise<Blob> {
  const r = await call(dcFilePath(ctx, name));
  if (!r.ok) throw new Error(`${name}을 받지 못했습니다(${r.status})`);
  return r.blob();
}
