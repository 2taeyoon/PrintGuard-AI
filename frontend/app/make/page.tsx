"use client";

// 작업 만들기 — DesignCraft를 MCP로 붙여 두고, 에이전트가 만드는 것을 따라 보는 화면.
//
// 이 화면은 두 번 크게 바뀌었다. 처음에는 '무엇을 만들까요 → 무엇을 넣을까요 → 다 됐으면' 세 칸이
// 있었다. 다음에는 그 자리에 DesignCraft 웹 편집기를 띄웠다 — 인디자인처럼 생긴 그 화면이
// 브라우저에서 그대로 돈다는 것을 알고 나서다.
//
// **편집기를 다시 걷어냈다.** 그 편집기는 브라우저 안에서 혼자 돈다. 바깥에서 조종할 수도,
// 들여다볼 수도 없다(글루 JS에 `postMessage`도 `WebSocket`도 없다 — 찾아봤다). 그래서 거기서
// 손으로 만든 것은 에이전트에게 가지 않고, 에이전트가 하는 일도 거기에 비치지 않는다.
// 62MB짜리 wasm을 받아 가며 띄울 값이 없었다.
//
// 남긴 것은 **MCP 연결 하나**다. 클로드·커서가 그 연결로 문서를 만들고 고치면, 걸음마다 기록이
// 쌓인다. 이 화면은 그것을 **글로** 적고, 그 문서를 그대로 인쇄 검수로 넘긴다.
//
// 만드는 창구(`compose`·`edit_document`)는 그대로 둔다 — 클로드·커서가 MCP로 쓴다. 화면에서만
// 걷어낸 것이다.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { mcpStatus, type McpStatus } from "@/lib/agentClient";
import { SetupGuide } from "../dc-shared";
import WatchDoc from "../watch-doc";
import { SignInNote } from "../sign-in";

export default function MakePage() {
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [mcpBusy, setMcpBusy] = useState(true);

  const check = useCallback(
    () => mcpStatus()
      .then(setMcp, (e: unknown) => {
        const m = e instanceof Error ? e.message : String(e);
        setMcp(/^404\b/.test(m)
          ? { available: false, reason: "404 — 에이전트가 이 기능을 모릅니다(이 기능이 생기기 전 버전으로 켜져 있습니다)." }
          : { available: false, reason: m });
      })
      .finally(() => setMcpBusy(false)),
    [],
  );
  useEffect(() => { void check(); }, [check]);

  const appMode = mcp?.available === true && mcp.mode === "app";

  return (
    <main className="common_wrap">
      <div className="page_head">
        <h1>작업 만들기</h1>
        <p className="lead">
          클로드·커서에 “명함 하나 만들어 줘” 하고 시키면, DesignCraft 엔진이 인디자인 문서를
          만듭니다. 그 일이 어떻게 되어 가는지 이 화면에서 <b>한 걸음씩 글로</b> 보입니다.
          다 되면 <Link href="/">인쇄 검수</Link>로 바로 넘겨 글꼴·도련·색·오탈자를 받아 보세요.
        </p>
      </div>

      <SignInNote />

      {/* 연결 칸. 지금 무엇으로 돌고 있는지 — 창 없이 도는지, 켜 둔 앱에 붙었는지 — 가 보여야 한다. */}
      <section className="panel dc_mcp">
        <div className="dc_head">
          <strong>DesignCraft 연결</strong>
          <span className={`badge ${mcp?.available ? "ok" : "off"}`}>
            {mcpBusy ? "확인 중…" : mcp?.available ? "연결됨" : "연결 안 됨"}
          </span>
          {mcp?.available && (
            <span className="chip">{appMode ? `앱에 붙음 (${mcp.app_port} 포트)` : "창 없이 돎"}</span>
          )}
          <button type="button" className="pill" onClick={() => { setMcpBusy(true); void check(); }} disabled={mcpBusy}>다시 확인</button>
        </div>
        {mcp?.available && (
          <div className="dc_kv">
            <span className="chip">서버<b>{mcp.server} {mcp.server_version}</b></span>
            <span className="chip">CLI<b>{mcp.version}</b></span>
            <span className="chip">프로토콜<b>{mcp.protocol}</b></span>
            <span className="chip">도구<b>{mcp.tools?.length ?? 0}</b></span>
          </div>
        )}
        <p className="note">
          이 연결로 <b>문서를 만들고, 고치고, 검수 결과를 반영</b>합니다. 클로드·커서를 이 앱에
          붙이는 방법은 <Link href="/help">도움말</Link>에 적어 두었습니다.
        </p>
        {mcp?.available && !appMode && (
          <p className="note">
            지금은 <b>창 없이</b> 돕니다 — 문서를 파일로만 다루고, 쪽 그림을 뽑아 아래에 보여 줍니다.
            만들어지는 것을 <b>눈앞에서</b> 보고 싶으시면 데스크톱 앱을{" "}
            <code>designcraft --control 7979</code>로 띄우고 에이전트 쪽 <code>agents/.env</code>에{" "}
            <code>PG_DESIGNCRAFT_CONNECT=7979</code>를 넣으세요. 그러면 그 앱 창에서 바로 일어납니다.
            다만 그때는 폴더 울타리가 없어집니다(돌고 있는 앱은 가둘 수 없습니다).
          </p>
        )}
        {appMode && (
          <p className="note">
            <b>켜 두신 앱에 붙어 있습니다.</b> 에이전트가 하는 일이 그 <b>앱 창</b>에서 바로 일어납니다.
            이 모드에서는 폴더 울타리가 없습니다.
          </p>
        )}
        {mcp?.available === false && <SetupGuide reason={mcp.reason ?? ""} />}
        {mcp?.available === false && mcp.hint && <p className="note">{mcp.hint}</p>}
      </section>

      {/* 하는 일(글) + 그 문서(검수로 넘기기·파일 받기·쪽 미리보기·검사). */}
      <WatchDoc />
    </main>
  );
}
