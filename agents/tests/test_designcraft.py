"""designcraft 에이전트: 쪽 매핑, 입력 검증, MCP 가두기.

designcraft-cli가 깔려 있을 때만 도는 시험은 따로 표시해 둔다(없으면 건너뛴다).
깔려 있지 않아도 도는 시험이 더 많다 — 쪽 매핑과 입력 검증은 MCP 없이 확인할 수 있다.
"""
import asyncio
from datetime import timedelta
from pathlib import Path

import pytest

from pg_agents.contracts import AgentRequest, RequestMeta, now_utc
from pg_agents.designcraft import agent as dc
from pg_agents.designcraft.mcp_client import Mcp, McpError, cli_path

HAVE_CLI = cli_path() is not None
needs_cli = pytest.mark.skipif(not HAVE_CLI, reason="designcraft-cli가 없다")


def meta(ctx="ctx_dc_test"):
    return RequestMeta(context_id=ctx, token="mock:orchestrator", deadline=now_utc() + timedelta(minutes=5))


# ---------- 쪽 매핑 ----------
def test_story_pages_follows_nested_items():
    """프레임은 그룹 안에 중첩된다. 자식 bounds는 부모 기준이라 그대로 쓰면 엉뚱한 쪽이 나온다 —
    쪽은 최상위 조상에서 한 번 정하고 아래로 물려줘야 한다."""
    doc = {
        "spreads": [{
            "index": 0,
            "pages": [{"index": 0, "bounds": [0, 0, 300, 500]}, {"index": 1, "bounds": [300, 0, 600, 500]}],
            "items": [
                {"id": 1, "bounds": [10, 10, 100, 100], "children": [{"id": 2, "bounds": [-900, -900, -800, -800]}]},
                {"id": 3, "bounds": [310, 10, 500, 100]},
            ],
        }],
        "stories": [{"id": 10, "frames": [2]}, {"id": 11, "frames": [3]}, {"id": 12, "frames": [99]}],
    }
    pages = dc._story_pages(doc)
    assert pages[10] == {1}, "그룹 자식은 부모의 쪽을 물려받는다(자기 bounds로 재지 않는다)"
    assert pages[11] == {2}, "오른쪽 쪽에 놓인 프레임은 2쪽"
    assert pages[12] == set(), "문서에 없는 프레임만 가진 스토리는 쪽이 없다"


def test_story_pages_handles_threaded_story_across_pages():
    doc = {
        "spreads": [{"index": 0, "pages": [{"index": 0, "bounds": [0, 0, 300, 500]}, {"index": 1, "bounds": [300, 0, 600, 500]}],
                     "items": [{"id": 1, "bounds": [10, 10, 100, 100]}, {"id": 2, "bounds": [310, 10, 400, 100]}]}],
        "stories": [{"id": 7, "frames": [1, 2]}],
    }
    assert dc._story_pages(doc)[7] == {1, 2}


def test_story_pages_survives_missing_bounds_and_pages():
    """엔진이 bounds를 안 줄 수도 있다. 그래도 죽지 않고 첫 쪽으로 둔다."""
    doc = {"spreads": [{"index": 0, "pages": [{"index": 0, "bounds": [0, 0, 300, 500]}], "items": [{"id": 1}]},
                       {"index": 1, "pages": [], "items": [{"id": 2, "bounds": [0, 0, 1, 1]}]}],
           "stories": [{"id": 5, "frames": [1, 2]}]}
    assert dc._story_pages(doc)[5] == {1}  # 쪽이 없는 스프레드의 프레임은 빠진다


# ---------- 입력 검증 ----------
@pytest.mark.parametrize("name", ["a.docx", "noext", ""])
def test_rejects_unknown_formats(name):
    with pytest.raises(ValueError, match="열 수 없는 형식"):
        dc._src_path("a" * 64, name)


@pytest.mark.parametrize(("name", "why"), [("a.pdf", "글자를 집을 수 없"), ("a.indd", "IDML"), ("a.indt", "IDML")])
def test_refused_formats_say_what_to_do_instead(name, why):
    """'열 수 없는 형식'이라고만 하면 IDML로 바꾸면 된다는 것을 모른다. 이유와 다음 할 일을 같이 말한다."""
    with pytest.raises(ValueError, match=why):
        dc._src_path("a" * 64, name)


def test_missing_source_says_so():
    with pytest.raises(FileNotFoundError):
        dc._src_path("f" * 64, "gone.idml")


def test_apply_fixes_rejects_empty_list():
    r = asyncio.run(dc.apply_fixes(AgentRequest(meta=meta(), skill="apply_fixes",
                                                input={"src_ref": "a" * 64, "filename": "a.idml", "fixes": []})))
    assert r["status"] == "rejected" and r["outcome"] == "INVALID_INPUT"


def test_only_formats_we_can_hand_back_are_accepted():
    """받는 것은 **같은 형식으로 돌려줄 수 있는 것**뿐이다. INDD는 엔진이 읽을 수는 있지만
    INDD로 못 돌려주므로 받지 않는다 — 반쪽만 되는 것을 되는 것처럼 두지 않는다."""
    assert set(dc.OPENABLE) == {".idml", ".designcraft"}
    assert set(dc.REFUSED) == {".indd", ".indt", ".pdf"}
    assert not set(dc.OPENABLE) & set(dc.REFUSED)


def test_card_grades():
    g = {s.id: s.grade for s in dc.CARD.skills}
    assert g == {"mcp_status": "read", "inspect_source": "read", "apply_fixes": "A"}
    apply = next(s for s in dc.CARD.skills if s.id == "apply_fixes")
    assert apply.allowed_requesters == ["orchestrator"], "파일을 쓰는 skill은 오케스트레이터만 부를 수 있다"


# ---------- MCP 가두기 ----------
def test_mcp_refuses_to_start_unconfined(tmp_path):
    """가두지 않은 MCP는 띄우지 않는다. 플래그가 없으면 디스크 전체가 열린다."""
    with pytest.raises(McpError, match="읽기·쓰기 폴더"):
        Mcp(read_roots=[tmp_path], write_roots=[])
    with pytest.raises(McpError, match="읽기·쓰기 폴더"):
        Mcp(read_roots=[], write_roots=[tmp_path])


@needs_cli
def test_probe_reports_tools():
    from pg_agents.designcraft.mcp_client import probe
    p = probe()
    assert p["available"] is True, p.get("reason")
    assert "execute" in p["tools"] and "inspect_document" in p["tools"]


@needs_cli
def test_mcp_write_outside_the_root_is_refused(tmp_path):
    """작업 폴더 밖으로는 못 쓴다. 이게 뚫리면 에이전트가 이 PC의 아무 파일이나 덮어쓴다."""
    work, outside = tmp_path / "work", tmp_path / "outside"
    work.mkdir(), outside.mkdir()
    with Mcp(read_roots=[work], write_roots=[work]) as m:
        m.tool("new_document", {"preset": "A4"})
        m.ex("file.exportPdf", path=str(work / "ok.pdf"))          # 안쪽은 된다
        assert (work / "ok.pdf").exists()
        with pytest.raises(McpError):                               # 바깥은 거절
            m.ex("file.exportPdf", path=str(outside / "no.pdf"))
    assert not (outside / "no.pdf").exists()


@needs_cli
def test_apply_fixes_engine_refinds_after_each_edit(tmp_path):
    """한글은 글자당 3바이트다. 앞을 고치면 뒤 오프셋이 밀리는데, 한 건마다 다시 찾으므로 따라와야 한다."""
    src = tmp_path / "t.designcraft"
    with Mcp(read_roots=[tmp_path], write_roots=[tmp_path]) as m:
        m.tool("new_document", {"preset": "A4", "margins": 36})
        r = m.ex("frame.create", rect=[36, 36, 520, 200], content="text", text="alpha and beta and gamma")
        m.tool("set_story_text", {"story": r["story"], "text": "alpha and beta and gamma"})
        m.ex("file.saveAs", path=str(src))
    fixes = [{"key": "1", "original": "alpha", "suggestion": "가나다라마"},   # 5자 → 15바이트 (+10)
             {"key": "2", "original": "gamma", "suggestion": "감마"},         # 뒤쪽 — 밀린 위치를 찾아야 한다
             {"key": "3", "original": "없는말", "suggestion": "x"}]
    out = tmp_path / "out"
    out.mkdir()
    res = dc._apply_blocking(src, ".designcraft", out, fixes)
    assert [a["key"] for a in res["applied"]] == ["1", "2"]
    assert [f["key"] for f in res["failed"]] == ["3"]
    assert "찾지 못했" in res["failed"][0]["reason"]
    assert [s["page"] for s in res["shots"]] == [1]
    for s in res["shots"]:
        assert (out / s["before"]).exists() and (out / s["after"]).exists()
    assert Path(res["pdf_path"]).exists()


@needs_cli
def test_apply_fixes_refuses_ambiguous_and_wrong_page(tmp_path):
    """같은 문구가 여러 군데면 찍지 않고 실패로 남긴다 — 추측해서 고치면 조용히 틀린다."""
    src = tmp_path / "t.designcraft"
    with Mcp(read_roots=[tmp_path], write_roots=[tmp_path]) as m:
        m.tool("new_document", {"preset": "A4", "margins": 36})
        r = m.ex("frame.create", rect=[36, 36, 520, 200], content="text", text="x")
        m.tool("set_story_text", {"story": r["story"], "text": "같은말 그리고 같은말"})
        m.ex("file.saveAs", path=str(src))
    out = tmp_path / "out"
    out.mkdir()
    res = dc._apply_blocking(src, ".designcraft", out, [
        {"key": "dup", "original": "같은말", "suggestion": "다른말"},
        {"key": "pg", "page": 9, "original": "그리고", "suggestion": "및"},
    ])
    assert res["applied"] == []
    why = {f["key"]: f["reason"] for f in res["failed"]}
    assert "2군데" in why["dup"]
    assert "9쪽에는 없습니다" in why["pg"]
    # 문서에 없는 9쪽을 그리려 들면 export_png가 오류를 내며 교정 전체가 날아간다 — 버려야 한다
    assert [s["page"] for s in res["shots"]] == [1]


@needs_cli
def test_shots_follow_the_pages_that_change(tmp_path):
    """전후 그림은 **바뀐 쪽**을 찍어야 한다. 늘 1쪽만 찍으면 여러 쪽짜리에서 정작 고친 자리를 못 본다."""
    src = tmp_path / "multi.designcraft"
    with Mcp(read_roots=[tmp_path], write_roots=[tmp_path]) as m:
        # facingPages를 끄면 스프레드 하나에 쪽 하나라 번호가 그대로 맞는다
        # (맞쪽이면 3쪽 문서의 스프레드가 2개다 — 0쪽 / 1·2쪽)
        m.tool("new_document", {"preset": "A4", "margins": 36, "pages": 3, "facingPages": False})
        for page, word in enumerate(("하나", "둘", "셋")):
            r = m.ex("frame.create", spread=page, rect=[36, 36, 520, 200], content="text", text="x")
            m.tool("set_story_text", {"story": r["story"], "text": f"{word}쪽 본문입니다"})
        m.ex("file.saveAs", path=str(src))
    out = tmp_path / "out"
    out.mkdir()
    # 3쪽에 있는 글만 고친다 → 3쪽 그림만 나와야 한다
    res = dc._apply_blocking(src, ".designcraft", out, [{"key": "a", "original": "셋쪽", "suggestion": "세번째쪽"}])
    assert [s["page"] for s in res["shots"]] == [3], res["shots"]
    assert res["shots_total"] == 1
    for s in res["shots"]:
        assert (out / s["before"]).exists() and (out / s["after"]).exists()


def test_src_path_finds_the_document_inside_an_uploaded_folder(tmp_path, monkeypatch):
    """업로드는 파일 하나든 폴더째든 SRC/<토큰>/ 하나로 풀린다. 그 안의 상대 경로로 문서를 찾는다."""
    src = tmp_path / "src"
    monkeypatch.setattr(dc, "SRC", src)
    pkg = src / "tok123" / "내 잡지"
    (pkg / "Links").mkdir(parents=True)
    (pkg / "magazine.idml").write_bytes(b"x")
    (pkg / "Links" / "photo.jpg").write_bytes(b"x")
    p, ext = dc._src_path("tok123", "내 잡지/magazine.idml")
    assert p == (pkg / "magazine.idml").resolve() and ext == ".idml"
    # 읽기 루트는 묶음의 뿌리여야 Links/가 닿는다
    assert dc._pkg_root(p) == (src / "tok123").resolve()


def test_src_path_refuses_escaping_the_upload_folder(tmp_path, monkeypatch):
    """브라우저가 주는 상대 경로는 손댈 수 있다. 토큰 폴더 밖은 열지 않는다."""
    src = tmp_path / "src"
    monkeypatch.setattr(dc, "SRC", src)
    (src / "tok").mkdir(parents=True)
    (src / "secret.idml").write_bytes(b"x")
    with pytest.raises((ValueError, FileNotFoundError)):
        dc._src_path("tok", "../secret.idml")
