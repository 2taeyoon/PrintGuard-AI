"""PrintGuard 에이전트를 한 번에 켠다(로컬 시연용). Ctrl+C로 모두 끈다.

  python run_agents.py            # 전부
  python run_agents.py guide color # 일부만
Python 에이전트는 이 인터프리터로, Node 에이전트는 frontend에서 `npx tsx`로 띄운다. 로그는 agents/.data/logs/<이름>.log
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
FRONT = HERE.parent / "frontend"
LOGS = HERE / ".data" / "logs"
PY = {"orchestrator": "pg_agents.orchestrator", "guide": "pg_agents.guide", "proofread": "pg_agents.proofread",
      "safety": "pg_agents.safety", "shop": "pg_agents.shop", "report": "pg_agents.report"}
# 메모리가 빠듯한 PC에서 OpenBLAS가 스레드마다 큰 버퍼를 잡다 실패하는 것을 막는다. 모델은 로컬 캐시만 쓴다.
ENV = {"PYTHONIOENCODING": "utf-8", "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2", "HF_HUB_OFFLINE": "1",
       "TOKENIZERS_PARALLELISM": "false"}
NODE = {"preflight": "agents/preflight.ts", "color": "agents/color.ts", "paper": "agents/paper.ts"}


def main(names: list[str]) -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # cp949 콘솔에서 출력하다 런처가 죽고 자식까지 끄는 일을 막는다
    sys.path.insert(0, str(HERE))
    from pg_agents.config import load_env_files
    for f in load_env_files():  # agents/.env의 설정을 자식 프로세스까지 물려 준다(값은 찍지 않는다)
        print(f"[.env] {f}")
    LOGS.mkdir(parents=True, exist_ok=True)
    want = names or [*PY, *NODE]
    procs = []
    npx = "npx.cmd" if os.name == "nt" else "npx"
    for n in want:
        if n in PY and (HERE / PY[n].replace(".", "/")).exists():
            cmd, cwd = [sys.executable, "-m", PY[n]], HERE
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
