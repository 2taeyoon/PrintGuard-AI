"""safety 에이전트(:8701) — 상태를 바꾸는 모든 행동의 실행 관문(ax-company-hq SAF 규칙을 옮김).

- 등급은 요청이 아니라 레지스트리(행동 주인 에이전트의 Agent Card)에서 읽는다. params에 grade를 적어도 무시한다.
- 금액은 코드(shop.pricing)로 다시 계산하고, 요청에 적힌 금액과 다르면 거절한다.
- A: 바로 실행 / B: 카드의 verifier가 교차 검증해 맞을 때만 실행 / C: 사람 승인 대기열(기한이 지나면 자동 거절)
- 하루 누적 한도(실행 + 승인 대기 금액). 넘으면 거절.
- 어떤 단계든 확인하지 못하면 거절(fail-closed). 자기 skill만 실행 요청할 수 있다(action 'agent.skill'의 agent = 요청자).
- 같은 (요청자, 멱등 키)는 같은 결정을 돌려준다. 승인 대기 건은 다시 부르면 승인 결과를 반영한다.
- 결정은 safety.sqlite(감사 기록)와 공통 로그에 남는다.

사람용 API: GET /reviews, POST /reviews/{review_id}/decide {approve, note} (Authorization: Bearer human:<이름>, 목 모드)
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import Header, HTTPException

from ..client import call_agent
from ..common_log import log_event
from ..config import DATA, agent_url, is_mock
from ..contracts import AgentCard, AgentRequest, AgentResult, ExecuteDecision, ExecuteRequest, TaskStatus, now_utc
from ..server import create_agent_app
from ..shop import pricing

NAME = "safety"
DB = DATA / "safety.sqlite"
KST = timezone(timedelta(hours=9))


def daily_limit() -> int:
    return int(os.environ.get("PG_DAILY_LIMIT", "1000000"))


def review_ttl() -> float:
    return float(os.environ.get("PG_REVIEW_TTL", "600"))


# 행동별 금액 계산과 검증자 입력은 safety 코드가 정한다(요청자가 정하지 않는다)
AMOUNT = {"shop.request_quote": lambda p: pricing.quote(p["partner"], p["spec"])["amount"],
          "shop.place_order": lambda p: pricing.quote(p["partner"], p["spec"])["amount"]}
VERIFY_INPUT = {"shop.request_quote": lambda p: {"pdf_ref": p["pdf_ref"], "spec": p["spec"]}}
VERIFY_SKILL = {"preflight": "verify_spec", "color": "recompute_delta_e"}
COUNTS_TO_LIMIT = {"C"}


async def fetch_card(agent: str) -> AgentCard:
    async with httpx.AsyncClient(timeout=3) as c:
        r = await c.get(f"{agent_url(agent)}/.well-known/agent-card.json")
        r.raise_for_status()
        return AgentCard.model_validate(r.json())


async def run_verifier(meta: Any, agent: str, skill: str, inp: dict[str, Any]) -> AgentResult:
    return await call_agent(agent, AgentRequest(meta=meta, skill=skill, input=inp))


def _db() -> sqlite3.Connection:
    DB.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    c.executescript("""
    CREATE TABLE IF NOT EXISTS executions(execution_id TEXT PRIMARY KEY, requester TEXT, idem_key TEXT, action TEXT, params_hash TEXT,
      grade TEXT, decision TEXT, reason TEXT, amount INTEGER, review_id TEXT, context_id TEXT, day TEXT, at TEXT, computed TEXT,
      UNIQUE(requester, idem_key));
    CREATE TABLE IF NOT EXISTS reviews(review_id TEXT PRIMARY KEY, execution_id TEXT, status TEXT, expires_at TEXT, decided_by TEXT,
      note TEXT, at TEXT, action TEXT, amount INTEGER, summary TEXT, context_id TEXT);""")
    return c


def _today() -> str:
    return datetime.now(KST).date().isoformat()


def _phash(params: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(params, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _decision(row: sqlite3.Row) -> dict[str, Any]:
    return ExecuteDecision(decision=row["decision"], grade=row["grade"], reason=row["reason"], execution_id=row["execution_id"],
                           review_id=row["review_id"], computed=json.loads(row["computed"] or "{}")).model_dump(mode="json")


def _committed(c: sqlite3.Connection) -> int:
    """오늘 실행됐거나 승인을 기다리는 한도 대상 금액 합."""
    marks = ",".join("?" * len(COUNTS_TO_LIMIT))
    row = c.execute(f"SELECT COALESCE(SUM(amount),0) FROM executions WHERE day=? AND grade IN ({marks}) AND decision IN ('executed','pending_review')",
                    (_today(), *COUNTS_TO_LIMIT)).fetchone()
    return int(row[0])


def sweep_expired(c: sqlite3.Connection) -> None:
    now = now_utc().isoformat()
    for r in c.execute("SELECT review_id, execution_id, context_id FROM reviews WHERE status='pending' AND expires_at<=?", (now,)).fetchall():
        c.execute("UPDATE reviews SET status='expired', at=? WHERE review_id=?", (now, r["review_id"]))
        c.execute("UPDATE executions SET decision='rejected', reason='승인 기한이 지나 자동 거절' WHERE execution_id=?", (r["execution_id"],))
        log_event(r["context_id"], "human_review", source=NAME, status="expired", payload={"review_id": r["review_id"]})
    c.commit()


def _resolve_pending(c: sqlite3.Connection, row: sqlite3.Row) -> sqlite3.Row:
    """승인 대기 건을 다시 부르면: 승인됐으면 한도를 다시 보고 실행, 거절·만료면 거절."""
    sweep_expired(c)
    rv = c.execute("SELECT * FROM reviews WHERE review_id=?", (row["review_id"],)).fetchone()
    if rv["status"] == "approved":
        over = _committed(c) > daily_limit()  # 이 건은 이미 대기 금액으로 합에 들어 있다
        dec, why = ("rejected", "승인 후 하루 누적 한도를 넘어 거절") if over else ("executed", f"사람 승인({rv['decided_by']}) 후 실행")
        c.execute("UPDATE executions SET decision=?, reason=? WHERE execution_id=?", (dec, why, row["execution_id"]))
        c.commit()
    return c.execute("SELECT * FROM executions WHERE execution_id=?", (row["execution_id"],)).fetchone()


async def decide(meta: Any, x: ExecuteRequest) -> dict[str, Any]:
    c = _db()
    try:
        prev = c.execute("SELECT * FROM executions WHERE requester=? AND idem_key=?", (x.requester, x.idempotency_key)).fetchone()
        if prev:
            if prev["action"] != x.action or prev["params_hash"] != _phash(x.params):
                return ExecuteDecision(decision="rejected", grade="C", reason="같은 멱등 키로 다른 요청", execution_id="none").model_dump(mode="json")
            if prev["decision"] == "pending_review":
                prev = _resolve_pending(c, prev)
            return {**_decision(prev), "duplicate": True}

        grade, amount, review_id, computed = "C", 0, None, {}
        try:
            agent, _, skill_id = x.action.partition(".")
            if agent != x.requester:
                raise PermissionError("자기 skill만 실행 요청할 수 있습니다")
            card = await fetch_card(agent)
            skill = next((s for s in card.skills if s.id == skill_id), None)
            if skill is None:
                raise LookupError("레지스트리에 없는 행동")
            grade = skill.grade
            if grade == "read":
                raise PermissionError("read skill은 관문 대상이 아닙니다")
            if x.action in AMOUNT:
                amount = int(AMOUNT[x.action](x.params))
                computed["amount"] = amount
                if "amount" in x.params and int(x.params["amount"]) != amount:
                    raise ValueError(f"금액 불일치: 요청 {x.params['amount']}, 계산 {amount}")
            if grade == "A":
                decision, reason = "executed", "A 등급: 바로 실행"
            elif grade == "B":
                build, vskill = VERIFY_INPUT.get(x.action), VERIFY_SKILL.get(skill.verifier or "")
                if build is None or vskill is None:
                    raise LookupError("검증 방법이 정해지지 않은 B 행동")
                r = await run_verifier(meta, skill.verifier, vskill, build(x.params))
                computed["verifier"] = {"agent": skill.verifier, "skill": vskill, "status": r.status, "output": r.output}
                if r.status != TaskStatus.COMPLETED or r.output.get("match") is not True:
                    why = "; ".join(r.output.get("mismatches") or []) or f"검증자 응답 {r.status} {r.outcome or ''}".strip()
                    raise ValueError(f"교차 검증 실패({skill.verifier}): {why}")
                decision, reason = "executed", f"B 등급: {skill.verifier} 교차 검증 통과"
            else:
                if _committed(c) + amount > daily_limit():
                    raise ValueError(f"하루 누적 한도 {daily_limit():,}원 초과")
                review_id = f"rv_{secrets.token_hex(4)}"
                decision, reason = "pending_review", "C 등급: 사람 승인 필요"
        except Exception as e:  # noqa: BLE001  확인하지 못하면 거절(fail-closed)
            decision, reason = "rejected", f"{e}" if isinstance(e, (PermissionError, LookupError, ValueError)) else f"확인 실패(fail-closed): {type(e).__name__}"

        eid = f"ex_{secrets.token_hex(5)}"
        c.execute("INSERT INTO executions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (eid, x.requester, x.idempotency_key, x.action, _phash(x.params), grade, decision, reason, amount, review_id, x.context_id,
                   _today(), now_utc().isoformat(), json.dumps(computed, ensure_ascii=False)))
        if review_id:
            expires = (now_utc() + timedelta(seconds=review_ttl())).isoformat()
            summary = json.dumps({k: x.params.get(k) for k in ("partner", "spec", "quote_id")}, ensure_ascii=False)
            c.execute("INSERT INTO reviews VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                      (review_id, eid, "pending", expires, None, None, now_utc().isoformat(), x.action, amount, summary, x.context_id))
        c.commit()
        log_event(x.context_id, "safety_decision", source=NAME, requester=x.requester, skill=x.action, status=decision, grade=grade,
                  payload={"reason": reason, "amount": amount, "review_id": review_id, "execution_id": eid})
        return _decision(c.execute("SELECT * FROM executions WHERE execution_id=?", (eid,)).fetchone())
    finally:
        c.close()


CARD = AgentCard.model_validate({
    "name": NAME, "description": "실행 관문: 등급은 레지스트리에서, 금액은 코드로, A 실행·B 교차 검증·C 사람 승인, 하루 한도, fail-closed",
    "url": "http://127.0.0.1:8701",
    "skills": [{"id": "execute", "description": "상태를 바꾸는 행동을 실행해도 되는지 결정한다", "grade": "read",
                "allowed_requesters": ["shop", "report", "orchestrator", "mcp"],
                "input_schema": {"action": "agent.skill", "idempotency_key": "string", "params": "object"},
                "output_schema": {"decision": "executed|pending_review|rejected", "grade": "A|B|C", "reason": "string", "review_id": "string?"}}],
})


async def execute(req: AgentRequest) -> dict[str, Any]:
    # 요청자는 본문이 아니라 토큰에서(공통 뼈대가 meta.requester에 채움)
    x = ExecuteRequest(action=str(req.input.get("action", "")), requester=req.meta.requester or "", context_id=req.meta.context_id,
                       idempotency_key=str(req.input.get("idempotency_key") or req.meta.idempotency_key or ""),
                       params=dict(req.input.get("params") or {}))
    if not x.idempotency_key:
        return {"status": "rejected", "outcome": "INVALID_INPUT", "output": {"message": "멱등 키가 필요합니다"}}
    d = await decide(req.meta, x)
    return {"status": "completed", "output": d, "evidence": {"queries": [], "data_summary": f"{x.action}: {d['decision']}", "ref_ids": [d["execution_id"]]}}


app = create_agent_app(CARD, {"execute": execute})


def human_from(authorization: str | None) -> str:
    tok = (authorization or "").removeprefix("Bearer ").strip()
    if is_mock() and tok.startswith("human:") and len(tok) > 6:
        return tok[6:]
    raise HTTPException(401, "사람 토큰(human:<이름>)이 필요합니다. 에이전트는 승인할 수 없습니다")


@app.get("/reviews")
async def reviews(context_id: str | None = None) -> dict[str, Any]:
    c = _db()
    try:
        sweep_expired(c)
        q = "SELECT * FROM reviews" + (" WHERE context_id=?" if context_id else "") + " ORDER BY at DESC LIMIT 50"
        rows = [dict(r) for r in c.execute(q, (context_id,) if context_id else ()).fetchall()]
        return {"data": rows, "meta": {"daily_limit": daily_limit(), "committed_today": _committed(c)}}
    finally:
        c.close()


@app.post("/reviews/{review_id}/decide")
async def decide_review(review_id: str, body: dict[str, Any], authorization: str | None = Header(None)) -> dict[str, Any]:
    who = human_from(authorization)
    c = _db()
    try:
        sweep_expired(c)
        rv = c.execute("SELECT * FROM reviews WHERE review_id=?", (review_id,)).fetchone()
        if rv is None:
            raise HTTPException(404, "없는 승인 요청")
        if rv["status"] != "pending":
            raise HTTPException(409, f"이미 처리됨: {rv['status']}")
        ok = body.get("approve") is True
        c.execute("UPDATE reviews SET status=?, decided_by=?, note=?, at=? WHERE review_id=?",
                  ("approved" if ok else "rejected", who, str(body.get("note") or "")[:200], now_utc().isoformat(), review_id))
        if not ok:
            c.execute("UPDATE executions SET decision='rejected', reason=? WHERE execution_id=?", (f"사람 거절({who})", rv["execution_id"]))
        c.commit()
        log_event(rv["context_id"], "human_review", source=NAME, requester=f"human:{who}", skill=rv["action"],
                  status="approved" if ok else "rejected", grade="C", payload={"review_id": review_id, "amount": rv["amount"]})
        return {"data": dict(c.execute("SELECT * FROM reviews WHERE review_id=?", (review_id,)).fetchone()), "meta": {}}
    finally:
        c.close()
