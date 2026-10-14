"use client";

import { FormEvent, useEffect, useState } from "react";
import type { Guide, Hit } from "@/lib/guide";
import { GuideBadge, GuideResult } from "../guide-ui";

const EXAMPLES = ["흰 글자가 출력에서 사라지는 이유는?", "도련은 몇 mm로 잡아야 해?", "뒷묻음은 왜 생겨?", "코팅지와 비코팅지 차이는?", "리치 블랙은 언제 써?"];

export default function GuidePage() {
  const [guide, setGuide] = useState<Guide | null>(null);
  const [status, setStatus] = useState("가이드 검색 준비 중");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [asked, setAsked] = useState("");

  useEffect(() => {
    let alive = true, unsub = () => {};
    import("@/lib/guide").then((m) => {
      const r = m.getGuide((s) => alive && setStatus(s));
      unsub = r.unsubscribe;
      return r.guide;
    }).then((g) => { if (alive) setGuide(g); }).catch(() => { /* 상태 문구로 표시됨 */ });
    return () => { alive = false; unsub(); };
  }, []);

  async function ask(text: string) {
    if (!guide || !text.trim()) return;
    setAsked(text.trim());
    setHits(await guide.search(text.trim(), 5));
  }
  const submit = (e: FormEvent) => { e.preventDefault(); ask(q); };

  return (
    <main className="common_wrap">
      <header className="page_head">
        <h1>인쇄 가이드</h1>
        <GuideBadge ready={!!guide} status={status} />
        <p className="lead">판형·색상·파일·용지·교정과 인쇄 불량에 관한 가이드 {guide ? guide.sections.length : "…"}개 항목에서 질문과 가까운 내용을 찾습니다.
          임베딩 모델(multilingual-e5-small)과 단어 검색(BM25)을 섞어 찾으며, 답을 지어내지 않고 가이드 원문을 그대로 보여 줍니다.</p>
      </header>
      <form className="upload ask panel" onSubmit={submit}>
        <label>질문
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="예: 흰 글자가 출력에서 사라지는 이유는?" disabled={!guide} />
        </label>
        <button disabled={!guide || !q.trim()}>찾기</button>
        <div className="filters" style={{ flexBasis: "100%", margin: 0 }}>
          {EXAMPLES.map((x) => (
            <button key={x} type="button" className="pill" disabled={!guide} onClick={() => { setQ(x); ask(x); }}>{x}</button>
          ))}
        </div>
      </form>
      {hits && (
        <>
          <p className="note">‘{asked}’와 가까운 항목 {hits.length}개 — 위쪽일수록 가깝습니다.{" "}
            <span className="mk-chunk">연한 배경</span>은 검색에 걸린 구간, <mark className="mk-term">진한 표시</mark>는 질문에 나온 단어입니다.</p>
          <ol className="gresults">{hits.map((h, i) => <GuideResult key={h.section.title} h={h} rank={i + 1} query={asked} />)}</ol>
        </>
      )}
      <div className="disclaimer">가이드는 일반적인 인쇄 상식과 공개 자료를 정리한 것이라 인쇄소마다 규격이 다를 수 있습니다. 최종 기준은 인쇄소에 확인하세요.</div>
    </main>
  );
}
