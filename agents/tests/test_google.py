"""구글 ID 토큰 확인 — 무엇을 통과시키고 무엇을 막는가.

네트워크를 쓰지 않는다. 테스트 안에서 RSA 열쇠를 하나 만들어 "구글인 척" 서명하고, 공개키
꾸러미를 그 열쇠로 바꿔 끼운다. 그래서 여기서 확인하는 것은 **주장(claims) 검사**다 —
청중(aud)·발급자(iss)·기한·서명·알고리즘.

가장 중요한 칸은 `test_other_app_token_is_refused`다. 청중을 보지 않으면 아무 앱에나
로그인해서 받은 구글 토큰을 그대로 여기에 들이밀 수 있다.
"""
import base64
import hashlib
import hmac
import json
import os
import time
from types import SimpleNamespace

os.environ["PG_FAKE_AGENTS"] = "1"
os.environ["PG_GOOGLE_CLIENT_ID"] = "test-client.apps.googleusercontent.com"

import jwt  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from pg_agents import google  # noqa: E402
from pg_agents.auth import verify  # noqa: E402
from pg_agents.orchestrator.app import app  # noqa: E402

AUD = "test-client.apps.googleusercontent.com"
_b64 = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")  # noqa: E731
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class _Jwks:
    """구글 공개키 꾸러미인 척한다. 늘 같은 공개키 하나를 돌려준다."""

    def __init__(self, key):  # noqa: ANN001
        self._k = key

    def get_signing_key_from_jwt(self, _token):  # noqa: ANN001, ANN201
        return SimpleNamespace(key=self._k)


def setup_module() -> None:
    google._jwks = _Jwks(KEY.public_key())


def teardown_module() -> None:
    google.forget_keys()
    os.environ.pop("PG_GOOGLE_CLIENT_ID", None)


def tok(key=KEY, **over) -> str:  # noqa: ANN001, ANN003
    now = int(time.time())
    body = {"iss": "https://accounts.google.com", "aud": AUD, "sub": "1234567890",
            "email": "a@example.com", "email_verified": True, "name": "홍길동",
            "picture": "https://lh3.googleusercontent.com/a/x", "iat": now, "exp": now + 3600}
    body.update(over)
    return jwt.encode(body, key, algorithm="RS256")


# ---------- 통과해야 하는 것 ----------
def test_valid_token_gives_the_account():
    u = google.verify(tok())
    assert u and u.sub == "1234567890" and u.email == "a@example.com" and u.name == "홍길동"


def test_bare_issuer_form_is_accepted():
    """구글은 iss를 'accounts.google.com'으로도 적는다. 둘 다 받아야 한다."""
    assert google.verify(tok(iss="accounts.google.com")) is not None


def test_email_without_verified_flag_passes():
    """확인 표시가 아예 없는 토큰까지 막으면 멀쩡한 계정이 못 들어온다. 거짓일 때만 막는다."""
    body = {"email_verified": None}
    assert google.verify(tok(**body)) is not None


# ---------- 막아야 하는 것 ----------
def test_other_app_token_is_refused():
    """이 테스트가 청중(aud) 검사의 이유다 — 다른 앱에 로그인해 받은 토큰은 통하지 않는다."""
    assert google.verify(tok(aud="someone-else.apps.googleusercontent.com")) is None


def test_other_key_refused():
    assert google.verify(tok(key=OTHER)) is None


def test_wrong_issuer_refused():
    assert google.verify(tok(iss="https://evil.example.com")) is None


def test_expired_refused():
    now = int(time.time())
    assert google.verify(tok(iat=now - 7200, exp=now - 3600)) is None


def test_unverified_email_refused():
    assert google.verify(tok(email_verified=False)) is None


def _hand_made(alg: str, sig: bytes) -> str:
    """토큰을 손으로 짠다. 라이브러리는 이런 토큰을 만들어 주지 않아서(그게 맞다) 직접 만든다."""
    now = int(time.time())
    head = _b64(json.dumps({"alg": alg, "typ": "JWT"}).encode())
    body = _b64(json.dumps({"iss": "https://accounts.google.com", "aud": AUD, "sub": "x",
                            "iat": now, "exp": now + 3600}).encode())
    return f"{head}.{body}.{_b64(sig) if sig else ''}"


def test_algorithm_confusion_refused():
    """공개키를 HMAC 비밀로 삼아 서명하는 고전적인 수법. 알고리즘을 RS256으로 못 박아 막는다."""
    from cryptography.hazmat.primitives import serialization
    pub = KEY.public_key().public_bytes(serialization.Encoding.PEM,
                                        serialization.PublicFormat.SubjectPublicKeyInfo)
    now = int(time.time())
    head = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = _b64(json.dumps({"iss": "https://accounts.google.com", "aud": AUD, "sub": "x",
                            "iat": now, "exp": now + 3600}).encode())
    sig = hmac.new(pub, f"{head}.{body}".encode(), hashlib.sha256).digest()
    assert google.verify(f"{head}.{body}.{_b64(sig)}") is None


def test_unsigned_token_refused():
    """서명을 아예 빼고 alg를 none이라고 적은 토큰."""
    assert google.verify(_hand_made("none", b"")) is None


def test_malformed_refused():
    for bad in ("", None, "a.b.c", "x" * 5000):
        assert google.verify(bad) is None, f"{str(bad)[:20]}이 통했다"


def test_no_client_id_means_no_login():
    """클라이언트 ID가 없으면 청중을 맞춰 볼 대상이 없다. 그때는 아무 토큰도 통과시키지 않는다."""
    os.environ["PG_GOOGLE_CLIENT_ID"] = ""
    try:
        assert google.verify(tok()) is None
    finally:
        os.environ["PG_GOOGLE_CLIENT_ID"] = AUD


# ---------- 오케스트레이터 ----------
def test_login_gives_a_usable_session_token():
    with TestClient(app) as c:
        r = c.post("/auth/google", json={"credential": tok()})
        assert r.status_code == 200
        d = r.json()["data"]
        claims = verify(d["token"])
        assert claims and claims.kind == "browser" and claims.write is True
        assert d["email"] == "a@example.com" and d["expires_in"] > 0
        # 받은 토큰으로 바로 의뢰를 넣을 수 있다
        h = {"Authorization": f"Bearer {d['token']}"}
        job = c.post("/jobs", files={"file": ("a.pdf", b"%PDF-1.4\n% fake\n", "application/pdf")},
                     data={"options": "{}"}, headers=h)
        assert job.status_code == 200
        assert c.get("/jobs", headers=h).json()["data"]


def test_same_account_comes_back_as_the_same_owner():
    """다시 로그인하면 같은 주인이어야 한다. 그래야 브라우저가 토큰을 저장할 필요가 없다."""
    with TestClient(app) as c:
        a = verify(c.post("/auth/google", json={"credential": tok()}).json()["data"]["token"])
        b = verify(c.post("/auth/google", json={"credential": tok()}).json()["data"]["token"])
    assert a and b and a.subject == b.subject


def test_owner_name_does_not_leak_the_google_id():
    """주인 이름은 로그와 의뢰 기록에 남는다. 구글 계정 번호를 그대로 쓰면 그것까지 같이 남는다."""
    with TestClient(app) as c:
        claims = verify(c.post("/auth/google", json={"credential": tok()}).json()["data"]["token"])
    assert claims and "1234567890" not in claims.subject


def test_bad_credential_is_401():
    with TestClient(app) as c:
        assert c.post("/auth/google", json={"credential": tok(key=OTHER)}).status_code == 401
        assert c.post("/auth/google", json={}).status_code == 401


def test_config_tells_the_browser_which_client_id():
    with TestClient(app) as c:
        assert c.get("/auth/config").json()["data"]["google_client_id"] == AUD


def test_no_client_id_is_503_not_401():
    """'설정이 없다'와 '로그인이 틀렸다'를 가른다. 뭉개면 설정을 빼먹은 사람이 영원히 헤맨다."""
    os.environ["PG_GOOGLE_CLIENT_ID"] = ""
    try:
        with TestClient(app) as c:
            assert c.post("/auth/google", json={"credential": tok()}).status_code == 503
    finally:
        os.environ["PG_GOOGLE_CLIENT_ID"] = AUD
