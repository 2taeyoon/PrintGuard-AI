"use client";

// 에이전트가 만들고 있는 문서를 **따라 보는** 칸.
//
// 왜 이것이 필요한가. '작업 만들기'의 편집기는 iframe 안에서 혼자 도는 프로그램이라 바깥에서
// 조종할 수도, 들여다볼 수도 없다(글루 JS에 `postMessage`도 `WebSocket`도 없다 — 찾아봤다).
// 그래서 그 캔버스 대신 **에이전트가 그린 쪽 그림을 따라 보여 준다.** 진짜 편집기 안에서
// 움직이는 것은 아니고, 그려진 결과를 쫓아간다.
//
// 클로드·커서가 MCP로 만든 문서는 그 클라이언트가 주인이라 브라우저와 다르다. 그래서 번호로
// 연다 — `ctx_dc_` 뒤 24자리는 난수이고, 그 번호는 사용자가 쓰는 도구에만 찍힌다.
// 번호는 `localStorage`에 둔다. 열쇠가 아니라 '어느 문서를 보고 있었나'일 뿐이고, 잃어도
// 다시 붙여 넣으면 된다.

import { useCallback, useEffect, useRef, useState } from "react";

import { myDocs, watchDoc, watchShot, type Watch } from "@/lib/agentClient";

const KEY = "pg.watch.ctx";
/** 한 단계가 끝날 때마다 한 줄이 는다. 너무 느리게 물으면 여러 줄이 한꺼번에 쏟아진다. */
const EVERY = 900;

/** 엔진 명령을 사람 말로. 쓰는 사람에게 `swatch.create`는 암호다. */
const WHAT: Record<string, string> = {
  "swatch.create": "색 준비", "frame.create": "상자 놓기", "text.insert": "글 넣기",
  "type.char": "글자 모양", "type.para": "문단 모양", "file.place": "사진 넣기",
  "object.fill": "색 채우기", "object.stroke": "테두리", "line.create": "선 긋기",
  "table.insert": "표 넣기", "layout.pages.insert": "쪽 늘리기", "object.qrCode": "QR 코드",
  "style.paragraph.create": "글 모양 모음", "toc.generate": "목차",
};

export default function WatchDoc() {
  const [ctx, setCtx] = useState("");
  const [typed, setTyped] = useState("");
  const [w, setW] = useState<Watch | null>(null);
  const [mine, setMine] = useState<{ context_id: string; filename: string }[]>([]);
  const [err, setErr] = useState("");
  const [shot, setShot] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const end = useRef<HTMLLIElement | null>(null);
  const lastShot = useRef<string>("");

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
    setCtx(v); setTyped(v); setErr(""); setW(null); setShot(null); setPage(1);
    lastShot.current = "";
    try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* 막힌 브라우저 */ }
  }, []);

  // 보고 있는 동안 되풀이해 묻는다.
  useEffect(() => {
    if (!ctx) return;
    let alive = true;
    const tick = () => watchDoc(ctx)
      .then((r) => { if (alive) { setW(r); setErr(""); } })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    tick();
    const t = setInterval(tick, EVERY);
    return () => { alive = false; clearInterval(t); };
  }, [ctx]);

  // 쪽 그림은 바뀐 것이 있을 때만 다시 받는다.
  const shots = w?.shots ?? [];
  const name = shots[Math.min(page, shots.length) - 1] ?? null;
  const stamp = `${name}|${w?.steps?.[0]?.id ?? ""}`;
  useEffect(() => {
    if (!ctx || !name || stamp === lastShot.current) return;
    lastShot.current = stamp;
    let dead: string | null = null;
    watchShot(ctx, name).then((u) => { setShot((old) => { dead = old; return u; }); })
      .catch(() => { /* 아직 안 그려졌을 수 있다 */ })
      .finally(() => { if (dead) setTimeout(() => URL.revokeObjectURL(dead!), 1000); });
  }, [ctx, name, stamp]);

  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [w?.steps?.length]);

  const steps = [...(w?.steps ?? [])].filter((r) => r.payload.phase !== "넣었습니다");
  const busy = steps.length > 0 && steps[steps.length - 1]?.payload.phase !== "끝";

  return (
    <section className="panel dc_watch">
      <div className="dc_head">
        <strong>에이전트가 하는 일 따라 보기</strong>
        {w && <span className="chip">{w.filename}</span>}
        {w?.pages ? <span className="chip">쪽<b>{w.pages}</b></span> : null}
        {busy && <span className="spinner" aria-hidden="true" />}
        <span className="grow" />
        {ctx && <button type="button" className="pill" onClick={() => open("")}>그만 보기</button>}
      </div>

      <p className="note">
        클로드·커서에서 <code>make_document</code>로 문서를 만들면 <b>번호</b>가 나옵니다.
        그 번호를 여기에 넣으면, 에이전트가 글상자를 놓고 글을 넣는 것이 <b>한 걸음씩 그대로</b> 보입니다.
        아래 편집기와는 다른 문서입니다 — 편집기는 손으로 만드는 자리이고, 여기는 에이전트가 만드는 것을 보는 자리입니다.
      </p>

      <div className="dc_row">
        <label className="wide">문서 번호
          <input type="text" value={typed} spellCheck={false} placeholder="ctx_dc_…"
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") open(typed); }} />
        </label>
        <button type="button" className="pill on" onClick={() => open(typed)} disabled={!typed.trim()}>보기</button>
      </div>
      {mine.length > 0 && (
        <div className="dc_row">
          <span className="note">내가 만든 것:</span>
          {mine.slice(0, 5).map((m) => (
            <button key={m.context_id} type="button" className={`pill${ctx === m.context_id ? " on" : ""}`}
              onClick={() => open(m.context_id)}>{m.filename}</button>
          ))}
        </div>
      )}

      {err && <p className="warn">{err.startsWith("404") ? "그 번호로 된 문서가 없습니다. 번호를 다시 확인해 주세요." : err}</p>}

      {ctx && !err && (
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
              ? <img className="dc_shot" src={shot} alt={`${w?.filename ?? ""} ${page}쪽`} />
              : <div className="empty">아직 그려진 쪽이 없습니다.</div>}
          </div>
          <div>
            <h3 className="dc_sub">한 걸음씩</h3>
            {steps.length === 0 ? <div className="empty">아직 한 일이 없습니다.</div> : (
              <ol className="livelist watchlist">
                {steps.map((r) => {
                  const p = r.payload;
                  return (
                    <li key={r.id} className={p.error ? "bad" : ""}>
                      <b>{p.command ? (WHAT[p.command] ?? p.command) : p.phase}</b>
                      {p.command && <span className="pl_cmds">{p.command}</span>}
                      {p.error && <span className="pl_detail">{p.error}</span>}
                    </li>
                  );
                })}
                <li ref={end} aria-hidden="true" className="live_end" />
              </ol>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
