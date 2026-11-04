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
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from ..client import call_agent, new_meta
from ..common_log import log_event, query
from ..config import CORS_ORIGIN_REGEX, DC_OUT, PORTS, SRC, STORE, agent_url, ensure_dirs, set_agent_name
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
# 공개 주소로 열려 있으므로 모르는 사람도 PDF를 올릴 수 있다. 제한이 없으면 디스크와 메모리를
# 채워 이 PC를 멈출 수 있다. 숫자는 쓰는 사람이 환경변수로 조절한다.
MAX_UPLOAD = max(1, int(os.environ.get("PG_MAX_UPLOAD_MB", "25"))) * 1024 * 1024
MAX_JOBS = max(10, int(os.environ.get("PG_MAX_JOBS", "200")))          # 넘으면 끝난 의뢰부터 버린다
MAX_ACTIVE = max(1, int(os.environ.get("PG_MAX_ACTIVE_PER_CLIENT", "3")))  # 한 브라우저가 동시에 돌릴 수 있는 수


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
    # 통째로 읽고 나서 크기를 재면 이미 메모리에 들어온 뒤다. 한도를 넘는 순간 끊는다
    buf, size = [], 0
    while blk := await file.read(1 << 20):
        size += len(blk)
        if size > MAX_UPLOAD:
            raise HTTPException(413, f"PDF가 너무 큽니다(최대 {MAX_UPLOAD // (1024 * 1024)}MB)")
        buf.append(blk)
    data = b"".join(buf)
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
    active = sum(1 for j in JOBS.values() if j.client == who and j.status in ("working", "input-required"))
    if who and active >= MAX_ACTIVE:
        raise HTTPException(429, f"이미 진행 중인 검사가 {active}건입니다. 끝난 뒤에 다시 맡겨 주세요")
    _evict()
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


def _evict() -> None:
    """의뢰는 메모리에 쌓이기만 한다. 한도를 넘으면 끝난 것부터, 그래도 넘으면 가장 오래된 것부터 버린다."""
    if len(JOBS) < MAX_JOBS:
        return
    done = sorted((j for j in JOBS.values() if j.status not in ("working", "input-required")), key=lambda j: j.created)
    for j in (done or sorted(JOBS.values(), key=lambda j: j.created))[: len(JOBS) - MAX_JOBS + 1]:
        JOBS.pop(j.context_id, None)
        BY_KEY.pop(j.idempotency_key, None)
        app.state.engines = getattr(app.state, "engines", {})
        app.state.engines.pop(j.context_id, None)


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


async def _reviews_of(contexts: set[str]) -> list[dict[str, Any]]:
    """내 의뢰에 딸린 승인 요청만 모은다. safety에 '전부 달라'고 물으면 남의 주문까지 돌아온다
    (금액·부수·승인한 사람 이름이 들어 있다)."""
    if not contexts:
        return []
    async with httpx.AsyncClient(timeout=5) as c:
        rs = await asyncio.gather(*(c.get(f"{agent_url('safety')}/reviews", params={"context_id": x}) for x in sorted(contexts)),
                                  return_exceptions=True)
    out: list[dict[str, Any]] = []
    for r in rs:
        if not isinstance(r, Exception) and r.status_code == 200:
            out += r.json().get("data", [])
    return sorted(out, key=lambda v: str(v.get("at") or ""), reverse=True)[:50]


@app.get("/reviews")
async def reviews(context_id: str | None = None, x_pg_client: str | None = Client) -> dict[str, Any]:
    who = _who(x_pg_client)
    if context_id:
        _owned(context_id, who)
        return {"data": await _reviews_of({context_id}), "meta": {}}
    return {"data": await _reviews_of(_mine(who)), "meta": {}}


@app.post("/reviews/{review_id}/decide")
async def decide_review(review_id: str, body: dict[str, Any], authorization: str | None = Header(None),
                        x_pg_client: str | None = Client) -> dict[str, Any]:
    """사람 토큰을 그대로 safety에 넘긴다(오케스트레이터는 대신 승인하지 않는다).
    넘기기 전에 그 승인 요청이 이 브라우저의 의뢰에 딸린 것인지부터 본다 — 아니면 남의 주문을
    승인·거절할 수 있게 된다."""
    mine = {v["review_id"] for v in await _reviews_of(_mine(_who(x_pg_client)))}
    if review_id not in mine:
        raise HTTPException(404, "없는 승인 요청")
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


# ---------- DesignCraft(인디자인 원본 수정) ----------
# 검수는 PDF로 하지만 고치는 것은 원본이어야 한다 — DesignCraft에서 PDF는 배치만 되고 글자를
# 집을 수 없다. 그래서 흐름이 둘로 나뉜다: PDF를 검수해 교정 목록을 만들고, 그 목록을 원본에 얹는다.
# 의뢰 번호는 PDF 검수(ctx_job_…)와 따로 쓴다(ctx_dc_…). 주인 가리기는 PDF 쪽과 같은 열쇠를 쓴다.
MAX_SOURCE = max(1, int(os.environ.get("PG_MAX_SOURCE_MB", "60"))) * 1024 * 1024
MAX_FIXES = max(1, int(os.environ.get("PG_MAX_FIXES", "300")))
# INDD는 받지 않는다 — 고친 결과를 INDD로 돌려줄 수 없어서다(자세한 이유는 designcraft 에이전트에).
DC_EXT = {".idml", ".designcraft"}
DC_REFUSED = {
    ".indd": "INDD는 받지 않습니다 — 고친 결과를 INDD로 돌려드릴 수 없어서입니다. "
             "InDesign에서 파일 → 다른 이름으로 저장 → InDesign Markup(IDML)으로 내보내 올려 주세요.",
    ".indt": "INDT는 받지 않습니다 — IDML로 내보내 올려 주세요.",
    ".pdf": "PDF는 고칠 수 없습니다 — PDF에서는 글자를 집을 수 없습니다. 편집 파일(IDML)을 올려 주세요.",
}
DCJOBS: dict[str, dict[str, Any]] = {}


def _dc_owned(ctx: str, client: str) -> dict[str, Any]:
    j = DCJOBS.get(ctx)
    if not j or not client or j.get("client") != client:
        raise HTTPException(404, "없는 의뢰")
    return j


@app.get("/designcraft/status")
async def dc_status() -> dict[str, Any]:
    """MCP가 연결되는지. 안 되는 이유를 **고칠 수 있는 말로** 돌려준다 — 에이전트가 안 떴는지,
    떴는데 CLI가 없는지는 할 일이 전혀 다르다. 둘을 '연결 안 됨'으로 뭉뚱그리면 아무도 못 고친다."""
    r = await _ask("designcraft", "mcp_status", "ctx_dc_status", {})
    if r.get("status") == "completed" and r.get("output"):
        return {"data": r["output"], "meta": {"status": r["status"]}}
    return {"data": {"available": False,
                     "reason": "원본 수정 에이전트(8709)가 대답하지 않습니다. 에이전트가 안 떴거나 옛 버전입니다.",
                     "hint": "에이전트를 돌리는 PC에서 다시 켜 주세요: conda activate dev; python agents/run_agents.py"},
            "meta": {"status": r.get("status")}}


MAX_SOURCE_FILES = max(1, int(os.environ.get("PG_MAX_SOURCE_FILES", "400")))


def _safe_rel(raw: str) -> str:
    """올린 폴더 안의 상대 경로를 믿지 않는다. 브라우저가 주는 값이라 손댈 수 있다.

    `..`·절대 경로·드라이브 문자·빈 조각을 걷어내고, 남은 이름만 다시 잇는다. 이게 뚫리면
    업로드 하나로 이 PC의 아무 자리에나 파일을 쓸 수 있다.
    """
    parts = []
    for seg in raw.replace("\\", "/").split("/"):
        seg = seg.strip()
        if not seg or seg in (".", "..") or ":" in seg:
            continue
        parts.append(seg[:120])
    return "/".join(parts[-8:])  # 너무 깊은 구조는 자른다


@app.post("/designcraft/source")
async def dc_source(files: list[UploadFile] = File(...), paths: str = Form("[]"),
                    x_pg_client: str | None = Client) -> dict[str, Any]:
    """편집 파일을 올린다. **파일 하나도 되고 폴더째도 된다.**

    IDML은 사진을 링크로만 들고 있어서 파일 하나만 올리면 인쇄용 사진이 빠진다. 폴더로 주면
    DesignCraft가 IDML 옆이나 `Links/`에서 사진을 찾고, `Document fonts/`가 있으면 글꼴도 읽는다.
    그래서 올라온 것을 **폴더 하나로 풀어** 두고 그 안에서 문서를 찾는다(하나만 올려도 같다).
    """
    set_agent_name(NAME)
    who = _who(x_pg_client)
    if not who:
        raise HTTPException(400, "브라우저 열쇠가 없습니다")
    if len(files) > MAX_SOURCE_FILES:
        raise HTTPException(413, f"파일이 너무 많습니다(최대 {MAX_SOURCE_FILES}개)")
    try:
        rel = json.loads(paths) if paths else []
    except json.JSONDecodeError:
        rel = []

    ensure_dirs()
    token = secrets.token_hex(8)
    root = SRC / token
    root.mkdir(parents=True, exist_ok=True)
    total, docs, saved = 0, [], 0
    for n, f in enumerate(files):
        name = (rel[n] if n < len(rel) and rel[n] else (f.filename or f"file{n}"))
        safe = _safe_rel(name)
        if not safe:
            continue
        ext = ("." + safe.rsplit(".", 1)[-1].lower()) if "." in safe.rsplit("/", 1)[-1] else ""
        if ext in DC_REFUSED and len(files) == 1:
            raise HTTPException(400, DC_REFUSED[ext])
        dest = root / safe
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("wb") as out:
            while blk := await f.read(1 << 20):
                total += len(blk)
                if total > MAX_SOURCE:
                    raise HTTPException(413, f"올린 것이 너무 큽니다(최대 {MAX_SOURCE // (1024 * 1024)}MB)")
                out.write(blk)
        saved += 1
        if ext in DC_EXT:
            docs.append(safe)

    if not saved:
        raise HTTPException(400, "빈 업로드입니다")
    if not docs:
        raise HTTPException(400, f"안에 편집 파일이 없습니다. {', '.join(sorted(DC_EXT))} 중 하나가 있어야 합니다. "
                                 "InDesign에서 파일 → 다른 이름으로 저장 → InDesign Markup(IDML)으로 내보내 주세요")
    if len(docs) > 1:
        raise HTTPException(400, f"편집 파일이 {len(docs)}개입니다({', '.join(docs[:4])}). 하나만 두고 다시 올려 주세요")

    active = sum(1 for j in DCJOBS.values() if j.get("client") == who)
    if active >= MAX_ACTIVE * 3:
        raise HTTPException(429, "올린 원본이 너무 많습니다. 잠시 뒤에 다시 해 주세요")
    ctx = f"ctx_dc_{secrets.token_hex(4)}"
    doc = docs[0]
    DCJOBS[ctx] = {"client": who, "src_ref": token, "filename": doc.rsplit("/", 1)[-1], "doc": doc,
                   "files": saved, "created": time.time(), "result": None}
    while len(DCJOBS) > MAX_JOBS:
        DCJOBS.pop(min(DCJOBS, key=lambda k: DCJOBS[k]["created"]), None)
    log_event(ctx, "dc_source_opened", source=NAME, payload={"files": saved, "doc": doc})
    r = await _ask("designcraft", "inspect_source", ctx, {"src_ref": token, "filename": doc})
    if r.get("status") != "completed":
        raise HTTPException(502, ((r.get("output") or {}).get("message") or "원본을 열지 못했습니다")[:300])
    DCJOBS[ctx]["inspect"] = r.get("output")
    return {"data": {"context_id": ctx, "filename": doc.rsplit("/", 1)[-1], "uploaded_files": saved,
                     **(r.get("output") or {})}, "meta": {}}


@app.post("/designcraft/{ctx}/apply")
async def dc_apply(ctx: str, body: dict[str, Any], x_pg_client: str | None = Client) -> dict[str, Any]:
    """검수에서 복사해 온 교정 목록을 원본에 얹고 PDF로 내보낸다."""
    j = _dc_owned(ctx, _who(x_pg_client))
    fixes = body.get("fixes")
    if not isinstance(fixes, list) or not fixes:
        raise HTTPException(400, "반영할 교정이 없습니다")
    if len(fixes) > MAX_FIXES:
        raise HTTPException(413, f"교정이 너무 많습니다(최대 {MAX_FIXES}건)")
    r = await _ask("designcraft", "apply_fixes", ctx,
                   {"src_ref": j["src_ref"], "filename": j.get("doc") or j["filename"], "fixes": fixes})
    if r.get("status") == "completed":
        j["result"] = r.get("output")
    return {"data": r, "meta": {}}


@app.get("/designcraft/{ctx}/file/{name}")
async def dc_file(ctx: str, name: str, x_pg_client: str | None = Client) -> FileResponse:
    """작업 폴더의 결과물(전후 PNG, 고친 PDF/IDML)을 내려 준다. 폴더 밖은 내보내지 않는다."""
    _dc_owned(ctx, _who(x_pg_client))
    if name != Path(name).name or name.startswith("."):
        raise HTTPException(400, "잘못된 이름")
    p = (DC_OUT / ctx / name).resolve()
    root = (DC_OUT / ctx).resolve()
    if root not in p.parents or not p.is_file():
        raise HTTPException(404, "없는 파일")
    kind = {".png": "image/png", ".pdf": "application/pdf"}.get(p.suffix.lower(), "application/octet-stream")
    return FileResponse(p, media_type=kind, filename=name)
