"use client";

// 작업 만들기 — DesignCraft 편집기를 이 페이지 안에서 연다.
//
// 전에는 '무엇을 만들까요 → 무엇을 넣을까요 → 다 됐으면' 세 칸이었다. 판형을 고르고 글로 부탁해
// 만드는 길이었는데, **엔진이 웹 빌드를 내준다는 것을 뒤늦게 알았다.** 인디자인처럼 생긴 그
// 화면이 브라우저에서 그대로 돈다면, 흉내 낸 칸을 늘어놓을 이유가 없다. 진짜를 띄운다.
//
// 편집기는 `public/designcraft/`에 있고 저장소에는 없다(wasm 하나가 62MB다). `prebuild`가
// GitHub 릴리스에서 받아 푼다 — `public/models`·`public/ort`와 같은 방식이다. 못 받았으면
// 편집기 자리에 받는 법을 적는다.
//
// **에이전트는 이 편집기를 조종하지 못한다.** 웹 빌드에는 바깥과 통하는 길이 없다(wasm 안을
// 뒤져 확인했다 — MCP도 제어 포트도 없다). 브라우저 안에서 혼자 도는 편집기다.
// 에이전트가 하는 일이 **눈앞에서 바뀌는 것을 보려면** 데스크톱 앱을 `--control`로 띄우고
// 에이전트를 거기에 붙여야 한다. 그 길도 열어 두었고, 아래에 적는다.
//
// 만드는 길(`compose`·`edit_document`)은 그대로 둔다 — 클로드·커서가 MCP로 쓰고, 화면에서만
// 걷어낸 것이다.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { mcpStatus, type McpStatus } from "@/lib/agentClient";
import { SetupGuide } from "../dc-shared";
import { SignInNote } from "../sign-in";

/** 편집기가 깔려 있는지. 없으면 `prebuild`가 아직 못 받은 것이다. */
function useEditor() {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/designcraft/index.html", { method: "HEAD" })
      .then((r) => { if (alive) setReady(r.ok); })
      .catch(() => { if (alive) setReady(false); });
    return () => { alive = false; };
  }, []);
  return ready;
}

export default function MakePage() {
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [mcpBusy, setMcpBusy] = useState(true);
  const [big, setBig] = useState(false);
  const editor = useEditor();

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
          인디자인 같은 편집기를 이 쪽에서 바로 씁니다. 명함·전단·포스터·책·잡지 — 판형을 고르고
          글상자와 사진을 놓아 만드시면 됩니다. 만든 것을 <code>.idml</code>로 내려받아{" "}
          <Link href="/">인쇄 검수</Link>에 올리면 검수와 교정 반영까지 이어집니다.
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
          이 연결은 <b>검수와 교정 반영</b>에 쓰입니다. 아래 편집기는 브라우저 안에서 혼자 돌기 때문에
          이 연결과는 따로입니다 — <b>아래에서 만든 것이 에이전트에게 저절로 가지는 않습니다.</b>{" "}
          <code>.idml</code>로 내려받아 <Link href="/">인쇄 검수</Link>에 올려 주세요.
        </p>
        {mcp?.available && !appMode && (
          <p className="note">
            <b>에이전트가 하는 일을 눈앞에서 보고 싶다면</b> 데스크톱 앱을 쓰십시오.
            앱을 <code>designcraft --control 7979</code>로 띄우고 에이전트 쪽{" "}
            <code>agents/.env</code>에 <code>PG_DESIGNCRAFT_CONNECT=7979</code>를 넣으면,
            말로 부탁한 것과 교정 반영이 <b>그 앱 창에서 실시간으로</b> 일어납니다.
            다만 그때는 폴더 울타리가 없어집니다(돌고 있는 앱은 가둘 수 없습니다).
          </p>
        )}
        {appMode && (
          <p className="note">
            <b>켜 두신 앱에 붙어 있습니다.</b> 에이전트가 하는 일은 그 <b>앱 창</b>에서 실시간으로 보입니다
            (아래 편집기가 아니라 따로 뜬 그 창입니다). 이 모드에서는 폴더 울타리가 없습니다.
          </p>
        )}
        {mcp?.available === false && <SetupGuide reason={mcp.reason ?? ""} />}
        {mcp?.available === false && mcp.hint && <p className="note">{mcp.hint}</p>}
      </section>

      {/* 편집기 */}
      <section className="panel dc_editor_wrap">
        <div className="dc_head">
          <strong>편집기</strong>
          {editor === true && <span className="chip">DesignCraft 웹</span>}
          {editor === null && <span className="note">여는 중…</span>}
          <span className="grow" />
          <button type="button" className="pill" onClick={() => setBig((b) => !b)}>
            {big ? "낮게 보기" : "높게 보기"}
          </button>
          <a className="pill" href="/designcraft/index.html" target="_blank" rel="noreferrer">새 탭에서 열기</a>
        </div>

        {editor === false && (
          <div className="warn">
            <p><b>편집기를 아직 받지 않았습니다.</b> 저장소에 넣지 않습니다 — 파일 하나가 62MB입니다.</p>
            <p>앱을 돌리는 자리에서 한 번 받으면 됩니다:</p>
            <pre className="dc_cmd">cd frontend &amp;&amp; npm run fetch:designcraft</pre>
            <p className="note">
              GitHub 릴리스에서 받아 공개된 SHA256과 대조한 뒤 <code>public/designcraft/</code>에 풉니다.
              빌드할 때도 자동으로 받습니다(<code>prebuild</code>).
            </p>
          </div>
        )}

        {editor === true && (
          <>
            <iframe
              className={`dc_editor${big ? " tall" : ""}`}
              src="/designcraft/index.html"
              title="DesignCraft 편집기"
              allow="fullscreen; clipboard-read; clipboard-write"
              // 내려받기(저장·내보내기)와 저장소(환경 설정)가 있어야 한다. 그 둘이 빠지면
              // 만든 것을 꺼낼 수도, 설정을 기억할 수도 없다.
              sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox allow-modals"
              allowFullScreen
            />
            <p className="note">
              처음 열 때 한 번 크게 받습니다(조금 걸립니다). 글쇠는 편집기를 한 번 누른 뒤부터 그쪽으로 갑니다.
              만든 것은 <b>File → Export</b>로 <code>.idml</code>이나 PDF로 내려받으세요.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
