"""서버가 발급해 서명하는 토큰: 발급·검증·위조·기한·권한, 그리고 오케스트레이터의 세션 발급.

여기서 지키려는 것은 하나다 — **클라이언트가 스스로 만든 값은 통하지 않는다.** 전에는 브라우저가
`crypto.randomUUID()`로 만든 값을 그대로 주인 표시로 썼다. 그 회귀를 막는 것이 이 파일의 핵심이다.
"""
import base64
import json
import os
import time

os.environ["PG_FAKE_AGENTS"] = "1"

from fastapi.testclient import TestClient  # noqa: E402

from pg_agents import auth  # noqa: E402
from pg_agents.auth import bearer, mint, verify  # noqa: E402
from pg_agents.orchestrator.app import app  # noqa: E402

PDF = b"%PDF-1.4\n% fake\n"


def _parts(token: str) -> tuple[str, dict, str]:
    ver, payload, sig = token.split(".")
    body = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    return ver, body, sig


def _repack(body: dict, sig: str) -> str:
    payload = base64.urlsafe_b64encode(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).decode().rstrip("=")
    return f"pg1.{payload}.{sig}"


# ---------- 발급·검증 ----------
def test_round_trip_keeps_subject_and_kind():
    t = mint("browser", subject="sub-1", label="탭")
    c = verify(t)
    assert c and c.kind == "browser" and c.subject == "sub-1" and c.label == "탭"
    assert c.expires > time.time()


def test_subject_is_random_when_not_given():
    a, b = verify(mint("browser")), verify(mint("browser"))
    assert a and b and a.subject != b.subject  # 세션마다 다른 주인


def test_write_defaults_browser_yes_mcp_no():
    """브라우저는 사람이 직접 몰고 있으니 쓰기까지, MCP 토큰은 달라고 해야 준다."""
    assert verify(mint("browser")).write is True
    assert verify(mint("mcp")).write is False
    assert verify(mint("mcp", write=True)).write is True


def test_unknown_kind_refused_at_mint():
    try:
        mint("admin")
    except ValueError:
        return
    raise AssertionError("모르는 종류를 발급했다")


# ---------- 위조 ----------
def test_self_issued_value_is_refused():
    """이 테스트가 이 변경의 이유다. 전에는 이런 값이 그대로 주인 표시로 통했다."""
    assert verify("3f8c2b1a-7d4e-4c9a-9f21-5b6e8a0d1c33") is None
    assert verify("pg1.eyJrIjoiYnJvd3NlciJ9.aaaa") is None


def test_payload_tamper_breaks_signature():
    """권한·주인·기한을 고쳐도 서명이 맞지 않으면 통하지 않는다."""
    t = mint("mcp", subject="reader", write=False)
    _, body, sig = _parts(t)
    for key, val in (("w", True), ("s", "someone-else"), ("e", int(time.time()) + 10**7), ("k", "browser")):
        bad = dict(body)
        bad[key] = val
        assert verify(_repack(bad, sig)) is None, f"{key}를 고친 토큰이 통했다"


def test_signature_tamper_refused():
    t = mint("browser")
    ver, payload, sig = t.split(".")
    assert verify(f"{ver}.{payload}.{sig[:-2]}xx") is None
    assert verify(f"{ver}.{payload}.") is None


def test_other_secret_refused():
    """다른 비밀로 서명한 토큰은 통하지 않는다(비밀 파일을 지우는 것이 전체 회수 수단이다)."""
    try:
        os.environ["PG_AUTH_SECRET"] = "secret-A"
        auth.forget_secret()
        made = mint("mcp")
        os.environ["PG_AUTH_SECRET"] = "secret-B"
        auth.forget_secret()
        assert verify(made) is None
    finally:
        os.environ.pop("PG_AUTH_SECRET", None)
        auth.forget_secret()


def test_expired_refused():
    assert verify(mint("browser", hours=-1)) is None


def test_malformed_refused():
    for bad in ("", None, "pg1", "pg1.a", "pg2.a.b", "a.b.c", "pg1..", "x" * 2000):
        assert verify(bad) is None, f"{str(bad)[:20]}이 통했다"


def test_bearer_parsing():
    assert bearer("Bearer abc") == "abc"
    assert bearer("bearer  abc ") == "abc"
    assert bearer("Basic abc") is None
    assert bearer("abc") is None
    assert bearer(None) is None
    assert bearer("Bearer ") is None


# ---------- 오케스트레이터 ----------
def test_session_endpoint_issues_usable_token():
    with TestClient(app) as c:
        r = c.post("/auth/session")
        assert r.status_code == 200
        data = r.json()["data"]
        claims = verify(data["token"])
        assert claims and claims.kind == "browser" and data["expires_in"] > 0
        # 받은 토큰으로 바로 의뢰를 넣을 수 있다
        h = {"Authorization": f"Bearer {data['token']}"}
        job = c.post("/jobs", files={"file": ("a.pdf", PDF, "application/pdf")}, data={"options": "{}"}, headers=h)
        assert job.status_code == 200
        assert c.get("/jobs", headers=h).json()["data"]


def test_no_token_sees_nothing_but_bad_token_says_so():
    """없는 것과 틀린 것을 가른다. 뭉개면 만료된 탭이 '의뢰가 없다'만 보고 영원히 멈춘다."""
    with TestClient(app) as c:
        assert c.get("/jobs").json()["data"] == []                    # 토큰 없음 → 빈 목록
        bad = {"Authorization": "Bearer pg1.deadbeef.cafe"}
        assert c.get("/jobs", headers=bad).status_code == 401         # 틀림 → 401
        assert c.get("/jobs/ctx_job_whatever", headers=bad).status_code == 401
        expired = {"Authorization": f"Bearer {mint('browser', hours=-1)}"}
        assert c.get("/jobs", headers=expired).status_code == 401


def test_read_only_token_cannot_write_report():
    """조회용으로 발급한 MCP 토큰은 파일을 남기지 못한다(A 등급 쓰기)."""
    ro = mint("mcp", subject="ro-client", write=False)
    with TestClient(app, headers={"Authorization": f"Bearer {ro}"}) as c:
        ctx = c.post("/jobs", files={"file": ("a.pdf", PDF, "application/pdf")},
                     data={"options": "{}"}).json()["data"]["context_id"]
        r = c.post(f"/jobs/{ctx}/report")
        assert r.status_code == 403 and "조회만" in r.json()["detail"]
    rw = mint("mcp", subject="ro-client", write=True)  # 같은 주인, 쓰기 토큰 → 권한으로 막히지 않는다
    with TestClient(app, headers={"Authorization": f"Bearer {rw}"}) as c:
        assert c.post(f"/jobs/{ctx}/report").status_code != 403


def test_context_id_is_not_guessable():
    """의뢰 번호는 URL·로그에 실려 다닌다. 32비트짜리는 찍어 볼 수 있다."""
    with TestClient(app, headers={"Authorization": f"Bearer {mint('browser')}"}) as c:
        ctx = c.post("/jobs", files={"file": ("a.pdf", PDF, "application/pdf")},
                     data={"options": "{}"}).json()["data"]["context_id"]
    assert len(ctx.removeprefix("ctx_job_")) >= 24  # 96비트 이상
