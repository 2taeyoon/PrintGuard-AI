import threading

import uvicorn

from ..config import HOST, listen_port
from .agent import index

threading.Thread(target=index, daemon=True).start()  # 첫 요청이 모델 로딩(약 1분)을 기다리지 않게 미리 불러온다
uvicorn.run("pg_agents.guide.agent:app", host=HOST, port=listen_port("guide"), log_level="warning")
