"""에이전트 서버 뼈대 `create_agent_app(card, handlers)` (ax agent-template과 같은 수신 순서).

GET /.well-known/agent-card.json, GET /health, POST /a2a

수신 순서: context_id → 토큰(요청자는 토큰에서) → 루프(path에 자기 이름) → 홉 제한 → 권한(allowed_requesters)
→ 마감 → 핸들러 → 결과 스키마 검증. 요청 수신과 결과 전송은 공통 로그에 자동으로 남는다.
"""
from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from .common_log import log_event
from .config import CORS_ORIGIN_REGEX, MAX_PATH_LENGTH, is_mock, set_agent_name
from .contracts import AgentCard, AgentRequest, AgentResult, ErrorCode, RequestMeta, TaskStatus, now_utc

Handler = Callable[[AgentRequest], Awaitable[AgentResult | dict[str, Any]]]


def error_result(meta: RequestMeta, status: TaskStatus, code: str, message: str = "") -> AgentResult:
    return AgentResult(meta=meta, status=status, outcome=code, output={"message": message} if message else {})


def verify_token(token: str) -> str:
    """목 모드에서만 `mock:<이름>`을 받는다. 그 밖에는 거부(fail-closed)."""
    if is_mock() and token.startswith("mock:") and len(token) > 5:
        return token[5:]
    raise PermissionError("토큰을 검증할 수 없다")


def create_agent_app(card: AgentCard, handlers: Mapping[str, Handler]) -> FastAPI:
    missing = {s.id for s in card.skills} ^ set(handlers)
    if missing:
        raise ValueError(f"카드 skill과 핸들러가 다르다: {sorted(missing)}")
    skills = {s.id: s for s in card.skills}
    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        set_agent_name(card.name)
        yield

    app = FastAPI(title=f"PrintGuard {card.name} agent", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origin_regex=CORS_ORIGIN_REGEX, allow_methods=["*"], allow_headers=["*"])

    @app.get("/")
    async def root() -> dict[str, Any]:
        """포트를 열어 본 사람에게 여기가 화면이 아니라는 것만 알려 준다(주소·내부 구조는 적지 않는다)."""
        return {"data": {"agent": card.name, "note": "에이전트 API입니다. 사람이 쓰는 화면은 앱에서 보세요."}, "meta": {}}

    @app.get("/.well-known/agent-card.json")
    async def agent_card() -> dict[str, Any]:
        return card.model_dump(mode="json")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"data": {"status": "ok", "agent": card.name}, "meta": {}}

    @app.post("/a2a")
    async def a2a(request: Request) -> dict[str, Any]:
        set_agent_name(card.name)
        body = await request.json()
        try:
            req = AgentRequest.model_validate(body)
        except ValidationError as e:
            meta = body.get("meta") or {}
            fallback = RequestMeta(context_id=str(meta.get("context_id") or "unknown"), token="", deadline=now_utc())
            return error_result(fallback, TaskStatus.REJECTED, ErrorCode.INVALID_INPUT, str(e)[:300]).model_dump(mode="json")
        result = await _handle(req)
        log_event(req.meta.context_id, "result_sent", source=card.name, requester=req.meta.requester, skill=req.skill,
                  status=result.status, outcome=result.outcome, grade=skills[req.skill].grade if req.skill in skills else None,
                  payload={"fallback": result.fallback, "question": bool(result.question)})
        return result.model_dump(mode="json")

    async def _handle(req: AgentRequest) -> AgentResult:
        meta = req.meta
        if not meta.context_id:
            return error_result(meta, TaskStatus.REJECTED, ErrorCode.MISSING_CONTEXT)
        try:
            requester = verify_token(meta.token)
        except PermissionError:
            return error_result(meta, TaskStatus.REJECTED, ErrorCode.UNAUTHORIZED)
        meta = meta.model_copy(update={"requester": requester})
        req = req.model_copy(update={"meta": meta})
        log_event(meta.context_id, "request_received", source=card.name, requester=requester, skill=req.skill,
                  payload={"path": meta.path})
        if card.name in meta.path:
            return error_result(meta, TaskStatus.REJECTED, ErrorCode.LOOP_DETECTED)
        if len(meta.path) > MAX_PATH_LENGTH:
            return error_result(meta, TaskStatus.REJECTED, ErrorCode.HOP_LIMIT)
        skill = skills.get(req.skill)
        if skill is None:
            return error_result(meta, TaskStatus.REJECTED, ErrorCode.UNKNOWN_SKILL)
        if requester not in skill.allowed_requesters:
            return error_result(meta, TaskStatus.REJECTED, ErrorCode.FORBIDDEN_SKILL)
        if meta.deadline <= now_utc():
            return error_result(meta, TaskStatus.CANCELED, ErrorCode.TIMEOUT)
        try:
            out = await handlers[req.skill](req)
            if isinstance(out, dict):
                out = AgentResult.model_validate({"meta": meta.model_dump(mode="json"), **out})
            return out.model_copy(update={"meta": meta})
        except ValidationError as e:
            return error_result(meta, TaskStatus.FAILED, ErrorCode.INVALID_OUTPUT, str(e)[:300])
        except Exception as e:  # noqa: BLE001
            return error_result(meta, TaskStatus.FAILED, "handler_error", f"{type(e).__name__}: {e}"[:300])

    return app
