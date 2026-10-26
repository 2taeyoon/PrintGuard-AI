"use client";
// 에이전트 모드 검수가 끝난 뒤: 목업 인쇄소 견적(B) → 주문(C, 사람 승인) → 보고서(A).
// 실제 인쇄소에는 아무것도 보내지 않는다. 금액은 shop이 계산하고 safety가 다시 계산해 대조한다.
import { useState } from "react";
import { compileReport, decideReview, placeOrder, requestQuote, type AgentReply } from "@/lib/agentClient";

const PARTNERS = [
  { id: "mock_ganada", label: "(목업) 가나다인쇄 · 오프셋 소량" },
  { id: "mock_haneul", label: "(목업) 하늘디지털인쇄 · 디지털" },
  { id: "mock_paju", label: "(목업) 파주오프셋 · 오프셋 대량" },
];
const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;

export function CommercePanel({ ctx }: { ctx: string }) {
  const [partner, setPartner] = useState(PARTNERS[0].id);
  const [copies, setCopies] = useState(100);
  const [quote, setQuote] = useState<AgentReply | null>(null);
  const [order, setOrder] = useState<AgentReply | null>(null);
  const [report, setReport] = useState<AgentReply | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what); setErr("");
    try { await f(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(""); }
  };
  const getQuote = () => run("quote", async () => { setOrder(null); setQuote(await requestQuote(ctx, partner, copies)); });
  const order1 = () => run("order", async () => setOrder(await placeOrder(ctx)));
  const decide = (ok: boolean) => run("order", async () => {
    await decideReview(String(order?.question?.review_id), ok);
    setOrder(await placeOrder(ctx)); // 승인 결과를 반영해 다시 부른다(같은 멱등 키 → 주문은 한 번만)
  });
  const makeReport = () => run("report", async () => setReport(await compileReport(ctx)));

  const q = quote?.output.quote;
  const dec = quote?.output.decision;
  return (
    <section className="commerce panel" aria-label="견적·주문·보고서">
      <div className="cm_head">
        <strong>인쇄소 견적·주문</strong>
        <span className="chip">목업 협력사만</span>
        <span className="note">실제 인쇄소에는 아무것도 보내지 않습니다. 단가는 시연용입니다. 상태를 바꾸는 일은 안전 관문(safety)을 거칩니다.</span>
      </div>

      <div className="cm_row">
        <label>협력사
          <select value={partner} onChange={(e) => setPartner(e.target.value)}>{PARTNERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        </label>
        <label>부수
          <input type="number" min={1} max={100000} value={copies} onChange={(e) => setCopies(Math.max(1, Number(e.target.value) || 1))} />
        </label>
        <button type="button" disabled={!!busy} onClick={getQuote}>{busy === "quote" ? "견적 요청 중…" : "견적 받기"}</button>
        <span className="chip grade">B · preflight가 사양 대조</span>
      </div>

      {quote && quote.status !== "completed" && <p className="cm_bad">견적 거절: {quote.output.reason ?? quote.output.message ?? quote.outcome}</p>}
      {q && (
        <div className="cm_quote">
          <div><b>{q.partner_name}</b> <span className="cm_amount">{won(q.amount)}</span> <span className="note">견적 {q.quote_id}</span></div>
          <ul>{q.breakdown.map((b: { item: string; won: number }, i: number) => <li key={i}>{b.item} <b>{won(b.won)}</b></li>)}</ul>
          <p className="note">사양: {q.spec.pages}쪽 · {q.spec.copies}부 · {q.spec.width_mm}×{q.spec.height_mm}mm · 종이 {q.spec.paper_id} — {dec?.reason}</p>
          <div className="cm_row">
            <button type="button" disabled={!!busy || order?.status === "completed"} onClick={order1}>{busy === "order" ? "처리 중…" : "주문 요청"}</button>
            <span className="chip grade">C · 사람 승인 필요</span>
          </div>
        </div>
      )}

      {order?.status === "input-required" && order.question && (
        <div className="question cm_approval" role="dialog" aria-label="주문 승인">
          <span className="chip">안전 관문의 승인 요청 · {String(order.question.review_id)}</span>
          <h3>{String(order.question.text)}</h3>
          <p className="note">승인은 사람만 할 수 있습니다(에이전트 토큰은 거부). 기한이 지나면 자동으로 거절됩니다.</p>
          <div className="q_opts">
            <button type="button" disabled={!!busy} onClick={() => decide(true)}>승인</button>
            <button type="button" className="ghost" disabled={!!busy} onClick={() => decide(false)}>거절</button>
          </div>
        </div>
      )}
      {order?.status === "completed" && <p className="cm_ok">목업 주문 완료: {order.output.order.order_id} · {won(order.output.order.amount)} · {order.output.decision?.reason}</p>}
      {order && !["completed", "input-required"].includes(order.status) && <p className="cm_bad">주문 거절: {order.output.reason ?? order.outcome}</p>}

      <div className="cm_row cm_report">
        <strong>검수 보고서</strong>
        <button type="button" className="ghost" disabled={!!busy} onClick={makeReport}>{busy === "report" ? "작성 중…" : "보고서 만들기"}</button>
        <span className="chip grade">A · ΔE는 color가 다시 계산해 대조</span>
      </div>
      {report && report.status !== "completed" && <p className="cm_bad">보고서 거절: {report.output.reason ?? report.outcome}</p>}
      {report?.status === "completed" && (
        <>
          {report.output.verified?.delta_e && (
            <p className={report.output.verified.delta_e.match ? "cm_ok" : "cm_bad"}>
              ΔE 검증: 받은 값 {Number(report.output.verified.delta_e.claimed).toFixed(2)} / 다시 계산 {report.output.verified.delta_e.recomputed == null ? "실패" : Number(report.output.verified.delta_e.recomputed).toFixed(2)}
              {report.output.verified.delta_e.match ? " · 일치" : " · 불일치(다시 계산한 값을 적음)"}
            </p>
          )}
          <pre className="cm_md">{report.output.markdown}</pre>
          <p className="note">저장: {report.output.path}</p>
        </>
      )}
      {err && <p className="cm_bad">{err}</p>}
    </section>
  );
}
