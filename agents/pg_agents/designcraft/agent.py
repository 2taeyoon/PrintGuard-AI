"""designcraft 에이전트(:8709) — 인디자인 원본을 열어 보고, 검수 교정을 반영해 PDF로 내보낸다.

**PDF는 편집하지 않는다.** DesignCraft에서 PDF는 배치만 되고 글자를 집을 수 없다(editable vectors 미지원).
고칠 수 있는 것은 원본 편집 파일뿐이다.

| 포맷 | 열기 | 내보내기 |
|---|---|---|
| `.idml` | O | O |
| `.designcraft` | O | O |
| `.indd` / `.indt` | **받지 않는다** | — |

INDD는 엔진이 읽을 수는 있다(indd-utils가 IDML로 바꿔 준다). 그래도 받지 않기로 했다. **INDD로는
되돌려 주지 못하기 때문**이다 — 고친 결과를 PDF와 IDML로만 줄 수 있어서, 올린 사람은 자기 작업
파일을 못 돌려받는다. 반쪽만 되는 것을 되는 것처럼 두면 올려 보고 나서야 알게 된다.
InDesign에서 **IDML로 내보내서(파일 → 다른 이름으로 저장 → InDesign Markup) 올리면** 된다.

skill
- mcp_status      : MCP가 연결되는지, 도구가 몇 개인지 (read)
- inspect_source  : 원본을 열어 쪽·스토리·preflight를 보고, 검수용 PDF를 뽑는다 (read)
- apply_fixes     : 교정 목록을 반영하고 PDF/IDML로 내보낸다 (A — 묻고 나서, safety를 거친다)
- create_document : 새 문서(빈 판형·샘플)를 만들어 IDML로 내보낸다 (A — safety를 거친다)
- list_commands   : 엔진이 받는 명령 전부(547개)와 인자 설명 (read)
- edit_document   : 만든 문서에 엔진 명령을 적용한다 (A — safety를 거친다)

**인디자인이 하는 일 전부가 `edit_document`로 온다.** 판형만 잡아 주는 것이 아니다 — 글상자·도형·선·
사진·표·쪽·스타일·색·목차·QR·XML·데이터 병합까지 엔진의 547개 명령이 그대로 열려 있다. 우리가 명령을
골라 담는 대신 **문서를 다시 열어 명령을 얹고 저장하는 일**만 맡는다. 그래서 할 수 있는 일의 범위는
우리 코드가 아니라 엔진이 정한다 — 엔진이 늘면 이 앱도 같이 는다.

파일 접근은 `--automation-*-root`가 막는다. 명령을 열어 줘도 **그 폴더 밖은 읽지도 쓰지도 못한다** —
명령 하나하나를 고르는 것보다 이 울타리가 확실하다(`script.run`도 엔진 명령줄만 돌린다).

**검수 흐름 안에 있다.** 편집 파일로 의뢰가 들어오면 오케스트레이터의 plan 마지막 단계가 이
에이전트다 — 검수가 끝나고 교정 제안이 있으면 "원본에 바로 반영할까요?"를 묻고, 그렇다고 하면
고쳐서 내보낸다. PDF로 들어온 의뢰에서는 이 단계가 아예 서지 않는다(고칠 원본이 없다).

교정을 반영할 때 **바이트 오프셋을 미리 모아 두지 않는다.** 한 건 고칠 때마다 다시 찾는다. 한글은
글자당 3바이트라 앞을 고치면 뒤가 전부 밀리는데, 다시 찾으면 밀린 위치가 저절로 따라온다.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import time
from pathlib import Path
from typing import Any

from ..client import call_agent
from ..config import DC_OUT, SRC
from ..contracts import AgentCard, AgentRequest, TaskStatus
from ..server import create_agent_app
from .mcp_client import Mcp, McpError, probe

NAME = "designcraft"
# 열 수 있는 원본. PDF는 일부러 뺐다 — 열려도 글자를 못 고치므로 받아 두면 거짓 기대만 준다.
OPENABLE = {".idml": "file.openIdml", ".designcraft": "file.open"}
# 받지는 않지만 왜 안 받는지는 말해 줘야 한다. 그냥 "열 수 없는 형식"이라고만 하면 IDML로 바꾸면
# 된다는 것을 모른다.
REFUSED = {
    ".indd": "INDD는 받지 않습니다 — 고친 결과를 INDD로 돌려드릴 수 없어서입니다. "
             "InDesign에서 파일 → 다른 이름으로 저장 → InDesign Markup(IDML)으로 내보내 올려 주세요.",
    ".indt": "INDT는 받지 않습니다 — 고친 결과를 INDT로 돌려드릴 수 없어서입니다. IDML로 내보내 올려 주세요.",
    ".pdf": "PDF는 고칠 수 없습니다 — DesignCraft에서 PDF는 배치만 되고 글자를 집을 수 없습니다.",
}

CARD = AgentCard.model_validate({
    "name": NAME,
    "description": "DesignCraft MCP로 편집 파일(IDML)을 열어 검수 교정을 반영하고 PDF로 내보낸다. PDF와 INDD는 받지 않는다.",
    "url": "http://127.0.0.1:8709",
    "skills": [
        {"id": "mcp_status", "description": "DesignCraft MCP 연결 상태와 사용 가능한 도구 목록", "grade": "read",
         "allowed_requesters": ["orchestrator", "mcp"],
         "input_schema": {}, "output_schema": {"available": "boolean", "version": "string?", "tools": "string[]"}},
        {"id": "inspect_source", "description": "편집 파일(IDML)을 열어 쪽·스토리·preflight를 보고 검수용 PDF를 뽑는다", "grade": "read",
         "allowed_requesters": ["orchestrator", "report", "mcp"],
         "input_schema": {"src_ref": "sha256", "filename": "string"},
         "output_schema": {"pages": "number", "stories": "[]", "preflight": "Issue[]", "pdf_ref": "sha256",
                           "fonts": "[{family, style, status: ok|missing|substituted, resolved, chars, source}]",
                           "missing_fonts": "string[] 이 PC에 없어 대체해서 그린 글꼴",
                           "glyph_blocked": "string[] 글꼴에 그 글자가 없어 PDF에 찍히지 않은 곳",
                           "document_fonts": "number 올린 패키지의 Document Fonts/에서 실려 온 글꼴 수",
                           "trust": "{text_readable, layout_faithful} 미리보기를 어디까지 믿을 수 있는가"}},
        {"id": "apply_fixes", "description": "교정 목록을 원본에 반영하고 PDF로 내보낸다(묻고 나서 고치며, 파일 쓰기는 safety를 거친다)", "grade": "A",
         "allowed_requesters": ["orchestrator"],
         "input_schema": {"src_ref": "sha256", "filename": "string", "confirm": "yes | no (없으면 사용자에게 묻는다)",
                          "fixes": "[{page?: number(1부터), original: string, suggestion: string, key?: string}]"},
         "output_schema": {"applied": "[]", "failed": "[]", "pdf_ref": "sha256", "source_out": "고친 편집 파일 이름",
                           "shots": "[{page, before, after}] 바뀐 쪽의 전후 그림",
                           "fonts": "[]", "missing_fonts": "string[]", "trust": "{}"}},
        {"id": "list_commands", "description": "DesignCraft 엔진이 받는 명령 전부(547개)와 각 명령의 인자 설명", "grade": "read",
         "allowed_requesters": ["orchestrator", "mcp"],
         "input_schema": {}, "output_schema": {"commands": "[{id, label, menu, params, enabled}]", "count": "number"}},
        {"id": "edit_document", "description": "만든 문서에 엔진 명령을 적용한다 — 인디자인이 하는 일 전부가 여기로 온다(파일 쓰기는 safety를 거친다)", "grade": "A",
         "allowed_requesters": ["orchestrator"],
         "input_schema": {"src_ref": "sha256", "filename": "string",
                          "commands": "[{command: 'frame.create' 같은 엔진 명령 id, params: {}}]",
                          "undo": "boolean? 참이면 명령 대신 바로 앞 단계로 되돌린다"},
         "output_schema": {"ok": "boolean", "applied": "[]", "failed": "{command, reason}?", "pages": "number",
                           "preflight": "Issue[]", "pdf_ref": "sha256", "shots": "[쪽 그림 파일 이름]",
                           "can_undo": "boolean"}},
        {"id": "create_document", "description": "새 문서(빈 판형 또는 샘플)를 만들어 IDML·PDF로 내보낸다(파일 쓰기는 safety를 거친다)", "grade": "A",
         "allowed_requesters": ["orchestrator"],
         "input_schema": {"start": "blank | sample", "width_mm": "number", "height_mm": "number", "pages": "number",
                          "facing": "boolean", "columns": "number", "gutter_mm": "number", "margin_mm": "number",
                          "bleed_mm": "number", "text": "string? 첫 글상자에 넣을 글"},
         "output_schema": {"src_ref": "sha256", "doc": "만든 IDML의 이름", "pages": "number", "width_mm": "number",
                           "height_mm": "number"}},
    ],
})


# ---------- 공통 ----------
def _src_path(src_ref: str, filename: str) -> tuple[Path, str]:
    """올린 것 안의 문서 경로와 확장자.

    업로드는 파일 하나든 폴더째든 **SRC/<토큰>/ 폴더 하나로** 풀려 있다. `filename`은 그 안에서의
    상대 경로다(`Links/`나 `Document Fonts/`가 옆에 있으면 DesignCraft가 알아서 읽는다).
    확장자가 중요하다 — DesignCraft가 이걸로 가져오기 방식을 고른다.
    """
    ext = Path(filename or "").suffix.lower()
    if ext in REFUSED:
        raise ValueError(REFUSED[ext])
    if ext not in OPENABLE:
        raise ValueError(f"열 수 없는 형식입니다: {ext or '(확장자 없음)'} — {', '.join(sorted(OPENABLE))}만 됩니다")
    root = (SRC / src_ref).resolve()
    p = (root / filename).resolve()
    if root not in p.parents and p != root:   # 토큰 폴더 밖은 열지 않는다
        raise ValueError("올린 폴더 밖의 파일은 열지 않습니다")
    if not p.is_file():
        p = SRC / f"{src_ref}{ext}"           # 옛 방식(파일 하나를 sha 이름으로 둔 것)도 받아 준다
    if not p.is_file():
        raise FileNotFoundError("올린 원본을 찾을 수 없습니다(다시 올려 주세요)")
    return p, ext


def _pkg_root(src: Path) -> Path:
    """읽기를 열어 줄 폴더. 올린 묶음의 뿌리(SRC/<토큰>)까지 열어야 `Links/`와 `Document Fonts/`가
    닿는다 — 문서가 하위 폴더에 들어 있는 패키지가 흔하다. SRC 자체(남의 업로드까지)는 열지 않는다."""
    p = src.parent.resolve()
    root = SRC.resolve()
    while p.parent != root and root in p.parents:
        p = p.parent
    return p


def _job_dir(context_id: str) -> Path:
    d = DC_OUT / context_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _story_pages(doc: dict[str, Any]) -> dict[int, set[int]]:
    """스토리 → 그 스토리가 놓인 쪽 번호(1부터). 교정이 가리키는 쪽과 맞춰 보려고 쓴다.

    아이템은 **중첩된다**(그룹 안에 프레임). 자식의 bounds는 부모 기준이라 그대로 쓰면 엉뚱한
    자리가 나온다. 그래서 쪽은 **최상위 조상의 bounds로 한 번만** 정하고 그 아래는 전부 물려받는다.
    그룹이 두 쪽에 걸치는 일은 드물고, 걸쳐도 교정 위치를 가리는 데는 지장이 없다.

    한 스프레드에 여러 쪽이 있을 수 있어서(맞쪽) 최상위 프레임 가운데 x가 든 쪽을 그 쪽으로 본다.
    """
    item_page: dict[int, int] = {}

    def walk(it: dict[str, Any], page: int) -> None:
        if isinstance(it.get("id"), int):
            item_page[it["id"]] = page
        for ch in it.get("children") or []:
            walk(ch, page)

    for sp in doc.get("spreads", []):
        pages = sp.get("pages", [])
        if not pages:
            continue
        for it in sp.get("items", []):
            b = it.get("bounds") or []
            cx = (b[0] + b[2]) / 2 if len(b) == 4 else None
            hit = pages[0]
            if cx is not None:
                hit = next((p for p in pages
                            if (p.get("bounds") or [0, 0, 0, 0])[0] <= cx <= (p.get("bounds") or [0, 0, 0, 0])[2]), pages[0])
            walk(it, int(hit.get("index", 0)) + 1)  # 사람이 읽는 쪽 번호는 1부터
    return {s["id"]: {item_page[f] for f in s.get("frames", []) if f in item_page} for s in doc.get("stories", [])}


def _open(m: Mcp, path: Path, ext: str) -> dict[str, Any]:
    """원본을 연다. INDD는 변환 경고가 같이 오므로 그대로 올려 보낸다(숨기면 왜 이상한지 알 수 없다)."""
    r = m.ex(OPENABLE[ext], path=str(path))
    return r if isinstance(r, dict) else {}


# ---------- 글꼴 ----------
# 글꼴은 **파일에 담겨 오지 않는다.** IDML은 "윤명조 330"처럼 **이름으로만** 가리키고, 그 이름을
# 실제 글자꼴로 바꾸는 일은 파일을 여는 쪽 PC가 한다. 서버에 세상의 글꼴을 다 깔아 둘 수는 없고,
# 상용 글꼴을 깔아 두고 남의 파일에 쓰는 것은 라이선스 문제이기도 하다.
#
# 그래서 **글꼴이 없으면 어떻게 되는지**를 정확히 알고 정확히 말해야 한다. 두 가지가 전혀 다르다.
#
#   1. 글꼴이 아예 없다(`missing`) — 엔진이 비슷한 것으로 **대체해서** 그린다. 글자는 다 보이고
#      PDF에서 뽑히기도 한다(없는 글자는 폴백 글꼴이 그려 준다). 교정은 멀쩡하게 돈다.
#      다만 글자 너비가 달라 **줄바꿈이 밀린다** — 넘친 글·쪽 배분 수치는 원본의 것이 아니다.
#   2. 글꼴은 있는데 그 글자가 없다(`missingGlyphs`) — 네모로 찍힌다. **PDF에 글자가 남지 않아서**
#      교정이 아무것도 읽지 못한다. 그대로 두면 "고칠 것 없음"이라는 거짓 결과가 나온다.
#      이건 대체로 원본 자체의 흠이다(한글을 라틴 전용 글꼴로 짠 경우).
#
# **고치는 쪽은 글꼴을 건드리지 않는다.** 우리는 글자만 바꾸므로 내보낸 IDML에는 원래 글꼴 이름이
# 그대로 남고, 그 글꼴이 있는 PC(올린 사람의 인디자인)에서 열면 원본대로 보인다. 그래서
# `font.replace`는 **우리가 만든 새 문서에서만** 쓴다(아래 `_create_blocking`). 남의 문서에 쓰면
# 되돌릴 수 없게 조판을 바꿔 놓는 것이다.
#
# 글꼴을 받을 길은 **인디자인의 파일 → 패키지**다. 그 폴더의 `Document Fonts/`를 DesignCraft가
# 문서를 열 때 먼저 읽는다(깔지 않고 그 자리에서만). 폴더째 올리면 1번이 사라진다.
def _fonts(m: Mcp) -> list[dict[str, Any]]:
    """문서가 쓰는 글꼴과 그 처지. preflight 메시지를 긁는 것보다 정확하다 — 무엇으로 대체됐는지,
    몇 글자가 걸렸는지, 어디서 온 글꼴인지가 들어 있다."""
    try:
        rows = m.ex("font.list") or []
    except McpError:
        return []
    out: list[dict[str, Any]] = []
    for f in rows if isinstance(rows, list) else []:
        missing = bool(f.get("missing"))
        status = "missing" if missing else ("substituted" if f.get("matchStatus") == "styleSubstitute" else "ok")
        out.append({
            "family": f.get("family"), "style": f.get("style"), "status": status,
            "resolved": f.get("resolvedFamily"), "resolved_style": f.get("resolvedStyle"),
            "chars": int(f.get("characters") or 0),
            # bundled | installed | document(패키지에서 실려 온 것) | added. 없으면 null.
            "source": f.get("source"),
            "restricted_licence": bool(f.get("restrictedLicence")),
        })
    return out


def _font_summary(fonts: list[dict[str, Any]], issues: list[dict[str, Any]]) -> dict[str, Any]:
    """화면과 보고서가 같은 말을 하도록, 글꼴 상태를 한 덩어리로 정리한다.

    `trust`가 핵심이다. 수치를 지우지 않고 **어디까지 믿을 수 있는지**를 같이 낸다 — 글꼴이
    대체되면 줄바꿈이 달라지므로, 넘친 글을 그대로 '원본의 문제'라고 말할 수 없다.
    """
    missing = [f for f in fonts if f["status"] == "missing"]
    substituted = [f for f in fonts if f["status"] == "substituted"]
    blocked = sorted({i.get("message", "").split(": ", 1)[0].replace("Missing glyphs in ", "")
                      for i in issues if i.get("kind") == "missingGlyphs"})
    return {
        "fonts": fonts,
        # 옛 이름 그대로 둔다 — 이걸 보는 화면이 이미 있다
        "missing_fonts": sorted({str(f["family"]) for f in missing}),
        "substituted_styles": sorted({f"{f['family']} {f['style']}" for f in substituted}),
        "document_fonts": sum(1 for f in fonts if f["source"] == "document"),
        "glyph_blocked": blocked,
        "trust": {
            # 글은 글꼴과 무관하다 — 네모로 찍히는 경우만 빼고
            "text_readable": not blocked,
            # 줄바꿈·넘침은 글꼴이 바뀌면 같이 바뀐다
            "layout_faithful": not missing and not substituted,
        },
    }


def _sha_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        while blk := f.read(1 << 20):
            h.update(blk)
    return h.hexdigest()


# ---------- skill ----------
async def mcp_status(_: AgentRequest) -> dict[str, Any]:
    info = await asyncio.to_thread(probe)
    ok = bool(info.get("available"))
    return {"status": "completed", "output": info,
            "evidence": {"queries": [], "data_summary": f"MCP {'연결됨' if ok else '연결 안 됨'}"
                         + (f", 도구 {len(info.get('tools', []))}개" if ok else f" — {info.get('reason', '')}"), "ref_ids": []}}


def _inspect_blocking(src: Path, ext: str, out: Path) -> dict[str, Any]:
    # 읽기는 원본이 있는 폴더와 작업 폴더만, 쓰기는 작업 폴더만. 원본 폴더까지 쓰기로 열면
    # 교정이 올린 파일 자체를 덮어쓸 수 있다 — 되돌릴 것이 없어진다.
    with Mcp(read_roots=[_pkg_root(src), out], write_roots=[out]) as m:
        warn = _open(m, src, ext)
        doc = m.tool("inspect_document")
        pf = m.ex("preflight.run", minPpi=150) or {}
        issues = pf.get("issues", [])
        pages = _story_pages(doc)
        stories = [{"id": s["id"], "length": s.get("length", 0), "overset": bool(s.get("overset")),
                    "pages": sorted(pages.get(s["id"], [])), "preview": (s.get("preview") or "")[:80]}
                   for s in doc.get("stories", [])]
        fonts = _fonts(m)
        pdf = out / "inspect.pdf"
        m.ex("file.exportPdf", path=str(pdf))
        png = out / "page1.png"
        m.tool("export_png", {"page": 0, "path": str(png), "scale": 1.0})
    return {
        "pages": doc.get("pageCount", 0),
        "stories": stories,
        "preflight": [{"severity": i.get("severity"), "kind": i.get("kind"), "message": i.get("message"),
                       "page": (i["page"] + 1) if isinstance(i.get("page"), int) else None} for i in issues],
        **_font_summary(fonts, issues),
        # 문서가 품은 글자 수. PDF에서 뽑힌 글이 이보다 턱없이 적으면 글꼴이 글자를 막은 것이다.
        "text_chars": sum(int(s.get("length") or 0) for s in doc.get("stories", [])),
        "open_warnings": (warn.get("warnings") or [])[:20],
        "paragraph_styles": len(doc.get("paragraphStyles", [])),
        "swatches": len(doc.get("swatches", [])),
        "pdf_path": str(pdf), "png": png.name,
    }


async def inspect_source(req: AgentRequest) -> dict[str, Any]:
    src, ext = _src_path(str(req.input.get("src_ref") or ""), str(req.input.get("filename") or ""))
    out = _job_dir(req.meta.context_id)
    r = await asyncio.to_thread(_inspect_blocking, src, ext, out)
    pdf = Path(r.pop("pdf_path"))
    r["pdf_ref"] = await asyncio.to_thread(_store_pdf, pdf)
    errs = sum(1 for i in r["preflight"] if i["severity"] == "error")
    return {"status": "completed", "output": r,
            "evidence": {"queries": [], "ref_ids": [r["pdf_ref"][:12]],
                         "data_summary": f"{r['pages']}쪽, 스토리 {len(r['stories'])}개, preflight 오류 {errs}건"
                                         + (f", 없는 글꼴 {len(r['missing_fonts'])}개(대체해서 열었습니다 — "
                                            "줄바꿈이 원본과 다릅니다)" if r["missing_fonts"] else "")
                                         + (f", 글꼴에 없는 글자 {len(r['glyph_blocked'])}곳"
                                            "(그 글자는 PDF에 찍히지 않아 교정이 읽지 못합니다)"
                                            if r["glyph_blocked"] else "")
                                         + (f", 패키지 글꼴 {r['document_fonts']}개를 그대로 썼습니다"
                                            if r["document_fonts"] else "")}}


def _store_pdf(p: Path) -> str:
    """뽑은 PDF를 기존 PDF 보관소에 sha256 이름으로 둔다 — 그래야 기존 검수가 그대로 받아 쓴다."""
    from ..config import STORE, ensure_dirs
    ensure_dirs()
    sha = _sha_file(p)
    shutil.copyfile(p, STORE / f"{sha}.pdf")
    return sha


MAX_SHOTS = max(1, int(os.environ.get("PG_DESIGNCRAFT_MAX_SHOTS", "4")))


def _target_pages(m: Mcp, fixes: list[dict[str, Any]], pages: dict[int, set[int]], page_count: int) -> tuple[list[int], int]:
    """교정이 닿을 쪽을 미리 가늠한다. '수정 전' 그림은 고치기 전에 찍어야 하는데, 어느 쪽이
    바뀔지는 찾아봐야 알기 때문이다. 쪽 번호가 적힌 교정은 그대로 믿고, 없으면 한 번 찾아 본다.
    100쪽짜리를 전부 찍을 수는 없으니 앞의 몇 쪽만 찍고 나머지는 수를 알려 준다.

    **문서에 없는 쪽은 버린다.** 붙여넣은 목록의 쪽 번호는 사람이 손으로 고칠 수 있고 다른 판본에서
    온 것일 수도 있다. 그대로 그리려 들면 없는 쪽이라고 오류가 나면서 교정 전체가 날아간다.
    (그 교정 자체는 뒤에서 '그 쪽에는 없습니다'로 따로 걸러진다.)
    """
    want: set[int] = set()
    for f in fixes:
        p = f.get("page")
        if isinstance(p, int) and 1 <= p <= page_count:
            want.add(p)
            continue
        if isinstance(p, int):
            continue  # 문서 밖 쪽 번호 — 그림은 건너뛴다
        try:
            ms = m.ex("find.find", find=str(f.get("original") or ""), caseSensitive=True)
        except McpError:
            continue
        for hit in ms if isinstance(ms, list) else []:
            want |= {x for x in pages.get(hit.get("story"), set()) if 1 <= x <= page_count}
    ordered = sorted(want) or [1]
    return ordered[:MAX_SHOTS], len(ordered)


def _shot(m: Mcp, page: int, path: Path) -> bool:
    """그림 한 장. 실패해도 교정 작업을 멈추지 않는다 — 비교 그림은 거들 뿐이고,
    고친 결과(PDF)가 본체다."""
    try:
        m.tool("export_png", {"page": page - 1, "path": str(path), "scale": 1.0})
        return True
    except McpError:
        return False


def _apply_blocking(src: Path, ext: str, out: Path, fixes: list[dict[str, Any]]) -> dict[str, Any]:
    applied: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    with Mcp(read_roots=[_pkg_root(src), out], write_roots=[out]) as m:
        _open(m, src, ext)
        doc = m.tool("inspect_document")
        pages = _story_pages(doc)
        shot_pages, want_total = _target_pages(m, fixes, pages, int(doc.get("pageCount") or 1))
        shot_pages = [p for p in shot_pages if _shot(m, p, out / f"before_p{p}.png")]

        for f in fixes:
            orig, sug = str(f.get("original") or ""), str(f.get("suggestion") or "")
            want = f.get("page")
            note = {"key": f.get("key"), "page": want, "original": orig, "suggestion": sug}
            if not orig:
                failed.append({**note, "reason": "원문이 비어 있습니다"})
                continue
            if orig == sug:
                failed.append({**note, "reason": "원문과 고칠 내용이 같습니다"})
                continue
            try:
                # 한 건마다 다시 찾는다 — 앞 교정으로 뒤 오프셋이 밀려도 알아서 따라온다
                ms = m.ex("find.find", find=orig, caseSensitive=True)
            except McpError as e:
                failed.append({**note, "reason": f"찾기 실패: {e}"[:200]})
                continue
            ms = ms if isinstance(ms, list) else []
            cands = [x for x in ms if not isinstance(want, int) or want in pages.get(x.get("story"), set())]
            if not cands:
                failed.append({**note, "reason": "원문을 찾지 못했습니다"
                               + (f"(문서 전체에는 {len(ms)}군데 있지만 {want}쪽에는 없습니다)" if ms else "")})
                continue
            if len(cands) > 1:
                failed.append({**note, "reason": f"같은 문구가 {len(cands)}군데 있어 어느 것인지 가릴 수 없습니다"})
                continue
            hit = cands[0]
            if hit.get("cell") is not None:
                failed.append({**note, "reason": "표 안의 글자입니다(아직 표는 건드리지 않습니다)"})
                continue
            try:
                m.ex("story.replaceRange", story=hit["story"], start=hit["start"], end=hit["end"], text=sug)
            except McpError as e:
                failed.append({**note, "reason": f"고치기 실패: {e}"[:200]})
                continue
            applied.append({**note, "story": hit["story"], "at": [hit["start"], hit["end"]]})

        shot_pages = [p for p in shot_pages if _shot(m, p, out / f"after_p{p}.png")]
        pdf = out / "fixed.pdf"
        m.ex("file.exportPdf", path=str(pdf))
        # 받는 형식은 둘 다 같은 형식으로 돌려준다
        s = out / ("fixed.idml" if ext == ".idml" else "fixed.designcraft")
        m.ex("file.exportIdml" if ext == ".idml" else "file.saveAs", path=str(s))
        source_out = s.name
        # 고친 뒤 남은 문제도 알려 준다(교정이 넘침을 새로 만들었을 수 있다)
        pf = m.ex("preflight.run", minPpi=150) or {}
        # 글꼴은 **건드리지 않았다.** 그래도 상태를 같이 내보낸다 — 내려받은 PDF가 원본과 다르게
        # 보이는 이유를 그 자리에서 알 수 있어야 하기 때문이다.
        fonts = _fonts(m)
    return {"applied": applied, "failed": failed, "pdf_path": str(pdf), "source_out": source_out,
            **_font_summary(fonts, pf.get("issues", [])),
            "shots": [{"page": p, "before": f"before_p{p}.png", "after": f"after_p{p}.png"} for p in shot_pages],
            "shots_total": want_total,
            "preflight_after": [{"severity": i.get("severity"), "kind": i.get("kind"), "message": i.get("message"),
                                 "page": (i["page"] + 1) if isinstance(i.get("page"), int) else None}
                                for i in pf.get("issues", [])]}


def _ask_first(fixes: list[dict[str, Any]], filename: str) -> dict[str, Any]:
    """고치기 전에 묻는다. **원본을 바꾸는 일이라 되돌릴 수 없다** — 검수를 맡겼다고 해서
    원본을 고쳐도 된다는 뜻은 아니다. 무엇을 고치는지 앞의 몇 건을 그대로 보여 준다."""
    sample = "  ·  ".join(f"{f.get('original')} → {f.get('suggestion')}" for f in fixes[:3])
    return {"status": "input-required", "reason_code": "customer_input", "output": {},
            "question": {
                "field": "apply_fixes",
                "text": f"교정 {len(fixes)}건을 원본({filename})에 바로 반영할까요?",
                "why": f"{sample}{' 외 ' + str(len(fixes) - 3) + '건' if len(fixes) > 3 else ''} — "
                       "올린 원본은 그대로 두고 고친 사본을 PDF와 IDML로 내려 드립니다. "
                       "찾지 못했거나 같은 문구가 여러 군데인 교정은 건너뛰고 이유를 적습니다.",
                "options": [
                    {"value": "yes", "label": "원본 고치기", "hint": "DesignCraft가 글자를 찾아 바꾸고 다시 내보냅니다"},
                    {"value": "no", "label": "검수만 하기", "hint": "교정 목록은 결과에 그대로 남습니다"},
                ]}}


async def apply_fixes(req: AgentRequest) -> dict[str, Any]:
    fixes = req.input.get("fixes") or []
    if not isinstance(fixes, list) or not fixes:  # 파일을 들추기 전에 싼 검사부터
        return {"status": "rejected", "outcome": "INVALID_INPUT", "output": {"message": "반영할 교정이 없습니다"}}
    src_ref, filename = str(req.input.get("src_ref") or ""), str(req.input.get("filename") or "")
    src, ext = _src_path(src_ref, filename)

    # 묻는 일을 부르는 쪽에 맡기지 않는다. 고치는 것은 이 에이전트이므로 승낙도 이 에이전트가 받는다.
    # 사람이 직접 '반영' 단추를 누른 길(앱의 원본 수정)은 confirm을 들고 온다.
    want = str(req.input.get("confirm") or "")
    if want not in ("yes", "no"):
        return _ask_first(fixes, Path(filename).name)
    if want == "no":
        return {"status": "completed", "outcome": "skipped",
                "output": {"skipped": True, "applied": [], "failed": [], "asked": len(fixes)},
                "evidence": {"queries": [], "ref_ids": [], "data_summary": f"교정 {len(fixes)}건을 반영하지 않기로 했습니다"}}

    # 파일을 쓰는 행동이므로 safety를 거친다(A 등급). 닿지 못하면 거절한다(fail-closed).
    key = "designcraft:" + hashlib.sha256(f"{req.meta.context_id}|{src_ref}|{len(fixes)}".encode()).hexdigest()[:20]
    gate = await call_agent("safety", AgentRequest(
        meta=req.meta.model_copy(update={"idempotency_key": key}), skill="execute",
        input={"action": "designcraft.apply_fixes", "idempotency_key": key,
               "params": {"context_id": req.meta.context_id, "fixes": len(fixes), "ext": ext}}))
    d = gate.output if gate.status == TaskStatus.COMPLETED else None
    if not d or d.get("decision") != "executed":
        return {"status": "rejected", "outcome": "SAFETY_REJECTED",
                "output": {"reason": (d or {}).get("reason", "safety에 닿지 못해 거절(fail-closed)")}}

    out = _job_dir(req.meta.context_id)
    r = await asyncio.to_thread(_apply_blocking, src, ext, out, fixes)
    r["pdf_ref"] = await asyncio.to_thread(_store_pdf, Path(r.pop("pdf_path")))
    r["decision"] = d
    n, bad = len(r["applied"]), len(r["failed"])
    return {"status": "completed" if not bad else "completed", "outcome": "partial" if bad else None, "output": r,
            "evidence": {"queries": [], "ref_ids": [d["execution_id"], r["pdf_ref"][:12]],
                         "data_summary": f"교정 {n + bad}건 중 {n}건 반영, {bad}건 실패"}}


# ---------- 엔진 명령 ----------
# **인디자인이 하는 일 전부를 여기로 들인다.** 우리가 "글상자·도형·표"를 하나씩 코드로 감싸면
# 감싼 것만 할 수 있는 앱이 된다. 엔진은 547개를 받으므로 그 목록을 그대로 내주고, 받은 명령을
# 그대로 얹는다. 할 수 있는 일의 범위를 우리 코드가 아니라 엔진이 정하게 하는 쪽이 맞다.
#
# 파일 접근은 `--automation-*-root`가 막는다. 명령을 열어 줘도 **그 폴더 밖은 읽지도 쓰지도
# 못한다** — 명령을 하나하나 고르는 것보다 이 울타리가 확실하다(`script.run`도 엔진 명령줄만 돈다).
MAX_EDIT_CMDS = max(1, int(os.environ.get("PG_DESIGNCRAFT_MAX_CMDS", "40")))
MAX_PREVIEW_PAGES = max(1, int(os.environ.get("PG_DESIGNCRAFT_PREVIEW_PAGES", "8")))


def _commands_blocking() -> dict[str, Any]:
    DC_OUT.mkdir(parents=True, exist_ok=True)
    with Mcp(read_roots=[DC_OUT], write_roots=[DC_OUT]) as m:
        r = m.tool("list_commands")
    rows = (r or {}).get("commands") if isinstance(r, dict) else r
    rows = rows if isinstance(rows, list) else []
    return {"commands": [{"id": c.get("id"), "label": c.get("label"), "menu": c.get("menu") or [],
                          "params": c.get("params") or "", "enabled": bool(c.get("enabled"))}
                         for c in rows if c.get("id")],
            "count": len(rows)}


async def list_commands(_: AgentRequest) -> dict[str, Any]:
    r = await asyncio.to_thread(_commands_blocking)
    return {"status": "completed", "output": r,
            "evidence": {"queries": [], "ref_ids": [], "data_summary": f"엔진 명령 {r['count']}개"}}


def _state(m: Mcp, out: Path) -> dict[str, Any]:
    """고친 뒤의 모습. 쪽수·글꼴·preflight와 쪽 그림, 그리고 내려받을 PDF."""
    doc = m.tool("inspect_document")
    pf = m.ex("preflight.run", minPpi=150) or {}
    issues = pf.get("issues", [])
    pages = int(doc.get("pageCount") or 0)
    pdf = out / "doc.pdf"
    m.ex("file.exportPdf", path=str(pdf))
    shots: list[str] = []
    for i in range(min(pages, MAX_PREVIEW_PAGES)):
        name = f"page{i + 1}.png"
        if _shot(m, i + 1, out / name):
            shots.append(name)
    return {
        "pages": pages,
        "shots": shots,
        "items": sum(len(sp.get("items") or []) for sp in doc.get("spreads") or []),
        "stories": len(doc.get("stories") or []),
        "preflight": [{"severity": i.get("severity"), "kind": i.get("kind"), "message": i.get("message"),
                       "page": (i["page"] + 1) if isinstance(i.get("page"), int) else None} for i in issues],
        **_font_summary(_fonts(m), issues),
        "pdf_path": str(pdf),
    }


def _edit_blocking(src: Path, ext: str, out: Path, cmds: list[dict[str, Any]]) -> dict[str, Any]:
    """명령을 얹고, **전부 됐을 때만** 저장한다.

    중간에 하나가 실패하면 아무것도 저장하지 않는다. 절반만 들어간 문서를 돌려주면 무엇이
    들어갔는지 사람이 알 수 없고, 되돌릴 자리도 흐려진다.

    되돌릴 자리(`undo`)는 **파이썬이** 만든다. MCP에는 문서가 있는 폴더 쓰기를 열지 않기
    때문이다 — 고친 결과를 제자리에 돌려 놓는 일도 파이썬이 한다(울타리는 그대로 둔다).
    """
    undo = out / f"undo{ext}"
    shutil.copyfile(src, undo)
    with Mcp(read_roots=[_pkg_root(src), out], write_roots=[out]) as m:
        _open(m, src, ext)
        applied: list[dict[str, Any]] = []
        for n, c in enumerate(cmds):
            cmd, params = str(c.get("command") or ""), c.get("params") or {}
            try:
                res = m.ex(cmd, **params)
            except McpError as e:
                return {"ok": False, "applied": applied,
                        "failed": {"command": cmd, "reason": str(e)[:400], "not_run": len(cmds) - n - 1},
                        "can_undo": undo.is_file()}
            applied.append({"command": cmd, "result": res if isinstance(res, dict) else None})
        work = out / f"work{ext}"
        m.ex("file.exportIdml" if ext == ".idml" else "file.saveAs", path=str(work))
        state = _state(m, out)
    shutil.copyfile(work, src)      # 고친 문서를 제자리로
    return {"ok": True, "applied": applied, "failed": None, "can_undo": True, **state}


def _undo_blocking(src: Path, ext: str, out: Path) -> dict[str, Any]:
    """바로 앞 단계로 되돌린다. **한 단계만** 간다 — 되돌린 자리를 지워 두 번 눌러도
    더 과거로 가지 않게 한다(어디까지 돌아갔는지 모르는 것이 더 무섭다)."""
    undo = out / f"undo{ext}"
    if not undo.is_file():
        raise FileNotFoundError("되돌릴 단계가 없습니다")
    shutil.copyfile(undo, src)
    with Mcp(read_roots=[_pkg_root(src), out], write_roots=[out]) as m:
        _open(m, src, ext)
        state = _state(m, out)
    undo.unlink(missing_ok=True)
    return {"ok": True, "applied": [], "failed": None, "undone": True, "can_undo": False, **state}


async def edit_document(req: AgentRequest) -> dict[str, Any]:
    src_ref, filename = str(req.input.get("src_ref") or ""), str(req.input.get("filename") or "")
    undo = bool(req.input.get("undo"))
    cmds = req.input.get("commands") or []
    if not undo:
        if not isinstance(cmds, list) or not cmds:
            return {"status": "rejected", "outcome": "INVALID_INPUT", "output": {"message": "적용할 명령이 없습니다"}}
        if len(cmds) > MAX_EDIT_CMDS:
            return {"status": "rejected", "outcome": "INVALID_INPUT",
                    "output": {"message": f"한 번에 {MAX_EDIT_CMDS}개까지만 받습니다(받은 것 {len(cmds)}개)"}}
        for c in cmds:
            if not isinstance(c, dict) or not str(c.get("command") or "").strip():
                return {"status": "rejected", "outcome": "INVALID_INPUT",
                        "output": {"message": "명령은 {command, params} 모양이어야 합니다"}}
            if c.get("params") is not None and not isinstance(c.get("params"), dict):
                return {"status": "rejected", "outcome": "INVALID_INPUT",
                        "output": {"message": f"{c.get('command')}의 params가 묶음(JSON 객체)이 아닙니다"}}
    src, ext = _src_path(src_ref, filename)

    # 파일을 쓰는 행동이므로 safety를 거친다(A 등급). 닿지 못하면 거절한다(fail-closed).
    # 되돌리기도 같은 skill이다. 행동 이름을 따로 지어 내면 safety가 카드에서 그 skill을 못 찾아
    # 거절한다('레지스트리에 없는 행동') — 등급은 카드에서 오고, 카드에 없는 이름은 등급이 없다.
    what = "designcraft.edit_document"
    # 열쇠에 시각을 섞는다. 이 화면에서는 **똑같은 명령을 일부러 여러 번** 쓴다(같은 글상자를 둘
    # 넣는 일). 시각이 없으면 두 번째가 첫 번째의 결정을 그대로 물려받아, 기록에는 한 건만 남는다.
    shape = json.dumps(cmds, sort_keys=True, default=str, ensure_ascii=False)
    key = "designcraft:" + hashlib.sha256(
        f"{req.meta.context_id}|{src_ref}|{what}|{undo}|{shape}|{time.time():.3f}".encode()).hexdigest()[:20]
    gate = await call_agent("safety", AgentRequest(
        meta=req.meta.model_copy(update={"idempotency_key": key}), skill="execute",
        input={"action": what, "idempotency_key": key,
               "params": {"context_id": req.meta.context_id, "commands": len(cmds), "ext": ext, "undo": undo}}))
    d = gate.output if gate.status == TaskStatus.COMPLETED else None
    if not d or d.get("decision") != "executed":
        return {"status": "rejected", "outcome": "SAFETY_REJECTED",
                "output": {"reason": (d or {}).get("reason", "safety에 닿지 못해 거절(fail-closed)")}}

    out = _job_dir(req.meta.context_id)
    r = (await asyncio.to_thread(_undo_blocking, src, ext, out) if undo
         else await asyncio.to_thread(_edit_blocking, src, ext, out, cmds))
    if p := r.pop("pdf_path", None):
        r["pdf_ref"] = await asyncio.to_thread(_store_pdf, Path(p))
    r["decision"] = d
    if not r["ok"]:
        return {"status": "completed", "outcome": "failed", "output": r,
                "evidence": {"queries": [], "ref_ids": [d["execution_id"]],
                             "data_summary": f"{r['failed']['command']}에서 멈춤 — 아무것도 저장하지 않았습니다"}}
    summary = "바로 앞 단계로 되돌렸습니다" if undo else f"명령 {len(r['applied'])}개 적용"
    return {"status": "completed", "output": r,
            "evidence": {"queries": [], "ref_ids": [d["execution_id"], (r.get("pdf_ref") or "")[:12]],
                         "data_summary": f"{summary}, {r['pages']}쪽"}}


# ---------- 새 문서 만들기 ----------
# 검수·수정은 '남이 만든 파일'을 받는 일이다. 그런데 원본이 아예 없는 사람도 있다. 그 사람에게
# "인디자인에서 먼저 만들어 오세요"라고 하면 거기서 끝난다. DesignCraft는 문서를 만들 수도 있으므로,
# 만드는 자리를 열어 두고 **만든 그 파일을 그대로 검수·수정으로 넘긴다**(앱의 '작업 만들기').
MM = 72 / 25.4          # 1mm는 몇 pt인가. DesignCraft의 길이는 전부 pt다
MAX_NEW_PAGES = max(1, int(os.environ.get("PG_DESIGNCRAFT_MAX_PAGES", "64")))
# 새 문서의 기본 글꼴(Source Serif 4)에는 **한글이 없다.** 그대로 두면 넣은 글이 PDF에 한 자도
# 찍히지 않고 preflight에 '없는 글자'만 쌓인다. 한글이 섞여 있으면 글꼴을 바꿔 준다.
KO_FONT = os.environ.get("PG_DESIGNCRAFT_KO_FONT", "Malgun Gothic")
DEFAULT_FONT = "Source Serif 4"


def _has_hangul(s: str) -> bool:
    return any("가" <= c <= "힣" or "ㄱ" <= c <= "ㆎ" for c in s)


def _pt(mm: float) -> float:
    return round(float(mm) * MM, 3)


def _clamp(v: Any, lo: float, hi: float, default: float) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return min(hi, max(lo, f))


def _create_blocking(out: Path, dest: Path, spec: dict[str, Any]) -> dict[str, Any]:
    """새 문서를 만들어 IDML로 내보낸다. 쓰기는 작업 폴더와 원본 보관 폴더 둘뿐이다."""
    sample = str(spec.get("start") or "blank") == "sample"
    with Mcp(read_roots=[out, dest.parent], write_roots=[out, dest.parent]) as m:
        if sample:
            # DesignCraft가 들고 있는 다쪽 잡지 견본. 판형·단·사진·스타일이 이미 짜여 있어서
            # 빈 문서보다 '잡지를 만든다'에 가깝다. 크기는 견본이 정한 값을 그대로 쓴다.
            m.ex("file.newSample")
        else:
            margin = _pt(spec.get("margin_mm", 15))
            m.ex("file.new", intent="print", units="points",
                 width=_pt(spec["width_mm"]), height=_pt(spec["height_mm"]), pages=int(spec["pages"]),
                 facingPages=bool(spec.get("facing", True)), columns=int(spec.get("columns", 1)),
                 gutter=_pt(spec.get("gutter_mm", 5)), margins=margin, bleed=_pt(spec.get("bleed_mm", 3)),
                 # **기본 글상자(primaryTextFrame)는 쓰지 않는다.** 그 글상자에 글을 넣으면 글이 차지하지
                 # 않은 쪽이 저절로 지워진다(스마트 텍스트 리플로우). 3쪽을 달라고 해서 1쪽을 받는 셈인데,
                 # 쪽수는 사람이 정한 값이라 글의 양이 줄여서는 안 된다. 글은 아래에서 직접 만든 상자에 넣는다.
                 primaryTextFrame=False)
        doc = m.tool("inspect_document")
        text = str(spec.get("text") or "").strip()[:4000]
        if text and not sample:
            page = (doc.get("spreads") or [{}])[0].get("pages") or [{}]
            b = page[0].get("bounds") or [0, 0, _pt(spec["width_mm"]), _pt(spec["height_mm"])]
            mg = _pt(spec.get("margin_mm", 15))
            m.ex("frame.create", spread=0, rect=[b[0] + mg, b[1] + mg, b[2] - mg, b[3] - mg],
                 content="text", text=text)
            # 기본 글꼴에는 한글이 없다. 바꾸지 못해도 문서는 만들어 준다 — preflight가 '없는 글자'로 알린다.
            if _has_hangul(text):
                try:
                    m.ex("font.replace", family=DEFAULT_FONT, toFamily=KO_FONT)
                except McpError:
                    pass
            doc = m.tool("inspect_document")
        idml = out / "new.idml"
        m.ex("file.exportIdml", path=str(idml))
        st = doc.get("settings") or {}
    shutil.copyfile(idml, dest)
    return {"pages": int(doc.get("pageCount") or 1),
            "width_mm": round(float(st.get("pageWidth") or 0) / MM, 1),
            "height_mm": round(float(st.get("pageHeight") or 0) / MM, 1),
            "stories": len(doc.get("stories") or []), "sample": sample}


async def create_document(req: AgentRequest) -> dict[str, Any]:
    spec = {
        "start": "sample" if str(req.input.get("start") or "") == "sample" else "blank",
        "width_mm": _clamp(req.input.get("width_mm"), 10, 2000, 148),
        "height_mm": _clamp(req.input.get("height_mm"), 10, 2000, 210),
        "pages": int(_clamp(req.input.get("pages"), 1, MAX_NEW_PAGES, 4)),
        "facing": bool(req.input.get("facing", True)),
        "columns": int(_clamp(req.input.get("columns"), 1, 10, 1)),
        "gutter_mm": _clamp(req.input.get("gutter_mm"), 0, 50, 5),
        "margin_mm": _clamp(req.input.get("margin_mm"), 0, 100, 15),
        "bleed_mm": _clamp(req.input.get("bleed_mm"), 0, 20, 3),
        "text": str(req.input.get("text") or ""),
    }
    # 파일을 쓰는 행동이라 apply_fixes와 같은 관문을 지난다. 닿지 못하면 거절한다(fail-closed).
    key = "designcraft:" + hashlib.sha256(f"new|{req.meta.context_id}|{spec['start']}".encode()).hexdigest()[:20]
    gate = await call_agent("safety", AgentRequest(
        meta=req.meta.model_copy(update={"idempotency_key": key}), skill="execute",
        input={"action": "designcraft.create_document", "idempotency_key": key,
               "params": {"context_id": req.meta.context_id, "start": spec["start"], "pages": spec["pages"]}}))
    d = gate.output if gate.status == TaskStatus.COMPLETED else None
    if not d or d.get("decision") != "executed":
        return {"status": "rejected", "outcome": "SAFETY_REJECTED",
                "output": {"reason": (d or {}).get("reason", "safety에 닿지 못해 거절(fail-closed)")}}

    # 만든 파일은 **올린 원본과 같은 자리**(SRC/<토큰>)에 둔다. 그래야 검수도 수정도
    # 올린 파일과 똑같은 길로 흐른다 — 만든 것이라고 따로 다루지 않는다.
    src_ref = hashlib.sha256(f"{req.meta.context_id}|{key}".encode()).hexdigest()[:16]
    doc_name = "샘플 잡지.idml" if spec["start"] == "sample" else "새 문서.idml"
    root = SRC / src_ref
    root.mkdir(parents=True, exist_ok=True)
    out = _job_dir(req.meta.context_id)
    r = await asyncio.to_thread(_create_blocking, out, root / doc_name, spec)
    r |= {"src_ref": src_ref, "doc": doc_name, "decision": d}
    return {"status": "completed", "output": r,
            "evidence": {"queries": [], "ref_ids": [d["execution_id"]],
                         "data_summary": f"{'샘플 잡지' if r['sample'] else '빈 문서'} {r['pages']}쪽"
                                         f"({r['width_mm']:.0f}×{r['height_mm']:.0f}mm)을 만들었습니다"}}


app = create_agent_app(CARD, {"mcp_status": mcp_status, "inspect_source": inspect_source, "apply_fixes": apply_fixes,
                              "create_document": create_document,
                                "list_commands": list_commands, "edit_document": edit_document})
