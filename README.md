# PrintGuard-AI

인쇄 전 PDF 품질 검수 웹앱. 기본(바로 검사)은 서버 없이 브라우저 안에서만 동작하고, 에이전트 검사 모드에서는 로컬 에이전트들이 같은 계산을 나눠 맡습니다(밖으로 나가는 통신 없음).

- **PDF 검수**: 판형·도련·폰트 포함·이미지 해상도·색 공간·안전 여백·문구(반복 단어, 율/률, 같은 항목 다른 숫자)를 검사하고 페이지 위에 문제 위치를 표시합니다.
- **인쇄 색 차이 예측**: PDF 안 RGB 이미지를 종이별 CMYK ICC 프로파일로 변환해 ΔE2000과 총 잉크량을 계산하고 색 차이 지도를 그립니다(lcms-wasm). 종이 흰색을 측정한 Lab 값을 넣으면 프로파일이 가정한 종이 대신 그 종이 기준으로 옮겨 다시 잽니다(브랜드 종이 근사 보정).
- **종이 491종**: 한국제지연합회 분류 기반 기본 종류 35종 + 두성종이·삼원페이퍼·국내 제지사 브랜드 456종, 종이 등급별 공개 프로파일 12개.
- **인쇄 불량 위험도**: 뒷묻음·눌림·색판 어긋남·농도 얼룩·줄무늬를 원문으로 확인한 근거의 점수표 규칙으로 표시합니다(학습 모델 아님). 점수 크기와 등급 구분선은 재서 정한 값이 아니라 임의로 정한 값이라, 등급은 확률이 아니라 먼저 확인할 순서로 읽어야 합니다.
- **인쇄 가이드 검색(RAG)**: multilingual-e5-small(int8 ONNX) + 2-gram BM25 하이브리드.
- **인쇄소 지도**: 행정안전부 전국 인쇄사 인허가 데이터(영업/정상 17,082곳) + 파주출판도시 입주기업, 구글 지도 링크. 좌표를 도로 단위로 추정했던 10곳은 자리를 확인할 수 없어 뺐습니다.

## 구조
```
frontend/   Next.js 16 앱 (app/, lib/, agents/ Node 에이전트, scripts/ 검증 스크립트, public/ 데이터)
agents/     로컬 에이전트(A2A) 9종과 MCP 서버 — 에이전트 검사 모드(`/?mode=agent`)의 뒷단
eval/       평가·데이터 생성 (Python): 검색 모델 비교, 색 엔진 대조, 종이·인쇄소 데이터 수집
samples/    시험용 PDF
```

## 설치
```bash
# 파이썬·Node를 한 환경에 둔다(Node 에이전트도 이 node로 돈다)
conda create -y -n dev python=3.12 nodejs=22
conda activate dev
pip install -r agents/requirements.txt

cd frontend && npm install          # tsx 포함(Node 에이전트 실행용)
# '저장소에 없는 파일'(모델·wasm·ICC 프로파일)을 채운다
```

## 실행
```bash
# 1) 바로 검사 모드만: 브라우저 안에서 전부 계산한다(에이전트 불필요)
cd frontend && npm run dev -- -H 127.0.0.1 -p 3000

# 2) 에이전트 검사 모드: 에이전트 9개(:8700~8708)를 켜고 앱에서 /?mode=agent 로 들어간다
cd agents && python run_agents.py   # 로그는 agents/.data/logs/<이름>.log
cd frontend && npm run dev -- -H 127.0.0.1 -p 3100

# 3) MCP(선택): 밖의 LLM 클라이언트가 에이전트를 쓰게 한다. 에이전트를 먼저 켠다
claude mcp add printguard -- "$(conda run -n dev python -c 'import sys;print(sys.executable)')" -m pg_agents.mcp_server
# cwd는 agents/ 여야 한다. 읽기 도구 8개와 쓰기 도구 1개(보고서 A)를 내보낸다.
# 쓰기 도구는 에이전트가 safety 관문을 거치고, 사람 승인(C)은 MCP가 대신할 수 없다(웹 화면에서 사람이 승인).
```
테스트: `cd agents && python -m pytest -q`

### 선택: 키를 넣어야 쓰는 기능
`agents/.env.example`을 `agents/.env`로 복사해 값을 채웁니다(`.env`는 커밋되지 않습니다). 터미널에 이미 설정된 환경변수가 있으면 그 값이 이깁니다.

```bash
cp agents/.env.example agents/.env      # Windows: copy agents\.env.example agents\.env
```
```ini
# agents/.env
GEMINI_API_KEY=발급받은_키
PG_LLM_MODEL=gemini-3.5-flash-lite    # 무료 등급이 있는 모델(기본값)
PG_PROOF_METHODS=rules,kiwi_typo,llm
LANGSMITH_API_KEY=발급받은_키
LANGSMITH_PROJECT=printguard
```

| 기능 | 환경변수 | 받는 곳 | 쓰는 법 |
| --- | --- | --- | --- |
| LLM 교정 제안(규칙·Kiwi에 더해) | `GEMINI_API_KEY`, 모델은 `PG_LLM_MODEL`(기본 `gemini-3.5-flash-lite` — 무료 등급. `gemini-2.5-*`는 신규 키에 제공되지 않음), `PG_PROOF_METHODS` | [Google AI Studio](https://aistudio.google.com/apikey) | `.env`에 넣고 `cd agents && python run_agents.py` |
| LLM 교정기 정량평가 | 위와 같음 | 위와 같음 | `python eval/proofread/eval_proofread.py` (키가 있으면 LLM 조합이 표에 더해짐. API 호출 121회 — 무료 등급 하루 한도 안, 분당 한도에 걸리면 기다렸다 다시 부름) |
| 추적을 LangSmith로 보내기 | `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`(기본 `printguard`) | [LangSmith](https://smith.langchain.com) → Settings → API Keys | `cd agents && python -m pg_agents.langsmith_export <context_id>` |

`.env`를 읽는 곳은 `run_agents.py`(자식 에이전트까지 물려 줌), `pg_agents.mcp_server`, `pg_agents.langsmith_export`, 교정 평가 스크립트입니다. 앱(브라우저) 쪽 설정은 Next.js 규칙대로 `frontend/.env.local`에 둡니다 — 지금 쓰는 값은 오케스트레이터 주소 하나입니다(`NEXT_PUBLIC_PG_ORCHESTRATOR=http://127.0.0.1:8700`).

LangSmith로 나가는 것은 공통 로그로 만든 추적(에이전트·skill·시간·상태·관문 결정)뿐입니다. PDF 본문·입력값은 공통 로그에 애초에 남기지 않으므로 나가지 않습니다.

## 저장소에 없는 파일
라이선스나 용량 때문에 올리지 않았습니다.

1. **임베딩 모델** → `frontend/public/models/Xenova/multilingual-e5-small/`
   Hugging Face `Xenova/multilingual-e5-small`에서 `config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `sentencepiece.bpe.model`, `quant_config.json`, `onnx/model_quantized.onnx`를 받습니다.
2. **onnxruntime-web wasm** → `frontend/public/ort/`
   `npm install` 후 `node_modules/onnxruntime-web/dist/`의 `ort-wasm-simd-threaded*.{mjs,wasm}`를 복사합니다.
3. **ICC 프로파일** → `frontend/public/icc/` (재배포 금지라 직접 받아야 합니다)
   - ECI(eci.org 다운로드): `PSOcoated_v3.icc`, `PSOuncoated_v3_FOGRA52.icc`(ICC 레지스트리에도 있음), `eci_offset_2009.zip` 안의 `ISOcoated_v2_eci.icc`, `ISOuncoatedyellowish.icc`, `PSO_LWC_Improved_eci.icc`, `PSO_LWC_Standard_eci.icc`, `PSO_MFC_Paper_eci.icc`, `PSO_SNP_Paper_eci.icc`, `eci_offset_profiles_inp.zip` 안의 `PSO_INP_Paper_eci.icc`
     (받는 곳: `https://eci.org/lib/exe/<이름>.zip` — `pso-coated_v3`, `pso-uncoated_v3_fogra52`, `eci_offset_2009`, `eci_offset_profiles_inp`, `pso_sc-b_paper_v3`. zip 안의 `.icc`만 꺼내 넣습니다)
   - ICC 프로파일 레지스트리: `PSOsc-b_paper_v3_FOGRA54.icc`(ECI의 `pso_sc-b_paper_v3.zip`에도 있음), `APTEC_PC10_CardBoard_2023_v1.icc`, `JapanColor2011Coated.icc`
     (받는 곳: `https://registry.color.org/profile-registry/profiles/<이름>.icc`)

## 한계
- 색 차이는 프로파일 기준 계산값이며 실물 인쇄 측색값이 아닙니다. 브랜드 종이는 등급 프로파일로 근사합니다.
- 종이 흰색 보정은 흰색만 옮깁니다. 잉크 거동·잉크량 한도는 등급 프로파일 값 그대로이고, 측정값을 넣지 않으면 보정하지 않습니다(방법 검증: `frontend/scripts/test-substrate.mts`, 적용 확인: `test-substrate-engine.mts`).
- 불량 위험도는 학습 모델이 아니라 점수표이며, 실제 불량 데이터로 보정하지 않았습니다.
- 인허가 '영업/정상'은 신고 기준이라 실제 영업 여부와 다를 수 있습니다.
- 인쇄 견적·주문 기능은 두지 않았습니다. 단가를 정할 근거가 없어서입니다 — 인쇄소 지도는 공공 데이터로 찾아 주기만 하고, 연락은 사용자가 직접 합니다. 사람 승인 토큰은 목 모드(`human:<이름>`)뿐입니다.
- 교정은 제안만 하며 자동으로 고치지 않습니다. 합성 평가셋(문서 60개)에서 기본 조합(규칙+Kiwi 오타)은 재현율 60.3%·정밀도 99.5%, LLM을 더하면 98.1%·97.8%입니다(`gemini-3.5-flash-lite`, 2026-10-27). 규칙 기반 쪽은 오류를 넣는 규칙과 찾는 규칙이 겹쳐 재현율이 부풀어 있어 실제 원고로 다시 재야 합니다.
- 기본값은 로컬 조합입니다. LLM을 켜면 PDF 본문이 외부 API로 나가므로(앱의 나머지 계산은 모두 기기 안) `PG_PROOF_METHODS`로 직접 켜야 합니다. LLM 교정기와 LangSmith 추적은 사용자가 `GEMINI_API_KEY`·`LANGSMITH_API_KEY`를 직접 넣을 때만 씁니다 — 키를 찾거나 읽지 않습니다.
- 오케스트레이터의 의뢰 목록은 메모리에만 있어 재시작하면 사라집니다(safety·shop 기록과 공통 로그는 SQLite에 남아 추적은 유지됩니다).

## 데이터 출처
한국제지연합회 「종이의 분류」, 두성종이·삼원페이퍼 제품 페이지, 행정안전부 LOCALDATA 기타_인쇄사(공공누리 출처표시), 파주출판도시 입주기업협의회, Kodak 공개 테스트 사진.
