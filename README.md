# PrintGuard-AI

인쇄소에 PDF를 넘기기 전에 스스로 검수해 보는 웹앱입니다. 폰트가 빠졌는지, 도련이 모자라지 않는지, 이미지 해상도가 버티는지, 고른 종이에 찍으면 색이 얼마나 달라지는지를 미리 보여 줍니다.

- 공개 사이트: **https://print-guard-ai-pi.vercel.app**
- 검사 방식이 두 가지입니다. **바로 검사**는 서버 없이 브라우저 안에서 끝나고(파일이 어디로도 나가지 않습니다), **에이전트 검사**는 에이전트 9개가 같은 계산을 나눠 맡아 누가 무엇을 언제 했는지까지 보여 줍니다.

## 무엇을 하나

- **PDF 검수** — 판형·도련·폰트 포함·이미지 해상도·색 공간·안전 여백·문구(반복 단어, 율/률, 같은 항목 다른 숫자)를 검사하고 페이지 위에 문제 위치를 표시합니다.
- **인쇄 색 차이 예측** — PDF 안 RGB 이미지를 종이별 CMYK ICC 프로파일로 변환해 ΔE2000과 총 잉크량을 계산하고 색 차이 지도를 그립니다(lcms-wasm). 종이 흰색을 측정한 Lab 값을 넣으면 프로파일이 가정한 종이 대신 그 종이 기준으로 옮겨 다시 잽니다(브랜드 종이 근사 보정).
- **종이 489종** — 한국제지연합회 분류 기반 기본 종류 35종에 두성종이·삼원페이퍼 카탈로그와 국내 제지사 공식 제품 페이지에서 모은 브랜드 454종을 더했습니다. 종이 등급별 공개 프로파일 12개를 함께 씁니다.
- **인쇄 불량 점검** — 뒷묻음·눌림·색판 어긋남·농도 얼룩·줄무늬에 대해, 원문으로 확인한 불량 원인이 이 파일·이 종이에 해당하는지만 보여 줍니다(학습 모델이 아닙니다). 위험 점수나 등급은 매기지 않습니다 — 실제 불량 데이터로 세기를 재 본 적이 없기 때문입니다.
- **인쇄 가이드 검색(RAG)** — multilingual-e5-small(int8 ONNX)과 2-gram BM25를 섞어 씁니다. 브라우저와 에이전트가 같은 모델 파일을 돌립니다(브라우저는 transformers.js, 서버는 onnxruntime).
- **인쇄소 지도** — 행정안전부 전국 인쇄사 인허가 데이터(영업/정상 17,082곳)와 파주출판도시 입주기업을 지도에 올리고 구글 지도로 이어 줍니다.

## 검사 방식 두 가지

| | 바로 검사 | 에이전트 검사(A2A) |
|---|---|---|
| 계산하는 곳 | 이 브라우저 안 | 에이전트 9개(기본 `127.0.0.1:8700`~`8708`) |
| PDF | 어디로도 보내지 않음 | 에이전트에 올라감 |
| 가이드 검색 | 브라우저가 모델을 받아 직접 | guide 에이전트가 대신 |
| 볼 수 있는 것 | 검수 결과 | 결과 + 누가 언제 무엇을 했는지(의뢰 추적·소통 기록·안전 관문 결정) |
| 필요한 것 | 없음 | 에이전트를 켜 둬야 함 |

에이전트를 켜지 않아도 앱은 바로 검사 모드로 전부 동작합니다.

## 에이전트 9개

| 에이전트 | 포트 | 하는 일 | 런타임 |
|---|---|---|---|
| 총괄 orchestrator | 8700 | 의뢰를 받아 나눠 보내고 결과를 모읍니다. 바깥에 열리는 창구는 여기 하나뿐입니다 | Python |
| 안전 관문 safety | 8701 | 행동 등급(읽기/A/B/C)을 보고 허가합니다. 막히면 막힌 채로 둡니다(fail-closed) | Python |
| 사전 검사 preflight | 8702 | PDF 구조 검사 | Node |
| 색 color | 8703 | 인쇄 색 차이 예측 | Node |
| 인쇄 가이드 guide | 8704 | 가이드 원문 검색 | Python |
| 종이·위험도 paper | 8705 | 종이 추천, 불량 위험 점검 | Node |
| 교정 proofread | 8706 | 오탈자 수정 제안 | Python |
| 인쇄소 shop | 8707 | 공공 인허가 데이터에서 인쇄소 찾기(조회만) | Python |
| 보고서 report | 8708 | 검수 보고서 작성 | Python |

## 구조

```
frontend/   Next.js 16 앱 (app/ 화면, lib/ 계산, agents/ Node 에이전트, scripts/ 검증, public/ 데이터)
agents/     에이전트 9종(A2A)과 MCP 서버 — 에이전트 검사 모드의 뒷단
eval/       평가·데이터 생성(Python): 검색 모델 비교, 색 엔진 대조, 종이·인쇄소 수집
deploy/     배포용(에이전트 컨테이너, ICC 내려받기 스크립트)
samples/    시험용 PDF
```

## 설치

```bash
# 파이썬과 Node를 한 환경에 둡니다(Node 에이전트도 이 node로 돕니다)
conda create -y -n dev python=3.12 nodejs=22
conda activate dev
pip install -r agents/requirements.txt

cd frontend && npm install          # tsx 포함(Node 에이전트 실행용)
```

그다음 **저장소에 없는 파일**(모델·wasm·ICC 프로파일)을 채웁니다. 아래 같은 이름의 절을 보세요.

## 실행

```bash
# 1) 바로 검사만 — 에이전트 없이 브라우저 안에서 전부 계산합니다
cd frontend && npm run dev -- -H 127.0.0.1 -p 8752

# 2) 에이전트 검사까지 — 에이전트 9개를 켜고 앱에서 '에이전트 검사'를 고릅니다
python agents/run_agents.py          # 로그는 agents/.data/logs/<이름>.log
cd frontend && npm run dev -- -H 127.0.0.1 -p 8752
```

`python agents/run_agents.py guide color`처럼 이름을 적으면 일부만 켭니다. 끄는 것은 Ctrl+C 한 번이면 전부 내려갑니다.

테스트: `python -m pytest agents -q` (65개)
타입·린트·빌드: `cd frontend && npx tsc --noEmit && npx eslint app lib && npm run build`

### MCP (선택)

밖의 LLM 클라이언트가 에이전트를 쓰게 합니다. 에이전트를 먼저 켭니다.

```bash
claude mcp add printguard -- "$(conda run -n dev python -c 'import sys;print(sys.executable)')" -m pg_agents.mcp_server
```

cwd는 `agents/`여야 합니다. 읽기 도구 8개와 쓰기 도구 1개(보고서 작성)를 내보냅니다. 쓰기 도구는 safety 관문을 거치고, 사람 승인(C 등급)은 MCP가 대신할 수 없습니다 — 웹 화면에서 사람이 승인합니다.

## 공개 배포

프론트는 Vercel에 올리고, 에이전트는 **개발자 PC에서 돌리면서 Cloudflare 터널로 고정 주소를 붙이는** 구성입니다. 에이전트 9개는 서로 http로 부르며 계속 떠 있어야 해서, 요청 때만 깨는 서버리스로는 돌릴 수 없습니다.

```
브라우저 ─▶ Vercel(프론트) ─▶ https://pg.2taeyoon.com ─▶ Cloudflare 터널 ─▶ PC 127.0.0.1:8700 ─▶ 에이전트 9개
```

**프론트(Vercel)** — Root Directory `frontend`, 프리셋 Next.js, `main`에 머지하면 자동 배포됩니다. 환경변수는 하나입니다.

```ini
NEXT_PUBLIC_PG_ORCHESTRATOR=https://pg.2taeyoon.com
```

`NEXT_PUBLIC_` 값은 빌드할 때 번들에 박히므로, 바꾸면 재배포해야 합니다. 이 값이 로컬 주소가 아니면 앱은 공개 배포로 보고 에이전트 검사를 기본 모드로 엽니다.

**에이전트(내 PC + 터널)** — 터널은 한 번만 만들어 두면 주소가 고정됩니다.

```bash
cloudflared tunnel login                                   # 최초 1회
cloudflared tunnel create printguard                       # 최초 1회
cloudflared tunnel route dns printguard pg.2taeyoon.com    # 최초 1회
```

`~/.cloudflared/config.yml`에 들어갈 내용은 이렇습니다. 바깥에 여는 것은 오케스트레이터 하나뿐이고 나머지 경로는 막습니다.

```yaml
tunnel: <터널 ID>
credentials-file: <경로>/<터널 ID>.json
ingress:
  - hostname: pg.2taeyoon.com
    service: http://127.0.0.1:8700
  - service: http_status:404
```

그 뒤로는 켤 때마다 두 줄입니다.

```bash
python agents/run_agents.py
cloudflared tunnel run printguard
```

브라우저가 다른 출처에서 오케스트레이터를 부르므로 `agents/.env`에 그 출처를 허용해 둡니다.

```ini
PG_CORS_ORIGIN_REGEX=https://.*\.vercel\.app|http://(127\.0\.0\.1|localhost):\d+
```

**공개 사이트에서 달라지는 점**

- 에이전트를 끄면 에이전트 검사만 멈춥니다. 바로 검사는 그대로 동작합니다.
- 가이드 검색 모델과 onnxruntime wasm은 저장소에 없으면 CDN에서 받아 옵니다. 첫 검색에서 118MB를 내려받아 느립니다.
- **ICC 프로파일은 공개 사이트에 올리지 않습니다**(재배포가 허용되지 않습니다). 색 차이를 재려면 방문자가 인쇄소에서 받은 `.icc` 파일을 화면에서 직접 올려야 합니다.
- 에이전트 주소는 연결이 끊겼을 때만 화면에 입력칸으로 나타납니다. 거기서 바꾼 주소는 그 브라우저에만 저장되고 서버로 가지 않습니다.

컨테이너로 올리고 싶으면 `deploy/hf-space/Dockerfile`이 에이전트 9개를 한 컨테이너에 담습니다(`PG_HOST=0.0.0.0`, `PORT`로 오케스트레이터 포트를 받습니다).

## 선택: 키를 넣어야 쓰는 기능

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
| LLM 교정 제안(규칙·Kiwi에 더해) | `GEMINI_API_KEY`, 모델은 `PG_LLM_MODEL`(기본 `gemini-3.5-flash-lite` — 무료 등급. `gemini-2.5-*`는 신규 키에 제공되지 않음), `PG_PROOF_METHODS` | [Google AI Studio](https://aistudio.google.com/apikey) | `.env`에 넣고 `python agents/run_agents.py` |
| LLM 교정기 정량평가 | 위와 같음 | 위와 같음 | `python eval/proofread/eval_proofread.py` (키가 있으면 LLM 조합이 표에 더해집니다. API 호출 121회 — 무료 등급 하루 한도 안, 분당 한도에 걸리면 기다렸다 다시 부릅니다) |
| 추적을 LangSmith로 보내기 | `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`(기본 `printguard`) | [LangSmith](https://smith.langchain.com) → Settings → API Keys | `cd agents && python -m pg_agents.langsmith_export <context_id>` |

`.env`를 읽는 곳은 `run_agents.py`(자식 에이전트까지 물려 줍니다), `pg_agents.mcp_server`, `pg_agents.langsmith_export`, 교정 평가 스크립트입니다. 앱(브라우저) 쪽 설정은 Next.js 규칙대로 `frontend/.env.local`에 둡니다 — 지금 쓰는 값은 오케스트레이터 주소 하나입니다(`NEXT_PUBLIC_PG_ORCHESTRATOR=http://127.0.0.1:8700`).

LangSmith로 나가는 것은 공통 로그로 만든 추적(에이전트·skill·시간·상태·관문 결정)뿐입니다. PDF 본문과 입력값은 공통 로그에 애초에 남기지 않으므로 나가지 않습니다.

## 저장소에 없는 파일

라이선스나 용량 때문에 올리지 않았습니다. 셋 다 없어도 앱은 뜨지만, 모델과 wasm은 CDN에서 받아 오느라 느려지고 ICC가 없으면 색 차이를 재지 못합니다.

1. **임베딩 모델** → `frontend/public/models/Xenova/multilingual-e5-small/`
   Hugging Face `Xenova/multilingual-e5-small`에서 `config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `sentencepiece.bpe.model`, `quant_config.json`, `onnx/model_quantized.onnx`를 받습니다. 없으면 브라우저는 Hugging Face CDN에서, 에이전트는 `huggingface_hub`로 받아 씁니다.
2. **onnxruntime-web wasm** → `frontend/public/ort/`
   `npm install` 후 `node_modules/onnxruntime-web/dist/`의 `ort-wasm-simd-threaded*.{mjs,wasm}`를 복사합니다. 없으면 transformers.js 기본 CDN을 씁니다.
3. **ICC 프로파일** → `frontend/public/icc/` (재배포 금지라 직접 받아야 합니다)
   ```bash
   python deploy/fetch_icc.py          # 12개를 ECI·ICC 레지스트리에서 받아 넣습니다
   ```
   손으로 받으려면 — ECI(`https://eci.org/lib/exe/<이름>.zip`의 `pso-coated_v3`, `pso-uncoated_v3_fogra52`, `eci_offset_2009`, `eci_offset_profiles_inp`, `pso_sc-b_paper_v3`) 안의 `PSOcoated_v3.icc`, `PSOuncoated_v3_FOGRA52.icc`, `ISOcoated_v2_eci.icc`, `ISOuncoatedyellowish.icc`, `PSO_LWC_Improved_eci.icc`, `PSO_LWC_Standard_eci.icc`, `PSO_MFC_Paper_eci.icc`, `PSO_SNP_Paper_eci.icc`, `PSO_INP_Paper_eci.icc`와, ICC 프로파일 레지스트리(`https://registry.color.org/profile-registry/profiles/<이름>.icc`)의 `PSOsc-b_paper_v3_FOGRA54.icc`, `APTEC_PC10_CardBoard_2023_v1.icc`, `JapanColor2011Coated.icc`입니다.

## 한계

- 색 차이는 프로파일 기준 계산값이며 실물 인쇄 측색값이 아닙니다. 브랜드 종이는 등급 프로파일로 근사합니다.
- 종이 흰색 보정은 흰색만 옮깁니다. 잉크 거동과 잉크량 한도는 등급 프로파일 값 그대로이고, 측정값을 넣지 않으면 보정하지 않습니다(방법 검증: `frontend/scripts/test-substrate.mts`, 적용 확인: `test-substrate-engine.mts`).
- 불량 점검은 학습 모델이 아니라 근거를 밝힌 규칙이며, 실제 불량 데이터가 없어 위험의 세기(점수·등급)는 내지 않습니다.
- 인허가 '영업/정상'은 신고 기준이라 실제 영업 여부와 어긋날 수 있습니다.
- 인쇄 견적·주문 기능은 두지 않았습니다. 단가를 정할 근거가 없어서입니다 — 인쇄소 지도는 공공 데이터로 찾아 주기만 하고, 연락은 사용자가 직접 합니다. 사람 승인 토큰은 흉내 모드(`human:<이름>`)뿐입니다.
- 교정은 제안만 하며 자동으로 고치지 않습니다. 합성 평가셋(문서 60개)에서 기본 조합(규칙+Kiwi 오타)은 재현율 60.3%·정밀도 99.5%, LLM을 더하면 98.1%·97.8%입니다(`gemini-3.5-flash-lite`, 2026-10-27). 규칙 기반 쪽은 오류를 넣는 규칙과 찾는 규칙이 겹쳐 재현율이 부풀어 있어 실제 원고로 다시 재야 합니다.
- 기본값은 로컬 조합입니다. LLM을 켜면 PDF 본문이 외부 API로 나가므로(앱의 나머지 계산은 모두 기기 안) `PG_PROOF_METHODS`로 직접 켜야 합니다. LLM 교정기와 LangSmith 추적은 사용자가 `GEMINI_API_KEY`·`LANGSMITH_API_KEY`를 직접 넣을 때만 씁니다 — 키를 찾거나 읽지 않습니다.
- 오케스트레이터의 의뢰 목록은 메모리에만 있어 재시작하면 사라집니다(safety·shop 기록과 공통 로그는 SQLite에 남아 추적은 유지됩니다).

## 데이터 출처

한국제지연합회 「종이의 분류」, 두성종이·삼원페이퍼 제품 페이지와 국내 제지사 공식 제품 페이지, 행정안전부 LOCALDATA 기타_인쇄사(공공누리 출처표시), 파주출판도시 입주기업협의회, Kodak 공개 테스트 사진. 화면의 **출처** 탭에 논문·데이터·모델·라이브러리를 전부 적어 두었습니다.
