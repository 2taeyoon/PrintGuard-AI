// 구글 로그인 — **선택이다.** 로그인하지 않아도 검사는 전부 된다.
//
// ── 주인이 두 가지인 이유 ─────────────────────────────────────────────────────
// 에이전트는 PC 한 대인데 주소는 누구에게나 열려 있다. 그래서 의뢰마다 주인이 있어야
// 남의 파일 이름과 소통 기록이 섞이지 않는다. 그 주인을 이렇게 만든다.
//
// 1. 로그인 전 — 서버에서 **익명 토큰**을 받아(`POST /auth/session`) `localStorage`에 둔다.
//    누구인지는 담기지 않는다. 그 브라우저에서만 그 의뢰가 보인다.
// 2. 로그인 — 구글이 서명한 ID 토큰을 서버에 한 번 내밀면(`POST /auth/google`) 구글 계정
//    번호(ID 토큰 안의 `sub`)에 묶인 토큰으로 바꿔 준다. 이 토큰도 기한과 함께 `localStorage`에
//    둔다.
//
//    **전에는 두지 않았다.** '새로 고치면 구글에 조용히 다시 물어 받으면 된다'고 보았고, 잃어도
//    다시 받을 수 있는 값은 남기지 않는 것이 맞다. 그런데 그 '다시 받기'가 실제로는 자주 실패한다
//    — 크롬의 FedCM 자동 재로그인은 쓰는 사람의 브라우저 설정과 지난 동의에 달려 있어서,
//    새로 고칠 때마다 로그인이 풀린 것처럼 보였다. 다시 받을 수 없는 값이 되었으니 남긴다.
//    대신 **기한을 같이 적어** 지난 것은 쓰지 않고, 로그아웃·401에서 지운다.
// 3. 그 사이 — 로그인하는 순간 익명 토큰으로 넣어 둔 의뢰를 계정으로 **옮기고**
//    (`POST /auth/claim`) 로컬에 있던 익명 토큰을 지운다. 옮기지 않으면 로그인했더니
//    하던 일이 사라진 것처럼 보인다.
import { orchUrl } from "./orch";

export type Account = { email: string; name: string; picture: string };
export type Session = {
  account: Account | null;
  busy: boolean;
  error: string;
  ready: boolean;   // 조용한 로그인 시도를 한 번은 끝냈는가(그 전에는 단추를 그리지 않는다)
  moved: number;    // 로그인하면서 계정으로 옮겨 온 의뢰 수(화면에 한 번 알린다)
  tied: boolean;    // 에이전트에까지 붙었는가. 구글 로그인은 됐는데 에이전트가 꺼져 있을 수 있다
};

const ANON_KEY = "pg.anon";     // 로그인 전 토큰. 자격증명이지만 **버려도 되는** 값이다
const SESS_KEY = "pg.sess";     // 로그인한 토큰 + 기한 + 화면에 쓸 계정
let tok: string | null = null;  // 로그인한 토큰
let cred: string | null = null; // 구글이 준 ID 토큰. 에이전트가 늦게 켜졌을 때 다시 바꿔 보려고 들고 있는다
let retryAt = 0;                // 바꾸기를 다시 시도할 수 있는 시각(실패가 반복될 때 매 요청마다 때리지 않게)
let account: Account | null = null;
let busy = false;
let error = "";
let ready = false;
let moved = 0;

const subs = new Set<() => void>();
const EMPTY: Session = { account: null, busy: false, error: "", ready: false, moved: 0, tied: false };
let snap: Session = EMPTY;
function push(): void {
  snap = { account, busy, error, ready, moved, tied: tok !== null };
  subs.forEach((f) => f());
}
export function subscribeSession(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
export const sessionSnapshot = (): Session => snap;
/** 서버에서 그릴 때 쓰는 값. 브라우저 쪽 첫 그림과 같아야 hydration이 깨지지 않는다 */
export const sessionServerSnapshot = (): Session => EMPTY;

/* ---------- 로그인한 세션을 새로 고쳐도 들고 있는다 ----------
   기한이 지난 것은 아예 읽지 않는다. 서버가 거절할 토큰을 들고 있어 봐야 '로그인한 것처럼
   보이는데 아무것도 안 되는' 상태가 될 뿐이다. */
type Saved = { token: string; exp: number; account: Account };

function readSess(): Saved | null {
  try {
    const v = JSON.parse(localStorage.getItem(SESS_KEY) || "null") as Saved | null;
    if (!v?.token || typeof v.exp !== "number") return null;
    if (v.exp <= Date.now()) { dropSess(); return null; }
    return v;
  } catch { return null; }
}
function writeSess(token: string, seconds: number, who: Account): void {
  // 기한은 서버가 말한 것에서 1분을 뺀다. 딱 맞춰 두면 마지막 요청이 가는 도중에 지난다.
  const exp = Date.now() + Math.max(60, seconds - 60) * 1000;
  try { localStorage.setItem(SESS_KEY, JSON.stringify({ token, exp, account: who })); } catch { /* 막힌 브라우저 */ }
}
function dropSess(): void {
  try { localStorage.removeItem(SESS_KEY); } catch { /* 같음 */ }
}

/* ---------- 로그인 전: 익명 토큰 ---------- */
const readAnon = () => { try { return localStorage.getItem(ANON_KEY) ?? ""; } catch { return ""; } };
const writeAnon = (v: string) => { try { localStorage.setItem(ANON_KEY, v); } catch { /* 저장을 막아 둔 브라우저 */ } };
const dropAnon = () => { try { localStorage.removeItem(ANON_KEY); } catch { /* 같음 */ } };

let anonMint: Promise<string> | null = null;
async function anon(): Promise<string> {
  const have = readAnon();
  if (have) return have;
  if (!anonMint) {
    anonMint = (async () => {
      const r = await fetch(`${orchUrl()}/auth/session`, { method: "POST" });
      if (!r.ok) throw new Error(r.status === 404
        ? "에이전트가 옛 버전입니다. 에이전트를 돌리는 PC에서 다시 켜 주세요"
        : `에이전트에 연결하지 못했습니다(${r.status})`);
      const t = (await r.json())?.data?.token;
      if (typeof t !== "string" || !t) throw new Error("에이전트에 연결하지 못했습니다");
      writeAnon(t);
      return t;
    })();
    void anonMint.catch(() => undefined).then(() => { anonMint = null; });
  }
  return anonMint;
}

/** 요청에 붙일 토큰. 로그인했으면 계정 토큰, 아니면 익명 토큰. **로그인을 요구하지 않는다.**
 *  구글 로그인은 됐는데 에이전트가 꺼져 있어 못 바꿨다면, 여기서 한 번 더 바꿔 본다 —
 *  에이전트를 나중에 켠 사람이 다시 로그인하지 않아도 되게. */
export async function requireToken(): Promise<string> {
  if (tok) return tok;
  if (cred && Date.now() > retryAt) {
    retryAt = Date.now() + 5000;
    await exchange(cred);
    if (tok) return tok;
  }
  return anon();
}

/** 서버가 401을 돌려줬을 때 버린다. 익명 토큰이면 지워서 다음 요청에 새로 받는다. */
export function forgetSession(): void {
  if (tok) { tok = null; account = null; dropSess(); push(); return; }
  dropAnon();
}

/* ---------- 구글 쪽 ---------- */
type Gsi = {
  accounts: {
    id: {
      initialize(o: Record<string, unknown>): void;
      renderButton(el: HTMLElement, o: Record<string, unknown>): void;
      prompt(cb?: (n: unknown) => void): void;
      disableAutoSelect(): void;
    };
  };
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const win = () => window as any;

let loading: Promise<Gsi> | null = null;
function script(): Promise<Gsi> {
  if (!loading) {
    loading = new Promise<Gsi>((ok, no) => {
      if (win().google?.accounts?.id) { ok(win().google); return; }
      const el = document.createElement("script");
      el.src = "https://accounts.google.com/gsi/client";
      el.async = true;
      el.onload = () => (win().google?.accounts?.id ? ok(win().google) : no(new Error("구글 로그인을 불러오지 못했습니다")));
      el.onerror = () => no(new Error("구글 로그인을 불러오지 못했습니다. 네트워크를 확인해 주세요"));
      document.head.appendChild(el);
    });
    loading.catch(() => { loading = null; });   // 다음에 다시 시도할 수 있게
  }
  return loading;
}

/* 클라이언트 ID는 **에이전트에게 묻는다**. 앱은 한 번 배포해 두고 에이전트는 사람마다 자기 PC에서
   켜기 때문이다 — 앱에 박아 두면 다른 사람이 자기 에이전트를 쓸 때 ID를 바꿀 길이 없다.
   앱 쪽 값(NEXT_PUBLIC_GOOGLE_CLIENT_ID)은 에이전트가 답하지 못할 때의 대비책이다. */
const BUILT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
let clientId: Promise<string> | null = null;
function id(): Promise<string> {
  if (!clientId) {
    clientId = fetch(`${orchUrl()}/auth/config`, { signal: AbortSignal.timeout(8000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => String(j?.data?.google_client_id || "") || BUILT_ID)
      .catch(() => BUILT_ID);
  }
  return clientId;
}

let started: string | null = null;  // 어떤 ID로 초기화했는가(주소가 바뀌면 다시 한다)

async function init(): Promise<Gsi> {
  const cid = await id();
  if (!cid) throw new Error("이 에이전트에 구글 로그인이 설정되어 있지 않습니다");
  const g = await script();
  if (started !== cid) {
    g.accounts.id.initialize({
      client_id: cid,
      auto_select: true,            // 전에 로그인한 적이 있으면 조용히 다시 로그인한다
      cancel_on_tap_outside: false,
      use_fedcm_for_prompt: true,   // 크롬이 제3자 쿠키를 막아도 뜨는 길
      callback: (r: { credential?: string }) => { if (r?.credential) void exchange(r.credential); },
    });
    started = cid;
  }
  return g;
}

/** ID 토큰 속을 **표시용으로만** 들여다본다. 서명을 확인하지 않으므로 주인을 가르는 데는 쓸 수 없다 —
 *  그 일은 서버가 구글 공개키로 한다. 여기서 꺼내는 것은 화면에 띄울 이름·사진뿐이다.
 *  이게 필요한 이유: 구글 로그인은 끝났는데 에이전트가 꺼져 있으면, 서버 쪽 값을 받을 길이 없다.
 *  그때도 "로그인했다"는 사실은 화면에 바로 보여야 한다. */
function peek(credential: string): Account | null {
  try {
    const body = credential.split(".")[1];
    const bin = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    const pic = String(json.picture ?? "");
    return { email: String(json.email ?? ""), name: String(json.name ?? ""),
             picture: pic.startsWith("https://") ? pic : "" };
  } catch {
    return null;
  }
}

/** 구글 토큰을 이 앱의 토큰으로 바꾸고, 로그인 전에 하던 일을 계정으로 옮긴다.
 *  구글 토큰은 이 함수 밖으로 나가지 않는다. */
async function exchange(credential: string): Promise<void> {
  cred = credential;
  const shown = peek(credential);
  if (shown) account = shown;      // 구글 쪽은 이미 끝났다. 에이전트 응답을 기다리지 않고 바로 보여 준다
  busy = true; error = ""; push();
  try {
    const r = await fetch(`${orchUrl()}/auth/google`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    if (!r.ok) {
      throw new Error(r.status === 503 ? "이 에이전트에 구글 로그인이 설정되어 있지 않습니다"
        : r.status === 404 ? "에이전트가 옛 버전입니다. 에이전트를 돌리는 PC에서 다시 켜 주세요"
        : r.status === 429 ? "로그인을 너무 자주 했습니다. 잠시 뒤에 다시 해 주세요"
        : `로그인하지 못했습니다(${r.status})`);
    }
    const d = (await r.json())?.data;
    if (!d?.token) throw new Error("로그인하지 못했습니다");
    tok = d.token;
    account = { email: d.email ?? "", name: d.name ?? "", picture: d.picture ?? "" };
    writeSess(d.token, Number(d.expires_in) || 12 * 3600, account);
    moved = await claim();
  } catch (e) {
    // 구글 로그인 자체는 된 것이다. 계정 표시는 남겨 두고 '에이전트에 못 붙었다'만 알린다
    error = e instanceof Error ? e.message : String(e);
    tok = null;
    if (!account) account = shown;
  } finally {
    busy = false; ready = true; prompting = false; push();
  }
}

/** 로그인 전에 넣어 둔 의뢰를 계정으로 옮긴다. 옮기고 나면 로컬의 익명 토큰을 지운다.
 *  옮기지 못해도 로그인은 성공한 것이라, 여기서 실패해도 오류로 올리지 않는다. */
async function claim(): Promise<number> {
  const old = readAnon();
  if (!old || !tok) return 0;
  try {
    const r = await fetch(`${orchUrl()}/auth/claim`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ token: old }),
    });
    if (!r.ok) return 0;
    dropAnon();
    return Number((await r.json())?.data?.moved ?? 0);
  } catch {
    return 0;
  }
}

/** 화면이 열릴 때 한 번, 조용히 로그인을 시도한다. 구글 쪽 로그인이 살아 있으면 아무 일도 일어나지 않는다.
 *  **겹쳐 부르지 않는다** — 브라우저는 자격증명 요청을 한 번에 하나만 받고, 둘째는 NotAllowedError다. */
let prompting = false;
export async function silentSignIn(): Promise<void> {
  if (tok || busy || prompting) return;
  // 새로 고친 것뿐이면 들고 있던 세션을 그대로 쓴다. 구글에 다시 묻지 않으므로 깜빡임도 없고,
  // 브라우저가 자동 재로그인을 막아 두었어도 로그인이 풀리지 않는다.
  const have = readSess();
  if (have) {
    tok = have.token; account = have.account; ready = true; push();
    return;
  }
  prompting = true;
  try {
    const g = await init();
    g.accounts.id.prompt();
    setTimeout(() => { prompting = false; if (!tok && !busy) { ready = true; push(); } }, 2500);
  } catch (e) {
    prompting = false;
    error = e instanceof Error ? e.message : String(e);
    ready = true; push();
  }
}

/** 구글 단추를 이 자리에 그린다. 모양·글씨는 구글이 그린다(직접 그리면 약관 위반이다). */
export async function mountButton(el: HTMLElement): Promise<void> {
  const g = await init();
  el.replaceChildren();
  g.accounts.id.renderButton(el, { type: "standard", theme: "outline", size: "medium",
    text: "signin_with", shape: "square", locale: "ko" });
}

export function signOut(): void {
  try { win().google?.accounts?.id?.disableAutoSelect(); } catch { /* 스크립트가 아직 없을 수 있다 */ }
  dropSess();
  tok = null; cred = null; account = null; error = ""; moved = 0; push();
}

/** '옮겼습니다' 알림을 한 번 보여 주고 끈다. */
export function clearMoved(): void {
  moved = 0; push();
}
