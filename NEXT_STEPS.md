# 남은 작업 (2026-10-27 기준)

에이전트 작업 순서 1 → 2 → 4 → 3 → 5 → 6 **전부 구현 완료**. 6단계(MCP 서버·추적)는 이번에 넣었고, 남은 것은 아래 '직접 해야 하는 확인'과 선택 항목이다.

## 지금 상태 요약
- 에이전트 9개(포트 8700~8708): orchestrator, safety, preflight, color, guide, paper, proofread, shop, report.
  - 실행: `cd agents && python run_agents.py` (conda `dev`), 앱: `cd frontend && npm run dev -- -H 127.0.0.1 -p 3100` → `/?mode=agent`
- 테스트: `cd agents && python -m pytest -q` → **58개 통과**(2026-10-27, 추적 7개·MCP 19개 추가). `npx tsc --noEmit`·`npm run lint` 통과.
- e2e(에이전트를 켠 상태에서 수동): `python agents/e2e_check.py ../samples/defective_a5.pdf '{"paper_id":"art","finish":"none","proofread":true}' --commerce`
- 교정 기본 탐지: 규칙+Kiwi 오타 (합성 평가 재현율 0.603, 정밀도 0.995). LLM 교정은 키가 없어 평가하지 않음.

## 이 PC 환경(2026-10-27 설치)
- conda `dev`: python 3.12.16 + nodejs 22.23.4(Node 에이전트도 이 node로 돈다). 패키지는 `agents/requirements.txt`로 고정.
- `frontend/npm install` 완료(407개) + `tsx`를 devDependency로 추가(run_agents.py가 `npx tsx`로 Node 에이전트를 띄운다).
- 받아 둔 것: `frontend/public/ort/`(onnxruntime-web wasm, node_modules에서 복사), `frontend/public/models/Xenova/multilingual-e5-small/`(브라우저 검색용 134MB), HF 캐시 `intfloat/multilingual-e5-small`(guide 에이전트 — `HF_HUB_OFFLINE=1`로 검색까지 확인).
- **ICC는 `RSWOP.icm`(Windows 내장)만 있다.** ECI·ICC 레지스트리 프로파일 12개는 자동 내려받기가 막혀 있어(eci.org가 내려받기 링크를 사람 확인 뒤에만 준다) README의 목록대로 직접 받아 `frontend/public/icc/`에 넣어야 한다. 그때까지 색 차이 예측은 SWOP 종이에서만 된다.
- eval 쪽 패키지(torch 외 pyproj 등)는 넣지 않았다. `eval/`을 돌릴 때 따로 설치.
- 서버는 띄우지 않았다(요청대로 설치까지만).

## 6단계에서 넣은 것
- `agents/pg_agents/tracing.py` — `build_trace(context_id)`: 공통 로그의 request_received↔result_sent 짝으로 에이전트별 구간(시작·걸린 시간·상태·열린 구간), safety_decision·human_review 관문, 의뢰 사건을 만든다. 로그에 없는 값은 만들지 않는다.
- `GET /trace?context_id=…`(오케스트레이터) + 에이전트 탭의 **의뢰별 워터폴**(구간 막대 + 관문 목록, 2초마다 갱신).
- `agents/pg_agents/mcp_server.py` — stdio MCP 서버, 요청자 이름 `mcp`. 도구 11개.
  - 읽기: `check_pdf`, `get_job`, `answer_question`, `list_agents`, `get_trace`, `find_shops`, `list_reviews`, `search_guide`
  - 쓰기: `request_quote`(B), `place_order`(C), `compile_report`(A) — 모두 해당 에이전트가 safety를 거치고, 관문 거절은 고치지 않고 그대로 돌려준다. 승인 도구는 없다(C는 웹 화면에서 사람이 승인).
  - 결과에서 heat 비트맵은 버리고, PDF 본문(untrusted)은 기본으로 넣지 않는다(`get_job(include_texts=True)`로만).
  - `pdf_ref` 문제 해결: `Job.public()`에 `pdf_ref`·`answers`를 넣었다. 견적 사양·보고서 입력은 `orchestrator/plan.py`의 `quote_spec`·`report_input`으로 모아 오케스트레이터 API와 MCP가 같은 코드를 쓴다.
  - 설치된 `mcp`는 2.3.0이다(FastMCP → MCPServer로 이름이 바뀜). import는 2.x·1.x 둘 다 되게 해 두었다.

## 직접 해야 하는 확인(사람 손이 필요)
- [ ] MCP 등록·수동 점검: 에이전트를 켠 뒤
      `claude mcp add printguard -- C:\Users\403\miniforge3\envs\dev\python.exe -m pg_agents.mcp_server` (cwd `agents/`).
      확인할 것: 도구 목록 11개, `check_pdf`로 의뢰 → `answer_question` → `get_trace`, `request_quote`가 틀린 사양일 때 교차 검증 거절을 그대로 돌려주는지, `place_order`가 승인 대기만 돌려주는지(웹에서 승인 뒤 다시 부르면 주문).
- [ ] ICC 프로파일 12개 직접 받기(README '저장소에 없는 파일' 3번). 받은 뒤 `npx tsx scripts/test-profiles.mts`로 확인.
- [ ] e2e_check.py를 이 PC에서 한 번 돌려 보기(에이전트 9개를 켠 상태).

## 선택 항목
- [ ] LangSmith 연동: `langsmith` 0.14.12 설치됨. `LANGSMITH_API_KEY`를 사용자가 직접 넣었을 때만 내보내기. 키를 찾거나 읽지 않는다.
- [ ] LLM-as-judge: 교정 LLM 탐지기 평가. `GEMINI_API_KEY`가 있을 때만.

## 이전부터 남은 것
- [ ] 종이 흰색(substrate) 보정을 색 에이전트에 넣기. 화면의 `class="warn"`(브랜드 종이 근사 경고)를 해결하려던 작업. `frontend/lib/substrate.ts`와 검증(12쌍 중 9쌍에서 선형 방법이 가장 좋음)까지만 했다. 검증 스크립트는 `eval/icc/`의 프로파일을 읽으므로 ICC를 먼저 받아야 한다.
- [ ] Next.js 보안 업그레이드 안내: `next upgrade --agent=security` (frontend). 따로 worktree에서 할지 정해야 한다.
- [ ] 아티팩트(https://claude.ai/artifact/P8Y7u41CLDXUPppz8CAR4Q)에 교정 탐지기 비교 결과(`eval/proofread/results.json`) 추가.

## 알려진 한계
- shop의 협력사·단가는 시연용으로 지어낸 값이다. 실제 인쇄소에는 아무것도 보내지 않는다.
- 사람 토큰은 목 모드(`human:<이름>`)뿐이다. 실제 로그인 없음.
- 오케스트레이터의 의뢰(JOBS)는 메모리에만 있다. 재시작하면 사라진다(safety·shop 기록과 공통 로그는 SQLite에 남는다 — 추적은 그 로그만 읽으므로 재시작 뒤에도 남아 있다).
- 교정 평가 문장 틀이 규칙과 겹친다(띄어쓰기·율/률 재현율 1.0은 순환). 실제 원고로 다시 재야 한다.
- PyMuPDF 2.0에서 `import fitz`는 경고가 난다(아직 동작한다). 바꿀 때 `eval/`의 스크립트까지 같이 고쳐야 한다.
