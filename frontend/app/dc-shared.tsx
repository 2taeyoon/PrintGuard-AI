"use client";

// DesignCraft(인디자인 엔진)를 쓰는 화면들이 같이 쓰는 조각들.
//
// 전에는 '원본 수정' 한 화면에만 있었다. 지금은 **고치는 일이 인쇄 검수 안으로 들어가고**
// ('검수 → 교정 제안 → 원본에 반영'이 한 줄기다), 이 화면은 '작업 만들기'가 되었다.
// 두 화면이 같은 것을 보여 줘야 해서 — 연결 상태, 원본 검사 결과, 전후 비교 — 여기로 옮겼다.

import { useEffect, useMemo, useState } from "react";

import { dcFileBlob, type FontState, type PreflightIssue } from "@/lib/agentClient";

export const SEV: Record<string, string> = { error: "오류", warning: "경고" };
// DesignCraft preflight가 내는 종류를 우리말로. 모르는 종류는 영문 그대로 둔다(숨기면 왜 걸렸는지 알 수 없다).
export const KIND: Record<string, string> = {
  overset: "텍스트 넘침", unplacedStory: "배치 안 된 글", missingFont: "없는 글꼴", missingFontStyle: "글꼴 스타일 대체",
  missingGlyphs: "없는 글자(글리프)", missingLink: "끊긴 이미지 링크", lowResolution: "낮은 해상도",
  emptyText: "빈 텍스트 프레임", rgbColor: "인쇄 문서의 RGB 색", unsupportedTypography: "미지원 조판",
  unsupportedGraphicLayers: "미지원 그래픽 레이어",
};

/** 글꼴 상태. **고치는 게 아니라 밝히는 화면이다.**
 *
 *  글꼴은 편집 파일에 담겨 오지 않고 이름으로만 실려 온다. 서버에 세상의 글꼴을 다 깔아 둘 수는
 *  없고, 상용 글꼴을 깔아 두고 남의 파일에 쓰는 것은 라이선스 문제이기도 하다. 그래서 글꼴이
 *  없을 때 **무엇이 멀쩡하고 무엇이 못 믿을 것인지**를 가려 말하는 것이 이 화면이 할 일이다.
 *
 *  대체된 글꼴로 본 결과를 그냥 내놓으면, 넘친 글 수치를 원본의 문제로 읽게 된다. 수치를 지우는
 *  것도 답이 아니다 — 색·해상도처럼 글꼴과 무관한 검수는 그대로 맞기 때문이다. 그래서 둘을 나눈다.
 *
 *  `advise`: 올린 원본이면 패키지로 다시 올리는 길을 알려 준다. 우리가 만든 문서에는 해당 없다.
 */
export function FontNotice({ s, advise = true }: { s: Partial<FontState>; advise?: boolean }) {
  const missing = (s.fonts ?? []).filter((f) => f.status === "missing");
  const subbed = (s.fonts ?? []).filter((f) => f.status === "substituted");
  const blocked = s.glyph_blocked ?? [];
  const fromPkg = s.document_fonts ?? 0;
  if (!missing.length && !subbed.length && !blocked.length && !fromPkg) return null;

  return (
    <div className="dc_fonts">
      {fromPkg > 0 && (
        <p className="note dc_fontok">
          <b>패키지에 담겨 온 글꼴 {fromPkg}개를 그대로 썼습니다.</b> 미리보기가 원본과 같습니다 —
          이 PC에 설치하지 않고 올리신 폴더 안에서만 읽습니다.
        </p>
      )}

      {/* 가장 위험한 경우. 글자가 PDF에 남지 않아 교정이 '고칠 것 없음'을 내놓는다 */}
      {blocked.length > 0 && (
        <div className="warn">
          <p><b>글꼴에 없는 글자가 있습니다</b> — {blocked.join(", ")}.</p>
          <p>
            그 글자는 네모로 찍히고 <b>PDF에 글자로 남지 않습니다.</b> 교정이 그 글을 읽지 못하니,
            <b> 교정이 적게 나왔다면 글이 깨끗해서가 아닐 수 있습니다.</b>
          </p>
          <p>
            이건 대체 글꼴 문제가 아니라 <b>원본의 흠</b>입니다 — 한글을 한글이 없는 글꼴로 짜 놓은 것입니다.
            인디자인에서 그 글의 글꼴을 바꾸셔야 합니다.
          </p>
        </div>
      )}

      {missing.length > 0 && (
        <div className="warn">
          <p><b>이 PC에 없는 글꼴 {missing.length}개</b> — 비슷한 것으로 대체해서 열었습니다.</p>
          <ul className="dc_fontlist">
            {missing.map((f) => (
              <li key={`${f.family} ${f.style}`}>
                <b>{f.family}</b> {f.style}
                <span>→ {f.resolved} {f.resolved_style}로 대체</span>
                <span className="chip">{f.chars}자</span>
              </li>
            ))}
          </ul>
          <p>
            <b>글은 그대로입니다.</b> 교정과 원본 반영은 글꼴과 상관없이 됩니다 — 고쳐 드리는 편집 파일에는{" "}
            <b>원래 글꼴 이름이 그대로 남아</b>, 그 글꼴이 있는 PC(올리신 인디자인)에서 열면 원본대로 보입니다.
            <b> 원본이 깨지는 일은 없습니다.</b>
          </p>
          <p>
            <b>줄바꿈은 다릅니다.</b> 글자 너비가 달라 줄이 밀립니다. 그래서 <b>넘친 글·쪽 배분·줄 수</b>는
            여기 보이는 값이 원본의 것이 아닙니다. 색·해상도·종이처럼 글꼴과 무관한 검수는 그대로 맞습니다.
          </p>
          {advise && (
            <p>
              글꼴까지 맞춰서 보시려면 인디자인에서 <b>파일 → 패키지</b>로 만든 폴더를 <b>통째로</b> 올려 주세요.
              그 안의 <code>Document Fonts</code> 폴더를 문서보다 먼저 읽습니다. 글꼴 파일을 따로 보내실 필요는 없습니다.
            </p>
          )}
        </div>
      )}

      {subbed.length > 0 && (
        <p className="warn">
          <b>굵기·기울기가 대체된 글꼴 {subbed.length}개</b>: {subbed.map((f) => `${f.family} ${f.style}`).join(", ")} —
          글꼴 가족은 있는데 그 굵기가 없어 가까운 것으로 그렸습니다. 글자 모양이 원본보다 가늘거나 굵게 보입니다.
        </p>
      )}
    </div>
  );
}

/** 같은 종류는 묶어서 센다 — 넘침 28건을 28줄로 늘어놓으면 읽을 수가 없다. */
export function IssueRows({ rows, empty }: { rows: PreflightIssue[]; empty: string }) {
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
export function useBlob(ctx: string | null, name: string | null) {
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

/** 한 쪽의 전후 비교. 1쪽만 그리면 여러 쪽짜리에서 정작 바뀐 쪽을 못 본다. */
export function Compare({ ctx, shot }: { ctx: string; shot: { page: number; before: string; after: string } }) {
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

/** 눌러서 복사하는 명령 한 줄. 연결 안내는 '읽고 따라 치는' 것이 아니라 '복사해서 붙여넣는' 것이어야 한다. */
export function Cmd({ children, note }: { children: string; note?: string }) {
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
export function SetupGuide({ reason }: { reason: string }) {
  // 할 일이 전혀 다른 네 경우를 가른다. '연결 안 됨'으로 뭉뚱그리면 아무도 고치지 못한다.
  const cliMissing = /찾을 수 없|실행할 수 없|PG_DESIGNCRAFT_CLI/.test(reason);
  const noRoute = /^404\b|\b404 —/.test(reason);
  const unreachable = /Failed to fetch|NetworkError|Load failed|ERR_|timeout|시간이 초과/i.test(reason);
  const step = cliMissing ? 3 : noRoute || unreachable ? 2 : /대답하지 않습니다|꺼져/.test(reason) ? 2 : 0;

  return (
    <div className="dc_setup">
      <p className="warn">
        {cliMissing && <><b>designcraft-cli가 그 PC에 없습니다.</b> 아래 1번으로 설치해 주세요.</>}
        {!cliMissing && unreachable && <><b>에이전트에 닿지 못했습니다.</b> 아래 2번으로 켜 주세요.</>}
        {!cliMissing && !unreachable && noRoute && <><b>에이전트가 옛 버전입니다.</b> 이 기능이 생기기 전에 켠 것이라 이 주소를 모릅니다 — 아래 2번으로 다시 켜 주세요.</>}
        {!cliMissing && !unreachable && !noRoute && <>{reason || "연결하지 못했습니다."}</>}
      </p>

      <p className="note">
        MCP는 <b>stdin/stdout으로만</b> 말합니다. 브라우저가 직접 부를 수 없어서, <b>에이전트를 돌리는 그 PC</b>에{" "}
        <code>designcraft-cli</code>가 있어야 합니다.
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
export function DirectConnect() {
  return (
    <details className="dc_direct">
      <summary>이 MCP를 클로드·커서에 직접 붙이려면</summary>
      <p className="note">
        위 연결은 DesignCraft 자체 기능이라, 같은 MCP를 AI 코딩 도구에 바로 붙여 대화로 고치게 할 수도 있습니다.
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
        직접 붙이면 PrintGuard가 하던 것들은 빠집니다. 같은 글자가 여러 쪽에 있을 때 <b>쪽으로 가리기</b>,
        한 건 고칠 때마다 <b>다시 찾기</b>, 항목별 실패 이유, 승인 관문, 고친 뒤 재검사 다섯입니다.
        (한글은 한 자가 3바이트라, 한 번 바꾸면 뒤쪽 위치가 모두 밀립니다. 그래서 건마다 다시 찾습니다.)
      </p>
    </details>
  );
}
