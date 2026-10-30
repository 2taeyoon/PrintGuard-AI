"""shop 에이전트(:8707) — 인쇄소 찾기(read).

- find_shops: 공공 인허가 데이터로 만든 인쇄소 목록(frontend/public/data/shops.json)에서 찾기만 한다.
  실제 업체에는 아무것도 보내지 않고, 상태를 바꾸는 일도 하지 않는다.
"""
from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from ..config import ROOT
from ..contracts import AgentCard, AgentRequest
from ..server import create_agent_app

SHOPS = ROOT / "frontend" / "public" / "data" / "shops.json"

CARD = AgentCard.model_validate({
    "name": "shop", "description": "공공 인허가 데이터에서 인쇄소를 찾는다(조회만).", "url": "http://127.0.0.1:8707",
    "skills": [
        {"id": "find_shops", "description": "공공데이터 인쇄사 목록에서 찾는다", "grade": "read", "allowed_requesters": ["orchestrator", "mcp"],
         "input_schema": {"q": "string?", "sido": "string?", "limit": "number?"}, "output_schema": {"shops": "[]"}},
    ],
})


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
    return {"status": "completed", "output": {"shops": shops, "total": len(hit)},
            "evidence": {"queries": [q or sido or "*"], "data_summary": f"{len(hit)}곳 중 {len(shops)}곳", "ref_ids": []}}


app = create_agent_app(CARD, {"find_shops": find_shops})
