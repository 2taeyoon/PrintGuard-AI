import uvicorn

from ..config import PORTS

uvicorn.run("pg_agents.report.agent:app", host="127.0.0.1", port=PORTS["report"], log_level="warning")
