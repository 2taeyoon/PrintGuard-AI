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
from ..config import PORTS, STORE, agent_url, ensure_dirs, set_agent_name
from ..contracts import AgentCard, AgentRequest
from .engine import Engine, Job
from .fakes import fake_caller
from .plan import _color, _size, build_plan, paper_id

NAME = "orchestrator"
DEPTS = [n for n in PORTS if n != NAME]


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    set_agent_name(NAME)
    ensure_dirs()
    yield


app = FastAPI(title="PrintGuard orchestrator", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origin_regex=r"http://(127\.0\.0\.1|localhost):\d+", allow_methods=["*"], allow_headers=["*"])
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


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"data": {"status": "ok", "agent": NAME, "fake": FAKE}, "meta": {}}


@app.get("/jobs")
async def list_jobs() -> dict[str, Any]:
    rows = sorted(JOBS.values(), key=lambda j: -j.created)[:30]
    return {"data": [{"context_id": j.context_id, "status": j.status, "filename": j.filename, "created": j.created} for j in rows], "meta": {}}


@app.get("/agents")
async def agents() -> dict[str, Any]:
    return {"data": await registry(), "meta": {"fake": FAKE}}


@app.get("/logs")
async def logs(context_id: str | None = None, limit: int = 300) -> dict[str, Any]:
    return {"data": query(context_id, limit), "meta": {}}


@app.post("/jobs")
async def create_job(file: UploadFile = File(...), options: str = Form("{}")) -> dict[str, Any]:
    set_agent_name(NAME)
    data = await file.read()
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, "PDF 파일이 아닙니다")
    opts = json.loads(options or "{}")
    sha = hashlib.sha256(data).hexdigest()
    (STORE / f"{sha}.pdf").write_bytes(data)
    key = hashlib.sha256((sha + json.dumps(opts, sort_keys=True)).encode()).hexdigest()[:24]
    # 같은 PDF·같은 옵션은 이전 의뢰를 돌려준다(멱등성). 단, 실패가 섞인 의뢰(completed_partial·failed)는 다시 실행한다
    if key in BY_KEY and JOBS[BY_KEY[key]].status in ("completed", "working", "input-required"):
        j = JOBS[BY_KEY[key]]
        log_event(j.context_id, "duplicate_job", source=NAME, payload={"idempotency_key": key})
        return {"data": {"context_id": j.context_id, "status": j.status, "duplicate": True}, "meta": {}}
    ctx = f"ctx_job_{secrets.token_hex(4)}"
    job = Job(context_id=ctx, idempotency_key=key, options=opts, pdf_ref=sha, filename=file.filename or "upload.pdf")
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
async def get_job(ctx: str) -> dict[str, Any]:
    if ctx not in JOBS:
        raise HTTPException(404, "없는 의뢰")
    return {"data": JOBS[ctx].public(), "meta": {}}


@app.post("/jobs/{ctx}/answer")
async def answer(ctx: str, body: dict[str, Any]) -> dict[str, Any]:
    job = JOBS.get(ctx)
    if not job or job.status != "input-required":
        raise HTTPException(409, "답을 기다리는 의뢰가 아닙니다")
    set_agent_name(NAME)
    asyncio.create_task(app.state.engines[ctx].answer(job, body.get("value")))
    return {"data": {"context_id": ctx, "status": "working"}, "meta": {}}


# ---------- 5단계: 인쇄소 견적·주문(목업)·사람 승인·보고서 ----------
async def _ask(agent: str, skill: str, ctx: str, inp: dict[str, Any]) -> dict[str, Any]:
    set_agent_name(NAME)
    r = await call_agent(agent, AgentRequest(meta=new_meta(ctx, seconds=60), skill=skill, input=inp))
    return r.model_dump(mode="json", exclude={"meta"})


def _job(ctx: str) -> Job:
    if ctx not in JOBS:
        raise HTTPException(404, "없는 의뢰")
    return JOBS[ctx]


@app.get("/shops")
async def shops(q: str = "", sido: str = "", limit: int = 20) -> dict[str, Any]:
    return {"data": await _ask("shop", "find_shops", "ctx_shop_search", {"q": q, "sido": sido, "limit": limit}), "meta": {}}


@app.post("/jobs/{ctx}/quote")
async def quote(ctx: str, body: dict[str, Any]) -> dict[str, Any]:
    """사양은 검수 결과(쪽수)와 의뢰 옵션(크기·도련·종이)에서 만든다. 부수와 협력사만 사용자가 고른다."""
    j = _job(ctx)
    pf = j.results.get("preflight") or {}
    spec = {**{k: v for k, v in _size(j).items() if k != "pdf_ref"}, "pages": pf.get("pages", 1), "copies": int(body.get("copies") or 100),
            "paper_id": paper_id(j)}
    r = await _ask("shop", "request_quote", ctx, {"pdf_ref": j.pdf_ref, "partner": body.get("partner"), "spec": {**spec, **(body.get("spec") or {})}})
    if r["status"] == "completed":
        j.results["quote"] = r["output"]["quote"]
        j.results.pop("order", None)
    return {"data": r, "meta": {}}


@app.post("/jobs/{ctx}/order")
async def order(ctx: str) -> dict[str, Any]:
    """처음 부르면 사람 승인 대기(input-required), 승인 뒤 다시 부르면 주문이 생긴다."""
    j = _job(ctx)
    if "quote" not in j.results:
        raise HTTPException(409, "견적을 먼저 받으세요")
    r = await _ask("shop", "place_order", ctx, {"quote_id": j.results["quote"]["quote_id"]})
    if r["status"] == "completed":
        j.results["order"] = r["output"]["order"]
    return {"data": r, "meta": {}}


@app.get("/reviews")
async def reviews(context_id: str | None = None) -> dict[str, Any]:
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
async def report(ctx: str) -> dict[str, Any]:
    j = _job(ctx)
    res = j.results
    co = res.get("color") or {}
    issues = [{"severity": x.get("severity"), "title": x.get("title"), "page": x.get("page")}
              for x in [*(res.get("preflight") or {}).get("issues", []), *co.get("issues", [])]]
    inp = {"pdf_ref": j.pdf_ref, "filename": j.filename, "pages": (res.get("preflight") or {}).get("pages"), "paper_id": paper_id(j),
           "paper_name": ((res.get("risk") or {}).get("paper") or {}).get("name"), "issues": issues,
           "proofread": [{k: s.get(k) for k in ("page", "kind_label", "original", "suggestion")} for s in (res.get("proofread") or {}).get("suggestions", [])],
           "risks": [{"title": r.get("name"), "level": r.get("level")} for r in (res.get("risk") or {}).get("risks", [])],
           "quote": res.get("quote"), "order": res.get("order")}
    if co.get("color_report"):
        inp["color"] = {"input": {k: v for k, v in _color(j).items() if k != "pdf_ref"}, "mean_de": co["color_report"].get("weightedMeanDE"),
                        "profile": co.get("profile")}
    r = await _ask("report", "compile_report", ctx, inp)
    if r["status"] == "completed":
        j.results["report"] = {k: r["output"][k] for k in ("markdown", "path", "verified")}
    return {"data": r, "meta": {}}
