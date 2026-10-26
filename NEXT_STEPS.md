# 남은 작업 (2026-10-26 기준)

에이전트 작업 순서 1 → 2 → 4 → 3 → 5 → 6 중 **1·2·4·3·5단계 완료**(커밋 955e1e4, 69dd593, 2597177, 0627fb3, 0ca59ab). 6단계는 시작 전 단계에서 멈췄다.

## 지금 상태 요약
- 에이전트 9개(포트 8700~8708): orchestrator, safety, preflight, color, guide, paper, proofread, shop, report.
  - 실행: `cd agents && python run_agents.py` (conda `dev`), 앱: `cd frontend && npm run dev -- -H 127.0.0.1 -p 3100` → `/?mode=agent`
- 테스트: `cd agents && python -m pytest -q` → 32개 통과(2026-10-26).
- e2e: `python agents/e2e_check.py ../samples/defective_a5.pdf '{"paper_id":"art","finish":"none","proofread":true}' --commerce`
  - 견적(B) 통과, 사양 틀린 견적은 preflight 교차 검증에서 거절, 에이전트 토큰 승인 401, 사람 승인 후 주문, 보고서 ΔE 재계산 일치.
- 교정 기본 탐지: 규칙+Kiwi 오타 (합성 평가 재현율 0.603, 정밀도 0.995). LLM 교정은 키가 없어 평가하지 않음.

## 6단계: MCP 서버 + 추적 (미완)
- [ ] `agents/pg_agents/mcp_server.py` (FastMCP, stdio). 초안을 썼지만 레포에 넣지 않았다. 아래 두 가지가 비어 있다.
  - 읽기 도구: `check_pdf`, `get_job`, `answer_question`, `list_agents`, `get_trace`, `find_shops`, `list_reviews`
  - 쓰기 도구: `request_quote`(B), `place_order`(C, MCP는 승인 불가 → 웹에서 사람이 승인), `compile_report`(A). 모두 에이전트가 safety를 거친다.
  - [ ] `request_quote`에 쓸 `pdf_ref`를 얻을 길이 없다 → `Job.public()`에 `pdf_ref`를 넣거나 job_opened 로그에 전체 sha256을 남기기.
  - [ ] `agents/pg_agents/tracing.py`(`build_trace(context_id)`)가 아직 없다: 공통 로그의 request_received/result_sent 짝으로 에이전트별 구간·시간·관문 결정을 만든다.
  - conda `dev`에 `mcp` 1.30.0을 설치함. Claude Code 등록 예: `claude mcp add printguard -- <dev python> -m pg_agents.mcp_server` (cwd `agents/`).
  - [ ] MCP 테스트: 도구 목록, 쓰기 도구가 safety 거절을 그대로 돌려주는지, 결과에 heat 같은 큰 값이 빠지는지.
- [ ] 추적 화면: 에이전트 탭에 의뢰별 워터폴(공통 로그 기반).
- [ ] LangSmith 연동(선택): `langsmith` 0.14.7은 설치돼 있음. `LANGSMITH_API_KEY` 환경변수를 사용자가 직접 넣었을 때만 내보내기. 키를 찾거나 읽지 않는다.
- [ ] LLM-as-judge(선택): 교정 LLM 탐지기 평가. `GEMINI_API_KEY`가 있을 때만.

## 이전부터 남은 것
- [ ] 종이 흰색(substrate) 보정을 색 에이전트에 넣기. 화면의 `class="warn"`(브랜드 종이 근사 경고)를 해결하려던 작업. `frontend/lib/substrate.ts`와 검증(12쌍 중 9쌍에서 선형 방법이 가장 좋음)까지만 했다. Arctic Paper ICC는 임시 폴더에 받았다가 지워졌을 수 있다.
- [ ] Next.js 보안 업그레이드 안내가 나왔다: `next upgrade --agent=security` (frontend). 따로 worktree에서 할지 정해야 한다.
- [ ] 아티팩트(https://claude.ai/artifact/P8Y7u41CLDXUPppz8CAR4Q)에 교정 탐지기 비교 결과(`eval/proofread/results.json`) 추가.

## 알려진 한계
- shop의 협력사·단가는 시연용으로 지어낸 값이다. 실제 인쇄소에는 아무것도 보내지 않는다.
- 사람 토큰은 목 모드(`human:<이름>`)뿐이다. 실제 로그인 없음.
- 오케스트레이터의 의뢰(JOBS)는 메모리에만 있다. 재시작하면 사라진다(safety·shop 기록은 SQLite에 남음).
- 교정 평가 문장 틀이 규칙과 겹친다(띄어쓰기·율/률 재현율 1.0은 순환). 실제 원고로 다시 재야 한다.
