"""포트 표, 에이전트 이름·토큰·주소, 목 모드, 공유 저장소 경로."""
from __future__ import annotations

import os
from contextvars import ContextVar
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # PrintGuard/

ENV_FILES = (ROOT / "agents" / ".env", ROOT / ".env")  # 둘 다 .gitignore에 있다. 보기는 agents/.env.example


def load_env_files(paths: tuple[Path, ...] = ENV_FILES) -> list[str]:
    """`.env`의 KEY=VALUE를 환경변수로 올린다(이미 설정된 값은 건드리지 않는다 — 터미널에서 준 값이 이긴다).

    `#` 주석과 빈 줄은 넘기고, 따옴표로 감싼 값은 벗긴다. 값을 화면에 찍지 않는다(키가 로그에 남지 않게).
    `KEY=`처럼 값이 빈 줄은 설정하지 않는다(앞 파일의 빈 줄이 뒤 파일의 실제 값을 가리지 않게).
    읽은 파일 목록을 돌려준다. 파일이 없으면 아무 일도 하지 않는다(선택 기능이라 없는 것이 정상).

    **시험은 이 PC의 `.env`를 읽지 않는다**(`PG_NO_ENV_FILES=1`, conftest가 세운다). 막는 자리를
    여기 하나로 둔 이유가 있다 — 전에는 `config` 안에서만 막았고, `mcp_server`가 불러오는 순간
    따로 한 번 더 읽었다. 그래서 그 모듈을 들여오는 시험이 돌면 개발자 PC의 열쇠가 환경에 올라오고,
    뒤이어 도는 교정 시험이 **진짜 API를 불렀다**(돈이 나간다). 경로를 직접 준 경우는 읽는다 —
    그건 시험이 만든 임시 파일이고, 읽는 동작 자체를 재는 시험이 있다.
    """
    if paths is ENV_FILES and os.environ.get("PG_NO_ENV_FILES") == "1":
        return []
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
            if k and v and k not in os.environ:
                os.environ[k] = v
        read.append(str(p))
    return read


# **불러오는 순간 `.env`를 읽는다.** 아래 상수들이 `os.environ`을 그 자리에서 읽어 굳기 때문에,
# 읽기를 미루면 늦는다. 전에는 런처(`run_agents.py`)만 읽었고, 그래서
# `python -m pg_agents.orchestrator`로 **하나만 직접 켜면** 설정이 통째로 기본값으로 돌아갔다 —
# CORS가 로컬 전용으로 돌아가 배포된 사이트가 조용히 막혔다(에이전트는 멀쩡히 켜져 있는데).
#
# 테스트는 읽지 않는다(`PG_NO_ENV_FILES=1`, conftest가 세운다). 개발자 PC의 열쇠와 설정이
# 시험 결과를 바꾸면 안 된다 — `GEMINI_API_KEY`가 있으면 진짜 LLM을 부르러 간다.
ENV_LOADED: list[str] = load_env_files()      # 막는 일은 load_env_files 안에서 한다

DATA = Path(os.environ.get("PG_DATA_DIR", ROOT / "agents" / ".data"))
STORE = DATA / "pdf"  # 의뢰한 PDF를 sha256 이름으로 둔다(에이전트끼리는 pdf_ref만 주고받는다)
SRC = DATA / "src"    # 올린 인디자인 원본(IDML/INDD). 확장자를 남긴다 — DesignCraft가 이걸로 가져오기 방식을 고른다
DC_OUT = DATA / "dc"  # 의뢰별 DesignCraft 작업 폴더. MCP를 여기에 가둔다
LOG_DB = Path(os.environ.get("PG_COMMON_LOG_DB", DATA / "common_log.sqlite"))
MAX_PATH_LENGTH = 3

PORTS: dict[str, int] = {
    "orchestrator": 8700, "safety": 8701, "preflight": 8702, "color": 8703, "guide": 8704,
    "paper": 8705, "proofread": 8706, "report": 8708, "designcraft": 8709,
}

# 배포용 설정. 기본값은 로컬 그대로이고, 컨테이너에서는 환경변수로 바꾼다.
HOST = os.environ.get("PG_HOST", "127.0.0.1")           # 컨테이너에서는 0.0.0.0
# 바깥에 열어 주는 창구는 오케스트레이터 하나뿐이다. 호스팅이 정해 주는 포트(PORT)를 따른다.
CORS_ORIGIN_REGEX = os.environ.get("PG_CORS_ORIGIN_REGEX", r"http://(127\.0\.0\.1|localhost):\d+")


def listen_port(name: str) -> int:
    if name == "orchestrator" and os.environ.get("PORT"):
        return int(os.environ["PORT"])
    return PORTS[name]


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
    SRC.mkdir(parents=True, exist_ok=True)
    DC_OUT.mkdir(parents=True, exist_ok=True)
    LOG_DB.parent.mkdir(parents=True, exist_ok=True)


