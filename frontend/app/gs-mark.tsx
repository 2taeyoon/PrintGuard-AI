/** 접이식 패널(class="gs_toggle") 오른쪽 끝의 펼침/접힘 표시.
 *  전각 ＋／－ 글자는 폰트에 따라 굵기와 중심이 제각각이라, 선 굵기를 직접 쥘 수 있는 svg로 그린다.
 *  색은 stroke="currentColor"로만 받는다 — 그래야 호버할 때 막대 전체를 흰 글자로 바꾸는
 *  globals.css의 .gs_toggle:hover .gs_mark 규칙이 아이콘에도 그대로 먹는다. */
export function GsMark({ open }: { open: boolean }) {
  return (
    <svg className="gs_mark" viewBox="0 0 24 24" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
      <line x1="4" y1="12" x2="20" y2="12" />
      {/* 접힌 상태에만 세로획을 더해 ＋로 만든다 */}
      {!open && <line x1="12" y1="4" x2="12" y2="20" />}
    </svg>
  );
}
