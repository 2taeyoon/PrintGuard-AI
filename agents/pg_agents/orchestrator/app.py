"""오케스트레이터(총괄) :8700.

앱용 API
- POST /jobs (multipart: file=PDF 또는 source=원본 의뢰 번호, options=JSON) → {context_id, status}. 같은 입력·같은 옵션이면 이전 job을 돌려준다(멱등성)
- GET  /jobs/{context_id}                         → 상태·단계·결과·질문
- POST /jobs/{context_id}/answer  {"value": …}    → input-required 답
- GET  /agents                                     → Agent Card 레지스트리와 상태
- GET  /logs?context_id=…                          → 공통 로그(에이전트 소통 탭)
- GET  /auth/config                                → 로그인 단추를 그리는 데 필요한 구글 클라이언트 ID
- POST /auth/google  {"credential": …}             → 구글 ID 토큰 → 이 앱의 세션 토큰

PG_FAKE_AGENTS=1이면 부서 에이전트 대신 프로세스 안의 가짜 응답으로 돈다(시연·테스트용).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .. import google
from ..auth import Claims, bearer, mint, secret, tool_subject, verify
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

# 총괄의 Agent Card. **받는 일(skill)이 없다** — 이쪽이 시키는 쪽이기 때문이다. 부서 에이전트는
# `/a2a`로 요청을 받지만 총괄은 아무에게도 요청받지 않는다. 브라우저가 HTTP로 부른다.
#
# 그래도 카드를 둔다. 없으면 에이전트 목록에 총괄이 아예 서지 못해서, 계획을 세우고 차례를
# 부르는 당사자만 화면에서 빠진다 — "8/8"처럼 머릿수도 하나 모자라게 세어진다.
# 빈 `skills`를 '없음'으로만 적으면 아무것도 안 하는 쪽으로 읽힌다. 그래서 화면은 빈 자리에
# **무엇을 시키는지**를 적는다.
CARD = AgentCard.model_validate({
    "name": NAME,
    "description": "나머지 에이전트를 시키는 쪽. 올린 파일에 맞는 차례(plan)를 세우고 부서 에이전트를 그 차례대로 "
                   "불러 결과를 모은다. 중간에 누가 물으면 사람에게 옮기고, 답을 받아 그 단계만 다시 부른다. "
                   "되돌릴 수 없는 일은 안전 관문을 거치게 한다.",
    "url": f"http://127.0.0.1:{PORTS[NAME]}",
    "skills": [],
})


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
    """에이전트들의 Agent Card를 모은다. 응답이 없으면 off로 표시한다.

    **총괄 자기도 넣는다.** 빼 두면 계획을 세우고 차례를 부르는 당사자만 화면에서 빠지고,
    머릿수도 하나 모자라게 세어진다. 자기 카드는 HTTP로 돌아 가져오지 않는다 — 이 프로세스가
    들고 있으므로 그대로 쓴다(자기에게 요청을 보내면 그 요청을 받는 일꾼이 자기라서 막힐 수 있다).
    이 함수가 대답하고 있다는 것 자체가 총괄이 켜져 있다는 뜻이다.
    """
    me = {"status": "fake" if FAKE else "on", "card": CARD.model_dump(mode="json")}
    if FAKE:
        return {NAME: me, **{d: {"status": "fake", "card": None} for d in DEPTS}}
    out: dict[str, dict[str, Any]] = {}
    async with httpx.AsyncClient(timeout=1.5) as c:
        async def one(d: str) -> None:
            try:
                r = await c.get(f"{agent_url(d)}/.well-known/agent-card.json")
                out[d] = {"status": "on", "card": AgentCard.model_validate(r.json()).model_dump(mode="json")}
            except Exception:  # noqa: BLE001
                out[d] = {"status": "off", "card": None}
        await asyncio.gather(*(one(d) for d in DEPTS))
    return {NAME: me, **out}


# ---------- 의뢰의 주인 ----------
# 에이전트는 이 PC 한 대인데 공개 주소로 누구나 들어온다. 주인을 가리지 않으면 남의 파일명과
# 소통 기록이 그대로 보이고, 남의 질문에 대신 답까지 할 수 있다. 그래서 요청마다 **서버가 발급해
# 서명한** 토큰을 받고, 그 안의 subject가 맞는 의뢰만 돌려준다(`pg_agents.auth` 참조).
#
# 주인은 두 가지로 생긴다. **로그인은 하지 않아도 된다.**
#
# - 로그인 전: `POST /auth/session`이 익명 토큰을 내준다. 주인 이름은 그때그때 만든 난수라
#   누구인지는 담기지 않는다. 브라우저가 이 값을 들고 있는 동안만 그 의뢰가 보인다.
# - 로그인 뒤: `POST /auth/google`이 구글 계정에 묶인 토큰을 내준다. 주인 이름은 구글 계정
#   번호를 비밀로 해시한 값이라, 다른 기기에서 다시 로그인해도 같은 주인으로 돌아온다.
# - 그 사이를 잇는 것이 `POST /auth/claim`이다. 로그인 전에 넣어 둔 의뢰를 계정으로 옮긴다.
#   옮기지 않으면 "로그인했더니 하던 일이 사라졌다"가 된다.
#
# 여기까지 온 과정: ① 브라우저가 스스로 만든 값(X-PG-Client)을 믿었다 → 기한도 회수도 없었다.
# ② 서버가 익명 세션을 발급했다 → 기한은 생겼지만 '누구'가 없어 탭을 닫으면 본인도 못 찾았다.
# ③ 지금은 익명으로 먼저 쓰고, 로그인하면 그때까지 한 일을 계정으로 옮긴다.
Auth = Header(None, alias="Authorization")
SESSION_HOURS = max(0.1, float(os.environ.get("PG_SESSION_HOURS", "12")))
# 로그인을 무한정 시도할 수 있으면 구글 공개키 확인을 그만큼 돌리게 된다. 발급 자체를 IP로 막는다.
MAX_SESSIONS_PER_IP = max(1, int(os.environ.get("PG_MAX_SESSIONS_PER_IP", "60")))
SESSION_WINDOW = 3600.0
_minted: dict[str, list[float]] = {}


def _claims(header: str | None) -> Claims | None:
    """토큰이 없으면 None. **있는데 틀리면** 401 — 브라우저가 이것을 보고 세션을 새로 받는다.
    둘을 뭉개면 만료된 탭이 '의뢰가 없다'만 보고 영원히 빈 화면에 머문다."""
    raw = bearer(header)
    if raw is None:
        return None
    c = verify(raw)
    if c is None:
        raise HTTPException(401, "로그인이 만료되었거나 토큰이 올바르지 않습니다. 다시 로그인해 주세요")
    return c


def _who(header: str | None) -> str:
    c = _claims(header)
    return c.subject if c else ""


def _writer(header: str | None) -> Claims:
    """상태를 바꾸는 일에만 쓴다. 조회 전용 토큰으로는 통과하지 못한다."""
    c = _claims(header)
    if not c:
        raise HTTPException(401, "토큰이 필요합니다")
    if not c.write:
        raise HTTPException(403, "이 토큰은 조회만 할 수 있습니다. 쓰기 토큰은 "
                                 "`python -m pg_agents.mktoken --write`로 받습니다")
    return c


def _too_often(request: Request) -> None:
    ip = (request.client.host if request.client else "?") or "?"
    now = time.time()
    seen = [t for t in _minted.get(ip, []) if now - t < SESSION_WINDOW]
    if len(seen) >= MAX_SESSIONS_PER_IP:
        raise HTTPException(429, "로그인을 너무 자주 했습니다. 잠시 뒤에 다시 해 주세요")
    seen.append(now)
    _minted[ip] = seen
    if len(_minted) > 4096:  # 오래된 IP는 버린다(메모리가 쌓이기만 하는 것을 막는다)
        for k in [k for k, v in _minted.items() if not v or now - max(v) > SESSION_WINDOW]:
            _minted.pop(k, None)


@app.post("/auth/session")
async def auth_session(request: Request) -> dict[str, Any]:
    """로그인하지 않은 브라우저에 익명 토큰을 내준다. **로그인은 선택이다** — 검사는 이 토큰만으로 다 된다.

    누구인지는 묻지도 담지도 않는다. 하는 일은 "이 브라우저가 넣은 의뢰만 이 브라우저에 보인다"뿐이다.
    브라우저는 이 값을 로컬에 두고, 나중에 로그인하면 `/auth/claim`으로 계정에 옮긴 뒤 지운다.
    """
    _too_often(request)
    return {"data": {"token": mint("browser", hours=SESSION_HOURS, label="anon"),
                     "expires_in": int(SESSION_HOURS * 3600)}, "meta": {}}


@app.post("/auth/claim")
async def auth_claim(body: dict[str, Any], authorization: str | None = Auth) -> dict[str, Any]:
    """로그인 전에 넣어 둔 의뢰를 로그인한 계정으로 옮긴다.

    **무엇으로 권리를 증명하나** — 옮겨 갈 의뢰의 주인인 익명 토큰을 그대로 내민다. 그 토큰을 들고
    있다는 것이 곧 그 의뢰의 주인이라는 뜻이다(번호만 알면 남의 것을 가져갈 수 있어서는 안 된다).
    """
    me = _claims(authorization)
    if not me:
        raise HTTPException(401, "로그인한 토큰이 필요합니다")
    old = verify(str(body.get("token") or ""))
    if old is None or old.kind != "browser":
        raise HTTPException(401, "옮겨 올 토큰을 확인하지 못했습니다")
    if old.subject == me.subject:
        return {"data": {"moved": 0}, "meta": {}}
    moved = [c for c, j in JOBS.items() if j.client and j.client == old.subject]
    for c in moved:
        JOBS[c].client = me.subject
    # 멱등성 키에 주인이 섞여 있다. 주인이 바뀐 의뢰의 키는 더 이상 맞지 않으므로 버린다
    for k, c in list(BY_KEY.items()):
        if c in moved:
            BY_KEY.pop(k, None)
    return {"data": {"moved": len(moved)}, "meta": {}}


@app.get("/auth/config")
async def auth_config() -> dict[str, Any]:
    """브라우저가 로그인 단추를 그리기 전에 묻는다. 클라이언트 ID는 비밀이 아니다 —
    화면에 들고 다녀야 하는 값이라 숨길 수 없고, 숨겨서 얻는 것도 없다.

    왜 이 값을 에이전트가 들고 있나 — 앱은 한 번 배포해 두고 에이전트는 사람마다 자기 PC에서
    켠다. 클라이언트 ID를 앱에 박아 두면 다른 사람이 자기 에이전트를 쓸 때 ID를 못 바꾼다."""
    return {"data": {"google_client_id": google.client_id()}, "meta": {}}


@app.post("/auth/google")
async def auth_google(body: dict[str, Any], request: Request) -> dict[str, Any]:
    """구글 로그인 결과(ID 토큰)를 확인하고 이 앱의 세션 토큰으로 바꿔 준다.

    주인 이름으로는 구글 번호(sub)를 그대로 쓰지 않고 **비밀로 해시한 값**을 쓴다. 의뢰 기록과
    로그에 남는 값이라, 새면 그 사람의 구글 계정 번호가 같이 새기 때문이다. 비밀 파일을 지우면
    해시가 통째로 바뀌어 지난 토큰이 전부 무효가 된다(그것이 회수 수단이다).
    """
    if not google.client_id():
        raise HTTPException(503, "이 에이전트에 구글 클라이언트 ID가 없습니다. 에이전트를 돌리는 쪽에서 "
                                 "PG_GOOGLE_CLIENT_ID를 넣고 다시 켜야 합니다")
    _too_often(request)
    u = google.verify(str(body.get("credential") or ""))
    if u is None:
        raise HTTPException(401, "구글 로그인을 확인하지 못했습니다. 다시 로그인해 주세요")
    sub = hashlib.sha256(secret() + b"google:" + u.sub.encode()).hexdigest()[:32]
    return {"data": {"token": mint("browser", subject=sub, hours=SESSION_HOURS, label=u.email[:40]),
                     "expires_in": int(SESSION_HOURS * 3600),
                     "email": u.email, "name": u.name, "picture": u.picture}, "meta": {}}


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
async def list_jobs(authorization: str | None = Auth) -> dict[str, Any]:
    mine = _mine(_who(authorization))
    rows = sorted((j for j in JOBS.values() if j.context_id in mine), key=lambda j: -j.created)[:30]
    return {"data": [{"context_id": j.context_id, "status": j.status, "filename": j.filename, "created": j.created} for j in rows], "meta": {}}


@app.get("/.well-known/agent-card.json")
async def agent_card() -> dict[str, Any]:
    """총괄도 부서들과 같은 자리에 카드를 띄운다. 받는 일이 없다는 것도 계약의 일부다 —
    적어 두지 않으면 '아직 안 만든 것'과 구별되지 않는다."""
    return CARD.model_dump(mode="json")


@app.get("/agents")
async def agents() -> dict[str, Any]:
    return {"data": await registry(), "meta": {"fake": FAKE}}


@app.get("/logs")
async def logs(context_id: str | None = None, limit: int = 300, authorization: str | None = Auth) -> dict[str, Any]:
    mine = _mine(_who(authorization))
    return {"data": query(limit=limit, contexts=mine & {context_id} if context_id else mine), "meta": {}}


@app.get("/trace")
async def trace(context_id: str, limit: int = 2000, authorization: str | None = Auth) -> dict[str, Any]:
    """공통 로그로 만든 의뢰별 추적(에이전트 탭 워터폴). 로그에 있는 것만 담는다."""
    _owned(context_id, _who(authorization))
    return {"data": build_trace(context_id, limit), "meta": {}}


@app.post("/jobs")
async def create_job(file: UploadFile | None = File(None), options: str = Form("{}"), source: str = Form(""),
                     authorization: str | None = Auth) -> dict[str, Any]:
    """검수 의뢰를 연다. 들어오는 길이 둘이다.

    - `file`: PDF를 그대로 올린 경우.
    - `source`: **편집 파일(IDML)로 먼저 올린 경우**(`POST /designcraft/source`가 내준 의뢰 번호).
      그 원본에서 뽑아 둔 PDF로 검수하고, 검수가 끝나면 그 원본을 고칠 수 있다(plan의 마지막 단계).
      PDF만 올린 의뢰에는 고칠 원본이 없어서 그 단계가 서지 않는다.
    """
    set_agent_name(NAME)
    who = _who(authorization)
    opts = json.loads(options or "{}")
    if source:
        dc = _dc_owned(source, who)      # 남의 원본으로 의뢰를 열 수 없다
        sha = str((dc.get("inspect") or {}).get("pdf_ref") or "")
        if not sha:
            raise HTTPException(409, "원본에서 뽑아 둔 PDF가 없습니다. 원본을 다시 올려 주세요")
        name = dc["filename"]
        # 고칠 때 필요한 것(어느 폴더의 어느 문서인가)을 의뢰에 적어 둔다. plan이 이 값으로 단계를 세운다.
        opts = {**opts, "src_ctx": source, "src_ref": dc["src_ref"], "src_doc": dc.get("doc") or dc["filename"]}
    else:
        if file is None:
            raise HTTPException(400, "검수할 파일이 없습니다")
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
        sha = hashlib.sha256(data).hexdigest()
        (STORE / f"{sha}.pdf").write_bytes(data)
        name = file.filename or "upload.pdf"
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
    ctx = f"ctx_job_{secrets.token_hex(12)}"
    job = Job(context_id=ctx, idempotency_key=key, options=opts, pdf_ref=sha, filename=name, client=who)
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
async def get_job(ctx: str, authorization: str | None = Auth) -> dict[str, Any]:
    return {"data": _owned(ctx, _who(authorization)).public(), "meta": {}}


@app.post("/jobs/{ctx}/answer")
async def answer(ctx: str, body: dict[str, Any], authorization: str | None = Auth) -> dict[str, Any]:
    job = _owned(ctx, _who(authorization))
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
async def reviews(context_id: str | None = None, authorization: str | None = Auth) -> dict[str, Any]:
    who = _who(authorization)
    if context_id:
        _owned(context_id, who)
        return {"data": await _reviews_of({context_id}), "meta": {}}
    return {"data": await _reviews_of(_mine(who)), "meta": {}}


@app.post("/reviews/{review_id}/decide")
async def decide_review(review_id: str, body: dict[str, Any], authorization: str | None = Auth,
                        x_pg_human: str | None = Header(None, alias="X-PG-Human")) -> dict[str, Any]:
    """사람 토큰을 그대로 safety에 넘긴다(오케스트레이터는 대신 승인하지 않는다).

    자격증명이 **둘** 오간다. `Authorization`은 이 세션이 누구의 의뢰를 보는지를 가리는
    오케스트레이터의 토큰이고, `X-PG-Human`은 safety가 요구하는 **사람** 토큰이다. 둘을 한
    헤더에 담으면 세션 토큰이 승인 권한으로 둔갑하거나 그 반대가 된다 — 그래서 따로 받는다.
    오케스트레이터는 사람 토큰을 들여다보지 않고 safety에 그대로 넘긴다(대신 승인하지 않는다).

    넘기기 전에 그 승인 요청이 이 세션의 의뢰에 딸린 것인지부터 본다 — 아니면 남의 주문을
    승인·거절할 수 있게 된다.
    """
    mine = {v["review_id"] for v in await _reviews_of(_mine(_who(authorization)))}
    if review_id not in mine:
        raise HTTPException(404, "없는 승인 요청")
    async with httpx.AsyncClient(timeout=5) as c:
        r = await c.post(f"{agent_url('safety')}/reviews/{review_id}/decide", json=body,
                         headers={"Authorization": x_pg_human or ""})
    if r.status_code != 200:
        raise HTTPException(r.status_code, r.json().get("detail", "거절"))
    return r.json()


@app.post("/jobs/{ctx}/report")
async def report(ctx: str, authorization: str | None = Auth) -> dict[str, Any]:
    """보고서를 만든다(A 등급). 상태를 바꾸는 일이라 **쓰기 권한이 있는 토큰**만 통한다 —
    조회용으로 발급한 MCP 토큰으로는 파일을 남길 수 없다."""
    j = _owned(ctx, _writer(authorization).subject)
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
MAX_ASSET = max(1, int(os.environ.get("PG_MAX_ASSET_MB", "20"))) * 1024 * 1024
ASSET_EXT = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".pdf", ".eps", ".ai", ".svg", ".psd"}
# 엔진 명령표는 버전마다 고정이다. 한 번 받아 들고 있는다(물을 때마다 MCP가 새로 뜬다).
_CMD_CACHE: dict[str, Any] | None = None
# 문서 고치기는 한 번에 MCP 프로세스 하나를 띄우고 PDF·그림까지 뽑는다. 연타로 부르면 PC가 멈춘다.
_EDIT_AT: dict[str, float] = {}
EDIT_GAP = float(os.environ.get("PG_DESIGNCRAFT_EDIT_GAP", "1.0"))


def _too_often_edit(ctx: str) -> None:
    now = time.time()
    if now - _EDIT_AT.get(ctx, 0.0) < EDIT_GAP:
        raise HTTPException(429, "조금 빠릅니다. 한 단계가 끝나고 눌러 주세요")
    _EDIT_AT[ctx] = now
    for k, t in list(_EDIT_AT.items()):     # 오래된 자리는 버린다
        if now - t > 3600:
            _EDIT_AT.pop(k, None)
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
    """주인이거나, 번호를 들고 와 자기 화면으로 가져온 사람(`also`)이면 통과.

    주인이 하나여야 할 이유가 없다. 클로드가 만든 문서를 사람이 자기 화면에서 받고 검수로
    넘기려면 둘 다 주인이어야 한다 — 한쪽을 밀어내면 그 뒤로 클로드가 그 문서를 못 고친다.
    """
    j = DCJOBS.get(ctx)
    if not j or not client or (j.get("client") != client and client not in (j.get("also") or [])):
        raise HTTPException(404, "없는 의뢰")
    return j


def _dc_or_job(ctx: str, client: str) -> None:
    """결과 파일의 주인 확인. 원본 수정은 두 곳에서 돈다 — 원본만 올린 의뢰(ctx_dc_…)와
    검수 흐름 안(ctx_job_…). 작업 폴더 이름이 그 의뢰 번호라서 둘 다 받아야 한다."""
    if ctx.startswith("ctx_job_"):
        _owned(ctx, client)
        return
    _dc_owned(ctx, client)


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
                    authorization: str | None = Auth) -> dict[str, Any]:
    """편집 파일을 올린다. **파일 하나도 되고 폴더째도 된다.**

    IDML은 사진을 링크로만 들고 있어서 파일 하나만 올리면 인쇄용 사진이 빠진다. 폴더로 주면
    DesignCraft가 IDML 옆이나 `Links/`에서 사진을 찾고, `Document Fonts/`가 있으면 글꼴도 읽는다(설치하지 않고 그 폴더에서만).
    그래서 올라온 것을 **폴더 하나로 풀어** 두고 그 안에서 문서를 찾는다(하나만 올려도 같다).
    """
    set_agent_name(NAME)
    who = _who(authorization)
    if not who:
        raise HTTPException(401, "로그인이 필요합니다. 구글로 로그인한 뒤 다시 올려 주세요")
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
    ctx = f"ctx_dc_{secrets.token_hex(12)}"
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


@app.post("/designcraft/create")
async def dc_create(body: dict[str, Any], authorization: str | None = Auth) -> dict[str, Any]:
    """새 문서를 만든다(빈 판형 또는 샘플 잡지).

    만든 것을 **올린 원본과 똑같이** 다룬다 — 같은 보관 폴더에 두고, 같은 `inspect_source`로 열어 보고,
    같은 의뢰 번호로 검수에 넘긴다. 그래야 '만든 파일'만 다른 길로 흐르는 일이 없다.
    """
    set_agent_name(NAME)
    who = _writer(authorization).subject
    active = sum(1 for j in DCJOBS.values() if j.get("client") == who)
    if active >= MAX_ACTIVE * 3:
        raise HTTPException(429, "만든 문서가 너무 많습니다. 잠시 뒤에 다시 해 주세요")
    ensure_dirs()
    ctx = f"ctx_dc_{secrets.token_hex(12)}"
    # 무엇을 폈는지 같이 적는다. 따라 보는 칸이 '무엇을 만들기 시작했다'를 말하려면 이게 있어야 한다.
    log_event(ctx, "dc_create_opened", source=NAME,
              payload={"start": str(body.get("start") or "blank"),
                       "width_mm": body.get("width_mm"), "height_mm": body.get("height_mm"),
                       "pages": body.get("pages"), "facing": bool(body.get("facing"))})
    r = await _ask("designcraft", "create_document", ctx, body)
    if r.get("status") != "completed":
        raise HTTPException(502, (((r.get("output") or {}).get("reason") or (r.get("output") or {}).get("message"))
                                  or "문서를 만들지 못했습니다")[:300])
    made = r.get("output") or {}
    DCJOBS[ctx] = {"client": who, "src_ref": made["src_ref"], "filename": made["doc"], "doc": made["doc"],
                   "files": 1, "created": time.time(), "result": None, "made": True,
                   # 말로 부탁할 때 자리를 잡는 데 쓴다(쪽 크기를 모르면 엉뚱한 곳에 그린다)
                   "width_mm": made.get("width_mm"), "height_mm": made.get("height_mm"),
                   "facing": bool(body.get("facing")),
                   # 여백·도련도 적어 둔다. 이게 없으면 말로 부탁한 것이 여백을 넘어 앉는다.
                   "margin_mm": body.get("margin_mm"), "bleed_mm": body.get("bleed_mm")}
    while len(DCJOBS) > MAX_JOBS:
        DCJOBS.pop(min(DCJOBS, key=lambda k: DCJOBS[k]["created"]), None)
    ins = await _ask("designcraft", "inspect_source", ctx, {"src_ref": made["src_ref"], "filename": made["doc"]})
    if ins.get("status") != "completed":
        raise HTTPException(502, "만든 문서를 다시 열지 못했습니다")
    DCJOBS[ctx]["inspect"] = ins.get("output")
    return {"data": {"context_id": ctx, "filename": made["doc"], "made": True,
                     "width_mm": made.get("width_mm"), "height_mm": made.get("height_mm"),
                     **(ins.get("output") or {})}, "meta": {}}


@app.get("/designcraft/commands")
async def dc_commands() -> dict[str, Any]:
    """엔진이 받는 명령 전부(547개)와 인자 설명.

    **한 번 받아서 들고 있는다.** 명령표는 엔진 버전마다 고정이고, 한 번 물을 때마다 MCP 프로세스가
    새로 뜬다(1초쯤). 화면이 검색할 때마다 띄울 이유가 없다.
    주인을 가리지 않는다 — 누구의 파일도 담기지 않은 '엔진이 뭘 할 수 있나'이기 때문이다.
    """
    global _CMD_CACHE
    if _CMD_CACHE is None:
        r = await _ask("designcraft", "list_commands", "ctx_dc_commands", {})
        if r.get("status") != "completed":
            raise HTTPException(502, "명령 목록을 받지 못했습니다. 원본 수정 에이전트가 켜져 있는지 보세요")
        _CMD_CACHE = r.get("output") or {}
    return {"data": _CMD_CACHE, "meta": {}}


@app.post("/designcraft/{ctx}/edit")
async def dc_edit(ctx: str, body: dict[str, Any], authorization: str | None = Auth) -> dict[str, Any]:
    """만든 문서에 엔진 명령을 얹는다 — 인디자인이 하는 일 전부가 이 창구로 온다.

    **만든 문서만 고친다.** 올린 원본을 이 창구로 고치면 올린 사람의 파일을 제자리에서 덮어쓰게
    된다 — 되돌릴 것이 없어진다. 올린 원본을 고치는 길은 검수 끝의 `apply_fixes` 하나뿐이고,
    그쪽은 올린 파일을 그대로 두고 **사본**을 내준다.
    """
    j = _dc_owned(ctx, _writer(authorization).subject)
    if not j.get("made"):
        raise HTTPException(409, "올리신 원본은 이 창구로 고치지 않습니다. 올린 파일은 그대로 두고, "
                                 "검수가 끝난 자리에서 사본을 고쳐 드립니다")
    _too_often_edit(ctx)
    undo = bool(body.get("undo"))
    cmds = body.get("commands")
    if not undo and (not isinstance(cmds, list) or not cmds):
        raise HTTPException(400, "적용할 명령이 없습니다")
    r = await _ask("designcraft", "edit_document", ctx,
                   {"src_ref": j["src_ref"], "filename": j.get("doc") or j["filename"],
                    "commands": cmds or [], "undo": undo})
    if r.get("status") != "completed":
        raise HTTPException(502, (((r.get("output") or {}).get("reason") or (r.get("output") or {}).get("message"))
                                  or "문서를 고치지 못했습니다")[:300])
    out = r.get("output") or {}
    # 고친 뒤의 '보관된 모습'은 **문서를 다시 열어 본 것**으로 갈아 둔다. 그래야 검수로 넘길 때와
    # 새로 열 때 같은 것을 본다.
    #
    # 고치기가 돌려주는 것을 그대로 덮어쓰면 안 된다. 두 모양이 다르다 — 고치기의 `stories`는
    # 글 덩어리 **개수**이고, 열어 보기의 `stories`는 글 덩어리 **목록**이다(쪽·글자 수·넘침).
    # 개수를 목록 자리에 얹으면 그 문서를 검수로 넘기는 순간 화면이 깨지고(`stories.some is not a
    # function`), 교정이 집을 글도 사라진다. 다시 여는 값은 MCP 한 번이고, 틀린 것을 보관하는
    # 값보다 싸다.
    if out.get("ok"):
        ins = await _ask("designcraft", "inspect_source", ctx,
                         {"src_ref": j["src_ref"], "filename": j.get("doc") or j["filename"]})
        if ins.get("status") == "completed":
            fresh = dict(ins.get("output") or {})
            # 쪽 그림만은 고치기 쪽이 더 많이 뽑는다(열어 보기는 1쪽만 그린다). 그 목록은 살린다 —
            # 여러 쪽짜리에서 2쪽부터가 사라지면 따라 보는 칸이 1쪽만 보여 준다.
            if out.get("shots"):
                fresh["shots"] = out["shots"]
            j["inspect"] = fresh
    return {"data": out, "meta": {"status": r.get("status")}}


@app.get("/designcraft/jobs")
async def dc_jobs(authorization: str | None = Auth) -> dict[str, Any]:
    """내가 만든 문서 목록. 브라우저에서 시작한 것이 바로 보이게 하는 데 쓴다."""
    who = _who(authorization)
    rows = [{"context_id": c, "filename": j.get("filename"), "created": j.get("created"),
             "pages": ((j.get("inspect") or {}).get("pages")), "made": bool(j.get("made"))}
            for c, j in DCJOBS.items()
            if who and (j.get("client") == who or who in (j.get("also") or []))]
    rows.sort(key=lambda r: -(r["created"] or 0))
    return {"data": rows[:20], "meta": {}}


def _watchable(ctx: str) -> dict[str, Any]:
    """번호를 아는 쪽에 열어 주는 '보기 전용' 문. 고치는 창구는 그대로 주인만 들어간다.

    `ctx_dc_` 뒤 24자리는 난수다. 찍어 맞힐 수 없고, 그 번호는 사용자가 쓰는 도구(클로드의
    답, 이 화면)에만 찍힌다. 그래서 공유 링크와 같은 세기로 본다 — 대신 내주는 것은 쪽 그림과
    단계뿐이고, 파일 자체는 주인만 받는다.
    """
    j = DCJOBS.get(ctx)
    if not j:
        raise HTTPException(404, "없는 문서")
    return j


# 이 PC에서 왔는가. 번호 없이 '클로드가 지금 만들고 있는 것'을 보여 줄지를 이것으로 가른다.
#
# 왜 이것으로 충분한가. stdio로 띄운 MCP 서버(클로드·커서)는 **띄운 사람이 주인**이고, 그 주인
# 이름은 서명 비밀에서 뽑은 고정값이다(`tool_subject`). 그 서버가 도는 PC와 이 오케스트레이터가
# 도는 PC는 같다. 그러니 그 PC의 브라우저 앞에 앉은 사람은 그 도구를 쓰는 사람 본인이다 —
# 그 사람에게 '내 클로드가 방금 무엇을 만들었나'를 가리는 것은 지키는 것이 아니라 막는 것이다.
#
# 바깥에서 들어온 요청에는 이 문이 안 열린다. 오케스트레이터를 밖으로 내놓더라도 남의 문서가
# 흘러나가지 않는다 — 그쪽은 번호를 들고 와야 한다.
LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"}


def _at_this_pc(request: Request) -> bool:
    return bool(request.client) and (request.client.host or "") in LOCAL_HOSTS


def _visible(who: str, here: bool) -> set[str]:
    """글로 따라 볼 수 있는 문서들. 내 것 + (이 PC라면) 이 PC의 도구가 만든 것."""
    tool = tool_subject() if here else None
    return {c for c, j in DCJOBS.items()
            if (who and (j.get("client") == who or who in (j.get("also") or [])))
            or (tool and j.get("client") == tool)}


# 따라 보기에 실어 보내는 기록. 걸음(dc_step) 말고도 '무엇이 시작됐나'를 같이 보내야
# 채팅처럼 읽힌다 — 걸음만 있으면 어느 문서의 걸음인지 모른 채 줄만 쌓인다.
# 가져가기(dc_adopted)는 뺀다 — 화면이 문서를 따라갈 때마다 남는 줄이라, 보여 주면
# '내가 보는 중'이라는 말만 채팅에 쌓인다.
FEED_KINDS = {"dc_step", "dc_create_opened", "dc_source_opened", "dc_asked"}
FEED_MAX = 400


@app.get("/designcraft/feed")
async def dc_feed(request: Request, after: int = 0, authorization: str | None = Auth) -> dict[str, Any]:
    """**번호 없이** 지금 무슨 일이 일어나고 있는지. 화면이 되풀이해 물어 채팅처럼 쌓는다.

    번호를 넣어야만 보이던 것이 문제였다. 그 번호는 클로드의 답에만 찍히므로, 보려면 매번
    복사해 와야 했다. 정작 보고 싶은 것은 '지금 뭐 하고 있나' 하나다.

    `after`는 마지막으로 받은 줄 번호다. 그보다 뒤엣것만 돌려준다 — 0.9초마다 200줄을 통째로
    다시 보내면 브라우저가 매번 같은 것을 다시 그린다.
    """
    who = _who(authorization)
    if not who:
        raise HTTPException(401, "로그인이 필요합니다")
    seen = _visible(who, _at_this_pc(request))
    if not seen:
        return {"data": {"rows": [], "docs": {}, "next": after}, "meta": {}}
    rows = [r for r in query(limit=FEED_MAX, contexts=seen)
            if r["kind"] in FEED_KINDS and r["id"] > after]
    docs = {c: {"filename": j.get("filename"), "made": bool(j.get("made")),
                "pages": (j.get("inspect") or {}).get("pages"),
                "width_mm": j.get("width_mm"), "height_mm": j.get("height_mm"),
                "mine": j.get("client") == who or who in (j.get("also") or []),
                "created": j.get("created")}
            for c, j in DCJOBS.items() if c in seen}
    return {"data": {"rows": [{"id": r["id"], "at": r["at"], "ctx": r["context_id"],
                               "kind": r["kind"], "payload": r["payload"]} for r in rows],
                     "docs": docs,
                     "next": rows[-1]["id"] if rows else after}, "meta": {}}


@app.get("/designcraft/{ctx}/watch")
async def dc_watch(ctx: str, authorization: str | None = Auth) -> dict[str, Any]:
    """지금 그 문서가 어떻게 생겼고, 에이전트가 무엇을 하고 있는지."""
    if not _who(authorization):
        raise HTTPException(401, "로그인이 필요합니다")
    j = _watchable(ctx)
    ins = j.get("inspect") or {}
    steps = [r for r in query(limit=200, contexts={ctx}) if r["kind"] == "dc_step"]
    return {"data": {"context_id": ctx, "filename": j.get("filename"),
                     "pages": ins.get("pages"),
                     # 갓 만든 문서는 쪽 그림이 `png` 한 장뿐이다(열어 볼 때 1쪽만 그린다).
                     # 고치고 나면 `shots`로 여러 장이 생긴다. 있는 쪽을 쓴다.
                     "shots": ins.get("shots") or ([ins["png"]] if ins.get("png") else []),
                     "preflight": len(ins.get("preflight") or []),
                     "width_mm": j.get("width_mm"), "height_mm": j.get("height_mm"),
                     # 기록은 오래된 것부터 온다. 앞에서 자르면 40걸음째부터 **새 걸음이 안 보인다** —
                     # 지금 무엇을 하고 있는지가 알고 싶은 것이므로 뒤에서 자른다.
                     "steps": steps[-60:]}, "meta": {}}


@app.get("/designcraft/{ctx}/watch/{name}")
async def dc_watch_file(ctx: str, name: str, authorization: str | None = Auth) -> FileResponse:
    """지켜보기용 쪽 그림. **그림만** 내준다 — 편집 파일과 PDF는 주인만 받는다."""
    if not _who(authorization):
        raise HTTPException(401, "로그인이 필요합니다")
    _watchable(ctx)
    if not re.fullmatch(r"(page\d{1,3}|page1)\.png", name):
        raise HTTPException(404, "지켜보기로는 쪽 그림만 볼 수 있습니다")
    p = (DC_OUT / ctx / name).resolve()
    if (DC_OUT / ctx).resolve() not in p.parents or not p.is_file():
        raise HTTPException(404, "없는 그림")
    return FileResponse(p, media_type="image/png")


@app.post("/designcraft/{ctx}/adopt")
async def dc_adopt(ctx: str, authorization: str | None = Auth) -> dict[str, Any]:
    """번호를 들고 온 사람을 그 문서의 주인으로 **더한다**(원래 주인은 그대로 둔다).

    지켜보기만으로는 받을 수도, 검수로 넘길 수도 없다. 그런데 그 번호는 만든 사람의 도구에만
    찍히므로, 번호를 들고 왔다는 것 자체가 '내가 만든 것'이라는 뜻이다 — 공유 링크와 같은
    세기로 본다. 밀어내지 않고 곁에 두는 이유는, 밀어내면 클로드가 그 문서를 이어서 못 고치기
    때문이다. 누가 가져갔는지는 기록에 남긴다.
    """
    who = _writer(authorization).subject
    j = DCJOBS.get(ctx)
    if not j:
        raise HTTPException(404, "없는 문서")
    if j.get("client") != who and who not in (j.get("also") or []):
        j.setdefault("also", []).append(who)
        j["also"] = j["also"][-8:]
        log_event(ctx, "dc_adopted", source=NAME, payload={"total": len(j["also"]) + 1})
    ins = j.get("inspect") or {}
    return {"data": {"context_id": ctx, "filename": j.get("filename"), "made": bool(j.get("made")),
                     **ins}, "meta": {}}


@app.post("/designcraft/{ctx}/compose")
async def dc_compose(ctx: str, body: dict[str, Any], authorization: str | None = Auth) -> dict[str, Any]:
    """말로 부탁한 것을 엔진 명령으로 **짜 주기만** 한다. 고치지는 않는다.

    짜는 일과 고치는 일을 나눈 이유가 있다. LLM은 틀릴 수 있으므로, 무엇이 일어날지 사람이
    먼저 보고 눌러야 한다. 실제로 고치는 것은 `/edit`이고 그쪽이 safety 관문을 거친다.
    """
    j = _dc_owned(ctx, _writer(authorization).subject)
    if not j.get("made"):
        raise HTTPException(409, "만든 문서에만 쓸 수 있습니다")
    request = str(body.get("request") or "").strip()
    if not request:
        raise HTTPException(400, "무엇을 만들지 적어 주세요")
    if len(request) > 2000:
        raise HTTPException(413, "부탁이 너무 깁니다(2000자까지)")
    # 부탁한 말을 남긴다. 따라 보는 칸에서 이게 사람 쪽 말이 된다 — 한 일만 늘어놓으면
    # 무엇을 시켜서 그렇게 된 것인지가 어디에도 안 남는다.
    log_event(ctx, "dc_asked", source=NAME, payload={"text": request[:500]})
    ins = j.get("inspect") or {}
    r = await _ask("designcraft", "compose", ctx, {
        "request": request, "pages": ins.get("pages"),
        "width_mm": j.get("width_mm") or ins.get("width_mm"),
        "height_mm": j.get("height_mm") or ins.get("height_mm"),
        "facing": bool(j.get("facing")),
        "margin_mm": j.get("margin_mm"), "bleed_mm": j.get("bleed_mm"),
        # 올려 둔 그림의 경로를 같이 넘긴다. 안 넘기면 LLM이 경로를 지어내고 엔진이 거절한다.
        "assets": j.get("assets") or [],
    })
    if r.get("status") != "completed":
        raise HTTPException(502, (((r.get("output") or {}).get("reason") or (r.get("output") or {}).get("message"))
                                  or "명령을 짜지 못했습니다")[:300])
    return {"data": r.get("output") or {}, "meta": {"status": r.get("status")}}


@app.get("/designcraft/{ctx}/progress")
async def dc_progress(ctx: str, authorization: str | None = Auth) -> dict[str, Any]:
    """만드는 동안 무엇을 하고 있는지. 화면이 0.8초마다 물어 따라간다.

    흐름(SSE)을 새로 만들지 않았다 — 한 단계마다 공통 로그에 남으므로 그걸 읽으면 된다.
    `/logs`로는 안 보인다(그쪽은 검수 의뢰만 본다). 주인만 볼 수 있게 여기서 가린다.
    """
    _dc_owned(ctx, _who(authorization))
    rows = [r for r in query(limit=200, contexts={ctx}) if r["kind"] == "dc_step"]
    return {"data": rows[:40], "meta": {}}


@app.post("/designcraft/{ctx}/asset")
async def dc_asset(ctx: str, file: UploadFile = File(...), authorization: str | None = Auth) -> dict[str, Any]:
    """문서에 넣을 사진을 의뢰 폴더에 둔다. 돌려주는 경로를 `file.place`에 그대로 쓴다.

    사진 없이는 '인디자인으로 만들 수 있는 모든 것'이 말이 안 된다. 그런데 브라우저의 사진은
    에이전트 PC에 없으므로, 먼저 **의뢰 폴더 안으로** 받아 둬야 엔진이 읽을 수 있다
    (MCP는 그 폴더 밖을 읽지 못한다 — 그래서 여기로 받는다).
    """
    j = _dc_owned(ctx, _writer(authorization).subject)
    if not j.get("made"):
        raise HTTPException(409, "만든 문서에만 사진을 넣습니다")
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ASSET_EXT:
        raise HTTPException(400, f"넣을 수 없는 그림 형식입니다: {ext or '(확장자 없음)'} — "
                                 f"{', '.join(sorted(ASSET_EXT))} 중 하나여야 합니다")
    d = DC_OUT / ctx / "assets"
    d.mkdir(parents=True, exist_ok=True)
    name = f"{secrets.token_hex(6)}{ext}"
    dest = d / name
    size = 0
    with dest.open("wb") as w:
        while blk := await file.read(1 << 20):
            size += len(blk)
            if size > MAX_ASSET:
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"그림이 너무 큽니다(최대 {MAX_ASSET // (1024 * 1024)}MB)")
            w.write(blk)
    log_event(ctx, "dc_asset_added", source=NAME, payload={"bytes": size, "ext": ext})
    # 의뢰에 적어 둔다 — 말로 부탁할 때 이 목록만 `file.place`에 쓸 수 있다.
    shown = file.filename or name
    j.setdefault("assets", []).append({"name": shown, "path": str(dest)})
    j["assets"] = j["assets"][-20:]
    return {"data": {"path": str(dest), "name": name, "bytes": size,
                     "original": shown}, "meta": {}}


@app.get("/designcraft/{ctx}")
async def dc_get(ctx: str, authorization: str | None = Auth) -> dict[str, Any]:
    """올려 두었거나 만들어 둔 원본을 다시 집어 온다('작업 만들기' → '인쇄 검수'로 넘어올 때).
    화면이 번호 하나만 들고 옮겨 다닐 수 있어야 한다 — 쪽수·미리보기를 주소에 실어 나르지 않는다."""
    j = _dc_owned(ctx, _who(authorization))
    return {"data": {"context_id": ctx, "filename": j["filename"], "made": bool(j.get("made")),
                     **(j.get("inspect") or {})}, "meta": {}}


@app.post("/designcraft/{ctx}/apply")
async def dc_apply(ctx: str, body: dict[str, Any], authorization: str | None = Auth) -> dict[str, Any]:
    """검수에서 복사해 온 교정 목록을 원본에 얹고 PDF로 내보낸다."""
    j = _dc_owned(ctx, _writer(authorization).subject)
    fixes = body.get("fixes")
    if not isinstance(fixes, list) or not fixes:
        raise HTTPException(400, "반영할 교정이 없습니다")
    if len(fixes) > MAX_FIXES:
        raise HTTPException(413, f"교정이 너무 많습니다(최대 {MAX_FIXES}건)")
    # confirm="yes": 이 길은 사람이 화면에서 '반영' 단추를 직접 누른 것이라 더 물을 것이 없다.
    # (검수 흐름 안에서 부를 때는 confirm을 비워 두고 에이전트가 사용자에게 묻는다.)
    r = await _ask("designcraft", "apply_fixes", ctx,
                   {"src_ref": j["src_ref"], "filename": j.get("doc") or j["filename"], "fixes": fixes, "confirm": "yes"})
    if r.get("status") == "completed":
        j["result"] = r.get("output")
    return {"data": r, "meta": {}}


@app.get("/designcraft/{ctx}/file/{name}")
async def dc_file(ctx: str, name: str, authorization: str | None = Auth) -> FileResponse:
    """작업 폴더의 결과물(전후 PNG, 고친 PDF/IDML)을 내려 준다. 폴더 밖은 내보내지 않는다."""
    _dc_or_job(ctx, _who(authorization))
    if name != Path(name).name or name.startswith("."):
        raise HTTPException(400, "잘못된 이름")
    p = (DC_OUT / ctx / name).resolve()
    root = (DC_OUT / ctx).resolve()
    if root not in p.parents or not p.is_file():
        raise HTTPException(404, "없는 파일")
    kind = {".png": "image/png", ".pdf": "application/pdf"}.get(p.suffix.lower(), "application/octet-stream")
    return FileResponse(p, media_type=kind, filename=name)
