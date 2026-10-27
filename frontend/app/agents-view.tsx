"use client";

// 에이전트 화면 본체: 왼쪽에 에이전트 목록(기본 접힘, 누르면 그 자리에서 skill을 펼친다), 오른쪽에 의뢰 추적과 소통 기록.
// '인쇄 검수'에서 에이전트 검사 모드를 고르면 이 화면이 그 자리에 펼쳐진다(따로 된 탭은 없앴다).
import { useEffect, useState } from "react";
import { getTrace, listAgents, listJobs, listLogs, orchestratorUp, type AgentInfo, type JobRow, type LogRow, type Trace } from "@/lib/agentClient";
import { agentLabel, skillLabel, SkillName } from "./agent-ui";

const KIND: Record<string, string> = {
  job_opened: "의뢰 접수", request_received: "요청 받음", result_sent: "결과 보냄", task_status: "호출 실패", input_required: "사용자에게 질문",
  input_answered: "답 받음", job_closed: "의뢰 종료", job_failed: "의뢰 실패", duplicate_job: "같은 의뢰(멱등성)",
  safety_decision: "관문 결정", human_review: "사람 승인",
};
const GRADE: Record<string, string> = { read: "조회", A: "A 즉시 실행", B: "B 교차검증", C: "C 사람 승인" };
const DECISION: Record<string, string> = { executed: "실행", pending_review: "사람 승인 대기", rejected: "거절", approved: "승인", expired: "기한 지나 거절" };
const STATUS: Record<string, string> = { on: "켜짐", fake: "가짜", off: "꺼짐" };
const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}초`;

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

export default function AgentsView({ initialCtx = "", showWarn = true }: { initialCtx?: string; showWarn?: boolean }) {
  // initialCtx가 바뀌면(검사 중에 새 의뢰가 생기면) 그 의뢰로 따라간다. 사용자가 직접 고른 뒤에는 그대로 둔다.
  const [up, setUp] = useState<boolean | null>(null);
  const [agents, setAgents] = useState<Record<string, AgentInfo>>({});
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [ctx, setCtx] = useState<string>(initialCtx);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [opened, setOpened] = useState<string | null>(null); // 처음에는 모두 접혀 있다

  // 렌더 중에 바로 맞춘다(권장 방식). 사용자가 직접 고른 뒤에는 initialCtx가 그대로라 건드리지 않는다.
  const [seenCtx, setSeenCtx] = useState(initialCtx);
  if (initialCtx !== seenCtx) {
    setSeenCtx(initialCtx);
    if (initialCtx) setCtx(initialCtx);
  }

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const ok = await orchestratorUp();
      if (!alive) return;
      setUp(ok);
      if (!ok) return;
      const [a, js] = await Promise.all([listAgents(), listJobs()]);
      if (!alive) return;
      setAgents(a); setJobs(js);
      setLogs(await listLogs(ctx || undefined));
      setTrace(ctx ? await getTrace(ctx) : null);  // 추적은 의뢰를 하나 고를 때만(전체 워터폴은 뜻이 없다)
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [ctx]);

  const list = Object.entries(agents);
  const onCount = list.filter(([, a]) => a.status !== "off").length;

  return (
    <>
      {showWarn && up === false && <div className="warn">에이전트에 연결할 수 없습니다. <code>agents</code> 폴더에서 <code>python run_agents.py</code>로 켜세요.</div>}

      <div className="agent_layout">
        {/* 왼쪽: 에이전트 목록 */}
        <aside className="agent_side">
          <div className="side_head">
            <strong>에이전트</strong>
            <span className="chip">{onCount}/{list.length} 켜짐</span>
          </div>
          <ul className="agent_list">
            {list.map(([name, a]) => {
              const isOpen = opened === name;
              return (
                <li key={name} className={`aitem ${a.status}${isOpen ? " open" : ""}`}>
                  <button type="button" className="aitem_head" aria-expanded={isOpen} onClick={() => setOpened(isOpen ? null : name)}>
                    <span className={`dot ${a.status}`} aria-hidden="true" />
                    <b>{agentLabel(name)}</b>
                    <code>({name})</code>
                    <span className="grow" />
                    <span className="note">{STATUS[a.status] ?? a.status}</span>
                    <span className="mark" aria-hidden="true">{isOpen ? "－" : "＋"}</span>
                  </button>
                  {isOpen && (
                    <div className="aitem_body">
                      {a.card ? (
                        <>
                          <p className="note">{a.card.description}</p>
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
                        </>
                      ) : <p className="note">아직 켜지지 않았거나 만들어지지 않은 에이전트입니다.</p>}
                    </div>
                  )}
                </li>
              );
            })}
            {list.length === 0 && <li className="aitem"><span className="note">에이전트를 불러오는 중…</span></li>}
          </ul>
        </aside>

        {/* 오른쪽: 의뢰를 하나 고르면 추적과 기록이 그 의뢰로 좁혀진다 */}
        <div className="agent_main">
          <div className="panel job_pick">
            <strong>의뢰</strong>
            <select value={ctx} onChange={(e) => setCtx(e.target.value)} aria-label="의뢰 고르기">
              <option value="">전체(최근 기록만)</option>
              {jobs.map((j) => <option key={j.context_id} value={j.context_id}>{j.context_id} · {j.filename} · {j.status}</option>)}
            </select>
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
              ) : <span className="note">{ctx ? "이 의뢰에는 아직 구간이 없습니다." : "위에서 의뢰를 고르면 에이전트별 워터폴이 나옵니다."}</span>}
            </div>
            {trace && trace.spans.length > 0 && (
              <ol className="waterfall">
                {trace.spans.map((s, i) => {
                  const total = Math.max(trace.total_ms, 1);
                  const ms = s.ms ?? total - s.start_ms;
                  return (
                    <li key={i}>
                      <span className="wf_who"><b>{agentLabel(s.agent)}</b> {s.skill && <code>{skillLabel(s.skill)}</code>}{s.requester && <span className="note"> ← {agentLabel(s.requester)}</span>}</span>
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
                  <span className="t">{l.at.slice(11, 23)}</span>
                  <span className="who"><b>{agentLabel(l.source)}</b>{l.requester && l.kind === "request_received" ? <> ← {agentLabel(l.requester)}</> : null}</span>
                  <span className="what">{KIND[l.kind] ?? l.kind}{l.skill && <> · {skillLabel(l.skill)} <code>({l.skill})</code></>}{l.status && <> · {l.status}</>}{l.outcome && <> · <b>{l.outcome}</b></>}{l.grade && l.grade !== "read" && <> · 등급 {l.grade}</>}</span>
                  {!ctx && <span className="note">{l.context_id}</span>}
                </li>
              ))}
              {logs.length === 0 && <li><span className="note">아직 기록이 없습니다. 위에서 에이전트 검사 모드로 PDF를 맡겨 보세요.</span></li>}
            </ol>
          </section>
        </div>
      </div>
    </>
  );
}
