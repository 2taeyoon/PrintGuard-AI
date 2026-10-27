"""교정 탐지기 정량평가.

정답을 아는 평가셋: 가이드 KB 문단(정상 문서로 가정) 2개씩을 묶은 문서 60개에 오류를 일부러 넣는다.
오류 유형(규칙이 미리 아는지로 나눔):
  known_misuse  규칙 사전에 있는 오용(몇일, 컨텐츠 …)            ← 규칙에 유리(순환)
  unseen_misuse 규칙 사전에 없는 오용(왠일, 어떻해, 구지 …)
  typo          본문 단어의 한 글자를 비슷한 글자로 바꾼 무작위 오타 ← 어떤 방법도 미리 모름
  spacing       의존명사 붙여 쓰기(할 수 있다 → 할수있다)
  rate          율/률 바꿔 쓰기(비율 → 비률)
지표: 오류 단위 재현율(유형별), 제안 단위 정밀도, 부트스트랩 95% 구간(문서 단위 재표본).
원문(오류를 넣기 전)에 대한 제안 수 = 오탐(1,000자당).
결과: eval/proofread/results.json
"""
from __future__ import annotations

import json
import os
import random
import re
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "agents"))
sys.stdout.reconfigure(encoding="utf-8")
from pg_agents.config import load_env_files  # noqa: E402
from pg_agents.proofread import detectors as det  # noqa: E402
from pg_agents.proofread.detectors import MISUSE, detect  # noqa: E402

random.seed(7)
KB = (ROOT / "frontend" / "public" / "kb" / "print_guide.md").read_text(encoding="utf-8")
SECS = [s.strip() for s in re.split(r"\n## ", KB) if s.strip() and not s.startswith("#")]
SECS = [re.sub(r"^.*?\n", "", s, count=1).replace("\n", " ") for s in SECS]  # 제목 줄 빼고 본문만

UNSEEN = [("웬일", "왠일"), ("어떡해", "어떻해"), ("굳이", "구지"), ("며칠째", "몇일째"), ("눈곱", "눈꼽"), ("안 돼", "안되"),
          ("설렘", "설레임"), ("헷갈리", "헷깔리"), ("움큼", "웅큼"), ("통째로", "통채로")]
UNSEEN = [(r, w) for r, w in UNSEEN if w not in MISUSE]  # 규칙 사전과 겹치면 뺀다
KNOWN = list(MISUSE.items())
RATE = [("비율", "비률"), ("확률", "확율"), ("효율", "효률"), ("합격률", "합격율"), ("불량률", "불량율"), ("백분율", "백분률")]
TEMPL = {
    "known_misuse": "참고로 {w} 문제는 미리 확인한다.",
    "unseen_misuse": "작업자는 {w} 실수를 줄여야 한다.",
    "rate": "이 공정의 {w}은 꾸준히 기록한다.",
    "spacing": "파일은 미리 {w} 확인한다.",
}
SPACING = [("확인할 수 있다", "확인할수있다"), ("인쇄할 때", "인쇄할때"), ("볼 수 없다", "볼수없다"), ("할 수 있도록", "할수있도록"), ("만들 때", "만들때")]


def sim_char(ch: str) -> str:
    """한 음절의 받침이나 모음 하나를 바꾼다(인쇄→인새 같은 오타)."""
    c = ord(ch) - 0xAC00
    cho, jung, jong = c // 588, (c % 588) // 28, c % 28
    if jong and random.random() < 0.5:
        jong = random.choice([j for j in range(28) if j != jong])
    else:
        jung = random.choice([j for j in range(21) if j != jung])
    return chr(0xAC00 + cho * 588 + jung * 28 + jong)


def make_doc(i: int) -> dict:
    base = " ".join(random.sample(SECS, 2))
    errs = []
    sents = [base]
    # 문장형 오류: 템플릿 문장을 넣는다
    for kind in ["known_misuse", "unseen_misuse", "rate", "spacing"]:
        if kind == "known_misuse":
            w, (right, _) = random.choice(KNOWN)
        elif kind == "unseen_misuse":
            right, w = random.choice(UNSEEN)
        elif kind == "rate":
            right, w = random.choice(RATE)
        else:
            right, w = random.choice(SPACING)
        sents.append(TEMPL[kind].format(w=w))
        errs.append({"kind": kind, "wrong": w, "right": right})
    text = " ".join(sents)
    # 무작위 글자 오타 2개: 본문의 두 글자 이상 한글 단어에서
    words = [m for m in re.finditer(r"[가-힣]{3,}", base)]
    for m in random.sample(words, 2):
        k = m.start() + random.randrange(m.end() - m.start())
        new = sim_char(text[k])
        text = text[:k] + new + text[k + 1:]
        errs.append({"kind": "typo", "wrong": text[max(0, k - 0):k + 1], "pos": k, "right": m.group(0)})
    # 위치 찾기(템플릿 오류는 마지막 등장 위치)
    for e in errs:
        if "pos" not in e:
            k = text.rfind(e["wrong"])
            e["pos"], e["end"] = k, k + len(e["wrong"])
        else:
            e["end"] = e["pos"] + 1
    return {"id": i, "base": " ".join(sents), "text": text, "errors": errs}


DOCS = [make_doc(i) for i in range(60)]
METHODS = {"규칙": ["rules"], "Kiwi 오타": ["kiwi_typo"], "Kiwi 띄어쓰기": ["kiwi_space"], "규칙+Kiwi 오타": ["rules", "kiwi_typo"],
           "규칙+Kiwi 오타+띄어쓰기": ["rules", "kiwi_typo", "kiwi_space"]}


# LLM 교정기는 GEMINI_API_KEY가 있을 때만 평가에 넣는다(키가 없으면 조합을 아예 넣지 않는다 — 빈 결과를 0점으로 적지 않기 위해).
# 같은 글을 방법 조합마다 다시 묻지 않도록 호출을 캐시한다(문서 60개의 오류본·원문 + 전체 원문 1개 = API 호출 121회).
load_env_files()  # agents/.env 또는 레포 루트 .env의 GEMINI_API_KEY를 쓴다
LLM_MODEL = os.environ.get("PG_LLM_MODEL", "gemini-2.5-flash")
LLM_ON = bool(os.environ.get("GEMINI_API_KEY"))
if LLM_ON:
    det.DETECTORS["llm"] = lru_cache(maxsize=None)(det.DETECTORS["llm"])
    METHODS["LLM"] = ["llm"]
    METHODS["규칙+Kiwi 오타+LLM"] = ["rules", "kiwi_typo", "llm"]
    print(f"LLM 교정기 평가: {LLM_MODEL} (GEMINI_API_KEY 있음)")
else:
    print("LLM 교정기 평가 건너뜀: GEMINI_API_KEY 없음")


def score(doc: dict, sug: list[dict]) -> tuple[list[bool], list[bool]]:
    hit_err = [any(not (s["end"] <= e["pos"] or s["start"] >= e["end"]) for s in sug) for e in doc["errors"]]
    good_sug = [any(not (s["end"] <= e["pos"] or s["start"] >= e["end"]) for e in doc["errors"]) for s in sug]
    return hit_err, good_sug


def boot(per_doc: list[tuple[int, int]], n: int = 2000) -> list[float]:
    a = np.array(per_doc, dtype=float)
    rs = []
    for _ in range(n):
        idx = np.random.randint(0, len(a), len(a))
        num, den = a[idx, 0].sum(), a[idx, 1].sum()
        rs.append(num / den if den else 0)
    return [float(np.percentile(rs, 2.5)), float(np.percentile(rs, 97.5))]


np.random.seed(0)
clean_chars = sum(len(d["base"]) for d in DOCS)
res = {"n_docs": len(DOCS), "n_errors": sum(len(d["errors"]) for d in DOCS), "methods": {},
       "llm": f"실시: {LLM_MODEL}" if LLM_ON else "미실시: GEMINI_API_KEY 없음"}
for name, ms in METHODS.items():
    rec_doc, prec_doc, by_kind = [], [], {}
    fp_clean = 0
    for d in DOCS:
        sug = detect(d["text"], ms)
        he, gs = score(d, sug)
        rec_doc.append((sum(he), len(he)))
        prec_doc.append((sum(gs), len(gs)))
        for e, h in zip(d["errors"], he):
            by_kind.setdefault(e["kind"], []).append(h)
        fp_clean += len(detect(d["base"].replace("  ", " "), ms)) - sum(1 for e in d["errors"] if e["kind"] != "typo" and e["wrong"] in d["base"] and any(True for _ in [0]))
    R = sum(a for a, _ in rec_doc) / sum(b for _, b in rec_doc)
    P = sum(a for a, _ in prec_doc) / max(1, sum(b for _, b in prec_doc))
    res["methods"][name] = {"methods": ms, "recall": R, "recall_ci": boot(rec_doc), "precision": P, "precision_ci": boot(prec_doc),
                            "f1": 2 * P * R / (P + R) if P + R else 0, "suggestions": sum(b for _, b in prec_doc),
                            "recall_by_kind": {k: float(np.mean(v)) for k, v in sorted(by_kind.items())}}
    print(f"{name:22s} R {R:.3f} {res['methods'][name]['recall_ci']} P {P:.3f} {res['methods'][name]['precision_ci']} 제안 {res['methods'][name]['suggestions']}",
          {k: round(float(np.mean(v)), 2) for k, v in sorted(by_kind.items())})

# 원문(오류를 넣지 않은 KB 문단)에 대한 오탐: 모든 제안이 오탐(KB가 맞춤법상 맞다고 가정, 추정)
clean = " ".join(SECS)
res["clean_fp"] = {name: {"suggestions": len(s := detect(clean, ms)), "per_1000_chars": round(len(s) / len(clean) * 1000, 2),
                          "examples": [f"{x['original']}→{x['suggestion']}" for x in s[:8]]} for name, ms in METHODS.items()}
for name, v in res["clean_fp"].items():
    print("원문 오탐", name, v["suggestions"], v["per_1000_chars"], "/1000자", v["examples"][:4])
if LLM_ON:  # 실제 API 호출 수(캐시 적중은 뺀다)
    res["llm"] += f", API 호출 {det.DETECTORS['llm'].cache_info().misses}회"
res["samples"] = [{"text": DOCS[0]["text"][:400], "errors": DOCS[0]["errors"]}]
(HERE / "results.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
