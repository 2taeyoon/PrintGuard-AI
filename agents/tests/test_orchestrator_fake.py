"""오케스트레이터 목 모드(가짜 부서): 의뢰 → plan 실행 → input-required → 답 → 완료, 멱등성, 공통 로그."""
import json
import os
import time

os.environ["PG_FAKE_AGENTS"] = "1"

from fastapi.testclient import TestClient  # noqa: E402

from pg_agents.orchestrator.app import app  # noqa: E402

PDF = b"%PDF-1.4\n% fake\n"


def wait(c, ctx, until, timeout=5):
    t = time.time()
    while time.time() - t < timeout:
        j = c.get(f"/jobs/{ctx}").json()["data"]
        if j["status"] in until:
            return j
        time.sleep(0.05)
    raise AssertionError(f"상태가 {until}가 되지 않음: {j['status']}")


def test_job_flow_with_input_required():
    with TestClient(app) as c:
        r = c.post("/jobs", files={"file": ("a.pdf", PDF, "application/pdf")}, data={"options": json.dumps({"finish": "unknown"})}).json()["data"]
        j = wait(c, r["context_id"], {"input-required"})
        assert j["question"]["field"] == "finish" and j["question"]["agent"] == "paper"
        assert c.post(f"/jobs/{r['context_id']}/answer", json={"value": "none"}).status_code == 200
        j = wait(c, r["context_id"], {"completed", "completed_partial"})
        assert {s["skill"] for s in j["steps"]} >= {"check_structure", "predict_color", "assess_risk"}
        assert "preflight" in j["results"] and "risk" in j["results"]
        kinds = [x["kind"] for x in c.get("/logs", params={"context_id": r["context_id"]}).json()["data"]]
        assert "job_opened" in kinds and "input_required" in kinds and "input_answered" in kinds and "job_closed" in kinds


def test_idempotent_same_pdf_same_options():
    with TestClient(app) as c:
        opts = {"finish": "none", "paper_id": "art"}
        a = c.post("/jobs", files={"file": ("a.pdf", PDF + b"x", "application/pdf")}, data={"options": json.dumps(opts)}).json()["data"]
        b = c.post("/jobs", files={"file": ("a.pdf", PDF + b"x", "application/pdf")}, data={"options": json.dumps(opts)}).json()["data"]
        assert a["context_id"] == b["context_id"] and b["duplicate"] is True


def test_rejects_non_pdf():
    with TestClient(app) as c:
        assert c.post("/jobs", files={"file": ("a.txt", b"hello", "text/plain")}).status_code == 400


def test_partial_job_is_not_reused():
    from pg_agents.orchestrator.app import JOBS
    with TestClient(app) as c:
        opts = {"finish": "none", "paper_id": "snow"}
        a = c.post("/jobs", files={"file": ("a.pdf", PDF + b"p", "application/pdf")}, data={"options": json.dumps(opts)}).json()["data"]
        wait(c, a["context_id"], {"completed", "completed_partial"})
        JOBS[a["context_id"]].status = "completed_partial"  # 일부 에이전트가 실패했던 것처럼
        b = c.post("/jobs", files={"file": ("a.pdf", PDF + b"p", "application/pdf")}, data={"options": json.dumps(opts)}).json()["data"]
        assert b["context_id"] != a["context_id"] and b["duplicate"] is False
