"""proofread 에이전트(:8706) — 맞춤법·띄어쓰기·오타 '수정 제안'만 한다. 자동 수정 skill은 만들지 않는다(사용자 원칙).

- PDF에서 꺼낸 글은 외부 입력(untrusted)이다. LLM을 쓸 때도 데이터 블록으로만 넣는다.
- 탐지 방법은 PG_PROOF_METHODS(쉼표)로 고른다. 기본값은 eval/proofread 정량평가에서 고른 조합.
- 제안의 원문이 그 쪽 글에 없으면 버린다(지어낸 지적 방지). 위치(rect)는 PDF에서 원문을 찾아 붙인다.
"""
from __future__ import annotations

import os
from typing import Any

from ..config import STORE
from ..contracts import AgentCard
from ..server import create_agent_app
from .detectors import detect

DEFAULT_METHODS = os.environ.get("PG_PROOF_METHODS", "rules,kiwi_typo")
KIND_LABEL = {"misuse": "맞춤법·표준어", "spacing": "띄어쓰기", "rate": "율/률", "typo": "오타", "llm": "교정(LLM)"}

CARD = AgentCard.model_validate({
    "name": "proofread", "description": "맞춤법·띄어쓰기·오타 수정 제안(자동 수정 없음). PDF 본문은 untrusted로 다룬다.", "url": "http://127.0.0.1:8706",
    "skills": [{"id": "suggest_corrections", "description": "PDF의 쪽별 글에서 틀린 곳을 찾아 수정 제안을 돌려준다(원문은 고치지 않는다)", "grade": "read",
                "allowed_requesters": ["orchestrator", "report", "mcp"], "input_schema": {"pdf_ref": "sha256", "methods": "string?"},
                "output_schema": {"suggestions": "[{key,page,original,suggestion,reason,kind,kind_label,source,rect}]"}}],
})


def page_texts(pdf_ref: str) -> list[tuple[str, Any]]:
    import fitz
    if not (len(pdf_ref) == 64 and all(c in "0123456789abcdef" for c in pdf_ref)):
        raise ValueError("pdf_ref 형식이 아닙니다")
    doc = fitz.open(STORE / f"{pdf_ref}.pdf")
    return [(p.get_text("text"), p) for p in doc]


def suggest(pdf_ref: str, methods: list[str]) -> list[dict[str, Any]]:
    out = []
    for no, (text, page) in enumerate(page_texts(pdf_ref), start=1):
        for s in detect(text, methods):
            if text[s["start"]:s["end"]] != s["original"]:
                continue
            hits = page.search_for(s["original"])
            r = hits[0] if hits else None
            out.append({**s, "page": no, "kind_label": KIND_LABEL.get(s["kind"], s["kind"]), "key": f"pr-{len(out) + 1}",
                        "rect": [r.x0, r.y0, r.x1, r.y1] if r else None})
    return out


async def suggest_corrections(req):
    methods = [m for m in str(req.input.get("methods") or DEFAULT_METHODS).split(",") if m]
    sug = suggest(str(req.input.get("pdf_ref")), methods)
    return {"status": "completed", "output": {"suggestions": sug, "methods": methods},
            "evidence": {"queries": [], "data_summary": f"제안 {len(sug)}건 ({', '.join(methods)})", "ref_ids": []}}


app = create_agent_app(CARD, {"suggest_corrections": suggest_corrections})
