// 에이전트(오케스트레이터) 주소 하나만 다룬다.
// agentClient와 auth가 둘 다 이 값을 쓰는데, 한쪽에 두면 서로를 불러 import가 고리를 그린다.
//
// **화면에서 바꾸지 못한다.** 전에는 주소를 입력하는 칸을 두었다(터널 주소가 켤 때마다 바뀌던
// 시절의 잔재다). 지금은 이름 있는 터널이라 주소가 고정이고, 그 칸은 들어오는 사람 아무에게나
// 내 에이전트 주소를 적어 보여 주는 자리였다. 그래서 칸을 없애고 빌드 값만 쓴다.
//
// 주소 자체를 숨기는 것은 아니다 — 브라우저가 거기로 요청을 보내니 개발자도구를 열면 보인다.
// 가린 것은 '화면에 광고하지 않는다'까지고, 막는 일은 오케스트레이터의 토큰 검사와 CORS가 한다.

/** 빌드할 때 박히는 주소(`NEXT_PUBLIC_PG_ORCHESTRATOR`). 비워 두면 내 PC의 에이전트를 부른다. */
export const ORCH_BUILT = process.env.NEXT_PUBLIC_PG_ORCHESTRATOR ?? "http://127.0.0.1:8700";

const OLD_KEY = "pg.orchestrator";   // 주소를 저장하던 시절의 열쇠. 남아 있으면 지운다
let cleaned = false;

/** 지금 부를 에이전트 주소. 언제나 빌드 값이다. */
export function orchUrl(): string {
  if (!cleaned && typeof window !== "undefined") {
    cleaned = true;
    // 전에 저장해 둔 주소가 남아 있으면 지운다. 그대로 두면 아무 데도 쓰이지 않는 값이
    // 브라우저에 계속 남는다(옛 터널 주소가 저장된 사람도 있다).
    try { localStorage.removeItem(OLD_KEY); } catch { /* 저장을 막아 둔 브라우저 */ }
  }
  return ORCH_BUILT.trim().replace(/\/+$/, "");
}

export const isLocalOrch = (u: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(u);
/** 에이전트가 내 PC가 아니라 다른 서버에 있는가(공개 배포·터널). 화면 문구가 달라진다. */
export const hostedOrch = () => !isLocalOrch(orchUrl());
