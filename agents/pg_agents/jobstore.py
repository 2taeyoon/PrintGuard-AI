"""의뢰 목록을 디스크에 남긴다 — **에이전트를 다시 켜도 목록이 그대로 있게.**

지금까지 의뢰(`JOBS`)와 만든 문서(`DCJOBS`)는 메모리에만 있었다. 파일은 작업 폴더에 남는데
목록만 사라져서, 다시 켜고 나면 화면이 비어 있고 **파일이 지워진 것처럼 보였다.** 한나절 만든
것이 화면에서 사라지는 일이라 쓰는 사람에게는 사고와 같다.

소통 기록이 이미 SQLite에 남으므로 **같은 파일에 표 하나를 더 둔다.** 데이터베이스를 따로
세울 일이 아니다 — 늘어나는 것은 설치할 것과 꺼질 것뿐이다.

**무엇을 남기고 무엇을 안 남기나.** 만든 문서는 전부 남긴다(결과물이다). 의뢰는 **끝난 것만**
남긴다 — 돌던 중에 꺼진 의뢰는 되살릴 수 없다. 에이전트 호출이 끊긴 자리와 사람의 답을
기다리던 자리(`pending`)는 함수라서 적어 둘 수도 없고, 적어 둔 척하면 '이어서 하기'를 눌렀을 때
아무 일도 일어나지 않는다. 되살릴 수 없는 것을 목록에 두는 쪽이 더 나쁘다.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any

from .config import LOG_DB, ensure_dirs

_lock = threading.Lock()
SCHEMA = """CREATE TABLE IF NOT EXISTS job_store (
  context_id TEXT PRIMARY KEY, kind TEXT NOT NULL, client TEXT NOT NULL,
  created REAL NOT NULL, saved REAL NOT NULL, body TEXT NOT NULL)"""
INDEX = "CREATE INDEX IF NOT EXISTS job_store_kind ON job_store(kind, created)"


def _conn() -> sqlite3.Connection:
    ensure_dirs()
    c = sqlite3.connect(LOG_DB, timeout=5)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute(SCHEMA)
    c.execute(INDEX)
    return c


def save(kind: str, context_id: str, client: str, created: float, body: dict[str, Any]) -> bool:
    """한 건을 적어 둔다(있으면 덮는다). 적지 못해도 **지금 하던 일은 멈추지 않는다** —
    목록이 안 남는 것과 검수가 안 되는 것 중에서는 앞엣것이 덜 나쁘다. 대신 조용히 넘기지
    않고 한 줄 찍는다(왜 목록이 비는지 아무 데도 안 적히면 아무도 못 고친다)."""
    try:
        with _lock, _conn() as c:
            c.execute("INSERT OR REPLACE INTO job_store(context_id,kind,client,created,saved,body) "
                      "VALUES (?,?,?,?,?,?)",
                      (context_id, kind, client or "", float(created), time.time(),
                       json.dumps(body, ensure_ascii=False, default=str)))
        return True
    except Exception as e:  # noqa: BLE001
        print(f"[jobstore] {kind} {context_id[:16]}을 남기지 못했습니다: {e}", flush=True)
        return False


def load(kind: str, limit: int = 400) -> list[dict[str, Any]]:
    """새것부터 `limit`건. 읽다 깨지면 **빈 목록**이다 — 목록을 못 읽었다고 에이전트가 안 뜨면
    고칠 방법이 없어진다(파일을 지우려 해도 앱이 안 뜬다)."""
    try:
        with _lock, _conn() as c:
            c.row_factory = sqlite3.Row
            rows = c.execute("SELECT * FROM job_store WHERE kind=? ORDER BY created DESC LIMIT ?",
                             (kind, limit)).fetchall()
    except Exception as e:  # noqa: BLE001
        print(f"[jobstore] 목록을 읽지 못했습니다: {e}", flush=True)
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        try:
            body = json.loads(r["body"])
        except json.JSONDecodeError:
            continue                      # 한 줄이 깨졌다고 나머지를 버리지 않는다
        if isinstance(body, dict):
            out.append({"context_id": r["context_id"], "client": r["client"],
                        "created": r["created"], "body": body})
    return list(reversed(out))            # 오래된 것부터 — 메모리 목록이 쌓이는 차례와 같게


def forget(context_id: str) -> int:
    """한 건을 지운다. **조용히 실패하면 안 된다** — 사람이 '지워 달라'고 한 일이라,
    안 지워졌는데 지웠다고 말하는 쪽이 더 나쁘다(common_log.forget과 같은 이유)."""
    with _lock, _conn() as c:
        return int(c.execute("DELETE FROM job_store WHERE context_id=?", (context_id,)).rowcount)


def prune(kind: str, keep: int) -> int:
    """오래된 것부터 버려 `keep`건만 남긴다. 메모리 쪽 한도(MAX_JOBS)와 맞춰 두지 않으면
    디스크만 끝없이 는다."""
    with _lock, _conn() as c:
        return int(c.execute(
            "DELETE FROM job_store WHERE kind=? AND context_id NOT IN "
            "(SELECT context_id FROM job_store WHERE kind=? ORDER BY created DESC LIMIT ?)",
            (kind, kind, max(0, keep))).rowcount)
