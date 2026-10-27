"""PrintGuard 검수 plan.

1단계(병렬): preflight.check_structure ∥ color.predict_color(종이를 알 때) ∥ proofread.suggest_corrections(교정 에이전트가 켜져 있을 때)
2단계: paper.recommend_paper — 종이를 모르면 PDF 특징으로 후보 3개를 묻는다(input-required)
3단계: color.predict_color — 1단계에서 못 돌렸으면 고른 종이로 실행
4단계: paper.assess_risk — 후가공을 모르면 묻는다(input-required)
5단계: guide.search_guide — 앞 단계의 문제·위험·교정 제안마다 근거 문단 검색
"""
from __future__ import annotations

from typing import Any

from .engine import Call, Job


def paper_id(j: Job) -> str:
    return str(j.answers.get("paper_id") or j.options.get("paper_id") or "art")


def paper_known(j: Job) -> bool:
    return paper_id(j) != "unknown"


def _size(j: Job) -> dict[str, Any]:
    o = j.options
    return {"pdf_ref": j.pdf_ref, "width_mm": o.get("width_mm", 148), "height_mm": o.get("height_mm", 210), "bleed_mm": o.get("bleed_mm", 3)}


def _color(j: Job) -> dict[str, Any]:
    o = j.options
    return {**_size(j), "paper_id": paper_id(j), "profile": o.get("profile", "auto"), "intent": o.get("intent", "relative"),
            # 질문에 답해 종이를 고른 경우엔 그 종이 프로파일의 한도를 쓰고, 처음부터 정한 경우엔 화면의 한도를 쓴다
            "tac_limit": None if ("paper_id" in j.answers and o.get("profile", "auto") == "auto") else o.get("tac_limit"),
            "paper_color": o.get("paper_color", True),
            # 측정한 종이 흰색(선택). 넣으면 color가 프로파일 종이 대신 이 종이 기준으로 옮긴다(report의 ΔE 재계산도 같은 값을 쓴다)
            **({"substrate_white": o["substrate_white"]} if o.get("substrate_white") else {})}


def _recommend(j: Job) -> dict[str, Any]:
    pf = j.results.get("preflight", {})
    cs = pf.get("color_summary") or {}
    return {"pages": pf.get("pages", 1), "width_mm": j.options.get("width_mm", 148), "height_mm": j.options.get("height_mm", 210),
            "images": int(sum(v for v in cs.values() if isinstance(v, (int, float)))), "text_chars": sum(len(t) for t in pf.get("texts", [])),
            "chosen": j.answers.get("paper_id")}


def _risk(j: Job) -> dict[str, Any]:
    o, c = j.options, j.results.get("color", {})
    rep = c.get("color_report") or {}
    return {"paper_id": paper_id(j), "finish": j.answers.get("finish", o.get("finish", "unknown")), "gsm": o.get("gsm", 150),
            "max_tac": c.get("max_tac", 0), "image_share": rep.get("areaShare", 0), "has_images": bool(rep.get("images")),
            "tac_limit": c.get("tac_limit") or o.get("tac_limit") or 300}


def _guide(j: Job) -> dict[str, Any]:
    qs: dict[str, str] = {}
    for it in (j.results.get("preflight", {}).get("issues", []) + j.results.get("color", {}).get("issues", [])):
        qs[f"issue:{it.get('key')}"] = f"{it.get('title')}. {it.get('detail')}"
    for r in j.results.get("risk", {}).get("risks", []):
        qs[f"risk:{r['id']}"] = r["query"]
    for s in j.results.get("proofread", {}).get("suggestions", [])[:10]:
        qs[f"proof:{s.get('key')}"] = f"{s.get('kind_label', '')} {s.get('reason', '')}"
    return {"queries": qs, "k": 2}


# ---------- 5·6단계: 오케스트레이터 API와 MCP 서버가 같이 쓰는 입력 만들기 ----------
def quote_spec(j: Job, copies: int, override: dict[str, Any] | None = None) -> dict[str, Any]:
    """견적 사양은 검수 결과(쪽수)와 의뢰 옵션(크기·도련·종이)에서 만든다. 부수와 협력사만 사용자가 고른다."""
    pf = j.results.get("preflight") or {}
    return {**{k: v for k, v in _size(j).items() if k != "pdf_ref"}, "pages": pf.get("pages", 1), "copies": int(copies or 100),
            "paper_id": paper_id(j), **(override or {})}


def report_input(j: Job) -> dict[str, Any]:
    """보고서 입력. 수치를 새로 만들지 않고 부서 결과에서 고르기만 한다(ΔE는 report가 color로 다시 계산해 대조한다)."""
    res = j.results
    co = res.get("color") or {}
    issues = [{"severity": x.get("severity"), "title": x.get("title"), "page": x.get("page")}
              for x in [*(res.get("preflight") or {}).get("issues", []), *co.get("issues", [])]]
    inp = {"pdf_ref": j.pdf_ref, "filename": j.filename, "pages": (res.get("preflight") or {}).get("pages"), "paper_id": paper_id(j),
           "paper_name": ((res.get("risk") or {}).get("paper") or {}).get("name"), "issues": issues,
           "proofread": [{k: s.get(k) for k in ("page", "kind_label", "original", "suggestion")} for s in (res.get("proofread") or {}).get("suggestions", [])],
           "risks": [{"title": r.get("name"), "level": r.get("level")} for r in (res.get("risk") or {}).get("risks", [])],
           "quote": res.get("quote"), "order": res.get("order")}
    if co.get("color_report"):
        inp["color"] = {"input": {k: v for k, v in _color(j).items() if k != "pdf_ref"}, "mean_de": co["color_report"].get("weightedMeanDE"),
                        "profile": co.get("profile")}
    return inp


def build_plan(available: set[str]) -> list[list[Call]]:
    first = [Call("preflight", "preflight", "check_structure", _size),
             Call("color", "color", "predict_color", _color, when=paper_known)]
    if "proofread" in available:
        first.append(Call("proofread", "proofread", "suggest_corrections", lambda j: {"pdf_ref": j.pdf_ref},
                          when=lambda j: bool(j.options.get("proofread", True))))
    plan = [first,
            [Call("paper_choice", "paper", "recommend_paper", _recommend, when=lambda j: not paper_known(j))],
            [Call("color", "color", "predict_color", _color, when=lambda j: "color" not in j.results and paper_known(j))],
            [Call("risk", "paper", "assess_risk", _risk, when=paper_known)]]
    if "guide" in available:
        plan.append([Call("guide", "guide", "search_guide", _guide)])
    return plan
