import threading

import uvicorn

from ..config import PORTS
from .agent import index

threading.Thread(target=index, daemon=True).start()  # 첫 요청이 모델 로딩(약 1분)을 기다리지 않게 미리 불러온다
uvicorn.run("pg_agents.guide.agent:app", host="127.0.0.1", port=PORTS["guide"], log_level="warning")
