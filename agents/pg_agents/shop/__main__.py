import uvicorn

from ..config import PORTS

uvicorn.run("pg_agents.shop.agent:app", host="127.0.0.1", port=PORTS["shop"], log_level="warning")
