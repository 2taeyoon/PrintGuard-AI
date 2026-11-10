"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { Analysis, Issue, Sev } from "@/lib/analyze";
import type { IntentName } from "@/lib/color";
import type { Guide, Hit } from "@/lib/guide";
import { GuideBadge, GuideCard, ModelLoadingScreen } from "./guide-ui";
import { TermsPanel } from "./terms";
import GuideSearch from "./guide-search";
import { AgentProgress, QuestionCard } from "./agent-ui";
import AgentsView, { AgentHealth } from "./agents-view";
import { FINISHES, GROUPS, loadPapers, surface, type FinishId, type Paper, type PaperDb } from "@/lib/papers";
import { CUSTOM, GROUPS as FORMATS, dims, match } from "@/lib/formats";
import { measure, type Measured } from "@/lib/pagesize";
import { assess, inputFrom, type Risk } from "@/lib/risk";
import CopyFixes from "./copy-fixes";
import { LAYOUT_FIX, autoFixOf } from "@/lib/fixlist";
import { SignInNote } from "./sign-in";
import FixResultPanel from "./fix-result";
import { FontNotice, IssueRows } from "./dc-shared";
import type { ProofSkip } from "@/lib/agentClient";
import { answerJob, createJob, dcFile, getSource, hostedOrch, orchestratorUp, toScreen, uploadSource, waitJob,
  type FixResult, type JobView, type SourceView } from "@/lib/agentClient";

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
  // 편집 파일(IDML)로 맡길 때만 채워진다. 이 번호가 있으면 검수 뒤에 **원본 수정까지** 간다.
  const srcParam = sp.get("src");   // '작업 만들기'에서 넘어온 길(`/?src=…`)
  const [srcCtx, setSrcCtx] = useState("");
  const [srcInfo, setSrcInfo] = useState<SourceView | null>(null);
  /** 이번 검수에서 빠진 교정 방법. 비어 있지 않으면 '적게 나온 이유'를 결과 위에 적는다. */
  const [proofSkip, setProofSkip] = useState<ProofSkip[]>([]);
  /** 폴더로 올린 것. 브라우저는 '파일 8개'라고만 적어서, **무엇을 올렸는지** 우리가 적어야 한다. */
  const [pack, setPack] = useState<Packed | null>(null);
  // 주소에 번호를 달고 들어왔으면 **처음부터** 여는 중이다. 효과 안에서 켜면 렌더가 한 번 더 돈다.
  const [srcBusy, setSrcBusy] = useState(!!srcParam);
  // 고른 것을 지울 때 input의 value까지 비우려면 손잡이가 필요하다
  const pdfRef = useRef<HTMLInputElement>(null);
  const idmlRef = useRef<HTMLInputElement | null>(null);
  // '이 문서로 인쇄 검수하기'로 들어온 사람을 **올리는 칸 앞에** 내려 준다. 맨 위에서 열리면
  // 방금 고른 문서가 어디 들어갔는지 보이지 않아, 멀쩡히 들어가 있는데도 다시 고르려고
  // 파일 칸을 찾아 내려가게 된다. 내려 줄 자리는 고른 것과 판형이 함께 보이는 그 칸이다.
  const formRef = useRef<HTMLFormElement>(null);
  const jumped = useRef(false);
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
  // 에이전트 주소는 빌드 값 하나로 고정이다(lib/orch.ts). 화면에서 바꾸는 칸은 두지 않는다 —
  // 그 칸은 들어오는 사람 아무에게나 내 에이전트 주소를 적어 보여 주는 자리였다.
  const HOSTED = hostedOrch();
  const [mode, setModeState] = useState<"direct" | "agent">(sp.get("mode") === "direct" ? "direct" : "agent");
  const setMode = (m: "direct" | "agent") => {
    setModeState(m);
    router.replace(m === "direct" ? "/?mode=direct" : "/", { scroll: false });
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
    const d = dims(v);
    if (d) { setW(d[0]); setH(d[1]); }
  }

  /** 파일을 고르면 완성 크기·도련을 그 파일에서 읽어 칸을 채운다.
   *  손으로 적던 칸이라 오타 한 번에 "페이지 크기가 설정과 다름"이 모든 쪽에 떴다. 값은 이미 파일 안에 있다.
   *  사람이 적어 둔 값도 덮어쓴다 — 대신 무엇을 어디서 읽었는지 칸 아래에 적어, 틀렸으면 되돌릴 수 있게 한다. */
  /** 원본(IDML)에서 뽑아 둔 검수용 PDF를 받아 **화면이 쓰는 PDF로 삼는다.**
   *  크기를 재는 것도(lib/pagesize), 결과에서 쪽을 그리는 것도(pdf.js) 그 PDF로 한다. 그래서
   *  이 뒤로는 PDF를 올린 것과 한 글자도 다르지 않게 흐른다 — 다른 점은 `srcCtx`가 있다는 것뿐이고,
   *  그 하나가 '검수 뒤에 원본을 고칠 수 있다'를 가른다. */
  const adoptSource = useCallback(async (s: SourceView) => {
    setSrcCtx(s.context_id); setSrcInfo(s);
    const blob = await dcFile(s.context_id, "inspect.pdf");
    const pdf = new File([blob], s.filename.replace(/\.[^.]+$/, "") + ".pdf", { type: "application/pdf" });
    setFile(pdf);
    const m = await measure(pdf);
    if (!m) { setReadFail(true); return; }
    setRead(m);
    setW(m.widthMm); setH(m.heightMm);
    if (m.bleedMm !== null) setBleed(m.bleedMm);
    const hit = match(m.widthMm, m.heightMm);
    setSize(hit && !hit.rotated ? hit.format.label : CUSTOM);
  }, []);

  // 번호 하나만 들고 와서 여기서 다시 집어 온다(쪽수·미리보기를 주소에 실어 나르지 않는다).
  useEffect(() => {
    if (!srcParam) return;
    let alive = true;
    getSource(srcParam)
      .then((s) => { if (alive) return adoptSource(s); })
      .catch((e: unknown) => { if (alive) setErr(`만든 문서를 불러오지 못했습니다. (${e instanceof Error ? e.message : e})`); })
      .finally(() => { if (alive) setSrcBusy(false); });
    return () => { alive = false; };
  }, [srcParam, adoptSource]);

  // 다 불러온 뒤에 내려간다. 여는 동안 내려 보내면 칸이 '여는 중…'일 때 자리를 잡고,
  // 쪽수·판형이 채워지면서 자리가 밀린다. 한 번만 한다 — 그 뒤로는 보던 자리가 흔들리면 안 된다.
  useEffect(() => {
    if (!srcParam || srcBusy || jumped.current) return;
    jumped.current = true;
    formRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [srcParam, srcBusy]);

  async function openSource(fs: File[]) {
    setSrcBusy(true); setErr(""); setRead(null); setReadFail(false);
    try {
      await adoptSource(await uploadSource(fs));
    } catch (e) {
      setErr(`원본을 열지 못했습니다. 편집 파일은 에이전트가 켜져 있어야 열 수 있습니다. (${e instanceof Error ? e.message : e})`);
      setFile(null);
    }
    setSrcBusy(false);
  }

  /** 지금 고른 쪽. **둘 중 하나만** 올릴 수 있으므로 이 한 값이 두 칸의 잠금을 가른다.
   *  `srcCtx`를 먼저 본다 — IDML을 올리면 거기서 뽑은 PDF가 `file`에도 들어가기 때문이다. */
  const picked: "" | "pdf" | "idml" = srcCtx || srcBusy ? "idml" : (file ? "pdf" : "");

  /** 고른 것을 지운다. 잠그기만 해 두면 잘못 고른 사람이 새로 고치기 말고는 길이 없다.
   *  input의 `value`까지 비워야 한다 — 같은 파일을 다시 골라도 `change`가 안 나기 때문이다. */
  function clearPick() {
    for (const r of [pdfRef, idmlRef]) if (r.current) r.current.value = "";
    setFile(null); setRead(null); setReadFail(false); setSrcCtx(""); setSrcInfo(null); setErr(""); setPack(null);
  }

  async function pickFile(f: File | null) {
    setFile(f); setRead(null); setReadFail(false); setSrcCtx(""); setSrcInfo(null); setPack(null);
    if (!f) return;
    // 편집 파일은 브라우저가 열지 못한다. 에이전트에 올려 DesignCraft로 열고, 거기서 뽑은 PDF로 검수한다.
    if (/\.(idml|designcraft)$/i.test(f.name)) return openSource([f]);
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
      // 원본으로 맡기면 파일을 다시 올리지 않는다 — 서버가 이미 그 원본과 거기서 뽑은 PDF를 들고 있다.
      const { context_id } = await createJob(srcCtx ? null : f, opts, srcCtx);
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
    const { analysis, risks: rs, hits: hs, proofSkipped: ps } = toScreen(v);
    setProofSkip(ps);
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
        <p className="lead">폰트와 도련, 해상도, 색, 문구를 검사합니다. 고른 종이로 인쇄 색 차이와 불량 위험을 예측합니다. 오탈자 등은 수정 제안만 보여 줍니다. 자동으로 고치지는 않으니 원본 파일에서 직접 고치세요. {mode === "direct" ? "파일은 어디로도 보내지 않습니다." : HOSTED ? "에이전트 검사 모드에서는 PDF가 에이전트 서버로 올라갑니다." : "파일은 이 PC에서 도는 에이전트에만 보냅니다."}</p>
      </header>

      {/* 가이드 검색: 검수 전에 규격을 확인할 수 있게 맨 위에 둔다(기본은 접힘) */}
      <GuideSearch guide={guide} mode={mode} ready={!!agentUp}
        badge={mode === "direct" ? <GuideBadge ready={!!guide} status={guideStatus} />
          : <span className="badge">Guide 에이전트 준비됨</span>} />

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

      {/* 에이전트 검사를 고르면 '에이전트' 탭과 같은 내용(목록·의뢰 추적·소통 기록)을 이 자리에서 본다 */}
      {mode === "agent" && (
        <section className="gsearch panel agent_inline open">
          {/* 접지 않는다. '에이전트 검사'를 고른 사람은 **누가 무엇을 하는지 보려고** 고른 것이다 —
              그걸 한 번 더 눌러야 보이게 두면 고른 이유가 접혀 있는 셈이다. */}
          <div className="gs_head">
            <b>에이전트 상태 · 의뢰 추적 · 소통 기록</b>
            <AgentHealth />
            <span className="note">누가 어떤 일을 할 수 있고(skill), 이번 의뢰를 누가 언제 얼마나 처리했는지 그대로 보여 줍니다.</span>
          </div>
          <div className="gs_body"><AgentsView initialCtx={agentJob?.context_id ?? ""} showWarn={false} withFix={!!srcCtx} /></div>
        </section>
      )}

      {mode === "agent" && <SignInNote />}

      <TermsPanel />

      <form className="upload panel" ref={formRef} onSubmit={submit}>
        {/* **둘 중 하나만 올린다.** PDF로 맡긴 검수와 IDML로 맡긴 검수는 할 수 있는 일이 다르다
            (IDML 쪽만 끝에서 원본을 고친다). 둘 다 골라 두면 어느 쪽으로 도는지 화면만 보고는
            알 수 없다. 그래서 하나를 고르면 다른 쪽을 잠그고, 잠긴 이유를 그 자리에 적는다.

            파일 고르기는 **‘파일 선택’을 눌렀을 때만** 열려야 한다. `<label>`은 품은 input을
            대신 누르므로, label 안에 설명이나 제목을 두면 그 글자를 눌러도 파일 창이 뜬다 —
            읽으려고 누른 사람 앞에 창이 열린다. 그래서 글자는 `<span>`으로 두고, 이름은
            `aria-labelledby`로 input에 묶는다(읽어 주는 프로그램에는 그대로 들린다). */}
        <div className={`wide filepick${picked === "idml" ? " locked" : ""}`}>
          <span className="fp_title" id="pick_pdf_l">검수할 PDF 파일
            {picked === "idml" && <span className="chip">IDML을 고르셨습니다</span>}
          </span>
          {/* 칸의 생김새를 우리가 맡는다. 브라우저가 input 옆에 적는 글('파일 8개')은 **고를 수 없는
              말**이라, 폴더로 올린 사람에게 무엇을 올렸는지 하나도 말해 주지 않는다. 그 글자를
              화면에서만 감추고(읽어 주는 프로그램에는 그대로 있다) 그 자리에 고른 것의 이름을
              우리가 적는다. 파일 창은 여전히 단추를 눌렀을 때만 열린다. */}
          <div className="fp_pick">
            <input id="pick_pdf" aria-labelledby="pick_pdf_l" type="file" accept=".pdf,application/pdf"
              className="fp_file" tabIndex={-1}
              ref={pdfRef} disabled={srcBusy || picked === "idml"}
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
            <button type="button" className="ghost small" disabled={srcBusy || picked === "idml"}
              onClick={() => pdfRef.current?.click()}>파일 선택</button>
            <span className={`fp_name${picked === "pdf" ? "" : " none"}`}>
              {picked === "pdf" ? (file?.name ?? "") : "고른 파일 없습니다"}
            </span>
          </div>
          <span className="note">
            검수까지 됩니다. <b>원본은 고치지 못합니다</b> — PDF에서는 글자를 집을 수 없습니다.
            고치는 데까지 가시려면 아래에 <b>인디자인 패키지 폴더</b>를 올려 주세요.
          </span>
        </div>

        {/* IDML은 사진을 링크로만, 글꼴을 이름으로만 들고 있다. 파일 하나만 받으면 인쇄용 사진도
            글꼴도 빠진 채로 검수하게 된다. 그래서 파일 하나와 패키지 폴더를 **둘 다** 받는다 —
            `webkitdirectory`가 걸린 칸은 폴더만 고를 수 있어서, 칸 하나로는 둘을 다 받지 못한다. */}
        <div className={`wide filepick${picked === "pdf" ? " locked" : ""}`}>
          <span className="fp_title" id="pick_idml_l">검수할 인디자인 작업 — <b>패키지 폴더째</b>
            {picked === "pdf" && <span className="chip">PDF를 고르셨습니다</span>}
          </span>
          {/* 파일 하나만 받던 길을 없앴다. IDML은 사진을 링크로만, 글꼴을 이름으로만 들고 있어서
              파일 하나로는 **인쇄용 사진도 글꼴도 빠진 채** 검수하게 된다 — 넘침·줄바꿈·해상도가
              원본과 다르게 나오는데, 그 수치를 보고 인쇄를 결정하면 안 된다. 폴더째만 받는다.
              (webkitdirectory는 React 타입에 없어서 속성으로 직접 준다) */}
          <div className="fp_pick">
            <input id="pick_idml" aria-labelledby="pick_idml_l" type="file" className="fp_file" tabIndex={-1}
              disabled={srcBusy || picked === "pdf"}
              ref={(el) => { idmlRef.current = el; if (el) { el.setAttribute("webkitdirectory", ""); el.setAttribute("directory", ""); } }}
              onChange={(e) => {
                const fs = e.target.files;
                if (!fs?.length) return;
                const list = Array.from(fs);
                setPack(packOf(list));
                void openSource(list);
              }} />
            <button type="button" className="ghost small" disabled={srcBusy || picked === "pdf"}
              onClick={() => idmlRef.current?.click()}>폴더 선택</button>
            {/* 브라우저가 적던 '파일 8개' 자리. 고른 **폴더 이름**을 적는다 — 여럿을 번갈아
                올려 보는 사람에게 개수는 어느 것인지 가려 주지 못한다. */}
            <span className={`fp_name${pack ? "" : " none"}`}>{pack ? pack.folder : "고른 폴더 없습니다"}</span>
          </div>
          <span className="note">
            InDesign에서 <b>파일 → 패키지</b>로 폴더를 만든 뒤 <b>그 폴더를 통째로</b> 골라 주세요.
            안에 든 <code>Links</code> 사진과 <code>Document Fonts</code> 글꼴까지 같이 올라가야{" "}
            <b>보시는 결과가 실제 인쇄물과 같아집니다.</b>
          </span>
          <span className="note">
            검수가 끝나면 <b>고칠 것을 원본에 반영할지 묻고 고쳐 드립니다.</b> 올리신 파일은 그대로 두고
            사본을 내드리며, 그 사본에는 원래 글꼴 이름이 그대로 남습니다.
          </span>
          {pack && <PackList pack={pack} />}
        </div>

        {/* 고른 뒤의 상태는 두 칸 어디에도 넣지 않는다. IDML을 올리면 거기서 뽑은 PDF가 '화면이 쓰는
            PDF'가 되므로 크기 안내는 두 길에 다 해당하고, 잠긴 칸 안에 적으면 흐려져서 안 읽힌다. */}
        {(picked || srcBusy) && (
          <div className="wide fp_state">
            {srcBusy && <span className="note">원본을 여는 중입니다… DesignCraft가 열어 검수용 PDF를 뽑습니다(10초쯤).</span>}
            {!srcBusy && (
              <span className="note">
                고른 것: <b>{srcInfo ? srcInfo.filename : (file?.name ?? "")}</b>
                {/* 파일 하나만 올려도 서버는 폴더 하나로 풀어 둔다. 그래서 1은 적지 않는다 —
                    '폴더 안 1개'는 폴더로 올린 줄로 읽힌다. */}
                {(srcInfo?.uploaded_files ?? 0) > 1 ? ` — 폴더째 ${srcInfo!.uploaded_files}개` : ""}
                {" "}
                <button type="button" className="pill" onClick={clearPick}>지우고 다시 고르기</button>
              </span>
            )}
            {read && <ReadHint m={read} />}
            {readFail && <span className="note">파일에서 크기를 읽지 못했습니다. 암호가 걸렸거나 깨진 PDF일 수 있습니다. 아래 칸을 직접 채워 주세요.</span>}
          </div>
        )}
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
        <div className="filepick">
          <span className="fp_title" id="pick_icc_l">인쇄소 CMYK 프로파일(ICC)</span>
          <input id="pick_icc" aria-labelledby="pick_icc_l" type="file" accept=".icc,.icm" onChange={(e) => setIccFile(e.target.files?.[0] ?? null)} title={`비워 두면 ${profile?.name ?? "선택한 종이의 프로파일"}을 씁니다`} />
        </div>
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
        <button disabled={!file || busy || (!profile && !(mode === "agent" && paperId === "unknown")) || (mode === "agent" && !agentUp)}>{busy ? "검사 중…" : mode === "agent" ? "에이전트에 맡기기" : "검사 시작"}</button>
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

      {/* 원본(IDML)으로 맡길 때만. PDF만 봐서는 알 수 없는 것들이 여기서 나온다 —
          넘친 글자는 PDF에 아예 안 찍히고, 끊긴 사진은 빈 칸으로 보일 뿐이다. */}
      {srcInfo && <SourcePanel s={srcInfo} />}

      {mode === "agent" && agentJob && <AgentProgress job={agentJob} />}
      {mode === "agent" && agentJob?.status === "input-required" && agentJob.question && (
        <QuestionCard q={agentJob.question} busy={busy} onAnswer={answer} />
      )}
      {err && <div className="err">{err}</div>}
      {!res && !busy && !err && !agentJob && (
        <div className="empty">{mode === "direct"
          ? "검수할 파일을 고르고 ‘검사 시작’을 누르세요. 파일은 서버로 보내지 않습니다."
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
          {/* 검수의 마지막 — 원본을 고쳤는가. 편집 파일로 맡겼을 때만 이 자리가 생긴다. */}
          {agentJob?.results?.fix && (
            <FixResultPanel ctx={agentJob.context_id} filename={agentJob.filename} r={agentJob.results.fix as FixResult} />
          )}
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
              {/* **고쳐 주는 것과 고쳐 드릴 수 없는 것을 먼저 가른다.**
                  해상도·색 차이·안전 영역은 기계가 손댈 수 있는 종류의 문제가 아니다 — 없는 화소를
                  만들어 낼 수도, 디자인을 대신 정할 수도 없다. 그걸 목록 안에 섞어 두면 '맡기면
                  다 고쳐지겠지' 하고 기다리게 된다. 숫자로 먼저 말하고, 항목마다 표를 붙인다. */}
              {res.issues.length > 0 && (() => {
                const auto = res.issues.filter((i) => autoFixOf(i)).length;
                return (
                  <div className="fixsum">
                    <span className="howfix auto">자동 수정 {auto}건</span>
                    <span className="howfix">사람이 고칠 것 {res.issues.length - auto}건</span>
                    <span className="note">
                      <b>자동 수정</b>은 편집 파일(<code>.idml</code>)로 맡기시면 검수 끝에 묻고 바꿔 드립니다 —
                      글자를 찾아 바꾸는 것뿐 아니라 <b>사진 크기·글상자 자리·내보내기 규격</b>까지 고칩니다.
                      나머지는 사진을 바꾸거나 디자인을 다시 정하는 일이라 기계가 대신 정할 수 없습니다.
                    </span>
                    {/* 교정 방법 하나가 빠진 채로 '자동 수정 0건'을 보여 주면, 그 0이 '이 파일은
                        깨끗하다'로 읽힌다. 빠졌으면 빠졌다고 적는다. */}
                    {proofSkip.length > 0 && (
                      <span className="warn">
                        <b>{proofSkip.map((x) => x.label).join(", ")}</b>이(가) 이번 검수에서 빠졌습니다 —{" "}
                        {proofSkip[0].reason.includes("429") || /한도|quota|RESOURCE_EXHAUSTED/i.test(proofSkip[0].reason)
                          ? "LLM 분당 한도에 걸렸습니다. 잠시 뒤에 같은 파일로 다시 맡기시면 맞춤법 교정까지 함께 나옵니다."
                          : proofSkip[0].reason}
                        {" "}나머지 방법으로 찾은 것만 아래에 있습니다.
                      </span>
                    )}
                  </div>
                );
              })()}
              {res.issues.map((i) => (
                <div key={i.id} className={`card ${i.severity} ${sel === i.id ? "sel" : ""}`} onClick={() => pick(i)}>
                  <h4><span className={`sev-${i.severity}`}>{SEV_LABEL[i.severity]}</span> · {i.page}쪽 · {i.title}
                    <span className="src">{SRC[i.source]}</span>
                    {autoFixOf(i)
                      ? <span className="howfix auto" title={autoFixOf(i)}>자동 수정</span>
                      : <span className="howfix" title="기계가 대신 정할 수 없는 항목입니다. 사람이 보고 고쳐야 합니다">사람이 고칠 것</span>}
                  </h4>
                  <p>{i.detail}</p>
                  {i.edit?.original && i.edit.suggestion
                    ? <p><b>바꿀 것:</b> <del>{i.edit.original}</del> <span className="arrow">→</span> <ins>{i.edit.suggestion}</ins></p>
                    : LAYOUT_FIX[i.kind]
                      // 자리·크기는 바꿀 '글자'가 없다. 무엇을 어떻게 움직이는지 그 자리에 적어야
                      // 누르기 전에 무슨 일이 일어날지 알 수 있다.
                      ? <p><b>자동으로 할 일:</b> {LAYOUT_FIX[i.kind]}</p>
                      : <p><b>수정 제안(직접 수정):</b> {i.fix}</p>}
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

/* ---------- 올린 폴더 안에 무엇이 들어갔나 ----------
   브라우저는 '파일 8개'라고만 적는다. 그런데 패키지는 **편집 파일 하나에 사진과 글꼴이 딸려 오는
   묶음**이고, 그 여덟이 무엇이냐가 곧 '검수 결과가 실제 인쇄물과 같아지는가'다 — 사진이 빠지면
   해상도를 못 보고, 글꼴이 빠지면 줄바꿈이 밀린 채로 재게 된다. 그래서 종류별로 묶어 세고
   이름을 그대로 적는다. 빠진 것이 있으면 올리기 전에 알아야 한다. */
type Packed = { folder: string; files: string[]; isFolder: boolean };

function packOf(list: File[]): Packed {
  // 폴더로 고르면 webkitRelativePath에 '폴더/안/경로'가 담긴다. 파일 하나만 고르면 비어 있다.
  const first = list[0]?.webkitRelativePath ?? "";
  const isFolder = first.includes("/");
  return {
    isFolder,
    folder: isFolder ? first.split("/")[0] : (list[0]?.name ?? "고른 파일"),
    files: list.map((f) => f.webkitRelativePath || f.name).sort((a, b) => a.localeCompare(b, "ko")),
  };
}

const PACK_KINDS: { id: string; label: string; test: RegExp }[] = [
  { id: "doc", label: "편집 파일", test: /\.(idml|designcraft)$/i },
  { id: "indd", label: "인디자인 원본 — 열지 않습니다", test: /\.(indd|indt)$/i },
  { id: "img", label: "사진·그림", test: /\.(jpe?g|png|tiff?|psd|ai|eps|pdf|svg|gif|bmp)$/i },
  { id: "font", label: "글꼴", test: /\.(otf|ttf|ttc|otc|dfont|pfb|pfm|woff2?)$/i },
];
const PACK_SHOW = 12;   // 사진은 수십 장이 될 수 있다. 다 펼치면 칸을 덮는다

function PackList({ pack }: { pack: Packed }) {
  const rows = PACK_KINDS
    .map((k) => ({ ...k, items: pack.files.filter((f) => k.test.test(f)) }))
    .concat([{
      id: "etc", label: "그 밖", test: /$^/,
      items: pack.files.filter((f) => !PACK_KINDS.some((k) => k.test.test(f))),
    }])
    .filter((k) => k.items.length > 0);
  const hasDoc = rows.some((k) => k.id === "doc");
  return (
    <div className="packlist">
      <div className="pack_head">
        {pack.isFolder
          ? <><b>{pack.folder}</b> 안의 파일 {pack.files.length}개를 올렸습니다</>
          : <><b>{pack.folder}</b> 하나만 올렸습니다 — 폴더째 올리시면 사진과 글꼴까지 같이 갑니다</>}
      </div>
      {rows.map((k) => (
        <div key={k.id} className="pack_row">
          <span className="pack_kind">{k.label} <b>{k.items.length}</b></span>
          <span className="pack_files">
            {k.items.slice(0, PACK_SHOW).map((f) => <code key={f}>{f}</code>)}
            {k.items.length > PACK_SHOW && <span className="note">외 {k.items.length - PACK_SHOW}개</span>}
          </span>
        </div>
      ))}
      {!hasDoc && (
        <p className="warn">
          <b>편집 파일(<code>.idml</code>)이 안 보입니다.</b> 패키지 폴더에는 보통 <code>.indd</code>만 들어 있습니다 —
          InDesign에서 <b>파일 → 다른 이름으로 저장 → InDesign Markup(IDML)</b>으로 내보내 그 폴더에 넣은 뒤
          다시 골라 주세요.
        </p>
      )}
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

/** 편집 파일을 열어 본 결과. 검수(PDF)와 **다른 것을 보는 눈**이라 따로 적는다.
 *  넘친 글자는 PDF에 안 찍히고, 끊긴 사진은 빈 칸으로 보일 뿐이며, 없는 글꼴은 대체되어 그려진다 —
 *  셋 다 PDF만 봐서는 알 수 없고, 원본을 열었기 때문에 잡힌다. */
function SourcePanel({ s }: { s: SourceView }) {
  const errs = s.preflight.filter((i) => i.severity === "error").length;
  return (
    <section className="panel dc_src">
      <div className="dc_head">
        <strong>원본 파일</strong>
        <span className="chip">{s.filename}</span>
        <span className="chip">쪽<b>{s.pages}</b></span>
        <span className="chip">글 덩어리<b>{s.stories.length}</b></span>
        <span className="chip">넘친 글<b className={s.stories.some((x) => x.overset) ? "sev-high" : ""}>{s.stories.filter((x) => x.overset).length}</b></span>
        <span className="chip">원본 검사<b className={errs ? "sev-high" : ""}>{s.preflight.length}</b></span>
      </div>
      <p className="note">
        편집 파일로 맡기셨습니다. 검수는 이 원본에서 뽑은 PDF로 하고, 검수가 끝나면{" "}
        <b>고칠 것을 원본에 반영할지 물어봅니다</b>.
      </p>
      {s.preflight.some((i) => i.kind === "missingLink") && (
        <p className="warn">
          <b>사진 링크가 끊겼습니다.</b> IDML 파일만 올려서 그렇습니다 — 사진은 그 파일 안에 없습니다.
          지금 보이는 그림은 IDML이 품고 있는 <b>저해상 미리보기</b>라서, 이대로 내보낸 PDF는 인쇄에 쓸 수 없습니다.
          글자 교정만 하실 거면 그대로 두셔도 됩니다.
        </p>
      )}
      <FontNotice s={s} />
      {/* 접지 않는다. 올린 파일에서 **무엇이 걸렸나**는 이 칸을 연 이유 그 자체라, 한 번 더 눌러야
          보이면 안 본 채로 넘어간다. 줄이 길어지면 이 목록 안에서만 굴린다. */}
      <h3 className="dc_sub">원본 검사(preflight) {s.preflight.length}건</h3>
      <IssueRows rows={s.preflight} empty="원본에서 발견된 문제가 없습니다." />
    </section>
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
