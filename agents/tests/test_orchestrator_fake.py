"""오케스트레이터 목 모드(가짜 부서): 의뢰 → plan 실행 → input-required → 답 → 완료, 멱등성, 공통 로그."""
import json
import os
import time

os.environ["PG_FAKE_AGENTS"] = "1"

from fastapi.testclient import TestClient  # noqa: E402

from pg_agents.auth import mint  # noqa: E402
from pg_agents.orchestrator.app import app  # noqa: E402

PDF = b"%PDF-1.4\n% fake\n"


KEY = "test-browser"


def client(key: str = KEY) -> TestClient:
    """의뢰의 주인은 **서버가 발급해 서명한** 토큰 속 subject로 가린다. 토큰 없이 부르면 404가 맞다.
    그래서 테스트도 실제 브라우저처럼 토큰을 달고 부른다 — subject를 바꿔 '다른 브라우저'를 만든다."""
    return TestClient(app, headers={"Authorization": f"Bearer {mint('browser', subject=key)}"})


def wait(c, ctx, until, timeout=5):
    t = time.time()
    while time.time() - t < timeout:
        j = c.get(f"/jobs/{ctx}").json()["data"]
        if j["status"] in until:
            return j
        time.sleep(0.05)
    raise AssertionError(f"상태가 {until}가 되지 않음: {j['status']}")


def test_job_flow_with_input_required():
    with client() as c:
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
    with client() as c:
        opts = {"finish": "none", "paper_id": "art"}
        a = c.post("/jobs", files={"file": ("a.pdf", PDF + b"x", "application/pdf")}, data={"options": json.dumps(opts)}).json()["data"]
        b = c.post("/jobs", files={"file": ("a.pdf", PDF + b"x", "application/pdf")}, data={"options": json.dumps(opts)}).json()["data"]
        assert a["context_id"] == b["context_id"] and b["duplicate"] is True


def test_rejects_non_pdf():
    with client() as c:
        assert c.post("/jobs", files={"file": ("a.txt", b"hello", "text/plain")}).status_code == 400


def test_partial_job_is_not_reused():
    from pg_agents.orchestrator.app import JOBS
    with client() as c:
        opts = {"finish": "none", "paper_id": "snow"}
        a = c.post("/jobs", files={"file": ("a.pdf", PDF + b"p", "application/pdf")}, data={"options": json.dumps(opts)}).json()["data"]
        wait(c, a["context_id"], {"completed", "completed_partial"})
        JOBS[a["context_id"]].status = "completed_partial"  # 일부 에이전트가 실패했던 것처럼
        b = c.post("/jobs", files={"file": ("a.pdf", PDF + b"p", "application/pdf")}, data={"options": json.dumps(opts)}).json()["data"]
        assert b["context_id"] != a["context_id"] and b["duplicate"] is False


def test_unknown_paper_asks_then_runs_color_with_choice():
    with client() as c:
        opts = {"finish": "none", "paper_id": "unknown"}
        r = c.post("/jobs", files={"file": ("a.pdf", PDF + b"u", "application/pdf")}, data={"options": json.dumps(opts)}).json()["data"]
        j = wait(c, r["context_id"], {"input-required"})
        assert j["question"]["field"] == "paper_id" and "color" not in j["results"]  # 종이를 모르면 색 검사를 미룬다
        c.post(f"/jobs/{r['context_id']}/answer", json={"value": "art"})
        j = wait(c, r["context_id"], {"completed", "completed_partial"})
        skills = [s["skill"] for s in j["steps"]]
        assert skills.index("recommend_paper") < skills.index("predict_color") < skills.index("assess_risk")
        assert j["results"]["paper_choice"]["paper_id"] == "art"


def test_color_input_passes_measured_paper_white_only_when_given():
    """측정한 종이 흰색은 의뢰 옵션에 있을 때만 color 입력에 넣는다(없으면 키 자체를 보내지 않는다)."""
    from pg_agents.orchestrator.engine import Job
    from pg_agents.orchestrator.plan import _color
    base = {"context_id": "ctx_job_w", "idempotency_key": "k", "pdf_ref": "a" * 64, "filename": "a.pdf"}
    assert "substrate_white" not in _color(Job(options={"paper_id": "art"}, **base))
    white = [95.0, 1.0, -5.0]
    assert _color(Job(options={"paper_id": "art", "substrate_white": white}, **base))["substrate_white"] == white


def test_other_browser_cannot_see_or_answer_my_job():
    """토큰의 주인이 다르면 남의 의뢰는 없는 것처럼 보여야 한다(목록·상세·답·로그 모두)."""
    with client("alice") as a:
        r = a.post("/jobs", files={"file": ("a.pdf", PDF + b"iso", "application/pdf")},
                   data={"options": json.dumps({"finish": "unknown"})}).json()["data"]
        ctx = r["context_id"]
        wait(a, ctx, {"input-required"})
        assert a.get(f"/jobs/{ctx}").status_code == 200
    with client("bob") as b:
        assert b.get(f"/jobs/{ctx}").status_code == 404
        assert b.post(f"/jobs/{ctx}/answer", json={"value": "none"}).status_code == 404
        assert b.get("/jobs").json()["data"] == []
        assert b.get("/logs", params={"context_id": ctx}).json()["data"] == []
    with client() as c:  # 또 다른 토큰에도 안 보인다
        assert c.get(f"/jobs/{ctx}").status_code == 404


# ---------- 원본 수정은 편집 파일로 의뢰했을 때만 ----------
def _job(**opts):
    from pg_agents.orchestrator.engine import Job
    j = Job(context_id="ctx_job_t", idempotency_key="k", options=opts, pdf_ref="sha", filename="a.pdf")
    j.results["proofread"] = {"suggestions": [{"key": "pr-1", "page": 2, "original": "읍니다", "suggestion": "습니다"},
                                              {"key": "pr-2", "page": 3, "original": "", "suggestion": "x"},
                                              {"key": "pr-3", "page": 4, "original": "같다", "suggestion": "같다"}]}
    return j


def test_pdf_job_never_runs_the_fix_step():
    """PDF로 올린 의뢰에는 고칠 원본이 없다. 설 수 없는 단계를 세워 두고 매번 실패시키지 않는다."""
    from pg_agents.orchestrator import plan as P
    assert P.can_fix(_job()) is False
    steps = P.build_plan({"preflight", "color", "paper", "guide", "proofread", "designcraft"})
    fix = [c for stage in steps for c in stage if c.agent == "designcraft"]
    assert len(fix) == 1, "단계는 늘 있고, 설지 말지는 when이 정한다"
    assert fix[0].when(_job()) is False


def test_idml_job_runs_the_fix_step_with_only_the_fixable_suggestions():
    from pg_agents.orchestrator import plan as P
    j = _job(src_ctx="ctx_dc_1", src_ref="tok", src_doc="내 잡지/a.idml")
    assert P.can_fix(j) is True
    inp = P._fix(j)
    assert inp["filename"] == "내 잡지/a.idml" and inp["src_ref"] == "tok"
    assert [f["key"] for f in inp["fixes"]] == ["pr-1"], "원문이 비었거나 고칠 내용이 같은 제안은 보내지 않는다"
    assert inp["confirm"] == "", "아직 묻지 않았다"
    j.answers["apply_fixes"] = "yes"
    assert P._fix(j)["confirm"] == "yes"


def test_fix_step_is_skipped_when_there_is_nothing_to_fix():
    from pg_agents.orchestrator import plan as P
    j = _job(src_ref="tok", src_doc="a.idml")
    j.results["proofread"] = {"suggestions": []}
    assert P.can_fix(j) is False


# ---------- 원본으로 연 의뢰 ----------
def _seed_source(ctx="ctx_dc_seed", owner=KEY):
    from pg_agents.orchestrator import app as A
    A.DCJOBS[ctx] = {"client": owner, "src_ref": "tok", "filename": "a.idml", "doc": "pkg/a.idml",
                     "files": 1, "created": time.time(), "result": None, "inspect": {"pdf_ref": "sha-from-idml"}}
    return ctx


def test_job_can_be_opened_from_an_uploaded_source():
    ctx = _seed_source()
    with client() as c:
        r = c.post("/jobs", data={"source": ctx, "options": json.dumps({"finish": "none", "paper_id": "art"})})
        assert r.status_code == 200, r.text
        j = wait(c, r.json()["data"]["context_id"], {"completed", "completed_partial"})
        assert j["filename"] == "a.idml" and j["pdf_ref"] == "sha-from-idml"
        assert j["options"]["src_ref"] == "tok" and j["options"]["src_doc"] == "pkg/a.idml"


def test_cannot_open_a_job_from_someone_elses_source():
    ctx = _seed_source("ctx_dc_other", owner="someone-else")
    with client() as c:
        assert c.post("/jobs", data={"source": ctx}).status_code == 404


def test_job_without_file_or_source_is_refused():
    with client() as c:
        assert c.post("/jobs", data={"options": "{}"}).status_code == 400
