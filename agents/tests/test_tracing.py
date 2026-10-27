"""추적(build_trace) 테스트: 요청↔결과 짝으로 구간 만들기, 끝나지 않은 구간, 관문·사건 모으기."""
import os
import sqlite3
import tempfile

os.environ.setdefault("PG_DATA_DIR", tempfile.mkdtemp())

from pg_agents import common_log  # noqa: E402
from pg_agents.tracing import build_trace  # noqa: E402

T0 = "2026-10-27T09:00:00.000+00:00"


def put(ctx, at, kind, source, **f):
    """공통 로그에 시각을 지정해 한 줄 넣는다(log_event는 지금 시각만 쓴다)."""
    with common_log._conn() as c:
        c.execute("INSERT INTO common_log(at,context_id,kind,source,requester,skill,status,outcome,grade,payload) VALUES (?,?,?,?,?,?,?,?,?,?)",
                  (at, ctx, kind, source, f.get("requester"), f.get("skill"), f.get("status"), f.get("outcome"), f.get("grade"),
                   __import__("json").dumps(f.get("payload") or {}, ensure_ascii=False)))


def at(ms):
    return f"2026-10-27T09:00:{ms // 1000:02d}.{ms % 1000:03d}+00:00"


def test_spans_pair_request_and_result():
    ctx = "ctx_job_trace1"
    put(ctx, at(0), "job_opened", "orchestrator", payload={"agents": ["preflight"]})
    put(ctx, at(100), "request_received", "preflight", requester="orchestrator", skill="check_structure")
    put(ctx, at(400), "result_sent", "preflight", requester="orchestrator", skill="check_structure", status="completed", grade="read")
    put(ctx, at(500), "job_closed", "orchestrator", status="completed")

    t = build_trace(ctx)
    assert t["t0"] == at(0) and t["total_ms"] == 500 and t["lines"] == 4
    (span,) = t["spans"]
    assert span["agent"] == "preflight" and span["skill"] == "check_structure" and span["requester"] == "orchestrator"
    assert (span["start_ms"], span["end_ms"], span["ms"]) == (100, 400, 300)
    assert span["status"] == "completed" and span["open"] is False
    assert t["agents"] == [{"agent": "preflight", "calls": 1, "ms": 300, "open": 0}]
    assert [e["kind"] for e in t["events"]] == ["job_opened", "job_closed"]


def test_unfinished_span_stays_open():
    ctx = "ctx_job_trace2"
    put(ctx, at(0), "request_received", "guide", requester="orchestrator", skill="search_guide")
    t = build_trace(ctx)
    (span,) = t["spans"]
    assert span["open"] is True and span["ms"] is None and span["status"] == "working"
    assert t["agents"][0]["open"] == 1


def test_parallel_calls_to_same_agent_pair_in_order():
    ctx = "ctx_job_trace3"
    put(ctx, at(0), "request_received", "paper", requester="orchestrator", skill="recommend_paper")
    put(ctx, at(10), "request_received", "paper", requester="orchestrator", skill="assess_risk")
    put(ctx, at(200), "result_sent", "paper", requester="orchestrator", skill="assess_risk", status="completed")
    put(ctx, at(300), "result_sent", "paper", requester="orchestrator", skill="recommend_paper", status="input-required")
    t = build_trace(ctx)
    got = {(s["skill"], s["start_ms"], s["ms"], s["status"]) for s in t["spans"]}
    assert got == {("recommend_paper", 0, 300, "input-required"), ("assess_risk", 10, 190, "completed")}
    assert t["agents"] == [{"agent": "paper", "calls": 2, "ms": 490, "open": 0}]


def test_gates_and_failed_call():
    ctx = "ctx_job_trace4"
    put(ctx, at(0), "safety_decision", "safety", requester="shop", skill="shop.place_order", status="pending_review", grade="C",
        payload={"reason": "C 등급: 사람 승인 필요", "amount": 123456, "review_id": "rv_1", "execution_id": "ex_1"})
    put(ctx, at(50), "human_review", "safety", requester="human:web-user", skill="shop.place_order", status="approved", grade="C",
        payload={"review_id": "rv_1", "amount": 123456})
    put(ctx, at(80), "task_status", "orchestrator", skill="predict_color", status="failed", outcome="unreachable", payload={"target": "color"})
    t = build_trace(ctx)
    assert [(g["kind"], g["decision"], g["grade"], g["amount"], g["review_id"]) for g in t["gates"]] == [
        ("safety_decision", "pending_review", "C", 123456, "rv_1"), ("human_review", "approved", "C", 123456, "rv_1")]
    assert t["spans"] == [] and [e["outcome"] for e in t["events"]] == ["unreachable"]


def test_result_without_request_is_zero_length():
    ctx = "ctx_job_trace5"
    put(ctx, at(0), "result_sent", "color", requester="orchestrator", skill="predict_color", status="completed")
    (span,) = build_trace(ctx)["spans"]
    assert span["ms"] == 0 and span["unpaired"] is True and span["open"] is False


def test_empty_trace():
    t = build_trace("ctx_job_없음")
    assert t == {"context_id": "ctx_job_없음", "t0": None, "total_ms": 0, "spans": [], "gates": [], "events": [], "agents": [], "lines": 0}


def test_db_is_the_common_log():
    """추적은 공통 로그만 읽는다(따로 저장하지 않는다)."""
    assert sqlite3.connect(common_log.LOG_DB).execute("SELECT count(*) FROM common_log").fetchone()[0] > 0
