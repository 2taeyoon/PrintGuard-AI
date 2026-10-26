"""목업 협력 인쇄소와 견적 계산. 금액은 언제나 이 코드로 계산한다(요청에 적힌 금액이나 LLM 값을 믿지 않는다).

단가는 시연용으로 지어낸 값이다(실제 업체·실제 가격 아님). shop과 safety가 같은 함수를 써서 서로 대조한다.
"""
from __future__ import annotations

import math
from typing import Any

PARTNERS: dict[str, dict[str, Any]] = {
    "mock_ganada": {"name": "(목업) 가나다인쇄", "kind": "오프셋 소량", "setup": 30000, "per_page": 40},
    "mock_haneul": {"name": "(목업) 하늘디지털인쇄", "kind": "디지털(토너)", "setup": 10000, "per_page": 70},
    "mock_paju": {"name": "(목업) 파주오프셋", "kind": "오프셋 대량", "setup": 80000, "per_page": 18},
}
# 종이별 배수(지어낸 값). 목록에 없는 종이(특수지)는 1.3
PAPER_FACTOR = {"art": 1.0, "snow": 1.0, "mfc": 1.1, "woodfree": 0.9, "woodfree_yellow": 0.95, "bulk": 1.05}
BASE_AREA = 148 * 210  # A5 한 쪽 기준
VAT = 0.1


def check_spec(spec: dict[str, Any]) -> dict[str, Any]:
    s = {"pages": int(spec["pages"]), "copies": int(spec["copies"]), "width_mm": float(spec["width_mm"]), "height_mm": float(spec["height_mm"]),
         "bleed_mm": float(spec.get("bleed_mm") or 0), "paper_id": str(spec.get("paper_id") or "art")}
    if not (1 <= s["pages"] <= 1000 and 1 <= s["copies"] <= 100000 and 10 <= s["width_mm"] <= 1000 and 10 <= s["height_mm"] <= 1000):
        raise ValueError("사양 범위를 벗어났습니다(쪽 1~1000, 부수 1~100000, 크기 10~1000mm)")
    return s


def quote(partner: str, spec: dict[str, Any]) -> dict[str, Any]:
    if partner not in PARTNERS:
        raise ValueError(f"목업 협력사가 아닙니다: {partner}")
    p, s = PARTNERS[partner], check_spec(spec)
    area = max(1.0, s["width_mm"] * s["height_mm"] / BASE_AREA)
    paper = PAPER_FACTOR.get(s["paper_id"], 1.3)
    printing = math.ceil(s["pages"] * s["copies"] * p["per_page"] * area * paper)
    supply = p["setup"] + printing
    vat = math.ceil(supply * VAT)
    amount = int(math.ceil((supply + vat) / 10) * 10)
    return {"partner": partner, "partner_name": p["name"], "spec": s, "amount": amount,
            "breakdown": [{"item": "기본(판·세팅)", "won": p["setup"]},
                          {"item": f"인쇄 {s['pages']}쪽×{s['copies']}부×{p['per_page']}원×면적 {area:.2f}×종이 {paper}", "won": printing},
                          {"item": "부가세 10%", "won": vat}]}
