"use client";

// 회차 비교 — 이전본과 수정본 PDF를 올리면 쪽마다 바뀐 글자와 그림을 표시한다.
// 계산은 lib/compare.ts가 하고, 여기서는 파일을 읽어 쪽을 그리고 결과를 겹쳐 보여 준다.
// **파일은 이 브라우저 안에서만 읽는다.** 서버로 보내지 않는다(에이전트도 부르지 않는다).
import { useEffect, useRef, useState } from "react";
import {
  changedRegions, checkRequests, diffWords, groupChanges, parseRequests, visualOnly, wordsFromItems,
  type Box, type PageDiff, type RequestCheck,
} from "@/lib/compare";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any;
type Result = { pages: PageDiff[]; oldCount: number; newCount: number; checks: RequestCheck[]; sizes: [number, number][] };

const SAMPLE = "깨끗히 → 깨끗이\n몇일 → 며칠";
const VIS_SCALE = 1.2;          // 그림 비교 배율. 높이면 정확해지지만 느려진다

async function loadPdf(f: File): Promise<Doc> {
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

async function words(page: Doc) {
  const [x0, y0, , y1] = page.view as number[];
  const tc = await page.getTextContent();
  return wordsFromItems(tc.items, [x0, y0], y1 - y0);
}

export default function Compare() {
  const [oldF, setOldF] = useState<File | null>(null);
  const [newF, setNewF] = useState<File | null>(null);
  const [req, setReq] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [page, setPage] = useState(1);
  const [focus, setFocus] = useState<number | null>(null);
  const docs = useRef<{ old: Doc; neu: Doc } | null>(null);
  const oldCv = useRef<HTMLCanvasElement>(null);
  const newCv = useRef<HTMLCanvasElement>(null);

  async function run() {
    if (!oldF || !newF) return;
    setErr(""); setRes(null); setFocus(null);
    try {
      setBusy("파일을 읽는 중…");
      const [o, n] = await Promise.all([loadPdf(oldF), loadPdf(newF)]);
      docs.current = { old: o, neu: n };
      const total = Math.max(o.numPages, n.numPages);
      const pages: PageDiff[] = [], oldTexts: string[] = [], newTexts: string[] = [], sizes: [number, number][] = [];
      for (let i = 1; i <= total; i++) {
        setBusy(`${i} / ${total}쪽 비교 중…`);
        const po = i <= o.numPages ? await o.getPage(i) : null;
        const pn = i <= n.numPages ? await n.getPage(i) : null;
        const ref = (pn ?? po)!;
        const [vx0, vy0, vx1, vy1] = ref.view as number[];
        sizes.push([vx1 - vx0, vy1 - vy0]);
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
        const so = po.view as number[], sn = pn.view as number[];
        const sameSize = Math.abs((so[2] - so[0]) - (sn[2] - sn[0])) < 1 && Math.abs((so[3] - so[1]) - (sn[3] - sn[1])) < 1;
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
      const first = pages.find((p) => p.changes.length || p.visual.length || p.only)?.page ?? 1;
      setRes({ pages, oldCount: o.numPages, newCount: n.numPages, checks, sizes });
      setPage(first);
    } catch (e) {
      setErr(`비교하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy("");
    }
  }

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
  const changedPages = res?.pages.filter((p) => p.changes.length || p.visual.length || p.only) ?? [];
  const textCount = res?.pages.reduce((n, p) => n + p.changes.length, 0) ?? 0;
  const visCount = res?.pages.reduce((n, p) => n + p.visual.length, 0) ?? 0;
  const tally = (s: string) => res?.checks.filter((c) => c.status === s).length ?? 0;

  return (
    <main className="common_wrap">
      <header className="page_head">
        <h1>회차 비교</h1>
        <p className="lead">
          이전본과 수정본 PDF를 올리면 쪽마다 바뀐 글자와 그림을 표시합니다. 요청한 수정을 적어 두면 반영됐는지도 셉니다.
          파일은 이 브라우저 안에서만 읽고 서버로 보내지 않습니다.
        </p>
      </header>

      <section className="panel cmp_form">
        <label className="cmp_file">
          <b>이전본</b>
          <input type="file" accept="application/pdf,.pdf" onChange={(e) => setOldF(e.target.files?.[0] ?? null)} />
        </label>
        <label className="cmp_file">
          <b>수정본</b>
          <input type="file" accept="application/pdf,.pdf" onChange={(e) => setNewF(e.target.files?.[0] ?? null)} />
        </label>
        <label className="cmp_req">
          <b>요청한 수정 <span className="note">(선택 · 한 줄에 하나, &lsquo;이전 → 이후&rsquo;)</span></b>
          <textarea rows={4} value={req} placeholder={SAMPLE} onChange={(e) => setReq(e.target.value)} />
        </label>
        <div className="cmp_go">
          <button type="button" disabled={!oldF || !newF || !!busy} onClick={() => void run()}>
            {busy || "비교하기"}
          </button>
          <span className="note">PDF만 받습니다. 글자 비교는 PDF 안의 글을 읽고, 그림 비교는 두 쪽을 같은 배율로 그려 대조합니다.</span>
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
                const n = p.changes.length + p.visual.length + (p.only ? 1 : 0);
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
                  <figcaption>{side === "old" ? "이전본" : "수정본"}{cur?.only === (side === "old" ? "new" : "old") && " — 이 쪽 없음"}</figcaption>
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
    </main>
  );
}
