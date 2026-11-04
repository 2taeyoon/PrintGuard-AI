// 구글 로그인. 에이전트 검사(남의 PC에 파일을 올리는 쪽)는 이 로그인을 통과해야 쓸 수 있다.
// '바로 검사'는 전부 이 브라우저 안에서 끝나므로 로그인과 아무 상관이 없다.
//
// ── 토큰을 어디에 두는가 ──────────────────────────────────────────────────────
// **아무 데도 두지 않는다.** 이 모듈의 `tok`은 그냥 변수라 새로 고치면 사라진다.
//
// 전에는 세션 토큰을 sessionStorage에 넣었다. 그 전에는 브라우저가 직접 만든 값을
// localStorage에 넣었다. 둘 다 "토큰을 잃으면 지난 의뢰를 못 찾는다"가 전제였고, 그래서
// 어딘가에 남겨 두어야 했다. 로그인이 생기면서 그 전제가 사라졌다 — 토큰을 잃어도 다시
// 로그인하면 **같은 주인**으로 돌아오고, 서버는 그 주인의 의뢰를 그대로 돌려준다.
// 남길 이유가 없어진 값은 남기지 않는 쪽이 맞다.
//
// 새로 고치면 구글에 조용히 한 번 다시 묻는다(자동 선택). 구글 쪽 로그인이 살아 있으면
// 사람 눈에는 아무 일도 일어나지 않고, 아니면 로그인 단추가 뜬다.
import { orchUrl } from "./orch";

export type Account = { email: string; name: string; picture: string };
export type Session = { account: Account | null; busy: boolean; error: string; ready: boolean };

/** 로그인이 필요한데 안 되어 있을 때 던지는 오류.
 *  값 자체를 사람이 읽을 말로 둔다 — 어딘가에서 이 오류를 그대로 화면에 찍어도 영문 코드가 뜨지 않게. */
export const NEED_SIGN_IN = "구글로 로그인해야 쓸 수 있습니다";

let tok: string | null = null;      // 이 페이지가 살아 있는 동안만. 어떤 저장소에도 넣지 않는다
let account: Account | null = null;
let busy = false;
let error = "";
let ready = false;                  // 조용한 로그인 시도를 한 번은 끝냈는가(그 전에는 단추를 그리지 않는다)

const subs = new Set<() => void>();
let snap: Session = { account: null, busy: false, error: "", ready: false };
function push(): void {
  snap = { account, busy, error, ready };
  subs.forEach((f) => f());
}
export function subscribeSession(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
export const sessionSnapshot = (): Session => snap;
/** 서버에서 그릴 때 쓰는 값. 브라우저 쪽과 같은 모양이어야 hydration이 깨지지 않는다 */
export const sessionServerSnapshot = (): Session => EMPTY;
const EMPTY: Session = { account: null, busy: false, error: "", ready: false };

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
   앱에 박아 둔 값(NEXT_PUBLIC_GOOGLE_CLIENT_ID)은 에이전트가 답하지 못할 때의 대비책이다. */
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
let waiting: ((t: string) => void)[] = [];

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

/** 구글 토큰을 이 앱의 세션 토큰으로 바꾼다. 구글 토큰은 이 함수 밖으로 나가지 않는다. */
async function exchange(credential: string): Promise<void> {
  busy = true; error = ""; push();
  try {
    const r = await fetch(`${orchUrl()}/auth/google`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    if (!r.ok) {
      const msg = r.status === 503 ? "이 에이전트에 구글 로그인이 설정되어 있지 않습니다"
        : r.status === 404 ? "에이전트가 옛 버전입니다. 에이전트를 돌리는 PC에서 다시 켜 주세요"
        : r.status === 429 ? "로그인을 너무 자주 했습니다. 잠시 뒤에 다시 해 주세요"
        : `로그인하지 못했습니다(${r.status})`;
      throw new Error(msg);
    }
    const d = (await r.json())?.data;
    if (!d?.token) throw new Error("로그인하지 못했습니다");
    tok = d.token;
    account = { email: d.email ?? "", name: d.name ?? "", picture: d.picture ?? "" };
    const take = waiting; waiting = [];
    take.forEach((f) => f(tok as string));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    tok = null; account = null;
  } finally {
    busy = false; ready = true; prompting = false; push();
  }
}

/** 화면이 뜰 때 한 번. 구글 쪽 로그인이 살아 있으면 사람 눈에 아무 일도 일어나지 않는다.
 *  **겹쳐 부르지 않는다** — 브라우저는 자격증명 요청을 한 번에 하나만 받고, 둘째 요청은
 *  NotAllowedError로 떨어진다(화면이 뜰 때와 첫 요청이 거의 동시에 부른다). */
let prompting = false;
export async function silentSignIn(): Promise<void> {
  if (tok || busy || prompting) return;
  prompting = true;
  try {
    const g = await init();
    g.accounts.id.prompt();
    // 조용한 시도는 실패해도 오류가 아니다. 단추를 그리면 그만이다
    setTimeout(() => { prompting = false; if (!tok && !busy) { ready = true; push(); } }, 2500);
  } catch (e) {
    prompting = false;
    error = e instanceof Error ? e.message : String(e);
    ready = true; push();
  }
}

/** 구글 단추를 이 자리에 그린다. 단추 모양·글씨는 구글이 그린다(직접 그리면 약관 위반이다). */
export async function mountButton(el: HTMLElement): Promise<void> {
  const g = await init();
  el.replaceChildren();
  g.accounts.id.renderButton(el, { type: "standard", theme: "outline", size: "large",
    text: "signin_with", shape: "square", locale: "ko", width: 240 });
}

export function signOut(): void {
  try { win().google?.accounts?.id?.disableAutoSelect(); } catch { /* 스크립트가 아직 없을 수 있다 */ }
  tok = null; account = null; error = ""; push();
}

/** 지금 들고 있는 토큰(없으면 null). 요청을 보낼 때만 쓴다. */
export const token = (): string | null => tok;

/** 토큰을 버린다(서버가 401을 돌려줬을 때). */
export function forgetSession(): void {
  tok = null; account = null; push();
}

/** 요청에 붙일 토큰. 없으면 조용히 한 번 더 시도하고, 그래도 없으면 로그인하라고 알린다. */
export async function requireToken(): Promise<string> {
  if (tok) return tok;
  let mine!: (t: string) => void;
  const wait = new Promise<string>((ok) => { mine = ok; waiting.push(mine); });
  void silentSignIn();
  const got = await Promise.race([wait, new Promise<null>((ok) => setTimeout(() => ok(null), 5000))]);
  waiting = waiting.filter((f) => f !== mine);
  if (typeof got === "string") return got;
  throw new Error(NEED_SIGN_IN);
}
