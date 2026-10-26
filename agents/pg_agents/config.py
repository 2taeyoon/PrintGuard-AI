"""포트 표, 에이전트 이름·토큰·주소, 목 모드, 공유 저장소 경로."""
from __future__ import annotations

import os
from contextvars import ContextVar
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # PrintGuard/
DATA = Path(os.environ.get("PG_DATA_DIR", ROOT / "agents" / ".data"))
STORE = DATA / "pdf"  # 의뢰한 PDF를 sha256 이름으로 둔다(에이전트끼리는 pdf_ref만 주고받는다)
LOG_DB = Path(os.environ.get("PG_COMMON_LOG_DB", DATA / "common_log.sqlite"))
MAX_PATH_LENGTH = 3

PORTS: dict[str, int] = {
    "orchestrator": 8100, "safety": 8101, "preflight": 8102, "color": 8103, "guide": 8104,
    "paper": 8105, "proofread": 8106, "shop": 8107, "report": 8108,
}

_name: ContextVar[str] = ContextVar("pg_agent_name", default="anonymous")


def set_agent_name(name: str) -> None:
    _name.set(name)


def get_agent_name() -> str:
    return _name.get()


def is_mock() -> bool:
    """목 모드: 토큰은 `mock:<이름>`, 사람 토큰은 `human:<이름>`. 로컬 시연은 기본으로 켠다."""
    return os.environ.get("PG_MOCK", "1") == "1"


def agent_token(name: str) -> str:
    return f"mock:{name}" if is_mock() else os.environ.get(f"PG_{name.upper()}_TOKEN", "")


def agent_url(target: str) -> str:
    if target.startswith("http"):
        return target.rstrip("/")
    env = os.environ.get(f"PG_{target.upper()}_URL")
    return env.rstrip("/") if env else f"http://127.0.0.1:{PORTS[target]}"


def ensure_dirs() -> None:
    STORE.mkdir(parents=True, exist_ok=True)
    LOG_DB.parent.mkdir(parents=True, exist_ok=True)
