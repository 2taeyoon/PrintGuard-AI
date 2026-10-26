"""가짜 부서(PG_FAKE_AGENTS=1). 실제 연동 없이 plan 흐름·input-required·로그를 시연하고 테스트한다."""
from __future__ import annotations

import asyncio

from ..common_log import log_event
from ..contracts import AgentRequest, AgentResult, InputReason, TaskStatus

FAKE_OUT = {
    "check_structure": {"pages": 1, "page_sizes": [{"w": 419.5, "h": 595.3}], "issues": [
        {"key": "f1", "kind": "bleed", "severity": "high", "page": 1, "title": "도련 부족", "detail": "가짜 결과", "fix": "도련 3mm", "rect": None, "source": "rule"}],
        "texts": []},
    "predict_color": {"issues": [], "color_report": {"profile": "fake", "images": 0, "areaShare": 0, "weightedMeanDE": 0, "areaOver5": 0, "areaOver10": 0, "areaOverTAC": 0},
                      "max_tac": 0, "tac_limit": 300},
    "search_guide": {"hits": {}},
    "suggest_corrections": {"suggestions": []},
}


async def fake_caller(agent: str, req: AgentRequest) -> AgentResult:
    await asyncio.sleep(0.05)
    log_event(req.meta.context_id, "request_received", source=f"{agent}(fake)", requester="orchestrator", skill=req.skill)
    if req.skill == "assess_risk" and req.input.get("finish") == "unknown":
        return AgentResult(meta=req.meta, status=TaskStatus.INPUT_REQUIRED, reason_code=InputReason.CUSTOMER_INPUT,
                           question={"field": "finish", "text": "후가공이 있나요?", "options": [{"value": "none", "label": "없음"}]})
    out = {"risks": []} if req.skill == "assess_risk" else FAKE_OUT.get(req.skill, {})
    log_event(req.meta.context_id, "result_sent", source=f"{agent}(fake)", requester="orchestrator", skill=req.skill, status="completed")
    return AgentResult(meta=req.meta, status=TaskStatus.COMPLETED, output=out)
