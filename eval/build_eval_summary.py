"""평가 산출물(eval/*.json)에서 앱의 '평가' 탭이 쓰는 요약을 만든다 → frontend/public/data/eval_summary.json

수치를 새로 만들지 않고 각 평가 스크립트가 남긴 값을 고르기만 한다. 큰 배열(사진별·종이별 전체)은 담지 않는다.
  python eval/build_eval_summary.py
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = ROOT / "frontend" / "public" / "data" / "eval_summary.json"
sys.stdout.reconfigure(encoding="utf-8")


def load(name: str):
    p = HERE / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


search = load("results.json")
browser = load("browser_int8_result.json")
profiles = load("profiles_result.json")
color = load("color_check_result.json")
quant = load("quant_check.json")
substrate = load("substrate_check.json")
proof = load("proofread/results.json")

out: dict = {"built": date.today().isoformat(), "sources": {}}

# ---------- 1) 가이드 검색 ----------
if search:
    e5 = "multilingual-e5-small"
    pc = "구조 parent-child"
    hybrid = (search.get("hybrid", {}).get(e5, {}).get(pc, {}) or {}).get("2-gram", {})
    out["search"] = {
        "n_questions": search["n_questions"], "kb_chars": search["kb_chars"],
        "chunking": {k: {"search_units": v["search_units"], "returned_units": v["returned_units"],
                         "avg_returned_chars": round(v["avg_returned_chars"], 1)} for k, v in search["chunking_info"].items()},
        "models": {k: {"params_M": v["params_M"], "MB": v["safetensors_MB"], "dim": v["dim"], "load_s": v["load_s"]}
                   for k, v in search["models"].items()},
        # 모델 × 청킹: 1위 적중률과 MRR만
        "dense": {m: {c: {"hit1": v["hit1"], "hit1_ci": v["hit1_ci"], "mrr": v["mrr"]} for c, v in by_c.items()}
                  for m, by_c in search["dense"].items()},
        # 하이브리드 가중치(0=BM25만 … 1=임베딩만), 고른 설정은 0.5
        "hybrid": {w: {"mrr": v["all"]["mrr"], "hit1": v["all"]["hit1"], "dev_mrr": v["dev"]["mrr"], "val_mrr": v["val"]["mrr"]}
                   for w, v in sorted(hybrid.items(), key=lambda kv: float(kv[0]))},
        "tokenizer": {t: {w: v["all"]["mrr"] for w, v in sorted(by_w.items(), key=lambda kv: float(kv[0]))}
                      for t, by_w in ((search.get("hybrid", {}).get(e5, {}).get(pc, {}) or {}).items())},
    }
    out["sources"]["search"] = "eval/run_eval.py → eval/results.json"

if browser:
    b = browser.get("eval31") or {}
    out["browser"] = {"n": browser.get("n"),
                      "load_ms": round(b.get("load_ms", 0)), "query_ms": round(b.get("query_ms", 0), 1),
                      "hit1": (b.get("all") or {}).get("hit1"), "mrr": (b.get("all") or {}).get("mrr")}
    out["sources"]["browser"] = "frontend/scripts/eval-guide-browser.mjs (실제 Chrome, wasm)"

# ---------- 2) 색 차이 ----------
if color:
    out["color_crosscheck"] = {**{k: color[k] for k in
                               ("n", "mean_js", "mean_pillow", "p95_js", "p95_pillow", "mean_abs_diff") if k in color}}
    out["sources"]["color"] = "eval/crosscheck_color.py (앱의 lcms-wasm ↔ Python Pillow 대조)"
if quant:
    out["quant"] = {"max_diff16": quant["max_diff16"], "max_diff8": quant["max_diff8"],
                    "rows": len(quant["rows"])}
if profiles:
    def pick(p: dict, key: str) -> dict:
        v = p.get(key) or {}
        return {"meanDE": v.get("weightedMeanDE"), "over5": v.get("areaOver5"), "over10": v.get("areaOver10")}
    out["profiles"] = {
                       "rows": [{"key": p["key"], "name": p["name"], "condition": p.get("condition", ""), "tac": p.get("tac"),
                                 "white": p.get("white"), "blackL": p.get("blackL"), "papers": p.get("papers"),
                                 "noPaper": pick(p, "noPaper"), "withPaper": pick(p, "withPaper")} for p in profiles]}
    out["sources"]["profiles"] = "frontend/scripts/test-profiles.mts (사진 8장 × 프로파일 13개)"
if substrate:
    out["substrate"] = {
                        "rows": [{k: r[k] for k in ("from", "to", "paperWhiteDE", "none_mean", "ratio_mean", "linear_mean",
                                                    "none_p95", "ratio_p95", "linear_p95") if k in r} for r in substrate]}
    out["sources"]["substrate"] = "frontend/scripts/test-substrate.mts (측정 프로파일 쌍)"

# ---------- 3) 교정 ----------
if proof:
    out["proofread"] = {"n_docs": proof["n_docs"], "n_errors": proof["n_errors"],
                        "llm": proof["llm"],
                        "methods": {k: {"recall": v["recall"], "recall_ci": v["recall_ci"], "precision": v["precision"],
                                        "f1": v["f1"], "suggestions": v["suggestions"], "by_kind": v["recall_by_kind"],
                                        "uses_llm": "llm" in v["methods"]} for k, v in proof["methods"].items()},
                        "clean_fp": {k: v["per_1000_chars"] for k, v in proof["clean_fp"].items()}}
    out["sources"]["proofread"] = "eval/proofread/eval_proofread.py"

OUT.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
print(f"{OUT.relative_to(ROOT)} {OUT.stat().st_size:,} 바이트 — 담은 것: {', '.join(k for k in out if k not in ('built', 'sources'))}")
