"""테스트는 진짜 `agents/.data`를 건드리지 않는다.

`pg_agents.config`는 **불러오는 순간** `PG_DATA_DIR`을 읽어 경로를 고정한다. 그래서 각 테스트 파일
맨 위에서 환경변수를 세우는 방식은 **파일 이름 순서에 기댄다** — 먼저 불린 다른 파일이 config를
이미 불러왔으면 늦는다. 실제로 그렇게 깨졌다(새 테스트 파일이 알파벳순으로 앞에 오면서 추적
테스트가 진짜 공통 로그를 읽어 엉뚱한 줄을 세었다).

conftest는 테스트 모듈보다 먼저 불리므로 여기서 한 번 세우면 순서와 무관해진다.
"""
import os
import tempfile

os.environ.setdefault("PG_DATA_DIR", tempfile.mkdtemp(prefix="pg-test-"))
