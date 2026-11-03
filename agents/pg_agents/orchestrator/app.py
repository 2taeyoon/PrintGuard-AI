"""오케스트레이터(총괄) :8700.

앱용 API
- POST /jobs (multipart: file=PDF, options=JSON)  → {context_id, status}. 같은 PDF·같은 옵션이면 이전 job을 돌려준다(멱등성)
- GET  /jobs/{context_id}                         → 상태·단계·결과·질문
- POST /jobs/{context_id}/answer  {"value": …}    → input-required 답
- GET  /agents                                     → Agent Card 레지스트리와 상태
- GET  /logs?context_id=…                          → 공통 로그(에이전트 소통 탭)

PG_FAKE_AGENTS=1이면 부서 에이전트 대신 프로세스 안의 가짜 응답으로 돈다(시연·테스트용).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from ..client import call_agent, new_meta
from ..common_log import log_event, query
from ..config import CORS_ORIGIN_REGEX, PORTS, STORE, agent_url, ensure_dirs, set_agent_name
from ..contracts import AgentCard, AgentRequest
from ..tracing import build_trace
from .engine import Engine, Job
from .fakes import fake_caller
from .plan import build_plan, report_input

NAME = "orchestrator"
DEPTS = [n for n in PORTS if n != NAME]


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    set_agent_name(NAME)
    ensure_dirs()
    yield


app = FastAPI(title="PrintGuard orchestrator", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origin_regex=CORS_ORIGIN_REGEX, allow_methods=["*"], allow_headers=["*"])
JOBS: dict[str, Job] = {}
BY_KEY: dict[str, str] = {}
FAKE = os.environ.get("PG_FAKE_AGENTS") == "1"


async def registry() -> dict[str, dict[str, Any]]:
    """부서 에이전트의 Agent Card를 모은다. 응답이 없으면 off로 표시한다."""
    if FAKE:
        return {d: {"status": "fake", "card": None} for d in DEPTS}
    out: dict[str, dict[str, Any]] = {}
    async with httpx.AsyncClient(timeout=1.5) as c:
        async def one(d: str) -> None:
            try:
                r = await c.get(f"{agent_url(d)}/.well-known/agent-card.json")
                out[d] = {"status": "on", "card": AgentCard.model_validate(r.json()).model_dump(mode="json")}
            except Exception:  # noqa: BLE001
                out[d] = {"status": "off", "card": None}
        await asyncio.gather(*(one(d) for d in DEPTS))
    return out


# ---------- 의뢰의 주인 ----------
# 에이전트는 이 PC 한 대인데 공개 주소로 누구나 들어온다. 주인을 가리지 않으면 남의 파일명과
# 소통 기록이 그대로 보이고, 남의 질문에 대신 답까지 할 수 있다. 그래서 브라우저가 들고 오는
# 임의의 값(X-PG-Client)을 의뢰에 적어 두고, 그 값이 맞는 요청에만 돌려준다.
# 로그인이 아니라 열쇠다. 열쇠를 잃으면 그 브라우저의 지난 의뢰는 다시 못 본다.
Client = Header(None, alias="X-PG-Client")


def _who(raw: str | None) -> str:
    return (raw or "").strip()[:64]


def _mine(client: str) -> set[str]:
    """이 브라우저가 넣은 의뢰 번호. 주인이 없는 옛 의뢰는 아무에게도 보이지 않는다."""
    return {c for c, j in JOBS.items() if j.client and j.client == client} if client else set()


def _owned(ctx: str, client: str) -> Job:
    """남의 의뢰인지 아예 없는 의뢰인지 알려 주지 않으려고 둘 다 404로 답한다."""
    j = JOBS.get(ctx)
    if not j or not client or j.client != client:
        raise HTTPException(404, "없는 의뢰")
    return j


@app.get("/")
async def root() -> dict[str, Any]:
    """포트를 열어 본 사람에게 여기가 화면이 아니라는 것만 알려 준다(주소·내부 구조는 적지 않는다)."""
    return {"data": {"agent": NAME, "note": "에이전트 API입니다. 사람이 쓰는 화면은 앱에서 보세요."}, "meta": {}}


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"data": {"status": "ok", "agent": NAME, "fake": FAKE}, "meta": {}}


@app.get("/jobs")
async def list_jobs(x_pg_client: str | None = Client) -> dict[str, Any]:
    mine = _mine(_who(x_pg_client))
    rows = sorted((j for j in JOBS.values() if j.context_id in mine), key=lambda j: -j.created)[:30]
    return {"data": [{"context_id": j.context_id, "status": j.status, "filename": j.filename, "created": j.created} for j in rows], "meta": {}}


@app.get("/agents")
async def agents() -> dict[str, Any]:
    return {"data": await registry(), "meta": {"fake": FAKE}}


@app.get("/logs")
async def logs(context_id: str | None = None, limit: int = 300, x_pg_client: str | None = Client) -> dict[str, Any]:
    mine = _mine(_who(x_pg_client))
    return {"data": query(limit=limit, contexts=mine & {context_id} if context_id else mine), "meta": {}}


@app.get("/trace")
async def trace(context_id: str, limit: int = 2000, x_pg_client: str | None = Client) -> dict[str, Any]:
    """공통 로그로 만든 의뢰별 추적(에이전트 탭 워터폴). 로그에 있는 것만 담는다."""
    _owned(context_id, _who(x_pg_client))
    return {"data": build_trace(context_id, limit), "meta": {}}


@app.post("/jobs")
async def create_job(file: UploadFile = File(...), options: str = Form("{}"), x_pg_client: str | None = Client) -> dict[str, Any]:
    set_agent_name(NAME)
    data = await file.read()
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, "PDF 파일이 아닙니다")
    opts = json.loads(options or "{}")
    sha = hashlib.sha256(data).hexdigest()
    (STORE / f"{sha}.pdf").write_bytes(data)
    who = _who(x_pg_client)
    # 주인을 키에 섞는다. 안 그러면 같은 PDF를 올린 다른 사람에게 남의 의뢰가 돌아간다
    # 멱등성 키를 세 값의 배열로 묶어서 만든다. 이어 붙이면 경계가 모호해져 다른 조합이 같은 키가 될 수 있다
    key = hashlib.sha256(json.dumps([sha, opts, who], sort_keys=True).encode()).hexdigest()[:24]
    # 같은 PDF·같은 옵션은 이전 의뢰를 돌려준다(멱등성). 단, 실패가 섞인 의뢰(completed_partial·failed)는 다시 실행한다
    if key in BY_KEY and JOBS[BY_KEY[key]].status in ("completed", "working", "input-required"):
        j = JOBS[BY_KEY[key]]
        log_event(j.context_id, "duplicate_job", source=NAME, payload={"idempotency_key": key})
        return {"data": {"context_id": j.context_id, "status": j.status, "duplicate": True}, "meta": {}}
    ctx = f"ctx_job_{secrets.token_hex(4)}"
    job = Job(context_id=ctx, idempotency_key=key, options=opts, pdf_ref=sha, filename=file.filename or "upload.pdf", client=who)
    JOBS[ctx], BY_KEY[key] = job, ctx
    reg = await registry()
    available = {d for d, v in reg.items() if v["status"] in ("on", "fake")}
    log_event(ctx, "job_opened", source=NAME, payload={"agents": sorted(available), "pdf_ref": sha[:12]})
    engine = Engine(build_plan(available), fake_caller if FAKE else None)
    app.state.engines = getattr(app.state, "engines", {})
    app.state.engines[ctx] = engine
    asyncio.create_task(_run(engine, job))
    return {"data": {"context_id": ctx, "status": job.status, "duplicate": False}, "meta": {}}


async def _run(engine: Engine, job: Job) -> None:
    set_agent_name(NAME)
    try:
        await engine.run(job)
    except Exception as e:  # noqa: BLE001
        job.status = "failed"
        log_event(job.context_id, "job_failed", source=NAME, outcome=type(e).__name__)


@app.get("/jobs/{ctx}")
async def get_job(ctx: str, x_pg_client: str | None = Client) -> dict[str, Any]:
    return {"data": _owned(ctx, _who(x_pg_client)).public(), "meta": {}}


@app.post("/jobs/{ctx}/answer")
async def answer(ctx: str, body: dict[str, Any], x_pg_client: str | None = Client) -> dict[str, Any]:
    job = _owned(ctx, _who(x_pg_client))
    if job.status != "input-required":
        raise HTTPException(409, "답을 기다리는 의뢰가 아닙니다")
    set_agent_name(NAME)
    asyncio.create_task(app.state.engines[ctx].answer(job, body.get("value")))
    return {"data": {"context_id": ctx, "status": "working"}, "meta": {}}


# ---------- 인쇄소 찾기·사람 승인·보고서 ----------
async def _ask(agent: str, skill: str, ctx: str, inp: dict[str, Any]) -> dict[str, Any]:
    set_agent_name(NAME)
    r = await call_agent(agent, AgentRequest(meta=new_meta(ctx, seconds=60), skill=skill, input=inp))
    return r.model_dump(mode="json", exclude={"meta"})


@app.get("/guide")
async def guide(q: str, k: int = 5) -> dict[str, Any]:
    """앱의 가이드 검색(에이전트 모드). guide 에이전트가 찾은 원문 절을 그대로 돌려준다."""
    r = await _ask("guide", "search_guide", "ctx_guide_search", {"queries": {"q": q}, "k": max(1, min(10, k))})
    return {"data": (r.get("output") or {}).get("hits", {}).get("q", []) if r.get("status") == "completed" else [], "meta": {"status": r.get("status")}}


@app.get("/shops")
async def shops(q: str = "", sido: str = "", limit: int = 20) -> dict[str, Any]:
    return {"data": await _ask("shop", "find_shops", "ctx_shop_search", {"q": q, "sido": sido, "limit": limit}), "meta": {}}


@app.get("/reviews")
async def reviews(context_id: str | None = None, x_pg_client: str | None = Client) -> dict[str, Any]:
    if context_id:
        _owned(context_id, _who(x_pg_client))
    # 의뢰를 지정하지 않으면 safety가 가진 검토 목록을 그대로 돌려준다(사람 승인용 화면, 파일명은 담기지 않는다)
    async with httpx.AsyncClient(timeout=5) as c:
        r = await c.get(f"{agent_url('safety')}/reviews", params={"context_id": context_id} if context_id else None)
    return r.json()


@app.post("/reviews/{review_id}/decide")
async def decide_review(review_id: str, body: dict[str, Any], authorization: str | None = Header(None)) -> dict[str, Any]:
    """사람 토큰을 그대로 safety에 넘긴다(오케스트레이터는 대신 승인하지 않는다)."""
    async with httpx.AsyncClient(timeout=5) as c:
        r = await c.post(f"{agent_url('safety')}/reviews/{review_id}/decide", json=body, headers={"Authorization": authorization or ""})
    if r.status_code != 200:
        raise HTTPException(r.status_code, r.json().get("detail", "거절"))
    return r.json()


@app.post("/jobs/{ctx}/report")
async def report(ctx: str, x_pg_client: str | None = Client) -> dict[str, Any]:
    j = _owned(ctx, _who(x_pg_client))
    r = await _ask("report", "compile_report", ctx, report_input(j))
    if r["status"] == "completed":
        j.results["report"] = {k: r["output"][k] for k in ("markdown", "path", "verified")}
    return {"data": r, "meta": {}}
