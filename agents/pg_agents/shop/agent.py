"""shop 에이전트(:8707) — 인쇄소 찾기(read), 견적 요청(B), 주문(C). 견적·주문은 목업 협력사에만 보낸다.

- find_shops: LOCALDATA 인쇄사 목록(frontend/public/data/shops.json)에서 찾기만 한다. 실제 업체에는 아무것도 보내지 않는다.
- request_quote(B, 검증자 preflight): 금액은 pricing 코드로 계산, safety가 다시 계산·교차 검증한 뒤에만 견적을 만든다.
- place_order(C): safety가 사람 승인 대기열에 올린다. 승인 전에는 input-required(human_input), 승인 뒤 다시 부르면 주문이 생긴다.
- 상태를 바꾸는 일은 모두 safety.execute를 먼저 거친다. safety에 닿지 못하면 거절(fail-closed).
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from functools import lru_cache
from typing import Any

from ..client import call_agent
from ..config import DATA, ROOT
from ..contracts import AgentCard, AgentRequest, TaskStatus, now_utc
from ..server import create_agent_app
from . import pricing

DB = DATA / "shop.sqlite"
SHOPS = ROOT / "frontend" / "public" / "data" / "shops.json"
MOCK_NOTE = "견적·주문은 목업 협력사에만 보냅니다. 실제 인쇄소에는 아무것도 보내지 않습니다. 단가는 시연용으로 지어낸 값입니다."

CARD = AgentCard.model_validate({
    "name": "shop", "description": "인쇄소 찾기·견적·주문(목업 협력사만). 상태를 바꾸는 일은 safety를 거친다.", "url": "http://127.0.0.1:8707",
    "skills": [
        {"id": "find_shops", "description": "공공데이터 인쇄사 목록과 목업 협력사를 찾는다", "grade": "read", "allowed_requesters": ["orchestrator", "mcp"],
         "input_schema": {"q": "string?", "sido": "string?", "limit": "number?"}, "output_schema": {"shops": "[]", "partners": "[]"}},
        {"id": "request_quote", "description": "목업 협력사에 견적을 요청한다(사양은 preflight가 PDF와 대조)", "grade": "B", "verifier": "preflight",
         "allowed_requesters": ["orchestrator", "mcp"], "input_schema": {"pdf_ref": "sha256", "partner": "string", "spec": "{pages,copies,width_mm,height_mm,bleed_mm,paper_id}"},
         "output_schema": {"quote": "{quote_id, amount, breakdown}"}},
        {"id": "place_order", "description": "견적으로 목업 주문을 넣는다(사람 승인 필요)", "grade": "C", "allowed_requesters": ["orchestrator", "mcp"],
         "input_schema": {"quote_id": "string"}, "output_schema": {"order": "{order_id, amount}"}},
    ],
})


def _db() -> sqlite3.Connection:
    DB.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    c.executescript("""
    CREATE TABLE IF NOT EXISTS quotes(quote_id TEXT PRIMARY KEY, context_id TEXT, pdf_ref TEXT, partner TEXT, spec TEXT, amount INTEGER, breakdown TEXT, at TEXT);
    CREATE TABLE IF NOT EXISTS orders(order_id TEXT PRIMARY KEY, quote_id TEXT UNIQUE, context_id TEXT, amount INTEGER, approved_by TEXT, at TEXT);""")
    return c


@lru_cache(maxsize=1)
def _shops() -> tuple[list[str], list[list[Any]]]:
    d = json.loads(SHOPS.read_text(encoding="utf-8"))
    return d["cols"], d["rows"]


async def find_shops(req: AgentRequest) -> dict[str, Any]:
    cols, rows = _shops()
    q, sido = str(req.input.get("q") or "").strip(), str(req.input.get("sido") or "").strip()
    limit = max(1, min(50, int(req.input.get("limit") or 20)))
    ix = {c: i for i, c in enumerate(cols)}
    hit = [r for r in rows if (not q or q in r[ix["name"]] or q in r[ix["addr"]]) and (not sido or r[ix["sido"]] == sido)]
    shops = [{c: r[ix[c]] for c in ("name", "addr", "tel", "lat", "lon", "sido", "sgg")} for r in hit[:limit]]
    partners = [{"id": k, **v} for k, v in pricing.PARTNERS.items()]
    return {"status": "completed", "output": {"shops": shops, "total": len(hit), "partners": partners, "note": MOCK_NOTE},
            "evidence": {"queries": [q or sido or "*"], "data_summary": f"{len(hit)}곳 중 {len(shops)}곳", "ref_ids": []}}


async def _gate(req: AgentRequest, action: str, key: str, params: dict[str, Any]) -> dict[str, Any] | None:
    """safety.execute 결과(결정)를 돌려준다. 닿지 못하면 None(→ 호출한 쪽이 거절)."""
    r = await call_agent("safety", AgentRequest(meta=req.meta.model_copy(update={"idempotency_key": key}), skill="execute",
                                                 input={"action": action, "idempotency_key": key, "params": params}))
    return r.output if r.status == TaskStatus.COMPLETED else None


def _rejected(reason: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"status": "rejected", "outcome": "SAFETY_REJECTED", "output": {"reason": reason, **(extra or {})}}


async def request_quote(req: AgentRequest) -> dict[str, Any]:
    i = req.input
    try:
        q = pricing.quote(str(i.get("partner")), dict(i.get("spec") or {}))
    except (ValueError, KeyError, TypeError) as e:
        return {"status": "rejected", "outcome": "INVALID_INPUT", "output": {"message": str(e)}}
    pdf_ref = str(i.get("pdf_ref") or "")
    params = {"pdf_ref": pdf_ref, "partner": q["partner"], "spec": q["spec"], "amount": q["amount"]}
    key = "quote:" + hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest()[:20]
    d = await _gate(req, "shop.request_quote", key, params)
    if d is None:
        return _rejected("safety에 닿지 못해 거절(fail-closed)")
    if d["decision"] != "executed":
        return _rejected(d["reason"], {"decision": d})
    qid = "q_" + key.split(":")[1][:12]
    c = _db()
    try:
        c.execute("INSERT OR IGNORE INTO quotes VALUES (?,?,?,?,?,?,?,?)", (qid, req.meta.context_id, pdf_ref, q["partner"], json.dumps(q["spec"]),
                                                                          q["amount"], json.dumps(q["breakdown"], ensure_ascii=False), now_utc().isoformat()))
        c.commit()
    finally:
        c.close()
    return {"status": "completed", "output": {"quote": {"quote_id": qid, **q, "mock": True}, "decision": d, "note": MOCK_NOTE},
            "evidence": {"queries": [], "data_summary": f"{q['partner_name']} {q['amount']:,}원", "ref_ids": [qid, d["execution_id"]]}}


async def place_order(req: AgentRequest) -> dict[str, Any]:
    qid = str(req.input.get("quote_id") or "")
    c = _db()
    try:
        row = c.execute("SELECT * FROM quotes WHERE quote_id=?", (qid,)).fetchone()
        if row is None:
            return {"status": "rejected", "outcome": "INVALID_INPUT", "output": {"message": "없는 견적"}}
        params = {"quote_id": qid, "pdf_ref": row["pdf_ref"], "partner": row["partner"], "spec": json.loads(row["spec"]), "amount": row["amount"]}
        d = await _gate(req, "shop.place_order", f"order:{qid}", params)
        if d is None:
            return _rejected("safety에 닿지 못해 거절(fail-closed)")
        if d["decision"] == "pending_review":
            return {"status": "input-required", "reason_code": "human_input", "output": {"decision": d},
                    "question": {"kind": "approval", "field": "approval", "review_id": d["review_id"], "amount": row["amount"],
                                 "text": f"{pricing.PARTNERS[row['partner']]['name']}에 {row['amount']:,}원 목업 주문을 넣을까요? 사람 승인이 필요합니다."}}
        if d["decision"] != "executed":
            return _rejected(d["reason"], {"decision": d})
        oid = "o_" + qid[2:]
        c.execute("INSERT OR IGNORE INTO orders VALUES (?,?,?,?,?,?)", (oid, qid, req.meta.context_id, row["amount"], d["reason"], now_utc().isoformat()))
        c.commit()
        o = dict(c.execute("SELECT * FROM orders WHERE order_id=?", (oid,)).fetchone())
    finally:
        c.close()
    return {"status": "completed", "output": {"order": {**o, "mock": True}, "decision": d, "note": MOCK_NOTE},
            "evidence": {"queries": [], "data_summary": f"주문 {oid} {o['amount']:,}원", "ref_ids": [oid, d["execution_id"]]}}


app = create_agent_app(CARD, {"find_shops": find_shops, "request_quote": request_quote, "place_order": place_order})
