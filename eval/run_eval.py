"""청킹 x 임베딩 x 하이브리드 정량평가 (블로그 '토끼와 거북이 RAG' 방식을 인쇄 가이드 지식베이스에 적용).

실행: python run_eval.py  ->  results.json
"""
import json
import math
import os
import random
import re
import sys
import time
from pathlib import Path

import numpy as np
import torch
from sentence_transformers import SentenceTransformer

HERE = Path(__file__).resolve().parent
KB = (HERE / "kb" / "print_guide.md").read_text(encoding="utf-8")
QUESTIONS = json.loads((HERE / "questions.json").read_text(encoding="utf-8"))
BUDGET = 500
random.seed(0)
np.random.seed(0)

MODELS = {
    "ko-sroberta": ("jhgan/ko-sroberta-multitask", "", ""),
    "multilingual-e5-small": ("intfloat/multilingual-e5-small", "query: ", "passage: "),
    "bge-m3": ("BAAI/bge-m3", "", ""),
    "KURE-v1": ("nlpai-lab/KURE-v1", "", ""),
}


# ---------- 지식베이스 파싱 ----------
def parse_sections(md):
    secs, doc, cur = [], "", None
    for line in md.splitlines():
        if line.startswith("# "):
            doc = line[2:].strip()
        elif line.startswith("## "):
            cur = {"doc": doc, "title": line[3:].strip(), "body": []}
            secs.append(cur)
        elif cur is not None and line.strip():
            cur["body"].append(line.strip())
    for s in secs:
        s["text"] = s["title"] + "\n" + "\n".join(s["body"])
    return secs


SECS = parse_sections(KB)
FULL = "\n\n".join(s["text"] for s in SECS)
norm = lambda t: re.sub(r"\s+", "", t)

# 정답 문구가 지식베이스에 정확히 한 번 나오는지 검증
for q, a in QUESTIONS:
    c = norm(FULL).count(norm(a))
    assert c == 1, f"정답 문구 {c}회 등장: {a!r}"


# ---------- 청킹 ----------
def fixed(text, size=150, overlap=25):
    out, step = [], size - overlap
    for i in range(0, max(len(text) - overlap, 1), step):
        out.append(text[i:i + size])
    return out


def sentences(text):
    parts = re.split(r"(?<=[.?!다])\s+", text.replace("\n", " "))
    return [p.strip() for p in parts if p.strip()]


def recursive(text, limit=300):
    chunks = []
    for para in text.split("\n\n"):
        buf = ""
        for sent in sentences(para):
            if buf and len(buf) + len(sent) + 1 > limit:
                chunks.append(buf)
                buf = sent
            else:
                buf = (buf + " " + sent).strip()
        if buf:
            chunks.append(buf)
    return chunks


def build_chunkings():
    """각 전략: [(검색 대상 텍스트, 돌려줄 텍스트)]"""
    out = {}
    out["고정 150자"] = [(c, c) for c in fixed(FULL)]
    out["재귀 분할 300자"] = [(c, c) for c in recursive(FULL)]
    # 문장 윈도우: 문장 하나로 검색, 앞뒤 1문장 함께 반환
    sw = []
    for s in SECS:
        ss = sentences(s["text"])
        for i, x in enumerate(ss):
            sw.append((x, " ".join(ss[max(0, i - 1): i + 2])))
    out["문장 윈도우(±1)"] = sw
    # 구조 기반 parent-child: 절을 150자로 잘라 검색, 걸리면 절 전체 반환
    pc = []
    for s in SECS:
        for c in fixed(s["text"]):
            pc.append((c, s["text"]))
    out["구조 parent-child"] = pc
    return out


CHUNKINGS = build_chunkings()


# ---------- BM25 ----------
_kiwi = None


def tok_2gram(t):
    t = re.sub(r"\s+", "", t)
    return [t[i:i + 2] for i in range(len(t) - 1)] or [t]


def tok_space(t):
    return re.findall(r"\S+", t)


def tok_kiwi(t):
    global _kiwi
    if _kiwi is None:
        from kiwipiepy import Kiwi
        _kiwi = Kiwi()
    return [m.form for m in _kiwi.tokenize(t) if m.tag[0] in "NVMS" or m.tag.startswith("XR")]


TOKENIZERS = {"2-gram": tok_2gram, "형태소": tok_kiwi, "어절": tok_space}


class BM25:
    def __init__(self, docs, tok, k1=1.5, b=0.75):
        self.tok, self.k1, self.b = tok, k1, b
        self.docs = [tok(d) for d in docs]
        self.avg = sum(len(d) for d in self.docs) / len(self.docs)
        df = {}
        for d in self.docs:
            for w in set(d):
                df[w] = df.get(w, 0) + 1
        n = len(self.docs)
        self.idf = {w: math.log(1 + (n - f + 0.5) / (f + 0.5)) for w, f in df.items()}
        self.tf = []
        for d in self.docs:
            m = {}
            for w in d:
                m[w] = m.get(w, 0) + 1
            self.tf.append((m, len(d)))

    def scores(self, q):
        qs = self.tok(q)
        out = np.zeros(len(self.docs))
        for i, (m, ln) in enumerate(self.tf):
            s = 0.0
            for w in qs:
                f = m.get(w)
                if f:
                    s += self.idf[w] * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * ln / self.avg))
            out[i] = s
        return out


def z(x):
    sd = x.std()
    return (x - x.mean()) / sd if sd > 1e-9 else np.zeros_like(x)


# ---------- 평가 ----------
def evaluate(order, returned, qi):
    """order: 점수 순 child 인덱스. returned: child -> 반환 텍스트."""
    ans = norm(QUESTIONS[qi][1])
    seen, units = set(), []
    for ci in order:
        r = returned[ci]
        if r in seen:
            continue
        seen.add(r)
        units.append(r)
        if len(units) >= 10:
            break
    hit1 = ans in norm(units[0])
    rank = next((i + 1 for i, u in enumerate(units) if ans in norm(u)), None)
    # 예산: 위에서부터 BUDGET자까지만 읽음
    acc, budget_hit = 0, False
    for u in units:
        take = u[: BUDGET - acc]
        if ans in norm(take):
            budget_hit = True
            break
        acc += len(take)
        if acc >= BUDGET:
            break
    return {"hit1": hit1, "mrr": 1 / rank if rank else 0.0, "budget": budget_hit, "hit3": bool(rank and rank <= 3)}


def mean(rows, k):
    return float(np.mean([r[k] for r in rows]))


def boot_ci(vals, n=2000):
    vals = np.array(vals, dtype=float)
    m = [vals[np.random.randint(0, len(vals), len(vals))].mean() for _ in range(n)]
    return [float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5))]


def disk_mb(path):
    return sum(f.stat().st_size for f in Path(path).rglob("*") if f.is_file()) / 1e6


def lexical_split():
    """질문의 2-gram 중 정답 문구에 들어 있는 비율. 낮은 쪽 절반 = 바꿔 쓴 질문."""
    cov = []
    for q, a in QUESTIONS:
        qb, ab = set(tok_2gram(q)), set(tok_2gram(a))
        cov.append(len(qb & ab) / max(len(qb), 1))
    order = np.argsort(cov)
    return cov, set(int(i) for i in order[: len(order) // 2])


def main():
    cov, low_set = lexical_split()
    dev_idx = [i for i in range(len(QUESTIONS)) if i % 2 == 0]
    val_idx = [i for i in range(len(QUESTIONS)) if i % 2 == 1]
    queries = [q for q, _ in QUESTIONS]
    res = {"n_questions": len(QUESTIONS), "n_dev": len(dev_idx), "n_val": len(val_idx), "kb_chars": len(FULL),
           "kb_sections": len(SECS), "budget": BUDGET, "chunking_info": {}, "models": {}, "dense": {}, "hybrid": {}, "tokenizer": {},
           "fusion": {}, "samples": {}, "lexical": {}, "cov_median": float(np.median(cov)), "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"}
    for name, ch in CHUNKINGS.items():
        ret = len({r for _, r in ch})
        res["chunking_info"][name] = {"search_units": len(ch), "returned_units": ret,
                                      "avg_returned_chars": float(np.mean([len(r) for r in {r for _, r in ch}]))}
    bm25 = {}
    for cn, ch in CHUNKINGS.items():
        for tn, tk in TOKENIZERS.items():
            bm25[(cn, tn)] = BM25([c for c, _ in ch], tk)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    for mname, (repo, qp, pp) in MODELS.items():
        t0 = time.time()
        model = SentenceTransformer(repo, device=dev)
        model.max_seq_length = 512
        nparams = sum(p.numel() for p in model.parameters()) / 1e6
        from huggingface_hub import snapshot_download
        size = disk_mb(snapshot_download(repo, local_files_only=True, allow_patterns=["*.safetensors"]))
        qv = model.encode([qp + q for q in queries], normalize_embeddings=True, batch_size=16)
        t_enc = {}
        dense_scores = {}
        for cn, ch in CHUNKINGS.items():
            t1 = time.time()
            cv = model.encode([pp + c for c, _ in ch], normalize_embeddings=True, batch_size=16)
            t_enc[cn] = time.time() - t1
            dense_scores[cn] = qv @ cv.T
        res["models"][mname] = {"repo": repo, "params_M": round(nparams, 1), "safetensors_MB": round(size, 0),
                                "dim": int(qv.shape[1]), "load_s": round(time.time() - t0, 1)}
        res["dense"][mname] = {}
        for cn, ch in CHUNKINGS.items():
            returned = [r for _, r in ch]
            rows = [evaluate(np.argsort(-dense_scores[cn][qi]), returned, qi) for qi in range(len(QUESTIONS))]
            res["dense"][mname][cn] = {"hit1": mean(rows, "hit1"), "hit1_ci": boot_ci([r["hit1"] for r in rows]),
                                       "hit3": mean(rows, "hit3"), "mrr": mean(rows, "mrr"), "budget": mean(rows, "budget"),
                                       "budget_ci": boot_ci([r["budget"] for r in rows])}
        # 하이브리드: 구조 parent-child 와 재귀 분할 두 전략 x 토크나이저 3 x 가중치
        res["hybrid"][mname] = {}
        for cn in ["재귀 분할 300자", "구조 parent-child"]:
            ch = CHUNKINGS[cn]
            returned = [r for _, r in ch]
            res["hybrid"][mname][cn] = {}
            for tn in TOKENIZERS:
                bm = bm25[(cn, tn)]
                bscore = np.array([bm.scores(q) for q in queries])
                curve, lex = {}, {}
                for w in [round(x * 0.1, 1) for x in range(0, 11)]:
                    rows = []
                    for qi in range(len(QUESTIONS)):
                        s = w * z(dense_scores[cn][qi]) + (1 - w) * z(bscore[qi])
                        rows.append(evaluate(np.argsort(-s), returned, qi))
                    if tn == "2-gram" and w in (0.0, 0.2, 0.5, 0.8, 1.0):
                        lo = [rows[i] for i in range(len(rows)) if i in low_set]
                        hi = [rows[i] for i in range(len(rows)) if i not in low_set]
                        lex[str(w)] = {"low": {k: mean(lo, k) for k in ("mrr", "hit1")},
                                       "high": {k: mean(hi, k) for k in ("mrr", "hit1")}}
                    curve[str(w)] = {
                        "dev": {k: mean([rows[i] for i in dev_idx], k) for k in ("mrr", "hit1", "budget")},
                        "val": {k: mean([rows[i] for i in val_idx], k) for k in ("mrr", "hit1", "budget")},
                        "all": {k: mean(rows, k) for k in ("mrr", "hit1", "budget")},
                        "val_hit1_raw": [int(rows[i]["hit1"]) for i in val_idx],
                    }
                res["hybrid"][mname][cn][tn] = curve
                if tn == "2-gram":
                    res["lexical"].setdefault(mname, {})[cn] = lex
        # 샘플 정성 비교: 청킹마다 1위 결과가 갈리는 질문을 고른다 (multilingual-e5-small 기준)
        if mname == "multilingual-e5-small":
            for qi in range(len(QUESTIONS)):
                tops = {}
                for cn, ch in CHUNKINGS.items():
                    top = int(np.argmax(dense_scores[cn][qi]))
                    tops[cn] = {"text": ch[top][1], "hit": norm(QUESTIONS[qi][1]) in norm(ch[top][1])}
                hits = [v["hit"] for v in tops.values()]
                if any(hits) and not all(hits) and len(res["samples"]) < 5:
                    res["samples"][queries[qi]] = {"answer": QUESTIONS[qi][1], "by_chunking": tops}
        del model
        torch.cuda.empty_cache()
        print("done", mname, flush=True)
    # BM25 단독 (토크나이저 비교) - 가중치 0.0
    for cn in ["재귀 분할 300자", "구조 parent-child"]:
        res["tokenizer"][cn] = {}
        for tn in TOKENIZERS:
            c = res["hybrid"]["bge-m3"][cn][tn]["0.0"]["all"]
            res["tokenizer"][cn][tn] = c
    (HERE / "results.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print("saved")


if __name__ == "__main__":
    main()

