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


def suggest(pdf_ref: str, methods: list[str]) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """쪽마다 탐지기를 돌려 제안을 모은다. 넘어진 방법은 **그 쪽에서 빼고 계속 간다.**

    탐지는 쪽 단위다. 20쪽짜리면 LLM을 스무 번 부르는데, 무료 등급은 분당 횟수가 정해져 있어
    중간에 429가 난다. 한 번 한도에 걸린 방법을 남은 열아홉 쪽에서 계속 부르면, 쪽마다 35초씩
    기다렸다 또 실패한다 — 검수가 몇 분씩 늘어지고 결과는 같다. 그래서 한 번 넘어지면 뺀다.
    무엇이 빠졌는지는 돌려줘서 화면이 말할 수 있게 한다.
    """
    out: list[dict[str, Any]] = []
    left = list(methods)
    bad: dict[str, str] = {}
    for no, (text, page) in enumerate(page_texts(pdf_ref), start=1):
        found, broke = detect(text, left)
        for m, why in broke.items():
            bad.setdefault(m, why)
            if m in left:
                left.remove(m)
        for s in found:
            if text[s["start"]:s["end"]] != s["original"]:
                continue
            hits = page.search_for(s["original"])
            r = hits[0] if hits else None
            out.append({**s, "page": no, "kind_label": KIND_LABEL.get(s["kind"], s["kind"]), "key": f"pr-{len(out) + 1}",
                        "rect": [r.x0, r.y0, r.x1, r.y1] if r else None})
    return out, bad


# 방법 이름을 사람 말로. 화면이 '무엇이 빠졌는지'를 말하려면 이 이름이 필요하다.
METHOD_LABEL = {"rules": "규칙 사전", "kiwi_typo": "Kiwi 오타 모델", "kiwi_space": "Kiwi 띄어쓰기", "llm": "LLM 교정"}


async def suggest_corrections(req):
    methods = [m for m in str(req.input.get("methods") or DEFAULT_METHODS).split(",") if m]
    sug, bad = suggest(str(req.input.get("pdf_ref")), methods)
    # 넘어진 방법이 있어도 **완료로 돌려준다.** 전에는 통째로 실패여서, LLM이 분당 한도에 걸리면
    # 규칙·Kiwi가 찾아 둔 맞춤법까지 같이 사라지고 뒤의 원본 수정 단계도 서지 못했다.
    skipped = [{"method": m, "label": METHOD_LABEL.get(m, m), "reason": why} for m, why in bad.items()]
    note = f" · 빠짐 {', '.join(s['label'] for s in skipped)}" if skipped else ""
    return {"status": "completed", "output": {"suggestions": sug, "methods": methods, "skipped": skipped},
            "evidence": {"queries": [], "data_summary": f"제안 {len(sug)}건 ({', '.join(methods)}){note}", "ref_ids": []}}


app = create_agent_app(CARD, {"suggest_corrections": suggest_corrections})
