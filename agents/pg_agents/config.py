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
    "orchestrator": 8700, "safety": 8701, "preflight": 8702, "color": 8703, "guide": 8704,
    "paper": 8705, "proofread": 8706, "shop": 8707, "report": 8708,
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


ENV_FILES = (ROOT / "agents" / ".env", ROOT / ".env")  # 둘 다 .gitignore에 있다. 보기는 agents/.env.example


def load_env_files(paths: tuple[Path, ...] = ENV_FILES) -> list[str]:
    """`.env`의 KEY=VALUE를 환경변수로 올린다(이미 설정된 값은 건드리지 않는다 — 터미널에서 준 값이 이긴다).

    `#` 주석과 빈 줄은 넘기고, 따옴표로 감싼 값은 벗긴다. 값을 화면에 찍지 않는다(키가 로그에 남지 않게).
    읽은 파일 목록을 돌려준다. 파일이 없으면 아무 일도 하지 않는다(선택 기능이라 없는 것이 정상).
    """
    read: list[str] = []
    for p in paths:
        try:
            text = p.read_text(encoding="utf-8")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k, v = k.strip().removeprefix("export ").strip(), v.strip()
            if len(v) > 1 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            if k and k not in os.environ:
                os.environ[k] = v
        read.append(str(p))
    return read
