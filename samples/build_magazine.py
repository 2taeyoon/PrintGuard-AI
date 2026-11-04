"""시험용 잡지 20쪽을 짓는다 — PrintGuard가 잡아내는 오류를 종류별로 일부러 심는다.

    conda activate dev
    python samples/build_magazine.py

만들어지는 것(samples/jongi-wa-ingk/):
    jongi-wa-ingk.idml      편집 파일
    Links/                  사진 — IDML은 사진을 링크로만 들고 있어서 이 폴더가 있어야 한다
    jongi-wa-ingk.pdf       위 IDML에서 뽑은 검수용 PDF
    README.md               무엇을 심었는지

심은 오류(검수에서 이것들이 나와야 한다)
    글    맞춤법 14건(사전) · 율/률 표기 불일치 · 단어 반복 · 수치 불일치
    구조  저해상 사진 2장 · RGB 사진 · 안전 영역 침범 · 페이지 밖으로 나간 글
    원본  넘친 글(overset) · 빈 텍스트 프레임

DesignCraft CLI가 있어야 한다(README의 '인디자인 원본 수정' 절 참고).
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agents"))
sys.stdout.reconfigure(encoding="utf-8")

from pg_agents.designcraft.mcp_client import Mcp  # noqa: E402

OUT = Path(__file__).resolve().parent / "jongi-wa-ingk"
LINKS = OUT / "Links"
KR = "Noto Sans KR"
W, H = 595.3, 841.9  # A4 (pt)

# (제목, 본문, 사진, 캡션, 심은 것)
PAGES: list[tuple[str, str, str | None, str | None, str]] = [
    ("계간 종이와 잉크",
     "2026년 겨울호\n특집 · 작은 출판사의 인쇄 공정\n\n값 12,000원", "cover.jpg", None, "표지"),

    ("이번 호에 담은 것",
     "02 여는 글 — 고치는 일\n"
     "04 특집 ① 종이를 고르는 일\n"
     "06 특집 ② 잉크가 마르는 시간\n"
     "08 특집 ③ 색은 어디서 틀어지나\n"
     "10 인터뷰 — 15년 차 인쇄 감리\n"
     "13 작업실 탐방 세 곳\n"
     "16 독자 질문함\n"
     "18 종이 값 비교표\n"
     "20 닫는 글", None, None, ""),

    ("여는 글 — 고치는 일",
     "한 권을 만드는 데 드는 시간의 절반은 고치는 데 쓴다.\n"
     "편집자의 역활은 글을 다듬는 것에서 끝나지 않는다. 종이와 잉크를 고르고, 인쇄소와 말을 맞추고, "
     "교정지를 몇 번이고 되넘긴다.\n"
     "이번 호는 그 과정을 일일히 따라가 보았다. 쓰는 일보다 고치는 일이 길다는 것을, 만들면서 다시 배웠다.",
     None, None, "맞춤법: 역활, 일일히"),

    ("특집 ① 종이를 고르는 일",
     "같은 파일도 종이가 바뀌면 다른 책이 된다.\n"
     "코팅지는 잉크가 표면에 얹혀 색이 선명하고, 비코팅지는 스며들어 차분하다. 아트지와 스노우지가 앞쪽이고 "
     "모조지와 랑데뷰지가 뒤쪽이다.\n"
     "인쇄소에 넘기기 전에 칼라를 어떻게 맞출지 메세지로 남겨 두는 편이 좋다. 말로만 하면 서로 기억이 다르다.",
     "paper.jpg", "아트지와 모조지에 같은 사진을 찍어 비교했다", "맞춤법: 칼라, 메세지"),

    ("특집 ① — 이어서",
     "평량은 종이 한 장의 무게다. 본문은 보통 80~100g, 표지는 200g 안팎을 쓴다.\n"
     "두께는 평량만으로 정해지지 않는다. 같은 100g이라도 부피가 큰 종이가 더 두껍다.\n"
     "종이를 바꾸면 책등 두께가 달라져서 표지를 다시 짜야 한다. 이것을 깜빡하는 일이 번번히 생긴다.",
     None, None, "맞춤법: 번번히"),

    ("특집 ② 잉크가 마르는 시간",
     "총 잉크량이 높으면 마르는 데 오래 걸린다. 뒷묻음이 생기는 것도 대개 이때다.\n"
     "인쇄소에서 몇일 걸린다고 하면 그 말을 믿고 일정을 잡는 편이 낫다. 재촉해서 좋을 것이 없다.\n"
     "건조대에 쌓는 높이도 영향을 준다. 아래쪽 종이가 눌려 잉크가 옮겨 붙는다.",
     "dryer.jpg", "건조대에 올린 전지 — 자료 사진", "맞춤법: 몇일 / 저해상 사진"),

    ("특집 ③ 색은 어디서 틀어지나",
     "화면은 빛을 더해 색을 만들고 인쇄는 잉크를 겹쳐 뺀다. 그래서 화면에서 선명하던 색이 인쇄에서 탁해진다.\n"
     "특히 형광에 가까운 초록과 파랑이 많이 죽는다. 미리 소프트 프루프로 확인하는 수밖에 없다.\n"
     "교정쇄를 뽑아 보면 확실하지만 돈과 시간이 든다.",
     "color.jpg", "RGB로 둔 사진 — 인쇄 색과 차이가 크다", "RGB 사진"),

    ("특집 ③ — 이어서",
     "종이 흰색도 색을 바꾼다. 누런 종이에 찍으면 전체가 누렇게 깔린다.\n"
     "프로파일은 그 종이의 흰색을 기준으로 만들어진다. 그래서 종이가 바뀌면 프로파일도 바뀌어야 한다.\n"
     "브랜드 종이는 측정한 공개 프로파일이 없는 경우가 많다. 같은 등급으로 근사할 수밖에 없다.",
     None, None, ""),

    ("인터뷰 — 15년 차 인쇄 감리",
     "오랫만에 현장을 찾았다. 기계 소리가 먼저 반겼다.\n"
     "“제 역활은 사고를 막는 겁니다.” 그는 교정지를 넘기며 말했다. “색이 틀어지면 되돌릴 수 없으니까요.”\n"
     "하루에 몇 번이나 색을 보느냐고 묻자, 세어 본 적 없다고 했다.",
     "press.jpg", "인쇄기 앞에서 교정지를 보는 모습", "맞춤법: 오랫만, 역활(2번째)"),

    ("인터뷰 — 이어서",
     "가장 자주 보는 사고가 무엇이냐고 물었다.\n"
     "“도련을 안 넣고 보내는 거죠. 그리고 폰트를 포함 안 한 파일.”\n"
     "그는 컨텐츠를 만드는 사람일수록 파일 규격을 챙겨야 한다고 했다. 글이 좋아도 파일이 틀리면 못 찍는다.",
     None, None, "맞춤법: 컨텐츠"),

    ("인터뷰 — 마치며",
     "인터뷰를 마치고 나오는데 그가 교정지 한 장을 건넸다.\n"
     "“이거 가져가서 보세요. 어디가 틀렸는지 찾아보시면 재밌을 겁니다.”\n"
     "차에서 펼쳐 보니 글자 하나가 뒤집혀 있었다. 금새 찾았다고 하기엔 한참 걸렸다.",
     None, None, "맞춤법: 금새"),

    ("작업실 탐방 ① 종이 창고 옆",
     "작은 출판사 세 곳을 찾았다. 첫 곳은 종이 창고 옆이었다.\n"
     "책상 위에는 교정지가 쌓여 있었다. 한 편집자는 “솔직이 교정이 제일 오래 걸린다”고 했다.\n"
     "벽에는 종이 견본이 붙어 있었다. 매일 들여다본다고 했다.",
     None, None, "맞춤법: 솔직이"),

    ("작업실 탐방 ② 2층 작업실",
     "두 번째 곳은 2층이었다. 창이 커서 색을 보기 좋다고 했다.\n"
     "“빛이 바뀌면 색도 달라 보여요. 그래서 오전에만 교정을 봅니다.”\n"
     "작업실마다 쓰는 종이가 달랐다. 한 곳은 랑데뷰지를, 다른 곳은 모조지를 고집했다.",
     None, None, ""),

    ("작업실 탐방 ③ 다시 뵈요",
     "세 번째 곳에서는 차를 내주었다.\n"
     "문을 나서며 “다음에 또 뵈요” 하고 인사했다.\n"
     "돌아오는 길에 세 곳의 공통점을 생각했다. 모두 종이를 손으로 만져 보고 골랐다.",
     None, None, "맞춤법: 뵈요"),

    ("독자 질문함 ①",
     "Q. 도련은 꼭 넣어야 하나요?\n"
     "A. 가장자리까지 색이 닿는 디자인이라면 넣어야 합니다. 재단기는 1~2mm 오차가 납니다.\n\n"
     "Q. 폰트는 어떻게 넘기나요?\n"
     "A. PDF로 내보낼 때 포함하거나 글자를 도형으로 바꿉니다. 바꾸면 더 못 고치니 원본은 따로 두세요.",
     None, None, ""),

    ("독자 질문함 ②",
     "Q. 재활용지를 쓰면 색이 어떻게 되나요?\n"
     "A. 종이 바탕이 누런 편이라 전체가 가라앉습니다. 올해 재활용율은 작년보다 올랐지만, "
     "인쇄용으로 쓰는 재활용률은 아직 낮습니다.\n\n"
     "Q. 교정은 몇 번이 적당한가요?\n"
     "A. 정해진 수는 없습니다. 다만 마지막 교정은 반드시 인쇄할 파일 그대로 보세요.",
     None, None, "표기 불일치: 재활용율 vs 재활용률"),

    ("종이 값 비교표",
     "같은 책을 세 종이로 찍어 견적을 받았다. 500부 기준이다.\n\n"
     "아트지 100g: 1,420,000원\n"
     "모조지 100g: 1,180,000원\n"
     "랑데뷰 105g: 1,760,000원\n\n"
     "같은 조건인데 견적서마다 부수가 달리 적혀 있었다. 한 곳은 500부, 다른 곳은 600부로 계산했다.",
     None, None, "수치 불일치: 부수 500/600"),

    ("종이 값 비교표 — 읽는 법",
     "견적은 종이 값만이 아니다. 판 만드는 값, 인쇄 값, 제본 값이 따로 붙는다.\n"
     "부수가 늘면 한 권 값은 떨어진다. 판 값이 나뉘기 때문이다.\n"
     "500부와 1,000부의 차이가 두 배가 아닌 이유가 그것이다. 인쇄 500부 기준으로 다시 받아 보면 안다.",
     None, None, ""),

    ("다음 호 예고",
     "다음 호는 제본을 다룬다. 중철과 무선, 양장의 차이를 손으로 뜯어 보며 비교할 생각이다.\n"
     "제본소 두 곳을 섭외했다. 한 곳은 기계를, 다른 곳은 손 제본을 보여 주기로 했다.\n"
     "질문을 보내 주시면 독자 질문함에 싣겠다.",
     None, None, ""),

    ("닫는 글",
     "이번 호를 만드는 동안에도 고칠 곳이 계속 나왔다.\n"
     "그래서 검수는 마지막이 아니라 과정이라고 적어 둔다.\n"
     "다음 호에서 뵙겠다.",
     None, None, ""),
]


def make_images() -> None:
    """사진을 만든다. 일부러 작게 만든 둘은 해상도 경고가 나와야 한다."""
    import random

    from PIL import Image, ImageDraw

    LINKS.mkdir(parents=True, exist_ok=True)

    def art(w: int, h: int, c1: tuple[int, int, int], c2: tuple[int, int, int], blobs: int, seed: int) -> Image.Image:
        im = Image.new("RGB", (w, h))
        d = ImageDraw.Draw(im)
        for y in range(h):
            t = y / max(1, h - 1)
            d.line([(0, y), (w, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(c1, c2)))
        r = random.Random(seed)
        for _ in range(blobs):
            x, y, rr = r.randrange(w), r.randrange(h), r.randrange(w // 10, max(w // 10 + 1, w // 3))
            d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=tuple(r.randrange(50, 250) for _ in range(3)))
        return im

    art(2480, 3508, (24, 36, 84), (214, 86, 58), 16, 3).save(LINKS / "cover.jpg", quality=92)       # 표지, 300dpi급
    art(1800, 1200, (238, 238, 232), (118, 168, 208), 10, 7).save(LINKS / "paper.jpg", quality=90)  # 넉넉함
    art(1700, 1150, (252, 246, 228), (206, 118, 148), 12, 11).save(LINKS / "press.jpg", quality=90)
    art(300, 200, (255, 228, 118), (198, 58, 58), 6, 13).save(LINKS / "dryer.jpg", quality=80)      # 일부러 저해상
    art(380, 250, (40, 230, 120), (60, 90, 240), 8, 17).save(LINKS / "color.jpg", quality=85)       # 저해상 + 쨍한 RGB


def build() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    make_images()
    idml, pdf = OUT / "jongi-wa-ingk.idml", OUT / "jongi-wa-ingk.pdf"

    with Mcp(read_roots=[OUT], write_roots=[OUT]) as m:
        # 길이는 포인트다. 도련 3mm는 8.5pt — 3을 주면 3pt(=1mm)가 되어 "도련 부족"이 뜬다.
        m.tool("new_document", {"preset": "A4", "margins": 56, "pages": len(PAGES),
                                "facingPages": False, "bleed": 8.504})
        doc = m.tool("inspect_document")

        for i, (title, body, photo, caption, _) in enumerate(PAGES):
            top = 56.0
            if photo:
                img_h = 540.0 if i == 0 else 250.0
                # 표지 사진은 재단선 바깥(도련 3mm ≒ 8.5pt)까지 넘긴다 — 실제 표지가 그렇다
                rect = [-8.5, -8.5, W + 8.5, img_h] if i == 0 else [56, top, 539, top + img_h]
                m.ex("frame.create", spread=i, rect=rect, content="graphic")
                fid = m.tool("inspect_document")["spreads"][i]["items"][-1]["id"]
                m.tool("place_image", {"path": str(LINKS / photo), "frame": fid})
                m.ex("object.fit", mode="fillProportionally")
                top = (img_h + 16) if i == 0 else (top + img_h + 10)
                if caption:
                    r = m.ex("frame.create", spread=i, rect=[56, top, 539, top + 16], content="text", text="x")
                    m.tool("set_story_text", {"story": r["story"], "text": caption})
                    m.ex("text.select", story=r["story"], anchor=0, focus=len(caption.encode()))
                    m.ex("type.char", fontFamily=KR, size=8.5)
                    top += 24

            # 제목 — 10쪽은 일부러 오른쪽으로 밀어 재단선을 넘긴다(페이지 밖으로 나간 글)
            x1 = 760 if i == 9 else 539
            r = m.ex("frame.create", spread=i, rect=[56, top, x1, top + 46], content="text", text="x")
            m.tool("set_story_text", {"story": r["story"], "text": title})
            m.ex("text.select", story=r["story"], anchor=0, focus=len(title.encode()))
            m.ex("type.char", fontFamily=KR, size=26 if i == 0 else 18)
            m.ex("type.para", hyphenate=False)
            top += 56

            # 본문 — 16쪽은 틀을 일부러 짧게 잡아 글이 넘치게 한다(overset)
            bottom = top + 70 if i == 15 else 770
            r = m.ex("frame.create", spread=i, rect=[56, top, 539, bottom], content="text", text="x")
            m.tool("set_story_text", {"story": r["story"], "text": body})
            m.ex("text.select", story=r["story"], anchor=0, focus=len(body.encode()))
            m.ex("type.char", fontFamily=KR, size=11, leading={"kind": "points", "value": 18.5})
            m.ex("type.para", hyphenate=False)

            if i:  # 쪽번호 — 18쪽은 재단선에 바싹 붙여 안전 영역을 침범시킨다
                y = 826 if i == 17 else 790
                r = m.ex("frame.create", spread=i, rect=[56, y, 539, y + 14], content="text", text="x")
                m.tool("set_story_text", {"story": r["story"], "text": str(i + 1)})
                m.ex("text.select", story=r["story"], anchor=0, focus=len(str(i + 1).encode()))
                m.ex("type.char", fontFamily=KR, size=8.5)

        # 19쪽에 빈 텍스트 프레임 하나(편집하다 남긴 빈 틀 — preflight가 잡는다)
        m.ex("frame.create", spread=18, rect=[56, 700, 300, 740], content="text")

        m.ex("file.exportIdml", path=str(idml))
        # 도련을 넣어 내보낸다. 안 넣으면 모든 쪽이 "도련 부족"으로 뜨는데, 그건 이 자료가
        # 보여 주려는 오류가 아니다(쪽마다 같은 경고가 스무 번 나와 정작 심은 것이 묻힌다).
        m.ex("file.exportPdf", path=str(pdf), bleed=True)
        pf = m.ex("preflight.run", minPpi=150)
        doc = m.tool("inspect_document")

    from collections import Counter
    kinds = Counter(i["kind"] for i in pf.get("issues", []))
    print(f"{doc['pageCount']}쪽 · 글 덩어리 {len(doc['stories'])}")
    print("원본 검사(preflight):", dict(kinds) or "문제 없음")
    for it in pf.get("issues", []):
        print(f"   [{it['severity']}] {it['kind']} 쪽={it.get('page')}: {it['message'][:70]}")

    planted = [f"- {i + 1}쪽: {p[4]}" for i, p in enumerate(PAGES) if p[4]]
    (OUT / "README.md").write_text(
        "# 계간 종이와 잉크 — 시험용 잡지 20쪽\n\n"
        "PrintGuard가 잡아내는 오류를 일부러 심은 자료입니다. `samples/build_magazine.py`로 다시 만들 수 있습니다.\n\n"
        "## 이 폴더를 통째로 올리세요\n\n"
        "IDML은 사진을 **링크로만** 들고 있습니다. `jongi-wa-ingk.idml` 하나만 올리면 사진이 따라오지 않아\n"
        "‘끊긴 이미지 링크’가 뜹니다. `Links/`가 같이 있어야 그대로 열립니다.\n\n"
        "```\n"
        "jongi-wa-ingk/\n"
        "  jongi-wa-ingk.idml    편집 파일 — 원본 수정 화면에 올립니다\n"
        "  jongi-wa-ingk.pdf     검수용 PDF — 인쇄 검수 화면에 올립니다\n"
        "  Links/                사진 5장\n"
        "```\n\n"
        "## 돌려 보는 순서\n\n"
        "1. **인쇄 검수**에 `jongi-wa-ingk.pdf`를 올립니다(완성 크기 A4, 도련 3mm, 후가공 중철·무선 제본).\n"
        "2. 결과에서 **교정 목록 복사**를 누릅니다.\n"
        "3. **원본 수정**에서 이 폴더를 통째로 올리고, 복사한 글을 붙여 넣고 반영합니다.\n"
        "4. 고친 PDF를 다시 검수하면 맞춤법 지적이 사라집니다.\n\n"
        "## 심어 둔 것\n\n" + "\n".join(planted) + "\n\n"
        "그 밖에 저해상 사진 2장(6·7쪽), 쨍한 RGB 사진(7쪽), 빈 텍스트 프레임(19쪽),\n"
        "재단선을 넘어간 제목(10쪽), 재단선에 붙은 쪽번호(18쪽), 넘친 글(16쪽)이 들어 있습니다.\n",
        encoding="utf-8")
    print(f"\n만든 곳: {OUT}")
    for p in sorted(OUT.rglob("*")):
        if p.is_file():
            print(f"  {p.relative_to(OUT)}  {p.stat().st_size:,}B")


if __name__ == "__main__":
    build()
