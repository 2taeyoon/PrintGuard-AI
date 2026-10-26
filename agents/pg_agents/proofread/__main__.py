import uvicorn

from ..config import PORTS

uvicorn.run("pg_agents.proofread.agent:app", host="127.0.0.1", port=PORTS["proofread"], log_level="warning")
