"""엔진이 영어로 적어 주는 검사 결과를 **우리말로** 옮긴다.

화면은 종류(`kind`)만 우리말로 적고 있었다. 그 옆에 붙는 설명은 엔진이 적은 영어 그대로라
'없는 글자(글리프) — Missing glyphs in Malgun Gothic Regular: ✦'처럼 반쪽만 우리말이었다.
인쇄소에 넘길 사람이 읽는 줄이고, 읽는 사람 대부분은 한국에서 인쇄를 맡기는 사람이다.

**규칙으로 옮긴다.** 이 문장들은 엔진(Rust) 안에 박힌 **정해진 꼴** 열한 가지뿐이라
(`crates/engine/src/cmd/preflight.rs`), 옮길 것이 글꼴 이름·파일 이름·숫자를 끼운 빈칸이다.
그런 자리에 LLM을 세우면 같은 입력에 다른 답이 나오고, 글꼴 이름("Nanum Myeongjo Ghost")을
'나눔명조 고스트'로 옮겨 버리면 **그 이름으로 찾아야 하는 사람이 못 찾는다.**

모르는 꼴은 **영어 그대로 둔다.** 엔진이 새 종류를 내기 시작했을 때, 우리가 아는 꼴로 우겨
넣는 것보다 낯선 영어 한 줄이 낫다 — 적어도 무엇이 걸렸는지는 읽을 수 있다.
"""
from __future__ import annotations

import re
from typing import Any, Callable

# 사람 이름·파일 이름·글꼴 이름은 **건드리지 않는다.** 괄호 안 숫자도 그대로 둔다.
_RULES: list[tuple[re.Pattern[str], Callable[[re.Match[str]], str]]] = [
    # Overset text: 69 characters
    (re.compile(r"^Overset text: (\d+) characters$"),
     lambda m: f"글상자 밖으로 넘친 글 {m[1]}자 — 넘친 글은 인쇄되지 않습니다"),
    # Unplaced story: 120 characters have no text frame
    (re.compile(r"^Unplaced story:?\s*(\d+) characters have no text frame$"),
     lambda m: f"글 {m[1]}자가 들어앉을 글상자가 없습니다"),
    # Missing font style: Yoon Myungjo 330 Bold (using Regular)
    (re.compile(r"^Missing font style: (.+?) \(using (.+?)\)$"),
     lambda m: f"없는 글꼴 스타일 {m[1]} — {m[2]}(으)로 대신 그렸습니다"),
    # Missing font: Nanum Myeongjo Ghost
    (re.compile(r"^Missing font: (.+)$"),
     lambda m: f"이 PC에 없는 글꼴 {m[1]}"),
    # Missing glyphs in Malgun Gothic Regular: ✦ 𠆢 🖨 and 2 more
    (re.compile(r"^Missing glyphs in (.+?): (.+?)(?: and (\d+) more)?$"),
     lambda m: f"글꼴 {m[1]}에 없는 글자 {m[2]}" + (f" 외 {m[3]}자" if m[3] else "")),
    # Missing link: photo.jpg and 2 more
    (re.compile(r"^Missing link: (.+?)(?: and (\d+) more)?$"),
     lambda m: f"끊긴 이미지 링크 {m[1]}" + (f" 외 {m[2]}개" if m[2] else "")),
    # 9ce5328252c8.jpg: effective 32 ppi (< 150)
    (re.compile(r"^(.+?): effective (\d+) ppi \(< (\d+)\)$"),
     lambda m: f"{m[1]} — 실제 해상도 {m[2]}ppi (인쇄 기준 {m[3]}ppi에 못 미칩니다)"),
    # Empty text frame
    (re.compile(r"^Empty text frame$"), lambda _m: "글이 들어 있지 않은 빈 글상자"),
    # RGB swatch in a print document: WebBlue
    (re.compile(r"^RGB swatch in a print document: (.+)$"),
     lambda m: f"인쇄 문서에 RGB 색 {m[1]} — 인쇄는 CMYK로 찍습니다"),
    # Placed graphic layer visibility overrides are preserved but are not applied to rendering or PDF output
    (re.compile(r"^Placed graphic layer visibility overrides are preserved but are not applied "
                r"to rendering or PDF output$"),
     lambda _m: "앉힌 그림의 레이어 표시 설정은 파일에 그대로 남지만, 미리보기와 PDF에는 반영되지 않습니다"),
    # ── 내보낼 때 엔진이 남기는 말 ── 검사 결과는 아니지만 같은 자리에 같은 말투로 적힌다.
    # PDF/X-4: form fields and media were left out
    (re.compile(r"^(PDF/[\w-]+): form fields and media were left out$"),
     lambda m: f"{m[1]}: 입력 양식과 동영상·소리는 빼고 내보냈습니다 — 이 규격이 담지 못합니다"),
    # PDF/X-4: the XMP metadata date couldn't be added
    (re.compile(r"^(PDF/[\w-]+): the XMP metadata date couldn't be added$"),
     lambda m: f"{m[1]}: 만든 날짜(XMP)를 적지 못했습니다"),
    # PDF/X-4: RGB fills or strokes on page 4: under a CMYK output intent RGB needs an ICC profile
    (re.compile(r"^(PDF/[\w-]+): RGB fills or strokes on page (\d+): "
                r"under a CMYK output intent RGB needs an ICC profile$"),
     lambda m: f"{m[1]}: {m[2]}쪽에 RGB 색이 그대로 있습니다 — CMYK 출력 의도에서는 "
               f"RGB에 ICC 프로파일이 있어야 합니다"),
    # PDF/X-1a: the transparency flattener failed: …
    (re.compile(r"^(PDF/[\w-]+): the transparency flattener failed: (.+)$"),
     lambda m: f"{m[1]}: 투명을 눌러 없애지 못했습니다 — {m[2]}"),
]


def ko(message: Any) -> str:
    """검사 결과 한 줄을 우리말로. 아는 꼴이 없으면 받은 그대로 돌려준다."""
    s = str(message or "").strip()
    for pat, say in _RULES:
        if m := pat.match(s):
            return say(m)
    return s


def rows(issues: Any) -> list[dict[str, Any]]:
    """엔진이 준 검사 결과를 화면·보고서가 쓰는 모양으로. 쪽 번호는 **1부터** 센다.

    세 자리(열어 보기·고친 뒤·만든 뒤)가 같은 모양을 만들어야 한다. 한 곳에서만 우리말로
    옮기면 어떤 화면에서는 영어가 그대로 보인다.
    """
    out: list[dict[str, Any]] = []
    for i in issues if isinstance(issues, list) else []:
        page = i.get("page")
        out.append({"severity": i.get("severity"), "kind": i.get("kind"), "message": ko(i.get("message")),
                    "page": (page + 1) if isinstance(page, int) else None})
    return out
