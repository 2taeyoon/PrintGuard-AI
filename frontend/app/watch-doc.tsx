"use client";

// 에이전트가 하는 일을 **글로** 따라 보고, 그 문서를 그대로 인쇄 검수로 넘기는 칸.
//
// 전에는 이 자리에 DesignCraft 웹 편집기를 띄웠다. 걷어냈다 — 그 편집기는 브라우저 안에서 혼자
// 돌아서 바깥에서 조종할 수도, 들여다볼 수도 없다(글루 JS에 `postMessage`도 `WebSocket`도 없다.
// 찾아봤다). 손으로 만드는 자리를 하나 더 둔다고 에이전트가 하는 일이 보이지는 않았다.
//
// 그래서 **에이전트 쪽만 남긴다.** 클로드·커서가 MCP로 문서를 만들면 걸음마다 기록이 쌓이고,
// 이 칸이 그것을 되풀이해 물어 한 줄씩 적는다. 명령 이름이 아니라 하는 일로 적는다
// (`frame.create` → '글 넣기 “ATELIER”'). 아래 칸에서는 그 문서를 검수로 넘기고 파일로 받는다.
//
// 번호로 여는 이유. MCP로 만든 문서는 그 도구(클로드)가 주인이라 브라우저와 다르다.
// `ctx_dc_` 뒤 24자리는 난수이고 그 번호는 만든 사람의 도구에만 찍히므로, 번호를 들고 왔다는 것을
// '내가 만든 것'으로 본다 — 공유 링크와 같은 세기다. 번호는 `localStorage`에 둔다. 열쇠가 아니라
// '어느 문서를 보고 있었나'일 뿐이고, 잃어도 다시 붙여 넣으면 된다.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  adoptDoc, dcFileBlob, myDocs, watchDoc, watchShot,
  type SourceView, type Watch,
} from "@/lib/agentClient";
import { readable } from "@/lib/engineText";
import { FontNotice, IssueRows } from "./dc-shared";

const KEY = "pg.watch.ctx";
/** 한 걸음이 끝날 때마다 한 줄이 는다. 너무 느리게 물으면 여러 줄이 한꺼번에 쏟아진다. */
const EVERY = 900;

type Doc = SourceView & { made: boolean };

export default function WatchDoc() {
  const router = useRouter();
  const [ctx, setCtx] = useState("");
  const [typed, setTyped] = useState("");
  const [w, setW] = useState<Watch | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [mine, setMine] = useState<{ context_id: string; filename: string }[]>([]);
  const [err, setErr] = useState("");
  const [shot, setShot] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const end = useRef<HTMLLIElement | null>(null);
  const lastShot = useRef<string>("");
  const lastFresh = useRef("");

  // 보던 번호를 기억한다. 새로 고칠 때마다 다시 붙여 넣게 하면 쓸 수가 없다.
  useEffect(() => {
    let alive = true;
    // 효과 본체에서 바로 상태를 바꾸지 않는다(연쇄 렌더). 저장소는 바깥 세상이므로 한 박자 뒤에 읽는다.
    void Promise.resolve().then(() => {
      if (!alive) return;
      try {
        const v = localStorage.getItem(KEY);
        if (v) { setCtx(v); setTyped(v); }
      } catch { /* 저장을 막아 둔 브라우저 */ }
    });
    myDocs().then((r) => { if (alive) setMine(r); }).catch(() => { /* 내 것이 없을 수도 있다 */ });
    return () => { alive = false; };
  }, []);

  const open = useCallback((id: string) => {
    const v = id.trim();
    setCtx(v); setTyped(v); setErr(""); setW(null); setDoc(null); setShot(null); setPage(1);
    lastShot.current = "";
    lastFresh.current = "";
    try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* 막힌 브라우저 */ }
  }, []);

  // 보고 있는 동안 되풀이해 묻는다. 걸음이 끝나도 계속 묻는다 — 클로드가 이어서 더 고칠 수 있다.
  useEffect(() => {
    if (!ctx) return;
    let alive = true;
    const tick = () => watchDoc(ctx)
      .then((r) => { if (alive) { setW(r); setErr(""); } })
      .catch((e: unknown) => {
        if (!alive) return;
        const m = e instanceof Error ? e.message : String(e);
        setErr(m);
        // 그 번호가 없어졌으면 아래 칸도 비운다. 없다고 말하면서 그 문서를 그대로 보여 주면
        // 받기·검수 단추가 안 듣는 이유를 알 수가 없다(에이전트를 다시 켜면 이렇게 된다).
        if (m.startsWith("404")) { setW(null); setDoc(null); setShot(null); }
      });
    tick();
    const t = setInterval(tick, EVERY);
    return () => { alive = false; clearInterval(t); };
  }, [ctx]);

  // 쪽 그림은 바뀐 것이 있을 때만 다시 받는다.
  const shots = w?.shots ?? [];
  const name = shots[Math.min(page, shots.length) - 1] ?? null;
  const stamp = `${name}|${w?.steps?.length ?? 0}`;
  useEffect(() => {
    if (!ctx || !name || stamp === lastShot.current) return;
    lastShot.current = stamp;
    let dead: string | null = null;
    watchShot(ctx, name).then((u) => { setShot((old) => { dead = old; return u; }); })
      .catch(() => { /* 아직 안 그려졌을 수 있다 */ })
      .finally(() => { if (dead) setTimeout(() => URL.revokeObjectURL(dead!), 1000); });
  }, [ctx, name, stamp]);

  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [w?.steps?.length]);

  /** 걸음을 사람이 읽는 줄로.
   *
   *  엔진에서 글 하나를 넣는 일은 명령 세 개다(상자 → 글자 모양 → 글). 세 줄로 적으면
   *  '글 넣기 “ATELIER”' 한 번이 무슨 일인지 안 보인다. 그래서 한 줄로 합친다.
   *
   *  기록에는 '넣는 중'(무엇을 넣는지)과 '넣었습니다'(엔진이 돌려준 번호)가 따로 쌓인다.
   *  뒤쪽은 **적지 않는다** — `id 7 · story 8`은 엔진이 자기 안에서 쓰는 번호이고,
   *  무슨 일을 하고 있는지와는 상관이 없다. 무엇을 했는지는 앞쪽에 다 들어 있다.
   *
   *  '문서를 엽니다'·'저장합니다'처럼 명령이 없는 걸음은 그 자리에 그대로 둔다 — 순서가
   *  뒤집히면 무엇 다음에 무엇을 했는지를 잃는다. */
  const rows = (() => {
    const all = w?.steps ?? [];
    const out: { id: number; what: string; detail: string; command: string; error: string }[] = [];
    let run: typeof all = [];
    const flush = () => {
      if (!run.length) return;
      const batch = run;
      run = [];
      for (const row of readable(batch.map((r) => ({ command: r.payload.command ?? "", params: r.payload.params ?? {} })))) {
        const got = row.idx.map((k) => batch[k]).filter(Boolean);
        out.push({
          id: got[0]?.id ?? out.length,
          what: row.what,
          detail: row.detail,
          command: row.cmds.join(" · "),
          error: got.map((r) => r.payload.error).filter(Boolean).join(" ") || "",
        });
      }
    };
    for (const r of all) {
      const p = r.payload;
      if (p.phase === "넣었습니다") continue;
      if (p.command) { run.push(r); continue; }
      flush();
      out.push({ id: r.id, what: p.phase, detail: "", command: "", error: p.error ?? "" });
    }
    flush();
    return out;
  })();
  const steps = w?.steps ?? [];
  const last = steps[steps.length - 1]?.payload;
  const busy = !!last && last.phase !== "끝" && last.phase !== "멈춤";
  const at = Math.max(0, ...steps.map((r) => r.payload.at ?? 0));
  const total = Math.max(0, ...steps.map((r) => r.payload.total ?? 0));

  // 번호를 열면 그 문서를 **내 쪽으로 가져온다.** 이걸 해야 파일을 받고 검수로 넘길 수 있다
  // (지켜보기만으로는 걸음과 쪽 그림까지다). 원래 주인은 그대로 남아 이어서 고칠 수 있다.
  //
  // 한 걸음이 끝날 때마다 다시 가져온다. 한 번만 가져오면 **아래 칸이 옛날 문서를 말한다** —
  // 클로드가 뒤이어 고쳐 놓았는데 '검사 0건'이 그대로 붙어 있으면 그게 더 나쁘다.
  const fresh = busy ? "" : `${ctx}|${steps.length}`;
  useEffect(() => {
    if (!ctx || !fresh || fresh === lastFresh.current) return;
    lastFresh.current = fresh;
    let alive = true;
    adoptDoc(ctx)
      .then((d) => { if (alive) setDoc(d); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    myDocs().then((r) => { if (alive) setMine(r); }).catch(() => { /* 목록은 없어도 된다 */ });
    return () => { alive = false; };
  }, [ctx, fresh]);

  /** 결과물 받기. 고친 뒤와 갓 만든 뒤의 파일 이름이 달라서 있는 쪽을 쓴다. */
  const dl = async (names: string[], as: string) => {
    for (const n of names) {
      try {
        const u = await dcFileBlob(ctx, n);
        const a = document.createElement("a");
        a.href = u; a.download = as; a.click();
        setTimeout(() => URL.revokeObjectURL(u), 10_000);
        return;
      } catch { /* 다음 이름으로 */ }
    }
    setErr(`${as}를 받지 못했습니다. 아직 저장된 파일이 없습니다.`);
  };

  return (
    <>
      <section className="panel dc_watch">
        <div className="dc_head">
          <strong>에이전트가 하는 일</strong>
          {w && <span className="chip">{w.filename}</span>}
          {w?.pages ? <span className="chip">쪽<b>{w.pages}</b></span> : null}
          {total > 0 && <span className="chip">{busy ? "하는 중" : "다 했습니다"}<b>{at}/{total}</b></span>}
          {busy && <span className="spinner" aria-hidden="true" />}
          <span className="grow" />
          {ctx && <button type="button" className="pill" onClick={() => open("")}>그만 보기</button>}
        </div>

        <p className="note">
          클로드·커서에서 <b>MCP로</b> 문서를 만들면, 글상자를 놓고 글을 넣는 것이 여기에{" "}
          <b>한 걸음씩 글로</b> 적힙니다. 문서 번호만 넣으시면 됩니다.
        </p>
        {/* 번호를 넣으라고만 하고 어디서 나오는지 말하지 않으면 칸이 있으나 마나다. */}
        <details className="dc_warnbox">
          <summary>번호는 어디서 나오나요?</summary>
          <p className="note">
            클로드·커서에 “명함 하나 만들어 줘” 하고 시키면 <code>make_document</code>가 돌면서
            이렇게 답합니다 —
          </p>
          <pre className="dc_cmd">문서 번호는 ctx_dc_7aa971b1a64e2926059337 입니다.
이 번호를 사람에게 그대로 알려 주세요 …</pre>
          <p className="note">
            <code>ctx_dc_</code>로 시작하는 그 번호를 복사해 아래 칸에 넣으시면 됩니다. 한 번 넣은
            번호는 이 브라우저가 기억하므로, 다음에 오시면 그대로 이어서 보입니다.
          </p>
          <p className="note">
            클로드·커서를 이 앱에 붙이는 방법은 <Link href="/help">도움말</Link>에 적어 두었습니다.
          </p>
        </details>

        <div className="dc_row">
          <label className="wide">문서 번호
            <input type="text" value={typed} spellCheck={false} placeholder="ctx_dc_ 로 시작하는 번호를 붙여 넣으세요"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") open(typed); }} />
          </label>
          <button type="button" className="pill on" onClick={() => open(typed)} disabled={!typed.trim()}>보기</button>
        </div>
        {mine.length > 0 && (
          <div className="dc_row">
            <span className="note">최근에 본 문서:</span>
            {mine.slice(0, 5).map((m) => (
              <button key={m.context_id} type="button" className={`pill${ctx === m.context_id ? " on" : ""}`}
                onClick={() => open(m.context_id)}>{m.filename}</button>
            ))}
          </div>
        )}

        {err && <p className="warn">{err.startsWith("404") ? "그 번호로 된 문서가 없습니다. 번호를 다시 확인해 주세요." : err}</p>}

        {ctx && !err && (
          rows.length === 0
            ? <div className="empty">아직 한 일이 없습니다. 클로드·커서에서 시키시면 여기에 적힙니다.</div>
            : (
              <ol className="livelist watchlist">
                {rows.map((r) => (
                  <li key={r.id} className={r.error ? "bad" : ""}>
                    <b>{r.what}</b>
                    {r.detail && <span className="pl_detail">{r.detail}</span>}
                    {r.command && <span className="pl_cmds">{r.command}</span>}
                    {r.error && <span className="pl_detail">{r.error}</span>}
                  </li>
                ))}
                <li ref={end} aria-hidden="true" className="live_end" />
              </ol>
            )
        )}
      </section>

      {/* 만든 문서. 여기서 끝이 아니라 검수로 이어진다 — 만들어 놓고 못 넘기면 반쪽이다. */}
      {doc && (
        <section className="panel dc_run">
          <div className="dc_head">
            <strong>그 문서</strong>
            <span className="chip">{doc.filename}</span>
            <span className="grow" />
            <button type="button" className="pill on"
              onClick={() => router.push(`/?src=${encodeURIComponent(doc.context_id)}`)}>
              이 문서로 인쇄 검수하기 →
            </button>
            <button type="button" className="pill"
              onClick={() => void dl(["work.idml", "new.idml"], doc.filename)}>인디자인 파일 받기</button>
            <button type="button" className="pill"
              onClick={() => void dl(["doc.pdf", "inspect.pdf"], doc.filename.replace(/\.idml$/, ".pdf"))}>PDF 받기</button>
          </div>
          <p className="note">
            검수로 넘기면 글꼴·도련·해상도·색·오탈자를 검사합니다. 고칠 것이 있으면{" "}
            <b>이 문서에 반영할지 물어봅니다</b>. 받은 인디자인 파일은 그대로 열어 이어서 작업해도 됩니다.
          </p>

          <div className="watchgrid">
            <div>
              {shots.length > 1 && (
                <div className="pagebar" role="tablist" aria-label="쪽 고르기">
                  {shots.map((_, i) => (
                    <button key={i} type="button" role="tab" aria-selected={page === i + 1}
                      className={`pill${page === i + 1 ? " on" : ""}`} onClick={() => setPage(i + 1)}>{i + 1}쪽</button>
                  ))}
                </div>
              )}
              {shot
                // eslint-disable-next-line @next/next/no-img-element
                ? <img className="dc_shot" src={shot} alt={`${doc.filename} ${page}쪽`} />
                : <div className="empty">아직 그려진 쪽이 없습니다.</div>}
            </div>
            <div>
              <h3 className="dc_sub">만든 문서 검사 {doc.preflight.length}건</h3>
              <IssueRows rows={doc.preflight} empty="문제를 찾지 못했습니다." />
              {/* 글꼴은 만들 때 골라 넣었으니 없을 일이 드물다. 그래도 한글이 없는 글꼴로 짜였으면
                  글자가 PDF에 안 찍히므로 같은 화면으로 알려 준다. 패키지 안내는 해당 없다. */}
              <FontNotice s={doc} advise={false} />
            </div>
          </div>
        </section>
      )}
    </>
  );
}
