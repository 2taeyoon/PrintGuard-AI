"use client";

// 작업 만들기 — DesignCraft로 **새 문서를 만드는** 화면.
//
// 왜 이 화면이 있나. 검수도 수정도 '남이 만든 파일'이 있어야 시작된다. 원본이 아예 없는 사람에게
// "인디자인에서 먼저 만들어 오세요"라고 하면 거기서 끝난다. DesignCraft는 문서를 만들 수도 있으니
// 만드는 자리를 열어 두고, **만든 그 파일을 그대로 인쇄 검수로 넘긴다**. 그래서 이 화면의 마지막
// 단추는 '내려받기'가 아니라 '이 문서로 인쇄 검수하기'다.
//
// (전에 이 자리에 있던 '원본 수정'은 인쇄 검수 안으로 들어갔다 — 편집 파일로 검수를 맡기면
//  검수가 끝난 자리에서 바로 "원본에 반영할까요?"를 묻는다. 복사해서 붙여넣는 다리는 없앴다.)

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { createDocument, dcFileBlob, mcpStatus, type MadeDoc, type McpStatus } from "@/lib/agentClient";
import { CUSTOM, GROUPS as FORMATS, dims } from "@/lib/formats";
import { DirectConnect, FontNotice, IssueRows, SetupGuide, useBlob } from "../dc-shared";
import { GsMark } from "../gs-mark";
import { SignInNote } from "../sign-in";

export default function MakePage() {
  const router = useRouter();
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [mcpBusy, setMcpBusy] = useState(true);

  const [start, setStart] = useState<"blank" | "sample">("blank");
  const [size, setSize] = useState("A5 · 국판 (148×210)");
  const [w, setW] = useState(148);
  const [h, setH] = useState(210);
  const [pages, setPages] = useState(4);
  const [facing, setFacing] = useState(true);
  const [columns, setColumns] = useState(1);
  const [gutter, setGutter] = useState(5);
  const [margin, setMargin] = useState(15);
  const [bleed, setBleed] = useState(3);
  const [text, setText] = useState("");

  const [made, setMade] = useState<MadeDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showPre, setShowPre] = useState(true);
  const preview = useBlob(made?.context_id ?? null, made?.png ?? null);

  // 상태를 효과 안에서 바로 바꾸지 않는다(연쇄 렌더). 전부 약속이 끝난 뒤에 바꾼다.
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
  const recheck = () => { setMcpBusy(true); void check(); };

  function pickSize(v: string) {
    setSize(v);
    const d = dims(v);
    if (d) { setW(d[0]); setH(d[1]); }
  }

  /** 만든 파일 받기. 열쇠 헤더가 필요해 <a href>로 바로 못 걸고 받아서 내려 준다. */
  const dl = async (ctx: string, name: string, as: string) => {
    const u = await dcFileBlob(ctx, name);
    const a = document.createElement("a");
    a.href = u; a.download = as; a.click();
    setTimeout(() => URL.revokeObjectURL(u), 10_000);
  };

  async function make() {
    setBusy(true); setErr(""); setMade(null);
    try {
      setMade(await createDocument(start === "sample"
        ? { start: "sample" }
        : { start: "blank", width_mm: w, height_mm: h, pages, facing, columns,
            gutter_mm: gutter, margin_mm: margin, bleed_mm: bleed, text }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  return (
    <main className="common_wrap">
      <div className="page_head">
        <h1>작업 만들기</h1>
        <p className="lead">
          DesignCraft로 새 인디자인 문서를 만듭니다. 빈 판형으로 시작하거나 다쪽 <b>샘플 잡지</b>를 받아
          손보면 됩니다. 만든 파일은 그대로 <Link href="/">인쇄 검수</Link>로 넘어갑니다 — 검수까지 한 줄기입니다.
        </p>
        <p className="cantfix">
          <span className="nobadge">여기서 쪽을 그리지는 않습니다</span>
          글상자를 끌어 놓고 사진을 앉히는 일은 인디자인이나 DesignCraft 앱에서 하십시오. 이 화면이 하는 일은
          <b> 판형이 제대로 선 문서를 만들어 주는 것</b>까지입니다 — 그다음은 받아서 편집하시면 됩니다.
        </p>
      </div>

      <SignInNote />

      {/* 1. 연결 상태 */}
      <section className="panel dc_mcp">
        <div className="dc_head">
          <strong>1. DesignCraft MCP 연결</strong>
          <span className="chip">DesignCraft 기능</span>
          <span className={`badge ${mcp?.available ? "ok" : "off"}`}>{mcpBusy ? "확인 중…" : mcp?.available ? "연결됨" : "연결 안 됨"}</span>
          <button type="button" className="pill" onClick={recheck} disabled={mcpBusy}>다시 확인</button>
        </div>
        <p className="note">
          이 1번은 <b>DesignCraft가 제공하는 기능</b>입니다 — <code>designcraft-cli mcp</code>를 띄워 상태를 읽습니다.
        </p>
        {mcp?.available === false && <SetupGuide reason={mcp.reason ?? ""} />}
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
          </>
        )}
      </section>

      {/* 2. 무엇을 만들까 */}
      <section className="panel dc_src">
        <div className="dc_head"><strong>2. 무엇을 만들까요</strong></div>

        <div className="modebar" role="tablist" aria-label="시작하는 방법">
          <button type="button" role="tab" aria-selected={start === "blank"} className={`pill${start === "blank" ? " on" : ""}`}
            onClick={() => setStart("blank")}>빈 문서 <span className="count">판형부터 정하기</span></button>
          <button type="button" role="tab" aria-selected={start === "sample"} className={`pill${start === "sample" ? " on" : ""}`}
            onClick={() => setStart("sample")}>샘플 잡지 <span className="count">짜인 4쪽</span></button>
          <span className="note">
            {start === "blank"
              ? "쪽 크기·여백·단만 선 빈 문서를 만듭니다. 글상자가 하나 들어가 있어 바로 글을 흘릴 수 있습니다."
              : "DesignCraft가 들고 있는 다쪽 잡지 견본입니다. 표지·기사 제목·본문·사진 자리가 이미 짜여 있어, 글만 바꾸면 한 권이 됩니다. 크기는 견본이 정한 값(Letter, 마주보기)을 그대로 씁니다."}
          </span>
        </div>

        {start === "blank" && (
          <form className="upload" onSubmit={(e) => { e.preventDefault(); void make(); }}>
            <label>판형
              <select value={size} onChange={(e) => pickSize(e.target.value)}>
                {FORMATS.map((g) => (
                  <optgroup key={g.name} label={g.name}>
                    {g.items.map((f) => <option key={f.label} value={f.label}>{f.label}</option>)}
                  </optgroup>
                ))}
                <option value={CUSTOM}>{CUSTOM}</option>
              </select>
            </label>
            <label>가로(mm)
              <input type="number" min={10} max={2000} value={w} onChange={(e) => { setW(+e.target.value); setSize(CUSTOM); }} />
            </label>
            <label>세로(mm)
              <input type="number" min={10} max={2000} value={h} onChange={(e) => { setH(+e.target.value); setSize(CUSTOM); }} />
            </label>
            <label>쪽수
              <input type="number" min={1} max={64} value={pages} onChange={(e) => setPages(+e.target.value)} />
            </label>
            <label>여백(mm)
              <input type="number" min={0} max={100} value={margin} onChange={(e) => setMargin(+e.target.value)} />
            </label>
            <label>도련(mm)
              <input type="number" min={0} max={20} value={bleed} onChange={(e) => setBleed(+e.target.value)} />
            </label>
            <label>단
              <input type="number" min={1} max={10} value={columns} onChange={(e) => setColumns(+e.target.value)} />
            </label>
            <label>단 간격(mm)
              <input type="number" min={0} max={50} value={gutter} onChange={(e) => setGutter(+e.target.value)} />
            </label>
            <label className="chk" title="켜면 두 쪽이 펼침면으로 붙습니다(책·잡지). 끄면 낱장입니다(전단·포스터)">
              <input type="checkbox" checked={facing} onChange={(e) => setFacing(e.target.checked)} /> 마주보는 쪽(펼침면)
            </label>
            <label className="wide">첫 글상자에 넣을 글 (선택)
              <textarea className="dc_ta" rows={4} value={text} onChange={(e) => setText(e.target.value)}
                placeholder={"비워 두셔도 됩니다. 줄을 바꾸면 문단이 나뉩니다.\n\n가을호 특집\n인쇄는 기다림의 기술이다."} />
            </label>
          </form>
        )}

        <div className="dc_head">
          <button type="button" className="pill on" disabled={busy || !mcp?.available} onClick={() => void make()}>
            {busy ? "만드는 중…" : start === "sample" ? "샘플 잡지 만들기" : "문서 만들기"}
          </button>
          {!mcp?.available && <span className="note">DesignCraft에 연결된 뒤에 만들 수 있습니다.</span>}
          {busy && <span className="note">문서를 만들고 바로 열어 봅니다(10초쯤 걸립니다).</span>}
        </div>
        {err && <p className="warn">{err}</p>}
      </section>

      {/* 3. 만든 문서 */}
      {made && (
        <section className="panel dc_run">
          <div className="dc_head">
            <strong>3. 만든 문서</strong>
            <span className="chip">{made.filename}</span>
            <span className="chip">쪽<b>{made.pages}</b></span>
            {made.width_mm > 0 && <span className="chip">크기<b>{made.width_mm}×{made.height_mm}mm</b></span>}
            <span className="chip">글 덩어리<b>{made.stories.length}</b></span>
            <button type="button" className="pill on" onClick={() => router.push(`/?src=${encodeURIComponent(made.context_id)}`)}>
              이 문서로 인쇄 검수하기 →
            </button>
            <button type="button" className="pill" onClick={() => void dl(made.context_id, "new.idml", made.filename)}>IDML 받기</button>
            <button type="button" className="pill" onClick={() => void dl(made.context_id, "inspect.pdf", made.filename.replace(/\.idml$/, ".pdf"))}>PDF 받기</button>
          </div>
          <p className="note">
            검수로 넘기면 에이전트들이 이 문서를 그대로 받아 검사하고, 고칠 것이 있으면 <b>원본에 반영할지 물어봅니다</b>.
            편집 파일로 맡기는 길이라 고치는 데까지 한 번에 갑니다.
          </p>

          {preview && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="dc_shot" src={preview} alt={`${made.filename} 1쪽 미리보기`} />
          )}

          <button type="button" className="gs_toggle" onClick={() => setShowPre((o) => !o)} aria-expanded={showPre}>
            <GsMark open={showPre} /> 만든 문서 검사(preflight) {made.preflight.length}건
          </button>
          {showPre && <IssueRows rows={made.preflight} empty="만든 문서에서 발견된 문제가 없습니다." />}
          {/* 글꼴은 우리가 골라 만들었으니 없을 일이 드물다. 그래도 한글이 없는 글꼴로 짜였으면
              글자가 PDF에 안 찍히므로 같은 화면으로 알려 준다. 패키지 안내는 해당 없다. */}
          <FontNotice s={made} advise={false} />
        </section>
      )}
    </main>
  );
}
