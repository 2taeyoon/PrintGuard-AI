"""MCP 클라이언트용 토큰을 발급한다 — 에이전트를 돌리는 PC에서 사람이 직접 실행한다.

    cd agents
    python -m pg_agents.mktoken --label claude-desktop --days 90
    python -m pg_agents.mktoken --label cursor --days 30 --write

**언제 필요한가.** MCP 서버가 오케스트레이터와 **같은 PC**에 있으면 필요 없다 — 그때는
서명 비밀 파일을 직접 읽을 수 있으니 MCP 서버가 자기 토큰을 스스로 만든다(그 파일을 읽을
수 있다는 것 자체가 이 PC의 주인이라는 뜻이다). 토큰을 손으로 발급하는 것은 **다른 PC**의
클라이언트가 터널을 넘어 들어올 때다.

발급한 값은 **다시 볼 수 없다**(서버가 저장하지 않는다 — 서명만 맞으면 통한다). 잃으면 다시
발급하면 되고, 한꺼번에 무효로 만들려면 데이터 폴더의 `auth_secret`을 지우면 된다.
"""
from __future__ import annotations

import argparse
import sys

from .auth import SECRET_FILE, mint
from .config import ensure_dirs, load_env_files


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m pg_agents.mktoken", description="MCP 클라이언트용 토큰 발급")
    p.add_argument("--label", default="mcp", help="사람이 알아보기 위한 이름(권한과 무관). 예: claude-desktop")
    p.add_argument("--days", type=float, default=90, help="유효 기간(일). 기본 90")
    p.add_argument("--write", action="store_true",
                   help="상태를 바꾸는 일(보고서 작성)까지 허용한다. 없으면 조회만 된다")
    a = p.parse_args(argv)
    if a.days <= 0:
        print("--days는 0보다 커야 합니다", file=sys.stderr)
        return 2

    load_env_files()
    ensure_dirs()
    token = mint("mcp", hours=a.days * 24, write=a.write, label=a.label)

    print(f"\n라벨 {a.label} · {a.days:g}일 · 권한 {'조회+쓰기' if a.write else '조회만'}")
    print("이 값은 다시 볼 수 없습니다. 지금 옮겨 두세요.\n")
    print(token)
    print(f"\n등록 예(그 클라이언트가 있는 PC에서):\n"
          f"  claude mcp add printguard --env PG_TOKEN={token} \\\n"
          f"    --env PG_ORCHESTRATOR_URL=https://<터널 주소> \\\n"
          f"    -- <dev python> -m pg_agents.mcp_server\n")
    print(f"한꺼번에 무효로 만들려면 {SECRET_FILE} 를 지우고 에이전트를 다시 켜세요.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
