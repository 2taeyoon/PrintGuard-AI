"""PrintGuard 검수 plan.

1단계(병렬): preflight.check_structure ∥ color.predict_color ∥ proofread.suggest_corrections(교정 에이전트가 있을 때)
2단계: paper.assess_risk  — 색 결과(최대 잉크량·이미지 면적)를 받아 종이·후가공 위험도. 후가공을 모르면 input-required
3단계: guide.search_guide — 앞 단계의 문제·위험마다 근거 문단 검색
"""
from __future__ import annotations

from typing import Any

from .engine import Call, Job


def _size(j: Job) -> dict[str, Any]:
    o = j.options
    return {"pdf_ref": j.pdf_ref, "width_mm": o.get("width_mm", 148), "height_mm": o.get("height_mm", 210), "bleed_mm": o.get("bleed_mm", 3)}


def _color(j: Job) -> dict[str, Any]:
    o = j.options
    return {**_size(j), "paper_id": o.get("paper_id", "art"), "profile": o.get("profile", "auto"), "intent": o.get("intent", "relative"),
            "tac_limit": o.get("tac_limit"), "paper_color": o.get("paper_color", True)}


def _risk(j: Job) -> dict[str, Any]:
    o, c = j.options, j.results.get("color", {})
    finish = j.answers.get("finish", o.get("finish", "unknown"))
    return {"paper_id": o.get("paper_id", "art"), "finish": finish, "gsm": o.get("gsm", 150), "max_tac": c.get("max_tac", 0),
            "image_share": (c.get("color_report") or {}).get("areaShare", 0), "has_images": bool((c.get("color_report") or {}).get("images")),
            "tac_limit": c.get("tac_limit") or o.get("tac_limit") or 300}


def _guide(j: Job) -> dict[str, Any]:
    qs: dict[str, str] = {}
    for it in (j.results.get("preflight", {}).get("issues", []) + j.results.get("color", {}).get("issues", [])):
        qs[f"issue:{it.get('key')}"] = f"{it.get('title')}. {it.get('detail')}"
    for r in j.results.get("risk", {}).get("risks", []):
        qs[f"risk:{r['id']}"] = r["query"]
    for s in j.results.get("proofread", {}).get("suggestions", [])[:5]:
        qs[f"proof:{s.get('key')}"] = f"{s.get('kind')} {s.get('reason')}"
    return {"queries": qs, "k": 2}


def build_plan(available: set[str]) -> list[list[Call]]:
    first = [Call("preflight", "preflight", "check_structure", _size), Call("color", "color", "predict_color", _color)]
    if "proofread" in available:
        first.append(Call("proofread", "proofread", "suggest_corrections", lambda j: {"pdf_ref": j.pdf_ref},
                          untrusted=lambda j: {"pdf_text": j.results.get("_text", [])},
                          when=lambda j: bool(j.options.get("proofread", True))))
    plan = [first, [Call("risk", "paper", "assess_risk", _risk)]]
    if "guide" in available:
        plan.append([Call("guide", "guide", "search_guide", _guide)])
    return plan
