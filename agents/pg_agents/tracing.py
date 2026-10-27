"""공통 로그로 의뢰 하나의 추적을 만든다 — 에이전트별 구간·시간·관문 결정(에이전트 탭 워터폴과 MCP get_trace의 원천).

- 구간(span): 같은 (에이전트, skill)의 request_received ↔ result_sent 짝. 결과가 아직 없으면 열린 구간(open=True).
- 관문(gate): safety_decision·human_review 줄(등급·결정·금액·승인 기록).
- 사건(event): 의뢰 접수·질문·답·종료처럼 짝이 없는 줄.
시간은 첫 줄(t0)로부터의 밀리초로 바꿔 둔다. 공통 로그에 없는 값은 만들어 내지 않는다(판단 문장·입력 본문은 애초에 로그에 없다).
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any

from .common_log import query

GATE_KINDS = ("safety_decision", "human_review")
EVENT_KINDS = ("job_opened", "job_closed", "job_failed", "input_required", "input_answered", "duplicate_job", "task_status")


def _ms(at: str, t0: datetime) -> int:
    return round((datetime.fromisoformat(at) - t0).total_seconds() * 1000)


def build_trace(context_id: str, limit: int = 2000) -> dict[str, Any]:
    """공통 로그 → {t0, total_ms, spans, gates, events, agents}. 로그가 없으면 빈 추적."""
    rows = query(context_id, limit)  # 오래된 줄부터
    empty = {"context_id": context_id, "t0": None, "total_ms": 0, "spans": [], "gates": [], "events": [], "agents": [], "lines": 0}
    if not rows:
        return empty
    t0 = datetime.fromisoformat(rows[0]["at"])
    total = _ms(rows[-1]["at"], t0)
    pending: dict[tuple[str, str | None], list[dict[str, Any]]] = defaultdict(list)
    spans: list[dict[str, Any]] = []
    gates: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []

    for r in rows:
        at, kind = _ms(r["at"], t0), r["kind"]
        if kind == "request_received":
            sp = {"agent": r["source"], "skill": r["skill"], "requester": r["requester"], "start_ms": at, "end_ms": None, "ms": None,
                  "status": "working", "outcome": None, "grade": r["grade"], "open": True}
            pending[(r["source"], r["skill"])].append(sp)
            spans.append(sp)
        elif kind == "result_sent":
            q = pending.get((r["source"], r["skill"])) or []
            sp = q.pop(0) if q else None
            if sp is None:  # 요청 줄이 없으면(로그 유실·잘린 구간) 길이 0으로 둔다
                sp = {"agent": r["source"], "skill": r["skill"], "requester": r["requester"], "start_ms": at, "end_ms": at, "ms": 0,
                      "status": None, "outcome": None, "grade": None, "open": False, "unpaired": True}
                spans.append(sp)
            sp.update(end_ms=at, ms=at - sp["start_ms"], status=r["status"], outcome=r["outcome"], grade=r["grade"] or sp["grade"], open=False)
        elif kind in GATE_KINDS:
            p = r["payload"] or {}
            gates.append({"at_ms": at, "kind": kind, "source": r["source"], "requester": r["requester"], "action": r["skill"],
                          "decision": r["status"], "grade": r["grade"], "reason": p.get("reason"), "amount": p.get("amount"),
                          "review_id": p.get("review_id"), "execution_id": p.get("execution_id")})
        if kind in EVENT_KINDS:
            events.append({"at_ms": at, "kind": kind, "source": r["source"], "skill": r["skill"], "status": r["status"],
                           "outcome": r["outcome"], "payload": r["payload"] or {}})

    spans.sort(key=lambda s: (s["start_ms"], s["agent"]))
    roll: dict[str, dict[str, Any]] = {}
    for s in spans:
        a = roll.setdefault(s["agent"], {"agent": s["agent"], "calls": 0, "ms": 0, "open": 0})
        a["calls"] += 1
        a["ms"] += s["ms"] or 0
        a["open"] += 1 if s["open"] else 0
    return {"context_id": context_id, "t0": rows[0]["at"], "total_ms": total, "spans": spans, "gates": gates, "events": events,
            "agents": sorted(roll.values(), key=lambda a: -a["ms"]), "lines": len(rows)}
