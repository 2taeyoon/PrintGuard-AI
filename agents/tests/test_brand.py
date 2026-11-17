"""브랜드 키트 — 등록한 색·글꼴·로고가 그대로 지켜지고, 주인이 바르게 갈리는지.

지키는 것:
- 색은 CMYK 0~100만 받는다. 틀린 값은 **고쳐 넣지 않고 거절한다**(조용히 고치면 등록한 색과 찍히는 색이 달라진다).
- 이 PC에 없는 글꼴은 거절한다 — 엔진이 한글 없는 기본 글꼴로 바꿔 찍어 글자가 사라진다.
- 영문 전용 글꼴은 받되, 한글 상자에는 한글 글꼴을 쓰라고 엔진 쪽에 일러 준다.
- 이 PC에서 직접 온 요청은 이 PC의 클로드(MCP)와 한 키트를 쓴다. 터널을 거친 요청은 바깥 사람으로 본다.
"""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pg_agents import brand
from pg_agents.auth import mint, tool_subject
from pg_agents.orchestrator.app import app

KIT = {"name": "여백 출판사", "colors": [{"name": "주색", "c": 100, "m": 80, "y": 0, "k": 10}],
       "title_font": "", "body_font": ""}


def _h(sub: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {mint('browser', subject=sub)}"}


def test_validate_refuses_bad_colors_instead_of_fixing_them():
    with pytest.raises(ValueError, match="0~100"):
        brand.validate({"colors": [{"name": "주색", "c": 120, "m": 0, "y": 0, "k": 0}]})
    with pytest.raises(ValueError, match="겹칩니다"):
        brand.validate({"colors": [{"name": "a", "c": 0, "m": 0, "y": 0, "k": 0}] * 2})
    with pytest.raises(ValueError, match="6개"):
        brand.validate({"colors": [{"name": f"c{i}", "c": 0, "m": 0, "y": 0, "k": 0} for i in range(7)]})
    assert brand.validate(KIT)["colors"][0] == {"name": "주색", "c": 100, "m": 80, "y": 0, "k": 10}


def test_validate_refuses_font_not_on_this_pc():
    with pytest.raises(ValueError, match="없는"):
        brand.validate({**KIT, "title_font": "Helvetica"}, fonts=["Malgun Gothic"])
    assert brand.validate({**KIT, "body_font": "Malgun Gothic"}, fonts=["Malgun Gothic"])["body_font"] == "Malgun Gothic"


def test_prompt_block_carries_exact_values_and_logo_path():
    b = brand.prompt_block({**KIT, "title_font": "Batang"}, "/x/brand_logo.png", "Malgun Gothic")
    assert "주색(c100 m80 y0 k10)" in b
    assert '제목은 "Batang"' in b and '본문은 "Batang"' in b     # 본문이 비면 제목 글꼴을 쓴다
    assert "/x/brand_logo.png" in b


def test_kits_are_per_owner_and_logo_path_never_leaks():
    with TestClient(app) as c:
        assert c.get("/designcraft/brand", headers=_h("kit-a")).json()["data"] is None
        r = c.put("/designcraft/brand", json=KIT, headers=_h("kit-a"))
        assert r.status_code == 200, r.text
        r = c.post("/designcraft/brand/logo", files={"file": ("logo.png", b"\x89PNG fake", "image/png")},
                   headers=_h("kit-a"))
        assert r.status_code == 200
        got = c.get("/designcraft/brand", headers=_h("kit-a")).json()["data"]
        assert got["colors"] == KIT["colors"] and got["logo"] == {"name": "logo.png", "bytes": 9}
        assert "path" not in got["logo"]                                  # PC 안의 경로는 밖으로 내보내지 않는다
        assert c.get("/designcraft/brand/logo", headers=_h("kit-a")).content == b"\x89PNG fake"
        # 남의 키트는 안 보인다
        assert c.get("/designcraft/brand", headers=_h("kit-b")).json()["data"] is None
        # 다시 저장해도 로고는 그대로 남는다
        c.put("/designcraft/brand", json={**KIT, "name": "바뀐 이름"}, headers=_h("kit-a"))
        assert c.get("/designcraft/brand", headers=_h("kit-a")).json()["data"]["logo"]["name"] == "logo.png"
        assert c.put("/designcraft/brand", json={"colors": [{"name": "x", "c": -1, "m": 0, "y": 0, "k": 0}]},
                     headers=_h("kit-a")).status_code == 400
        assert c.post("/designcraft/brand/logo", files={"file": ("a.exe", b"MZ", "application/octet-stream")},
                      headers=_h("kit-a")).status_code == 400
        assert c.delete("/designcraft/brand", headers=_h("kit-a")).json()["data"]["deleted"] is True
        assert c.get("/designcraft/brand", headers=_h("kit-a")).json()["data"] is None


def test_this_pc_shares_kit_with_its_tool_but_tunnel_does_not():
    with TestClient(app, client=("127.0.0.1", 50000)) as c:
        c.put("/designcraft/brand", json=KIT, headers=_h("browser-anon"))
        assert brand.load(tool_subject())["name"] == "여백 출판사"        # 이 PC의 클로드가 같은 키트를 본다
        # 터널로 들어온 요청은 주소가 127.0.0.1이어도 바깥 사람이다
        r = c.get("/designcraft/brand", headers={**_h("outsider"), "X-Forwarded-For": "203.0.113.9"})
        assert r.json()["data"] is None
        c.delete("/designcraft/brand", headers=_h("browser-anon"))


def test_apply_copies_logo_into_the_document_folder(monkeypatch):
    """edit_document로 직접 짤 때 로고를 넣을 수 있어야 한다 — 엔진은 문서 폴더 밖을 못 읽는다."""
    from pg_agents.orchestrator import app as orch
    monkeypatch.setitem(orch.DCJOBS, "ctx_dc_kit", {"client": "kit-c", "made": True, "filename": "a.idml"})
    monkeypatch.setattr(orch, "_dc_save", lambda ctx: None)   # 공용 저장소에 가짜 문서를 남기지 않는다
    with TestClient(app) as c:
        c.put("/designcraft/brand", json=KIT, headers=_h("kit-c"))
        c.post("/designcraft/brand/logo", files={"file": ("d.pdf", b"%PDF-1.4 fake", "application/pdf")}, headers=_h("kit-c"))
        got = c.post("/designcraft/ctx_dc_kit/brand", headers=_h("kit-c")).json()["data"]
        assert Path(got["logo_path"]).parts[-3:] == ("ctx_dc_kit", "assets", "brand_logo.pdf")
        assert orch.DCJOBS["ctx_dc_kit"]["assets"][0]["path"] == got["logo_path"]   # compose도 이 경로를 안다
        assert c.post("/designcraft/ctx_dc_kit/brand", headers=_h("someone-else")).status_code == 404
        c.delete("/designcraft/brand", headers=_h("kit-c"))


def test_decimal_cmyk_is_refused_not_rounded():
    """12.4를 12로 저장하면 등록한 색과 찍히는 색이 달라진다. 거절하고 이유를 말한다."""
    with pytest.raises(ValueError, match="정수"):
        brand.validate({"colors": [{"name": "주색", "c": 12.4, "m": 0, "y": 0, "k": 0}]})
    with pytest.raises(ValueError, match="0~100"):
        brand.validate({"colors": [{"name": "주색", "c": True, "m": 0, "y": 0, "k": 0}]})
    assert brand.validate({"colors": [{"name": "주색", "c": 12.0, "m": 0, "y": 0, "k": 0}]})["colors"][0]["c"] == 12


def test_empty_font_list_still_refuses_fonts():
    """이 PC에서 한글 글꼴을 하나도 못 찾았으면, 어떤 글꼴도 받지 않는다(검사를 건너뛰지 않는다)."""
    with pytest.raises(ValueError, match="없는"):
        brand.validate({**KIT, "title_font": "Malgun Gothic"}, fonts=[])
    assert brand.validate(KIT, fonts=[])["title_font"] == ""          # 비워 두는 것은 된다


def test_new_logo_replaces_old_only_after_it_is_written(monkeypatch):
    owner = "kit-logo"
    first = brand.set_logo(owner, b"PNG-1", ".png", "a.png")["logo"]["path"]
    second = brand.set_logo(owner, b"%PDF-2", ".pdf", "b.pdf")["logo"]["path"]
    assert not Path(first).exists() and Path(second).read_bytes() == b"%PDF-2"   # 확장자가 달라도 옛 것은 정리된다
    # 쓰다가 실패하면 옛 로고는 그대로 남는다
    monkeypatch.setattr(Path, "write_bytes", lambda self, data: (_ for _ in ()).throw(OSError("디스크가 찼습니다")))
    with pytest.raises(OSError):
        brand.set_logo(owner, b"PNG-3", ".png", "c.png")
    monkeypatch.undo()
    kit = brand.load(owner)
    assert kit["logo"]["name"] == "b.pdf" and Path(kit["logo"]["path"]).read_bytes() == b"%PDF-2"
    # JSON 저장이 실패해도 옛 로고와 기록은 그대로고, 새 파일은 남지 않는다
    monkeypatch.setattr(brand, "_write", lambda o, k: (_ for _ in ()).throw(OSError("JSON 저장 실패")))
    with pytest.raises(OSError):
        brand.set_logo(owner, b"PNG-4", ".pdf", "d.pdf")
    monkeypatch.undo()
    kit = brand.load(owner)
    assert kit["logo"]["name"] == "b.pdf" and Path(kit["logo"]["path"]).read_bytes() == b"%PDF-2"
    assert len(list(brand.BRAND.glob(f"{brand._key(owner)}_logo.*"))) == 1
    brand.delete(owner)


def test_truncated_ttc_is_skipped(tmp_path):
    """잘린 ttc 헤더가 struct.error로 글꼴 조회 전체를 죽이지 않는다."""
    bad = tmp_path / "bad.ttc"
    bad.write_bytes(b"ttcf")
    assert brand._faces(bad) == []


def test_saving_fields_and_logo_together_keeps_both(monkeypatch):
    """두 쪽이 번갈아 저장해도 서로의 값을 지우지 않는다."""
    import threading
    import time
    real_load = brand.load

    def slow_load(o):
        data = real_load(o)
        time.sleep(0.02)  # 읽은 뒤 쓰기 전에 멈춰, 잠금이 없으면 같은 옛 상태를 읽고 서로 덮어쓰게 한다
        return data
    monkeypatch.setattr(brand, "load", slow_load)
    owner = "kit-race"
    errs = []

    def fields(i):
        try:
            brand.save(owner, {"name": f"이름{i}", "colors": [], "title_font": "", "body_font": ""})
        except Exception as e:      # noqa: BLE001
            errs.append(e)

    def logo(i):
        try:
            brand.set_logo(owner, f"L{i}".encode(), ".png", f"l{i}.png")
        except Exception as e:      # noqa: BLE001
            errs.append(e)
    ts = [threading.Thread(target=f, args=(i,)) for i in range(20) for f in (fields, logo)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    kit = brand.load(owner)
    assert not errs and kit["name"].startswith("이름") and kit["logo"]["name"].startswith("l")
    brand.delete(owner)


def test_compose_with_a_kit_reaches_the_agent(monkeypatch):
    """/compose가 키트를 실어 에이전트를 부른다. 예전에는 부탁 글이 HTTP 요청 변수를 덮어써
    키트 주인을 가리다 넘어졌다(str에 headers가 없다) — compose가 늘 500이었다."""
    from pg_agents.orchestrator import app as orch
    monkeypatch.setitem(orch.DCJOBS, "ctx_dc_cmp", {"client": "kit-d", "made": True, "filename": "a.idml",
                                                     "width_mm": 90, "height_mm": 50})
    monkeypatch.setattr(orch, "_dc_save", lambda ctx: None)
    sent = {}

    async def fake_ask(agent, skill, _ctx, body):
        sent.update(agent=agent, skill=skill, body=body)
        return {"status": "completed", "output": {"available": True, "commands": [], "says": "짰습니다"}}
    monkeypatch.setattr(orch, "_ask", fake_ask)
    monkeypatch.setattr(orch, "log_event", lambda *a, **k: None)
    with TestClient(app) as c:
        c.put("/designcraft/brand", json=KIT, headers=_h("kit-d"))
        c.post("/designcraft/brand/logo", files={"file": ("d.pdf", b"%PDF logo", "application/pdf")}, headers=_h("kit-d"))
        r = c.post("/designcraft/ctx_dc_cmp/compose", json={"request": "명함 만들어 줘"}, headers=_h("kit-d"))
        assert r.status_code == 200, r.text
        assert sent["skill"] == "compose" and sent["body"]["request"] == "명함 만들어 줘"
        assert sent["body"]["brand"]["colors"] == KIT["colors"]
        assert sent["body"]["brand"]["logo_path"] == sent["body"]["assets"][-1]["path"]
        c.delete("/designcraft/brand", headers=_h("kit-d"))


def test_changed_logo_with_the_same_size_is_copied_again(monkeypatch):
    """크기만 같다고 건너뛰면, 색 코드만 바꾼 SVG처럼 바이트 수가 같은 새 로고가 문서에 안 들어간다."""
    from pg_agents.orchestrator import app as orch
    monkeypatch.setitem(orch.DCJOBS, "ctx_dc_same", {"client": "kit-e", "made": True, "filename": "a.idml"})
    monkeypatch.setattr(orch, "_dc_save", lambda ctx: None)
    with TestClient(app) as c:
        c.put("/designcraft/brand", json=KIT, headers=_h("kit-e"))
        c.post("/designcraft/brand/logo", files={"file": ("d.svg", b"<svg fill='#ff0000'/>", "image/svg+xml")}, headers=_h("kit-e"))
        p1 = c.post("/designcraft/ctx_dc_same/brand", headers=_h("kit-e")).json()["data"]["logo_path"]
        c.post("/designcraft/brand/logo", files={"file": ("d.svg", b"<svg fill='#0000ff'/>", "image/svg+xml")}, headers=_h("kit-e"))
        p2 = c.post("/designcraft/ctx_dc_same/brand", headers=_h("kit-e")).json()["data"]["logo_path"]
        assert p1 == p2 and Path(p2).read_bytes() == b"<svg fill='#0000ff'/>"
        c.delete("/designcraft/brand", headers=_h("kit-e"))


# ---------- 키트에 올린 글꼴 파일 ----------
# 진짜 글꼴 파일은 저장소에 넣지 않는다(라이선스·용량). 파일을 읽는 부분(faces)만 가짜로 바꾸고,
# 받기·거절·문서 옆 Document Fonts/로 옮기기를 본다.
def _fake_faces(monkeypatch, table):
    monkeypatch.setattr(brand, "faces", lambda p: table.get(Path(p).name.replace(".tmp", ""), []))


def test_latin_only_font_is_taken_but_variable_font_is_refused(monkeypatch):
    """영문 전용 글꼴도 받는다(영문 로고타입·영문 제목). 한글이 없다는 것은 적어 둔다.
    가변 글꼴과 글꼴이 아닌 파일은 여전히 거절한다."""
    _fake_faces(monkeypatch, {"Latin.ttf": [{"family": "Latin", "style": "Regular", "hangul": False}],
                              "Var.ttf": []})
    kit = brand.add_font("kit-f", b"x", "Latin.ttf")
    assert [(f["family"], f["hangul"]) for f in kit["fonts"]] == [("Latin", False)]
    brand.remove_font("kit-f", "Latin.ttf")
    with pytest.raises(ValueError, match="가변 글꼴"):
        brand.add_font("kit-f", b"x", "Var.ttf")
    with pytest.raises(ValueError, match=r"\.ttf"):
        brand.add_font("kit-f", b"x", "font.woff2")
    assert not (brand.load("kit-f") or {}).get("fonts")


def test_uploaded_font_can_be_picked_and_goes_beside_the_document(monkeypatch, tmp_path):
    """(이름은 어느 PC에도 깔려 있을 리 없는 것을 쓴다 — Pretendard를 쓰면 그 글꼴을 깐 PC에서 깨진다.)
    올린 글꼴은 고를 수 있고, 키트를 문서에 쓰면 그 문서 **원본 옆** Document Fonts/로 간다.
    작업 폴더에 두면 엔진이 안 읽는다 — 고치기는 원본(SRC/<src_ref>/)을 열기 때문이다."""
    from pg_agents.orchestrator import app as orch
    _fake_faces(monkeypatch, {"KitOnlyFont-Bold.ttf": [{"family": "KitOnlyFont", "style": "Bold", "hangul": True}]})
    monkeypatch.setattr(orch, "SRC", tmp_path)
    (tmp_path / "ref1").mkdir()
    monkeypatch.setitem(orch.DCJOBS, "ctx_dc_font", {"client": "kit-g", "made": True, "filename": "a.idml", "src_ref": "ref1"})
    monkeypatch.setattr(orch, "_dc_save", lambda ctx: None)
    with TestClient(app) as c:
        # 올리기 전에는 고를 수 없다
        assert c.put("/designcraft/brand", json={**KIT, "title_font": "KitOnlyFont"}, headers=_h("kit-g")).status_code == 400
        r = c.post("/designcraft/brand/font", files={"file": ("KitOnlyFont-Bold.ttf", b"FONTDATA", "font/ttf")}, headers=_h("kit-g"))
        assert r.status_code == 200, r.text
        assert r.json()["data"]["fonts"] == [{"family": "KitOnlyFont", "style": "Bold", "name": "KitOnlyFont-Bold.ttf", "bytes": 8,
                                              "hangul": True, "langs": []}]
        assert c.put("/designcraft/brand", json={**KIT, "title_font": "KitOnlyFont"}, headers=_h("kit-g")).status_code == 200
        # 필드를 저장해도 올린 글꼴은 남는다
        assert c.get("/designcraft/brand", headers=_h("kit-g")).json()["data"]["fonts"][0]["family"] == "KitOnlyFont"
        got = c.post("/designcraft/ctx_dc_font/brand", headers=_h("kit-g")).json()["data"]
        assert (tmp_path / "ref1" / "Document Fonts" / "KitOnlyFont-Bold.ttf").read_bytes() == b"FONTDATA"
        assert got["fonts"] == [{"family": "KitOnlyFont", "style": "Bold"}]
        # 빼면 그 글꼴을 고른 칸은 기본값(맑은 고딕)으로 돌아간다
        k = c.delete("/designcraft/brand/font/KitOnlyFont-Bold.ttf", headers=_h("kit-g")).json()["data"]
        assert k["fonts"] == [] and k["title_font"] == ""
        c.delete("/designcraft/brand", headers=_h("kit-g"))


def test_prompt_tells_which_weights_an_uploaded_font_has():
    b = brand.prompt_block({**KIT, "title_font": "Pretendard",
                            "fonts": [{"family": "Pretendard", "style": "Bold", "file": "p.ttf"}]}, None, "Malgun Gothic")
    assert '"Pretendard"는 올린 글꼴이라 굵기가 Bold뿐' in b



def test_pc_owner_sees_the_same_kit_through_the_public_site():
    """이 PC 앞에서 구글로 로그인한 계정은 공개 사이트(터널)로 들어와도 이 PC의 키트 — 클로드가
    쓰는 그 키트 — 를 본다. 예전에는 계정 몫으로 키트가 따로 생겨, 화면의 키트와 클로드가 만든
    문서가 달랐다. 바깥 사람은 여전히 자기 키트만 본다."""
    tunnel = {"X-Forwarded-For": "203.0.113.9"}
    owner = {"Authorization": f"Bearer {mint('browser', subject='g-owner', label='owner@example.com')}"}
    stranger = {"Authorization": f"Bearer {mint('browser', subject='g-stranger', label='who@example.com')}"}
    anon = {"Authorization": f"Bearer {mint('browser', subject='anon-1', label='anon')}"}
    with TestClient(app, client=("127.0.0.1", 50000)) as c:
        c.put("/designcraft/brand", json=KIT, headers=anon)          # 이 PC의 키트(익명으로 등록)
        # 터널로 온 구글 계정은 아직 이 PC 주인으로 적히지 않았다 → 자기 키트(없음)
        assert c.get("/designcraft/brand", headers={**owner, **tunnel}).json()["data"] is None
        # 이 PC 앞에서 같은 계정으로 한 번 열면 적힌다
        assert c.get("/designcraft/brand", headers=owner).json()["data"]["name"] == "여백 출판사"
        assert c.get("/designcraft/brand", headers={**owner, **tunnel}).json()["data"]["name"] == "여백 출판사"
        # 익명 토큰은 적지 않는다, 바깥 사람은 여전히 따로다
        assert not brand.is_pc_owner("anon-1")
        assert c.get("/designcraft/brand", headers={**stranger, **tunnel}).json()["data"] is None
        # 터널로 들어온 사람은 자기를 이 PC 주인으로 적을 수 없다
        c.get("/designcraft/brand", headers={**stranger, **tunnel})
        assert not brand.is_pc_owner("g-stranger")
        c.delete("/designcraft/brand", headers=anon)



def test_font_list_can_be_read_again_after_installing_a_font(monkeypatch, tmp_path):
    """글꼴 목록은 한 번 읽고 기억한다. 에이전트를 켠 뒤에 깐 글꼴(Pretendard)이 새로고침해도 안 보였다.
    refresh=1이면 다시 읽어 새 글꼴이 들어온다."""
    monkeypatch.setattr(brand, "FONT_DIRS", [tmp_path])
    monkeypatch.setattr(brand, "_faces", lambda p: [(p.stem, ("한글", "영문"))])
    brand.installed_fonts.cache_clear()
    names = lambda r: [f["family"] for f in r.json()["data"]]  # noqa: E731
    (tmp_path / "Old.ttf").write_bytes(b"x")
    with TestClient(app) as c:
        assert names(c.get("/designcraft/brand/fonts")) == ["Old"]
        (tmp_path / "Pretendard.otf").write_bytes(b"x")           # 켠 뒤에 깐 글꼴
        assert names(c.get("/designcraft/brand/fonts")) == ["Old"]
        assert names(c.get("/designcraft/brand/fonts?refresh=1")) == ["Old", "Pretendard"]
    brand.installed_fonts.cache_clear()


def test_font_list_marks_latin_only_and_user_installed(monkeypatch, tmp_path):
    """영문 전용 글꼴도 목록에 오고, 한글이 없다는 것과 사람이 직접 깐 글꼴인지가 같이 온다.
    (윈도 기본 영문 글꼴 100여 개 사이에 직접 깐 글꼴이 묻히지 않게 화면이 따로 묶는다.)"""
    sysd, userd = tmp_path / "sys", tmp_path / "user"
    sysd.mkdir(); userd.mkdir()
    monkeypatch.setattr(brand, "FONT_DIRS", [sysd, userd])
    monkeypatch.setattr(brand, "USER_FONT_DIRS", [userd])
    table = {"Arial.ttf": [("Arial", ("영문",))], "Batang.ttc": [("Batang", ("한글", "영문", "한자"))],
             "Pretendard.otf": [("Pretendard", ("한글", "영문"))],
             # 굵기마다 지원 글자가 다르면 합친다(Bold에만 한자가 있는 경우)
             "Brand-Regular.otf": [("BrandSans", ("영문",))], "Brand-Bold.otf": [("BrandSans", ("한자", "영문"))]}
    monkeypatch.setattr(brand, "_faces", lambda p: table[p.name])
    for n in ("Arial.ttf", "Batang.ttc"):
        (sysd / n).write_bytes(b"x")
    for n in ("Pretendard.otf", "Brand-Regular.otf", "Brand-Bold.otf"):
        (userd / n).write_bytes(b"x")
    brand.installed_fonts.cache_clear()
    with TestClient(app) as c:
        rows = c.get("/designcraft/brand/fonts?refresh=1").json()["data"]
    brand.installed_fonts.cache_clear()
    assert rows == [{"family": "Arial", "hangul": False, "user": False, "langs": ["영문"]},
                    {"family": "Batang", "hangul": True, "user": False, "langs": ["한글", "영문", "한자"]},
                    {"family": "BrandSans", "hangul": False, "user": True, "langs": ["영문", "한자"]},
                    {"family": "Pretendard", "hangul": True, "user": True, "langs": ["한글", "영문"]}]


def test_latin_only_font_is_saved_and_kept_off_hangul_text():
    """영문 전용 글꼴을 고르면 키트에 그 사실이 남고, 엔진 쪽 안내문은 그 글꼴을 영문·숫자에만 쓰고
    한글이 든 상자는 한글 글꼴로 짜라고 한다. 한글을 영문 글꼴로 짜면 PDF에 한 자도 안 찍힌다."""
    fonts = {"Malgun Gothic": True, "Batang": True, "BrandSans": False}
    kit = brand.validate({**KIT, "title_font": "BrandSans", "body_font": "Batang"}, fonts)
    assert kit["latin_only"] == ["BrandSans"]
    b = brand.prompt_block(kit, None, "Malgun Gothic")
    assert '"BrandSans"에는 **한글이 없다**' in b and '한글이 한 글자라도 든 글 상자는 "Batang"로 짠다' in b
    # 둘 다 영문 전용이면 한글은 기본 한글 글꼴로
    both = brand.validate({**KIT, "title_font": "BrandSans", "body_font": "BrandSans"}, fonts)
    assert '든 글 상자는 "Malgun Gothic"로 짠다' in brand.prompt_block(both, None, "Malgun Gothic")
    # 한글 글꼴만 고르면 그런 말이 없다
    ko = brand.validate({**KIT, "title_font": "Batang"}, fonts)
    assert ko["latin_only"] == [] and "한글이 없다" not in brand.prompt_block(ko, None, "Malgun Gothic")


def test_brand_for_carries_latin_only_to_the_prompt(monkeypatch):
    """오케스트레이터가 엔진 쪽에 넘기는 키트에 latin_only가 실려야 한다. 빠지면 prompt_block이
    '한글은 한글 글꼴로' 안내를 못 만들어, 영문 전용 글꼴로 짠 한글이 PDF에서 사라진다."""
    from pg_agents.orchestrator import app as orch
    monkeypatch.setattr(orch.brand, "font_files", lambda owner, kit: [])
    monkeypatch.setattr(orch.brand, "load", lambda owner: {**KIT, "title_font": "BrandSans", "latin_only": ["BrandSans"]})
    got = orch._brand_for("ctx", {}, "kit-x")
    assert got["latin_only"] == ["BrandSans"]
    assert "한글이 없다" in brand.prompt_block(got, None, "Malgun Gothic")
