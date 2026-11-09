"""의뢰 목록이 **에이전트를 다시 켜도 남아 있는가.**

전에는 메모리에만 있어서 다시 켜면 화면이 비었다. 파일은 작업 폴더에 그대로 있는데 목록만
사라지니, 쓰는 사람에게는 만든 것이 지워진 것으로 보였다. 여기서 보는 것은 셋이다 —
남기는가, 다시 올리는가, 그리고 **올리면 안 되는 것을 안 올리는가.**
"""
from __future__ import annotations

import time

from pg_agents import jobstore
from pg_agents.config import SRC
from pg_agents.orchestrator import app as orch


def _clean(*ctxs: str) -> None:
    for c in ctxs:
        jobstore.forget(c)
        orch.DCJOBS.pop(c, None)
        orch.JOBS.pop(c, None)


def test_a_saved_row_comes_back():
    jobstore.save("dc", "ctx_dc_keep", "me", 1000.0, {"filename": "명함.idml", "pages": 1})
    got = {r["context_id"]: r for r in jobstore.load("dc")}
    assert got["ctx_dc_keep"]["body"]["filename"] == "명함.idml"
    assert got["ctx_dc_keep"]["client"] == "me"
    _clean("ctx_dc_keep")


def test_saving_twice_replaces_instead_of_piling_up():
    """한 의뢰가 걸음마다 다시 저장된다. 쌓이면 다시 켤 때 같은 줄이 여러 번 올라온다."""
    jobstore.save("dc", "ctx_dc_twice", "me", 1000.0, {"pages": 1})
    jobstore.save("dc", "ctx_dc_twice", "me", 1000.0, {"pages": 10})
    rows = [r for r in jobstore.load("dc") if r["context_id"] == "ctx_dc_twice"]
    assert len(rows) == 1 and rows[0]["body"]["pages"] == 10
    _clean("ctx_dc_twice")


def test_forget_removes_one_and_says_how_many():
    jobstore.save("dc", "ctx_dc_bye", "me", 1000.0, {})
    assert jobstore.forget("ctx_dc_bye") == 1
    assert jobstore.forget("ctx_dc_bye") == 0           # 두 번 지워도 터지지 않는다
    assert not [r for r in jobstore.load("dc") if r["context_id"] == "ctx_dc_bye"]


def test_prune_keeps_the_newest():
    """디스크만 끝없이 늘지 않게. 남기는 것은 **새것** 쪽이다."""
    ids = [f"ctx_dc_p{i}" for i in range(5)]
    for i, c in enumerate(ids):
        jobstore.save("dc", c, "me", 2000.0 + i, {"n": i})
    jobstore.prune("dc", 2)
    left = {r["context_id"] for r in jobstore.load("dc")}
    assert "ctx_dc_p4" in left and "ctx_dc_p3" in left
    assert "ctx_dc_p0" not in left and "ctx_dc_p1" not in left
    _clean(*ids)


def test_a_broken_row_does_not_take_the_rest_down():
    """한 줄이 깨졌다고 목록 전체를 버리면, 고치려고 켠 사람도 아무것도 못 본다."""
    jobstore.save("dc", "ctx_dc_okrow", "me", 3000.0, {"filename": "ok.idml"})
    with jobstore._conn() as c:                          # noqa: SLF001 - 일부러 깨뜨린다
        c.execute("INSERT OR REPLACE INTO job_store(context_id,kind,client,created,saved,body) "
                  "VALUES (?,?,?,?,?,?)", ("ctx_dc_badrow", "dc", "me", 3001.0, time.time(), "{깨짐"))
    got = {r["context_id"] for r in jobstore.load("dc")}
    assert "ctx_dc_okrow" in got and "ctx_dc_badrow" not in got
    _clean("ctx_dc_okrow", "ctx_dc_badrow")


# ---------- 다시 켤 때 ----------
def test_restore_brings_a_made_document_back():
    src = "restore0001"
    (SRC / src).mkdir(parents=True, exist_ok=True)
    jobstore.save("dc", "ctx_dc_back", "me", 4000.0,
                  {"client": "me", "src_ref": src, "filename": "표지.idml", "made": True, "created": 4000.0})
    orch.DCJOBS.pop("ctx_dc_back", None)
    orch._restore()                                      # noqa: SLF001
    assert orch.DCJOBS["ctx_dc_back"]["filename"] == "표지.idml"
    _clean("ctx_dc_back")


def test_a_document_whose_source_is_gone_is_left_out():
    """열지도 받지도 못하는 줄이 목록에 남으면, 누르는 사람은 앱이 고장 난 것으로 읽는다."""
    jobstore.save("dc", "ctx_dc_ghost", "me", 4100.0,
                  {"client": "me", "src_ref": "no-such-folder-0001", "filename": "유령.idml"})
    orch.DCJOBS.pop("ctx_dc_ghost", None)
    orch._restore()                                      # noqa: SLF001
    assert "ctx_dc_ghost" not in orch.DCJOBS
    _clean("ctx_dc_ghost")


def test_only_finished_jobs_are_written_down():
    """돌던 중에 꺼진 의뢰는 되살릴 수 없다. 멈춘 자리(`pending`)가 함수라서 적어 둘 수가 없고,
    적어 둔 척하면 다시 켠 뒤 '이어서'를 눌렀을 때 아무 일도 일어나지 않는다."""
    working = orch.Job(context_id="ctx_job_working", idempotency_key="k1", options={}, pdf_ref="a" * 64,
                       filename="a.pdf", status="working", client="me")
    done = orch.Job(context_id="ctx_job_done", idempotency_key="k2", options={}, pdf_ref="b" * 64,
                    filename="b.pdf", status="completed", client="me")
    orch._job_save(working)                              # noqa: SLF001
    orch._job_save(done)                                 # noqa: SLF001
    saved = {r["context_id"] for r in jobstore.load("job")}
    assert "ctx_job_done" in saved and "ctx_job_working" not in saved

    orch.JOBS.pop("ctx_job_done", None)
    orch.BY_KEY.pop("k2", None)
    orch._restore()                                      # noqa: SLF001
    back = orch.JOBS["ctx_job_done"]
    assert back.status == "completed" and back.filename == "b.pdf" and back.client == "me"
    # 멱등성 색인도 같이 돌아와야 한다 — 같은 PDF를 다시 올리면 지난 의뢰를 돌려주는 자리다
    assert orch.BY_KEY.get("k2") == "ctx_job_done"
    orch.BY_KEY.pop("k2", None)
    _clean("ctx_job_done", "ctx_job_working")
