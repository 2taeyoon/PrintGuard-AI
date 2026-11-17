"use client";

// 지난 회차와 비교 — 같은 문서의 이전 회차와 이번 회차에서 쪽마다 바뀐 글자와 그림을 표시한다.
//
// 이 칸은 세 번 바뀌었다. 따로 된 탭(/compare) → 인쇄 검수 화면 맨 아래의 '교정 회차 비교' 칸 → 지금.
// 앞의 둘은 **사람이 할 일처럼** 보였다 — 이전본·수정본을 골라 올리는 칸이 있었고, 검수 결과와 상관없이
// 늘 떠 있었다. 그런데 회차 비교는 '이 문서를 지난번에도 검수했나'에서 시작하는 일이다. 그래서 따로 된
// 칸을 없애고, **같은 문서를 두 번째 이상 검수했을 때만** 그 검수 결과 아래에 저절로 붙인다.
// 처음 검수하는 문서에는 아무것도 그리지 않는다. 같은 문서인지는 lib/rounds.ts가 이름으로 가린다.
// 계산은 lib/compare.ts가 하고, 비교는 이 브라우저 안에서 한다(지난 회차 PDF는 검수 때 올린 것을 다시 받는다).
import { useEffect, useRef, useState } from "react";
import { jobPdf, listJobs, type JobRow } from "@/lib/agentClient";
import { docKey, roundsOf } from "@/lib/rounds";
import {
  changedRegions, checkRequests, diffWords, groupChanges, parseRequests, visualOnly, wordsFromItems,
  type Box, type PageDiff, type RequestCheck,
} from "@/lib/compare";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any;
type Result = { pages: PageDiff[]; oldCount: number; newCount: number; checks: RequestCheck[]; sizes: [number, number][];
  labels: [string, string] };
type Src = { blob: Blob; label: string };

const SAMPLE = "깨끗히 → 깨끗이\n몇일 → 며칠";
const VIS_SCALE = 1.2;          // 그림 비교 배율. 높이면 정확해지지만 느려진다

async function loadPdf(f: Blob): Promise<Doc> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  return pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
}

/** 쪽 하나를 그려 화소를 돌려준다(그림 비교용, 화면에는 안 붙인다). */
async function pixels(page: Doc, scale: number) {
  const vp = page.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  await page.render({ canvas: c, viewport: vp }).promise;
  return { data: c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
}

/** 쪽의 낱말과 자리. 자리는 **화면에 그려지는 좌표**(배율 1)로 돌려준다.
 *  PDF 좌표 그대로 두면 /Rotate가 90·180·270인 쪽에서 상자가 엉뚱한 곳에 놓인다 — 캔버스는
 *  돌린 뒤의 크기로 그려지는데 상자는 돌리기 전 좌표라서다. 네 모서리를 뷰포트로 옮겨 감싼다. */
async function words(page: Doc) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  return wordsFromItems(tc.items, [0, 0], 0).map((w) => {
    // origin 0·높이 0으로 받으면 box는 [x0, -(y+h), x1, -y] — PDF 좌표로 되돌려 옮긴다
    const [a, nt, b, nb] = w.box;
    const p1 = vp.convertToViewportPoint(a, -nt), p2 = vp.convertToViewportPoint(b, -nb);
    const box: Box = [Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.max(p1[0], p2[0]), Math.max(p1[1], p2[1])];
    return { ...w, box };
  });
}

/** 화면에 그려지는 쪽 크기(배율 1, 돌린 뒤). 상자 % 계산과 같은 크기 비교에 쓴다. */
const shown = (page: Doc): [number, number] => {
  const vp = page.getViewport({ scale: 1 });
  return [vp.width, vp.height];
};

const when = (t: number) => new Date(t * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** `current`: 방금 맡긴 검수 의뢰. 그 문서의 지난 회차가 있을 때만 그린다. */
export default function ComparePanel({ current }: { current: string }) {
  // 검수 기록. null이면 에이전트에 닿지 못한 것 — 그때는 그리지 않는다.
  const [jobs, setJobs] = useState<JobRow[] | null>([]);
  const [pick, setPick] = useState<[string, string]>(["", ""]);
  const [req, setReq] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [page, setPage] = useState(1);
  const [focus, setFocus] = useState<number | null>(null);
  const docs = useRef<{ old: Doc; neu: Doc } | null>(null);
  const oldCv = useRef<HTMLCanvasElement>(null);
  const newCv = useRef<HTMLCanvasElement>(null);

  async function run(oldSrc: Src, newSrc: Src) {
    setErr(""); setRes(null); setFocus(null);
    try {
      setBusy("파일을 읽는 중…");
      const [o, n] = await Promise.all([loadPdf(oldSrc.blob), loadPdf(newSrc.blob)]);
      docs.current = { old: o, neu: n };
      const total = Math.max(o.numPages, n.numPages);
      const pages: PageDiff[] = [], oldTexts: string[] = [], newTexts: string[] = [], sizes: [number, number][] = [];
      for (let i = 1; i <= total; i++) {
        setBusy(`${i} / ${total}쪽 비교 중…`);
        const po = i <= o.numPages ? await o.getPage(i) : null;
        const pn = i <= n.numPages ? await n.getPage(i) : null;
        const ref = (pn ?? po)!;
        sizes.push(shown(ref));
        if (!po || !pn) {
          const only = po ? "old" : "new";
          const ws = await words(ref);
          (only === "old" ? oldTexts : newTexts).push(ws.map((w) => w.s).join(" "));
          (only === "old" ? newTexts : oldTexts).push("");
          pages.push({ page: i, changes: [], visual: [], only });
          continue;
        }
        const [A, B] = await Promise.all([words(po), words(pn)]);
        oldTexts.push(A.map((w) => w.s).join(" ")); newTexts.push(B.map((w) => w.s).join(" "));
        const changes = groupChanges(diffWords(A.map((w) => w.s), B.map((w) => w.s)), A, B);
        const [ow, oh] = shown(po), [nw, nh] = shown(pn);
        const sameSize = Math.abs(ow - nw) < 1 && Math.abs(oh - nh) < 1;
        let visual: Box[] = [];
        if (sameSize) {
          const [a, b] = await Promise.all([pixels(po, VIS_SCALE), pixels(pn, VIS_SCALE)]);
          if (a.w === b.w && a.h === b.h) {
            visual = changedRegions(a.data, b.data, a.w, a.h)
              .map((r) => r.map((v) => v / VIS_SCALE) as Box);
            visual = visualOnly(visual, changes);
          }
        }
        pages.push({ page: i, changes, visual, sizeChanged: !sameSize });
      }
      const checks = checkRequests(parseRequests(req), oldTexts, newTexts);
      const first = pages.find((p) => p.changes.length || p.visual.length || p.only || p.sizeChanged)?.page ?? 1;
      setRes({ pages, oldCount: o.numPages, newCount: n.numPages, checks, sizes, labels: [oldSrc.label, newSrc.label] });
      setPage(first);
    } catch (e) {
      setErr(`비교하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy("");
    }
  }

  const rounds = jobs ? roundsOf(jobs, current) : [];
  const roundNo = (ctx: string) => rounds.findIndex((r) => r.context_id === ctx) + 1;
  const labelOf = (ctx: string) => {
    const j = jobs?.find((x) => x.context_id === ctx);
    const n = roundNo(ctx);
    return j ? `${n ? `${n}회차 · ` : ""}${j.filename} · ${when(j.created)}` : ctx;
  };

  /** 고른 두 검수 기록을 서버에서 받아 비교한다. */
  async function compareJobs(a: string, b: string, names = labelOf) {
    if (!a || !b) return;
    setErr("");
    try {
      setBusy("지난 회차 파일을 받는 중…");
      const [x, y] = await Promise.all([jobPdf(a), jobPdf(b)]);
      await run({ blob: x, label: names(a) }, { blob: y, label: names(b) });
    } catch (e) {
      setBusy("");
      setErr(`회차 파일을 받지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 검수 기록을 읽고, 같은 문서가 두 회차 이상이면 **묻지 않고** 마지막 두 회차를 맞대 본다.
  // 상태는 응답이 온 뒤에만 바꾼다(효과 본문에서 바로 바꾸지 않는다).
  useEffect(() => {
    let off = false;
    listJobs()
      .then((js) => {
        if (off) return;
        setJobs(js);
        const r = roundsOf(js, current);
        if (r.length < 2) return;
        const [a, b] = [r[r.length - 2], r[r.length - 1]];
        setPick([a.context_id, b.context_id]);
        // 아직 jobs 상태가 이 목록으로 바뀌기 전이라 이름표를 여기서 만든다
        const names = (ctx: string) => {
          const i = r.findIndex((x) => x.context_id === ctx);
          return `${i + 1}회차 · ${r[i].filename} · ${when(r[i].created)}`;
        };
        void compareJobs(a.context_id, b.context_id, names);
      })
      .catch(() => { if (!off) setJobs(null); });
    return () => { off = true; };
    // compareJobs는 그릴 때마다 새로 만들어지지만, 회차를 다시 찾을 때는 의뢰가 바뀔 때뿐이다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // 고른 쪽을 두 칸에 그린다. 한쪽에만 있는 쪽이면 다른 칸은 비운다.
  useEffect(() => {
    if (!res || !docs.current) return;
    let cancelled = false;
    const tasks: { cancel: () => void }[] = [];
    const draw = async (doc: Doc, count: number, cv: HTMLCanvasElement | null) => {
      if (!cv) return;
      const ctx = cv.getContext("2d")!;
      if (page > count) { cv.width = 1; cv.height = 1; ctx.clearRect(0, 0, 1, 1); return; }
      const p = await doc.getPage(page);
      if (cancelled) return;
      const vp = p.getViewport({ scale: 1.5 });
      cv.width = vp.width; cv.height = vp.height;
      const t = p.render({ canvas: cv, viewport: vp });
      tasks.push(t);
      await t.promise;
    };
    void draw(docs.current.old, res.oldCount, oldCv.current).catch(() => undefined);
    void draw(docs.current.neu, res.newCount, newCv.current).catch(() => undefined);
    return () => { cancelled = true; tasks.forEach((t) => t.cancel()); };
  }, [res, page]);

  const cur = res?.pages[page - 1];
  const size = res?.sizes[page - 1] ?? [1, 1];
  const pct = (b: Box) => ({ left: `${(b[0] / size[0]) * 100}%`, top: `${(b[1] / size[1]) * 100}%`,
    width: `${((b[2] - b[0]) / size[0]) * 100}%`, height: `${((b[3] - b[1]) / size[1]) * 100}%` });
  const changedPages = res?.pages.filter((p) => p.changes.length || p.visual.length || p.only || p.sizeChanged) ?? [];
  const textCount = res?.pages.reduce((n, p) => n + p.changes.length, 0) ?? 0;
  const visCount = res?.pages.reduce((n, p) => n + p.visual.length, 0) ?? 0;
  const tally = (s: string) => res?.checks.filter((c) => c.status === s).length ?? 0;

  // 이 문서를 처음 검수했으면(회차가 하나뿐이면) 아무것도 그리지 않는다 — 비교할 지난 회차가 없다.
  if (rounds.length < 2 || !rounds.some((r) => r.context_id === current)) return null;

  return (
    <section className="panel cmp_wrap" id="compare">
      <div className="cmp_head">
        <h2>지난 회차와 비교</h2>
        <span className="note">
          {`‘${docKey(rounds[0].filename)}’ 문서를 ${rounds.length}번 검수했습니다. 바뀐 글자·그림과 요청한 수정이 들어갔는지 봅니다.`}
        </span>
      </div>

      <section className="panel cmp_form">
        {(["이전 회차", "이번 회차"] as const).map((t, side) => (
          <label key={t} className="cmp_file">
            <b>{t}</b>
            <select value={pick[side]} onChange={(e) => setPick(side === 0 ? [e.target.value, pick[1]] : [pick[0], e.target.value])}>
              {rounds.map((r) => <option key={r.context_id} value={r.context_id}>{labelOf(r.context_id)}</option>)}
            </select>
          </label>
        ))}
        <label className="cmp_req">
          <b>요청한 수정 <span className="note">(선택 · 한 줄에 하나, &lsquo;이전 → 이후&rsquo;)</span></b>
          <textarea rows={3} value={req} placeholder={SAMPLE} onChange={(e) => setReq(e.target.value)} />
        </label>
        <div className="cmp_go">
          <button type="button" disabled={!pick[0] || !pick[1] || pick[0] === pick[1] || !!busy}
            onClick={() => void compareJobs(pick[0], pick[1])}>
            {busy || (req.trim() ? "요청한 수정까지 다시 비교" : "다시 비교")}
          </button>
        </div>
        {err && <div className="err">{err}</div>}
      </section>

      {res && (
        <>
          <section className="panel cmp_sum">
            <div className="cmp_chips">
              <span className="chip">바뀐 쪽 {changedPages.length} / {Math.max(res.oldCount, res.newCount)}</span>
              <span className="chip cmp_c_text">글자 변경 {textCount}곳</span>
              <span className="chip cmp_c_vis">그림 변화 {visCount}곳</span>
              {res.oldCount !== res.newCount && (
                <span className="chip cmp_c_warn">쪽수가 다릅니다 · 이전 {res.oldCount}쪽 → 수정 {res.newCount}쪽</span>
              )}
            </div>
            {res.checks.length > 0 && (
              <>
                <h2 className="cmp_h2">
                  요청한 수정 {res.checks.length}개 · 반영 {tally("반영")} · 누락 {tally("누락")} · 확인 필요 {tally("확인 필요")}
                </h2>
                <div className="scroll">
                  <table className="cmp_table">
                    <thead><tr><th>상태</th><th>요청</th><th>쪽</th><th>설명</th></tr></thead>
                    <tbody>
                      {res.checks.map((c, i) => (
                        <tr key={i}>
                          <td><span className={`chip cmp_st cmp_st_${c.status === "반영" ? "ok" : c.status === "누락" ? "miss" : "check"}`}>{c.status}</span></td>
                          <td>{c.from} → {c.to || "(지움)"}</td>
                          <td>{c.page ? <button type="button" className="ghost cmp_pg" onClick={() => setPage(c.page!)}>{c.page}쪽</button> : "—"}</td>
                          <td className="note">{c.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {changedPages.length === 0 && <p className="note">두 파일에서 달라진 곳을 찾지 못했습니다.</p>}
          </section>

          <div className="cmp_ws">
            <div className="pages">
              {res.pages.map((p) => {
                const n = p.changes.length + p.visual.length + (p.only || p.sizeChanged ? 1 : 0);
                return (
                  <button key={p.page} className={p.page === page ? "on" : ""} onClick={() => { setPage(p.page); setFocus(null); }}>
                    {p.page}쪽{n > 0 && <span className="dot">{n}</span>}
                  </button>
                );
              })}
            </div>

            <div className="cmp_view">
              {(["old", "new"] as const).map((side) => (
                <figure key={side} className="cmp_side">
                  <figcaption>{side === "old" ? `이전 · ${res.labels[0]}` : `이번 · ${res.labels[1]}`}{cur?.only === (side === "old" ? "new" : "old") && " — 이 쪽 없음"}</figcaption>
                  <div className="sheet">
                    <canvas ref={side === "old" ? oldCv : newCv} style={{ width: "100%", display: "block" }} />
                    {cur?.changes.map((c, i) => (side === "old" ? c.oldBoxes : c.newBoxes).map((b, j) => (
                      <span key={`${i}-${j}`} className={`cmp_mark ${side === "old" ? "cmp_del" : "cmp_ins"}${focus === i ? " on" : ""}`} style={pct(b)} />
                    )))}
                    {side === "new" && cur?.visual.map((b, i) => <span key={`v${i}`} className="cmp_mark cmp_vis" style={pct(b)} />)}
                  </div>
                </figure>
              ))}
            </div>

            <aside className="cmp_list">
              <h2 className="cmp_h2">{page}쪽에서 바뀐 것</h2>
              {cur?.only && <p className="note">{cur.only === "old" ? "수정본에서 이 쪽이 빠졌습니다." : "수정본에 새로 생긴 쪽입니다."}</p>}
              {cur?.sizeChanged && <p className="note">판형이 달라 그림 비교는 건너뛰었습니다.</p>}
              {cur && !cur.only && cur.changes.length === 0 && cur.visual.length === 0 && <p className="note">바뀐 것이 없습니다.</p>}
              <ol className="cmp_items">
                {cur?.changes.map((c, i) => (
                  <li key={i}>
                    <button type="button" className={`ghost cmp_item${focus === i ? " on" : ""}`} onClick={() => setFocus(focus === i ? null : i)}>
                      <span className={`chip cmp_k cmp_k_${c.kind}`}>{c.kind === "rep" ? "바꿈" : c.kind === "del" ? "지움" : "넣음"}</span>
                      {c.before && <del>{c.before}</del>}
                      {c.kind === "rep" && " → "}
                      {c.after && <ins>{c.after}</ins>}
                    </button>
                  </li>
                ))}
              </ol>
              {cur && cur.visual.length > 0 && (
                <p className="note">그림 변화 {cur.visual.length}곳 — 수정본의 주황 상자. 사진 교체·자리 이동·색 변경처럼 글자로는 안 잡히는 변화입니다.</p>
              )}
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
