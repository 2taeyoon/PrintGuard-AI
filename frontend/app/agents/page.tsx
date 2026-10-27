"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { getTrace, listAgents, listJobs, listLogs, orchestratorUp, type AgentInfo, type JobRow, type LogRow, type Trace } from "@/lib/agentClient";
import { agentLabel } from "../agent-ui";

const KIND: Record<string, string> = {
  job_opened: "의뢰 접수", request_received: "요청 받음", result_sent: "결과 보냄", task_status: "호출 실패", input_required: "사용자에게 질문",
  input_answered: "답 받음", job_closed: "의뢰 종료", job_failed: "의뢰 실패", duplicate_job: "같은 의뢰(멱등성)",
};
const GRADE: Record<string, string> = { read: "조회", A: "A 즉시 실행", B: "B 교차검증", C: "C 사람 승인" };
const DECISION: Record<string, string> = { executed: "실행", pending_review: "사람 승인 대기", rejected: "거절", approved: "승인", expired: "기한 지나 거절" };
const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}초`;

export default function AgentsPageWrap() {
  return <Suspense><AgentsPage /></Suspense>;
}

function AgentsPage() {
  const sp = useSearchParams();
  const [up, setUp] = useState<boolean | null>(null);
  const [agents, setAgents] = useState<Record<string, AgentInfo>>({});
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [ctx, setCtx] = useState<string>(sp.get("ctx") ?? "");
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [trace, setTrace] = useState<Trace | null>(null);

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

  return (
    <main className="common_wrap">
      <header className="page_head">
        <h1>에이전트</h1>
        <p className="lead">에이전트 검사 모드에서 일하는 로컬 에이전트들입니다. 각 에이전트는 Agent Card로 할 수 있는 일(skill)과 등급, 부를 수 있는 쪽을 공개하고,
          서로 A2A로 요청을 주고받습니다. 모든 요청·결과는 공통 로그에 남습니다(입력 본문은 남기지 않음).</p>
      </header>
      {up === false && <div className="warn">오케스트레이터(127.0.0.1:8700)에 연결할 수 없습니다. <code>agents</code> 폴더에서 <code>python run_agents.py</code>로 켜세요.</div>}

      <section className="agent_grid">
        {Object.entries(agents).map(([name, a]) => (
          <article key={name} className={`acard ${a.status}`}>
            <h3>{agentLabel(name)} <code>{name}</code> <span className={`chip ${a.status === "on" ? "st-completed" : ""}`}>{a.status === "on" ? "켜짐" : a.status === "fake" ? "가짜" : "꺼짐"}</span></h3>
            {a.card ? (
              <>
                <p>{a.card.description}</p>
                <ul>
                  {a.card.skills.map((s) => (
                    <li key={s.id}><code>{s.id}</code> <span className="chip">{GRADE[s.grade] ?? s.grade}</span>
                      {s.verifier && <span className="chip">검증자 {agentLabel(s.verifier)}</span>}
                      <div className="note">{s.description} · 부를 수 있는 쪽: {s.allowed_requesters.map(agentLabel).join(", ")}</div></li>
                  ))}
                </ul>
              </>
            ) : <p className="note">아직 켜지지 않았거나 만들어지지 않은 에이전트입니다.</p>}
          </article>
        ))}
      </section>

      {/* 의뢰별 추적: 공통 로그의 요청↔결과 짝으로 만든 구간이다. 측정하지 않은 시간은 그리지 않는다(열린 구간은 줄무늬) */}
      <section className="panel">
        <div className="toolbar">
          <strong>의뢰 추적</strong>
          {trace && trace.spans.length > 0 ? (
            <>
              <span className="chip">전체 {secs(trace.total_ms)}</span>
              {trace.agents.map((a) => (
                <span key={a.agent} className="chip">{agentLabel(a.agent)} {a.calls}회 · {secs(a.ms)}{a.open ? " · 진행 중" : ""}</span>
              ))}
              <span className="note">공통 로그 {trace.lines}줄 기준 · 시작 {trace.t0?.slice(11, 19)}</span>
            </>
          ) : <span className="note">{ctx ? "이 의뢰에는 아직 구간이 없습니다." : "아래 목록에서 의뢰를 하나 고르면 에이전트별 워터폴이 나옵니다."}</span>}
        </div>
        {trace && trace.spans.length > 0 && (
          <ol className="waterfall">
            {trace.spans.map((s, i) => {
              const total = Math.max(trace.total_ms, 1);
              const ms = s.ms ?? total - s.start_ms;
              return (
                <li key={i}>
                  <span className="wf_who"><b>{agentLabel(s.agent)}</b> <code>{s.skill}</code>{s.requester && <span className="note"> ← {agentLabel(s.requester)}</span>}</span>
                  <span className="wf_track">
                    <span className={`wf_bar st-${s.status ?? "working"}${s.open ? " open" : ""}`} style={{ left: `${(s.start_ms / total) * 100}%`, width: `${Math.max((ms / total) * 100, 0.8)}%` }}
                      title={`${s.start_ms}~${s.end_ms ?? "?"}ms${s.outcome ? ` · ${s.outcome}` : ""}`} />
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
                <span>{g.kind === "human_review" ? "사람 승인" : "안전 관문"} · <code>{g.action}</code>
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
          <select value={ctx} onChange={(e) => setCtx(e.target.value)}>
            <option value="">전체(최근 300줄)</option>
            {jobs.map((j) => <option key={j.context_id} value={j.context_id}>{j.context_id} · {j.filename} · {j.status}</option>)}
          </select>
          <span className="note">{logs.length}줄 · 2초마다 갱신</span>
        </div>
        <ol className="timeline">
          {logs.map((l) => (
            <li key={l.id} className={`k-${l.kind} st-${l.status ?? ""}`}>
              <span className="t">{l.at.slice(11, 23)}</span>
              <span className="who"><b>{agentLabel(l.source)}</b>{l.requester && l.kind === "request_received" ? <> ← {agentLabel(l.requester)}</> : null}</span>
              <span className="what">{KIND[l.kind] ?? l.kind}{l.skill && <> · <code>{l.skill}</code></>}{l.status && <> · {l.status}</>}{l.outcome && <> · <b>{l.outcome}</b></>}{l.grade && l.grade !== "read" && <> · 등급 {l.grade}</>}</span>
              {!ctx && <span className="note">{l.context_id}</span>}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
