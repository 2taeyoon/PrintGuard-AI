import uvicorn

from ..config import PORTS

uvicorn.run("pg_agents.safety.agent:app", host="127.0.0.1", port=PORTS["safety"], log_level="warning")
