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
    assert g == {"mcp_status": "read", "inspect_source": "read", "list_commands": "read", "compose": "read",
                 "apply_fixes": "A", "edit_document": "A", "create_document": "A"}
    for sid in ("apply_fixes", "create_document"):
        s = next(x for x in dc.CARD.skills if x.id == sid)
        assert s.allowed_requesters == ["orchestrator"], "파일을 쓰는 skill은 오케스트레이터만 부를 수 있다"


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


# ---------- 고치기 전에 묻는다 ----------
def _dummy_src(tmp_path, monkeypatch):
    src = tmp_path / "src"
    monkeypatch.setattr(dc, "SRC", src)
    (src / "tok").mkdir(parents=True)
    (src / "tok" / "a.idml").write_bytes(b"x")
    return src


def test_asks_before_touching_the_original(tmp_path, monkeypatch):
    """원본을 고치는 것은 되돌릴 수 없다. 검수를 맡겼다고 원본을 고쳐도 된다는 뜻은 아니므로,
    confirm 없이 오면 **파일을 열기 전에** 묻는다(MCP를 띄우지 않는다)."""
    _dummy_src(tmp_path, monkeypatch)
    req = AgentRequest(meta=meta(), skill="apply_fixes",
                       input={"src_ref": "tok", "filename": "a.idml",
                              "fixes": [{"original": "읍니다", "suggestion": "습니다"}]})
    r = asyncio.run(dc.apply_fixes(req))
    assert r["status"] == "input-required"
    assert r["question"]["field"] == "apply_fixes"
    assert [o["value"] for o in r["question"]["options"]] == ["yes", "no"]
    assert "a.idml" in r["question"]["text"]


def test_no_means_the_original_is_left_alone(tmp_path, monkeypatch):
    """'검수만 하기'를 고르면 아무것도 쓰지 않고 끝난다. 다시 묻지 않는다 — 그러면 답할 길이 없다."""
    _dummy_src(tmp_path, monkeypatch)
    req = AgentRequest(meta=meta(), skill="apply_fixes",
                       input={"src_ref": "tok", "filename": "a.idml", "confirm": "no",
                              "fixes": [{"original": "읍니다", "suggestion": "습니다"}]})
    r = asyncio.run(dc.apply_fixes(req))
    assert r["status"] == "completed" and r["output"]["skipped"] is True
    assert r["output"]["applied"] == [] and r["output"]["asked"] == 1


# ---------- 글꼴 ----------
# 글꼴은 편집 파일에 **담겨 오지 않는다** — 이름으로만 실려 온다. 올린 사람 PC에는 있고 검수하는
# PC에는 없는 일이 흔하다. 서버에 세상의 글꼴을 다 깔아 둘 수도 없다(라이선스 문제이기도 하다).
# 그래서 "없을 때 무엇이 멀쩡하고 무엇이 거짓인지"를 정확히 가리는 것이 여기서 지킬 일이다.
def test_font_summary_keeps_the_numbers_but_says_which_to_trust():
    """글꼴이 대체되면 줄이 밀린다 — 넘침 수치를 원본의 것이라고 말할 수 없다. 그래도 글은 멀쩡해서
    교정은 돈다. 둘을 따로 말해야 한다(수치를 지우는 것은 답이 아니다)."""
    fonts = [
        {"family": "윤명조 330", "style": "Regular", "status": "missing", "resolved": "Source Sans 3",
         "resolved_style": "Regular", "chars": 49, "source": None, "restricted_licence": False},
        {"family": "Arial", "style": "Regular", "status": "ok", "resolved": "Arial",
         "resolved_style": "Regular", "chars": 12, "source": "installed", "restricted_licence": False},
    ]
    r = dc._font_summary(fonts, [])
    assert r["missing_fonts"] == ["윤명조 330"]
    assert r["trust"] == {"text_readable": True, "layout_faithful": False}


def test_font_summary_flags_the_case_that_makes_the_check_a_lie():
    """글꼴은 있는데 그 글자가 없으면 네모로 찍힌다 — PDF에 글자가 남지 않아 교정이 아무것도 못
    읽는다. 이때 '고칠 것 없음'은 거짓이다. 대체(missing)와 섞어 두면 안 된다."""
    fonts = [{"family": "Source Serif 4", "style": "Regular", "status": "ok", "resolved": "Source Serif 4",
              "resolved_style": "Regular", "chars": 29, "source": "bundled", "restricted_licence": False}]
    issues = [{"kind": "missingGlyphs", "severity": "error",
               "message": "Missing glyphs in Source Serif 4 Regular: 한 글 제 목"}]
    r = dc._font_summary(fonts, issues)
    assert r["missing_fonts"] == []                       # 글꼴은 멀쩡하다
    assert r["glyph_blocked"] == ["Source Serif 4 Regular"]
    assert r["trust"]["text_readable"] is False           # 그런데 글을 읽을 수 없다
    assert r["trust"]["layout_faithful"] is True


def test_fonts_carried_in_the_uploaded_package_are_counted():
    """패키지의 `Document Fonts/`에서 실려 온 글꼴은 깔지 않고 그 자리에서만 읽는다. 그게 글꼴을
    받는 유일한 길이므로, 몇 개가 실렸는지 보여 줘야 한다 — 됐는지 안 됐는지 알 수가 없다."""
    fonts = [{"family": "Malgun Gothic", "style": "Regular", "status": "ok", "resolved": "Malgun Gothic",
              "resolved_style": "Regular", "chars": 49, "source": "document", "restricted_licence": False}]
    r = dc._font_summary(fonts, [])
    assert r["document_fonts"] == 1
    assert r["trust"] == {"text_readable": True, "layout_faithful": True}


def test_only_documents_we_made_get_their_font_replaced():
    """**남의 문서의 글꼴은 건드리지 않는다.** 우리가 보기 좋게 바꿔 버리면 되돌릴 수 없게 조판을
    바꿔 놓는 것이고, 올린 사람 PC에는 그 글꼴이 있다. `font.replace`는 우리가 만든 새 문서에서만
    쓴다 — 그 문서의 글꼴은 우리가 고른 것이라서."""
    import inspect
    for fn in (dc._inspect_blocking, dc._apply_blocking):
        assert "font.replace" not in inspect.getsource(fn), f"{fn.__name__}이 남의 글꼴을 바꾼다"
    assert "font.replace" in inspect.getsource(dc._create_blocking)


def _idml_with_a_font_this_pc_lacks(tmp_path: Path) -> Path:
    """이 PC에 없는 글꼴을 가리키는 IDML. 남이 보낸 파일을 흉내 낸다 — IDML 안의 글꼴 이름을
    바꿔치기하면 된다(글꼴은 이름으로만 실려 오므로 그것이 곧 '없는 글꼴'이다)."""
    import zipfile
    base = tmp_path / "base.idml"
    with Mcp(read_roots=[tmp_path], write_roots=[tmp_path]) as m:
        m.ex("file.new", intent="print", units="points", width=595, height=842,
             pages=1, facingPages=False, margins=36, primaryTextFrame=False)
        m.ex("frame.create", spread=0, rect=[60, 60, 500, 300], content="text",
             text="본문입니다. 깨끗히 인쇄되어야 합니다.")
        m.ex("font.replace", family="Source Serif 4", toFamily="Malgun Gothic")
        m.ex("file.exportIdml", path=str(base))
    out = tmp_path / "missing.idml"
    with zipfile.ZipFile(base) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for it in zin.infolist():
            b = zin.read(it.filename)
            if it.filename.endswith(".xml"):
                b = b.replace(b"Malgun Gothic", b"Yoon Myungjo 330").replace(b"MalgunGothic", b"YoonMyungjo330")
            zout.writestr(it, b)
    return out


@needs_cli
def test_a_missing_font_says_what_replaced_it_and_how_much_text(tmp_path):
    """"없는 글꼴 1개"만으로는 아무것도 할 수 없다. 무엇으로 대체됐고 몇 글자가 걸렸는지 알아야
    미리보기를 어디까지 믿을지 판단할 수 있다."""
    src = _idml_with_a_font_this_pc_lacks(tmp_path)
    out = tmp_path / "out"
    out.mkdir()
    r = dc._inspect_blocking(src, ".idml", out)
    assert r["missing_fonts"] == ["Yoon Myungjo 330"]
    (f,) = [x for x in r["fonts"] if x["status"] == "missing"]
    assert f["resolved"] and f["resolved"] != "Yoon Myungjo 330"   # 무엇으로 그렸는지
    assert f["chars"] > 0                                          # 몇 글자가 걸렸는지
    assert r["trust"]["layout_faithful"] is False
    assert r["trust"]["text_readable"] is True                     # 글은 멀쩡하다


@needs_cli
def test_fixing_text_leaves_the_original_font_name_in_the_file(tmp_path):
    """**이것이 글꼴 문제의 답이다.** 글꼴이 없어도 원본은 깨지지 않는다 — 우리는 글자만 바꾸고
    글꼴 이름은 손대지 않으므로, 내보낸 편집 파일에는 원래 이름이 그대로 남는다. 그 글꼴이 있는
    PC(올린 사람의 인디자인)에서 열면 원본대로 보인다. 대체한 글꼴 이름이 파일에 적히면 안 된다."""
    import re
    import zipfile
    src = _idml_with_a_font_this_pc_lacks(tmp_path)
    out = tmp_path / "out"
    out.mkdir()
    r = dc._apply_blocking(src, ".idml", out, [{"original": "깨끗히", "suggestion": "깨끗이"}])
    assert len(r["applied"]) == 1 and not r["failed"]       # 글 고치기는 글꼴과 무관하게 된다
    names: set[str] = set()
    with zipfile.ZipFile(out / r["source_out"]) as z:
        for n in z.namelist():
            if n.endswith(".xml"):
                names |= set(re.findall(r"Yoon Myungjo 330|Source Sans 3|Malgun Gothic",
                                        z.read(n).decode("utf-8", "replace")))
    assert names == {"Yoon Myungjo 330"}, f"글꼴 이름이 바뀌었다: {sorted(names)}"

# ---------- 엔진 명령(작업 만들기) ----------
# 이 화면은 "판형을 잡아 주는 곳"이 아니라 **인디자인이 하는 일 전부를 여는 곳**이다. 그래서
# 지킬 것이 둘이다. ① 한 단계는 전부 아니면 전무여야 한다(절반 들어간 문서는 되돌릴 자리가 흐려진다).
# ② 되돌리기는 한 단계만 가야 한다(어디까지 돌아갔는지 모르는 것이 더 무섭다).
def test_edit_refuses_a_shape_that_is_not_a_command_list():
    for bad in ([], "frame.create", [{"params": {}}], [{"command": "", "params": {}}],
                [{"command": "frame.create", "params": "rect=1"}]):
        req = AgentRequest(meta=meta(), skill="edit_document",
                           input={"src_ref": "tok", "filename": "a.idml", "commands": bad})
        r = asyncio.run(dc.edit_document(req))
        assert r["status"] == "rejected", bad
        assert r["outcome"] == "INVALID_INPUT", bad


def test_edit_refuses_more_commands_than_it_will_run():
    many = [{"command": "layout.pages.insert", "params": {"count": 1}}] * (dc.MAX_EDIT_CMDS + 1)
    req = AgentRequest(meta=meta(), skill="edit_document",
                       input={"src_ref": "tok", "filename": "a.idml", "commands": many})
    r = asyncio.run(dc.edit_document(req))
    assert r["status"] == "rejected" and r["outcome"] == "INVALID_INPUT"
    assert str(dc.MAX_EDIT_CMDS) in r["output"]["message"]


@needs_cli
def test_the_whole_engine_is_on_offer_not_a_handful_of_wrapped_tools():
    """우리가 감싼 몇 가지만 내주면 감싼 것만 할 수 있는 앱이 된다. 엔진이 받는 것을 그대로 내준다."""
    r = dc._commands_blocking()
    assert r["count"] > 500, r["count"]
    ids = {c["id"] for c in r["commands"]}
    # 글·도형·표·쪽·스타일·색·목차 — 한 분야만 되는 것이 아니다
    for must in ("frame.create", "file.place", "table.insert", "layout.pages.insert",
                 "style.paragraph.create", "swatch.create", "toc.generate", "object.qrCode"):
        assert must in ids, must
    assert all(c["params"] is not None for c in r["commands"])   # 인자 설명이 같이 온다


def _blank(tmp_path: Path) -> Path:
    src = tmp_path / "doc.idml"
    with Mcp(read_roots=[tmp_path], write_roots=[tmp_path]) as m:
        m.ex("file.new", intent="print", units="points", width=595, height=842,
             pages=1, facingPages=False, margins=36, primaryTextFrame=False)
        m.ex("file.exportIdml", path=str(src))
    return src


@needs_cli
def test_a_step_is_all_or_nothing(tmp_path):
    """명령 하나가 실패하면 **아무것도 저장하지 않는다.** 절반만 들어간 문서를 돌려주면 무엇이
    들어갔는지 사람이 알 수 없고, 되돌릴 자리도 흐려진다."""
    src = _blank(tmp_path)
    out = tmp_path / "job"
    out.mkdir()
    before = dc._edit_blocking(src, ".idml", out, [{"command": "layout.pages.insert", "params": {"count": 2}}])
    assert before["ok"] and before["pages"] == 3

    r = dc._edit_blocking(src, ".idml", out, [
        {"command": "layout.pages.insert", "params": {"count": 5}},          # 되는 명령
        {"command": "frame.create", "params": {"spread": 99, "rect": [0, 0, 1, 1]}},   # 안 되는 명령
    ])
    assert r["ok"] is False
    assert r["failed"]["command"] == "frame.create"
    # 앞의 '쪽 5개 추가'까지 저장됐다면 쪽수가 늘어 있을 것이다
    again = dc._edit_blocking(src, ".idml", out, [{"command": "layout.pages.insert", "params": {"count": 1}}])
    assert again["pages"] == 4, f"실패한 단계가 절반 저장됐다: {again['pages']}쪽"


@needs_cli
def test_undo_goes_back_one_step_and_no_further(tmp_path):
    """되돌리기는 **한 단계만** 간다. 두 번 눌러 더 과거로 가면 어디까지 돌아갔는지 알 수 없다."""
    src = _blank(tmp_path)
    out = tmp_path / "job"
    out.mkdir()
    dc._edit_blocking(src, ".idml", out, [{"command": "layout.pages.insert", "params": {"count": 3}}])
    r = dc._edit_blocking(src, ".idml", out, [{"command": "layout.pages.insert", "params": {"count": 4}}])
    assert r["pages"] == 8

    back = dc._undo_blocking(src, ".idml", out)
    assert back["pages"] == 4 and back["can_undo"] is False
    with pytest.raises(FileNotFoundError):
        dc._undo_blocking(src, ".idml", out)


@needs_cli
def test_a_new_text_box_gets_a_hangul_font_without_touching_the_rest(tmp_path):
    """기본 글꼴에는 한글이 없다. 글을 넣기 **전에** 글꼴을 세우면 그 상자만 바뀐다 —
    다 넣고 font.replace를 하면 문서의 다른 글까지 갈아 버린다."""
    src = _blank(tmp_path)
    out = tmp_path / "job"
    out.mkdir()
    r = dc._edit_blocking(src, ".idml", out, [
        {"command": "frame.create", "params": {"spread": 0, "rect": [60, 60, 400, 150], "content": "text"}},
        {"command": "text.insert", "params": {"text": "Latin stays"}},
        {"command": "frame.create", "params": {"spread": 0, "rect": [60, 200, 400, 320], "content": "text"}},
        {"command": "type.char", "params": {"attrs": {"fontFamily": dc.KO_FONT}}},
        {"command": "text.insert", "params": {"text": "한글 두 번째"}},
    ])
    assert r["ok"], r.get("failed")
    fams = {f["family"] for f in r["fonts"]}
    assert dc.KO_FONT in fams and dc.DEFAULT_FONT in fams, fams   # 둘이 같이 산다
    assert r["glyph_blocked"] == [], r["glyph_blocked"]           # 네모로 찍힌 글자가 없다

# ---------- 말로 부탁하기 ----------
# 명령 547개를 펼쳐 놓으면 할 수 있는 일은 많아지지만 처음 온 사람은 무엇을 눌러야 할지 모른다.
# 그래서 LLM이 명령을 짜 준다. **LLM은 확률적이라 계속 어긋나므로, 어긋남을 코드가 바로잡는다** —
# 프롬프트를 조이는 것보다 확실하다.
def test_compose_only_keeps_commands_it_knows():
    """목록에 없는 명령은 버린다. 버린 것을 돌려줘야 '모든 명령'에서 직접 쓸 수 있다."""
    fake = lambda _: ('{"says":"넣습니다","commands":['                     # noqa: E731
                      '{"command":"frame.create","params":{"spread":0,"rect":[1,2,3,4],"content":"text"}},'
                      '{"command":"file.package","params":{"dir":"C:/어딘가"}},'
                      '{"command":"지어낸명령","params":{}}]}')
    r = dc._compose_blocking("아무거나", {"pages": 1, "width_mm": 210, "height_mm": 297, "facing": False}, client=fake)
    assert [c["command"] for c in r["commands"]] == ["frame.create"]
    assert r["dropped"] == ["file.package", "지어낸명령"]


def test_compose_is_off_without_a_key(monkeypatch):
    """LLM은 늘 선택이다. 열쇠가 없으면 꺼졌다고 말하고 끝낸다 — 앱의 나머지는 그대로 돈다.

    어느 열쇠든 없으면 꺼진다. 둘 중 하나만 지우고 끝내면, 다른 하나가 개발자 PC에 있을 때
    이 시험이 **진짜 API를 부르러 간다**.
    """
    for k in ("ANTHROPIC_API_KEY", "GEMINI_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    r = dc._compose_blocking("아무거나", {"pages": 1})
    assert r["available"] is False and r["commands"] == []
    assert "ANTHROPIC_API_KEY" in r["reason"]


def test_a_plan_that_puts_the_font_after_the_text_is_fixed():
    """실측으로 본 어긋남이다. LLM은 `frame.create(text=…)` 뒤에 글꼴을 세우는데, 글이 먼저
    들어가 버려 글꼴이 안 먹는다 — 한글이면 PDF에 한 자도 찍히지 않는다.
    `frame.create → type.char → text.insert` 순서로 돌려 놓아야 한다."""
    got = dc._normalize([
        {"command": "frame.create", "params": {"spread": 0, "rect": [1, 2, 3, 4], "content": "text", "text": "한글 제목"}},
        {"command": "type.char", "params": {"attrs": {"size": 32}}},
    ])
    assert [c["command"] for c in got] == ["frame.create", "type.char", "text.insert"]
    assert "text" not in got[0]["params"]                       # 글은 떼어 냈다
    assert got[1]["params"]["attrs"]["fontFamily"] == dc.KO_FONT  # 글꼴을 세웠다
    assert got[1]["params"]["attrs"]["size"] == 32                # LLM이 정한 크기는 살렸다
    assert got[2]["params"]["text"] == "한글 제목"


def test_the_same_text_is_not_inserted_twice():
    """LLM이 `frame.create`의 text와 `text.insert`로 같은 글을 두 번 넣는다. 한 번만 넣는다."""
    got = dc._normalize([
        {"command": "frame.create", "params": {"rect": [1, 2, 3, 4], "content": "text", "text": "이태윤"}},
        {"command": "text.insert", "params": {"text": "이태윤"}},
    ])
    assert [c["command"] for c in got].count("text.insert") == 1


def test_hangul_always_gets_a_font_even_when_the_plan_forgot():
    got = dc._normalize([
        {"command": "frame.create", "params": {"rect": [1, 2, 3, 4], "content": "text"}},
        {"command": "text.insert", "params": {"text": "한글만 넣었다"}},
    ])
    assert [c["command"] for c in got] == ["frame.create", "type.char", "text.insert"]
    assert got[1]["params"]["attrs"]["fontFamily"] == dc.KO_FONT


def test_latin_text_is_left_alone():
    """한글이 아니면 글꼴을 세우지 않는다 — 문서가 고른 글꼴을 우리가 바꿀 이유가 없다."""
    got = dc._normalize([
        {"command": "frame.create", "params": {"rect": [1, 2, 3, 4], "content": "text"}},
        {"command": "text.insert", "params": {"text": "Latin only"}},
    ])
    assert [c["command"] for c in got] == ["frame.create", "text.insert"]


def test_compose_refuses_an_empty_request():
    req = AgentRequest(meta=meta(), skill="compose", input={"request": "   "})
    r = asyncio.run(dc.compose(req))
    assert r["status"] == "rejected" and r["outcome"] == "INVALID_INPUT"


@needs_cli
def test_the_plan_can_only_reach_commands_the_engine_really_has():
    """허용 목록이 엔진에 실제로 있는 명령이어야 한다. 하나라도 사라지면 LLM이 그것을 짜 줄 때
    늘 실패하는데, 그 이유가 화면에 드러나지 않는다."""
    ids = {c["id"] for c in dc._commands_blocking()["commands"]}
    missing = [c for c in dc.COMPOSE_OK if c not in ids]
    assert not missing, f"엔진에 없는 명령이 허용 목록에 있다: {missing}"


# ---------- 만든 문서의 이름 ----------
# 부탁한 것이 이름에 드러나야 한다. 그런데 그 값이 그대로 파일 이름이 되므로, 드러내는 것과
# 안전한 것을 **한 함수 안에서** 같이 지켜야 한다. 아래가 그 두 가지를 갈라 본다.
def test_the_name_says_what_was_asked_for():
    assert dc._doc_name("홍길동_명함", sample=False) == "홍길동_명함.idml"
    assert dc._doc_name("가을호 포스터", sample=False) == "가을호 포스터.idml"
    assert dc._doc_name("홍길동_명함.idml", sample=False) == "홍길동_명함.idml"   # 확장자를 두 번 붙이지 않는다


def test_no_name_keeps_the_old_one():
    """이름을 안 주던 부르는 쪽이 아직 있다. 그쪽이 깨지면 안 된다."""
    assert dc._doc_name("", sample=False) == "새 문서.idml"
    assert dc._doc_name(None, sample=False) == "새 문서.idml"
    assert dc._doc_name("   ", sample=True) == "샘플 잡지.idml"


def test_a_name_cannot_walk_out_of_the_folder():
    """**이 값은 파일 이름이 된다.** 그대로 쓰면 보관 폴더 밖에 쓰게 된다 — 만들기 한 번으로
    이 PC의 아무 자리나 덮어쓸 수 있다는 뜻이다."""
    for bad in ("../../.ssh/authorized_keys", r"..\..\windows\system32\x",
                "C:/Users/403/x", "명함/../../x", "a\x00b/c"):
        got = dc._doc_name(bad, sample=False)
        assert "/" not in got and "\\" not in got and ":" not in got, got
        assert not got.startswith(".") and "\x00" not in got, got
        assert got.endswith(".idml")


def test_a_name_that_is_only_dots_falls_back():
    """`.`과 `..`은 이름이 아니라 폴더를 가리킨다."""
    assert dc._doc_name(".", sample=False) == "새 문서.idml"
    assert dc._doc_name("..", sample=False) == "새 문서.idml"
    assert dc._doc_name("....idml", sample=False) == "새 문서.idml"


def test_windows_device_names_fall_back():
    """윈도에서 `CON.idml`은 파일이 아니라 장치로 열린다 — 쓰는 쪽이 조용히 멈춘다."""
    for dev in ("CON", "con", "  nul  ", "LPT1", "com9.idml"):
        assert dc._doc_name(dev, sample=False) == "새 문서.idml", dev
    assert dc._doc_name("content", sample=False) == "content.idml"   # 비슷하지만 장치가 아니다


def test_a_very_long_name_is_cut_but_stays_a_name():
    got = dc._doc_name("명" * 300, sample=False)
    assert got == "명" * dc.MAX_DOC_NAME + ".idml"
    assert len(got.encode()) < 255        # 파일 시스템이 받는 길이 안에 있다
