"use client";

// 작업 만들기 — 인디자인 문서를 만드는 화면.
//
// 왜 이 화면이 있나. 검수도 수정도 '남이 만든 파일'이 있어야 시작된다. 원본이 없는 사람에게
// "인디자인에서 먼저 만들어 오세요"라고 하면 거기서 끝난다. 그래서 만드는 자리를 열어 두고,
// **만든 그 파일을 그대로 인쇄 검수로 넘긴다.**
//
// **넣는 길은 적어서 부탁하기 하나다.** 전에는 빠른 도구(글상자·사진·도형…)와 명령 547개를
// 찾아 쓰는 칸이 같이 있었다. 둘 다 없앴다 — 자리를 숫자로 적고 명령 이름을 찾는 일은
// 인디자인을 아는 사람도 이 화면에서 하고 싶지 않고, 어차피 적어서 부탁하면 되는 일이었다.
// 칸이 하나면 무엇을 눌러야 할지 고민할 것도 없다.
//
// 사진만 예외로 **올리는 칸**이 남는다. 브라우저의 사진은 에이전트 PC에 없으므로 프롬프트만으로는
// 닿지 않는다 — 먼저 의뢰 폴더로 올려야 엔진이 읽는다. 올린 것의 경로를 LLM에게 알려 주고,
// 그 목록에 없는 경로는 서버가 버린다(지어낸 경로는 울타리 밖이라 어차피 거절된다).
//
// 한 번에 넣는 것은 **전부 아니면 전무**다. 하나가 실패하면 아무것도 저장되지 않는다 — 절반만
// 들어간 문서를 돌려주면 무엇이 들어갔는지 알 수 없다. 한 걸음 되돌리는 단추도 둔다.
//
// 마지막 칸에는 **엔진이 실제로 한 일**을 적는다. 명령 이름과 그 결과를 그대로 보여 준다 —
// 무엇이 어떻게 만들어졌는지 보고 싶은 사람에게는 이게 명령 목록보다 쓸모 있다.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  composeDocument, createDocument, dcFileBlob, editDocument, mcpStatus, undoEdit, uploadAsset,
  type Composed, type EditResult, type EngineStep, type MadeDoc, type McpStatus,
} from "@/lib/agentClient";
import { CUSTOM, GROUPS as FORMATS, dims } from "@/lib/formats";
import { FontNotice, IssueRows, SetupGuide, useBlob } from "../dc-shared";
import { SignInNote } from "../sign-in";

const PT = 72 / 25.4;           // 엔진이 쓰는 길이는 pt다. 화면은 mm로 묻는다

/** 무엇을 만들까. 크기 하나가 아니라 **한 벌**이다 — 명함은 앞뒤 두 쪽 낱장이고 책은 열여섯 쪽
 *  펼침면이다. 고르면 아래 칸이 한꺼번에 채워진다. */
type Kind = {
  id: string; w: number; h: number; pages: number; facing: boolean;
  margin: number; bleed: number; columns: number; gutter: number; note: string;
};
const KINDS: Kind[] = [
  { id: "명함", w: 90, h: 50, pages: 2, facing: false, margin: 5, bleed: 2, columns: 1, gutter: 0, note: "앞뒤 두 쪽" },
  { id: "엽서·카드", w: 148, h: 100, pages: 2, facing: false, margin: 8, bleed: 3, columns: 1, gutter: 0, note: "앞뒤 두 쪽" },
  { id: "전단", w: 210, h: 297, pages: 1, facing: false, margin: 10, bleed: 3, columns: 1, gutter: 0, note: "A4 한 장" },
  { id: "포스터", w: 420, h: 594, pages: 1, facing: false, margin: 15, bleed: 3, columns: 1, gutter: 0, note: "A2 한 장" },
  { id: "3단 리플릿", w: 297, h: 210, pages: 2, facing: false, margin: 8, bleed: 3, columns: 3, gutter: 0, note: "A4 가로, 세 칸" },
  { id: "책·소설", w: 152, h: 225, pages: 16, facing: true, margin: 18, bleed: 3, columns: 1, gutter: 0, note: "신국판 열여섯 쪽" },
  { id: "잡지", w: 210, h: 297, pages: 8, facing: true, margin: 15, bleed: 3, columns: 2, gutter: 5, note: "국배판 여덟 쪽" },
  { id: "카탈로그", w: 210, h: 297, pages: 12, facing: true, margin: 12, bleed: 3, columns: 2, gutter: 5, note: "A4 열두 쪽" },
  { id: "스티커", w: 50, h: 50, pages: 1, facing: false, margin: 3, bleed: 2, columns: 1, gutter: 0, note: "정사각 한 장" },
  { id: "메뉴판", w: 210, h: 420, pages: 2, facing: false, margin: 12, bleed: 3, columns: 1, gutter: 0, note: "길쭉한 판, 앞뒤" },
];

/** 적어서 부탁하는 보기. 빈 칸만 있으면 무엇을 적어야 할지 모른다. */
const EXAMPLES = [
  "맨 위에 큰 제목 ‘가을 공연 안내’, 그 아래 날짜와 장소, 아래쪽에 사진 자리 하나",
  "표지에 제목과 지은이, 둘째 쪽부터 두 단으로 본문 자리",
  "가격표를 세 줄 네 칸 표로, 맨 윗줄은 머리글",
];

/** 엔진이 한 일 한 줄. 명령과 그 결과를 그대로 적는다. */
type Did = { label: string; steps: { command: string; result: Record<string, unknown> | null }[] };

export default function MakePage() {
  const router = useRouter();
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [mcpBusy, setMcpBusy] = useState(true);

  const [kind, setKind] = useState("전단");
  const [size, setSize] = useState(CUSTOM);
  const [w, setW] = useState(210);
  const [h, setH] = useState(297);
  const [pages, setPages] = useState(1);
  const [facing, setFacing] = useState(false);
  const [columns, setColumns] = useState(1);
  const [gutter, setGutter] = useState(5);
  const [margin, setMargin] = useState(10);
  const [bleed, setBleed] = useState(3);

  const [made, setMade] = useState<MadeDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // 넣고 난 뒤의 모습. 한 번 넣을 때마다 갈린다.
  const [state, setState] = useState<EditResult | null>(null);
  const [did, setDid] = useState<Did[]>([]);
  const [page, setPage] = useState(1);

  // 말로 부탁하기 + 쓸 사진
  const [ask, setAsk] = useState("");
  const [plan, setPlan] = useState<Composed | null>(null);
  const [pics, setPics] = useState<string[]>([]);

  const shots = state?.shots ?? (made ? [made.png] : []);
  const shotName = shots[Math.min(page, shots.length) - 1] ?? null;
  const preview = useBlob(made?.context_id ?? null, shotName);

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

  function pickKind(id: string) {
    const k = KINDS.find((x) => x.id === id);
    if (!k) return;
    setKind(id); setSize(CUSTOM);
    setW(k.w); setH(k.h); setPages(k.pages); setFacing(k.facing);
    setMargin(k.margin); setBleed(k.bleed); setColumns(k.columns); setGutter(k.gutter);
  }
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

  async function make(start: "blank" | "sample") {
    setBusy(true); setErr(""); setMade(null); setState(null); setDid([]); setPage(1); setPlan(null); setPics([]);
    try {
      const m = await createDocument(start === "sample"
        ? { start: "sample" }
        : { start: "blank", width_mm: w, height_mm: h, pages, facing, columns,
          gutter_mm: gutter, margin_mm: margin, bleed_mm: bleed, text: "" });
      setMade(m);
      setDid([{ label: start === "sample" ? "미리 만들어 둔 샘플로 시작했습니다"
        : `${m.pages}쪽 ${m.width_mm}×${m.height_mm}mm 문서를 만들었습니다`, steps: [] }]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  /** 넣는다. 하나라도 실패하면 **아무것도 저장되지 않는다** — 그 말을 그대로 적는다. */
  async function apply(steps: EngineStep[], label: string) {
    if (!made || !steps.length) return;
    setBusy(true); setErr("");
    try {
      const r = await editDocument(made.context_id, steps);
      setState(r);
      if (r.ok) {
        setDid((d) => [...d, { label, steps: r.applied }]);
        setPage((p) => Math.min(p, Math.max(1, r.shots.length)));
        setPlan(null); setAsk("");
      } else {
        setErr(`${r.failed?.command}에서 멈췄습니다 — ${r.failed?.reason} 아무것도 저장하지 않았으니 문서는 그대로입니다.`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function compose() {
    if (!made || !ask.trim()) return;
    setBusy(true); setErr(""); setPlan(null);
    try {
      const r = await composeDocument(made.context_id, ask.trim());
      setPlan(r);
      if (r.available && r.commands.length === 0) {
        setErr(r.reason ?? "조금 더 자세히 적어 주세요. 지금 내용만으로는 무엇을 넣을지 알 수 없습니다.");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  /** 사진은 먼저 올려 둔다. 올린 뒤에 “왼쪽 위에 그 사진” 하고 적으면 된다. */
  async function addPic(f: File | null) {
    if (!f || !made) return;
    setBusy(true); setErr("");
    try {
      const a = await uploadAsset(made.context_id, f);
      setPics((p) => [...p, a.original]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function undo() {
    if (!made) return;
    setBusy(true); setErr("");
    try {
      setState(await undoEdit(made.context_id));
      setDid((d) => [...d, { label: "한 걸음 되돌렸습니다", steps: [] }]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  const pageCount = state?.pages ?? made?.pages ?? 0;
  const off = mcp?.available === false;

  return (
    <main className="common_wrap">
      <div className="page_head">
        <h1>작업 만들기</h1>
        <p className="lead">
          인쇄물을 처음부터 만듭니다. 명함·전단·포스터·책·잡지 중에서 고르고 <b>무엇을 넣을지 적으면</b>{" "}
          그대로 만들어 드립니다. 다 되면 인디자인 파일(<code>.idml</code>)과 PDF로 받고,{" "}
          <Link href="/">인쇄 검수</Link>로 바로 넘길 수도 있습니다.
        </p>
      </div>

      <SignInNote />

      {/* 연결은 끊겼을 때만 자리를 차지한다. 잘 되고 있을 때 설명을 읽고 싶은 사람은 없다. */}
      {off && (
        <section className="panel dc_mcp">
          <div className="dc_head">
            <strong>아직 만들 수 없습니다</strong>
            <span className="badge off">연결 안 됨</span>
            <button type="button" className="pill" onClick={() => { setMcpBusy(true); void check(); }} disabled={mcpBusy}>다시 확인</button>
          </div>
          <SetupGuide reason={mcp?.reason ?? ""} />
        </section>
      )}

      {/* 1. 무엇을 만들까 */}
      <section className="panel dc_src">
        <div className="dc_head">
          <strong>1. 무엇을 만들까요</strong>
          {made && <span className="chip">만들었습니다</span>}
          {mcpBusy && !made && <span className="note">준비하는 중…</span>}
        </div>
        <div className="kindbar" role="radiogroup" aria-label="무엇을 만들까요">
          {KINDS.map((k) => (
            <button key={k.id} type="button" role="radio" aria-checked={kind === k.id}
              className={`pill${kind === k.id ? " on" : ""}`} onClick={() => pickKind(k.id)} title={k.note}>
              {k.id}<small>{k.w}×{k.h}mm · {k.pages}쪽</small>
            </button>
          ))}
        </div>
        <p className="note">
          자동으로 채워진 내용은 직접 수정할 수 있습니다. 여기서 설정하는 것은 기본 구성일 뿐이며,
          이후 단계에서 페이지와 내용을 자유롭게 추가하거나 변경할 수 있습니다.
        </p>

        <form className="upload" onSubmit={(e) => { e.preventDefault(); void make("blank"); }}>
          <label>자주 쓰는 판형
            <select value={size} onChange={(e) => pickSize(e.target.value)}>
              <option value={CUSTOM}>{CUSTOM}</option>
              {FORMATS.map((g) => (
                <optgroup key={g.name} label={g.name}>
                  {g.items.map((f) => <option key={f.label} value={f.label}>{f.label}</option>)}
                </optgroup>
              ))}
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
          <label title="자를 때 가장자리에 흰 줄이 남지 않게, 바깥으로 조금 더 그려 두는 여유입니다">도련(mm)
            <input type="number" min={0} max={20} value={bleed} onChange={(e) => setBleed(+e.target.value)} />
          </label>
          <label title="본문을 나란히 몇 칸으로 나눌지 정합니다. 잡지·신문은 보통 두 칸 이상입니다">단
            <input type="number" min={1} max={10} value={columns} onChange={(e) => setColumns(+e.target.value)} />
          </label>
          <label>단 사이(mm)
            <input type="number" min={0} max={50} value={gutter} onChange={(e) => setGutter(+e.target.value)} />
          </label>
          <label className="chk" title="켜면 두 쪽이 나란히 붙습니다(책·잡지). 끄면 한 장씩 따로입니다(전단·포스터)">
            <input type="checkbox" checked={facing} onChange={(e) => setFacing(e.target.checked)} /> 두 쪽씩 나란히(책처럼)
          </label>
        </form>

        <div className="dc_head dc_head_gap">
          <button type="button" className="pill on" disabled={busy || off} onClick={() => void make("blank")}>
            {busy && !made ? "만드는 중…" : made ? "새로 만들기" : `${kind} 만들기`}
          </button>
          <button type="button" className="pill" disabled={busy || off} onClick={() => void make("sample")}>
            미리 만들어 둔 샘플로 시작
          </button>
          {made && <span className="note">새로 만들면 지금 문서는 그대로 두고 빈 문서가 하나 더 생깁니다.</span>}
        </div>
        {err && !made && <p className="warn">{err}</p>}
      </section>

      {/* 2. 무엇을 넣을까 — 적어서 부탁하는 칸 하나다 */}
      {made && (
        <section className="panel dc_run">
          <div className="dc_head">
            <strong>2. 무엇을 넣을까요</strong>
            <span className="chip">쪽<b>{pageCount}</b></span>
            <span className="chip">넣은 것<b>{state?.items ?? 0}</b></span>
            {busy && <span className="spinner" aria-hidden="true" />}
            <button type="button" className="pill" disabled={busy || !state?.can_undo} onClick={() => void undo()}
              title={state?.can_undo ? "한 걸음 전으로" : "되돌릴 것이 없습니다"}>한 걸음 되돌리기</button>
          </div>

          <label className="wide askbox">넣고 싶은 것을 적어 주세요
            <textarea className="dc_ta" rows={3} value={ask} onChange={(e) => setAsk(e.target.value)}
              placeholder="예) 맨 위에 큰 제목 ‘가을 공연 안내’, 그 아래 날짜와 장소, 아래쪽에 사진 자리 하나" />
          </label>
          <div className="dc_head">
            <button type="button" className="pill on" disabled={busy || !ask.trim()} onClick={() => void compose()}>
              {busy ? "생각하는 중…" : "이렇게 만들어 줘"}
            </button>
            {EXAMPLES.map((x, i) => (
              <button key={i} type="button" className="pill" onClick={() => setAsk(x)} title="눌러서 넣어 보기">보기 {i + 1}</button>
            ))}
          </div>

          {/* 사진만 따로 올린다. 브라우저의 사진은 에이전트 PC에 없어 글만으로는 닿지 않는다. */}
          <div className="filepick picpick">
            <span className="fp_title" id="pic_l">넣을 사진이 있으면 먼저 올려 주세요 (없으면 그냥 두세요)</span>
            <input id="pic" aria-labelledby="pic_l" type="file" disabled={busy}
              accept=".png,.jpg,.jpeg,.tif,.tiff,.pdf,.eps,.ai,.svg,.psd"
              onChange={(e) => { void addPic(e.target.files?.[0] ?? null); e.target.value = ""; }} />
            {pics.length > 0 && (
              <span className="note">
                올린 사진: {pics.map((p, i) => <b key={i}>{i > 0 ? ", " : ""}{p}</b>)} — 이제{" "}
                <b>“왼쪽 위에 그 사진”</b>처럼 적으면 그 자리에 넣어 드립니다.
              </span>
            )}
          </div>

          {/* 짠 계획을 먼저 보여 준다. LLM이 틀릴 수 있으니 사람이 보고 누르는 틈을 둔다. */}
          {plan && plan.available === false && (
            <p className="warn">
              <b>글로 적어 부탁하는 기능이 꺼져 있습니다.</b> {plan.reason} 에이전트를 돌리는 쪽에서{" "}
              <code>GEMINI_API_KEY</code>를 넣고 다시 켜면 됩니다.
            </p>
          )}
          {plan?.commands?.length ? (
            <div className="planbox">
              <div className="dc_kv">
                <strong>이렇게 만들까요?</strong>
                <span className="chip">{plan.commands.length}가지</span>
              </div>
              {plan.says && <p className="note">{plan.says}</p>}
              <ol className="dc_steps">
                {plan.commands.map((c, i) => <li key={i}><code>{c.command}</code> {describe(c)}</li>)}
              </ol>
              {plan.dropped.length > 0 && (
                <p className="note">
                  여기 빠진 <b>{plan.dropped.join(", ")}</b>는 글로 적어 부탁할 때는 쓰지 않아서 빼 두었습니다.
                  {plan.dropped.includes("file.place") && " 사진을 넣으시려면 위에서 먼저 사진을 올려 주세요."}
                </p>
              )}
              <div className="dc_head dc_head_gap">
                <button type="button" className="pill on" disabled={busy}
                  onClick={() => void apply(plan.commands, plan.says || "적어서 부탁한 것을 넣었습니다")}>이대로 넣기</button>
                <button type="button" className="pill" disabled={busy} onClick={() => setPlan(null)}>그만두기</button>
                <span className="note">넣는 도중 하나라도 안 되면 <b>아무것도 저장되지 않습니다.</b></span>
              </div>
            </div>
          ) : null}

          {err && <p className="warn">{err}</p>}

          {preview && (
            <>
              {shots.length > 1 && (
                <div className="pagebar" role="tablist" aria-label="쪽 고르기">
                  {shots.map((_, i) => (
                    <button key={i} type="button" role="tab" aria-selected={page === i + 1}
                      className={`pill${page === i + 1 ? " on" : ""}`} onClick={() => setPage(i + 1)}>{i + 1}쪽</button>
                  ))}
                  {pageCount > shots.length && <span className="note">앞 {shots.length}쪽만 그립니다(문서는 {pageCount}쪽).</span>}
                </div>
              )}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="dc_shot" src={preview} alt={`${made.filename} ${page}쪽 미리보기`} />
            </>
          )}
        </section>
      )}

      {/* 3. 다 됐으면 */}
      {made && (
        <section className="panel dc_run">
          <div className="dc_head">
            <strong>3. 다 됐으면</strong>
            <button type="button" className="pill on" onClick={() => router.push(`/?src=${encodeURIComponent(made.context_id)}`)}>
              이 문서로 인쇄 검수하기 →
            </button>
            <button type="button" className="pill" onClick={() => void dl(made.context_id, state ? "work.idml" : "new.idml", made.filename)}>인디자인 파일 받기</button>
            <button type="button" className="pill" onClick={() => void dl(made.context_id, state ? "doc.pdf" : "inspect.pdf", made.filename.replace(/\.idml$/, ".pdf"))}>PDF 받기</button>
          </div>
          <p className="note">
            검수로 넘기면 글꼴·도련·해상도·색·오탈자를 검사합니다. 고칠 것이 있으면 <b>이 문서에 반영할지 물어봅니다</b>.
            받은 인디자인 파일은 그대로 열어 이어서 작업해도 됩니다.
          </p>

          {/* DesignCraft가 실제로 한 일. 명령과 그 결과를 그대로 적는다 —
              무엇이 어떻게 만들어졌는지 보고 싶은 사람에게는 이게 제일 쓸모 있다. */}
          <h3 className="dc_sub">DesignCraft가 한 일</h3>
          <ol className="didlist">
            {did.map((d, i) => (
              <li key={i}>
                <div className="did_head"><b>{i + 1}.</b> {d.label}</div>
                {d.steps.length > 0 && (
                  <ul className="did_cmds">
                    {d.steps.map((st, k) => (
                      <li key={k}>
                        <code>{st.command}</code>
                        {st.result && <span className="note">{Object.entries(st.result).map(([a, b]) => `${a} ${String(b)}`).join(" · ")}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
          <p className="note">
            위 <code>frame.create</code>·<code>text.insert</code> 같은 것이 인디자인 엔진이 받은 명령이고,
            그 옆은 엔진이 돌려준 결과(만들어진 것의 번호)입니다. 이 문서는 이 순서로 만들어졌습니다.
          </p>

          <h3 className="dc_sub">만든 문서 검사 {(state?.preflight ?? made.preflight).length}건</h3>
          <IssueRows rows={state?.preflight ?? made.preflight} empty="문제를 찾지 못했습니다." />
          {/* 글꼴은 우리가 골라 만들었으니 없을 일이 드물다. 그래도 한글이 없는 글꼴로 짜였으면
              글자가 PDF에 안 찍히므로 같은 화면으로 알려 준다. 패키지 안내는 해당 없다. */}
          <FontNotice s={state ?? made} advise={false} />
          <p className="note">
            클로드·커서 같은 도구에서 <b>대화로 만들고 싶다면</b> 이 앱을 MCP로 연결하세요.
            연결하는 방법은 <Link href="/help">도움말</Link>에 적어 두었습니다.
          </p>
        </section>
      )}
    </main>
  );
}

/** 짠 명령 한 줄을 사람 말로. 전부 옮기지는 못하니 **눈에 띄는 값만** 추린다 —
 *  무엇이 일어날지 가늠하는 데 필요한 만큼이고, 정확한 값은 그 옆 `command`가 말한다. */
function describe(c: EngineStep): string {
  const p = c.params as Record<string, unknown>;
  const bits: string[] = [];
  if (typeof p.text === "string" && p.text) bits.push(`“${p.text.slice(0, 40)}${p.text.length > 40 ? "…" : ""}”`);
  if (typeof p.content === "string") bits.push(p.content === "text" ? "글상자" : p.content === "graphic" ? "사진 자리" : String(p.content));
  if (typeof p.shape === "string") bits.push(String(p.shape));
  if (typeof p.name === "string") bits.push(String(p.name));
  if (Array.isArray(p.rect) && p.rect.length === 4) {
    const [x0, y0, x1, y1] = (p.rect as number[]).map((v) => Math.round(v / PT));
    bits.push(`${x0},${y0}에서 ${x1 - x0}×${y1 - y0}mm`);
  }
  if (typeof p.spread === "number") bits.push(`${p.spread + 1}쪽`);
  if (typeof p.count === "number") bits.push(`${p.count}개`);
  return bits.join(" · ");
}
