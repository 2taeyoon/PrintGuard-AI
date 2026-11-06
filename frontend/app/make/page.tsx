"use client";

// 작업 만들기 — 인디자인 문서를 만드는 화면.
//
// 왜 이 화면이 있나. 검수도 수정도 '남이 만든 파일'이 있어야 시작된다. 원본이 없는 사람에게
// "인디자인에서 먼저 만들어 오세요"라고 하면 거기서 끝난다. 그래서 만드는 자리를 열어 두고,
// **만든 그 파일을 그대로 인쇄 검수로 넘긴다.**
//
// **말로 부탁하는 것이 기본이다.** 엔진이 받는 명령은 547개인데, 처음 온 사람에게 그 목록을
// 들이밀면 무엇을 눌러야 할지 모른다. 그래서 적어서 부탁하면 LLM이 계획을 짜고, 사람이 그
// 계획을 보고 누르면 엔진이 넣는다. 직접 고르는 길과 명령을 그대로 쓰는 길은 **접어 둔다** —
// 없애지는 않는다. 쓸 사람은 쓰고, 처음 온 사람은 안 보이는 쪽이 맞다.
//
// 한 번에 넣는 것은 **전부 아니면 전무**다. 하나가 실패하면 아무것도 저장되지 않는다 — 절반만
// 들어간 문서를 돌려주면 무엇이 들어갔는지 알 수 없다. 한 걸음 되돌리는 단추도 둔다.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  composeDocument, createDocument, dcFileBlob, editDocument, listCommands, mcpStatus, undoEdit, uploadAsset,
  type Composed, type EditResult, type EngineCommand, type EngineStep, type MadeDoc, type McpStatus,
} from "@/lib/agentClient";
import { CUSTOM, GROUPS as FORMATS, dims } from "@/lib/formats";
import { FontNotice, IssueRows, SetupGuide, useBlob } from "../dc-shared";
import { GsMark } from "../gs-mark";
import { SignInNote } from "../sign-in";

const PT = 72 / 25.4;           // 엔진이 쓰는 길이는 pt다. 화면은 mm로 묻는다
const pt = (mm: number) => Math.round(mm * PT * 100) / 100;
const hasHangul = (s: string) => /[ㄱ-ㆎ가-힣]/.test(s);

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

/** 직접 넣기 — 자주 쓰는 것만. 없는 것은 아래 ‘명령 직접 쓰기’에 전부 있다. */
type Field = { k: string; label: string; kind: "num" | "text" | "area" | "file" | "pick"; def?: string; of?: string[] };
type Tool = { id: string; label: string; hint: string; fields: Field[]; build: (v: Record<string, string>, asset: string | null) => EngineStep[] };

const rect = (v: Record<string, string>) => [pt(+v.x), pt(+v.y), pt(+v.x + +v.w), pt(+v.y + +v.h)];
const XYWH: Field[] = [
  { k: "page", label: "쪽", kind: "num", def: "1" },
  { k: "x", label: "왼쪽(mm)", kind: "num", def: "20" },
  { k: "y", label: "위(mm)", kind: "num", def: "20" },
  { k: "w", label: "폭(mm)", kind: "num", def: "80" },
  { k: "h", label: "높이(mm)", kind: "num", def: "40" },
];

const TOOLS: Tool[] = [
  {
    id: "text", label: "글", hint: "frame.create → type.char → text.insert",
    fields: [...XYWH, { k: "text", label: "넣을 글", kind: "area", def: "" }],
    build: (v) => {
      const steps: EngineStep[] = [
        { command: "frame.create", params: { spread: +v.page - 1, rect: rect(v), content: "text" } },
      ];
      // 기본 글꼴에는 한글이 없다. 글을 넣기 **전에** 글꼴을 세워야 그 상자만 바뀐다
      // (다 넣고 font.replace를 하면 문서의 다른 글까지 갈아 버린다 — 실측으로 확인했다).
      if (hasHangul(v.text)) steps.push({ command: "type.char", params: { attrs: { fontFamily: "Malgun Gothic" } } });
      if (v.text) steps.push({ command: "text.insert", params: { text: v.text } });
      return steps;
    },
  },
  {
    id: "image", label: "사진", hint: "file.place",
    fields: [{ k: "page", label: "쪽", kind: "num", def: "1" }, { k: "x", label: "왼쪽(mm)", kind: "num", def: "20" },
      { k: "y", label: "위(mm)", kind: "num", def: "20" }, { k: "w", label: "폭(mm)", kind: "num", def: "60" },
      { k: "file", label: "그림 파일", kind: "file" }],
    build: (v, asset) => asset
      ? [{ command: "file.place", params: { path: asset, spread: +v.page - 1, x: pt(+v.x), y: pt(+v.y), width: pt(+v.w) } }]
      : [],
  },
  {
    id: "shape", label: "도형", hint: "swatch.create → frame.create → object.fill",
    fields: [{ k: "shape", label: "모양", kind: "pick", of: ["rectangle", "ellipse", "polygon"], def: "rectangle" },
      ...XYWH, { k: "color", label: "색(#rrggbb, 비우면 테두리만)", kind: "text", def: "" }],
    build: (v) => {
      const steps: EngineStep[] = [];
      const name = `색 ${v.color}`;
      if (v.color) steps.push({ command: "swatch.create", params: { name, color: v.color } });
      steps.push({ command: "frame.create", params: { spread: +v.page - 1, rect: rect(v), shape: v.shape,
        content: "unassigned", ...(v.shape === "polygon" ? { sides: 6 } : {}) } });
      if (v.color) steps.push({ command: "object.fill", params: { swatch: name } });
      return steps;
    },
  },
  {
    id: "line", label: "선", hint: "line.create",
    fields: [{ k: "page", label: "쪽", kind: "num", def: "1" },
      { k: "x1", label: "시작 왼쪽(mm)", kind: "num", def: "20" }, { k: "y1", label: "시작 위(mm)", kind: "num", def: "60" },
      { k: "x2", label: "끝 왼쪽(mm)", kind: "num", def: "120" }, { k: "y2", label: "끝 위(mm)", kind: "num", def: "60" }],
    build: (v) => [{ command: "line.create", params: { spread: +v.page - 1, a: [pt(+v.x1), pt(+v.y1)], b: [pt(+v.x2), pt(+v.y2)] } }],
  },
  {
    id: "table", label: "표", hint: "frame.create(text) → table.insert",
    fields: [...XYWH, { k: "rows", label: "줄", kind: "num", def: "4" }, { k: "cols", label: "칸", kind: "num", def: "3" },
      { k: "head", label: "머리줄", kind: "num", def: "1" }],
    build: (v) => [
      { command: "frame.create", params: { spread: +v.page - 1, rect: rect(v), content: "text" } },
      { command: "table.insert", params: { rows: +v.rows, cols: +v.cols, headerRows: +v.head } },
    ],
  },
  {
    id: "qr", label: "QR 코드", hint: "object.qrCode",
    fields: [...XYWH, { k: "content", label: "주소나 글", kind: "text", def: "https://" }],
    build: (v) => [{ command: "object.qrCode", params: { spread: +v.page - 1, rect: rect(v), type: "url", content: v.content } }],
  },
  {
    id: "pages", label: "쪽 늘리기", hint: "layout.pages.insert",
    fields: [{ k: "count", label: "몇 쪽", kind: "num", def: "2" }],
    build: (v) => [{ command: "layout.pages.insert", params: { count: +v.count } }],
  },
  {
    id: "style", label: "글 모양 모음", hint: "style.paragraph.create",
    fields: [{ k: "name", label: "이름", kind: "text", def: "본문" }, { k: "font", label: "글꼴", kind: "text", def: "Malgun Gothic" },
      { k: "size", label: "크기(pt)", kind: "num", def: "10" }, { k: "lead", label: "줄 간격(pt)", kind: "num", def: "16" }],
    build: (v) => [{ command: "style.paragraph.create", params: { name: v.name,
      chars: { fontFamily: v.font, size: +v.size, leading: { kind: "points", value: +v.lead } } } }],
  },
];

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
  const [openSize, setOpenSize] = useState(false);

  const [made, setMade] = useState<MadeDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showPre, setShowPre] = useState(false);

  // 넣고 난 뒤의 모습. 한 번 넣을 때마다 갈린다.
  const [state, setState] = useState<EditResult | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [page, setPage] = useState(1);

  // 말로 부탁하기
  const [ask, setAsk] = useState("");
  const [plan, setPlan] = useState<Composed | null>(null);

  // 직접 넣기 / 명령 직접 쓰기(둘 다 접어 둔다)
  const [openTools, setOpenTools] = useState(false);
  const [openRaw, setOpenRaw] = useState(false);
  const [tool, setTool] = useState("text");
  const [val, setVal] = useState<Record<string, string>>({});
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [cmds, setCmds] = useState<EngineCommand[] | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<EngineCommand | null>(null);
  const [json, setJson] = useState("{}");

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

  // 명령표는 펼쳐 볼 때 한 번만 받는다(547개라 미리 받아 둘 이유가 없다).
  useEffect(() => {
    if (!openRaw || cmds) return;
    let alive = true;
    listCommands().then((r) => { if (alive) setCmds(r.commands); }).catch(() => { if (alive) setCmds([]); });
    return () => { alive = false; };
  }, [openRaw, cmds]);

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
    setBusy(true); setErr(""); setMade(null); setState(null); setLog([]); setPage(1); setPlan(null);
    try {
      const m = await createDocument(start === "sample"
        ? { start: "sample" }
        : { start: "blank", width_mm: w, height_mm: h, pages, facing, columns,
          gutter_mm: gutter, margin_mm: margin, bleed_mm: bleed, text: "" });
      setMade(m);
      setLog([start === "sample" ? "미리 만들어 둔 샘플로 시작했습니다" : `${m.pages}쪽 ${m.width_mm}×${m.height_mm}mm 문서를 만들었습니다`]);
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
        setLog((l) => [...l, label]);
        setPage((p) => Math.min(p, Math.max(1, r.shots.length)));
        setPlan(null);
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
      if (r.available && r.commands.length === 0) setErr(r.reason ?? "조금 더 자세히 적어 주세요. 지금 내용만으로는 무엇을 넣을지 알 수 없습니다.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function runTool() {
    const t = TOOLS.find((x) => x.id === tool);
    if (!t || !made) return;
    const v: Record<string, string> = {};
    for (const f of t.fields) v[f.k] = val[`${t.id}.${f.k}`] ?? f.def ?? "";
    let asset: string | null = null;
    if (t.fields.some((f) => f.kind === "file")) {
      if (!pickedFile) { setErr("넣을 그림을 먼저 고르세요."); return; }
      setBusy(true);
      try {
        asset = (await uploadAsset(made.context_id, pickedFile)).path;
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e)); setBusy(false); return;
      }
      setBusy(false);
    }
    await apply(t.build(v, asset), `${t.label}을 넣었습니다`);
  }

  async function runRaw() {
    if (!picked || !made) return;
    let params: Record<string, unknown>;
    try {
      const p: unknown = JSON.parse(json || "{}");
      if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("{ … } 모양이어야 합니다");
      params = p as Record<string, unknown>;
    } catch (e) {
      setErr(`값을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    await apply([{ command: picked.id, params }], `${picked.label || picked.id}을 실행했습니다`);
  }

  async function undo() {
    if (!made) return;
    setBusy(true); setErr("");
    try {
      setState(await undoEdit(made.context_id));
      setLog((l) => [...l, "한 걸음 되돌렸습니다"]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  const hits = useMemo(() => {
    if (!cmds) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return cmds.slice(0, 40);
    return cmds.filter((c) => `${c.id} ${c.label} ${c.menu.join(" ")}`.toLowerCase().includes(needle)).slice(0, 60);
  }, [cmds, q]);

  const cur = TOOLS.find((x) => x.id === tool) ?? TOOLS[0];
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

        <button type="button" className="gs_toggle" onClick={() => setOpenSize((o) => !o)} aria-expanded={openSize}>
          <GsMark open={openSize} /> 크기·쪽수 직접 정하기
        </button>
        {openSize && (
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
        )}

        <div className="dc_head">
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

      {/* 2. 무엇을 넣을까 */}
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

          {/* 짠 계획을 먼저 보여 준다. LLM이 틀릴 수 있으니 사람이 보고 누르는 틈을 둔다. */}
          {plan && plan.available === false && (
            <p className="warn">
              <b>글로 적어 부탁하는 기능이 꺼져 있습니다.</b> {plan.reason} 아래 <b>‘직접 넣기’</b>로는 그대로 만들 수 있습니다.
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
                  아래 <b>‘명령 직접 쓰기’</b>에서 쓸 수 있습니다.
                </p>
              )}
              <div className="dc_head">
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

          {log.length > 1 && (
            <>
              <h3 className="dc_sub">지금까지 한 일</h3>
              <ol className="dc_steps">{log.map((l, i) => <li key={i}>{l}</li>)}</ol>
            </>
          )}

          {/* 손으로 자리를 잡고 싶을 때 */}
          <button type="button" className="gs_toggle" onClick={() => setOpenTools((o) => !o)} aria-expanded={openTools}>
            <GsMark open={openTools} /> 직접 넣기 — 자리와 크기를 숫자로 정하기
          </button>
          {openTools && (
            <>
              <div className="modebar" role="tablist" aria-label="직접 넣기">
                {TOOLS.map((t) => (
                  <button key={t.id} type="button" role="tab" aria-selected={tool === t.id}
                    className={`pill${tool === t.id ? " on" : ""}`} onClick={() => { setTool(t.id); setErr(""); }}>
                    {t.label}
                  </button>
                ))}
              </div>
              <form className="upload" onSubmit={(e) => { e.preventDefault(); void runTool(); }}>
                {cur.fields.map((f) => {
                  const key = `${cur.id}.${f.k}`;
                  const v = val[key] ?? f.def ?? "";
                  const set = (x: string) => setVal((o) => ({ ...o, [key]: x }));
                  if (f.kind === "file") {
                    return (
                      <div className="filepick" key={key}>
                        <span className="fp_title" id={`${key}_l`}>{f.label}</span>
                        <input id={key} aria-labelledby={`${key}_l`} type="file"
                          accept=".png,.jpg,.jpeg,.tif,.tiff,.pdf,.eps,.ai,.svg,.psd"
                          onChange={(e) => setPickedFile(e.target.files?.[0] ?? null)} />
                      </div>
                    );
                  }
                  if (f.kind === "pick") {
                    return (
                      <label key={key}>{f.label}
                        <select value={v} onChange={(e) => set(e.target.value)}>
                          {(f.of ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      </label>
                    );
                  }
                  if (f.kind === "area") {
                    return (
                      <label className="wide" key={key}>{f.label}
                        <textarea className="dc_ta" rows={3} value={v} onChange={(e) => set(e.target.value)}
                          placeholder={"줄을 바꾸면 문단이 나뉩니다."} />
                      </label>
                    );
                  }
                  return (
                    <label key={key}>{f.label}
                      <input type={f.kind === "num" ? "number" : "text"} value={v} onChange={(e) => set(e.target.value)} />
                    </label>
                  );
                })}
              </form>
              <div className="dc_head">
                <button type="button" className="pill on" disabled={busy} onClick={() => void runTool()}>{cur.label} 넣기</button>
                <span className="note">
                  자리는 <b>그 쪽의 왼쪽 위 모서리부터 mm로</b> 잽니다.
                  {facing && " 이 문서는 두 쪽이 나란히 놓이는 형태라, 오른쪽 쪽에 놓으려면 왼쪽 값에 쪽 가로 폭을 더하세요."}
                </span>
              </div>
            </>
          )}

          {/* 엔진이 할 수 있는 나머지 전부 */}
          <button type="button" className="gs_toggle" onClick={() => setOpenRaw((o) => !o)} aria-expanded={openRaw}>
            <GsMark open={openRaw} /> 명령 직접 쓰기 — 인디자인이 하는 일 전부{cmds ? ` (${cmds.length}가지)` : ""}
          </button>
          {openRaw && (
            <>
              <p className="note">
                위에 없는 기능은 여기에 다 있습니다. 표 꾸미기, 목차, 쪽 번호, 데이터 병합, XML, 여러 문서를 책 하나로
                엮기까지 됩니다. <b>인디자인을 다뤄 보신 분을 위한 자리</b>입니다.
                값 설명은 인디자인이 주는 설명을 그대로 옮겼습니다.
              </p>
              <div className="dc_row">
                <label className="wide">찾기
                  <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
                    placeholder="예: table, toc, style, page, qr, place, swatch" />
                </label>
              </div>
              <div className="cmdlist">
                {hits.map((c) => (
                  <button key={c.id} type="button" className={`pill${picked?.id === c.id ? " on" : ""}`}
                    onClick={() => { setPicked(c); setJson("{}"); setErr(""); }} title={c.menu.join(" › ")}>
                    <code>{c.id}</code><small>{c.label}</small>
                  </button>
                ))}
                {cmds && hits.length === 0 && <span className="note">찾는 말과 맞는 항목이 없습니다.</span>}
                {!cmds && <span className="note">목록을 불러오는 중…</span>}
              </div>
              {picked && (
                <div className="cmdrun">
                  <div className="dc_kv">
                    <span className="chip"><code>{picked.id}</code></span>
                    <span className="chip">{picked.label}</span>
                    {picked.menu.length > 0 && <span className="note">{picked.menu.join(" › ")}</span>}
                  </div>
                  <p className="note cmdparams">{picked.params || "값이 없습니다."}</p>
                  <label className="wide">값(JSON)
                    <textarea className="dc_ta" rows={4} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
                  </label>
                  <div className="dc_head">
                    <button type="button" className="pill on" disabled={busy} onClick={() => void runRaw()}>실행</button>
                    <span className="note">길이는 pt입니다(1mm = 2.835pt). <code>spread</code>는 0부터 셉니다.</span>
                  </div>
                </div>
              )}
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
          <button type="button" className="gs_toggle" onClick={() => setShowPre((o) => !o)} aria-expanded={showPre}>
            <GsMark open={showPre} /> 만든 문서 검사 {(state?.preflight ?? made.preflight).length}건
          </button>
          {showPre && <IssueRows rows={state?.preflight ?? made.preflight} empty="문제를 찾지 못했습니다." />}
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
