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
- mcp_status     : MCP가 연결되는지, 도구가 몇 개인지 (read)
- inspect_source : 원본을 열어 쪽·스토리·preflight를 보고, 검수용 PDF를 뽑는다 (read)
- apply_fixes    : 교정 목록을 반영하고 PDF/IDML로 내보낸다 (A — safety를 거친다)

교정을 반영할 때 **바이트 오프셋을 미리 모아 두지 않는다.** 한 건 고칠 때마다 다시 찾는다. 한글은
글자당 3바이트라 앞을 고치면 뒤가 전부 밀리는데, 다시 찾으면 밀린 위치가 저절로 따라온다.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
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
    "description": "DesignCraft MCP로 인디자인 원본(IDML/INDD)을 열어 검수 교정을 반영하고 PDF로 내보낸다. PDF 자체는 편집하지 않는다.",
    "url": "http://127.0.0.1:8709",
    "skills": [
        {"id": "mcp_status", "description": "DesignCraft MCP 연결 상태와 사용 가능한 도구 목록", "grade": "read",
         "allowed_requesters": ["orchestrator", "mcp"],
         "input_schema": {}, "output_schema": {"available": "boolean", "version": "string?", "tools": "string[]"}},
        {"id": "inspect_source", "description": "원본(IDML/INDD)을 열어 쪽·스토리·preflight를 보고 검수용 PDF를 뽑는다", "grade": "read",
         "allowed_requesters": ["orchestrator", "report", "mcp"],
         "input_schema": {"src_ref": "sha256", "filename": "string"},
         "output_schema": {"pages": "number", "stories": "[]", "preflight": "Issue[]", "missing_fonts": "string[]",
                           "pdf_ref": "sha256"}},
        {"id": "apply_fixes", "description": "교정 목록을 원본에 반영하고 PDF로 내보낸다(파일 쓰기는 safety를 거친다)", "grade": "A",
         "allowed_requesters": ["orchestrator"],
         "input_schema": {"src_ref": "sha256", "filename": "string",
                          "fixes": "[{page?: number(1부터), original: string, suggestion: string, key?: string}]"},
         "output_schema": {"applied": "[]", "failed": "[]", "pdf_ref": "sha256", "source_out": "고친 편집 파일 이름",
                           "shots": "[{page, before, after}] 바뀐 쪽의 전후 그림"}},
    ],
})


# ---------- 공통 ----------
def _src_path(src_ref: str, filename: str) -> tuple[Path, str]:
    """저장해 둔 원본의 경로와 확장자. 확장자가 중요하다 — DesignCraft가 이걸로 가져오기 방식을 고른다."""
    ext = Path(filename or "").suffix.lower()
    if ext in REFUSED:
        raise ValueError(REFUSED[ext])
    if ext not in OPENABLE:
        raise ValueError(f"열 수 없는 형식입니다: {ext or '(확장자 없음)'} — {', '.join(sorted(OPENABLE))}만 됩니다")
    p = SRC / f"{src_ref}{ext}"
    if not p.exists():
        raise FileNotFoundError("올린 원본을 찾을 수 없습니다(다시 올려 주세요)")
    return p, ext


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
    with Mcp(read_roots=[src.parent, out], write_roots=[out]) as m:
        warn = _open(m, src, ext)
        doc = m.tool("inspect_document")
        pf = m.ex("preflight.run", minPpi=150) or {}
        issues = pf.get("issues", [])
        pages = _story_pages(doc)
        stories = [{"id": s["id"], "length": s.get("length", 0), "overset": bool(s.get("overset")),
                    "pages": sorted(pages.get(s["id"], [])), "preview": (s.get("preview") or "")[:80]}
                   for s in doc.get("stories", [])]
        pdf = out / "inspect.pdf"
        m.ex("file.exportPdf", path=str(pdf))
        png = out / "page1.png"
        m.tool("export_png", {"page": 0, "path": str(png), "scale": 1.0})
    return {
        "pages": doc.get("pageCount", 0),
        "stories": stories,
        "preflight": [{"severity": i.get("severity"), "kind": i.get("kind"), "message": i.get("message"),
                       "page": (i["page"] + 1) if isinstance(i.get("page"), int) else None} for i in issues],
        "missing_fonts": sorted({i["message"].split(": ", 1)[-1] for i in issues if i.get("kind") == "missingFont"}),
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
                                         + (f", 없는 글꼴 {len(r['missing_fonts'])}개" if r["missing_fonts"] else "")}}


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
    with Mcp(read_roots=[src.parent, out], write_roots=[out]) as m:
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
    return {"applied": applied, "failed": failed, "pdf_path": str(pdf), "source_out": source_out,
            "shots": [{"page": p, "before": f"before_p{p}.png", "after": f"after_p{p}.png"} for p in shot_pages],
            "shots_total": want_total,
            "preflight_after": [{"severity": i.get("severity"), "kind": i.get("kind"), "message": i.get("message"),
                                 "page": (i["page"] + 1) if isinstance(i.get("page"), int) else None}
                                for i in pf.get("issues", [])]}


async def apply_fixes(req: AgentRequest) -> dict[str, Any]:
    fixes = req.input.get("fixes") or []
    if not isinstance(fixes, list) or not fixes:  # 파일을 들추기 전에 싼 검사부터
        return {"status": "rejected", "outcome": "INVALID_INPUT", "output": {"message": "반영할 교정이 없습니다"}}
    src_ref, filename = str(req.input.get("src_ref") or ""), str(req.input.get("filename") or "")
    src, ext = _src_path(src_ref, filename)

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


app = create_agent_app(CARD, {"mcp_status": mcp_status, "inspect_source": inspect_source, "apply_fixes": apply_fixes})
