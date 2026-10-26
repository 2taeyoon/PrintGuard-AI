"""guide 에이전트(:8704) — 인쇄 가이드 하이브리드 검색(RAG의 R).

정량평가(eval/run_eval.py, 아티팩트 1~7절)에서 고른 설정을 그대로 쓴다:
구조 기반 parent-child(## 절을 150자/겹침 25자로 잘라 검색, 걸리면 절 전체 반환) + multilingual-e5-small(query:/passage:)
+ 2-gram BM25, 각각 z-점수로 정규화해 dense 0.5 : BM25 0.5. 답을 지어내지 않고 원문 절과 걸린 조각을 돌려준다.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from functools import lru_cache

import numpy as np

from ..config import ROOT
from ..contracts import AgentCard
from ..server import create_agent_app

KB = ROOT / "frontend" / "public" / "kb" / "print_guide.md"
DENSE_WEIGHT = 0.5

CARD = AgentCard.model_validate({
    "name": "guide", "description": "인쇄 가이드 하이브리드 검색(e5-small + 2-gram BM25). 상태를 바꾸지 않는다.", "url": "http://127.0.0.1:8704",
    "skills": [{"id": "search_guide", "description": "질문(여러 개 가능)마다 가까운 가이드 절을 k개 돌려준다", "grade": "read",
                "allowed_requesters": ["orchestrator", "proofread", "report", "mcp"],
                "input_schema": {"queries": "{key: 질문}", "k": "number"}, "output_schema": {"hits": "{key: [{doc,title,text,child,score}]}"}}],
})


def parse(md: str) -> list[dict[str, str]]:
    secs, doc, cur = [], "", None
    for line in md.splitlines():
        if line.startswith("# "):
            doc = line[2:].strip()
        elif line.startswith("## "):
            cur = {"doc": doc, "title": line[3:].strip(), "body": []}
            secs.append(cur)
        elif cur is not None and line.strip():
            cur["body"].append(line.strip())
    return [{"doc": s["doc"], "title": s["title"], "text": s["title"] + "\n" + "\n".join(s["body"])} for s in secs]


def fixed(text: str, size: int = 150, overlap: int = 25) -> list[str]:
    step = size - overlap
    return [text[i:i + size] for i in range(0, max(len(text) - overlap, 1), step)]


def bigrams(t: str) -> list[str]:
    s = re.sub(r"\s+", "", t)
    return [s] if len(s) < 2 else [s[i:i + 2] for i in range(len(s) - 1)]


class BM25:
    def __init__(self, docs: list[str], k1: float = 1.5, b: float = 0.75) -> None:
        self.tf = [Counter(bigrams(d)) for d in docs]
        self.len = [sum(c.values()) for c in self.tf]
        self.avg = sum(self.len) / len(self.len)
        df = Counter(w for c in self.tf for w in c)
        n = len(docs)
        self.idf = {w: math.log(1 + (n - f + 0.5) / (f + 0.5)) for w, f in df.items()}
        self.k1, self.b = k1, b

    def scores(self, q: str) -> np.ndarray:
        qs = bigrams(q)
        return np.array([sum(self.idf.get(w, 0) * c[w] * (self.k1 + 1) / (c[w] + self.k1 * (1 - self.b + self.b * ln / self.avg))
                             for w in qs if w in c) for c, ln in zip(self.tf, self.len)])


def z(x: np.ndarray) -> np.ndarray:
    sd = x.std()
    return (x - x.mean()) / sd if sd > 1e-9 else np.zeros_like(x)


@lru_cache(maxsize=1)
def index():
    from sentence_transformers import SentenceTransformer  # 무거워서 첫 요청 때 불러온다
    secs = parse(KB.read_text(encoding="utf-8"))
    children = [(c, i) for i, s in enumerate(secs) for c in fixed(s["text"])]
    model = SentenceTransformer("intfloat/multilingual-e5-small", device="cpu")
    vec = model.encode(["passage: " + c for c, _ in children], normalize_embeddings=True, batch_size=32)
    return secs, children, model, vec, BM25([c for c, _ in children])


def search(q: str, k: int = 3) -> list[dict]:
    secs, children, model, vec, bm = index()
    qv = model.encode(["query: " + q], normalize_embeddings=True)[0]
    fused = DENSE_WEIGHT * z(vec @ qv) + (1 - DENSE_WEIGHT) * z(bm.scores(q))
    best: dict[int, tuple[float, str]] = {}
    for (child, p), s in zip(children, fused):
        if p not in best or best[p][0] < s:
            best[p] = (float(s), child)
    top = sorted(best.items(), key=lambda kv: -kv[1][0])[:k]
    return [{**secs[p], "child": child, "score": round(score, 4)} for p, (score, child) in top]


async def search_guide(req):
    qs = req.input.get("queries") or {}
    if isinstance(qs, str):
        qs = {"q": qs}
    k = int(req.input.get("k", 3))
    hits = {key: search(str(q), k) for key, q in list(qs.items())[:40]}
    return {"status": "completed", "output": {"hits": hits, "sections": len(index()[0])},
            "evidence": {"queries": list(map(str, qs.values()))[:40], "data_summary": f"질문 {len(hits)}개", "ref_ids": []}}


app = create_agent_app(CARD, {"search_guide": search_guide})
