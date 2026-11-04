"""구글이 내준 ID 토큰을 확인하고 "누구인가"만 꺼낸다.

왜 토큰을 두 겹으로 쓰나
    구글 토큰은 **로그인하는 순간 한 번만** 본다. 그 뒤로는 이 앱이 서명한 세션 토큰
    (`pg_agents.auth`)을 쓴다. 구글 토큰을 매 요청마다 들고 다니면 ① 요청마다 구글 공개키를
    확인해야 해서 구글이 느려지면 앱이 통째로 멈추고 ② MCP가 쓰는 토큰과 검사하는 길이 둘로
    갈린다. 한 겹 더 두면 길이 하나로 모인다.

무엇을 확인하나
    서명(구글 공개키·RS256) · 발급자(iss) · **청중(aud)** · 기한(exp) · 이메일 확인 여부.
    이 중 청중 확인이 핵심이다. 그것이 없으면 아무 앱에나 로그인해서 받은 구글 토큰을 그대로
    여기에 들이밀 수 있다. aud가 이 앱의 클라이언트 ID와 같아야만 "이 앱에 로그인한 사람"이다.

클라이언트 ID는 비밀이 아니다
    브라우저가 화면에 들고 다니는 값이라 숨길 수 없고 숨길 이유도 없다. 비밀로 지켜야 하는
    것은 `agents/.data/auth_secret`(세션 토큰 서명 열쇠)뿐이다. 그래서 이 파일은 클라이언트
    비밀번호(client secret)를 쓰지 않는다 — ID 토큰만 받는 방식에는 필요가 없다.
"""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass

# 구글이 토큰에 적는 발급자. 두 꼴을 모두 쓴다
ISSUERS = ("https://accounts.google.com", "accounts.google.com")
CERTS = "https://www.googleapis.com/oauth2/v3/certs"
LEEWAY = 60       # 시계가 어긋난 PC에서 방금 받은 토큰이 '아직 유효하지 않다'로 떨어지는 것을 막는다
MAX_TOKEN = 4096  # 구글 ID 토큰은 1~2KB다. 그보다 크면 읽기 전에 버린다


@dataclass(frozen=True)
class User:
    sub: str      # 구글이 이 계정에 붙인 번호. 이메일과 달리 바뀌지 않는다
    email: str
    name: str
    picture: str


def client_id() -> str:
    """이 앱의 구글 클라이언트 ID. `agents/.env`의 `PG_GOOGLE_CLIENT_ID`에서 읽는다.

    비어 있으면 로그인을 아예 열지 않는다 — 청중을 맞춰 볼 대상이 없으면 아무 앱의 토큰이나
    통과시키게 되기 때문이다. 이때도 **검사는 그대로 된다**(로그인은 선택이다).
    """
    return os.environ.get("PG_GOOGLE_CLIENT_ID", "").strip()


_jwks = None
_lock = threading.Lock()


def _keys():  # noqa: ANN202
    """구글 공개키 꾸러미. 키는 돌아가므로 받아서 캐시하고 한 시간마다 다시 받는다."""
    global _jwks
    with _lock:
        if _jwks is None:
            from jwt import PyJWKClient
            _jwks = PyJWKClient(os.environ.get("PG_GOOGLE_CERTS", CERTS), cache_keys=True, lifespan=3600)
        return _jwks


def forget_keys() -> None:
    """캐시를 비운다(테스트에서 가짜 공개키로 바꿔 끼울 때)."""
    global _jwks
    with _lock:
        _jwks = None


def verify(token: str | None) -> User | None:
    """맞으면 누구인지, 아니면 None. **왜 틀렸는지는 돌려주지 않는다** — 바깥에서 토큰을 고쳐
    가며 찔러 볼 때 어디가 틀렸는지 알려 주는 셈이 된다."""
    aud = client_id()
    if not token or not aud or len(token) > MAX_TOKEN:
        return None
    try:
        import jwt
        key = _keys().get_signing_key_from_jwt(token).key
        c = jwt.decode(token, key, algorithms=["RS256"], audience=aud, leeway=LEEWAY,
                       options={"require": ["exp", "iat", "aud", "iss", "sub"]})
    except Exception:  # noqa: BLE001 — 서명·기한·청중 무엇이 틀렸든 답은 하나다
        return None
    if c.get("iss") not in ISSUERS:
        return None
    # 구글이 확인하지 않은 이메일은 남의 것일 수 있다. 주인을 가르는 값으로 쓰지 않는다
    if c.get("email") and c.get("email_verified") is False:
        return None
    sub = str(c.get("sub") or "")
    if not sub:
        return None
    pic = str(c.get("picture") or "")
    return User(sub=sub, email=str(c.get("email") or "")[:120], name=str(c.get("name") or "")[:60],
                picture=pic[:300] if pic.startswith("https://") else "")
