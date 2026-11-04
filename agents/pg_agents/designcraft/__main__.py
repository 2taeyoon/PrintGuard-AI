import uvicorn

from ..config import HOST, listen_port

uvicorn.run("pg_agents.designcraft.agent:app", host=HOST, port=listen_port("designcraft"), log_level="warning")
