"""PrintGuard 에이전트를 한 번에 켠다(로컬 시연용). Ctrl+C로 모두 끈다.

  python run_agents.py            # 전부
  python run_agents.py guide color # 일부만

Python 에이전트는 `PG_PYTHON`(없으면 런처를 띄운 이 인터프리터)으로, Node 에이전트는 frontend에서
`npx tsx`로 띄운다. 로그는 agents/.data/logs/<이름>.log

**켜기 전에 두 가지를 먼저 본다** — 이미 떠 있는 포트인지, 그리고 이 파이썬으로 에이전트가 뜨는지.
둘 다 전에는 자식이 조용히 죽고 런처는 `[종료됨] (코드 1)`만 적었다. 그 줄만 보면 원인이 보이지
않아서, 화면에 에이전트가 멀쩡히 켜져 있는데(= 먼저 띄운 것들이 포트를 잡고 있는데) 왜 종료됐냐는
질문이 남는다.
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
FRONT = HERE.parent / "frontend"
LOGS = HERE / ".data" / "logs"
PY = {"orchestrator": "pg_agents.orchestrator", "guide": "pg_agents.guide", "proofread": "pg_agents.proofread",
      "safety": "pg_agents.safety", "report": "pg_agents.report",
      "designcraft": "pg_agents.designcraft"}
# 메모리가 빠듯한 PC에서 OpenBLAS가 스레드마다 큰 버퍼를 잡다 실패하는 것을 막는다. 모델은 로컬 캐시만 쓴다.
ENV = {"PYTHONIOENCODING": "utf-8", "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2", "HF_HUB_OFFLINE": "1",
       "TOKENIZERS_PARALLELISM": "false"}
NODE = {"preflight": "agents/preflight.ts", "color": "agents/color.ts", "paper": "agents/paper.ts"}


def _busy(port: int) -> bool:
    """그 포트를 이미 누가 듣고 있는가. 떠 있는 에이전트 위에 겹쳐 띄우면 EADDRINUSE로 죽는다."""
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _runnable(py: str) -> bool:
    """이 인터프리터로 에이전트가 뜨는가. 의존성(requirements.txt)은 한 환경에만 깔려 있는 것이 보통이라,
    다른 python으로 런처를 부르면 런처는 멀쩡한데 자식이 전부 ModuleNotFoundError로 죽는다."""
    return subprocess.run([py, "-c", "import uvicorn, fastapi"], capture_output=True, check=False).returncode == 0


def main(names: list[str]) -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # cp949 콘솔에서 출력하다 런처가 죽고 자식까지 끄는 일을 막는다
    sys.path.insert(0, str(HERE))
    from pg_agents.config import listen_port, load_env_files
    for f in load_env_files():  # agents/.env의 설정을 자식 프로세스까지 물려 준다(값은 찍지 않는다)
        print(f"[.env] {f}")
    LOGS.mkdir(parents=True, exist_ok=True)
    want = names or [*PY, *NODE]

    # 이미 떠 있는 것은 그대로 둔다. 겹쳐 띄워서 죽이는 것보다 낫다.
    for n in [n for n in want if n in {**PY, **NODE} and _busy(listen_port(n))]:
        print(f"[이미 떠 있음] {n} ({listen_port(n)}) — 끄려면 그 에이전트를 띄운 창에서 Ctrl+C")
        want.remove(n)
    if not want:
        print("[그대로] 켜려던 에이전트가 모두 이미 떠 있습니다.")
        return

    py = os.environ.get("PG_PYTHON") or sys.executable
    if any(n in PY for n in want) and not _runnable(py):
        print(f"[멈춤] 이 파이썬에는 에이전트 의존성이 없습니다: {py}\n"
              "       의존성이 깔린 파이썬으로 켜거나(conda activate dev), 그 python 경로를\n"
              "       agents/.env의 PG_PYTHON에 적어 두세요. 새로 깔려면 pip install -r agents/requirements.txt")
        return

    procs = []
    npx = "npx.cmd" if os.name == "nt" else "npx"
    for n in want:
        if n in PY and (HERE / PY[n].replace(".", "/")).exists():
            cmd, cwd = [py, "-m", PY[n]], HERE
        elif n in NODE:
            cmd, cwd = [npx, "tsx", NODE[n]], FRONT
        else:
            print(f"[건너뜀] {n} (아직 없음)")
            continue
        log = open(LOGS / f"{n}.log", "w", encoding="utf-8")
        procs.append((n, subprocess.Popen(cmd, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, env={**os.environ, **ENV})))
        print(f"[시작] {n}: {' '.join(cmd)}")
    try:
        while True:
            for n, p in procs:
                if p.poll() is not None:
                    print(f"[종료됨] {n} (코드 {p.returncode}) — {LOGS / (n + '.log')} 확인")
                    procs.remove((n, p))
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        for _, p in procs:
            p.terminate()


if __name__ == "__main__":
    main(sys.argv[1:])
