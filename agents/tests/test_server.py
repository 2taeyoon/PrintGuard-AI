"""공통 뼈대(create_agent_app) 수신 검사: 카드, 토큰, 루프, 홉, 권한, 마감, 결과 검증."""
import os
from datetime import timedelta

from fastapi.testclient import TestClient

from pg_agents.contracts import AgentCard, now_utc
from pg_agents.server import create_agent_app

CARD = AgentCard.model_validate({"name": "dummy", "description": "테스트", "url": "http://x", "skills": [
    {"id": "echo", "description": "에코", "grade": "read", "allowed_requesters": ["orchestrator"]},
    {"id": "bad", "description": "깨진 결과", "grade": "read", "allowed_requesters": ["orchestrator"]}]})


async def echo(req):
    return {"status": "completed", "output": {"got": req.input}}


async def bad(req):
    return {"status": "input-required"}  # reason_code·question 없음 → INVALID_OUTPUT


client = TestClient(create_agent_app(CARD, {"echo": echo, "bad": bad}))


def req(skill="echo", token="mock:orchestrator", path=None, seconds=30, ctx="ctx_job_t"):
    return {"meta": {"context_id": ctx, "token": token, "path": path or [], "deadline": (now_utc() + timedelta(seconds=seconds)).isoformat()},
            "skill": skill, "input": {"a": 1}}


def post(body):
    return client.post("/a2a", json=body).json()


def test_card_and_health():
    assert client.get("/.well-known/agent-card.json").json()["name"] == "dummy"
    assert client.get("/health").json()["data"]["status"] == "ok"


def test_ok_and_requester_from_token():
    r = post(req())
    assert r["status"] == "completed" and r["output"]["got"] == {"a": 1} and r["meta"]["requester"] == "orchestrator"


def test_unauthorized_token():
    assert post(req(token="bogus"))["outcome"] == "UNAUTHORIZED"


def test_loop_and_hop_limit():
    assert post(req(path=["orchestrator", "dummy"]))["outcome"] == "LOOP_DETECTED"
    assert post(req(path=["a", "b", "c", "d"]))["outcome"] == "HOP_LIMIT"


def test_forbidden_requester():
    assert post(req(token="mock:shop"))["outcome"] == "FORBIDDEN_SKILL"


def test_deadline_passed():
    r = post(req(seconds=-1))
    assert r["status"] == "canceled" and r["outcome"] == "TIMEOUT"


def test_invalid_output_and_unknown_skill():
    assert post(req(skill="bad"))["outcome"] == "INVALID_OUTPUT"
    assert post(req(skill="nope"))["outcome"] == "UNKNOWN_SKILL"


def test_card_rules():
    import pytest
    with pytest.raises(ValueError):
        AgentCard.model_validate({"name": "a", "description": "", "url": "x", "skills": [
            {"id": "s", "description": "", "grade": "B", "allowed_requesters": []}]})  # B인데 verifier 없음
    with pytest.raises(ValueError):
        AgentCard.model_validate({"name": "a", "description": "", "url": "x", "skills": [
            {"id": "s", "description": "", "grade": "B", "allowed_requesters": [], "verifier": "a"}]})  # 자기 검증


# ---------- .env 읽기 ----------
def test_load_env_files(tmp_path, monkeypatch):
    """.env의 값을 올리되 이미 설정된 환경변수는 건드리지 않는다. 주석·따옴표·export를 처리하고 빈 값은 설정하지 않는다."""
    from pg_agents.config import load_env_files
    f = tmp_path / ".env"
    f.write_text("# 주석\n\nPG_T_A=1\nPG_T_B=\"큰 따옴표\"\nexport PG_T_C='작은'\nPG_T_D=\nPG_T_EXISTING=env파일값\n망한줄\n", encoding="utf-8")
    monkeypatch.setenv("PG_T_EXISTING", "터미널값")
    for k in ("PG_T_A", "PG_T_B", "PG_T_C", "PG_T_D"):
        monkeypatch.delenv(k, raising=False)

    assert load_env_files((f,)) == [str(f)]
    assert os.environ["PG_T_A"] == "1"
    assert os.environ["PG_T_B"] == "큰 따옴표"
    assert os.environ["PG_T_C"] == "작은"
    assert "PG_T_D" not in os.environ  # 빈 값(KEY=)은 설정하지 않는다 — 다음 .env의 실제 값을 가리지 않게
    assert os.environ["PG_T_EXISTING"] == "터미널값"  # 터미널이 이긴다


def test_load_env_files_without_file(tmp_path):
    from pg_agents.config import load_env_files
    assert load_env_files((tmp_path / "없는.env",)) == []


def test_root_explains_itself():
    """포트를 브라우저로 열어 본 사람에게 여기가 API라는 것과 skill 목록을 알려 준다."""
    r = client.get("/").json()["data"]
    assert r["agent"] == "dummy" and "127.0.0.1:8752" in r["note"]
    assert [s["id"] for s in r["skills"]] == ["echo", "bad"]
    assert "POST /a2a" in r["endpoints"]
