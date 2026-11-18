"""실제 원고 평가기(pg_agents.proofread.evaluate) 시험.

정답은 '원고'와 '사람이 고친 원고'의 차이에서 나온다. 차이를 오류로 옮기는 자리가 틀리면 재현율
숫자 전체가 틀리므로, 그 자리를 먼저 지킨다.
"""
from __future__ import annotations

import pytest

from pg_agents.proofread import detectors as det
from pg_agents.proofread import evaluate as ev


def test_a_fixed_copy_becomes_the_error_list():
    d = ev.label("a", "인쇄 파일은 몇일 전에 보낸다. 확인할수있다.", "인쇄 파일은 며칠 전에 보낸다. 확인할 수 있다.")
    assert d is not None
    # '할수있다' → '할 수 있다'는 띄어쓰기 두 곳이지만 붙어 있어 오류 하나다('수' 자리에 앞뒤 빈칸이 들어감)
    assert [(e.wrong, e.right) for e in d.errors] == [("몇일", "며칠"), ("수", " 수 ")]
    assert [d.text[e.start:e.end] for e in d.errors] == ["몇일", "수"]


def test_an_unchanged_copy_is_a_clean_manuscript():
    d = ev.label("clean", "멀쩡한 글입니다.", "멀쩡한 글입니다.")
    assert d is not None and d.errors == []


def test_a_rewritten_copy_is_not_a_proofread_and_is_left_out(tmp_path):
    assert ev.label("re", "오늘은 날씨가 맑다.", "내일 비가 많이 온다고 합니다.") is None
    (tmp_path / "re.txt").write_text("오늘은 날씨가 맑다.", encoding="utf-8")
    (tmp_path / "re.fixed.txt").write_text("내일 비가 많이 온다고 합니다.", encoding="utf-8")
    (tmp_path / "lonely.txt").write_text("짝 없는 원고", encoding="utf-8")
    docs, skipped = ev.load(tmp_path)
    assert docs == [] and len(skipped) == 2 and any("고쳐 쓰기" in s for s in skipped) and any("없음" in s for s in skipped)


def _fake(monkeypatch, found):
    monkeypatch.setitem(det.DETECTORS, "fake", lambda text: [dict(s) for s in found(text)])


def test_score_counts_hits_false_alarms_and_exact_fixes(monkeypatch):
    bad = ev.label("bad", "인쇄소에는 몇일 전에 보낸 파일의 컨텐츠를 다시 확인해 달라고 했다", "인쇄소에는 며칠 전에 보낸 파일의 콘텐츠를 다시 확인해 달라고 했다")
    assert bad is not None and len(bad.errors) == 2
    clean = ev.label("clean", "깨끗한 원고입니다", "깨끗한 원고입니다")

    def found(text):
        out = []
        for w, r in (("몇일", "며칠"), ("컨텐츠", "컨텐트"), ("원고", "원고지")):  # 둘째는 자리는 맞고 고친 내용이 틀림, 셋째는 헛경보
            k = text.find(w)
            if k >= 0:
                out.append({"original": w, "suggestion": r, "start": k, "end": k + len(w)})
        return out
    _fake(monkeypatch, found)
    m = ev.score([bad, clean], ["fake"])
    assert m["errors"] == 2 and m["recall"] == 1.0
    assert m["precision"] == pytest.approx(2 / 3)
    assert m["exact_fix"] == pytest.approx(1 / 2), "자리만 맞고 엉뚱하게 고친 제안은 '고친 내용까지 맞음'에서 뺀다"
    assert m["clean_false_alarms_per_1000"] == pytest.approx(1 / len("깨끗한 원고입니다") * 1000, abs=0.01)
    assert any("원고→원고지" in x for x in m["examples_false_alarm"])


def test_a_detector_that_breaks_stops_the_evaluation(monkeypatch):
    """넘어진 탐지기를 '못 찾음'으로 세면 재현율이 실제보다 낮게 적힌다. 그래서 멈춘다."""
    def boom(text):
        raise RuntimeError("429 한도")
    monkeypatch.setitem(det.DETECTORS, "fake", boom)
    with pytest.raises(SystemExit, match="멈춥니다"):
        ev.score([ev.label("a", "글", "글")], ["fake"])


def test_run_on_a_folder_with_the_real_rules(tmp_path, capsys):
    (tmp_path / "a.txt").write_text("인쇄 파일은 몇일 전에 보낸다.", encoding="utf-8")
    (tmp_path / "a.fixed.txt").write_text("인쇄 파일은 며칠 전에 보낸다.", encoding="utf-8")
    (tmp_path / "b.txt").write_text("이 글에는 고칠 곳이 없습니다.", encoding="utf-8")
    (tmp_path / "b.fixed.txt").write_text("이 글에는 고칠 곳이 없습니다.", encoding="utf-8")
    out = tmp_path / "r.json"
    assert ev.main(["run", str(tmp_path), "--out", str(out)]) == 0
    import json
    r = json.loads(out.read_text(encoding="utf-8"))
    rules = r["methods"]["규칙"]
    assert rules["docs"] == 2 and rules["clean_docs"] == 1 and rules["recall"] == 1.0 and rules["exact_fix"] == 1.0
    assert "LLM" not in "".join(r["methods"]), "--llm을 주지 않으면 돈 드는 LLM은 부르지 않는다"
