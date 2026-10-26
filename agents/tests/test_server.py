"""공통 뼈대(create_agent_app) 수신 검사: 카드, 토큰, 루프, 홉, 권한, 마감, 결과 검증."""
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
