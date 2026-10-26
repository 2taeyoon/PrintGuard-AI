import uvicorn

from ..config import PORTS

uvicorn.run("pg_agents.orchestrator.app:app", host="127.0.0.1", port=PORTS["orchestrator"], log_level="warning")
