"use client";

// 작업 만들기 — DesignCraft(인디자인 엔진)로 **인쇄물을 만드는** 화면.
//
// 왜 이 화면이 있나. 검수도 수정도 '남이 만든 파일'이 있어야 시작된다. 원본이 아예 없는 사람에게
// "인디자인에서 먼저 만들어 오세요"라고 하면 거기서 끝난다. 그래서 만드는 자리를 열어 두고,
// **만든 그 파일을 그대로 인쇄 검수로 넘긴다.**
//
// **판형만 잡아 주는 화면이 아니다.** 엔진은 547개 명령을 받는다 — 글상자·사진·도형·선·표·쪽·
// 스타일·색·목차·QR·XML·데이터 병합까지. 우리가 그중 몇 개를 코드로 감싸면 감싼 것만 할 수 있는
// 앱이 되므로, **명령표를 그대로 펼쳐 두고** 고른 명령을 그대로 얹는다. 자주 쓰는 몇 가지를
// '빠른 도구'로 미리 묶어 둔 것뿐이고, 없는 것은 '모든 명령'에서 찾으면 된다.
//
// 한 단계는 **전부 아니면 전무**다. 명령 하나가 실패하면 아무것도 저장되지 않는다 — 절반만 들어간
// 문서를 돌려주면 무엇이 들어갔는지 알 수 없다. 바로 앞 단계로 되돌리는 단추도 둔다.
//
// (전에 이 자리에 있던 '원본 수정'은 인쇄 검수 안으로 들어갔다 — 편집 파일로 검수를 맡기면
//  검수가 끝난 자리에서 바로 "원본에 반영할까요?"를 묻는다.)

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createDocument, dcFileBlob, editDocument, listCommands, mcpStatus, undoEdit, uploadAsset,
  type EditResult, type EngineCommand, type EngineStep, type MadeDoc, type McpStatus,
} from "@/lib/agentClient";
import { CUSTOM, GROUPS as FORMATS, dims } from "@/lib/formats";
import { DirectConnect, FontNotice, IssueRows, SetupGuide, useBlob } from "../dc-shared";
import { GsMark } from "../gs-mark";
import { SignInNote } from "../sign-in";

const PT = 72 / 25.4;           // 엔진의 길이는 전부 pt다. 화면은 mm로 묻는다
const pt = (mm: number) => Math.round(mm * PT * 100) / 100;
const hasHangul = (s: string) => /[ㄱ-ㆎ가-힣]/.test(s);

/** 무엇을 만드나. **판형 하나가 아니라 묶음**이다 — 명함은 앞뒤 2쪽 낱장이고 책은 16쪽 펼침면이다.
 *  고르면 아래 칸이 한꺼번에 채워진다. 손으로 고쳐도 된다. */
type Kind = {
  id: string; w: number; h: number; pages: number; facing: boolean;
  margin: number; bleed: number; columns: number; gutter: number; note: string;
};
const KINDS: Kind[] = [
  { id: "명함", w: 90, h: 50, pages: 2, facing: false, margin: 5, bleed: 2, columns: 1, gutter: 0, note: "앞뒤 2쪽, 도련 2mm" },
  { id: "엽서·카드", w: 148, h: 100, pages: 2, facing: false, margin: 8, bleed: 3, columns: 1, gutter: 0, note: "앞뒤 2쪽" },
  { id: "전단", w: 210, h: 297, pages: 1, facing: false, margin: 10, bleed: 3, columns: 1, gutter: 0, note: "A4 낱장" },
  { id: "포스터", w: 420, h: 594, pages: 1, facing: false, margin: 15, bleed: 3, columns: 1, gutter: 0, note: "A2 낱장" },
  { id: "3단 리플릿", w: 297, h: 210, pages: 2, facing: false, margin: 8, bleed: 3, columns: 3, gutter: 0, note: "A4 가로 3단, 앞뒤" },
  { id: "책·소설", w: 152, h: 225, pages: 16, facing: true, margin: 18, bleed: 3, columns: 1, gutter: 0, note: "신국판 16쪽 펼침면" },
  { id: "잡지", w: 210, h: 297, pages: 8, facing: true, margin: 15, bleed: 3, columns: 2, gutter: 5, note: "국배판 8쪽 2단" },
  { id: "카탈로그", w: 210, h: 297, pages: 12, facing: true, margin: 12, bleed: 3, columns: 2, gutter: 5, note: "A4 12쪽 펼침면" },
  { id: "스티커", w: 50, h: 50, pages: 1, facing: false, margin: 3, bleed: 2, columns: 1, gutter: 0, note: "정사각 낱장" },
  { id: "메뉴판", w: 210, h: 420, pages: 2, facing: false, margin: 12, bleed: 3, columns: 1, gutter: 0, note: "길쭉한 판, 앞뒤" },
];

/** 빠른 도구 하나. `build`가 엔진 명령을 만든다 — 어떤 명령으로 가는지 화면에 그대로 적는다. */
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
    id: "text", label: "글상자", hint: "frame.create → type.char → text.insert",
    fields: [...XYWH, { k: "text", label: "글", kind: "area", def: "" }],
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
    id: "pages", label: "쪽 추가", hint: "layout.pages.insert",
    fields: [{ k: "count", label: "몇 쪽", kind: "num", def: "2" }],
    build: (v) => [{ command: "layout.pages.insert", params: { count: +v.count } }],
  },
  {
    id: "style", label: "문단 스타일", hint: "style.paragraph.create",
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

  const [kind, setKind] = useState("잡지");
  const [size, setSize] = useState(CUSTOM);
  const [w, setW] = useState(210);
  const [h, setH] = useState(297);
  const [pages, setPages] = useState(8);
  const [facing, setFacing] = useState(true);
  const [columns, setColumns] = useState(2);
  const [gutter, setGutter] = useState(5);
  const [margin, setMargin] = useState(15);
  const [bleed, setBleed] = useState(3);

  const [made, setMade] = useState<MadeDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showPre, setShowPre] = useState(false);

  // 만든 뒤의 모습. 한 단계 얹을 때마다 갈린다.
  const [state, setState] = useState<EditResult | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [page, setPage] = useState(1);

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
  const recheck = () => { setMcpBusy(true); void check(); };

  // 명령표는 한 번만 받는다(서버도 들고 있다). 547개라 검색은 브라우저에서 한다.
  useEffect(() => {
    if (!made || cmds) return;
    let alive = true;
    listCommands().then((r) => { if (alive) setCmds(r.commands); }).catch(() => { if (alive) setCmds([]); });
    return () => { alive = false; };
  }, [made, cmds]);

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
    setBusy(true); setErr(""); setMade(null); setState(null); setLog([]); setPage(1);
    try {
      const m = await createDocument(start === "sample"
        ? { start: "sample" }
        : { start: "blank", width_mm: w, height_mm: h, pages, facing, columns,
          gutter_mm: gutter, margin_mm: margin, bleed_mm: bleed, text: "" });
      setMade(m);
      setLog([start === "sample" ? "짜인 샘플로 시작" : `빈 문서로 시작 — ${m.pages}쪽 ${m.width_mm}×${m.height_mm}mm`]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  /** 한 단계를 얹는다. 실패하면 **아무것도 저장되지 않는다** — 그 말을 그대로 적는다. */
  async function apply(steps: EngineStep[], label: string) {
    if (!made || !steps.length) return;
    setBusy(true); setErr("");
    try {
      const r = await editDocument(made.context_id, steps);
      setState(r);
      if (r.ok) {
        setLog((l) => [...l, `${label} — ${steps.map((s) => s.command).join(", ")}`]);
        setPage((p) => Math.min(p, Math.max(1, r.shots.length)));
      } else {
        setErr(`${r.failed?.command}에서 멈췄습니다: ${r.failed?.reason} — 아무것도 저장하지 않았습니다.`);
      }
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
    await apply(t.build(v, asset), t.label);
  }

  async function runRaw() {
    if (!picked || !made) return;
    let params: Record<string, unknown>;
    try {
      const p: unknown = JSON.parse(json || "{}");
      if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("묶음({ … }) 모양이어야 합니다");
      params = p as Record<string, unknown>;
    } catch (e) {
      setErr(`인자를 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    await apply([{ command: picked.id, params }], picked.label || picked.id);
  }

  async function undo() {
    if (!made) return;
    setBusy(true); setErr("");
    try {
      setState(await undoEdit(made.context_id));
      setLog((l) => [...l, "바로 앞 단계로 되돌림"]);
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

  return (
    <main className="common_wrap">
      <div className="page_head">
        <h1>작업 만들기</h1>
        <p className="lead">
          인디자인 엔진(DesignCraft)으로 인쇄물을 만듭니다. 명함·전단·포스터·책·잡지·카탈로그 —{" "}
          <b>판형만 잡아 주는 화면이 아닙니다.</b> 글상자·사진·도형·표·스타일·색·QR까지 엔진이 받는{" "}
          <b>547개 명령</b>이 그대로 열려 있습니다. 만든 파일은 그대로{" "}
          <Link href="/">인쇄 검수</Link>로 넘어갑니다.
        </p>
        <p className="cantfix">
          <span className="nobadge">끌어 놓는 화면은 아닙니다</span>
          마우스로 집어 옮기는 대신 <b>숫자와 명령으로</b> 만듭니다 — 엔진이 창 없이 도는 방식이라 그렇습니다.
          한 단계마다 쪽 그림과 검사 결과를 보여 드리고, 바로 앞 단계로 되돌릴 수 있습니다.
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
          <div className="dc_kv">
            <span className="chip">서버<b>{mcp.server} {mcp.server_version}</b></span>
            <span className="chip">CLI<b>{mcp.version}</b></span>
            <span className="chip">프로토콜<b>{mcp.protocol}</b></span>
            <span className="chip">방식<b>{mcp.mode === "headless" ? "헤드리스(창 없음)" : mcp.mode}</b></span>
            <span className="chip">도구<b>{mcp.tools?.length ?? 0}</b></span>
          </div>
        )}
      </section>

      {/* 2. 무엇을 만드나 */}
      <section className="panel dc_src">
        <div className="dc_head"><strong>2. 무엇을 만드나요</strong>{made && <span className="chip">시작했습니다</span>}</div>
        <p className="note">
          고르면 아래 칸이 한꺼번에 채워집니다 — <b>판형 하나가 아니라 묶음</b>입니다(명함은 앞뒤 2쪽 낱장,
          책은 16쪽 펼침면). 손으로 고쳐도 됩니다. 여기서 정하는 것은 <b>시작하는 모양</b>일 뿐이고,
          쪽과 내용은 다음 칸에서 얼마든지 더 넣습니다.
        </p>
        <div className="kindbar" role="radiogroup" aria-label="무엇을 만드나">
          {KINDS.map((k) => (
            <button key={k.id} type="button" role="radio" aria-checked={kind === k.id}
              className={`pill${kind === k.id ? " on" : ""}`} onClick={() => pickKind(k.id)} title={k.note}>
              {k.id}<small>{k.w}×{k.h} · {k.pages}쪽</small>
            </button>
          ))}
        </div>

        <form className="upload" onSubmit={(e) => { e.preventDefault(); void make("blank"); }}>
          <label>판형 목록에서
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
        </form>

        <div className="dc_head">
          <button type="button" className="pill on" disabled={busy || !mcp?.available} onClick={() => void make("blank")}>
            {busy && !made ? "만드는 중…" : made ? "새로 시작하기" : "이 모양으로 시작"}
          </button>
          <button type="button" className="pill" disabled={busy || !mcp?.available} onClick={() => void make("sample")}>
            짜인 샘플로 시작
          </button>
          {!mcp?.available && <span className="note">DesignCraft에 연결된 뒤에 만들 수 있습니다.</span>}
          {made && <span className="note">새로 시작하면 지금 문서는 그대로 두고 빈 문서가 하나 더 생깁니다.</span>}
        </div>
        {err && !made && <p className="warn">{err}</p>}
      </section>

      {/* 3. 만들기 */}
      {made && (
        <section className="panel dc_run">
          <div className="dc_head">
            <strong>3. 만들기</strong>
            <span className="chip">{made.filename}</span>
            <span className="chip">쪽<b>{pageCount}</b></span>
            <span className="chip">넣은 것<b>{state?.items ?? 0}</b></span>
            <span className="chip">글 덩어리<b>{state?.stories ?? made.stories.length}</b></span>
            {busy && <span className="spinner" aria-hidden="true" />}
            <button type="button" className="pill" disabled={busy || !state?.can_undo} onClick={() => void undo()}
              title={state?.can_undo ? "바로 앞 단계로" : "되돌릴 단계가 없습니다"}>되돌리기</button>
          </div>

          <div className="modebar" role="tablist" aria-label="빠른 도구">
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
                      placeholder={"줄을 바꾸면 문단이 나뉩니다.\n한글을 쓰면 글꼴을 맑은 고딕으로 맞춰 넣습니다."} />
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
            <span className="note">엔진 명령: <code>{cur.hint}</code></span>
          </div>
          <p className="note">
            자리는 <b>펼침면의 왼쪽 위에서 mm로</b> 잽니다. 마주보는 쪽에서는 한 펼침면에 두 쪽이 나란히
            붙으므로, 오른쪽 쪽에 놓으려면 왼쪽 값에 <b>쪽 가로 폭을 더하세요</b>.
          </p>

          {/* 모든 명령 — 빠른 도구에 없는 것은 여기서 */}
          <h3 className="dc_sub">모든 명령 {cmds ? `${cmds.length}개` : "(불러오는 중…)"}</h3>
          <p className="note">
            빠른 도구에 없는 것은 전부 여기 있습니다 — 표 꾸미기, 목차, 쪽 번호, 데이터 병합, XML, 책 묶기까지.
            <b> 인자 설명은 엔진이 적어 준 글을 그대로</b> 보여 드립니다(547개를 우리가 번역해 두면 엔진이 바뀔 때 거짓이 됩니다).
          </p>
          <div className="dc_row">
            <label className="wide">명령 찾기
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
            {cmds && hits.length === 0 && <span className="note">찾는 말과 맞는 명령이 없습니다.</span>}
          </div>
          {picked && (
            <div className="cmdrun">
              <div className="dc_kv">
                <span className="chip"><code>{picked.id}</code></span>
                <span className="chip">{picked.label}</span>
                {picked.menu.length > 0 && <span className="note">{picked.menu.join(" › ")}</span>}
              </div>
              <p className="note cmdparams">{picked.params || "인자가 없습니다."}</p>
              <label className="wide">인자(JSON)
                <textarea className="dc_ta" rows={4} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
              </label>
              <div className="dc_head">
                <button type="button" className="pill on" disabled={busy} onClick={() => void runRaw()}>이 명령 실행</button>
                <span className="note">길이는 <b>pt</b>입니다(1mm = 2.835pt). 펼침면은 <code>spread</code>로 <b>0부터</b> 셉니다.</span>
              </div>
            </div>
          )}

          {err && <p className="warn">{err}</p>}

          {log.length > 0 && (
            <>
              <h3 className="dc_sub">한 단계씩 한 일 {log.length}개</h3>
              <ol className="dc_steps">{log.map((l, i) => <li key={i}>{l}</li>)}</ol>
            </>
          )}
        </section>
      )}

      {/* 4. 만든 문서 */}
      {made && (
        <section className="panel dc_run">
          <div className="dc_head">
            <strong>4. 만든 문서</strong>
            <button type="button" className="pill on" onClick={() => router.push(`/?src=${encodeURIComponent(made.context_id)}`)}>
              이 문서로 인쇄 검수하기 →
            </button>
            <button type="button" className="pill" onClick={() => void dl(made.context_id, state ? "work.idml" : "new.idml", made.filename)}>IDML 받기</button>
            <button type="button" className="pill" onClick={() => void dl(made.context_id, state ? "doc.pdf" : "inspect.pdf", made.filename.replace(/\.idml$/, ".pdf"))}>PDF 받기</button>
          </div>
          <p className="note">
            검수로 넘기면 에이전트들이 이 문서를 그대로 받아 검사하고, 고칠 것이 있으면 <b>원본에 반영할지 물어봅니다</b>.
            편집 파일로 맡기는 길이라 고치는 데까지 한 번에 갑니다. 받은 IDML은 인디자인에서 이어 작업하시면 됩니다.
          </p>

          {shots.length > 1 && (
            <div className="pagebar" role="tablist" aria-label="쪽 고르기">
              {shots.map((_, i) => (
                <button key={i} type="button" role="tab" aria-selected={page === i + 1}
                  className={`pill${page === i + 1 ? " on" : ""}`} onClick={() => setPage(i + 1)}>{i + 1}쪽</button>
              ))}
              {pageCount > shots.length && <span className="note">앞 {shots.length}쪽만 그립니다(문서는 {pageCount}쪽).</span>}
            </div>
          )}
          {preview && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="dc_shot" src={preview} alt={`${made.filename} ${page}쪽 미리보기`} />
          )}

          <button type="button" className="gs_toggle" onClick={() => setShowPre((o) => !o)} aria-expanded={showPre}>
            <GsMark open={showPre} /> 만든 문서 검사(preflight) {(state?.preflight ?? made.preflight).length}건
          </button>
          {showPre && <IssueRows rows={state?.preflight ?? made.preflight} empty="만든 문서에서 발견된 문제가 없습니다." />}
          {/* 글꼴은 우리가 골라 만들었으니 없을 일이 드물다. 그래도 한글이 없는 글꼴로 짜였으면
              글자가 PDF에 안 찍히므로 같은 화면으로 알려 준다. 패키지 안내는 해당 없다. */}
          <FontNotice s={state ?? made} advise={false} />
        </section>
      )}
    </main>
  );
}
