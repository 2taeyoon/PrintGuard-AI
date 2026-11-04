"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";

import type { Issue } from "@/lib/analyze";
import { buildFixText } from "@/lib/fixlist";

/** 검수 결과를 '인디자인 원본 수정' 화면에 그대로 붙여 넣을 수 있는 글로 복사한다.
 *  두 검사 방식 모두에서 동작한다. 다만 기계가 그대로 적용할 수 있는 항목은 교정 에이전트가
 *  주는 '원래 내용 → 수정할 내용' 짝뿐이라, 나머지는 사람이 판단할 목록으로 같이 적어 준다. */
export default function CopyFixes({ issues, filename, mode }: { issues: Issue[]; filename: string; mode: "direct" | "agent" }) {
  const [state, setState] = useState<"idle" | "done" | "manual">("idle");
  const [open, setOpen] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);

  const text = useMemo(
    () => buildFixText(issues, { filename, mode: mode === "agent" ? "에이전트 검사" : "바로 검사" }),
    [issues, filename, mode],
  );
  const editable = useMemo(() => issues.filter((i) => i.edit?.original && i.edit.suggestion).length, [issues]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("done");
      setTimeout(() => setState((s) => (s === "done" ? "idle" : s)), 2500);
    } catch {
      // 클립보드를 막아 둔 브라우저가 있다. 그럴 때는 글을 펼쳐서 직접 고르게 한다.
      setState("manual");
      setOpen(true);
      setTimeout(() => ta.current?.select(), 0);
    }
  }

  return (
    <div className="copyfix panel">
      <div className="copyfix_head">
        <strong>검수 결과 복사</strong>
        <span className="chip">바로 고칠 수 있는 항목<b>{editable}</b></span>
        <span className="chip">사람이 볼 항목<b>{issues.length - editable}</b></span>
        <button type="button" className="pill on" onClick={copy}>
          {state === "done" ? "복사했습니다" : "클립보드로 복사"}
        </button>
        <button type="button" className="pill" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "접기" : "내용 보기"}
        </button>
        <Link className="pill" href="/fix">인디자인 원본 수정 →</Link>
      </div>

      {editable === 0 && (
        <p className="note">
          {mode === "direct"
            ? "바로 검사는 ‘이 글자를 저 글자로’ 형태의 교정을 만들지 않습니다(표기·수치 불일치를 짚어 주기만 합니다). 글자 교정을 자동으로 반영하려면 에이전트 검사로 돌려 주세요."
            : "이번 검수에서는 기계가 그대로 반영할 교정이 나오지 않았습니다. 아래 목록은 사람이 보고 판단할 항목입니다."}
        </p>
      )}
      {state === "manual" && <p className="note">브라우저가 클립보드를 막았습니다. 아래 글을 직접 복사(Ctrl+C)하세요.</p>}

      {open && (
        <textarea ref={ta} className="copyfix_text" readOnly value={text} rows={Math.min(18, text.split("\n").length + 1)} />
      )}
      <p className="note">
        복사한 글은 <Link href="/fix">인디자인 원본 수정</Link> 화면에 붙여 넣습니다. 그 화면에서 원본(IDML·INDD)을 올리면
        DesignCraft가 글자를 찾아 고치고 PDF로 다시 내보냅니다. <b>PDF 자체는 고칠 수 없습니다</b> — 원본 편집 파일이 있어야 합니다.
      </p>
    </div>
  );
}
