import type { ReactNode } from "react";
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

// 질문에서 뜻을 가진 단어만 남긴다(끝에 붙는 조사·어미와 물음표를 떼고 두 글자 이상)
const ENDINGS = /(은|는|이|가|을|를|의|에|에서|로|으로|와|과|도|만|야|요|해|하는|하면|할까|인가|일까|나요|까요|는지|은지)$/;
export function queryTerms(q: string): string[] {
  const out = new Set<string>();
  for (const raw of q.split(/[\s,.?!·()'"]+/)) {
    let w = raw.trim();
    for (let i = 0; i < 2 && w.length > 2; i++) w = w.replace(ENDINGS, "");
    if (w.length >= 2 && !["어떻게", "무엇", "언제", "왜", "어디", "뭐야", "얼마"].includes(w)) out.add(w);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

type Mark = 0 | 1 | 2 | 3; // 1: 검색에 걸린 구간, 2: 질문 단어, 3: 둘 다
function marks(text: string, chunk: string, terms: string[]): Mark[] {
  const m = new Array<Mark>(text.length).fill(0);
  const c = chunk ? text.indexOf(chunk) : -1;
  if (c >= 0) for (let i = c; i < c + chunk.length; i++) m[i] = 1;
  const low = text.toLowerCase();
  for (const t of terms) {
    let i = low.indexOf(t.toLowerCase());
    while (i >= 0) {
      for (let j = i; j < i + t.length; j++) m[j] = (m[j] | 2) as Mark;
      i = low.indexOf(t.toLowerCase(), i + t.length);
    }
  }
  return m;
}

function render(text: string, m: Mark[], offset: number): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const k = m[offset + i];
    let j = i;
    while (j < text.length && m[offset + j] === k) j++;
    const seg = text.slice(i, j);
    if (k === 0) out.push(seg);
    else if (k === 1) out.push(<span key={i} className="mk-chunk">{seg}</span>);
    else out.push(<mark key={i} className={k === 3 ? "mk-term in-chunk" : "mk-term"}>{seg}</mark>);
    i = j;
  }
  return out;
}

// 인쇄 가이드 탭의 결과 한 줄: 순위, 제목, 본문(검색에 걸린 구간과 질문 단어 하이라이트)
export function GuideResult({ h, rank, query }: { h: Hit; rank: number; query: string }) {
  const text = h.section.text;
  const nl = text.indexOf("\n");
  const head = nl >= 0 ? text.slice(0, nl) : text;
  const body = nl >= 0 ? text.slice(nl + 1) : "";
  const m = marks(text, h.child, queryTerms(query));
  return (
    <li className="gresult">
      <span className="grank" aria-label={`${rank}위`}>{rank}</span>
      <div className="gmain">
        <div className="gdoc">{h.section.doc}</div>
        <h3 className="gtitle">{render(head, m, 0)}</h3>
        <p className="gtext">{render(body.replace(/\n/g, " "), m, nl + 1)}</p>
      </div>
    </li>
  );
}

// 임베딩 모델을 불러오는 동안 화면 전체를 덮는 로딩 화면. 상태 문구의 "NN%"로 진행 막대를 그린다.
export function ModelLoadingScreen({ status }: { status: string }) {
  const m = status.match(/(\d+)%/);
  const pct = m ? Math.min(100, +m[1]) : null;
  return (
    <div className="loading_screen" role="alertdialog" aria-modal="true" aria-busy="true" aria-labelledby="loading-title">
      <div className="loading_box">
        <span className="spinner big" aria-hidden="true" />
        <h2 id="loading-title">임베딩 모델 불러오는 중</h2>
        <p className="loading_status" aria-live="polite">{status || "준비 마무리 중"}</p>
        <div className={`progress${pct === null ? " indeterminate" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
          <span style={pct === null ? undefined : { width: `${pct}%` }} />
        </div>
        <p className="note">처음 한 번은 모델 파일(약 118MB)을 읽고 가이드 항목을 임베딩합니다. 다음부터는 브라우저 캐시로 빨라집니다.</p>
      </div>
    </div>
  );
}
