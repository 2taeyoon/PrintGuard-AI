import uvicorn

from ..config import HOST, listen_port

uvicorn.run("pg_agents.proofread.agent:app", host=HOST, port=listen_port("proofread"), log_level="warning")
