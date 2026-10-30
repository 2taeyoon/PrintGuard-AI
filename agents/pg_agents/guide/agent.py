"""guide 에이전트(:8704) — 인쇄 가이드 하이브리드 검색(RAG의 R).

정량평가(eval/run_eval.py, 아티팩트 1~7절)에서 고른 설정을 그대로 쓴다:
구조 기반 parent-child(## 절을 150자/겹침 25자로 잘라 검색, 걸리면 절 전체 반환) + multilingual-e5-small(query:/passage:)
+ 2-gram BM25, 각각 z-점수로 정규화해 dense 0.5 : BM25 0.5. 답을 지어내지 않고 원문 절과 걸린 조각을 돌려준다.
"""
from __future__ import annotations

import math
import os
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


# ---- 임베딩: 브라우저(바로 검사)와 같은 모델·같은 양자화를 쓴다 ----
# 예전에는 sentence-transformers(torch, fp32)로 돌렸는데, 그러면 브라우저 쪽 int8 결과와 미세하게 달라지고
# 메모리도 2GB대로 커져 작은 서버에 올릴 수 없었다. 같은 int8 ONNX를 onnxruntime로 직접 돌려 둘을 맞춘다.
MODEL_REPO = "Xenova/multilingual-e5-small"
LOCAL_MODEL = ROOT / "frontend" / "public" / "models" / "Xenova" / "multilingual-e5-small"


def model_files() -> tuple[str, str]:
    """(tokenizer.json, model_quantized.onnx) 경로. 앱이 쓰는 로컬 파일을 먼저 보고, 없으면 Hugging Face에서 받는다."""
    local_tok, local_onnx = LOCAL_MODEL / "tokenizer.json", LOCAL_MODEL / "onnx" / "model_quantized.onnx"
    if local_tok.exists() and local_onnx.exists():
        return str(local_tok), str(local_onnx)
    from huggingface_hub import hf_hub_download  # 서버 배포용: 캐시에 한 번만 받는다
    return (hf_hub_download(MODEL_REPO, "tokenizer.json"), hf_hub_download(MODEL_REPO, "onnx/model_quantized.onnx"))


@lru_cache(maxsize=1)
def encoder():
    import onnxruntime as ort
    from tokenizers import Tokenizer
    tok_path, onnx_path = model_files()
    tok = Tokenizer.from_file(tok_path)
    tok.enable_truncation(max_length=512)
    tok.enable_padding(pad_id=1, pad_token="<pad>")  # XLM-R 계열: <pad>=1
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = int(os.environ.get("PG_ONNX_THREADS", "2"))
    sess = ort.InferenceSession(onnx_path, opts, providers=["CPUExecutionProvider"])
    return tok, sess


def embed(texts: list[str], batch: int = 16) -> np.ndarray:
    """e5 규칙대로 'query: '/'passage: '를 붙여 넣은 문장을 벡터로. 평균 풀링 뒤 L2 정규화(브라우저 쪽과 같은 계산)."""
    tok, sess = encoder()
    out = []
    for i in range(0, len(texts), batch):
        enc = tok.encode_batch(texts[i:i + batch])
        ids = np.array([e.ids for e in enc], dtype=np.int64)
        mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
        h = sess.run(["last_hidden_state"], {"input_ids": ids, "attention_mask": mask,
                                             "token_type_ids": np.zeros_like(ids)})[0]
        m = mask[..., None].astype(np.float32)
        v = (h * m).sum(1) / np.clip(m.sum(1), 1e-9, None)
        out.append(v / np.clip(np.linalg.norm(v, axis=1, keepdims=True), 1e-9, None))
    return np.concatenate(out) if out else np.zeros((0, 384), dtype=np.float32)


@lru_cache(maxsize=1)
def index():
    secs = parse(KB.read_text(encoding="utf-8"))
    children = [(c, i) for i, s in enumerate(secs) for c in fixed(s["text"])]
    vec = embed(["passage: " + c for c, _ in children])
    return secs, children, vec, BM25([c for c, _ in children])


def search(q: str, k: int = 3) -> list[dict]:
    secs, children, vec, bm = index()
    qv = embed(["query: " + q])[0]
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
