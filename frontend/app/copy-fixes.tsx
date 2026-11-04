"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";

import type { Issue } from "@/lib/analyze";
import { buildFixText, buildReportText } from "@/lib/fixlist";

type Kind = "report" | "fixes";

/** 검수 결과를 가져가는 두 가지 방법.
 *
 *  - **검수 결과 전체**: 사람이 읽는 글. 메일·메모·메신저에 그대로 붙여 씁니다.
 *  - **교정 목록**: 기계가 읽는 줄. '원본 수정' 화면에 붙여 넣으면 인디자인 원본에서 그 글자를 찾아 고칩니다.
 *
 *  둘을 한 자리에 둔 이유는, 쓰임이 다른 두 글을 화면 여기저기에 흩어 두면 어느 것을 눌러야 하는지
 *  알 수 없어서입니다. 버튼 이름으로 가릅니다.
 */
export default function CopyFixes({ issues, filename, pages, mode }:
  { issues: Issue[]; filename: string; pages: number; mode: "direct" | "agent" }) {
  const [done, setDone] = useState<Kind | null>(null);
  const [manual, setManual] = useState(false);
  const [open, setOpen] = useState<Kind | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  const modeLabel = mode === "agent" ? "에이전트 검사" : "바로 검사";
  const report = useMemo(() => buildReportText(issues, { filename, pages, mode: modeLabel }), [issues, filename, pages, modeLabel]);
  const fixes = useMemo(() => buildFixText(issues, { filename, mode: modeLabel }), [issues, filename, modeLabel]);
  const editable = useMemo(() => issues.filter((i) => i.edit?.original && i.edit.suggestion).length, [issues]);
  const text = (k: Kind) => (k === "report" ? report : fixes);

  async function copy(k: Kind) {
    try {
      await navigator.clipboard.writeText(text(k));
      setManual(false);
      setDone(k);
      setTimeout(() => setDone((d) => (d === k ? null : d)), 2500);
    } catch {
      // 클립보드를 막아 둔 브라우저가 있다. 그럴 때는 글을 펼쳐서 직접 고르게 한다.
      setManual(true);
      setOpen(k);
      setTimeout(() => ta.current?.select(), 0);
    }
  }

  const show = (k: Kind) => setOpen((o) => (o === k ? null : k));

  return (
    <div className="copyfix panel">
      <div className="copyfix_head">
        <strong>결과 가져가기</strong>
        <span className="chip">검수 항목<b>{issues.length}</b></span>
        <span className="chip">그중 바로 고칠 수 있는 것<b>{editable}</b></span>
      </div>

      <div className="copyfix_row">
        <div className="copyfix_one">
          <button type="button" className="pill on" onClick={() => copy("report")}>
            {done === "report" ? "복사했습니다" : "검수 결과 전체 복사"}
          </button>
          <button type="button" className="pill" onClick={() => show("report")} aria-expanded={open === "report"}>
            {open === "report" ? "접기" : "내용 보기"}
          </button>
          <span className="note">아래 카드를 사람이 읽는 글로 — 메일·메모에 그대로 붙여 쓰세요.</span>
        </div>

        <div className="copyfix_one">
          <button type="button" className="pill on" onClick={() => copy("fixes")} disabled={editable === 0}>
            {done === "fixes" ? "복사했습니다" : `교정 목록 복사 (${editable})`}
          </button>
          <button type="button" className="pill" onClick={() => show("fixes")} aria-expanded={open === "fixes"}>
            {open === "fixes" ? "접기" : "내용 보기"}
          </button>
          <Link className="pill" href="/fix">원본 수정 →</Link>
          <span className="note">
            {editable > 0
              ? <>인디자인 원본(IDML·INDD)에서 그 글자를 찾아 고칩니다. <b>PDF는 고칠 수 없습니다.</b></>
              : "이번 검수에는 기계가 그대로 반영할 교정이 없습니다(여백·수치처럼 사람이 판단할 항목뿐)."}
          </span>
        </div>
      </div>

      {manual && <p className="note">브라우저가 클립보드를 막았습니다. 아래 글을 직접 복사(Ctrl+C)하세요.</p>}
      {open && (
        <textarea ref={ta} className="copyfix_text" readOnly value={text(open)}
          rows={Math.min(20, text(open).split("\n").length + 1)} />
      )}
    </div>
  );
}
