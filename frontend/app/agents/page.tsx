"use client";

// 에이전트 탭 — 본체는 app/agents-view.tsx에 있고(인쇄 검수 화면에서도 같은 것을 쓴다) 여기서는 설명만 붙인다.
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import AgentsView from "../agents-view";

export default function AgentsPageWrap() {
  return <Suspense><AgentsPage /></Suspense>;
}

function AgentsPage() {
  const ctx = useSearchParams().get("ctx") ?? "";
  return (
    <main className="common_wrap">
      <header className="page_head">
        <h1>에이전트</h1>
        <p className="lead">에이전트 검사 모드에서 일하는 로컬 에이전트입니다. 각자 할 수 있는 일(skill)과 등급, 자기를 부를 수 있는 쪽을 공개하고 서로 요청을 주고받습니다.
          모든 요청·결과는 공통 로그에 남습니다(입력 본문은 남기지 않습니다). 이름을 누르면 그 에이전트가 할 수 있는 일을 볼 수 있습니다.</p>
      </header>
      <AgentsView initialCtx={ctx} />
    </main>
  );
}
