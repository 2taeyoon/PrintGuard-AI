// 교정 회차 — 같은 문서를 여러 번 검수했으면 그 기록끼리 묶는다.
// 교정지는 보통 '명함_1차.pdf', '명함_2차.pdf', '명함 (1).pdf', '명함_수정_최종.pdf'처럼
// 이름 끝만 바뀐 채 오간다. 그래서 끝에 붙는 회차 표시를 걷어 낸 이름을 '같은 문서'의 열쇠로 쓴다.
// 이름이 아예 다르면 묶지 않는다 — 다른 문서를 맞대 놓고 "바뀐 곳 200곳"을 보여 주는 쪽이 더 나쁘다.
import type { JobRow } from "./agentClient";

// 끝에서 하나씩 벗긴다. '명함_2차_수정' 같은 겹친 표시도 차례로 다 벗겨진다.
const TAIL = new RegExp(
  "[\\s_\\-.]*(?:" + [
    "\\(\\d+\\)",                       // 명함 (1)
    "v(?:er)?\\s*\\d+", "rev\\s*\\d+",  // v2, ver3, rev1
    "\\d+\\s*(?:차|교|회차?)",           // 2차, 3교, 2회차
    "[초재삼]교", "수정본?\\s*\\d*", "최종", "final", "교정", "copy", "사본",
    "\\d{4}[-.]?\\d{2}[-.]?\\d{2}", "\\d{6}", // 20261117, 2026-11-17, 261117
  ].join("|") + ")$", "i");

export function docKey(filename: string): string {
  let s = filename.normalize("NFC").trim().toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "");
  for (let prev = ""; prev !== s && s; ) { prev = s; s = s.replace(TAIL, ""); }
  return s.trim() || filename.toLowerCase();
}

/** 고른 의뢰(없으면 가장 최근 의뢰)와 같은 문서의 회차들. 오래된 것부터.
 *  같은 파일을 옵션만 바꿔 다시 검수했으면(지문이 같으면) 한 회차로 친다 — 나중 것만 남긴다. */
export function roundsOf(jobs: JobRow[], current?: string): JobRow[] {
  const anchor = jobs.find((j) => j.context_id === current) ?? [...jobs].sort((a, b) => b.created - a.created)[0];
  if (!anchor) return [];
  const key = docKey(anchor.filename);
  const same = jobs.filter((j) => docKey(j.filename) === key).sort((a, b) => a.created - b.created);
  return same.filter((j, i) => !j.pdf || same.slice(i + 1).every((k) => k.pdf !== j.pdf));
}
