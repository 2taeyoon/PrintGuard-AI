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


# ---------- 번호를 들고 와 가져오기 ----------
# 클로드·커서가 MCP로 만든 문서는 그 도구가 주인이다. 사람이 브라우저에서 그 문서를 받고 검수로
# 넘기려면 **주인이 둘**이어야 한다 — 밀어내면 그 뒤로 클로드가 그 문서를 이어서 못 고친다.
def test_someone_elses_document_stays_closed_until_you_bring_the_number():
    ctx = _seed_source("ctx_dc_byclaude", owner="claude-mcp")
    with client() as c:
        assert c.get(f"/designcraft/{ctx}").status_code == 404        # 번호를 넣기 전
        assert c.post(f"/designcraft/{ctx}/adopt").status_code == 200  # 번호를 들고 왔다
        r = c.get(f"/designcraft/{ctx}")
        assert r.status_code == 200 and r.json()["data"]["filename"] == "a.idml"


def test_taking_a_document_does_not_push_the_maker_out():
    ctx = _seed_source("ctx_dc_shared", owner="claude-mcp")
    with client() as c:
        assert c.post(f"/designcraft/{ctx}/adopt").status_code == 200
    with client("claude-mcp") as c:
        assert c.get(f"/designcraft/{ctx}").status_code == 200       # 만든 쪽도 그대로


def test_a_taken_document_shows_up_in_my_list():
    ctx = _seed_source("ctx_dc_inlist", owner="claude-mcp")
    with client() as c:
        assert [r["context_id"] for r in c.get("/designcraft/jobs").json()["data"] if r["context_id"] == ctx] == []
        c.post(f"/designcraft/{ctx}/adopt")
        assert ctx in [r["context_id"] for r in c.get("/designcraft/jobs").json()["data"]]


def test_a_number_nobody_made_is_not_adoptable():
    with client() as c:
        assert c.post("/designcraft/ctx_dc_nosuchthing/adopt").status_code == 404


# ---------- 지우기 ----------
# 넣은 사람이 지울 수 있어야 한다. 로그인을 했든 안 했든 같다 — 주인을 가리는 값은 로그인
# 여부가 아니라 토큰 속 subject이고, 그건 익명 세션에도 있다.
def test_i_can_erase_my_job_and_its_log(tmp_path):
    from pg_agents.common_log import query
    with client() as c:
        r = c.post("/jobs", data={"file": ""}, files={"file": ("a.pdf", PDF, "application/pdf")})
        ctx = r.json()["data"]["context_id"]
        wait(c, ctx, {"completed", "completed_partial", "failed", "input-required"})
        assert query(contexts={ctx})                       # 지우기 전에는 기록이 있다
        d = c.delete(f"/jobs/{ctx}").json()["data"]
        assert d["context_id"] == ctx and d["log_rows"] > 0
        assert query(contexts={ctx}) == []                 # 소통 기록까지 같이 지운다
        assert c.get(f"/jobs/{ctx}").status_code == 404
        assert [j["context_id"] for j in c.get("/jobs").json()["data"] if j["context_id"] == ctx] == []


def test_i_cannot_erase_someone_elses_job():
    """남의 것은 '없는 의뢰'다. 있는지 없는지도 알려 주지 않는다."""
    with client("brow-A") as a:
        ctx = a.post("/jobs", files={"file": ("a.pdf", PDF, "application/pdf")}).json()["data"]["context_id"]
        wait(a, ctx, {"completed", "completed_partial", "failed", "input-required"})
    with client("brow-B") as b:
        assert b.delete(f"/jobs/{ctx}").status_code == 404
    with client("brow-A") as a:
        assert a.get(f"/jobs/{ctx}").status_code == 200    # 남의 지우기 시도로 사라지지 않았다


def test_erase_all_of_mine_leaves_other_browsers_alone():
    with client("brow-A") as a:
        # 옵션을 달리한다. 같은 파일·같은 옵션이면 멱등성으로 **한 의뢰**가 되어 둘이 안 된다
        for paper in ("art", "matte"):
            ctx = a.post("/jobs", data={"options": json.dumps({"paper_id": paper})},
                         files={"file": ("a.pdf", PDF, "application/pdf")}).json()["data"]["context_id"]
            wait(a, ctx, {"completed", "completed_partial", "failed", "input-required"})
    with client("brow-B") as b:
        mine = b.post("/jobs", files={"file": ("b.pdf", PDF, "application/pdf")}).json()["data"]["context_id"]
        wait(b, mine, {"completed", "completed_partial", "failed", "input-required"})
    with client("brow-A") as a:
        d = a.delete("/jobs").json()["data"]
        assert d["jobs"] >= 2
        assert a.get("/jobs").json()["data"] == []
    with client("brow-B") as b:
        assert [j["context_id"] for j in b.get("/jobs").json()["data"]] == [mine]


def test_erasing_a_job_keeps_a_pdf_another_job_still_points_at(tmp_path):
    """올린 PDF는 내용 해시로 보관한다. 같은 파일을 둘이 가리킬 수 있어서, 혼자 남았을 때만 지운다."""
    from pg_agents.config import STORE
    # 다른 시험과 **다른 바이트**를 쓴다. 보관은 내용 해시라, 같은 바이트를 쓰면 다른 시험이 넣어
    # 둔 의뢰가 같은 파일을 보고 있어서 지워지지 않는다(그건 올바른 동작이고, 시험만 흔들린다).
    only = PDF + b"% erase-test only\n"
    with client("brow-erase") as c:      # 다른 시험이 쌓아 둔 의뢰 수에 걸리지 않게 주인도 따로 쓴다
        one = c.post("/jobs", data={"options": json.dumps({"paper_id": "art"})},
                     files={"file": ("a.pdf", only, "application/pdf")}).json()["data"]["context_id"]
        wait(c, one, {"completed", "completed_partial", "failed", "input-required"})
        ref = c.get(f"/jobs/{one}").json()["data"]["pdf_ref"]
        assert (STORE / f"{ref}.pdf").is_file()
        two = c.post("/jobs", data={"options": json.dumps({"paper_id": "matte"})},
                     files={"file": ("a.pdf", only, "application/pdf")}).json()["data"]["context_id"]
        wait(c, two, {"completed", "completed_partial", "failed", "input-required"})
        assert two != one                                  # 옵션이 달라 다른 의뢰, 같은 PDF를 본다

        c.delete(f"/jobs/{one}")
        assert (STORE / f"{ref}.pdf").is_file()            # 아직 보는 의뢰가 있으면 남긴다
        c.delete(f"/jobs/{two}")
        assert not (STORE / f"{ref}.pdf").exists()         # 아무도 안 보면 지운다


def test_erasing_a_document_takes_its_log_too():
    from pg_agents.common_log import log_event, query
    ctx = _seed_source("ctx_dc_toerase")
    log_event(ctx, "dc_step", source="orchestrator", payload={"phase": "끝"})
    with client() as c:
        assert query(contexts={ctx})
        d = c.delete(f"/designcraft/{ctx}").json()["data"]
        assert d["log_rows"] > 0 and query(contexts={ctx}) == []
        assert c.get(f"/designcraft/{ctx}").status_code == 404


def test_i_cannot_erase_someone_elses_document():
    ctx = _seed_source("ctx_dc_notmine", owner="someone-else")
    with client() as c:
        assert c.delete(f"/designcraft/{ctx}").status_code == 404


# ---------- 번호 없이 따라 보기 ----------
# 번호를 매번 복사해 오게 하면 아무도 안 본다. 이 PC의 도구(클로드·커서)가 만든 것은 이 PC의
# 브라우저에 그냥 보여 준다 — 그 둘은 같은 사람이다. 바깥에서 들어온 요청에는 안 열린다.
def _seed_tool_doc(ctx="ctx_dc_bytool"):
    from pg_agents.auth import tool_subject
    return _seed_source(ctx, owner=tool_subject())


def here(key: str = KEY) -> TestClient:
    """이 PC에서 온 요청."""
    return TestClient(app, client=("127.0.0.1", 5555),
                      headers={"Authorization": f"Bearer {mint('browser', subject=key)}"})


def test_this_pc_sees_what_the_local_tool_is_making_without_a_number():
    from pg_agents.common_log import log_event
    ctx = _seed_tool_doc("ctx_dc_feedlocal")
    log_event(ctx, "dc_step", source="orchestrator", payload={"phase": "넣는 중", "command": "text.insert"})
    with here() as c:
        d = c.get("/designcraft/feed").json()["data"]
        assert ctx in d["docs"]
        assert [r for r in d["rows"] if r["ctx"] == ctx and r["kind"] == "dc_step"]
        assert d["docs"][ctx]["mine"] is False      # 주인은 그 도구다. 보기만 열어 준 것이다


def test_a_request_from_outside_this_pc_sees_only_its_own():
    _seed_tool_doc("ctx_dc_feedremote")
    with client() as c:                              # TestClient 기본은 이 PC가 아니다
        d = c.get("/designcraft/feed").json()["data"]
        assert "ctx_dc_feedremote" not in d["docs"]


def test_the_feed_only_sends_what_is_new():
    from pg_agents.common_log import log_event
    ctx = _seed_tool_doc("ctx_dc_feedcursor")
    log_event(ctx, "dc_step", source="orchestrator", payload={"phase": "넣는 중", "command": "frame.create"})
    with here() as c:
        first = c.get("/designcraft/feed").json()["data"]
        assert first["rows"] and first["next"] > 0
        log_event(ctx, "dc_step", source="orchestrator", payload={"phase": "끝"})
        later = c.get(f"/designcraft/feed?after={first['next']}").json()["data"]
        assert [r["payload"]["phase"] for r in later["rows"] if r["ctx"] == ctx] == ["끝"]


def test_the_feed_needs_a_token():
    with TestClient(app, client=("127.0.0.1", 5555)) as c:
        assert c.get("/designcraft/feed").status_code == 401


def test_job_without_file_or_source_is_refused():
    with client() as c:
        assert c.post("/jobs", data={"options": "{}"}).status_code == 400


def test_the_orchestrator_is_in_its_own_agent_list():
    """총괄을 목록에서 빼 두면 계획을 세우고 차례를 부르는 당사자만 화면에서 빠지고, 머릿수도
    하나 모자라게 세어진다('8/8'). 자기 카드는 HTTP로 돌지 않고 들고 있는 것을 쓴다."""
    c = client()
    rows = c.get("/agents").json()["data"]
    assert "orchestrator" in rows
    assert rows["orchestrator"]["card"]["name"] == "orchestrator"
    # 대답하고 있다는 것 자체가 켜져 있다는 뜻이다 — 꺼진 것으로 적힐 수 없다
    assert rows["orchestrator"]["status"] != "off"
    # 부서는 하나도 빠지지 않았다
    assert set(rows) >= {"preflight", "color", "paper", "guide", "proofread", "report", "safety", "designcraft"}


def test_the_orchestrator_card_says_it_receives_nothing():
    """**받는 일이 없다는 것도 계약이다.** 총괄은 아무에게도 요청받지 않는다(`/a2a`가 없다) —
    적어 두지 않으면 '아직 안 만든 에이전트'와 구별되지 않는다."""
    c = client()
    card = c.get("/.well-known/agent-card.json").json()
    assert card["name"] == "orchestrator"
    assert card["skills"] == []
    assert c.post("/a2a", json={}).status_code == 404     # 받는 자리가 아예 없다
