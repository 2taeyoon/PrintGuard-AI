"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { listAgents, listJobs, listLogs, orchestratorUp, type AgentInfo, type JobRow, type LogRow } from "@/lib/agentClient";
import { agentLabel } from "../agent-ui";

const KIND: Record<string, string> = {
  job_opened: "의뢰 접수", request_received: "요청 받음", result_sent: "결과 보냄", task_status: "호출 실패", input_required: "사용자에게 질문",
  input_answered: "답 받음", job_closed: "의뢰 종료", job_failed: "의뢰 실패", duplicate_job: "같은 의뢰(멱등성)",
};
const GRADE: Record<string, string> = { read: "조회", A: "A 즉시 실행", B: "B 교차검증", C: "C 사람 승인" };

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
