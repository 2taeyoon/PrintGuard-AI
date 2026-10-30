import uvicorn

from ..config import HOST, listen_port

uvicorn.run("pg_agents.shop.agent:app", host=HOST, port=listen_port("shop"), log_level="warning")
