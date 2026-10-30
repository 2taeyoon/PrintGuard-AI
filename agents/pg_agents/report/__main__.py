import uvicorn

from ..config import HOST, listen_port

uvicorn.run("pg_agents.report.agent:app", host=HOST, port=listen_port("report"), log_level="warning")
