"use client";

// 인쇄 가이드 검색 — 검수 화면 맨 위에서 쓴다. 바로 검사 모드는 브라우저 안의 모델로, 에이전트 모드는 guide 에이전트로 찾는다.
// 어느 쪽이든 답을 지어내지 않고 가이드 원문 절을 그대로 보여 준다.
import { FormEvent, useState } from "react";
import type { Guide, Hit } from "@/lib/guide";
import { searchGuideViaAgent } from "@/lib/agentClient";
import { GuideResult } from "./guide-ui";

const EXAMPLES = ["도련은 몇 mm로 잡아야 해?", "흰 글자가 출력에서 사라지는 이유는?", "뒷묻음은 왜 생겨?", "리치 블랙은 언제 써?"];

export default function GuideSearch({ guide, mode, ready }: { guide: Guide | null; mode: "direct" | "agent"; ready: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const usable = mode === "agent" ? ready : !!guide;

  async function ask(text: string) {
    const t = text.trim();
    if (!t || !usable) return;
    setAsked(t); setBusy(true); setErr("");
    try {
      setHits(mode === "agent" ? await searchGuideViaAgent(t, 5) : await guide!.search(t, 5));
    } catch (e) {
      setErr(`가이드를 찾지 못했습니다 (${e instanceof Error ? e.message : e})`);
      setHits(null);
    } finally { setBusy(false); }
  }

  return (
    <section className={`gsearch panel${open ? " open" : ""}`}>
      <div className="gs_head">
        <button type="button" className="gs_toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <b>인쇄 가이드 찾아보기</b>
          <span className="note">판형·색·파일·종이·불량에 관한 가이드에서 질문과 가까운 항목을 찾습니다. 답을 지어내지 않고 원문을 보여 줍니다.</span>
          <span className="gs_mark" aria-hidden="true">{open ? "－" : "＋"}</span>
        </button>
      </div>
      {open && (
        <div className="gs_body">
          <form
            className="gs_form"
            onSubmit={(e: FormEvent) => { e.preventDefault(); ask(q); }}
          >
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="예: 도련은 몇 mm로 잡아야 해?" disabled={!usable || busy} />
            <button disabled={!usable || busy || !q.trim()}>{busy ? "찾는 중…" : "찾기"}</button>
          </form>
          <div className="gs_ex">
            {EXAMPLES.map((x) => (
              <button key={x} type="button" className="pill" disabled={!usable || busy} onClick={() => { setQ(x); ask(x); }}>{x}</button>
            ))}
          </div>
          {!usable && <p className="note">{mode === "agent" ? "에이전트가 켜져 있어야 가이드를 찾습니다." : "가이드 검색 모델을 불러오는 중입니다."}</p>}
          {err && <div className="warn">{err}</div>}
          {hits && (
            <>
              <p className="note">‘{asked}’와 가까운 항목 {hits.length}개 — 위쪽일수록 가깝습니다.{" "}
                <span className="mk-chunk">연한 배경</span>은 검색에 걸린 구간, <mark className="mk-term">진한 표시</mark>는 질문에 나온 단어입니다.</p>
              <ol className="gresults">{hits.map((h, i) => <GuideResult key={`${h.section.title}-${i}`} h={h} rank={i + 1} query={asked} />)}</ol>
              <p className="note">가이드는 일반적인 인쇄 상식과 공개 자료를 정리한 것이라 인쇄소마다 규격이 다를 수 있습니다. 최종 기준은 인쇄소에 확인하세요.</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
