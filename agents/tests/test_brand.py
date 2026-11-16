"""브랜드 키트 — 등록한 색·글꼴·로고가 그대로 지켜지고, 주인이 바르게 갈리는지.

지키는 것:
- 색은 CMYK 0~100만 받는다. 틀린 값은 **고쳐 넣지 않고 거절한다**(조용히 고치면 등록한 색과 찍히는 색이 달라진다).
- 이 PC에 없는(한글이 없는) 글꼴은 거절한다 — 엔진이 한글 없는 기본 글꼴로 바꿔 찍어 글자가 사라진다.
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
