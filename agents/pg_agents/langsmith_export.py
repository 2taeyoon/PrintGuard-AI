"""(선택) 의뢰 추적을 LangSmith로 내보낸다 — `LANGSMITH_API_KEY`를 사용자가 직접 넣었을 때만.

  python -m pg_agents.langsmith_export ctx_job_xxxxxxxx [--project 이름]

- 키를 찾거나 읽지 않는다. 환경변수가 없으면 아무것도 보내지 않고 그대로 알려 준다(exported 0).
- 보내는 것은 공통 로그로 만든 추적뿐이다(tracing.build_trace): 에이전트·skill·시간·상태·관문 결정.
  PDF 본문·입력값·판단 문장은 공통 로그에 애초에 없으므로 나가지 않는다.
- 의뢰 하나가 루트 run 1개, 에이전트 호출마다 자식 run 1개가 된다. 끝나지 않은 구간(open)은 보내지 않는다.
"""
from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime, timedelta
from typing import Any

from .tracing import build_trace

NAMESPACE = uuid.UUID("7f6c1f2e-0000-4000-8000-000000000001")  # 같은 의뢰를 다시 보내도 같은 run id가 되게(중복 방지)


def _ids(context_id: str, key: str) -> uuid.UUID:
    return uuid.uuid5(NAMESPACE, f"{context_id}/{key}")


def export_trace(context_id: str, *, project: str | None = None, client: Any = None) -> dict[str, Any]:
    """추적을 LangSmith run으로 보낸다. client를 주면 그것을 쓴다(테스트용). 보낸 run 수를 돌려준다."""
    if client is None:
        if not os.environ.get("LANGSMITH_API_KEY"):
            return {"exported": 0, "reason": "LANGSMITH_API_KEY 없음 — 환경변수를 직접 넣으면 보냅니다"}
        from langsmith import Client  # 키가 있을 때만 불러온다
        client = Client()
    tr = build_trace(context_id)
    if not tr["t0"]:
        return {"exported": 0, "reason": f"공통 로그에 없는 의뢰: {context_id}"}

    project = project or os.environ.get("LANGSMITH_PROJECT") or "printguard"
    t0 = datetime.fromisoformat(tr["t0"])
    at = lambda ms: t0 + timedelta(milliseconds=ms)
    root = _ids(context_id, "root")
    gates = [{k: g[k] for k in ("at_ms", "kind", "action", "decision", "grade", "amount", "review_id")} for g in tr["gates"]]
    client.create_run(name=f"job {context_id}", inputs={"context_id": context_id}, run_type="chain", project_name=project,
                      id=root, start_time=t0, end_time=at(tr["total_ms"]),
                      outputs={"agents": tr["agents"], "gates": gates, "log_lines": tr["lines"]},
                      extra={"metadata": {"source": "printguard/common_log", "spans": len(tr["spans"])}})
    sent = 1
    for i, s in enumerate(tr["spans"]):
        if s["open"]:  # 아직 결과가 없는 구간은 시간이 없으므로 보내지 않는다
            continue
        client.create_run(name=f"{s['agent']}.{s['skill']}", inputs={"requester": s["requester"]}, run_type="tool", project_name=project,
                          id=_ids(context_id, f"span{i}"), parent_run_id=root, start_time=at(s["start_ms"]), end_time=at(s["end_ms"]),
                          outputs={"status": s["status"], "outcome": s["outcome"]},
                          error=s["outcome"] if s["status"] in ("rejected", "failed", "canceled") else None,
                          extra={"metadata": {"grade": s["grade"], "ms": s["ms"]}})
        sent += 1
    return {"exported": sent, "project": project, "context_id": context_id, "root_run_id": str(root),
            "skipped_open_spans": sum(1 for s in tr["spans"] if s["open"])}


def main(argv: list[str]) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    if not argv or argv[0].startswith("-"):
        print(__doc__)
        return 2
    project = argv[argv.index("--project") + 1] if "--project" in argv else None
    r = export_trace(argv[0], project=project)
    print(r)
    return 0 if r["exported"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
