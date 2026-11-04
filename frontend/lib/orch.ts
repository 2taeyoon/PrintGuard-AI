// 에이전트(오케스트레이터) 주소 하나만 다룬다.
// agentClient와 auth가 둘 다 이 값을 쓰는데, 한쪽에 두면 서로를 불러 import가 고리를 그린다.

/** 빌드할 때 박히는 주소. 비워 두면 내 PC의 에이전트를 부른다. */
export const ORCH_BUILT = process.env.NEXT_PUBLIC_PG_ORCHESTRATOR ?? "http://127.0.0.1:8700";
const ORCH_KEY = "pg.orchestrator";
let typed: string | null = null; // null = 아직 저장된 값을 읽지 않음, "" = 저장된 값 없음

const trimUrl = (s: string) => s.trim().replace(/\/+$/, "");

/** 지금 부를 에이전트 주소. 화면에서 넣어 둔 값이 있으면 그것, 없으면 빌드할 때 박힌 값.
 *  터널 주소는 켤 때마다 바뀌는데 NEXT_PUBLIC_ 값은 빌드 때 박혀서, 화면에서 바꿀 길을 둔다.
 *  **자격증명이 아니라 설정이다.** 그래서 이 값만은 localStorage에 남겨도 된다. */
export function orchUrl(): string {
  if (typed === null) {
    try { typed = typeof window === "undefined" ? "" : localStorage.getItem(ORCH_KEY) ?? ""; } catch { typed = ""; }
  }
  return trimUrl(typed || ORCH_BUILT);
}

/** 주소를 이 브라우저에만 저장한다(빈 값이면 지우고 빌드할 때 박힌 값으로 돌아간다). 주소 꼴이 아니면 false */
export function setOrchUrl(v: string): boolean {
  const s = trimUrl(v);
  if (s && !/^https?:\/\/[^\s/?#]+$/.test(s)) return false;
  typed = s;
  try {
    if (s) localStorage.setItem(ORCH_KEY, s);
    else localStorage.removeItem(ORCH_KEY);
  } catch { /* 저장을 막아 둔 브라우저 */ }
  subs.forEach((f) => f());
  return true;
}

/* 주소를 React의 useSyncExternalStore로 읽게 해 둔다. 저장된 값을 첫 그림에서 바로 읽으면
   서버가 그린 화면(저장소가 없으니 빌드 값)과 브라우저가 그린 화면(저장된 값)이 어긋나
   hydration이 깨진다 — 주소를 한 번이라도 저장한 사람에게만 나던 오류다.
   서버 쪽 스냅샷으로 빌드 값을 주면 첫 그림이 양쪽 같아지고, 저장된 값은 그 직후에 반영된다. */
const subs = new Set<() => void>();
export function subscribeOrch(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
export const orchBuiltSnapshot = () => ORCH_BUILT;

export const isLocalOrch = (u: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(u);
/** 에이전트가 내 PC가 아니라 다른 서버에 있는가(공개 배포·터널). 화면 문구가 달라진다. */
export const hostedOrch = () => !isLocalOrch(orchUrl());
