"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Analysis, Issue, Sev } from "@/lib/analyze";
import type { IntentName } from "@/lib/color";
import type { Guide, Hit } from "@/lib/guide";
import { GuideBadge, GuideCard, ModelLoadingScreen } from "./guide-ui";
import { TermsPanel } from "./terms";
import { GsMark } from "./gs-mark";
import GuideSearch from "./guide-search";
import { AgentProgress, QuestionCard } from "./agent-ui";
import AgentsView, { AgentHealth } from "./agents-view";
import { FINISHES, GROUPS, loadPapers, surface, type FinishId, type Paper, type PaperDb } from "@/lib/papers";
import { CUSTOM, GROUPS as FORMATS, dims, match } from "@/lib/formats";
import { measure, type Measured } from "@/lib/pagesize";
import { assess, inputFrom, type Risk } from "@/lib/risk";
import CopyFixes from "./copy-fixes";
import { SessionBoot, SignInPanel, useSession } from "./sign-in";
import { answerJob, createJob, isLocalOrch, ORCH_BUILT, orchBuiltSnapshot, orchestratorUp, orchUrl, setOrchUrl, subscribeOrch, toScreen, waitJob, type JobView } from "@/lib/agentClient";

const LEVEL_LABEL = { check: "확인 필요", none: "해당 없음", na: "판단 불가" } as const;

const SEV_LABEL: Record<Sev, string> = { high: "인쇄 위험", medium: "수정 권장", low: "확인 필요" };
const SRC: Record<string, string> = { rule: "규칙", heuristic: "휴리스틱", proofread: "교정 에이전트" };

/** 측정한 종이 흰색 "94.9, 2.0, -6.0" → [L,a,b]. 숫자 3개가 아니거나 범위를 벗어나면 null(그때는 보정하지 않는다) */
function parseWhite(s: string): [number, number, number] | null {
  const a = s.split(/[\s,]+/).filter(Boolean).map(Number);
  if (a.length !== 3 || a.some((x) => !Number.isFinite(x)) || a[0] < 0 || a[0] > 100 || Math.abs(a[1]) > 128 || Math.abs(a[2]) > 128) return null;
  return [a[0], a[1], a[2]];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfDoc = any;

export default function HomePage() {
  return <Suspense><Home /></Suspense>;
}

function Home() {
  const sp = useSearchParams();
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [size, setSize] = useState("A5 · 국판 (148×210)");
  const [w, setW] = useState(148);
  const [h, setH] = useState(210);
  const [bleed, setBleed] = useState(3);
  const [iccFile, setIccFile] = useState<File | null>(null);
  const [intent, setIntent] = useState<IntentName>("relative");
  const [tac, setTac] = useState(300);
  const [db, setDb] = useState<PaperDb | null>(null);
  const [paperId, setPaperId] = useState("art");
  const [profileKey, setProfileKey] = useState("auto"); // auto: 종이에 연결된 프로파일
  const [brandQ, setBrandQ] = useState("");
  const [finish, setFinish] = useState<FinishId>("unknown");
  const [gsm, setGsm] = useState(150);
  const [paperColor, setPaperColor] = useState(true);
  const [whiteIn, setWhiteIn] = useState(""); // 측정한 종이 흰색 "L, a, b" (선택). 비워 두면 보정하지 않는다
  const [read, setRead] = useState<Measured | null>(null);   // 파일에서 읽은 완성 크기·도련
  const [readFail, setReadFail] = useState(false);
  const [risks, setRisks] = useState<(Risk & { hits: Hit[] })[]>([]);
  const [usedPaper, setUsedPaper] = useState<Paper | null>(null);
  const paper = db?.papers.find((p) => p.id === paperId) ?? null;
  const profKey = profileKey === "auto" ? paper?.profile : profileKey;
  const profile = profKey ? db?.profiles[profKey] : undefined;
  const brandLabel = (p: Paper) => `${p.name} · ${p.maker} · ${surface(p)}`;
  function pickPaper(id: string) {
    setPaperId(id);
    const np = db?.papers.find((p) => p.id === id);
    if (np && profileKey === "auto" && db) setTac(db.profiles[np.profile].tac);
  }
  function pickProfile(key: string) {
    setProfileKey(key);
    const k = key === "auto" ? paper?.profile : key;
    if (k && db) setTac(db.profiles[k].tac);
  }
  // 검사 방식: agent = 에이전트들이 A2A로 나눠 검사(기본), direct = 이 브라우저 안에서 바로.
  // 이 앱이 보여 주려는 것이 에이전트 협업이라 그 화면이 첫 화면이다. '바로 검사'는 `?mode=direct`로 간다.
  // 기본이 에이전트인 덕이 하나 더 있다 — 첫 화면에서 브라우저 임베딩 모델(약 130MB)을 아예 내려받지 않는다.
  // 에이전트 주소. 저장해 둔 값이 있으면 그것을 쓴다(터널 주소는 켤 때마다 바뀌는데, 빌드 때 박힌 값은 재배포해야 바뀐다).
  // 저장된 값은 첫 그림을 그린 뒤에 읽는다. 처음부터 읽으면 서버가 그린 화면(저장소가 없으니 빌드 값)과
  // 브라우저가 그린 화면(저장된 값)이 달라져 hydration이 깨진다 — 주소를 한 번이라도 저장한 사람에게만 나던 오류다.
  const orch = useSyncExternalStore(subscribeOrch, orchUrl, orchBuiltSnapshot);
  const orchIn = useRef<HTMLInputElement>(null);
  const HOSTED = !isLocalOrch(orch);
  const saveOrch = (v: string) => {
    if (!setOrchUrl(v)) { setErr("에이전트 주소는 http://127.0.0.1:8700 처럼 넣어 주세요(뒤에 경로는 빼고)."); return; }
    setErr(""); setAgentUp(null);   // 주소가 바뀌면 orch가 따라 바뀌고 건강 검사가 다시 돈다
  };
  const [mode, setModeState] = useState<"direct" | "agent">(sp.get("mode") === "direct" ? "direct" : "agent");
  const [showAgents, setShowAgents] = useState(true); // '에이전트 검사'를 고르면 에이전트 탭 내용을 이 자리에 펼친다
  const setMode = (m: "direct" | "agent") => {
    setModeState(m);
    if (m === "agent") setShowAgents(true); // 누르면 에이전트 내용이 바로 보이게
    router.replace(m === "direct" ? "/?mode=direct" : "/", { scroll: false });
  };
  // 에이전트 검사는 파일을 남의 PC로 보내므로 주인이 있어야 한다. '바로 검사'는 로그인과 무관하다.
  const me = useSession().account;
  const [agentUp, setAgentUp] = useState<boolean | null>(null);
  const [agentJob, setAgentJob] = useState<JobView | null>(null);
  const pdfData = useRef<Uint8Array | null>(null);
  const [showHeat, setShowHeat] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<(Analysis & { filename: string }) | null>(null);
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<number | null>(null);
  const [guide, setGuide] = useState<Guide | null>(null);
  const [guideStatus, setGuideStatus] = useState("가이드 검색 준비 중");
  const [hits, setHits] = useState<Record<number, Hit[]>>({});
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<PdfDoc>(null);

  useEffect(() => {
    loadPapers().then(setDb).catch((e) => setErr(String(e)));
  }, []);

  // 한 번 실패했다고 꺼진 것으로 보지 않는다. 터널은 가끔 느려질 뿐인데
  // 그때마다 안내 문구가 뒤집히고 '에이전트에 맡기기' 버튼까지 잠겼다.
  const downs = useRef(0);
  useEffect(() => {
    if (mode !== "agent") return;
    let alive = true;
    downs.current = 0;
    const check = () => orchestratorUp().then((ok) => {
      if (!alive) return;
      downs.current = ok ? 0 : downs.current + 1;
      if (ok || downs.current >= 2) setAgentUp(ok);   // 두 번 연속 실패해야 꺼진 것으로 본다
    });
    check();
    const t = setInterval(check, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [mode, orch]);

  useEffect(() => {
    if (mode !== "direct") return; // 에이전트 모드에서는 가이드 검색을 guide 에이전트가 한다
    let alive = true;
    let unsub = () => {};
    import("@/lib/guide")
      .then((m) => {
        // 개발 모드에서만: 브라우저 그대로(int8 wasm) 검색 점수를 재는 평가 스크립트가 쓴다
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (process.env.NODE_ENV === "development") (window as any).__loadGuide = m.loadGuide;
        const r = m.getGuide((s) => alive && setGuideStatus(s));
        unsub = r.unsubscribe;
        return r.guide;
      })
      .then((g) => { if (alive) setGuide(g); })
      .catch(() => { /* 상태 문구로 표시됨 */ });
    return () => { alive = false; unsub(); };
  }, [mode]);

  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!res || !doc || !canvas) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    (async () => {
      const p = await doc.getPage(page);
      if (cancelled) return;
      const vp = p.getViewport({ scale: 1.6 });
      canvas.width = vp.width; canvas.height = vp.height;
      task = p.render({ canvas, viewport: vp });
      await task!.promise;
    })().catch(() => { /* 페이지를 빨리 넘기면 이전 렌더가 취소된다 */ });
    return () => { cancelled = true; task?.cancel(); };
  }, [res, page]);

  function pickSize(v: string) {
    setSize(v);
    const d = dims(v);
    if (d) { setW(d[0]); setH(d[1]); }
  }

  /** 파일을 고르면 완성 크기·도련을 그 파일에서 읽어 칸을 채운다.
   *  손으로 적던 칸이라 오타 한 번에 "페이지 크기가 설정과 다름"이 모든 쪽에 떴다. 값은 이미 파일 안에 있다.
   *  사람이 적어 둔 값도 덮어쓴다 — 대신 무엇을 어디서 읽었는지 칸 아래에 적어, 틀렸으면 되돌릴 수 있게 한다. */
  async function pickFile(f: File | null) {
    setFile(f); setRead(null); setReadFail(false);
    if (!f) return;
    const m = await measure(f);
    if (!m) { setReadFail(true); return; }   // 암호가 걸렸거나 깨진 파일. 검사 단계에서 제대로 된 오류가 난다
    setRead(m);
    setW(m.widthMm); setH(m.heightMm);
    if (m.bleedMm !== null) setBleed(m.bleedMm);
    const hit = match(m.widthMm, m.heightMm);
    // 가로로 누운 파일은 '직접 입력'으로 둔다. 목록은 세로 기준이라, A4라고 적어 두면
    // 그 줄을 다시 고르는 순간 210×297로 돌아가 모든 쪽이 크기 불일치로 뜬다.
    setSize(hit && !hit.rotated ? hit.format.label : CUSTOM);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const askPaper = mode === "agent" && paperId === "unknown"; // 에이전트가 종이 후보를 묻는다
    if (!file || ((!paper || !profile) && !askPaper)) return;
    setBusy(true); setErr(""); setRes(null); setSel(null); setPage(1); setHits({}); setAgentJob(null);
    if (mode === "agent") return runAgent(file);
    if (!paper || !profile) { setBusy(false); return; }
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      const { analyze } = await import("@/lib/analyze");
      const { ColorEngine } = await import("@/lib/color");
      let icc: Uint8Array;
      if (iccFile) {
        icc = new Uint8Array(await iccFile.arrayBuffer());
      } else {
        const r = await fetch(`/icc/${profile.file}`);
        if (!r.ok) throw new Error("이 사이트에는 ICC 프로파일이 없습니다(재배포가 허용되지 않습니다). "
          + "인쇄소에서 받은 ICC 파일을 위 ‘인쇄소 CMYK 프로파일(ICC)’에 올리거나, 에이전트 검사 모드를 쓰세요.");
        icc = new Uint8Array(await r.arrayBuffer());
      }
      const color = await ColorEngine.create(icc, { intent, tacLimit: tac, paperColor, substrateWhite: parseWhite(whiteIn) ?? undefined,
        wasmUrl: "/lcms/lcms.wasm", moduleUrl: "/lcms/lcms.js" });
      const result = await analyze(data, pdfjs, { widthMm: w, heightMm: h, bleedMm: bleed, color });
      docRef.current = await pdfjs.getDocument({ data: data.slice() }).promise;
      setRes({ ...result, filename: file.name });
      setUsedPaper(paper);
      const rs = assess(inputFrom(result, paper, finish, gsm, tac));
      setRisks(await Promise.all(rs.map(async (r) => ({ ...r, hits: guide ? await guide.search(r.query, 1) : [] }))));
      if (guide) {
        const m: Record<number, Hit[]> = {};
        for (const it of result.issues) m[it.id] = await guide.search(`${it.title}. ${it.detail}`, 2);
        setHits(m);
      }
    } catch (x) {
      setErr(`분석하지 못했습니다. 암호화되었거나 손상된 PDF일 수 있습니다. (${x instanceof Error ? x.message : x})`);
    } finally { setBusy(false); }
  }


  // ---------- 에이전트 모드 ----------
  async function runAgent(f: File) {
    try {
      pdfData.current = new Uint8Array(await f.arrayBuffer());
      const opts = { width_mm: w, height_mm: h, bleed_mm: bleed, paper_id: paperId, profile: profileKey, intent, tac_limit: tac,
        paper_color: paperColor, finish, gsm,
        ...(parseWhite(whiteIn) ? { substrate_white: parseWhite(whiteIn) } : {}) };
      const { context_id } = await createJob(f, opts);
      await settle(await waitJob(context_id, setAgentJob));
    } catch (x) {
      setErr(`에이전트 검사에 실패했습니다. 에이전트가 켜져 있는지 확인하세요. (${x instanceof Error ? x.message : x})`);
      setBusy(false);
    }
  }

  async function answer(value: string) {
    if (!agentJob) return;
    setBusy(true);
    try {
      await answerJob(agentJob.context_id, value);
      await new Promise((r) => setTimeout(r, 200));
      await settle(await waitJob(agentJob.context_id, setAgentJob));
    } catch (x) {
      setErr(`답을 전달하지 못했습니다. (${x instanceof Error ? x.message : x})`);
      setBusy(false);
    }
  }

  async function settle(v: JobView) {
    if (v.status === "input-required") { setBusy(false); return; } // 질문 카드를 보여 주고 답을 기다린다
    if (v.status === "failed") { setErr("에이전트 검사가 실패했습니다. 위의 ‘소통 기록’을 확인하세요."); setBusy(false); return; }
    const { analysis, risks: rs, hits: hs } = toScreen(v);
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    docRef.current = await pdfjs.getDocument({ data: pdfData.current!.slice() }).promise;
    setRes({ ...analysis, filename: v.filename });
    const usedId = v.results.risk?.paper?.id ?? v.results.paper_choice?.paper_id ?? paperId;
    setUsedPaper(db?.papers.find((x) => x.id === usedId) ?? paper);
    setRisks(rs);
    setHits(hs);
    setBusy(false);
  }

  const count = (s: Sev) => res?.issues.filter((i) => i.severity === s).length ?? 0;
  const pageIssues = res?.issues.filter((i) => i.page === page) ?? [];
  const perPage = (p: number) => res?.issues.filter((i) => i.page === p && i.severity === "high").length ?? 0;
  const dim = res?.pageSizes[page - 1];
  const pick = (i: Issue) => { setSel(i.id); setPage(i.page); };

  return (
    <div className="common_wrap">
      <SessionBoot />
      {mode === "direct" && !guide && !guideStatus.startsWith("가이드 검색 사용 불가") && <ModelLoadingScreen status={guideStatus} />}
      <header className="page_head">
        <h1>인쇄 검수</h1>
        <p className="lead">폰트와 도련, 해상도, 색, 문구를 검사합니다. 고른 종이로 인쇄 색 차이와 불량 위험을 예측합니다. 오탈자 등은 수정 제안만 보여 줍니다. 자동으로 고치지는 않으니 원본 파일에서 직접 고치세요. {mode === "direct" ? "파일은 어디로도 보내지 않습니다." : HOSTED ? "에이전트 검사 모드에서는 PDF가 에이전트 서버로 올라갑니다." : "파일은 이 PC에서 도는 에이전트에만 보냅니다."}</p>
      </header>

      {/* 가이드 검색: 검수 전에 규격을 확인할 수 있게 맨 위에 둔다(기본은 접힘) */}
      <GuideSearch guide={guide} mode={mode} ready={!!agentUp}
        badge={mode === "direct" ? <GuideBadge ready={!!guide} status={guideStatus} />
          : <span className="badge">guide 에이전트가 찾습니다</span>} />

      <div className="modebar" role="tablist" aria-label="검사 방식">
        <button type="button" role="tab" aria-selected={mode === "agent"} className={`pill${mode === "agent" ? " on" : ""}`} onClick={() => setMode("agent")}>
          에이전트 검사 <span className="count">에이전트 협업(A2A)</span></button>
        <button type="button" role="tab" aria-selected={mode === "direct"} className={`pill${mode === "direct" ? " on" : ""}`} onClick={() => setMode("direct")}>
          바로 검사 <span className="count">브라우저 안</span></button>
        <span className="note">
          {mode === "direct" ? (HOSTED
            ? "모든 계산을 이 브라우저 안에서 합니다. 파일은 어디로도 보내지 않습니다. 다만 이 사이트에는 ICC 프로파일이 없습니다. 색 차이를 재려면 인쇄소에서 받은 ICC 파일을 아래에 올려야 합니다."
            : "모든 계산을 이 브라우저 안에서 합니다. 파일은 어디로도 보내지 않습니다.")
            : agentUp === null ? "에이전트 연결 확인 중…"
            : agentUp ? (HOSTED
              ? "에이전트가 나눠서 검사합니다. 파일은 에이전트 서버로 올라가고, 서버가 다시 뜨면 기록은 지워집니다. 아래에서 에이전트 상태와 소통 기록을 바로 볼 수 있습니다."
              : "에이전트가 나눠서 검사합니다. 파일은 이 PC의 에이전트에만 보냅니다. 아래에서 에이전트 상태와 소통 기록을 바로 볼 수 있습니다.")
            : <span className="sev-high">{HOSTED ? "에이전트가 꺼져 있습니다. 에이전트를 돌리는 PC에서 켜야 이 모드를 쓸 수 있습니다. 그동안에는 ‘바로 검사’로 검사하세요." : "에이전트가 꺼져 있습니다. 그동안에는 ‘바로 검사’로 검사하세요."}</span>}
        </span>
      </div>

      {/* 에이전트 주소: 주소는 고정이라 평소에는 숨긴다. 연결이 안 될 때만 꺼내 고칠 수 있게 보여 준다.
          (이 브라우저에만 저장하고 서버로 보내지 않는다) */}
      {mode === "agent" && agentUp === false && (
        <div className="orchbar panel">
          <label>에이전트 주소
            {/* key에 현재 주소를 걸어 두면 주소가 바뀔 때 칸이 그 값으로 다시 채워진다 */}
            <input key={orch} ref={orchIn} type="url" inputMode="url" spellCheck={false} placeholder={ORCH_BUILT} defaultValue={orch}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveOrch(e.currentTarget.value); } }} />
          </label>
          <button type="button" onClick={() => saveOrch(orchIn.current?.value ?? "")}>저장</button>
          <button type="button" className="ghost" onClick={() => saveOrch("")}>기본값</button>
          <span className="note">지금 부르는 곳 <code>{orch}</code> — {orch === ORCH_BUILT ? "기본값입니다." : "이 브라우저에 저장한 주소입니다."} 다른 곳의 에이전트를 부를 때만 고치세요. 오케스트레이터 주소만 넣습니다(뒤의 <code>/health</code> 같은 경로는 빼고).</span>
        </div>
      )}

      {/* 에이전트 검사를 고르면 '에이전트' 탭과 같은 내용(목록·의뢰 추적·소통 기록)을 이 자리에서 본다 */}
      {mode === "agent" && (
        <section className={`gsearch panel agent_inline${showAgents ? " open" : ""}`}>
          <button type="button" className="gs_toggle" aria-expanded={showAgents} onClick={() => setShowAgents((v) => !v)}>
            <b>에이전트 상태 · 의뢰 추적 · 소통 기록</b>
            <AgentHealth />
            <span className="note">누가 어떤 일을 할 수 있고(skill), 이번 의뢰를 누가 언제 얼마나 처리했는지 그대로 보여 줍니다.</span>
            <GsMark open={showAgents} />
          </button>
          {showAgents && <div className="gs_body"><AgentsView initialCtx={agentJob?.context_id ?? ""} showWarn={false} /></div>}
        </section>
      )}

      {mode === "agent" && !me && <SignInPanel what="에이전트 검사" />}

      <TermsPanel />

      <form className="upload panel" onSubmit={submit}>
        <label className="wide">검수할 파일
          <input type="file" accept="application/pdf" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
          {read && <ReadHint m={read} />}
          {readFail && <span className="note">파일에서 크기를 읽지 못했습니다. 암호가 걸렸거나 깨진 PDF일 수 있습니다. 아래 칸을 직접 채워 주세요.</span>}
        </label>
        <label>완성 크기
          <select value={size} onChange={(e) => pickSize(e.target.value)}>
            {FORMATS.map((g) => (
              <optgroup key={g.name} label={g.name}>
                {g.items.map((f) => <option key={f.label}>{f.label}</option>)}
              </optgroup>
            ))}
            <option>{CUSTOM}</option>
          </select>
        </label>
        <label>가로(mm)<input type="number" value={w} onChange={(e) => { setW(+e.target.value); setSize("직접 입력"); }} /></label>
        <label>세로(mm)<input type="number" value={h} onChange={(e) => { setH(+e.target.value); setSize("직접 입력"); }} /></label>
        <label>도련(mm)<input type="number" step="0.5" value={bleed} onChange={(e) => setBleed(+e.target.value)} /></label>
        <label>종이 종류
          {/* 브랜드를 골라도 이 칸은 그 브랜드가 속한 종류를 보여 준다. 종류를 다시 고르면 브랜드 선택은 풀린다 */}
          <select value={paper ? (paper.kind === "brand" ? paper.type : paper.id) : paperId} disabled={!db}
            onChange={(e) => { pickPaper(e.target.value); setBrandQ(""); }}>
            {mode === "agent" && <option value="unknown">모름 — 에이전트가 후보 추천</option>}
            {GROUPS.map((g) => (
              <optgroup key={g} label={g}>
                {db?.papers.filter((p) => p.kind === "type" && p.group === g).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label>브랜드 종이로 찾기 ({db ? db.papers.filter((p) => p.kind === "brand").length : 0}종, 선택)
          <span className="brandpick">
            <input list="brand-list" value={brandQ} placeholder="예: 랑데뷰, 반누보, 스타드림" disabled={!db}
              onChange={(e) => {
                setBrandQ(e.target.value);
                const hit = db?.papers.find((p) => p.kind === "brand" && brandLabel(p) === e.target.value);
                if (hit) pickPaper(hit.id);
              }} />
            {paper?.kind === "brand" && (
              <button type="button" className="ghost small" onClick={() => { pickPaper(paper.type); setBrandQ(""); }}>해제</button>
            )}
          </span>
          <datalist id="brand-list">
            {db?.papers.filter((p) => p.kind === "brand").map((p) => <option key={p.id} value={brandLabel(p)} />)}
          </datalist>
        </label>
        <label>인쇄 조건 (프로파일)
          <select value={profileKey} onChange={(e) => pickProfile(e.target.value)} disabled={!db}>
            <option value="auto">종이에 맞춤{paper && db ? ` — ${db.profiles[paper.profile].name}` : ""}</option>
            {db && Object.entries(db.profiles).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}
          </select>
        </label>
        <label className="chk" title="켜면 종이 흰색의 밝기·색조까지 색 차이에 넣습니다(절대 비색). 눈이 종이 흰색에 적응하므로 상한에 가까운 값입니다.">
          <input type="checkbox" checked={paperColor} onChange={(e) => setPaperColor(e.target.checked)} /> 종이 색 포함</label>
        <label>평량(g)<input type="number" step="10" value={gsm} onChange={(e) => setGsm(+e.target.value)} /></label>
        <label>후가공 <span className="noauto" title="후가공 정보는 PDF 파일 안에 없어 자동으로 검사하지 못합니다">PDF 자동 인식 불가 · 직접 선택</span>
          <select value={finish} onChange={(e) => setFinish(e.target.value as FinishId)}>
            {FINISHES.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <label>인쇄소 CMYK 프로파일(ICC)
          <input type="file" accept=".icc,.icm" onChange={(e) => setIccFile(e.target.files?.[0] ?? null)} title={`비워 두면 ${profile?.name ?? "선택한 종이의 프로파일"}을 씁니다`} />
        </label>
        <label>변환 방식
          <select value={intent} onChange={(e) => setIntent(e.target.value as IntentName)}>
            <option value="relative">상대 비색(로고·단색)</option>
            <option value="perceptual">지각적(사진)</option>
            <option value="saturation">채도</option>
          </select>
        </label>
        <label>총 잉크량 한도(%)<input type="number" value={tac} onChange={(e) => setTac(+e.target.value)} /></label>
        <label title="분광측색기로 잰 종이 흰색을 넣으면, 프로파일이 가정한 종이 대신 이 종이를 기준으로 삼습니다. 그 기준으로 인쇄 색을 옮겨 ΔE를 다시 잽니다. 비워 두면 보정하지 않습니다.">종이 흰색 측정값(Lab, 선택)
          <input type="text" inputMode="decimal" placeholder="예: 94.9, 2.0, -6.0" value={whiteIn} onChange={(e) => setWhiteIn(e.target.value)} disabled={!paperColor} /></label>
        <button disabled={!file || busy || (!profile && !(mode === "agent" && paperId === "unknown")) || (mode === "agent" && (!agentUp || !me))}>{busy ? "검사 중…" : mode === "agent" ? "에이전트에 맡기기" : "검사 시작"}</button>
        {paper && profile && (
          <div className="paperpick">
            <span className="chip">{paper.group}</span><span className="chip">{surface(paper)}</span>
            <b>{paper.name}</b>{paper.maker && <span className="note">{paper.maker}</span>}
            <span className="note">→ {profile.name}{profileKey === "auto" && paper.approx ? " (근사)" : ""} · 잉크량 한도 {profile.tac}% ({profile.tacSource})</span>
            {/* 근사 경고: 측정한 종이 흰색을 넣으면 그 종이 기준으로 옮겨 잰다(흰색만 보정이고 잉크 거동은 여전히 등급 프로파일 값이다) */}
            {profileKey === "auto" && paper.warn && !parseWhite(whiteIn) && <div className="warn">{paper.warn}
              {paper.approx && paperColor && <> 종이 흰색을 측정했다면 위 ‘종이 흰색 측정값’에 넣으면 그 종이 기준으로 보정합니다(참고: 프로파일 종이 흰색 Lab {profile.white.join(", ")}).</>}</div>}
            {parseWhite(whiteIn) && <div className="note">종이 흰색 보정 켜짐: 프로파일 종이 Lab {profile.white.join(", ")} → 측정값 Lab {parseWhite(whiteIn)!.join(", ")} (흰색만 옮깁니다. 잉크 거동·잉크량 한도는 프로파일 값 그대로입니다)</div>}
            {whiteIn.trim() && !parseWhite(whiteIn) && <div className="warn">종이 흰색 측정값을 읽지 못했습니다. ‘L, a, b’ 숫자 3개로 넣으세요(L 0~100, a·b ±128). 지금은 보정하지 않습니다.</div>}
          </div>
        )}
      </form>


      {mode === "agent" && agentJob && <AgentProgress job={agentJob} />}
      {mode === "agent" && agentJob?.status === "input-required" && agentJob.question && (
        <QuestionCard q={agentJob.question} busy={busy} onAnswer={answer} />
      )}
      {err && <div className="err">{err}</div>}
      {!res && !busy && !err && !agentJob && (
        <div className="empty">{mode === "direct"
          ? "검수할 파일을 고르고 ‘검사 시작’을 누르세요. 파일은 서버로 보내지 않습니다."
          : !me ? "구글로 로그인하면 ‘에이전트에 맡기기’를 쓸 수 있습니다. 로그인 없이 쓰려면 ‘바로 검사’를 고르세요."
            : HOSTED ? "검수할 파일을 고르고 ‘에이전트에 맡기기’를 누르세요. 파일은 위 주소의 에이전트로 올라갑니다."
              : "검수할 파일을 고르고 ‘에이전트에 맡기기’를 누르세요. 파일은 이 PC의 에이전트에만 보냅니다."}</div>
      )}

      {res && (
        <>
          <div className="summary">
            <strong>{res.filename} · {res.pages}쪽</strong>
            {(["high", "medium", "low"] as Sev[]).map((s) => (
              <span key={s} className="chip">{SEV_LABEL[s]}<b className={`sev-${s}`}>{count(s)}</b></span>
            ))}
            <span className="chip">RGB 이미지<b>{res.colorSummary.rgb ?? 0}</b></span>
            <label className="chip heatsw"><input type="checkbox" checked={showHeat} onChange={(e) => setShowHeat(e.target.checked)} /> 색 차이 지도(ΔE00&gt;5)</label>
            <span className="note">{mode === "agent" ? "오탈자는 교정 에이전트(규칙+Kiwi)가 제안만 합니다. 자동으로 고치지 않습니다." : "AI 문맥 교정(LLM)은 연결하지 않았습니다. 표기·수치 검사는 규칙 기반입니다."}</span>
          </div>
          <CopyFixes issues={res.issues} filename={res.filename} pages={res.pages} mode={mode} />
          {res.colorReport && (
            <div className="summary colorrep panel">
              <strong>인쇄 색 차이 ({res.colorReport.profile || "선택한 프로파일"})</strong>
              <span className="chip">RGB 이미지 면적<b>{(res.colorReport.areaShare * 100).toFixed(1)}%</b></span>
              <span className="chip">면적 가중 평균 ΔE00<b>{res.colorReport.weightedMeanDE.toFixed(1)}</b></span>
              <span className="chip">전체 면적 중 ΔE00&gt;5<b>{(res.colorReport.areaOver5 * 100).toFixed(1)}%</b></span>
              <span className="chip">ΔE00&gt;10<b>{(res.colorReport.areaOver10 * 100).toFixed(1)}%</b></span>
              <span className="chip">잉크 한도 초과<b>{(res.colorReport.areaOverTAC * 100).toFixed(1)}%</b></span>
              <span className="note">ΔE00 2 이하는 거의 같고 5를 넘으면 눈에 띄는 차이로 봅니다(경험 기준). 실제 인쇄 결과를 보장하지 않는 예측입니다.</span>
            </div>
          )}
          {risks.length > 0 && (
            <div className="risk panel">
              <strong>인쇄 불량 점검 · {usedPaper?.name}</strong>
              {usedPaper?.warn && <div className="warn">{usedPaper.warn}</div>}
              <div className="riskgrid">
                {risks.map((r) => (
                  <div key={r.id} className={`rcard lv-${r.level}`}>
                    <h4>{r.name} <span className={`sev-${r.level}`}>{LEVEL_LABEL[r.level]}</span>
                      {r.id === "indent" && <span className="noauto">후가공은 PDF로 자동 분석 불가</span>}
                      {r.id === "banding" && <span className="noauto">PDF로 예측 불가</span>}
                      {r.weak && <span className="noauto">근거 약함</span>}</h4>
                    <ul>{r.reasons.length ? r.reasons.map((t) => <li key={t}>{t}</li>) : <li>자료에서 확인한 원인 중 해당하는 것이 없습니다.</li>}</ul>
                    {r.hits[0] && <div className="gcard"><div className="gh">{r.hits[0].section.doc} › {r.hits[0].section.text.split("\n")[0]}</div></div>}
                  </div>
                ))}
              </div>
              <span className="note">위험도를 점수로 매기지 않습니다. 공개 자료에서 확인한 불량 원인이 이 파일과 이 종이에 해당하는지만 보고,
                해당하면 근거와 함께 ‘확인 필요’로 적습니다. 확률이 아니라 사람이 확인할 거리입니다.</span>
              <span className="note">후가공(접지·제본·박·형압)은 PDF에 정보가 없어 자동으로 검사하지 못합니다. 고른 값만 씁니다.</span>
            </div>
          )}
          <div className="ws">
            <div className="pages">
              {Array.from({ length: res.pages }, (_, i) => i + 1).map((p) => (
                <button key={p} className={p === page ? "on" : ""} onClick={() => setPage(p)}>
                  {p}쪽{perPage(p) > 0 && <span className="dot">{perPage(p)}</span>}
                </button>
              ))}
            </div>
            <div className="viewer">
              <div className="sheet" style={{ width: "min(100%, 620px)" }}>
                <canvas ref={canvasRef} style={{ width: "100%", display: "block" }} />
                {dim && showHeat && pageIssues.filter((i) => i.rect && i.heat).map((i) => {
                  const [x0, y0, x1, y1] = i.rect as number[];
                  return (
                    <HeatCanvas key={`h${i.id}`} heat={i.heat!}
                      style={{ left: `${(x0 / dim.w) * 100}%`, top: `${(y0 / dim.h) * 100}%`,
                        width: `${((x1 - x0) / dim.w) * 100}%`, height: `${((y1 - y0) / dim.h) * 100}%` }} />
                  );
                })}
                {dim && pageIssues.filter((i) => i.rect).map((i) => {
                  const [x0, y0, x1, y1] = i.rect as number[];
                  return (
                    <div key={i.id} className={`box ${i.severity} ${sel === i.id ? "sel" : ""}`} title={i.title} onClick={() => setSel(i.id)}
                      style={{ left: `${(x0 / dim.w) * 100}%`, top: `${(y0 / dim.h) * 100}%`,
                        width: `${((x1 - x0) / dim.w) * 100}%`, height: `${((y1 - y0) / dim.h) * 100}%` }} />
                  );
                })}
              </div>
            </div>
            <div className="list">
              {res.issues.length === 0 && <div className="empty">발견된 항목이 없습니다.</div>}
              {res.issues.map((i) => (
                <div key={i.id} className={`card ${i.severity} ${sel === i.id ? "sel" : ""}`} onClick={() => pick(i)}>
                  <h4><span className={`sev-${i.severity}`}>{SEV_LABEL[i.severity]}</span> · {i.page}쪽 · {i.title}
                    <span className="src">{SRC[i.source]}</span></h4>
                  <p>{i.detail}</p>
                  <p><b>수정 제안(직접 수정):</b> {i.fix}</p>
                  {hits[i.id]?.length ? (
                    <details className="guide" open={sel === i.id}>
                      <summary>관련 인쇄 가이드 ({hits[i.id].length})</summary>
                      {hits[i.id].map((h) => <GuideCard key={h.section.title} h={h} />)}
                    </details>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      <div className="disclaimer">
        <p>이 검수 결과는 인쇄소의 최종 승인과 사람의 교정을 대체하지 않습니다. 색상은 실제 인쇄 결과를 보장하지 않는 위험 예측입니다.</p>
        <p>계산에는 한계가 있습니다. 색 공간은 PDF 안의 정보를 읽은 값이고, 이미지 매칭은 가로·세로 픽셀 수로 합니다.
          같은 크기의 이미지가 여러 개면 틀릴 수 있습니다.</p>
      </div>
    </div>
  );
}

/** 파일에서 읽은 값을 그 자리에 적는다. 자동으로 채운 칸은 어디서 온 값인지 보여야 되돌릴 수 있다. */
function ReadHint({ m }: { m: Measured }) {
  const hit = match(m.widthMm, m.heightMm);
  const name = hit
    ? (hit.rotated ? `${hit.format.label}를 가로로 누인 크기` : hit.format.label)
    : "목록에 없는 크기 — ‘직접 입력’으로 두었습니다";
  return (
    <span className="note read_hint">
      <b>파일에서 읽음</b> {m.pages}쪽 · {m.widthMm}×{m.heightMm}mm · {name}
      {m.bleedMm !== null && <> · 도련 {m.bleedMm}mm</>}
      {m.from === "MediaBox" && <>
        {" "}— 재단선(TrimBox)이 없어 용지 크기를 그대로 넣었습니다. 도련이 섞인 값이면 완성 크기를 직접 고쳐 주세요.
      </>}
      {m.mixed && <> — 쪽마다 크기가 다릅니다. 1쪽 기준으로 채웠습니다.</>}
    </span>
  );
}

function HeatCanvas({ heat, style }: { heat: NonNullable<Issue["heat"]>; style: React.CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = heat.w; c.height = heat.h;
    c.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(heat.rgba), heat.w, heat.h), 0, 0);
  }, [heat]);
  return <canvas ref={ref} className="heat" style={style} />;
}
