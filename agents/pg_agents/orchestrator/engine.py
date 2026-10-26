"""검수 의뢰(job) 실행 엔진. plan = 단계 목록, 단계 = 병렬로 돌릴 호출 묶음.

- 결과가 input-required면 job을 멈추고 질문을 앱에 넘긴다. 답이 오면 같은 context_id로 그 skill만 다시 부른다(input-required 중계).
- 실패한 호출은 1번 재시도하고, 그래도 실패하면 그 부분만 빠진 채로 계속 간다(부분 결과).
- 분석 문장·수치를 만들지 않는다. 부서 결과를 모을 뿐이다.
"""
from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from ..client import call_agent, new_meta
from ..common_log import log_event
from ..contracts import AgentRequest, AgentResult, TaskStatus

Caller = Callable[[str, AgentRequest], Awaitable[AgentResult]]


@dataclass
class Call:
    key: str  # 결과를 담을 이름
    agent: str
    skill: str
    build: Callable[["Job"], dict[str, Any]]  # job 상태로 input을 만든다
    untrusted: Callable[["Job"], dict[str, Any]] | None = None
    when: Callable[["Job"], bool] = lambda j: True


@dataclass
class Job:
    context_id: str
    idempotency_key: str
    options: dict[str, Any]
    pdf_ref: str
    filename: str
    status: str = "working"  # working | input-required | completed | failed
    results: dict[str, Any] = field(default_factory=dict)
    steps: list[dict[str, Any]] = field(default_factory=list)
    question: dict[str, Any] | None = None
    pending: tuple[int, Call] | None = None  # 질문을 기다리는 단계와 호출
    answers: dict[str, Any] = field(default_factory=dict)
    created: float = field(default_factory=time.time)

    def public(self) -> dict[str, Any]:
        return {"context_id": self.context_id, "status": self.status, "filename": self.filename, "options": self.options,
                "steps": self.steps, "question": self.question, "results": self.results}


class Engine:
    def __init__(self, plan: list[list[Call]], caller: Caller | None = None) -> None:
        self.plan = plan
        self.caller = caller or call_agent

    async def run(self, job: Job, start: int = 0) -> None:
        for i in range(start, len(self.plan)):
            calls = [c for c in self.plan[i] if c.when(job)]
            results = await asyncio.gather(*(self._one(job, c) for c in calls))
            for c, r in zip(calls, results):
                if r is not None and r.status == TaskStatus.INPUT_REQUIRED:
                    job.status, job.question, job.pending = "input-required", {**(r.question or {}), "agent": c.agent, "skill": c.skill}, (i, c)
                    log_event(job.context_id, "input_required", source="orchestrator", skill=c.skill, status=r.status,
                              payload={"agent": c.agent, "field": (r.question or {}).get("field")})
                    return
        job.status = "completed" if not any(s["status"] in ("failed", "canceled", "rejected") for s in job.steps) else "completed_partial"
        log_event(job.context_id, "job_closed", source="orchestrator", status=job.status, payload={"steps": len(job.steps)})

    async def answer(self, job: Job, value: Any) -> None:
        """질문에 대한 답을 받아 멈춘 호출부터 다시 시작한다."""
        if not job.pending or not job.question:
            return
        i, c = job.pending
        job.answers[job.question["field"]] = value
        job.status, job.question, job.pending = "working", None, None
        log_event(job.context_id, "input_answered", source="orchestrator", skill=c.skill, payload={"field": list(job.answers)[-1]})
        r = await self._one(job, c)
        if r is not None and r.status == TaskStatus.INPUT_REQUIRED:
            job.status, job.question, job.pending = "input-required", {**(r.question or {}), "agent": c.agent, "skill": c.skill}, (i, c)
            return
        # 같은 단계의 다른 호출은 이미 끝났으므로 다음 단계부터 이어 간다
        await self.run(job, i + 1)

    async def _one(self, job: Job, c: Call) -> AgentResult | None:
        req = AgentRequest(meta=new_meta(job.context_id, seconds=180, idempotency_key=f"{job.idempotency_key}:{c.skill}"),
                           skill=c.skill, input=c.build(job), untrusted=c.untrusted(job) if c.untrusted else {})
        t0 = time.time()
        r = await self.caller(c.agent, req)
        if r.status in (TaskStatus.FAILED,) :  # 1번 재시도
            req = req.model_copy(update={"meta": new_meta(job.context_id, seconds=180, idempotency_key=req.meta.idempotency_key)})
            r = await self.caller(c.agent, req)
        ms = round((time.time() - t0) * 1000)
        job.steps.append({"agent": c.agent, "skill": c.skill, "key": c.key, "status": str(r.status), "outcome": r.outcome, "ms": ms,
                          "fallback": r.fallback})
        if r.status == TaskStatus.COMPLETED:
            job.results[c.key] = r.output
        return r
