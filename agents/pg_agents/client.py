"""다른 에이전트 호출 `call_agent(target, req)`.

호출 전에 path에 자기 이름을 붙이고 토큰을 자기 것으로 바꾼다. 마감이 지났으면 부르지 않고 canceled(TIMEOUT),
마감 안에 응답이 없으면 canceled(TIMEOUT), 연결·응답 오류는 failed. 닿지 못한 호출만 공통 로그에 남긴다(닿은 호출은 받는 쪽이 남김)."""
from __future__ import annotations

from datetime import timedelta

import httpx
from pydantic import ValidationError

from .common_log import log_event
from .config import agent_token, agent_url, get_agent_name
from .contracts import AgentRequest, AgentResult, ErrorCode, RequestMeta, TaskStatus, now_utc
from .server import error_result


def new_meta(context_id: str, *, seconds: float = 120, idempotency_key: str | None = None) -> RequestMeta:
    return RequestMeta(context_id=context_id, token=agent_token(get_agent_name()), deadline=now_utc() + timedelta(seconds=seconds),
                       idempotency_key=idempotency_key)


async def call_agent(target: str, req: AgentRequest, *, http_client: httpx.AsyncClient | None = None) -> AgentResult:
    name = get_agent_name()
    remaining = (req.meta.deadline - now_utc()).total_seconds()
    meta = req.meta.model_copy(update={"path": [*req.meta.path, name], "token": agent_token(name)})
    if remaining <= 0:
        return _failed(name, target, req, error_result(meta, TaskStatus.CANCELED, ErrorCode.TIMEOUT))
    sent = req.model_copy(update={"meta": meta})
    client = http_client or httpx.AsyncClient()
    try:
        r = await client.post(f"{agent_url(target)}/a2a", json=sent.model_dump(mode="json"), timeout=remaining)
    except httpx.TimeoutException:
        return _failed(name, target, req, error_result(meta, TaskStatus.CANCELED, ErrorCode.TIMEOUT))
    except httpx.HTTPError:
        return _failed(name, target, req, error_result(meta, TaskStatus.FAILED, "unreachable"))
    finally:
        if http_client is None:
            await client.aclose()
    if r.status_code != 200:
        return _failed(name, target, req, error_result(meta, TaskStatus.FAILED, f"http_{r.status_code}"))
    try:
        return AgentResult.model_validate(r.json())
    except (ValidationError, ValueError):
        return _failed(name, target, req, error_result(meta, TaskStatus.FAILED, ErrorCode.INVALID_OUTPUT))


def _failed(name: str, target: str, req: AgentRequest, result: AgentResult) -> AgentResult:
    log_event(req.meta.context_id, "task_status", source=name, skill=req.skill, status=result.status, outcome=result.outcome,
              payload={"target": target})
    return result
