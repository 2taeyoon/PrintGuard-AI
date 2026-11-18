"""실제 원고로 교정 정확도를 잰다.

**왜 따로 있나.** 지금 적어 둔 재현율(99.2%)은 오류를 일부러 넣어 만든 합성 평가셋에서 잰 값이다
(`eval/proofread/eval_proofread.py`). 넣은 오류의 종류를 우리가 정했으니, 실제 원고에서 사람이 틀리는
방식과 다를 수 있다. 실제로 쓰는 사람에게 중요한 것은 두 가지다.

1. 진짜 원고에서 틀린 곳을 얼마나 잡느냐(재현율).
2. **멀쩡한 원고에 헛경보를 얼마나 내느냐**(1,000자당 헛경보). 헛경보가 많으면 사람은 목록을 안 읽는다.

**정답을 다는 법 — 고친 원고 하나면 된다.** 사람이 오류 위치를 표로 적는 것은 느리고 틀리기 쉽다.
그래서 원고를 평소처럼 고친 사본만 받는다.

    <이름>.txt         검수기에 들어가는 원고 그대로
    <이름>.fixed.txt   사람이 교정한 원고. 고칠 곳이 없으면 똑같이 둔다(→ 헛경보를 재는 '깨끗한 원고')

두 글의 차이가 곧 정답이다. 문체를 다시 쓴 사본(차이가 20%를 넘는 것)은 교정이 아니라 고쳐 쓰기라
평가에서 뺀다 — 넣으면 바꾼 문장 전체가 '오류'가 되어 재현율이 부당하게 낮아진다.

PDF에서 원고를 꺼내려면:

    python -m pg_agents.proofread.evaluate extract 원고.pdf 평가폴더/    # 쪽마다 <이름>-p01.txt …

재기:

    python -m pg_agents.proofread.evaluate run 평가폴더/ [--llm] [--out 결과.json]

LLM 교정은 `--llm`을 줄 때만 넣는다. 원고마다 API를 부르므로 돈이 든다 — 모르게 쓰지 않는다.
탐지기 하나가 넘어지면(분당 한도 등) **평가를 멈춘다.** 넘어진 것을 '못 찾음'으로 세면 재현율이
실제보다 낮게 적힌다(합성 평가셋에서 한 번 그렇게 잘못 잴 뻔했다).
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from . import detectors as det

MAX_REWRITE = 0.20   # 고친 원고가 이만큼 넘게 다르면 교정이 아니라 고쳐 쓰기로 보고 뺀다
MERGE_GAP = 2        # 이 글자 수 안에 붙은 차이는 한 오류로 본다('할수있다'→'할 수 있다'는 띄어쓰기 두 곳이지만 오류 하나)


@dataclass
class Err:
    start: int          # 원고에서의 자리 [start, end)
    end: int
    wrong: str
    right: str


@dataclass
class Doc:
    name: str
    text: str
    fixed: str
    errors: list[Err] = field(default_factory=list)
    ops: list[tuple[str, int, int, int, int]] = field(default_factory=list)


def label(name: str, text: str, fixed: str) -> Doc | None:
    """원고와 고친 원고의 차이를 오류 목록으로. 고쳐 쓴 원고면 None."""
    sm = SequenceMatcher(None, text, fixed, autojunk=False)
    if text and 1 - sm.ratio() > MAX_REWRITE:
        return None
    ops = sm.get_opcodes()
    spans: list[list[int]] = []
    for tag, i1, i2, j1, j2 in ops:
        if tag == "equal":
            continue
        if spans and i1 - spans[-1][1] <= MERGE_GAP:
            spans[-1][1], spans[-1][3] = i2, j2
        else:
            spans.append([i1, i2, j1, j2])
    errs = []
    for i1, i2, j1, j2 in spans:
        # 넣기만 한 차이(띄어쓰기 빠짐 등)는 원고에서 폭이 0이다. 앞뒤 한 글자씩을 그 오류의 자리로 본다
        a, b = (max(0, i1 - 1), min(len(text), i2 + 1)) if i1 == i2 else (i1, i2)
        errs.append(Err(a, b, text[i1:i2], fixed[j1:j2]))
    return Doc(name, text, fixed, errs, ops)


def _map(doc: Doc, p: int) -> int | None:
    """원고의 자리 p가 고친 원고의 어디인지. 바뀐 구간 한가운데면 정할 수 없다(None)."""
    for tag, i1, i2, j1, j2 in doc.ops:
        if tag == "equal" and i1 <= p <= i2:
            return j1 + (p - i1)
        if tag != "equal" and p == i1:
            return j1
        if tag != "equal" and p == i2:
            return j2
    return None


def _exact(doc: Doc, s: dict[str, Any]) -> bool:
    """제안대로 바꾸면 그 자리가 사람이 고친 글과 **똑같아지는지.** 찾기만 하고 엉뚱하게 고치면 자동 수정이 원고를 망친다."""
    lo, hi = s["start"], s["end"]
    for e in doc.errors:
        if not (s["end"] <= e.start or s["start"] >= e.end):
            lo, hi = min(lo, e.start), max(hi, e.end)
    a, b = _map(doc, lo), _map(doc, hi)
    if a is None or b is None:
        return False
    return doc.text[lo:s["start"]] + str(s.get("suggestion") or "") + doc.text[s["end"]:hi] == doc.fixed[a:b]


def detect_strict(text: str, methods: list[str]) -> list[dict[str, Any]]:
    found, bad = det.detect(text, methods)
    if bad:
        raise SystemExit(f"탐지기가 넘어져 평가를 멈춥니다(넘어진 것을 '못 찾음'으로 세지 않기 위해): {bad}")
    return found


def score(docs: list[Doc], methods: list[str], seed: int = 0) -> dict[str, Any]:
    per_doc = []
    examples_fp: list[str] = []
    examples_miss: list[str] = []
    for d in docs:
        sug = detect_strict(d.text, methods)
        hit = [any(not (s["end"] <= e.start or s["start"] >= e.end) for s in sug) for e in d.errors]
        good = [any(not (s["end"] <= e.start or s["start"] >= e.end) for e in d.errors) for s in sug]
        exact = [_exact(d, s) for s, g in zip(sug, good) if g]
        per_doc.append({"name": d.name, "chars": len(d.text), "errors": len(d.errors), "hit": sum(hit),
                        "sug": len(sug), "good": sum(good), "exact": sum(exact), "clean": not d.errors})
        examples_fp += [f"{d.name}: {s['original']}→{s['suggestion']}" for s, g in zip(sug, good) if not g][:3]
        examples_miss += [f"{d.name}: {e.wrong or '∅'}→{e.right or '∅'}" for e, h in zip(d.errors, hit) if not h][:3]

    def ratio(rows, num, den):
        n, m = sum(r[num] for r in rows), sum(r[den] for r in rows)
        return n / m if m else None

    def ci(num, den, rows, n=2000):
        """원고 단위로 다시 뽑아 95% 구간. 원고가 적으면 구간이 넓다 — 그걸 그대로 보여 준다."""
        rnd = random.Random(seed)
        vals = []
        for _ in range(n):
            pick = [rnd.choice(rows) for _ in rows]
            v = ratio(pick, num, den)
            if v is not None:
                vals.append(v)
        if not vals:
            return None
        vals.sort()
        return [vals[int(0.025 * len(vals))], vals[min(len(vals) - 1, int(0.975 * len(vals)))]]

    clean = [r for r in per_doc if r["clean"]]
    clean_chars = sum(r["chars"] for r in clean)
    fp_all = sum(r["sug"] - r["good"] for r in per_doc)
    chars = sum(r["chars"] for r in per_doc)
    return {
        "methods": methods,
        "docs": len(docs), "clean_docs": len(clean), "chars": chars, "errors": sum(r["errors"] for r in per_doc),
        "recall": ratio(per_doc, "hit", "errors"), "recall_ci": ci("hit", "errors", per_doc),
        "precision": ratio(per_doc, "good", "sug"), "precision_ci": ci("good", "sug", per_doc),
        # 찾은 것 가운데, 제안대로 바꾸면 사람이 고친 글과 같아지는 비율 — 자동 수정이 믿을 만한지
        "exact_fix": ratio(per_doc, "exact", "good"),
        "false_alarms_per_1000": round(fp_all / chars * 1000, 2) if chars else None,
        "clean_false_alarms_per_1000": round(sum(r["sug"] for r in clean) / clean_chars * 1000, 2) if clean_chars else None,
        "examples_false_alarm": examples_fp[:10], "examples_missed": examples_miss[:10],
        "per_doc": per_doc,
    }


def load(folder: Path) -> tuple[list[Doc], list[str]]:
    docs, skipped = [], []
    for t in sorted(folder.glob("*.txt")):
        if t.name.endswith(".fixed.txt"):
            continue
        f = t.with_name(t.stem + ".fixed.txt")
        if not f.exists():
            skipped.append(f"{t.name}: 고친 원고({f.name})가 없음")
            continue
        d = label(t.stem, t.read_text(encoding="utf-8-sig"), f.read_text(encoding="utf-8-sig"))
        if d is None:
            skipped.append(f"{t.name}: 고친 원고가 {int(MAX_REWRITE * 100)}% 넘게 달라 교정이 아니라 고쳐 쓰기로 보고 뺌")
            continue
        docs.append(d)
    return docs, skipped


def extract(pdf: Path, out: Path) -> list[Path]:
    """PDF 쪽마다 글을 꺼내 <이름>-pNN.txt와 같은 내용의 .fixed.txt로 둔다. 사람은 .fixed.txt만 고치면 된다.
    교정 에이전트가 쓰는 것과 같은 방식(pymupdf `get_text("text")`)으로 꺼낸다 — 다르게 꺼내면 다른 글을 재게 된다."""
    import pymupdf
    out.mkdir(parents=True, exist_ok=True)
    made = []
    with pymupdf.open(pdf) as doc:
        for i, page in enumerate(doc, start=1):
            text = page.get_text("text")
            if not text.strip():
                continue
            p = out / f"{pdf.stem}-p{i:02d}.txt"
            if p.exists():
                raise SystemExit(f"이미 있습니다(덮어쓰지 않습니다): {p}")
            p.write_text(text, encoding="utf-8")
            p.with_name(p.stem + ".fixed.txt").write_text(text, encoding="utf-8")
            made.append(p)
    return made


COMBOS = {"규칙": ["rules"], "규칙+Kiwi 오타": ["rules", "kiwi_typo"]}


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    ap = argparse.ArgumentParser(prog="python -m pg_agents.proofread.evaluate", description="실제 원고로 교정 정확도 재기")
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("extract", help="PDF의 쪽 글을 평가용 원고로 꺼낸다")
    e.add_argument("pdf", type=Path)
    e.add_argument("out", type=Path)
    r = sub.add_parser("run", help="평가 폴더로 잰다")
    r.add_argument("folder", type=Path)
    r.add_argument("--llm", action="store_true", help="LLM 교정도 잰다(원고마다 API 호출 — 비용이 든다)")
    r.add_argument("--out", type=Path, help="결과 JSON을 쓸 곳")
    a = ap.parse_args(argv)

    if a.cmd == "extract":
        made = extract(a.pdf, a.out)
        print(f"{len(made)}쪽을 꺼냈습니다 → {a.out}. 각 쪽의 .fixed.txt를 교정해 주세요(고칠 곳이 없으면 그대로).")
        return 0

    docs, skipped = load(a.folder)
    for s in skipped:
        print("뺌:", s)
    if not docs:
        print("잴 원고가 없습니다. <이름>.txt와 <이름>.fixed.txt 짝을 넣어 주세요.")
        return 1
    combos = dict(COMBOS)
    if a.llm:
        from ..config import load_env_files
        from .. import llm as llm_mod
        load_env_files()
        if not llm_mod.provider():
            print("--llm을 줬지만 LLM 열쇠가 없습니다.")
            return 1
        combos["규칙+Kiwi 오타+LLM"] = ["rules", "kiwi_typo", "llm"]
    res = {"kind": "실제 원고", "skipped": skipped, "methods": {}}
    for name, ms in combos.items():
        m = res["methods"][name] = score(docs, ms)
        pct = lambda v: "—" if v is None else f"{v * 100:.1f}%"  # noqa: E731
        print(f"{name:18s} 재현율 {pct(m['recall'])} 정밀도 {pct(m['precision'])} 고친 내용까지 맞음 {pct(m['exact_fix'])} "
              f"헛경보 {m['false_alarms_per_1000']}/1000자 (깨끗한 원고 {m['clean_false_alarms_per_1000']})")
    head = next(iter(res["methods"].values()))
    print(f"원고 {head['docs']}개(깨끗한 원고 {head['clean_docs']}개), {head['chars']}자, 오류 {head['errors']}개")
    if a.out:
        a.out.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
        print("결과:", a.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
