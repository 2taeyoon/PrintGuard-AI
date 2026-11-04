"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  applyFixes, dcFileBlob, mcpStatus, orchBuiltSnapshot, orchUrl, subscribeOrch, uploadSource,
  type ApplyResult, type McpStatus, type PreflightIssue, type SourceView,
} from "@/lib/agentClient";
import { parseFixText } from "@/lib/fixlist";
import { GsMark } from "../gs-mark";
import { SessionBoot, SignInPanel, useSession } from "../sign-in";

const SEV: Record<string, string> = { error: "오류", warning: "경고" };
// DesignCraft preflight가 내는 종류를 우리말로. 모르는 종류는 영문 그대로 둔다(숨기면 왜 걸렸는지 알 수 없다).
const KIND: Record<string, string> = {
  overset: "텍스트 넘침", unplacedStory: "배치 안 된 글", missingFont: "없는 글꼴", missingFontStyle: "글꼴 스타일 대체",
  missingGlyphs: "없는 글자(글리프)", missingLink: "끊긴 이미지 링크", lowResolution: "낮은 해상도",
  emptyText: "빈 텍스트 프레임", rgbColor: "인쇄 문서의 RGB 색", unsupportedTypography: "미지원 조판",
  unsupportedGraphicLayers: "미지원 그래픽 레이어",
};
const ACCEPT = ".idml,.designcraft";

/** 같은 종류는 묶어서 센다 — 넘침 28건을 28줄로 늘어놓으면 읽을 수가 없다. */
function IssueRows({ rows, empty }: { rows: PreflightIssue[]; empty: string }) {
  const grouped = useMemo(() => {
    const m = new Map<string, PreflightIssue[]>();
    for (const r of rows) m.set(r.kind, [...(m.get(r.kind) ?? []), r]);
    return [...m.entries()].sort((a, b) => (a[1][0].severity === "error" ? 0 : 1) - (b[1][0].severity === "error" ? 0 : 1));
  }, [rows]);
  if (!rows.length) return <div className="empty">{empty}</div>;
  return (
    <ul className="dc_issues">
      {grouped.map(([kind, list]) => (
        <li key={kind} className={`sev-${list[0].severity === "error" ? "high" : "medium"}`}>
          <b>{KIND[kind] ?? kind}</b>
          <span className="chip">{SEV[list[0].severity] ?? list[0].severity}<b>{list.length}</b></span>
          <span className="dc_msg">{list.slice(0, 3).map((r) => (r.page ? `${r.page}쪽 ` : "") + r.message).join(" / ")}
            {list.length > 3 && ` 외 ${list.length - 3}건`}</span>
        </li>
      ))}
    </ul>
  );
}

/** 열쇠 헤더가 필요해서 <img src>로 바로 못 건다. 받아서 blob 주소로 바꾼다.
 *  받아 온 주소에 어느 파일 것인지 꼬리표를 달아 둔다 — 파일이 바뀌는 순간 지난 그림이
 *  남아 있지 않게 하려는 것이고, 효과 안에서 상태를 바로 바꾸지 않아도 되게 하려는 것이다. */
function useBlob(ctx: string | null, name: string | null) {
  const [got, setGot] = useState<{ key: string; url: string } | null>(null);
  const key = ctx && name ? `${ctx}/${name}` : "";
  useEffect(() => {
    if (!ctx || !name) return;
    let dead = false, made: string | null = null;
    dcFileBlob(ctx, name)
      .then((u) => { if (dead) { URL.revokeObjectURL(u); return; } made = u; setGot({ key: `${ctx}/${name}`, url: u }); })
      .catch(() => undefined);
    return () => { dead = true; if (made) URL.revokeObjectURL(made); };
  }, [ctx, name]);
  return got && got.key === key ? got.url : null;
}

/** 눌러서 복사하는 명령 한 줄. 연결 안내는 '읽고 따라 치는' 것이 아니라 '복사해서 붙여넣는' 것이어야 한다. */
function Cmd({ children, note }: { children: string; note?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="cmd">
      <code>{children}</code>
      <button type="button" className="pill" onClick={() => {
        navigator.clipboard.writeText(children).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        }, () => undefined);
      }}>{done ? "복사함" : "복사"}</button>
      {note && <span className="note">{note}</span>}
    </div>
  );
}

/** 연결이 안 될 때 **무엇을 하면 되는지**를 순서대로. 이유마다 짚을 곳이 다르다:
 *  오케스트레이터가 옛 버전인가 / 에이전트가 안 떴나 / CLI가 없나. */
function SetupGuide({ reason, orch }: { reason: string; orch: string }) {
  // 할 일이 전혀 다른 네 경우를 가른다. '연결 안 됨'으로 뭉뚱그리면 아무도 고치지 못한다.
  const cliMissing = /찾을 수 없|실행할 수 없|PG_DESIGNCRAFT_CLI/.test(reason);
  const noRoute = /^404\b|\b404 —/.test(reason);
  const unreachable = /Failed to fetch|NetworkError|Load failed|ERR_|timeout|시간이 초과/i.test(reason);
  const step = cliMissing ? 3 : noRoute || unreachable ? 2 : /대답하지 않습니다|꺼져/.test(reason) ? 2 : 0;

  return (
    <div className="dc_setup">
      <p className="warn">
        {cliMissing && <><b>designcraft-cli가 그 PC에 없습니다.</b> 아래 1번으로 설치해 주세요.</>}
        {!cliMissing && unreachable && <><b>에이전트에 닿지 못했습니다.</b> <code>{orch}</code>가 응답하지 않습니다 — 아래 2번으로 켜 주세요.</>}
        {!cliMissing && !unreachable && noRoute && <><b>에이전트가 옛 버전입니다.</b> 이 기능이 생기기 전에 켠 것이라 이 주소를 모릅니다 — 아래 2번으로 다시 켜 주세요.</>}
        {!cliMissing && !unreachable && !noRoute && <>{reason || "연결하지 못했습니다."}</>}
      </p>

      <p className="note">
        MCP는 <b>stdin/stdout으로만</b> 말합니다. 브라우저가 직접 부를 수 없어서, <b>에이전트를 돌리는 그 PC</b>에{" "}
        <code>designcraft-cli</code>가 있어야 합니다. 지금 보고 있는 에이전트 주소는 <code>{orch}</code>입니다.
      </p>

      <ol className="dc_steps">
        <li className={step === 3 ? "on" : ""}>
          <b>DesignCraft CLI 설치</b> — 저장소 폴더에서 한 번만. 관리자 권한이 필요 없고, 받는 데 몇 분 걸립니다.
          <Cmd note="릴리스를 받아 체크섬을 맞춰 보고 CLI만 꺼내 둡니다">
            powershell -ExecutionPolicy Bypass -File deploy\install_designcraft.ps1
          </Cmd>
          <span className="note">
            직접 받으셔도 됩니다 — <a href="https://github.com/storytold/designcraft/releases/latest" target="_blank" rel="noreferrer">릴리스</a>의
            Windows portable zip 안에 있는 <code>designcraft-cli.exe</code>를{" "}
            <code>%LOCALAPPDATA%\Programs\ArtCraft\DesignCraft\</code>에 두면 앱이 알아서 찾습니다.
            다른 곳에 두었으면 <code>agents/.env</code>에 <code>PG_DESIGNCRAFT_CLI=경로</code>를 적습니다.
          </span>
        </li>
        <li className={step === 2 ? "on" : ""}>
          <b>에이전트 다시 켜기</b> — 설치한 뒤에는 꼭 다시 켜야 합니다(켤 때 CLI를 찾습니다).
          <Cmd note="저장소 루트에서. 창은 그대로 두세요">conda activate dev; python agents\run_agents.py</Cmd>
          <span className="note">포트가 <b>9개</b>(8700~8706·8708·8709) 떠야 정상입니다.</span>
        </li>
        <li>
          <b>위 ‘다시 확인’ 누르기</b> — 서버 이름과 도구 수가 뜨면 끝입니다.
        </li>
      </ol>

    </div>
  );
}

/** 같은 MCP를 클로드·커서에 **직접** 붙이는 길. 이 화면을 거치지 않아도 되는 일이라 적어 둔다.
 *  같이 적는 경고가 더 중요하다 — 가두는 플래그를 빼면 디스크 전체가 열린다(확인했다). */
function DirectConnect() {
  return (
    <details className="dc_direct">
      <summary>이 MCP를 클로드·커서에 직접 붙이려면</summary>
      <p className="note">
        1번이 DesignCraft 자체 기능이라, 같은 MCP를 AI 코딩 도구에 바로 붙여 대화로 고치게 할 수도 있습니다.
        도구 26개가 그대로 붙어서 <code>file.openIdml</code> → <code>find.change</code> → <code>file.exportPdf</code>를
        스스로 합니다. 아래 두 폴더는 <b>읽기·쓰기를 가두는 값</b>이니 본인 폴더로 바꿔 주세요.
      </p>
      <Cmd note="두 폴더를 반드시 같이 주세요">
        claude mcp add designcraft -- designcraft-cli mcp --automation-read-root C:\work\idml --automation-write-root C:\work\out
      </Cmd>
      <p className="warn">
        <b>두 폴더를 빼면 디스크 전체가 열립니다.</b> 문서의 “Without either flag nothing changes”는 <i>가두지 않는다</i>는
        뜻입니다. 실제로 확인해 보니, 플래그 없이 띄운 MCP가 임의의 폴더에 있는 파일을 읽고 임의의 자리에 파일을 썼습니다.
        그래서 PrintGuard는 두 폴더가 없으면 MCP를 <b>아예 띄우지 않습니다</b>.
      </p>
      <p className="note">
        직접 붙이면 이 화면이 하던 것들은 빠집니다. 같은 글자가 여러 쪽에 있을 때 <b>쪽으로 가리기</b>,
        한 건 고칠 때마다 <b>다시 찾기</b>, 항목별 실패 이유, 승인 관문, 고친 뒤 재검사 다섯입니다.
        (한글은 한 자가 3바이트라, 한 번 바꾸면 뒤쪽 위치가 모두 밀립니다. 그래서 건마다 다시 찾습니다.)
      </p>
      <p className="note">
        한두 건이면 직접 붙이는 편이 빠릅니다. 검수 결과를 그대로 반영할 때는 아래 2·3·4가 안전합니다.
      </p>
    </details>
  );
}

/** 한 쪽의 전후 비교. 1쪽만 그리면 여러 쪽짜리에서 정작 바뀐 쪽을 못 본다. */
function Compare({ ctx, shot }: { ctx: string; shot: { page: number; before: string; after: string } }) {
  const before = useBlob(ctx, shot.before);
  const after = useBlob(ctx, shot.after);
  return (
    <div className="dc_compare">
      <figure>
        <figcaption>{shot.page}쪽 · 수정 전</figcaption>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {before ? <img src={before} alt={`수정 전 ${shot.page}쪽`} /> : <div className="empty">불러오는 중…</div>}
      </figure>
      <figure>
        <figcaption>{shot.page}쪽 · 수정 후</figcaption>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {after ? <img src={after} alt={`수정 후 ${shot.page}쪽`} /> : <div className="empty">불러오는 중…</div>}
      </figure>
    </div>
  );
}

export default function FixPage() {
  // 저장된 주소는 localStorage에 있다. 처음 그릴 때 그대로 읽으면 서버가 그린 화면과 달라져
  // 하이드레이션이 어긋난다 — 그래서 빌드 기본값으로 먼저 그리고 구독으로 따라간다.
  const orch = useSyncExternalStore(subscribeOrch, orchUrl, orchBuiltSnapshot);

  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [mcpBusy, setMcpBusy] = useState(true);

  const [picked, setPicked] = useState<File[]>([]);
  const [src, setSrc] = useState<SourceView | null>(null);
  const [srcBusy, setSrcBusy] = useState(false);
  const [showPre, setShowPre] = useState(true);

  const [paste, setPaste] = useState("");
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [err, setErr] = useState("");
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  const parsed = useMemo(() => parseFixText(paste), [paste]);
  const ctx = src?.context_id ?? null;
  const previewUrl = useBlob(ctx, result ? null : (src?.png ?? null));

  // 상태를 효과 안에서 바로 바꾸지 않는다(연쇄 렌더). 전부 약속이 끝난 뒤에 바꾼다.
  const check = useCallback(
    () => mcpStatus()
      .then(setMcp, (e: unknown) => {
        // 404는 '꺼짐'이 아니라 **오케스트레이터가 이 기능을 모른다**는 뜻이다. 옛 버전으로 켜 둔 것이다.
        const m = e instanceof Error ? e.message : String(e);
        setMcp(/^404\b/.test(m)
          ? { available: false, reason: "404 — 에이전트가 이 기능을 모릅니다(이 기능이 생기기 전 버전으로 켜져 있습니다)." }
          : { available: false, reason: m });
      })
      .finally(() => setMcpBusy(false)),
    [],
  );
  useEffect(() => { void check(); }, [check, orch]);
  const recheck = () => { setMcpBusy(true); void check(); };  // 버튼에서는 바로 바꿔도 된다

  const me = useSession().account;

  async function upload(fs: File[]) {
    setSrcBusy(true); setErr(""); setSrc(null); setResult(null);
    try { setSrc(await uploadSource(fs)); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setSrcBusy(false);
  }

  async function run() {
    if (!ctx || !parsed.fixes.length) return;
    setRunBusy(true); setErr(""); setResult(null);
    try {
      const r = await applyFixes(ctx, parsed.fixes);
      if (r.status !== "completed") throw new Error((r.output?.reason as string) || (r.output?.message as string) || `반영하지 못했습니다(${r.status})`);
      setResult(r.output as unknown as ApplyResult);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setRunBusy(false);
  }

  const dl = async (name: string, as: string) => {
    if (!ctx) return;
    const u = await dcFileBlob(ctx, name);
    const a = document.createElement("a");
    a.href = u; a.download = as; a.click();
    setTimeout(() => URL.revokeObjectURL(u), 10_000);
  };

  return (
    <main className="common_wrap">
      <SessionBoot />
      <div className="page_head">
        <h1>원본 수정</h1>
        <p className="lead">
          <Link href="/">인쇄 검수</Link>에서 복사한 교정 목록을 붙여 넣고 편집 파일(IDML)을 올리면, DesignCraft가 글자를 찾아
          고치고 PDF로 다시 내보냅니다.
        </p>
        <p className="cantfix">
          <span className="nobadge">PDF는 고칠 수 없습니다</span>
          DesignCraft에서 PDF는 배치만 되고 글자를 집을 수 없습니다. 고치려면 편집 파일이 있어야 합니다.
        </p>
        <p className="cantfix">
          <span className="nobadge">INDD는 고칠 수 없습니다</span>
          고친 결과를 INDD로 돌려드릴 수 없어서 받지 않습니다. InDesign에서 <b>파일 → 다른 이름으로 저장 → InDesign Markup(IDML)</b>로
          내보내 올려 주세요.
        </p>
      </div>

      {/* 올린 편집 파일도 에이전트를 돌리는 PC에 저장된다. 그래서 여기도 주인이 있어야 한다 */}
      {!me && <SignInPanel what="원본 수정" />}

      {/* 1. 연결 상태 */}
      <section className="panel dc_mcp">
        <div className="dc_head">
          <strong>1. DesignCraft MCP 연결</strong>
          <span className="chip">DesignCraft 기능</span>
          <span className={`badge ${mcp?.available ? "ok" : "off"}`}>{mcpBusy ? "확인 중…" : mcp?.available ? "연결됨" : "연결 안 됨"}</span>
          <button type="button" className="pill" onClick={recheck} disabled={mcpBusy}>다시 확인</button>
        </div>
        {/* 어디까지가 남의 기능이고 어디부터가 우리 화면인지 적어 둔다. 이걸 섞어 두면
            'PrintGuard가 파일을 고친다'고 읽히는데, 고치는 것은 DesignCraft다. */}
        <p className="note">
          이 1번은 <b>DesignCraft가 제공하는 기능</b>입니다 — <code>designcraft-cli mcp</code>를 띄워 상태를 읽습니다.
          아래 <b>2·3·4는 그 위에 PrintGuard가 올린 화면</b>이고, 글자를 실제로 고치고 내보내는 일은 어느 쪽이든 DesignCraft가 합니다.
        </p>
        {mcp?.available === false && <SetupGuide reason={mcp.reason ?? ""} orch={orch} />}
        <DirectConnect />
        {mcp === null && <div className="dc_why"><p>확인 중입니다.</p></div>}
        {mcp?.available && (
          <>
            <div className="dc_kv">
              <span className="chip">서버<b>{mcp.server} {mcp.server_version}</b></span>
              <span className="chip">CLI<b>{mcp.version}</b></span>
              <span className="chip">프로토콜<b>{mcp.protocol}</b></span>
              <span className="chip">방식<b>{mcp.mode === "headless" ? "헤드리스(창 없음)" : mcp.mode}</b></span>
              <span className="chip">도구<b>{mcp.tools?.length ?? 0}</b></span>
            </div>
            <div className="dc_tools">{mcp.tools?.map((t) => <code key={t}>{t}</code>)}</div>
          </>
        )}
      </section>

      {/* 2. 원본 올리기 */}
      <section className="panel dc_src">
        <div className="dc_head">
          <strong>2. 원본 파일</strong>
        </div>
        {/* 무엇을 올릴 수 있고 무엇을 돌려받는지는 **고르기 전에** 알아야 한다.
            올린 뒤 경고로만 알려 주면 INDD 쓰는 사람은 이미 기대가 어긋난 뒤다. */}
        <table className="dc_formats">
          <thead><tr><th>올리는 파일</th><th>열기</th><th>돌려받는 것</th></tr></thead>
          <tbody>
            <tr><td><code>.idml</code></td><td>O</td><td>고친 <b>PDF + IDML</b></td></tr>
            <tr><td><code>.designcraft</code></td><td>O</td><td>고친 <b>PDF + .designcraft</b></td></tr>
            <tr className="no"><td><code>.indd</code> <code>.indt</code></td><td>✕</td>
              <td>받지 않습니다 — INDD로 돌려드릴 수 없어서입니다. IDML로 내보내 올려 주세요</td></tr>
            <tr className="no"><td><code>.pdf</code></td><td>✕</td><td>받지 않습니다 — PDF는 글자를 집을 수 없습니다</td></tr>
          </tbody>
        </table>
        <p className="pick_why">
          <span className="okbadge">폴더째 올리시는 편이 좋습니다</span>
          IDML은 사진을 <b>링크로만</b> 들고 있습니다. 파일 하나만 올리면 인쇄용 사진이 따라오지 않아 ‘끊긴 이미지 링크’가 뜨고,
          내보낸 PDF에서도 사진이 빠집니다. InDesign에서 <b>파일 → 패키지</b>로 만든 폴더를 통째로 올리면
          옆의 <code>Links</code> 사진과 <code>Document fonts</code> 글꼴까지 같이 올라가 그대로 열립니다.
        </p>

        <div className="dc_pick">
          <label className="pick">
            <b>폴더 올리기</b>
            <span className="note">사진·글꼴까지 — 권장</span>
            {/* webkitdirectory는 React 타입에 없어서 속성으로 직접 준다 */}
            <input type="file" disabled={!mcp?.available || srcBusy || !me}
              ref={(el) => { if (el) { el.setAttribute("webkitdirectory", ""); el.setAttribute("directory", ""); } }}
              onChange={(e) => { const fs = e.target.files; if (fs?.length) { setPicked(Array.from(fs)); void upload(Array.from(fs)); } }} />
          </label>
          <label className="pick">
            <b>파일 하나만</b>
            <span className="note">글자 교정만 할 때</span>
            <input type="file" accept={ACCEPT} disabled={!mcp?.available || srcBusy || !me}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) { setPicked([f]); void upload([f]); } }} />
          </label>
          {srcBusy && <span className="badge">여는 중…</span>}
          {picked.length > 0 && src && (
            <button type="button" className="pill" onClick={() => void upload(picked)} disabled={srcBusy || !me}>다시 열기</button>
          )}
        </div>

        {src && (
          <>
            <div className="dc_kv">
              <span className="chip">{src.filename}</span>
              <span className="chip">쪽<b>{src.pages}</b></span>
              <span className="chip">글 덩어리<b>{src.stories.length}</b></span>
              <span className="chip">단락 스타일<b>{src.paragraph_styles}</b></span>
              <span className="chip">넘친 글<b>{src.stories.filter((s) => s.overset).length}</b></span>
              {(src.uploaded_files ?? 1) > 1 && <span className="chip">올린 파일<b>{src.uploaded_files}</b></span>}
            </div>

            {src.preflight.some((i) => i.kind === "missingLink") && (
              <p className="warn">
                <b>사진 링크가 끊겼습니다.</b> IDML 파일만 올려서 그렇습니다 — 사진은 그 파일 안에 없습니다.
                지금 보이는 그림은 IDML이 품고 있는 <b>저해상 미리보기</b>라서, 이대로 내보낸 PDF는 인쇄에 쓸 수 없습니다.
                글자 교정만 하실 거면 그대로 두셔도 되고, 쓸 PDF가 필요하면 <b>패키지 폴더를 통째로</b> 올려 주세요.
              </p>
            )}
            {src.missing_fonts.length > 0 && (
              <p className="warn">
                <b>이 PC에 없는 글꼴 {src.missing_fonts.length}개</b>: {src.missing_fonts.join(", ")} — 대체 글꼴로 열렸습니다.
                글자 너비가 달라져 <b>줄바꿈과 넘침이 원본과 다르게 보일 수 있습니다.</b> 내보낸 PDF의 모양도 그만큼 달라집니다.
              </p>
            )}
            {src.open_warnings.length > 0 && (
              <details className="dc_warnbox">
                <summary>여는 중 경고 {src.open_warnings.length}건</summary>
                <ul>{src.open_warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </details>
            )}

            <button type="button" className="gs_toggle" onClick={() => setShowPre((o) => !o)} aria-expanded={showPre}>
              <GsMark open={showPre} /> 원본 검사(preflight) {src.preflight.length}건
            </button>
            {showPre && (
              <>
                <IssueRows rows={src.preflight} empty="원본에서 발견된 문제가 없습니다." />
                <p className="note">
                  넘친 글·끊긴 링크·없는 글꼴은 <b>PDF만 봐서는 알 수 없는 것들</b>입니다. 넘친 글자는 PDF에 아예 안 찍히고,
                  끊긴 이미지는 빈 칸으로 보일 뿐입니다. 원본을 열었기 때문에 잡힙니다.
                </p>
              </>
            )}
            {previewUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="dc_shot" src={previewUrl} alt={`${src.filename} 1쪽 미리보기`} />
            )}
          </>
        )}
      </section>

      {/* 3. 교정 목록 */}
      <section className="panel dc_paste">
        <div className="dc_head">
          <strong>3. 교정 목록 붙여넣기</strong>
          <span className="chip">반영할 항목<b>{parsed.fixes.length}</b></span>
          {parsed.skipped.length > 0 && <span className="chip sev-medium">건너뛸 줄<b>{parsed.skipped.length}</b></span>}
          <button type="button" className="pill" onClick={async () => {
            try { setPaste(await navigator.clipboard.readText()); } catch { pasteRef.current?.focus(); }
          }}>클립보드에서 붙여넣기</button>
          {paste && <button type="button" className="pill" onClick={() => setPaste("")}>비우기</button>}
        </div>
        {/* 손으로 쓰는 칸이 아니라 **받는 칸**이다. 안 적어 두면 15건을 직접 타이핑하려 든다. */}
        <p className="note">
          손으로 쓰는 칸이 아닙니다 — <Link href="/">인쇄 검수</Link>에서 <b>‘교정 목록 복사’</b>를 누르고 여기서{" "}
          <b>붙여넣기</b>만 하면 채워집니다. 칸을 열어 둔 것은 여러 건 중 <b>일부만 고르거나</b> 제안 문구를
          손봐서 반영하고 싶을 때를 위해서입니다.
        </p>
        <textarea ref={pasteRef} className="dc_ta" rows={10} value={paste} onChange={(e) => setPaste(e.target.value)}
          placeholder={"검수 화면에서 복사한 글을 그대로 붙여 넣으세요.\n\n고를 때만 손으로 고칩니다 — 한 줄에 '쪽 | 원래 내용 | 수정할 내용'\n3 | 넓이 | 너비"} />
        {parsed.skipped.length > 0 && (
          <ul className="dc_skipped">
            {parsed.skipped.map((s) => <li key={s.line}><b>{s.line}번째 줄</b> {s.why} — <code>{s.text}</code></li>)}
          </ul>
        )}
      </section>

      {/* 4. 실행 */}
      <section className="panel dc_run">
        <div className="dc_head">
          <strong>4. 반영하고 내보내기</strong>
          <button type="button" className="pill on" disabled={!ctx || !parsed.fixes.length || runBusy || !mcp?.available || !me} onClick={() => void run()}>
            {runBusy ? "반영 중…" : `교정 ${parsed.fixes.length}건 반영`}
          </button>
          {!ctx && <span className="note">먼저 원본을 올려 주세요.</span>}
          {ctx && !parsed.fixes.length && <span className="note">반영할 교정이 없습니다.</span>}
        </div>
        {err && <p className="warn">{err}</p>}

        {result && (
          <>
            <div className="dc_kv">
              <span className="chip">반영<b className="sev-low">{result.applied.length}</b></span>
              <span className="chip">실패<b className={result.failed.length ? "sev-high" : ""}>{result.failed.length}</b></span>
              <button type="button" className="pill on" onClick={() => void dl("fixed.pdf", `수정본_${src?.filename ?? "문서"}.pdf`)}>수정된 PDF 받기</button>
              {result.source_out && (
                <button type="button" className="pill" onClick={() => void dl(result.source_out!, `수정본_${result.source_out}`)}>
                  편집 파일({result.source_out.split(".").pop()}) 받기
                </button>
              )}
            </div>

            {result.shots.map((s) => <Compare key={s.page} ctx={ctx!} shot={s} />)}
            {result.shots_total > result.shots.length && (
              <p className="note">바뀐 쪽이 {result.shots_total}쪽인데 앞의 {result.shots.length}쪽만 그렸습니다.
                나머지는 내려받은 PDF에서 보세요.</p>
            )}

            <h3 className="dc_sub">반영된 항목 {result.applied.length}건</h3>
            {result.applied.length === 0 ? <div className="empty">반영된 항목이 없습니다.</div> : (
              <ul className="dc_log">
                {result.applied.map((a, i) => (
                  <li key={i} className="ok">
                    {a.page ? <span className="chip">{a.page}쪽</span> : null}
                    <del>{a.original}</del> <span className="arrow">→</span> <ins>{a.suggestion}</ins>
                    <span className="note">글 덩어리 {a.story}, 위치 {a.at[0]}–{a.at[1]}바이트</span>
                  </li>
                ))}
              </ul>
            )}

            {result.failed.length > 0 && (
              <>
                <h3 className="dc_sub">반영하지 못한 항목 {result.failed.length}건</h3>
                <ul className="dc_log">
                  {result.failed.map((f, i) => (
                    <li key={i} className="bad">
                      {f.page ? <span className="chip">{f.page}쪽</span> : null}
                      <code>{f.original}</code> <span className="arrow">→</span> <code>{f.suggestion}</code>
                      <span className="why">{f.reason}</span>
                    </li>
                  ))}
                </ul>
                <p className="note">
                  같은 문구가 여러 군데 있으면 <b>일부러 고치지 않습니다.</b> 어느 것인지 가릴 수 없는데 찍어서 고치면 조용히
                  틀립니다. 교정 줄 앞의 쪽 번호를 적어 주면 그 쪽에서만 찾습니다.
                </p>
              </>
            )}

            <h3 className="dc_sub">고친 뒤 원본 검사</h3>
            <IssueRows rows={result.preflight_after} empty="남은 문제가 없습니다." />
            <p className="note">
              교정이 새 문제를 만들 수 있습니다. 한글을 라틴 글꼴 자리에 넣으면 <b>없는 글자(글리프)</b>가 되고, 글이 길어지면{" "}
              <b>넘침</b>이 생깁니다. 그래서 고친 뒤에 한 번 더 검사합니다.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
