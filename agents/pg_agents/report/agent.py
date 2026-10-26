"""report 에이전트(:8708) — 검수 결과를 보고서(마크다운)로 묶어 파일로 남긴다(A 등급, safety를 거친다).

- 보고서에 적을 ΔE 수치는 받은 값을 그대로 믿지 않고 color.recompute_delta_e로 다시 계산해 대조한다.
  어긋나면 다시 계산한 값을 적고 '불일치'로 표시한다.
- 교정 제안은 '수정 제안'으로만 적는다(자동 수정 없음).
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from ..client import call_agent
from ..config import DATA
from ..contracts import AgentCard, AgentRequest, TaskStatus, now_utc
from ..server import create_agent_app

REPORTS = DATA / "reports"
SEV = {"high": "높음", "medium": "중간", "low": "낮음", "na": "해당 없음"}

CARD = AgentCard.model_validate({
    "name": "report", "description": "검수 보고서 작성(ΔE는 color가 다시 계산해 대조). 파일 쓰기는 safety를 거친다.", "url": "http://127.0.0.1:8708",
    "skills": [{"id": "compile_report", "description": "검수 결과를 마크다운 보고서로 묶어 저장한다", "grade": "A", "allowed_requesters": ["orchestrator", "mcp"],
                "input_schema": {"pdf_ref": "sha256", "filename": "string", "color": "{input, mean_de, profile}?", "issues": "[]", "proofread": "[]", "risks": "[]"},
                "output_schema": {"markdown": "string", "path": "string", "verified": "{delta_e}"}}],
})


async def _verify_de(req: AgentRequest, color: dict[str, Any]) -> dict[str, Any]:
    claimed = float(color.get("mean_de") or 0)
    r = await call_agent("color", AgentRequest(meta=req.meta, skill="recompute_delta_e",
                                                input={**(color.get("input") or {}), "pdf_ref": req.input.get("pdf_ref"), "claimed_mean_de": claimed, "tolerance": 0.05}))
    if r.status != TaskStatus.COMPLETED:
        return {"claimed": claimed, "recomputed": None, "match": None, "note": f"검증하지 못함({r.status} {r.outcome or ''})".strip()}
    return {"claimed": claimed, "recomputed": r.output.get("recomputed"), "match": bool(r.output.get("match"))}


def render(i: dict[str, Any], de: dict[str, Any] | None) -> str:
    L = [f"# 인쇄 전 검수 보고서 — {i.get('filename', '')}", "", f"- 작성: {now_utc().isoformat(timespec='seconds')} (UTC)",
         f"- 의뢰: {i.get('context_id', '')} · {i.get('pages', '?')}쪽 · 종이 {i.get('paper_name') or i.get('paper_id') or '?'}", ""]
    if de:
        L += ["## 색 차이", f"- 프로파일: {(i.get('color') or {}).get('profile', '')}"]
        if de["match"] is True:
            L.append(f"- 면적 가중 평균 ΔE00 {de['claimed']:.2f} (color 에이전트가 다시 계산해 일치: {de['recomputed']:.2f})")
        elif de["match"] is False:
            L.append(f"- 면적 가중 평균 ΔE00 **{de['recomputed']:.2f}** (받은 값 {de['claimed']:.2f}와 불일치 → 다시 계산한 값을 적음)")
        else:
            L.append(f"- 면적 가중 평균 ΔE00 {de['claimed']:.2f} ({de.get('note', '검증하지 못함')})")
        L.append("")
    issues = i.get("issues") or []
    L += [f"## 문제 {len(issues)}건"] + [f"- [{SEV.get(x.get('severity'), x.get('severity'))}] p.{x.get('page', '?')} {x.get('title', '')}" for x in issues[:40]] + [""]
    pr = i.get("proofread") or []
    if pr:
        L += [f"## 교정 제안 {len(pr)}건 (자동으로 고치지 않음. 원본에서 직접 고치세요)"]
        L += [f"- p.{s.get('page')} {s.get('kind_label', '')}: '{s.get('original')}' → '{s.get('suggestion')}'" for s in pr[:60]] + [""]
    risks = i.get("risks") or []
    if risks:
        L += ["## 종이·후가공 위험"] + [f"- [{SEV.get(r.get('level'), r.get('level', ''))}] {r.get('title', '')}" for r in risks[:20]] + [""]
    if i.get("quote"):
        q = i["quote"]
        L += ["## 견적(목업)", f"- {q.get('partner_name')} {int(q.get('amount', 0)):,}원 (견적 {q.get('quote_id')})"]
        if i.get("order"):
            L.append(f"- 주문 {i['order'].get('order_id')} (사람 승인 후 목업 주문)")
        L.append("")
    return "\n".join(L)


async def compile_report(req: AgentRequest) -> dict[str, Any]:
    i = {**req.input, "context_id": req.meta.context_id}
    de = await _verify_de(req, i["color"]) if i.get("color") else None
    md = render(i, de)
    key = "report:" + hashlib.sha256((req.meta.context_id + md.split("\n", 3)[3]).encode()).hexdigest()[:20]
    gate = await call_agent("safety", AgentRequest(meta=req.meta.model_copy(update={"idempotency_key": key}), skill="execute",
                                                    input={"action": "report.compile_report", "idempotency_key": key,
                                                           "params": {"context_id": req.meta.context_id, "chars": len(md)}}))
    d = gate.output if gate.status == TaskStatus.COMPLETED else None
    if not d or d.get("decision") != "executed":
        return {"status": "rejected", "outcome": "SAFETY_REJECTED", "output": {"reason": (d or {}).get("reason", "safety에 닿지 못해 거절(fail-closed)"), "markdown": md}}
    REPORTS.mkdir(parents=True, exist_ok=True)
    path = REPORTS / f"{req.meta.context_id}.md"
    path.write_text(md, encoding="utf-8")
    return {"status": "completed", "output": {"markdown": md, "path": str(path), "verified": {"delta_e": de}, "decision": d},
            "evidence": {"queries": [], "data_summary": f"보고서 {len(md)}자, ΔE 검증 {json.dumps(de['match'] if de else None)}", "ref_ids": [d["execution_id"]]}}


app = create_agent_app(CARD, {"compile_report": compile_report})
