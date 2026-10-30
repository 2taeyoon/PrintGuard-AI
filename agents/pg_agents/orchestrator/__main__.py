import uvicorn

from ..config import HOST, listen_port

uvicorn.run("pg_agents.orchestrator.app:app", host=HOST, port=listen_port("orchestrator"), log_level="warning")
