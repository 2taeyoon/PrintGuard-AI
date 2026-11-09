"use client";

// 에이전트 화면 본체: 왼쪽에 에이전트 목록(기본 접힘, 누르면 그 자리에서 skill을 펼친다), 오른쪽에 의뢰 추적과 소통 기록.
// '인쇄 검수'에서 에이전트 검사 모드를 고르면 이 화면이 그 자리에 펼쳐진다(따로 된 탭은 없앴다).
import { useEffect, useState } from "react";
import { deleteJob, deleteMyJobs, getTrace, listAgents, listJobs, listLogs, orchestratorUp,
  type AgentInfo, type JobRow, type LogRow, type Trace } from "@/lib/agentClient";
import { agentLabel, jobNo, skillLabel, SkillName, statusLabel } from "./agent-ui";

const KIND: Record<string, string> = {
  job_opened: "의뢰 접수", request_received: "요청 받음", result_sent: "결과 보냄", task_status: "호출 실패", input_required: "사용자에게 질문",
  input_answered: "답 받음", job_closed: "의뢰 종료", job_failed: "의뢰 실패", duplicate_job: "같은 의뢰(멱등성)",
  safety_decision: "관문 결정", human_review: "사람 승인",
};
const GRADE: Record<string, string> = { read: "조회", A: "A 즉시 실행", B: "B 교차검증", C: "C 사람 승인" };
const DECISION: Record<string, string> = { executed: "실행", pending_review: "사람 승인 대기", rejected: "거절", approved: "승인", expired: "기한 지나 거절" };
const STATUS: Record<string, string> = { on: "켜짐", fake: "가짜", off: "꺼짐" };
const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}초`;
// 에이전트는 서버가 주는 차례가 호출 순서에 따라 달라지므로, 일하는 차례대로 고정해서 보여 준다
const ORDER = ["orchestrator", "preflight", "color", "paper", "guide", "proofread", "report", "safety", "designcraft"];
const rank = (n: string) => { const i = ORDER.indexOf(n.replace("(fake)", "")); return i < 0 ? ORDER.length : i; };

// **한 목록이다.** 전에는 '참여'와 '참여하지 않는'으로 갈라 뒀는데, 거기 갈 에이전트가
// designcraft 하나뿐이었다. 원본 수정이 검수 흐름 안으로 들어온 뒤로는 그것도 참여하므로,
// 빈 칸만 남은 둘째 묶음을 없앴다. 모르는 이름이 와도 이 목록에 그대로 선다 — 걸러 내면
// 새로 붙인 에이전트가 화면에서 조용히 사라진다.
//
// designcraft만 **의뢰에 따라 할 일이 달라진다.** 편집 파일(IDML)로 맡기면 안전 관문 다음에
// 서서 교정을 원본에 반영하고, PDF로 맡기면 고칠 원본이 없어 그 단계가 서지 않는다. 목록에서
// 빼는 대신 **그 줄에 조건을 적는다** — 빼 버리면 왜 없는지 알 수가 없다.
const COND: Record<string, (withFix: boolean) => string | undefined> = {
  designcraft: (withFix) => withFix
    ? "편집 파일로 맡기셨으니 참여합니다 — 검수가 끝나면 교정을 원본에 반영할지 묻고 고칩니다"
    : "편집 파일(.idml)로 맡길 때만 원본을 고칩니다. PDF에서는 글자를 집을 수 없습니다",
};
// 공통 로그의 시각은 UTC로 남는다. 화면에는 한국 시간으로 '2026년 10월 27일 오전 9시 30분 20초'처럼 적는다
const KST = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "numeric", day: "numeric",
  hour: "numeric", minute: "numeric", second: "numeric", hour12: true,
});
const parts = (t: Date) => Object.fromEntries(KST.formatToParts(t).map((x) => [x.type, x.value]));
const when = (iso: string) => {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const p = parts(t);
  return `${p.year}년 ${p.month}월 ${p.day}일 ${p.dayPeriod} ${p.hour}시 ${p.minute}분 ${p.second}초`;
};
/** 지우는 단추. **한 번 더 눌러야 지운다.**
 *
 *  `confirm()`을 쓰지 않는 이유가 있다. 그 창에는 무엇이 지워지는지 적을 자리가 없고, 글자가
 *  이 앱의 말투도 아니다. 그래서 자리에서 물어보고, 무엇이 사라지는지 그 자리에 적는다.
 *  지운 뒤에는 몇 줄이 지워졌는지 말해 준다 — 지웠다는 말만 하면 정말 지워졌는지 알 수 없다. */
function DeleteJob({ label, what, run, done }:
  { label: string; what: string; run: () => Promise<{ log_rows: number }>; done: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");

  if (said) return <span className="note">{said}</span>;
  if (!asking) {
    return <button type="button" className="pill" onClick={() => setAsking(true)}>{label}</button>;
  }
  return (
    <span className="job_del">
      <span className="warn">{what}</span>
      <button type="button" className="pill" disabled={busy} onClick={() => setAsking(false)}>그만두기</button>
      <button type="button" className="pill on" disabled={busy} onClick={() => {
        setBusy(true);
        run().then((r) => { setSaid(`지웠습니다 — 기록 ${r.log_rows}줄`); done(); })
          .catch((e: unknown) => setSaid(`지우지 못했습니다: ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => { setBusy(false); setTimeout(() => setSaid(""), 4000); });
      }}>{busy ? "지우는 중…" : "지웁니다"}</button>
    </span>
  );
}

/** 의뢰 목록처럼 좁은 자리에는 시각만 적는다 — '오전 9시 30분' */
const clock = (epochSec: number) => {
  const t = new Date(epochSec * 1000);
  if (Number.isNaN(t.getTime())) return "";
  const p = parts(t);
  return `${p.dayPeriod} ${p.hour}시 ${p.minute}분`;
};
const JOB_STATUS: Record<string, string> = {
  working: "검사 중", "input-required": "답을 기다리는 중", completed: "검사 끝",
  completed_partial: "일부만 끝남", failed: "실패",
};

/** 에이전트가 전부 살아 있는지 한눈에 보는 뱃지. 접어 둔 상태에서도 보이게 제목 옆에 붙인다 */
export function AgentHealth() {
  const [agents, setAgents] = useState<Record<string, AgentInfo> | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => listAgents().then((a) => { if (alive) setAgents(a); }).catch(() => { if (alive) setAgents(null); });
    tick();
    const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!agents) return <span className="chip bad">에이전트 연결 안 됨</span>;
  const rows = Object.entries(agents);
  const off = rows.filter(([, a]) => a.status === "off").map(([n]) => agentLabel(n));
  const fake = rows.filter(([, a]) => a.status === "fake").map(([n]) => agentLabel(n));
  const ok = off.length === 0;
  return (
    <span className={`chip ${ok ? "good" : "bad"}`} title={ok ? "모두 응답합니다" : `꺼짐: ${off.join(", ")}`}>
      에이전트 {rows.length - off.length}/{rows.length} {ok ? "정상" : `꺼짐 ${off.length}개`}
      {fake.length > 0 && ` · 가짜 ${fake.length}개`}
    </span>
  );
}

/** 에이전트 한 줄. 누르면 그 자리에서 할 수 있는 일(skill)과 등급이 펼쳐진다.
 *  `why`는 할 일에 조건이 붙는 에이전트에만 달린다(지금은 원본 수정 하나) — 적어 주지 않으면
 *  '켜짐'만 보고 늘 고쳐 주는 줄로 읽는다. */
function AgentRow({ name, a, open, toggle, why }:
  { name: string; a: AgentInfo; open: boolean; toggle: (n: string) => void; why?: string }) {
  return (
    <li className={`aitem ${a.status}${open ? " open" : ""}`}>
      <button type="button" className="aitem_head" aria-expanded={open} onClick={() => toggle(name)}>
        <span className={`dot ${a.status}`} aria-hidden="true" />
        <b>{agentLabel(name)}</b>
        <code>({name})</code>
        <span className="grow" />
        <span className="note">{STATUS[a.status] ?? a.status}</span>
        <span className="mark" aria-hidden="true">{open ? "－" : "＋"}</span>
      </button>
      {why && <p className="note aitem_why">{why}</p>}
      {open && (
        <div className="aitem_body">
          {a.card ? (
            <>
              <p className="note">{a.card.description}</p>
              {/* 받는 일이 없는 에이전트(총괄)는 목록 자리를 비워 둔다. 무엇을 하는지는 바로 위
                  카드 설명이 적고 있으므로, 없는 목록을 설명하는 줄을 따로 두지 않는다. */}
              {a.card.skills.length > 0 && (
                <ul className="skills">
                  {a.card.skills.map((s) => (
                    <li key={s.id}>
                      <div className="s_head"><SkillName id={s.id} /> <span className="chip grade">{GRADE[s.grade] ?? s.grade}</span>
                        {s.verifier && <span className="chip">검증자 {agentLabel(s.verifier)}</span>}</div>
                      <div className="note">{s.description}</div>
                      <div className="note">부를 수 있는 쪽: {s.allowed_requesters.map(agentLabel).join(", ")}</div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : <p className="note">아직 켜지지 않았거나 만들어지지 않은 에이전트입니다.</p>}
        </div>
      )}
    </li>
  );
}

export default function AgentsView({ initialCtx = "", showWarn = true, withFix = false }:
  { initialCtx?: string; showWarn?: boolean; withFix?: boolean }) {
  // initialCtx가 바뀌면(검사 중에 새 의뢰가 생기면) 그 의뢰로 따라간다. 사용자가 직접 고른 뒤에는 그대로 둔다.
  const [up, setUp] = useState<boolean | null>(null);
  const [agents, setAgents] = useState<Record<string, AgentInfo>>({});
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [ctx, setCtx] = useState<string>(initialCtx);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [opened, setOpened] = useState<string[]>([]); // 처음에는 모두 접혀 있고, 각각 따로 열고 닫는다
  const toggle = (name: string) => setOpened((o) => (o.includes(name) ? o.filter((x) => x !== name) : [...o, name]));

  // 렌더 중에 바로 맞춘다(권장 방식). 사용자가 직접 고른 뒤에는 initialCtx가 그대로라 건드리지 않는다.
  const [seenCtx, setSeenCtx] = useState(initialCtx);
  if (initialCtx !== seenCtx) {
    setSeenCtx(initialCtx);
    if (initialCtx) setCtx(initialCtx);
  }

  // 에이전트 목록은 누구에게나 공개다(누가 무엇을 할 수 있는지, skill·등급).
  // 의뢰와 소통 기록은 주인이 있어야 보이는데, 그 주인은 로그인 전에도 익명 토큰으로 생긴다.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const ok = await orchestratorUp();
      if (!alive) return;
      setUp(ok);
      if (!ok) return;
      const a = await listAgents();
      if (!alive) return;
      setAgents(a);
      const js = await listJobs();
      if (!alive) return;
      setJobs(js);
      setLogs(await listLogs(ctx || undefined));
      setTrace(ctx ? await getTrace(ctx) : null);  // 추적은 의뢰를 하나 고를 때만(전체 워터폴은 뜻이 없다)
    };
    void tick().catch(() => undefined);   // 터널이 끊기거나 로그인이 만료되면 다음 차례에 다시 해 본다
    const t = setInterval(() => void tick().catch(() => undefined), 2000);
    return () => { alive = false; clearInterval(t); };
  }, [ctx]);

  const list = Object.entries(agents).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  const onCount = list.filter(([, a]) => a.status !== "off").length;

  return (
    <>
      {showWarn && up === false && <div className="warn">에이전트에 연결할 수 없습니다.</div>}

      <div className="agent_layout">
        {/* 왼쪽: 에이전트 목록 */}
        <aside className="agent_side">
          <div className="side_head">
            <strong>이 검수에 참여</strong>
            <span className="chip">{onCount}/{list.length} 켜짐</span>
          </div>
          <ul className="agent_list">
            {list.map(([name, a]) => (
              <AgentRow key={name} name={name} a={a} open={opened.includes(name)} toggle={toggle}
                why={COND[name.replace("(fake)", "")]?.(withFix)} />
            ))}
            {list.length === 0 && <li className="aitem"><span className="note">에이전트를 불러오는 중…</span></li>}
          </ul>
        </aside>

        {/* 오른쪽: 의뢰를 하나 고르면 추적과 기록이 그 의뢰로 좁혀진다 */}
        <div className="agent_main">
          <div className="panel job_pick">
            <strong>의뢰</strong>
            <select value={ctx} onChange={(e) => setCtx(e.target.value)} aria-label="의뢰 고르기">
              <option value="">전체(최근 기록만)</option>
              {jobs.map((j) => (
                <option key={j.context_id} value={j.context_id}>
                  {j.filename} · {JOB_STATUS[j.status] ?? j.status} · {clock(j.created)}
                </option>
              ))}
            </select>
            {/* 넣은 사람이 지울 수 있어야 한다. 로그인을 했든 안 했든 같다 — 주인을 가리는 값은
                로그인 여부가 아니라 토큰이고, 그건 익명으로 써도 있다.
                **되돌릴 수 없는 일이라 두 번 묻는다.** 누르면 무엇이 지워지는지 적고, 한 번 더
                눌러야 지운다(브라우저의 confirm 창은 쓰지 않는다 — 무엇이 지워지는지 못 적는다). */}
            {ctx
              ? <DeleteJob label="이 의뢰 지우기"
                  what={`이 의뢰와 소통 기록, 만들어진 쪽 그림까지 지웁니다. 되돌릴 수 없습니다.`}
                  run={() => deleteJob(ctx)} done={() => { setCtx(""); setTrace(null); }} />
              : jobs.length > 0 && <DeleteJob label={`내 의뢰 ${jobs.length}건 모두 지우기`}
                  what={`내 의뢰 ${jobs.length}건과 소통 기록을 모두 지웁니다. 되돌릴 수 없습니다.`}
                  run={deleteMyJobs} done={() => setTrace(null)} />}
            <span className="note">2초마다 갱신</span>
          </div>

          <section className="panel">
            <div className="toolbar">
              <strong>의뢰 추적</strong>
              {trace && trace.spans.length > 0 ? (
                <>
                  <span className="chip">전체 {secs(trace.total_ms)}</span>
                  {trace.agents.map((a) => (
                    <span key={a.agent} className="chip">{agentLabel(a.agent)} {a.calls}회 · {secs(a.ms)}{a.open ? " · 진행 중" : ""}</span>
                  ))}
                  <span className="note">공통 로그 {trace.lines}줄 기준</span>
                </>
              ) : null}
            </div>
            {!(trace && trace.spans.length > 0) && (
              <ol className="timeline">
                <li className="empty_row">{ctx ? "이 의뢰에는 아직 구간이 없습니다." : "위에서 의뢰를 고르면 에이전트별 구간 막대(워터폴)가 나옵니다."}</li>
              </ol>
            )}
            {trace && trace.spans.length > 0 && (
              <ol className="waterfall">
                {trace.spans.map((s, i) => {
                  const total = Math.max(trace.total_ms, 1);
                  const ms = s.ms ?? total - s.start_ms;
                  return (
                    <li key={i}>
                      <span className="wf_who">{s.requester && <span className="note">{agentLabel(s.requester)} → </span>}<b>{agentLabel(s.agent)}</b> {s.skill && <code>{skillLabel(s.skill)}</code>}</span>
                      <span className="wf_track">
                        <span className={`wf_bar st-${s.status ?? "working"}${s.open ? " open" : ""}`}
                          style={{ left: `${(s.start_ms / total) * 100}%`, width: `${Math.max((ms / total) * 100, 0.8)}%` }}
                          title={`${s.skill ?? ""} · ${s.start_ms}~${s.end_ms ?? "?"}ms${s.outcome ? ` · ${s.outcome}` : ""}`} />
                      </span>
                      <span className="wf_ms">{s.open ? "진행 중" : secs(ms)}</span>
                    </li>
                  );
                })}
              </ol>
            )}
            {trace && trace.gates.length > 0 && (
              <ul className="gatelist">
                {trace.gates.map((g, i) => (
                  <li key={i} className={`st-${g.decision ?? ""}`}>
                    <span className="t">{secs(g.at_ms)}</span>
                    <span>{g.kind === "human_review" ? "사람 승인" : "안전 관문"} · {g.action ? <SkillName id={g.action} /> : null}
                      {g.grade && <span className="chip grade">{GRADE[g.grade] ?? g.grade}</span>}
                      <b> {DECISION[g.decision ?? ""] ?? g.decision}</b>
                      {g.requester && <> · {agentLabel(g.requester)}</>}
                      {!!g.amount && <> · {g.amount.toLocaleString()}원</>}
                      {g.reason && <span className="note"> {g.reason}</span>}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <div className="toolbar">
              <strong>소통 기록</strong>
              <span className="note">{logs.length}줄{ctx ? "" : " · 최근 300줄"}</span>
            </div>
            <ol className="timeline">
              {logs.map((l) => (
                <li key={l.id} className={`k-${l.kind} st-${l.status ?? ""}`}>
                  <span className="t">{when(l.at)}</span>
                  {/* 부탁한 쪽을 앞에 둬서 '총괄 → 교정'처럼 일이 흘러간 방향대로 읽히게 한다 */}
                  <span className="who">{l.requester && l.kind === "request_received" ? <>{agentLabel(l.requester)} → </> : null}<b>{agentLabel(l.source)}</b></span>
                  <span className="what">{KIND[l.kind] ?? l.kind}{l.skill && <> · {skillLabel(l.skill)} <code>({l.skill})</code></>}{l.status && <> · {statusLabel(l.status)}</>}{l.outcome && <> · <b>{l.outcome}</b></>}{l.grade && l.grade !== "read" && <> · 등급 {l.grade}</>}</span>
                  {!ctx && <span className="note" title={l.context_id}>의뢰 {jobNo(l.context_id)}</span>}
                </li>
              ))}
              {logs.length === 0 && <li className="empty_row">아직 기록이 없습니다. 위에서 에이전트 검사 모드로 맡겨 보세요.</li>}
            </ol>
          </section>
        </div>
      </div>
    </>
  );
}
