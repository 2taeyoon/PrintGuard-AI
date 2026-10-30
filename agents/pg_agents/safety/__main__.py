import uvicorn

from ..config import HOST, listen_port

uvicorn.run("pg_agents.safety.agent:app", host=HOST, port=listen_port("safety"), log_level="warning")
