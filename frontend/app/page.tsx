"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useRef, useState } from "react";
import type { Analysis, Issue, Sev } from "@/lib/analyze";
import type { IntentName } from "@/lib/color";
import type { Guide, Hit } from "@/lib/guide";
import { GuideBadge, GuideCard, ModelLoadingScreen } from "./guide-ui";
import GuideSearch from "./guide-search";
import { AgentProgress, QuestionCard } from "./agent-ui";
import AgentsView, { AgentHealth } from "./agents-view";
import { FINISHES, GROUPS, loadPapers, surface, type FinishId, type Paper, type PaperDb } from "@/lib/papers";
import { assess, inputFrom, type Risk } from "@/lib/risk";
import { answerJob, createJob, orchestratorUp, toScreen, waitJob, type JobView } from "@/lib/agentClient";

const LEVEL_LABEL = { high: "높음", medium: "중간", low: "낮음", na: "판단 불가" } as const;

const SEV_LABEL: Record<Sev, string> = { high: "인쇄 위험", medium: "수정 권장", low: "확인 필요" };
const SIZES: Record<string, [number, number]> = {
  "A5 (148×210)": [148, 210], "A4 (210×297)": [210, 297], "B5 (176×250)": [176, 250], "직접 입력": [0, 0],
};
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
  const [size, setSize] = useState("A5 (148×210)");
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
  // 검사 방식: direct = 이 브라우저 안에서 바로, agent = 로컬 에이전트들이 A2A로 나눠 검사
  // 주소의 ?mode=agent로 시작 모드를 기억한다(에이전트 모드로 열면 브라우저 임베딩 모델을 아예 불러오지 않는다)
  const [mode, setModeState] = useState<"direct" | "agent">(sp.get("mode") === "agent" ? "agent" : "direct");
  const [showAgents, setShowAgents] = useState(true); // '에이전트 검사'를 고르면 에이전트 탭 내용을 이 자리에 펼친다
  const setMode = (m: "direct" | "agent") => {
    setModeState(m);
    if (m === "agent") setShowAgents(true); // 누르면 에이전트 내용이 바로 보이게
    router.replace(m === "agent" ? "/?mode=agent" : "/", { scroll: false });
  };
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

  useEffect(() => {
    if (mode !== "agent") return;
    let alive = true;
    const check = () => orchestratorUp().then((ok) => alive && setAgentUp(ok));
    check();
    const t = setInterval(check, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [mode]);

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
    const [a, b] = SIZES[v];
    if (a) { setW(a); setH(b); }
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
      const icc = iccFile ? new Uint8Array(await iccFile.arrayBuffer())
        : new Uint8Array(await (await fetch(`/icc/${profile.file}`)).arrayBuffer());
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
      setErr(`에이전트 검사에 실패했습니다. 에이전트를 켰는지 확인하세요(agents/run_agents.py). (${x instanceof Error ? x.message : x})`);
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
      {mode === "direct" && !guide && !guideStatus.startsWith("가이드 검색 사용 불가") && <ModelLoadingScreen status={guideStatus} />}
      <header className="page_head">
        <h1>인쇄 검수</h1>
        {mode === "direct" ? <GuideBadge ready={!!guide} status={guideStatus} /> : <span className="badge">가이드 검색은 guide 에이전트가 합니다</span>}
        <p className="lead">폰트·도련·해상도·색·문구를 검사하고, 고른 종이로 인쇄 색 차이와 불량 위험을 예측합니다. 오탈자 등은 자동으로 고치지 않고 수정 제안만 보여 주니 원본 파일에서 직접 고치세요. {mode === "direct" ? "파일은 어디로도 보내지 않습니다." : "파일은 이 PC에서 도는 에이전트에만 보냅니다."}</p>
      </header>

      {/* 가이드 검색: 검수 전에 규격을 확인할 수 있게 맨 위에 둔다(기본은 접힘) */}
      <GuideSearch guide={guide} mode={mode} ready={!!agentUp} />

      <div className="modebar" role="tablist" aria-label="검사 방식">
        <button type="button" role="tab" aria-selected={mode === "direct"} className={`pill${mode === "direct" ? " on" : ""}`} onClick={() => setMode("direct")}>
          바로 검사 <span className="count">브라우저 안</span></button>
        <button type="button" role="tab" aria-selected={mode === "agent"} className={`pill${mode === "agent" ? " on" : ""}`} onClick={() => setMode("agent")}>
          에이전트 검사 <span className="count">에이전트 협업(A2A)</span></button>
        <span className="note">
          {mode === "direct" ? "모든 계산을 이 브라우저 안에서 합니다. 파일은 어디로도 보내지 않습니다."
            : agentUp === null ? "에이전트 연결 확인 중…"
            : agentUp ? "로컬 에이전트(사전 검사·색·종이·가이드…)가 나눠서 검사합니다. 파일은 이 PC의 에이전트에만 보냅니다. 아래에서 에이전트 상태와 소통 기록을 바로 볼 수 있습니다."
            : <span className="sev-high">에이전트가 꺼져 있습니다. <code>agents</code> 폴더에서 <code>python run_agents.py</code>로 켜세요.</span>}
        </span>
      </div>

      {/* 에이전트 검사를 고르면 '에이전트' 탭과 같은 내용(목록·의뢰 추적·소통 기록)을 이 자리에서 본다 */}
      {mode === "agent" && (
        <section className={`gsearch panel agent_inline${showAgents ? " open" : ""}`}>
          <button type="button" className="gs_toggle" aria-expanded={showAgents} onClick={() => setShowAgents((v) => !v)}>
            <b>에이전트 상태 · 의뢰 추적 · 소통 기록</b>
            <AgentHealth />
            <span className="note">누가 어떤 일을 할 수 있고(skill), 이번 의뢰를 누가 언제 얼마나 처리했는지 그대로 보여 줍니다.</span>
            <span className="gs_mark" aria-hidden="true">{showAgents ? "－" : "＋"}</span>
          </button>
          {showAgents && <div className="gs_body"><AgentsView initialCtx={agentJob?.context_id ?? ""} showWarn={false} /></div>}
        </section>
      )}

      <form className="upload panel" onSubmit={submit}>
        <label>PDF 파일
          <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <label>완성 크기
          <select value={size} onChange={(e) => pickSize(e.target.value)}>
            {Object.keys(SIZES).map((k) => <option key={k}>{k}</option>)}
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
        <label title="분광측색기로 잰 종이 흰색을 넣으면, 프로파일이 가정한 종이 대신 이 종이 기준으로 인쇄 색을 옮겨 ΔE를 다시 잽니다. 비워 두면 보정하지 않습니다.">종이 흰색 측정값(Lab, 선택)
          <input type="text" inputMode="decimal" placeholder="예: 94.9, 2.0, -6.0" value={whiteIn} onChange={(e) => setWhiteIn(e.target.value)} disabled={!paperColor} /></label>
        <button disabled={!file || busy || (!profile && !(mode === "agent" && paperId === "unknown")) || (mode === "agent" && !agentUp)}>{busy ? "검사 중…" : mode === "agent" ? "에이전트에 맡기기" : "검사 시작"}</button>
        {res && <button type="button" className="ghost" onClick={() => window.print()}>보고서 인쇄/PDF 저장</button>}
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
        <div className="empty">PDF를 선택하고 ‘검사 시작’을 누르세요. 파일은 서버로 보내지 않습니다.<br />
          테스트용 샘플: <code>PrintGuard/samples/defective_a5.pdf</code></div>
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
          {res.colorReport && (
            <div className="summary colorrep panel">
              <strong>인쇄 색 차이 ({res.colorReport.profile || "선택한 프로파일"})</strong>
              <span className="chip">RGB 이미지 면적<b>{(res.colorReport.areaShare * 100).toFixed(1)}%</b></span>
              <span className="chip">면적 가중 평균 ΔE00<b>{res.colorReport.weightedMeanDE.toFixed(1)}</b></span>
              <span className="chip">전체 면적 중 ΔE00&gt;5<b>{(res.colorReport.areaOver5 * 100).toFixed(1)}%</b></span>
              <span className="chip">ΔE00&gt;10<b>{(res.colorReport.areaOver10 * 100).toFixed(1)}%</b></span>
              <span className="chip">잉크 한도 초과<b>{(res.colorReport.areaOverTAC * 100).toFixed(1)}%</b></span>
              <span className="note">ΔE00 2 이하는 거의 같고, 5를 넘으면 눈에 띄는 차이로 봅니다(경험 기준). 실제 인쇄 결과를 보장하지 않는 예측입니다.</span>
            </div>
          )}
          {risks.length > 0 && (
            <div className="risk panel">
              <strong>인쇄 불량 위험도 · {usedPaper?.name}</strong>
              {usedPaper?.warn && <div className="warn">{usedPaper.warn}</div>}
              <div className="riskgrid">
                {risks.map((r) => (
                  <div key={r.id} className={`rcard lv-${r.level}`}>
                    <h4>{r.name} <span className={`sev-${r.level}`}>{LEVEL_LABEL[r.level]}</span>
                      {r.id === "indent" && <span className="noauto">후가공은 PDF로 자동 분석 불가</span>}
                      {r.id === "banding" && <span className="noauto">PDF로 예측 불가</span>}
                      {r.weak && <span className="noauto">근거 약함</span>}</h4>
                    <ul>{r.reasons.length ? r.reasons.map((t) => <li key={t}>{t}</li>) : <li>해당하는 위험 요인이 없습니다.</li>}</ul>
                    {r.hits[0] && <div className="gcard"><div className="gh">{r.hits[0].section.doc} › {r.hits[0].section.text.split("\n")[0]}</div></div>}
                  </div>
                ))}
              </div>
              <span className="note">학습한 모델이 아니라 공개 자료의 원인에서 정한 점수표 규칙입니다. 점수와 등급 구분선은 재서 정한 값이 아니라 임의로 정한 값이라, 높음/중간/낮음은 확률이 아니라 먼저 확인할 순서로 읽으세요. 후가공(접지·제본·박·형압)은 PDF에 정보가 없어 자동으로 검사하지 못하며, 직접 고른 값만 씁니다.</span>
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
        이 검수 결과는 인쇄소의 최종 승인과 사람의 교정을 대체하지 않으며, 색상은 실제 인쇄 결과를 보장하지 않는 위험 예측입니다.
        색 공간은 PDF 안의 정보를 읽은 값이고, 이미지 매칭은 가로·세로 픽셀 수로 하므로 같은 크기의 이미지가 여러 개면 틀릴 수 있습니다.
      </div>
    </div>
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
