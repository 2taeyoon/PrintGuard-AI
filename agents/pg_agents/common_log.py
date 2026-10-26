"""공통 로그: 모든 A2A 요청·결과를 한 줄씩 SQLite에 남긴다(앱의 '에이전트 소통' 탭의 원천).
payload에는 skill·상태·결과 코드·ID만 담고, 입력 본문·untrusted·판단 문장은 넣지 않는다.
Node 에이전트(frontend/agents/lib/agent.ts)도 같은 파일·같은 표에 쓴다."""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import UTC, datetime
from typing import Any

from .config import LOG_DB, ensure_dirs

_lock = threading.Lock()
SCHEMA = """CREATE TABLE IF NOT EXISTS common_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, context_id TEXT NOT NULL, kind TEXT NOT NULL,
  source TEXT NOT NULL, requester TEXT, skill TEXT, status TEXT, outcome TEXT, grade TEXT, payload TEXT)"""


def _conn() -> sqlite3.Connection:
    ensure_dirs()
    c = sqlite3.connect(LOG_DB, timeout=5)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute(SCHEMA)
    return c


def log_event(context_id: str, kind: str, *, source: str, requester: str | None = None, skill: str | None = None,
              status: str | None = None, outcome: str | None = None, grade: str | None = None,
              payload: dict[str, Any] | None = None) -> None:
    """로그 쓰기가 실패해도 요청 처리는 멈추지 않는다."""
    try:
        with _lock, _conn() as c:
            c.execute("INSERT INTO common_log(at,context_id,kind,source,requester,skill,status,outcome,grade,payload) VALUES (?,?,?,?,?,?,?,?,?,?)",
                      (datetime.now(UTC).isoformat(timespec="milliseconds"), context_id, kind, source, requester, skill, status, outcome, grade,
                       json.dumps(payload or {}, ensure_ascii=False)))
    except Exception:  # noqa: BLE001
        pass


def query(context_id: str | None = None, limit: int = 300) -> list[dict[str, Any]]:
    with _conn() as c:
        c.row_factory = sqlite3.Row
        if context_id:
            rows = c.execute("SELECT * FROM common_log WHERE context_id=? ORDER BY id DESC LIMIT ?", (context_id, limit)).fetchall()
        else:
            rows = c.execute("SELECT * FROM common_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    out = [dict(r) | {"payload": json.loads(r["payload"] or "{}")} for r in rows]
    return list(reversed(out))
