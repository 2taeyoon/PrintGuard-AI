"""LangSmith 내보내기 테스트: 키가 없으면 아무것도 보내지 않고, 보낼 때는 추적에 있는 것만 보낸다(가짜 client)."""
import os
import tempfile

os.environ.setdefault("PG_DATA_DIR", tempfile.mkdtemp())

from pg_agents.langsmith_export import export_trace  # noqa: E402
from tests.test_tracing import at, put  # noqa: E402  같은 방식으로 공통 로그에 줄을 넣는다


class FakeClient:
    def __init__(self):
        self.runs = []

    def create_run(self, name, inputs, run_type, **kw):
        self.runs.append({"name": name, "inputs": inputs, "run_type": run_type, **kw})


def seed(ctx):
    put(ctx, at(0), "job_opened", "orchestrator", payload={"agents": ["preflight"]})
    put(ctx, at(100), "request_received", "preflight", requester="orchestrator", skill="check_structure")
    put(ctx, at(400), "result_sent", "preflight", requester="orchestrator", skill="check_structure", status="completed", grade="read")
    put(ctx, at(500), "request_received", "shop", requester="orchestrator", skill="request_quote")
    put(ctx, at(700), "result_sent", "shop", requester="orchestrator", skill="request_quote", status="rejected", outcome="SAFETY_REJECTED", grade="B")
    put(ctx, at(800), "safety_decision", "safety", requester="shop", skill="shop.request_quote", status="rejected", grade="B",
        payload={"reason": "교차 검증 실패", "amount": 1000, "review_id": None, "execution_id": "ex_1"})
    put(ctx, at(900), "request_received", "guide", requester="orchestrator", skill="search_guide")  # 끝나지 않은 구간


def test_no_key_sends_nothing(monkeypatch):
    monkeypatch.delenv("LANGSMITH_API_KEY", raising=False)
    r = export_trace("ctx_job_ls1")
    assert r["exported"] == 0 and "LANGSMITH_API_KEY" in r["reason"]


def test_unknown_job_sends_nothing():
    c = FakeClient()
    assert export_trace("ctx_job_없는것", client=c)["exported"] == 0
    assert c.runs == []


def test_sends_root_and_finished_spans():
    ctx = "ctx_job_ls2"
    seed(ctx)
    c = FakeClient()
    r = export_trace(ctx, project="테스트", client=c)
    assert r["exported"] == 3 and r["skipped_open_spans"] == 1  # 루트 + 끝난 구간 2개, 열린 구간은 제외
    root, *spans = c.runs
    assert root["run_type"] == "chain" and root["project_name"] == "테스트"
    assert root["outputs"]["log_lines"] == 7 and len(root["outputs"]["gates"]) == 1
    assert [s["name"] for s in spans] == ["preflight.check_structure", "shop.request_quote"]
    assert all(s["parent_run_id"] == root["id"] for s in spans)
    assert (spans[0]["end_time"] - spans[0]["start_time"]).total_seconds() == 0.3
    assert spans[0]["error"] is None and spans[1]["error"] == "SAFETY_REJECTED"


def test_same_job_keeps_same_run_ids():
    ctx = "ctx_job_ls3"
    seed(ctx)
    a, b = FakeClient(), FakeClient()
    export_trace(ctx, client=a)
    export_trace(ctx, client=b)
    assert [x["id"] for x in a.runs] == [x["id"] for x in b.runs]  # 다시 보내도 중복 run이 생기지 않는다


def test_sends_no_document_text():
    """공통 로그에 본문이 없으므로 내보내는 값에도 없다(회귀 방지)."""
    ctx = "ctx_job_ls4"
    seed(ctx)
    c = FakeClient()
    export_trace(ctx, client=c)
    blob = repr(c.runs)
    assert "texts" not in blob and "pdf" not in blob.lower()
