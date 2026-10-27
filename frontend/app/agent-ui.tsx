import type { JobView, Question } from "@/lib/agentClient";

const AGENT_LABEL: Record<string, string> = {
  orchestrator: "총괄", preflight: "사전 검사", color: "색", paper: "종이·위험도", guide: "인쇄 가이드", proofread: "교정", shop: "인쇄소", report: "보고서", safety: "안전 관문",
};
export const agentLabel = (n: string) => AGENT_LABEL[n.replace("(fake)", "")] ?? n;

// 에이전트가 할 수 있는 일(skill)의 이름은 코드용 영어 id라 처음 보면 뜻을 알 수 없다.
// 화면에는 언제나 '우리말 이름 (영어 id)' 순서로 적는다.
const SKILL_LABEL: Record<string, string> = {
  check_structure: "PDF 구조 검사", predict_color: "인쇄 색 차이 예측", recompute_delta_e: "색 차이 다시 계산",
  recommend_paper: "종이 추천", assess_risk: "인쇄 불량 위험도 평가", search_guide: "인쇄 가이드 검색",
  suggest_corrections: "오탈자 수정 제안", find_shops: "인쇄소 찾기", request_quote: "견적 요청",
  place_order: "주문 넣기", compile_report: "검수 보고서 작성", verify_spec: "주문 내용 교차 검증",
  execute: "행동 실행 허가(안전 관문)",
};
export const skillLabel = (id: string) => SKILL_LABEL[id] ?? id;

/** skill 이름: 우리말 이름을 앞에, 코드용 id를 괄호 안에 */
export function SkillName({ id }: { id: string }) {
  const ko = SKILL_LABEL[id];
  return ko ? <><b className="sk_ko">{ko}</b> <code>({id})</code></> : <code>{id}</code>;
}
const STATUS: Record<string, string> = { completed: "완료", "input-required": "질문", rejected: "거부", canceled: "취소", failed: "실패", working: "진행 중" };

/** 에이전트 모드 진행 상황: 어떤 에이전트가 어떤 skill을 했는지, 걸린 시간 */
export function AgentProgress({ job }: { job: JobView }) {
  return (
    <div className="agent_progress panel" aria-live="polite">
      <div className="ap_head">
        <strong>에이전트 검사</strong>
        <span className="chip">{job.context_id}</span>
        <span className={`chip st-${job.status}`}>{STATUS[job.status] ?? job.status}</span>
        {job.status === "working" && <span className="spinner" aria-hidden="true" />}
        <a className="note" href={`/agents?ctx=${job.context_id}`}>소통 기록 ↗</a>
      </div>
      <ol className="ap_steps">
        {job.steps.map((s, i) => (
          <li key={i} className={`st-${s.status}`}>
            <b>{agentLabel(s.agent)}</b> <SkillName id={s.skill} />
            <span className="chip">{STATUS[s.status] ?? s.status}{s.outcome ? ` · ${s.outcome}` : ""}</span>
            <span className="note">{(s.ms / 1000).toFixed(1)}초</span>
          </li>
        ))}
        {job.status === "working" && <li className="st-working"><span className="note">다음 에이전트 진행 중…</span></li>}
      </ol>
    </div>
  );
}

/** input-required: 에이전트가 판단에 필요한 정보를 묻는다. 답하면 그 skill만 다시 실행된다 */
export function QuestionCard({ q, busy, onAnswer }: { q: Question; busy: boolean; onAnswer: (v: string) => void }) {
  return (
    <div className="question panel" role="dialog" aria-label="에이전트 질문">
      <div className="q_from"><span className="chip">{agentLabel(q.agent)} 에이전트의 질문</span></div>
      <h3>{q.text}</h3>
      {q.why && <p className="note">{q.why}</p>}
      <div className="q_opts">
        {q.options.map((o) => (
          <button key={o.value} type="button" className="ghost" disabled={busy} onClick={() => onAnswer(o.value)} title={o.hint}>
            {o.label}{o.hint && <small>{o.hint}</small>}
          </button>
        ))}
      </div>
    </div>
  );
}
