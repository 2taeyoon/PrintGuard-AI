"use client";

// 에이전트가 하는 일이 **채팅방처럼** 쌓이는 칸. 그리고 그 문서를 그대로 인쇄 검수로 넘기는 칸.
//
// 전에는 문서 번호를 붙여 넣어야 보였다. 그 번호는 클로드의 답에만 찍히므로 매번 거기서 복사해
// 와야 했는데, 정작 보고 싶은 것은 '지금 뭐 하고 있나' 하나다. 번호를 묻는 칸이 그 사이를 막고
// 있었다. 그래서 **아무것도 넣지 않아도** 이 PC에서 일어나는 일이 그냥 흘러나오게 했다
// (서버가 이 PC에서 온 요청에만 열어 준다 — `GET /designcraft/feed`).
//
// 쌓는 방식이 채팅과 같다. 새 문서가 시작되면 방 이름처럼 한 줄 긋고, 그 아래로 한 일이
// 한 줄씩 붙는다. 사람이 말로 부탁한 것(`compose`)은 오른쪽에 붙어 누가 시킨 일인지 보인다.
// 명령 이름이 아니라 하는 일로 적는다 — `frame.create`·`type.char`·`text.insert` 세 줄이
// '글 넣기 “ATELIER”' 한 줄이 된다(엔진에서 글 하나를 넣는 일은 명령 세 개다).
//
// 아래 칸은 **보고 있는 그 문서**를 받고 검수로 넘긴다. 새 일이 시작되면 저절로 그쪽을 따라가고,
// 누르면 그 문서에 머문다. 받으려면 주인이어야 해서, 보는 순간 조용히 주인으로 올라선다
// (`/adopt` — 원래 주인은 그대로 남는다).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  adoptDoc, dcFileBlob, watchFeed, watchShot,
  type FeedDoc, type FeedRow, type SourceView,
} from "@/lib/agentClient";
import { readable } from "@/lib/engineText";
import { FontNotice, IssueRows } from "./dc-shared";

/** 한 걸음이 끝날 때마다 한 줄이 는다. 너무 느리게 물으면 여러 줄이 한꺼번에 쏟아진다. */
const EVERY = 900;
/** 들고 있을 줄 수. 오래된 것부터 버린다 — 한나절 켜 두면 끝없이 쌓인다. */
const KEEP = 400;

/** 가져온 문서. `shots`는 고치고 나면 생기는 쪽 그림 목록이다(갓 만든 것은 `png` 한 장뿐이다). */
type Doc = SourceView & { made: boolean; shots?: string[] };
/** 화면에 뿌릴 한 줄. `room`이면 방 이름(새 문서가 시작된 자리). */
type Msg = {
  id: number; ctx: string; at: string;
  room?: string; mine?: boolean; what: string; detail: string; command: string; error: string;
};

const clock = (at: string) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
};

/** 끝말고는 조용히 넘기는 걸음들. '저장합니다'까지 말풍선으로 띄우면 한 일이 묻힌다. */
const QUIET: Record<string, string> = {
  "문서를 엽니다": "문서를 열었습니다",
  "저장합니다": "저장했습니다",
  "그림을 뽑습니다": "쪽 그림을 뽑았습니다",
};

export default function WatchDoc() {
  const router = useRouter();
  const [rows, setRows] = useState<FeedRow[]>([]);
  const [docs, setDocs] = useState<Record<string, FeedDoc>>({});
  const [doc, setDoc] = useState<Doc | null>(null);
  const [chosen, setChosen] = useState("");    // 사람이 직접 고른 문서
  const [pinned, setPinned] = useState(false); // 그 자리에 머물러 있는가
  const [err, setErr] = useState("");
  const [shot, setShot] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [copied, setCopied] = useState(false);
  const after = useRef(0);
  const end = useRef<HTMLDivElement | null>(null);
  const lastShot = useRef("");
  const lastFresh = useRef("");

  // 되풀이해 묻는다. 받은 것은 **덧붙인다** — 매번 통째로 다시 받으면 보던 자리가 흔들린다.
  useEffect(() => {
    let alive = true;
    const tick = () => watchFeed(after.current)
      .then((f) => {
        if (!alive) return;
        setErr("");
        setDocs((old) => ({ ...old, ...f.docs }));
        if (f.rows.length) {
          after.current = f.next;
          setRows((old) => [...old, ...f.rows].slice(-KEEP));
        }
      })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    tick();
    const t = setInterval(tick, EVERY);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // 한 줄씩 들어온 기록을 사람이 읽는 말로. 명령은 묶어서 한 줄로 만든다.
  const msgs = useMemo<Msg[]>(() => {
    const out: Msg[] = [];
    let room = "";
    let run: FeedRow[] = [];
    const flush = () => {
      if (!run.length) return;
      const batch = run;
      run = [];
      for (const line of readable(batch.map((r) => ({ command: r.payload.command ?? "", params: r.payload.params ?? {} })))) {
        const got = line.idx.map((k) => batch[k]).filter(Boolean);
        const first = got[0] ?? batch[0];
        out.push({
          id: first.id, ctx: first.ctx, at: first.at,
          what: line.what, detail: line.detail, command: line.cmds.join(" · "),
          error: got.map((r) => r.payload.error).filter(Boolean).join(" ") || "",
        });
      }
    };
    for (const r of rows) {
      const p = r.payload;
      const same = r.ctx === room && !(r.kind === "dc_create_opened" || r.kind === "dc_source_opened");
      if (!same) flush();
      const push = (m: Omit<Msg, "id" | "ctx" | "at">) =>
        out.push({ id: r.id, ctx: r.ctx, at: r.at, ...m });

      if (!same) {
        // 방 이름. 어느 문서의 일인지 모르면 줄만 쌓인다.
        const d = docs[r.ctx];
        const size = p.width_mm && p.height_mm ? `${p.width_mm}×${p.height_mm}mm` : "";
        push({
          room: d?.filename || "문서",
          what: r.kind === "dc_source_opened" ? "올린 파일을 열었습니다"
            : r.kind === "dc_create_opened" ? (p.start === "sample" ? "샘플 잡지로 시작했습니다" : "새 문서를 폈습니다")
              : "이어서 작업합니다",
          detail: [size, p.pages ? `${p.pages}쪽` : "", p.doc ?? ""].filter(Boolean).join(" · "),
          command: "", error: "",
        });
        room = r.ctx;
        if (r.kind === "dc_create_opened" || r.kind === "dc_source_opened") continue;
      }

      if (r.kind === "dc_asked") {
        flush();
        push({ mine: true, what: p.text ?? "", detail: "", command: "", error: "" });
        continue;
      }
      if (r.kind !== "dc_step") continue;
      if (p.phase === "넣었습니다") continue;      // '넣는 중'과 같은 일이다. 두 번 적지 않는다
      if (p.command) { run.push(r); continue; }
      flush();
      if (p.phase === "끝") {
        push({
          what: "다 했습니다",
          detail: [p.total ? `${p.total}걸음` : "", p.pages ? `${p.pages}쪽` : "",
            p.items ? `넣은 것 ${p.items}개` : ""].filter(Boolean).join(" · "),
          command: "", error: "",
        });
      } else if (p.phase === "멈춤") {
        push({ what: "멈췄습니다", detail: "아무것도 저장하지 않았습니다", command: "", error: p.error ?? "" });
      } else {
        push({ what: QUIET[p.phase] ?? p.phase, detail: "", command: "", error: "" });
      }
    }
    flush();
    return out;
  }, [rows, docs]);

  // 마지막 걸음이 '끝'이 아니면 아직 돌고 있다. 기록이 끊긴 지 오래면 멈춘 것으로 본다.
  const lastStep = [...rows].reverse().find((r) => r.kind === "dc_step")?.payload;
  const busy = !!lastStep && lastStep.phase !== "끝" && lastStep.phase !== "멈춤";
  const live = rows.length ? rows[rows.length - 1].ctx : "";

  // 아래 칸이 보는 문서. **새 일이 시작되면 저절로 그쪽을 따라간다** — 번호를 지운 자리에
  // 다시 '무엇을 고르세요'를 놓으면 아무것도 나아지지 않는다. 사람이 고르면 그때부터 머문다.
  // 상태로 두지 않고 계산한다(효과 안에서 상태를 바꾸면 한 박자 늦게 그려진다).
  const pick = pinned && chosen ? chosen : (live || chosen);

  // 고른 것만 바꾼다. 다시 받아 오는 일은 아래 두 효과가 알아서 한다 — 그 둘이 보는 꼬리표에
  // 고른 문서가 들어 있어서, 문서가 바뀌면 꼬리표가 바뀐다.
  const open = useCallback((ctx: string) => {
    setChosen(ctx); setPinned(true); setShot(null); setPage(1);
  }, []);

  // 보고 있는 문서를 **내 쪽으로 가져온다.** 이걸 해야 파일을 받고 검수로 넘길 수 있다.
  // 걸음이 끝날 때마다 다시 가져온다 — 한 번만 가져오면 아래 칸이 옛날 문서를 말한다.
  const mark = busy ? "" : `${pick}|${rows.length}`;
  useEffect(() => {
    if (!pick || !mark || mark === lastFresh.current) return;
    lastFresh.current = mark;
    let alive = true;
    adoptDoc(pick)
      .then((d) => { if (alive) setDoc(d); })
      .catch(() => { if (alive) setDoc(null); });
    return () => { alive = false; };
  }, [pick, mark]);

  // 쪽 그림은 바뀐 것이 있을 때만 다시 받는다.
  const shots = doc?.shots?.length ? doc.shots : (doc?.png ? [doc.png] : []);
  const name = shots[Math.min(page, shots.length) - 1] ?? null;
  const stamp = `${pick}|${name}|${rows.length}`;
  useEffect(() => {
    if (!pick || !name || stamp === lastShot.current) return;
    lastShot.current = stamp;
    let dead: string | null = null;
    watchShot(pick, name).then((u) => { setShot((old) => { dead = old; return u; }); })
      .catch(() => { /* 아직 안 그려졌을 수 있다 */ })
      .finally(() => { if (dead) setTimeout(() => URL.revokeObjectURL(dead!), 1000); });
  }, [pick, name, stamp]);

  // 새 줄이 붙으면 아래로 따라 내려간다(채팅과 같다).
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [msgs.length]);

  /** 결과물 받기. 고친 뒤와 갓 만든 뒤의 파일 이름이 달라서 있는 쪽을 쓴다. */
  const dl = async (names: string[], as: string) => {
    for (const n of names) {
      try {
        const u = await dcFileBlob(pick, n);
        const a = document.createElement("a");
        a.href = u; a.download = as; a.click();
        setTimeout(() => URL.revokeObjectURL(u), 10_000);
        return;
      } catch { /* 다음 이름으로 */ }
    }
    setErr(`${as}를 받지 못했습니다. 아직 저장된 파일이 없습니다.`);
  };

  const recent = Object.entries(docs).sort((a, b) => (b[1].created ?? 0) - (a[1].created ?? 0)).slice(0, 6);

  return (
    <>
      <section className="panel dc_watch">
        <div className="dc_head">
          <strong>에이전트가 하는 일</strong>
          {busy
            ? <><span className="chip">하는 중<b>{lastStep?.at ?? 0}/{lastStep?.total ?? 0}</b></span>
              <span className="spinner" aria-hidden="true" /></>
            : msgs.length > 0 && <span className="chip">조용합니다</span>}
          <span className="grow" />
          {pinned && live && live !== pick && (
            <button type="button" className="pill on" onClick={() => { setPinned(false); }}>새 작업 따라가기</button>
          )}
        </div>

        <p className="note">
          클로드·커서에서 시키시면 <b>여기에 바로</b> 뜹니다. 넣을 것도 누를 것도 없습니다 —
          이 PC에서 하는 일이라 그대로 흘러나옵니다.
        </p>

        {err && !msgs.length && <p className="warn">{err}</p>}

        <div className="chat">
          {msgs.length === 0 ? (
            <div className="chat_empty">
              <p><b>아직 조용합니다</b></p>
              <p className="note">
                클로드·커서에 이렇게 적어 보세요 — “A4 전단 한 장 만들어 줘. 맨 위에 큰 제목,
                가운데 사진 자리, 맨 아래 연락처 한 줄.”
              </p>
              <p className="note">
                붙이는 방법은 <Link href="/help">도움말</Link>에 적어 두었습니다.
              </p>
            </div>
          ) : msgs.map((m) => (
            m.room ? (
              <div key={m.id} className={`chat_doc${m.ctx === pick ? " on" : ""}`}>
                <b>{m.room}</b>
                <span className="note">{m.what}{m.detail && ` · ${m.detail}`}</span>
                {/* 새로 만든 문서는 이름이 다 같다('새 문서.idml'). 시각이 없으면 어느 것인지 모른다. */}
                <time dateTime={m.at}>{clock(m.at)}</time>
                <span className="grow" />
                <button type="button" className="pill" onClick={() => open(m.ctx)}>
                  {m.ctx === pick ? "보는 중" : "이 문서 보기"}
                </button>
              </div>
            ) : (
              <div key={m.id} className={`msg${m.mine ? " me" : ""}${m.error ? " bad" : ""}`}>
                <div className="msg_body">
                  <b>{m.what}</b>
                  {m.detail && <span className="pl_detail">{m.detail}</span>}
                  {m.error && <span className="pl_detail">{m.error}</span>}
                  {m.command && <span className="pl_cmds">{m.command}</span>}
                </div>
                <time dateTime={m.at}>{clock(m.at)}</time>
              </div>
            )
          ))}
          <div ref={end} aria-hidden="true" />
        </div>

        {recent.length > 1 && (
          <div className="dc_row">
            <span className="note">문서 고르기:</span>
            {recent.map(([c, d]) => (
              <button key={c} type="button" className={`pill${c === pick ? " on" : ""}`}
                onClick={() => open(c)}>{d.filename}</button>
            ))}
          </div>
        )}

        {/* 다른 PC에서 만든 것이라면 이 길로 연다. 흔한 경우가 아니라 접어 둔다. */}
        <details className="dc_warnbox">
          <summary>다른 PC에서 만든 문서를 보려면</summary>
          <p className="note">
            위 목록은 <b>이 PC에서</b> 하는 일만 보여 줍니다. 에이전트가 다른 PC에 있다면 그 문서의
            번호가 있어야 합니다 — 클로드가 <code>make_document</code>로 만들 때 답에 적어 줍니다
            (<code>ctx_dc_</code>로 시작합니다).
          </p>
          <NumberBox onOpen={open} />
        </details>
      </section>

      {/* 보고 있는 그 문서. 만들어 놓고 못 넘기면 반쪽이다. */}
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
          {/* 이어서 시키려면 클로드에게 이 번호를 줘야 한다 — 'ctx_dc_… 이어서 고쳐 줘'. */}
          <div className="dc_row">
            <span className="note">이 문서 번호</span>
            <code className="dc_num">{doc.context_id}</code>
            <button type="button" className="pill" onClick={() => {
              navigator.clipboard.writeText(doc.context_id).then(() => setCopied(true), () => undefined);
              setTimeout(() => setCopied(false), 2000);
            }}>{copied ? "복사함" : "복사"}</button>
            <span className="note">클로드에게 주면 <b>이 문서를 이어서</b> 고칩니다.</span>
          </div>
          {err && <p className="warn">{err}</p>}

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

/** 번호로 여는 칸. 흔한 길이 아니어서 접어 두었다. */
function NumberBox({ onOpen }: { onOpen: (ctx: string) => void }) {
  const [typed, setTyped] = useState("");
  return (
    <div className="dc_row">
      <label className="wide">문서 번호
        <input type="text" value={typed} spellCheck={false} placeholder="ctx_dc_ 로 시작하는 번호"
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && typed.trim()) onOpen(typed.trim()); }} />
      </label>
      <button type="button" className="pill on" onClick={() => onOpen(typed.trim())} disabled={!typed.trim()}>보기</button>
    </div>
  );
}
