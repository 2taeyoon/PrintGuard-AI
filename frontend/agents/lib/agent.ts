// Node 에이전트 공통 뼈대. Python의 agents/pg_agents/server.py와 같은 계약·같은 수신 순서·같은 공통 로그 표를 쓴다.
// 수신 순서: context_id → 토큰(요청자는 토큰에서) → 루프 → 홉 제한 → 권한 → 마감 → 핸들러 → 결과 형식 확인
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Grade = "read" | "A" | "B" | "C";
export type Skill = { id: string; description: string; grade: Grade; allowed_requesters: string[]; verifier?: string | null;
  input_schema?: Record<string, unknown>; output_schema?: Record<string, unknown> };
export type AgentCard = { name: string; description: string; url: string; version?: string; skills: Skill[] };
export type Meta = { context_id: string; token: string; path: string[]; deadline: string; idempotency_key?: string | null; requester?: string | null };
export type AgentRequest = { meta: Meta; skill: string; input: Record<string, unknown>; untrusted?: Record<string, unknown> };
export type Status = "completed" | "input-required" | "rejected" | "canceled" | "failed";
export type AgentResult = { meta: Meta; status: Status; outcome?: string | null; output?: Record<string, unknown>;
  evidence?: { queries: string[]; data_summary: string; ref_ids: string[] }; reason_code?: string | null; question?: Record<string, unknown> | null; fallback?: boolean };
export type HandlerOut = Omit<AgentResult, "meta">;
export type Handler = (req: AgentRequest) => Promise<HandlerOut>;

export const ROOT = resolve(__dirname, "../../..");
export const DATA = process.env.PG_DATA_DIR ?? resolve(ROOT, "agents/.data");
export const STORE = resolve(DATA, "pdf");
const LOG_DB = process.env.PG_COMMON_LOG_DB ?? resolve(DATA, "common_log.sqlite");
export const PORTS: Record<string, number> = { orchestrator: 8700, safety: 8701, preflight: 8702, color: 8703, guide: 8704, paper: 8705, proofread: 8706, shop: 8707, report: 8708 };
const MAX_PATH = 3;
const isMock = () => (process.env.PG_MOCK ?? "1") === "1";

let db: DatabaseSync | null = null;
export function logEvent(context_id: string, kind: string, f: { source: string; requester?: string | null; skill?: string; status?: string; outcome?: string | null; grade?: string; payload?: unknown }) {
  try {
    if (!db) {
      mkdirSync(dirname(LOG_DB), { recursive: true });
      db = new DatabaseSync(LOG_DB, { timeout: 5000 });
      db.exec("PRAGMA journal_mode=WAL");
      db.exec(`CREATE TABLE IF NOT EXISTS common_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, context_id TEXT NOT NULL, kind TEXT NOT NULL,
        source TEXT NOT NULL, requester TEXT, skill TEXT, status TEXT, outcome TEXT, grade TEXT, payload TEXT)`);
    }
    db.prepare("INSERT INTO common_log(at,context_id,kind,source,requester,skill,status,outcome,grade,payload) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(new Date().toISOString(), context_id, kind, f.source, f.requester ?? null, f.skill ?? null, f.status ?? null, f.outcome ?? null, f.grade ?? null,
        JSON.stringify(f.payload ?? {}));
  } catch { /* 로그 실패로 요청을 멈추지 않는다 */ }
}

const err = (meta: Meta, status: Status, outcome: string, message = ""): AgentResult => ({ meta, status, outcome, output: message ? { message } : {} });

function verifyToken(token: string): string {
  if (isMock() && token.startsWith("mock:") && token.length > 5) return token.slice(5);
  throw new Error("UNAUTHORIZED");
}

async function handle(card: AgentCard, handlers: Record<string, Handler>, body: AgentRequest): Promise<AgentResult> {
  const skills = new Map(card.skills.map((s) => [s.id, s]));
  let meta = body.meta;
  if (!meta?.context_id) return err({ ...(meta ?? {}), context_id: "unknown", token: "", path: [], deadline: new Date().toISOString() }, "rejected", "MISSING_CONTEXT");
  let requester: string;
  try { requester = verifyToken(meta.token); } catch { return err(meta, "rejected", "UNAUTHORIZED"); }
  meta = { ...meta, path: meta.path ?? [], requester };
  logEvent(meta.context_id, "request_received", { source: card.name, requester, skill: body.skill, payload: { path: meta.path } });
  if (meta.path.includes(card.name)) return err(meta, "rejected", "LOOP_DETECTED");
  if (meta.path.length > MAX_PATH) return err(meta, "rejected", "HOP_LIMIT");
  const skill = skills.get(body.skill);
  if (!skill) return err(meta, "rejected", "UNKNOWN_SKILL");
  if (!skill.allowed_requesters.includes(requester)) return err(meta, "rejected", "FORBIDDEN_SKILL");
  if (new Date(meta.deadline).getTime() <= Date.now()) return err(meta, "canceled", "TIMEOUT");
  try {
    const out = await handlers[body.skill]({ ...body, meta });
    if (out.status === "input-required" && (!out.reason_code || !out.question)) return err(meta, "failed", "INVALID_OUTPUT", "input-required에는 reason_code·question이 필요");
    return { ...out, meta };
  } catch (e) {
    return err(meta, "failed", "handler_error", String(e instanceof Error ? e.message : e).slice(0, 300));
  }
}

export function serveAgent(card: AgentCard, handlers: Record<string, Handler>) {
  const ids = card.skills.map((s) => s.id).sort().join(), keys = Object.keys(handlers).sort().join();
  if (ids !== keys) throw new Error(`카드 skill과 핸들러가 다르다: ${ids} / ${keys}`);
  for (const s of card.skills) if (s.grade === "B" && (!s.verifier || s.verifier === card.name)) throw new Error(`skill ${s.id}: B 등급 verifier 규칙 위반`);
  const port = PORTS[card.name];
  const send = (res: ServerResponse, code: number, obj: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(obj));
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // 브라우저로 포트를 열어 본 사람에게 여기가 무엇인지 알려 준다(사람이 보는 화면은 앱 쪽이다)
    if (req.method === "GET" && req.url === "/") {
      return send(res, 200, { data: { agent: card.name, description: card.description,
        note: "사람이 보는 화면이 아니라 에이전트 API입니다. 앱은 http://127.0.0.1:8752 (에이전트 탭에서 이 카드를 볼 수 있습니다).",
        endpoints: { "GET /health": "살아 있는지", "GET /.well-known/agent-card.json": "할 수 있는 일(skill)과 등급",
          "POST /a2a": "다른 에이전트가 일을 맡기는 곳(토큰 필요)" },
        skills: card.skills.map((s) => ({ id: s.id, grade: s.grade, description: s.description })) }, meta: {} });
    }
    if (req.method === "GET" && req.url === "/.well-known/agent-card.json") return send(res, 200, card);
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { data: { status: "ok", agent: card.name }, meta: {} });
    if (req.method === "POST" && req.url === "/a2a") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: AgentRequest;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(res, 400, { error: "bad json" }); }
      const r = await handle(card, handlers, body);
      logEvent(r.meta.context_id, "result_sent", { source: card.name, requester: r.meta.requester, skill: body.skill, status: r.status, outcome: r.outcome ?? null,
        grade: card.skills.find((s) => s.id === body.skill)?.grade, payload: { fallback: !!r.fallback, question: !!r.question } });
      return send(res, 200, r);
    }
    send(res, 404, { error: "not found" });
  });
  server.listen(port, "127.0.0.1", () => console.log(`[${card.name}] http://127.0.0.1:${port}`));
  return server;
}

/** 오케스트레이터가 저장한 PDF를 pdf_ref(sha256)로 읽는다. 경로 조작을 막으려고 형식을 먼저 확인한다. */
export function loadPdf(ref: unknown): Uint8Array {
  if (typeof ref !== "string" || !/^[0-9a-f]{64}$/.test(ref)) throw new Error("pdf_ref 형식이 아닙니다");
  return new Uint8Array(readFileSync(resolve(STORE, `${ref}.pdf`)));
}
