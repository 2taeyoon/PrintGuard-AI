"""MCP 서버 테스트: 도구 목록(승인 도구 없음), 카드 권한, 큰 값 빼기, 쓰기 도구가 safety 거절을 그대로 돌려주는지."""
import os
import tempfile

import pytest

os.environ.setdefault("PG_DATA_DIR", tempfile.mkdtemp())

from pg_agents import mcp_server as m  # noqa: E402
from pg_agents.contracts import AgentResult, TaskStatus  # noqa: E402
from pg_agents.guide import agent as ga  # noqa: E402
from pg_agents.report import agent as ra  # noqa: E402
from pg_agents.safety import agent as sa  # noqa: E402
from pg_agents.shop import agent as sh  # noqa: E402

READ_TOOLS = {"check_pdf", "get_job", "answer_question", "list_agents", "get_trace", "find_shops", "list_reviews", "search_guide"}
WRITE_TOOLS = {"compile_report"}


def job_public(**kw):
    """오케스트레이터 GET /jobs/{ctx} 응답 모양(heat 비트맵·쪽별 본문이 들어 있는 상태)."""
    return {"context_id": "ctx_job_mcp1", "status": "completed", "filename": "a.pdf", "pdf_ref": "a" * 64,
            "options": {"paper_id": "art", "width_mm": 148, "height_mm": 210, "bleed_mm": 3}, "answers": {},
            "steps": [{"agent": "preflight", "skill": "check_structure", "key": "preflight", "status": "completed", "outcome": None, "ms": 12,
                       "fallback": False}],
            "question": None,
            "results": {"preflight": {"pages": 8, "texts": ["본문 " * 50, "두 번째 쪽"],
                                      "issues": [{"severity": "high", "page": 1, "title": "도련 부족", "detail": "x", "fix": "y",
                                                  "heat": {"w": 8, "h": 8, "rgba": "A" * 5000}}]},
                        "color": {"color_report": {"weightedMeanDE": 2.5, "areaShare": 0.3, "images": 2}, "max_tac": 280, "issues": [],
                                  "profile": "PSOcoated_v3.icc"},
                        "risk": {"risks": [{"id": "setoff", "name": "뒷묻음", "level": "medium"}], "paper": {"name": "아트지"}}},
            **kw}


@pytest.fixture
def orch(monkeypatch):
    """오케스트레이터 HTTP 대신 쓰는 가짜 응답. 보낸 요청을 기록한다."""
    sent = []
    data = {"/jobs/ctx_job_mcp1": job_public(), "/agents": {"shop": {"status": "on", "card": sh.CARD.model_dump(mode="json")}},
            "/reviews": [{"review_id": "rv_1", "status": "pending", "amount": 0, "action": "demo.act_c"}]}

    async def _orch(method, path, **kw):
        sent.append((method, path, kw))
        if path in data:
            return data[path]
        if path.endswith("/answer"):
            return {"context_id": "ctx_job_mcp1", "status": "working"}
        raise RuntimeError(f"가짜 오케스트레이터에 없는 경로: {path}")

    monkeypatch.setattr(m, "_orch", _orch)
    return sent, data


@pytest.fixture
def agent_calls(monkeypatch):
    """에이전트 호출을 가로채 정해진 결과를 돌려준다. 보낸 요청(요청자 토큰 포함)을 기록한다."""
    sent = []
    box = {"result": lambda req: AgentResult(meta=req.meta, status=TaskStatus.COMPLETED, output={"ok": True})}

    async def call_agent(target, req, **kw):
        sent.append((target, req))
        return box["result"](req)

    monkeypatch.setattr(m, "call_agent", call_agent)
    return sent, box


# ---------- 도구 목록 ----------
async def test_tool_list():
    names = {t.name for t in await m.mcp.list_tools()}
    assert names == READ_TOOLS | WRITE_TOOLS


async def test_no_approval_tool():
    """사람 승인은 사람이 웹에서만 한다. MCP에는 승인 도구도, 승인 API를 부르는 코드도 없어야 한다."""
    names = {t.name for t in await m.mcp.list_tools()}
    assert not [n for n in names if "approve" in n or "decide" in n or "review" in n.replace("list_reviews", "")]
    src = (os.path.dirname(m.__file__) and open(m.__file__, encoding="utf-8").read())
    assert "/decide" not in src and "human:" not in src


def test_cards_allow_mcp():
    """직접 부르는 skill은 Agent Card에서 mcp에게 열려 있어야 한다(카드가 바뀌면 이 테스트가 먼저 깨진다)."""
    for card, skill in [(sh.CARD, "find_shops"), (ra.CARD, "compile_report"), (ga.CARD, "search_guide")]:
        s = next(x for x in card.skills if x.id == skill)
        assert m.NAME in s.allowed_requesters, f"{card.name}.{skill}"
    assert m.NAME in next(s for s in sa.CARD.skills if s.id == "execute").allowed_requesters


# ---------- 큰 값 빼기 ----------
def test_prune_drops_heat_and_texts():
    out = m.prune({"issues": [{"title": "t", "heat": {"w": 4, "h": 4, "rgba": "A" * 100}}], "texts": ["가" * 10, "나"]})
    assert "heat" not in out["issues"][0] and "rgba" not in str(out)
    assert out["texts_omitted"] == {"pages": 2, "chars": 11, "note": out["texts_omitted"]["note"]}
    assert "texts" not in out


def test_prune_keeps_texts_when_asked_and_shortens_long_strings():
    out = m.prune({"texts": ["가" * 10]}, texts=True)
    assert out["texts"] == ["가" * 10]
    assert m.prune({"s": "x" * (m.MAX_STR + 50)})["s"].endswith(f"...(총 {m.MAX_STR + 50}자, 줄임)")


def test_prune_caps_long_lists():
    out = m.prune({"rows": list(range(m.MAX_LIST + 5))})
    assert len(out["rows"]) == m.MAX_LIST + 1 and out["rows"][-1] == "...5개 더"


async def test_get_job_has_no_heat(orch):
    out = await m.get_job("ctx_job_mcp1")
    assert "rgba" not in str(out) and "heat" not in str(out)
    assert out["counts"] == {"pages": 8, "structure_issues": 1, "color_issues": 0, "proofread_suggestions": 0, "risks": 1}
    assert out["mean_delta_e"] == 2.5 and out["results"]["preflight"]["texts_omitted"]["pages"] == 2


async def test_get_job_section_and_unknown_section(orch):
    assert (await m.get_job("ctx_job_mcp1", section="color"))["color"]["max_tac"] == 280
    with pytest.raises(m.ToolError, match="없는 부분"):
        await m.get_job("ctx_job_mcp1", section="guide")


# ---------- 쓰기 도구: 관문 결과를 그대로 ----------
async def test_compile_report_passes_safety_rejection_through(orch, agent_calls):
    sent, box = agent_calls
    reason = "확인 실패(fail-closed)"
    box["result"] = lambda req: AgentResult(meta=req.meta, status=TaskStatus.REJECTED, outcome="SAFETY_REJECTED",
                                            output={"reason": reason, "decision": {"decision": "rejected", "grade": "A"}})
    out = await m.compile_report("ctx_job_mcp1")
    assert out["status"] == "rejected" and out["outcome"] == "SAFETY_REJECTED" and out["output"]["reason"] == reason
    target, req = sent[0]
    assert (target, req.skill) == ("report", "compile_report") and req.meta.token == "mock:mcp"


async def test_compile_report_passes_forbidden_skill_through(orch, agent_calls):
    _, box = agent_calls
    box["result"] = lambda req: AgentResult(meta=req.meta, status=TaskStatus.REJECTED, outcome="FORBIDDEN_SKILL")
    out = await m.compile_report("ctx_job_mcp1")
    assert (out["status"], out["outcome"]) == ("rejected", "FORBIDDEN_SKILL")


async def test_compile_report_input_comes_from_job(orch, agent_calls):
    sent, box = agent_calls
    box["result"] = lambda req: AgentResult(meta=req.meta, status=TaskStatus.COMPLETED,
                                            output={"markdown": "# 보고서", "path": "x.md", "verified": {"delta_e": None}})
    out = await m.compile_report("ctx_job_mcp1")
    assert out["status"] == "completed" and out["output"]["markdown"] == "# 보고서"
    target, req = sent[0]
    assert (target, req.skill) == ("report", "compile_report")
    assert req.input["pdf_ref"] == "a" * 64 and req.input["pages"] == 8 and req.input["paper_name"] == "아트지"
    assert req.input["color"]["mean_de"] == 2.5 and "heat" not in str(req.input)


async def test_job_without_pdf_ref_is_an_error(orch):
    orch[1]["/jobs/ctx_job_mcp1"] = {k: v for k, v in job_public().items() if k != "pdf_ref"}
    with pytest.raises(m.ToolError, match="pdf_ref"):
        await m.compile_report("ctx_job_mcp1")


# ---------- 그 밖의 도구 ----------
async def test_check_pdf_rejects_non_pdf(tmp_path):
    p = tmp_path / "a.pdf"
    p.write_bytes(b"not a pdf")
    with pytest.raises(m.ToolError, match="PDF 파일이 아닙니다"):
        await m.check_pdf(str(p))
    with pytest.raises(m.ToolError, match="파일이 없습니다"):
        await m.check_pdf(str(tmp_path / "없는.pdf"))


async def test_answer_question_only_when_asked(orch):
    with pytest.raises(m.ToolError, match="답을 기다리는 의뢰가 아닙니다"):
        await m.answer_question("ctx_job_mcp1", "art")


async def test_list_agents_marks_mcp_callable(orch):
    out = await m.list_agents()
    skills = {s["id"]: s for s in out["agents"][0]["skills"]}
    assert skills["find_shops"]["callable_by_mcp"] is True and skills["find_shops"]["grade"] == "read"


async def test_list_reviews_says_only_humans_approve(orch):
    out = await m.list_reviews()
    assert out["reviews"][0]["review_id"] == "rv_1" and "승인할 수 없습니다" in out["note"]


async def test_orchestrator_off_tells_how_to_start(monkeypatch):
    import httpx

    class Boom:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def request(self, *a, **kw):
            raise httpx.ConnectError("refused")

    monkeypatch.setattr(m.httpx, "AsyncClient", lambda **kw: Boom())
    with pytest.raises(m.ToolError, match="run_agents.py"):
        await m.get_job("ctx_job_mcp1")
