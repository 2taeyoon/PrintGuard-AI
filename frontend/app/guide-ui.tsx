import type { Hit } from "@/lib/guide";

// 임베딩 모델을 불러오는 동안 도는 진행 표시와 상태 문구
export function GuideBadge({ ready, status }: { ready: boolean; status: string }) {
  return (
    <span className={`badge${ready ? "" : " loading"}`} role="status" aria-live="polite">
      {!ready && !status.startsWith("가이드 검색 사용 불가") && <span className="spinner" aria-hidden="true" />}
      {status || "가이드 준비 중"}
    </span>
  );
}

export function GuideCard({ h }: { h: Hit }) {
  const [head, ...rest] = h.section.text.split("\n");
  return (
    <div className="gcard">
      <div className="gh">{h.section.doc} › {head}</div>
      <div className="gb">{rest.join(" ")}</div>
    </div>
  );
}
