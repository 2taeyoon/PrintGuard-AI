"use client";

// 검수 흐름의 마지막 — 원본을 고친 결과(`job.results.fix`).
//
// 전에는 이것이 따로 된 '원본 수정' 화면이었다. 검수 결과를 복사해서 그 화면에 붙여 넣어야
// 고칠 수 있었는데, 붙여넣기는 사람이 하는 일이지 기계가 못 할 일이 아니었다. 지금은 편집
// 파일로 검수를 맡기면 검수가 끝난 자리에서 바로 묻고(designcraft가 input-required로 묻는다)
// 고친다. 그래서 이 패널은 **검수 결과의 한 조각**이다.

import { dcFileBlob, type FixResult } from "@/lib/agentClient";
import { Compare, FontNotice, IssueRows } from "./dc-shared";

export default function FixResultPanel({ ctx, filename, r }: { ctx: string; filename: string; r: FixResult }) {
  const dl = async (name: string, as: string) => {
    const u = await dcFileBlob(ctx, name);
    const a = document.createElement("a");
    a.href = u; a.download = as; a.click();
    setTimeout(() => URL.revokeObjectURL(u), 10_000);
  };

  // 고치지 않기로 한 것도 결과다. 아무것도 안 보여 주면 "물어봤는데 어떻게 됐지"가 남는다.
  if (r.skipped) {
    return (
      <section className="panel dc_run">
        <div className="dc_head">
          <strong>원본 수정</strong>
          <span className="chip">고치지 않음</span>
        </div>
        <p className="note">
          원본({filename})은 그대로 두었습니다. 교정 제안 {r.asked ?? 0}건은 위 검수 결과에 그대로 있습니다 —
          마음이 바뀌면 같은 파일로 다시 맡기시면 그 자리에서 다시 묻습니다.
        </p>
      </section>
    );
  }

  const applied = r.applied ?? [], failed = r.failed ?? [], shots = r.shots ?? [];
  // 손댄 쪽을 차례대로. 쪽을 모르는 건(0)은 맨 뒤로 보낸다.
  const pages = [...new Set([...applied, ...failed].map((x) => x.page ?? 0))]
    .sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  return (
    <section className="panel dc_run">
      <div className="dc_head">
        <strong>원본 수정</strong>
        <span className="chip">DesignCraft가 고침</span>
        <span className="chip">반영<b className="sev-low">{applied.length}</b></span>
        <span className="chip">실패<b className={failed.length ? "sev-high" : ""}>{failed.length}</b></span>
        <button type="button" className="pill on" onClick={() => void dl("fixed.pdf", `수정본_${filename}.pdf`)}>수정된 PDF 받기</button>
        {r.source_out && (
          <button type="button" className="pill" onClick={() => void dl(r.source_out!, `수정본_${r.source_out}`)}>
            편집 파일({r.source_out.split(".").pop()}) 받기
          </button>
        )}
      </div>
      <p className="note">
        올리신 원본은 건드리지 않았습니다. 고친 것은 사본이고, 위 두 단추로 받으시면 됩니다.
      </p>
      {/* 받은 PDF가 원본과 달라 보이는 이유는 여기서 말해야 한다. 나중에 알면 '잘못 고쳤나' 싶다.
          다시 올리라는 안내는 하지 않는다 — 고치는 일은 이미 끝났고, 글꼴은 건드리지 않았다. */}
      <FontNotice s={r} advise={false} />

      {/* 전후 비교는 **작게 늘어놓는다.** 쪽마다 큰 그림 두 장을 세로로 쌓으면 세 쪽만 되어도
          화면을 덮어서, 정작 무엇이 바뀌었는지를 적어 둔 아래 목록까지 내려가지 못한다.
          크게 보는 길은 내려받는 PDF에 있다. */}
      {shots.length > 0 && (
        <div className="cmp_row">
          {shots.map((s) => <Compare key={s.page} ctx={ctx} shot={s} compact />)}
        </div>
      )}
      {(r.shots_total ?? 0) > shots.length && (
        <p className="note">바뀐 쪽이 {r.shots_total}쪽인데 앞의 {shots.length}쪽만 그렸습니다.
          나머지는 내려받은 PDF에서 보세요.</p>
      )}

      {/* **쪽을 기준으로 묶는다.** 들어간 것과 못 들어간 것을 따로 늘어놓으면, '내가 보고 있는
          이 쪽은 다 된 건가'를 사람이 두 목록을 오가며 맞춰 봐야 한다. 한 쪽씩 같이 적는다. */}
      <h3 className="dc_sub">쪽마다 무엇이 바뀌었나</h3>
      {pages.length === 0 ? <div className="empty">바뀐 것이 없습니다.</div> : pages.map((pg) => {
        const ok = applied.filter((a) => (a.page ?? 0) === pg);
        const no = failed.filter((f) => (f.page ?? 0) === pg);
        return (
          <div key={pg} className="pagefix">
            <div className="pagefix_head">
              <b>{pg ? `${pg}쪽` : "쪽을 모르는 것"}</b>
              <span className="chip">바꿈 <b className="sev-low">{ok.length}</b></span>
              {no.length > 0 && <span className="chip">못 바꿈 <b className="sev-high">{no.length}</b></span>}
              {no.length === 0 && <span className="note">이 쪽은 모두 반영했습니다.</span>}
            </div>
            <ul className="dc_log">
              {ok.map((a, i) => (
                <li key={`o${i}`} className="ok">
                  <del>{a.original}</del> <span className="arrow">→</span> <ins>{a.suggestion}</ins>
                  <span className="note">글 덩어리 {a.story}, 위치 {a.at[0]}–{a.at[1]}바이트</span>
                </li>
              ))}
              {no.map((f, i) => (
                <li key={`x${i}`} className="bad">
                  <code>{f.original}</code> <span className="arrow">→</span> <code>{f.suggestion}</code>
                  <span className="why">{f.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {failed.length > 0 && (
        <p className="note">
          같은 문구가 여러 군데 있으면 <b>일부러 고치지 않습니다.</b> 어느 것인지 가릴 수 없는데 찍어서 고치면 조용히
          틀립니다. 그런 건은 원본에서 직접 고치시는 편이 안전합니다.
        </p>
      )}

      <h3 className="dc_sub">고친 뒤 원본 검사</h3>
      <IssueRows rows={r.preflight_after ?? []} empty="남은 문제가 없습니다." />
      <p className="note">
        교정이 새 문제를 만들 수 있습니다. 한글을 라틴 글꼴 자리에 넣으면 <b>없는 글자(글리프)</b>가 되고, 글이 길어지면{" "}
        <b>넘침</b>이 생깁니다. 그래서 고친 뒤에 한 번 더 검사합니다.
      </p>
    </section>
  );
}
