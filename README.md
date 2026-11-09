# PrintGuard-AI

인쇄소에 PDF를 넘기기 전에 스스로 검수해 보는 웹앱입니다. 폰트가 빠졌는지, 도련이 모자라지 않는지, 이미지 해상도가 버티는지, 고른 종이에 찍으면 색이 얼마나 달라지는지를 미리 보여 줍니다.

- 공개 사이트: **https://print-guard-ai.vercel.app**
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

에이전트를 켜지 않아도 앱은 바로 검사 모드로 전부 동작합니다. 주소 없이 열면(`/`) 에이전트 검사가 기본이고, `/?mode=direct`가 바로 검사입니다.

**로그인은 선택입니다.** 하지 않아도 검수는 전부 되고, 그때 기록은 그 브라우저에만 남습니다. 헤더 오른쪽에서 구글로 로그인하면 그때까지 한 검수가 계정으로 옮겨 가고, 다른 기기에서도 이어서 보입니다.

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
| 보고서 report | 8708 | 검수 보고서 작성 | Python |
| 원본 수정 designcraft | 8709 | 편집 파일(IDML)을 열어 교정을 반영하고, 새 문서도 만듭니다 | Python + DesignCraft MCP |

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

설치는 끝났고 꺼진 것을 되살리기만 하면 되는 상황이라면 [RUN.md](RUN.md)로 가세요 — 켜는 명령과 증상별(502·530) 판별표만 모아 둔 짧은 문서입니다.

**먼저 `conda activate dev`를 합니다.** `run_agents.py`는 자기를 실행한 파이썬으로 자식 에이전트를 띄우는데, 의존성은 그 환경에만 있습니다. 환경을 켜지 않고 `python`을 치면 패키지가 없는 시스템 파이썬이 잡힙니다. 그때는 런처가 **아무것도 띄우지 않고 멈추면서** 어느 파이썬이 잡혔는지 적습니다.

```
[멈춤] 이 파이썬에는 에이전트 의존성이 없습니다: C:\Users\...\Python312\python.exe
```

이미 떠 있는 에이전트가 있으면 그것도 켜기 전에 알려 주고 건드리지 않습니다(`[이미 떠 있음] color (8703)`). 겹쳐 띄우면 `EADDRINUSE`로 죽는데, 화면에서는 먼저 띄운 쪽이 멀쩡히 답하고 있어서 왜 죽었는지가 안 보입니다.

```bash
conda activate dev                   # 빼먹으면 에이전트가 안 뜹니다

# 1) 바로 검사만 — 에이전트 없이 브라우저 안에서 전부 계산합니다
cd frontend && npm run dev -- -H 127.0.0.1 -p 8752

# 2) 에이전트 검사까지 — 에이전트 9개를 켜고 앱에서 '에이전트 검사'를 고릅니다
python agents/run_agents.py          # 로그는 agents/.data/logs/<이름>.log
cd frontend && npm run dev -- -H 127.0.0.1 -p 8752
```

`conda activate`가 안 먹는 터미널에서는 경로를 직접 줘도 됩니다.

```bash
"$HOME/miniforge3/envs/dev/python.exe" agents/run_agents.py   # Windows
```

매번 적기 번거로우면 `agents/.env`에 **`PG_PYTHON`**으로 그 경로를 한 번 적어 두면 됩니다. 그러면 어느 파이썬으로 런처를 불러도 자식 에이전트는 그 파이썬으로 뜹니다.

`python agents/run_agents.py guide color`처럼 이름을 적으면 일부만 켭니다. 끄는 것은 Ctrl+C 한 번이면 전부 내려갑니다.

### 공개 사이트에 내 에이전트를 붙여 쓸 때

[공개 배포](#공개-배포) 구성으로 쓰는 경우, **에이전트와 터널은 한 쌍입니다.** 둘 중 하나만 켜면 공개 사이트에서 에이전트가 안 보입니다. 둘은 각자 창을 붙잡고 있어서 한 창에서 같이 켤 수 없으므로 **터미널 두 개**에 각각 띄웁니다.

**켜는 폴더가 둘이 다릅니다.**

| | 폴더 | 왜 |
|---|---|---|
| 에이전트 | **저장소 루트** — 이 README가 있는 폴더 | `agents/run_agents.py`는 상대 경로다. 다른 데서 치면 `can't open file`이 난다 |
| 터널 | **아무 폴더에서나** | cloudflared는 현재 폴더를 보지 않는다. 터널 설정을 `%USERPROFILE%\.cloudflared\config.yml`에서 읽으므로 어디서 쳐도 같다 |

```bash
# 터미널 1 — 저장소 루트로 가서
cd <저장소를 클론한 폴더>        # 예: cd ~/Documents/PrintGuard-AI
conda activate dev
python agents/run_agents.py

# 터미널 2 — 폴더는 상관없습니다
cloudflared tunnel run printguard
```

`cloudflared: command not found`가 나면 PATH에 없는 것입니다. **설치 폴더로 옮겨 가서 치거나**(Windows 기본값 `C:\Program Files (x86)\cloudflared`) 실행 파일을 전체 경로로 부릅니다.

```bash
cd "/c/Program Files (x86)/cloudflared"      # Git Bash
./cloudflared tunnel run printguard
```

증상으로 어느 쪽이 꺼졌는지 가릅니다.

| 증상 | 꺼진 것 |
|---|---|
| `curl http://127.0.0.1:8700/health`가 응답 없음 | 에이전트 |
| 로컬은 되는데 `https://pg.2taeyoon.com`이 **530** | 터널 — 아직 아무 터널도 붙지 않았다는 뜻 |
| 로컬도 응답이 없고 `https://pg.2taeyoon.com`이 **502** | 에이전트 — 터널은 PC까지 닿았는데 8700이 대답을 안 한다 |
| 로컬도 터널도 되는데 화면만 안 붙음 | CORS(`agents/.env`의 `PG_CORS_ORIGIN_REGEX`) 확인 |

#### 터널을 서비스로 등록해 두기

터널은 에이전트와 달리 수명을 길게 둘 수 있습니다. Windows 서비스로 등록하면 **PC를 켤 때 알아서 뜨고, 창을 닫아도 안 죽습니다.** 그 뒤로 손으로 켤 것은 에이전트 하나로 줄어듭니다 — 대개 꺼져 있는 쪽이 에이전트인 이유입니다.

**관리자 권한 터미널**에서 한 번만 합니다. 폴더는 상관없습니다.

```powershell
cloudflared service install
```

터널 이름을 따로 줄 필요는 없습니다. 서비스가 `%USERPROFILE%\.cloudflared\config.yml`을 그대로 읽어 돕니다. 그래서 **그 파일을 고쳤으면 서비스를 다시 시작해야 반영됩니다.**

확인과 멈춤·되살리기는 서비스로 다룹니다(멈춤·되살리기·해제는 관리자 권한).

```powershell
sc query cloudflared              # RUNNING인지. 이름을 못 찾으면 sc query state= all | findstr -i cloudflared
net stop cloudflared              # 멈춤
net start cloudflared             # 되살리기
cloudflared service uninstall     # 등록 해제
```

**서비스가 돌고 있으면 `cloudflared tunnel run`을 따로 치지 마세요.** 같은 터널에 두 프로세스가 붙어 요청이 둘로 갈립니다. 긴가민가하면 `tasklist | findstr cloudflared`로 먼저 셉니다.

테스트: `python -m pytest agents -q` (122개)
타입·린트·빌드: `cd frontend && npx tsc --noEmit && npx eslint app lib && npm run build`

### MCP (선택)

밖의 LLM 클라이언트가 검수를 쓰게 합니다. 에이전트를 먼저 켭니다.

```bash
claude mcp add printguard -- "$(conda run -n dev python -c 'import sys;print(sys.executable)')" -m pg_agents.mcp_server
```

cwd는 `agents/`여야 합니다. 읽기 도구 7개와 쓰기 도구 1개(보고서 작성)를 내보냅니다. 쓰기 도구는 safety 관문을 거치고, 사람 승인(C 등급)은 MCP가 대신할 수 없습니다 — 웹 화면에서 사람이 승인합니다.

**같은 PC라면 토큰이 필요 없습니다.** MCP 클라이언트가 이 프로세스를 직접 띄우고(stdio), 서명 비밀
파일을 읽을 수 있다는 것이 곧 이 PC의 주인이라는 뜻이라, 오케스트레이터에 낼 토큰을 스스로 만듭니다.

MCP에는 **구글 로그인이 필요 없습니다.** 로그인 창을 띄울 브라우저가 없어서, 대신 같은 PC라는 사실이나 미리 발급한 토큰으로 주인을 가립니다.

**다른 PC에서 터널을 넘어 붙일 때는** 에이전트를 돌리는 PC에서 토큰을 발급해 옮깁니다.

```bash
cd agents
python -m pg_agents.mktoken --label claude-desktop --days 90          # 조회만
python -m pg_agents.mktoken --label cursor --days 30 --write          # 보고서 작성까지
```

발급한 값은 **다시 볼 수 없습니다**(서버가 저장하지 않고 서명만 확인합니다). 한꺼번에 무효로 만들려면
`agents/.data/auth_secret`을 지우고 다시 켭니다. 토큰은 클라이언트의 `PG_TOKEN`에, 주소는
`PG_ORCHESTRATOR_URL`에 넣습니다.

MCP 서버 자체를 주소로 열 수도 있습니다(`PG_MCP_TRANSPORT=streamable-http`, `PG_MCP_PUBLIC_URL` 필수).
그때는 공개 주소에 놓이므로 **인증 없이는 뜨지 않고**, 받은 Bearer 토큰을 오케스트레이터에 그대로
넘깁니다 — 조회 전용 토큰이 중간에서 쓰기 권한을 얻는 일이 없게 합니다. 또 `check_pdf(path=…)`가
막히고 `content_base64`로 올려야 합니다: `path`는 '서버 PC의 파일'을 뜻해서, 멀리서 부르는 쪽이 남의
PC 파일을 고르는 길이 되기 때문입니다.

## 인디자인 원본 수정 (DesignCraft MCP)

검수는 PDF로 하지만 **고칠 수 있는 것은 원본뿐입니다.** DesignCraft에서 PDF는 배치만 되고 글자를
집을 수 없습니다(editable vectors 미지원).

그래서 **편집 파일로 맡긴 검수만** 고치는 데까지 갑니다. 인쇄 검수에 `.idml`을 올리면 designcraft가
열어 검수용 PDF를 뽑고, 그 PDF로 검수한 다음, 교정 제안이 있으면 검수가 끝난 자리에서 *"원본에 바로
반영할까요?"*를 묻습니다(plan의 마지막 단계, `input-required`). PDF로 맡긴 검수에는 고칠 원본이 없어
그 단계가 **아예 서지 않습니다** — 설 수 없는 단계를 세워 두고 매번 실패시키지 않습니다.

전에는 화면이 둘이었습니다(검수에서 교정 목록을 복사 → '원본 수정'에 붙여넣기). 그 붙여넣기는
사람이 하던 일이지 기계가 못 할 일이 아니어서 없앴습니다. 비어 있는 '원본 수정' 자리는
**작업 만들기**(`/make`)가 되었습니다 — 원본이 아예 없는 사람을 위한 자리입니다.

만드는 일은 **클로드·커서가 MCP로** 합니다(`make_document` → `edit_document`). 만들 때 `name`에
`홍길동_명함`처럼 **부탁한 것이 드러나는 이름**을 주면 그대로 파일 이름이 됩니다(안 주면 `새 문서.idml`입니다).
화면이 하는 일은
둘입니다. 하나는 **글로 따라 보기** — 엔진이 걸음마다 남기는 기록(`dc_step`)을 되풀이해 물어
'글 넣기 "ATELIER" · 1쪽 · 왼쪽에서 12mm…'처럼 **채팅방처럼** 쌓습니다. 또 하나는 **넘기기** —
그 문서를 **패키지(zip)**·IDML·PDF로 받거나 그대로 인쇄 검수로 보냅니다. 패키지에는 편집 파일과 함께
쓴 사진(`Links/`)과 글꼴(`Document Fonts/`)이 담깁니다 — IDML은 사진을 담지 않고 경로로 가리키기만 해서,
편집 파일 하나만 내주면 받은 사람 쪽에서 링크가 끊깁니다(올릴 때 폴더째 받는 것과 같은 이유입니다).

**넣을 것도 누를 것도 없습니다**(`GET /designcraft/feed`). 처음에는 문서 번호를 붙여 넣어야 보였는데,
그 번호는 클로드의 답에만 찍히므로 매번 거기서 복사해 와야 했습니다 — 정작 보고 싶은 것은 '지금 뭐
하고 있나' 하나인데 그 사이를 번호 칸이 막고 있었습니다.

번호 없이 열어 주는 근거는 **같은 PC**입니다. stdio로 띄운 MCP 서버(클로드·커서)는 띄운 사람이
주인이고, 그 주인 이름은 서명 비밀에서 뽑은 고정값입니다(`auth.tool_subject`). 그 서버가 도는 PC와
오케스트레이터가 도는 PC는 같으므로, 그 PC의 브라우저 앞에 앉은 사람은 그 도구를 쓰는 본인입니다.
바깥에서 들어온 요청에는 이 문이 열리지 않습니다 — 그쪽은 번호를 들고 와야 합니다
(`POST /designcraft/{ctx}/adopt`). 가져가도 원래 주인은 **밀려나지 않습니다**(밀어내면 클로드가
그 문서를 이어서 못 고칩니다).

한때 이 자리에 DesignCraft **웹 편집기**(릴리스의 `designcraft-web-*.zip`)를 띄워 봤지만 걷어냈습니다 —
브라우저 안에서 혼자 도는 프로그램이라 바깥에서 조종할 수도 들여다볼 수도 없고(글루 JS에
`postMessage`도 `WebSocket`도 없습니다), 거기서 손으로 만든 것이 에이전트에게 가지 않았습니다.
62MB짜리 wasm을 내려받아 가며 띄울 값이 없었습니다.

| 포맷 | 열기 | 돌려주기 |
|---|---|---|
| `.idml` · `.designcraft` | O | O (같은 형식 + PDF) |
| `.indd` · `.indt` | **받지 않습니다** | — INDD로 돌려줄 수 없어서입니다. IDML로 내보내 올립니다 |
| `.pdf` | — | 받지 않습니다(고칠 수 없어서) |

### 무엇을 올리나 — 파일 하나보다 폴더

IDML은 **사진을 링크로만** 들고 있습니다. 파일 하나만 올리면 인쇄용 사진이 따라오지 않아
`끊긴 이미지 링크`가 뜨고, 내보낸 PDF에서도 사진이 빠집니다. 화면에 보이는 그림은 IDML이
품고 있는 저해상 미리보기라 인쇄에는 못 씁니다.

InDesign에서 **파일 → 패키지**로 만든 폴더를 통째로 올리면 그대로 열립니다.

```
내 잡지 폴더/
  magazine.idml
  Links/              ← 사진. DesignCraft가 IDML 옆이나 이 폴더에서 찾는다
    cover.jpg
  Document fonts/     ← 글꼴. 있으면 대체 글꼴 문제도 사라진다
```

글자 교정만 하고 고친 IDML만 받으실 거면 파일 하나로도 충분합니다.

### 설치

[DesignCraft](https://github.com/storytold/designcraft)의 `designcraft-cli`가 **에이전트를 돌리는 PC에**
있어야 합니다. MCP는 stdin/stdout으로만 말해서 브라우저가 직접 부를 수 없고, 이 PC에서 프로세스를
띄워 파이프로 말하는 수밖에 없습니다(Claude 데스크톱이 하는 것과 같습니다).

릴리스의 Windows portable zip이나 MSI에 CLI가 같이 들어 있습니다. 푼 다음 `designcraft-cli.exe`를
기본 위치에 두면 설정 없이 찾습니다.

```
%LOCALAPPDATA%\Programs\ArtCraft\DesignCraft\designcraft-cli.exe   # Windows 기본
/Applications/DesignCraft.app/Contents/MacOS/designcraft-cli           # macOS
/usr/bin/designcraft-cli                                               # Linux
```

다른 데 두었으면 `agents/.env`에 경로를 적습니다. PATH에 있으면 그것도 씁니다.

```
PG_DESIGNCRAFT_CLI=D:\tools\designcraft\designcraft-cli.exe
```

화면 위쪽 **DesignCraft MCP 연결**에 버전·프로토콜·도구 수가 뜨면 된 것입니다. 안 되면 왜 안 되는지
같이 나옵니다.

### 교정 목록은 어디서 오나

| 검사 방식 | 교정 짝(원래 내용 → 수정할 내용) |
|---|---|
| 바로 검사 | 오용·외래어 표기 사전으로 브라우저에서 찾습니다 |
| 에이전트 검사 | 위 사전 + Kiwi 오타 모델 + (키를 넣으면) LLM 문맥 교정 |

사전은 `frontend/public/data/korean-misuse.json` **하나**입니다. 파이썬 교정 에이전트와 브라우저가
같은 파일을 읽습니다 — 한쪽에만 낱말을 더하면 두 검사 방식의 결과가 갈립니다.

여백 부족·수치 불일치처럼 **사람이 판단할 항목에는 짝이 없습니다.** 복사한 글에 주석으로 따로 적습니다.

### 어떻게 고치나

교정 한 건마다 `find.find`로 **다시 찾고** `story.replaceRange`로 바꿉니다. 미리 위치를 모아 두지
않는 이유는 한글이 글자당 3바이트여서 앞을 고치면 뒤가 전부 밀리기 때문입니다. 다시 찾으면 밀린
위치가 저절로 따라옵니다.

**같은 문구가 여러 군데면 고치지 않고 실패로 남깁니다.** 어느 것인지 가릴 수 없는데 찍어서 고치면
조용히 틀립니다. 교정 줄에 쪽 번호를 적어 주면 그 쪽에서만 찾습니다.

고친 뒤 한 번 더 `preflight.run`을 돌립니다. 교정이 새 문제를 만들 수 있어서입니다 — 한글을 라틴
글꼴 자리에 넣으면 글리프가 없고, 글이 길어지면 넘칩니다.

### 원본으로만 알 수 있는 것

`preflight.run`은 **PDF만 봐서는 알 수 없는 것들**을 잡습니다. 넘친 글자는 PDF에 아예 안 찍히고,
끊긴 이미지는 빈 칸으로 보일 뿐이며, 폰트는 이미 대체가 끝난 상태입니다.

`overset`(넘침) · `missingFont` · `missingGlyphs` · `missingLink` · `lowResolution` · `emptyText` · `rgbColor`

반대로 CMYK 색 차이(ΔE)·총 잉크량은 PDF를 래스터화해야 나오므로 기존 검수가 맡습니다. 원본만
올리면 DesignCraft가 PDF를 직접 뽑아 주므로 **판본이 어긋날 일이 없습니다.**

### 한계

- **글꼴이 1순위 위험입니다.** 원본이 쓰는 글꼴이 이 PC에 없으면 대체 글꼴로 열립니다. 글자 너비가
  달라져 줄바꿈과 넘침이 원본과 다르게 보이고, 내보낸 PDF도 그만큼 달라집니다. 화면에 경고로 띄웁니다.
- **INDD는 받지 않습니다.** 엔진은 읽을 수 있습니다(indd-utils가 IDML로 바꿔 주고, 자체 측정으로
  스토리 37,156개 중 37,153개가 글자까지 일치하며 변환 실패 0건입니다). 그래도 받지 않는 이유는
  **고친 결과를 INDD로 돌려줄 수 없어서**입니다 — 올린 사람이 자기 작업 파일을 못 돌려받습니다.
  반쪽만 되는 것을 되는 것처럼 두면 올려 보고 나서야 알게 됩니다. InDesign에서 IDML로 내보내 올립니다.
- **올린 원본은 그대로 두고 건드리지 않습니다.** 결과는 작업 폴더에만 씁니다.
- 표 안의 글자는 아직 고치지 않습니다.
- MCP는 **의뢰 하나에 프로세스 하나**를 씁니다. 열린 문서가 서버 전체의 상태라 두 의뢰가 같이 돌면
  서로의 문서를 덮어씁니다. 시작에 1초쯤 걸립니다.
- 파일 접근은 `--automation-read-root`/`--write-root`로 의뢰 폴더에 가둡니다. 읽기는 올린 원본이 있는
  폴더와 작업 폴더만, 쓰기는 작업 폴더만입니다.

### 같은 MCP를 클로드·커서에 직접 붙이기

화면의 1번(DesignCraft MCP 연결)은 **DesignCraft 자체 기능**이고, 2·3·4는 그 위에 PrintGuard가 올린
화면입니다. 그래서 같은 MCP를 AI 코딩 도구에 바로 붙여 대화로 고치게 할 수도 있습니다 — 도구 26개가
그대로 붙어서 `file.openIdml` → `find.change` → `file.exportPdf`를 스스로 합니다.

```bash
claude mcp add designcraft -- designcraft-cli mcp \
  --automation-read-root  C:\work\idml \
  --automation-write-root C:\work\out
```

> **두 폴더를 빼면 디스크 전체가 열립니다.** 문서의 "Without either flag nothing changes"는 *가두지
> 않는다*는 뜻입니다. 실제로 확인해 보니, 플래그 없이 띄운 MCP가 임의의 폴더에 있는 IDML을 읽고
> `%LOCALAPPDATA%\Temp`에 PNG를 **썼습니다**. 그래서 `mcp_client.py`는 두 폴더가 없으면 프로세스를
> 아예 띄우지 않습니다.

직접 붙이면 이 저장소가 하던 것들은 빠집니다 — 같은 글자가 여러 쪽에 있을 때 쪽으로 가리기, 한 건
고칠 때마다 다시 찾기(한글은 한 자가 3바이트라 한 번 바꾸면 뒤쪽 바이트 위치가 모두 밀립니다),
항목별 실패 이유, safety 관문, 고친 뒤 preflight 재검사. 한두 건이면 직접 붙이는 편이 빠르고, 검수
결과 전부를 그대로 반영할 때는 화면 쪽이 안전합니다.

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
- 가이드 검색 모델과 onnxruntime wasm은 저장소에 없으면 CDN에서 받아 옵니다. 첫 검색에서 약 135MB(모델 118MB + 토크나이저 17MB)를 내려받아 느립니다.
- **ICC 프로파일은 공개 사이트에 올리지 않습니다**(재배포가 허용되지 않습니다). 색 차이를 재려면 방문자가 인쇄소에서 받은 `.icc` 파일을 화면에서 직접 올려야 합니다.
- 에이전트 주소는 화면에 적지 않습니다. 빌드할 때 박힌 `NEXT_PUBLIC_PG_ORCHESTRATOR` 하나만 씁니다 — 주소를 입력하는 칸은 들어오는 사람 아무에게나 그 주소를 적어 보여 주는 자리였습니다. 다만 **주소 자체가 숨겨지는 것은 아닙니다**(브라우저가 거기로 요청을 보내니 개발자도구에는 보입니다). 막는 일은 오케스트레이터의 토큰 검사와 CORS가 합니다.

컨테이너로 올리고 싶으면 `deploy/hf-space/Dockerfile`이 에이전트 9개를 한 컨테이너에 담습니다(`PG_HOST=0.0.0.0`, `PORT`로 오케스트레이터 포트를 받습니다).

## 구글 로그인 설정

**로그인은 선택입니다** — 클라이언트 ID가 없어도 검수는 전부 됩니다. 다만 로그인 단추가 열리지 않아
기록이 그 브라우저를 벗어나지 못합니다.

1. [Google Cloud 콘솔](https://console.cloud.google.com/auth/clients) → **OAuth 클라이언트 ID 만들기** → **웹 애플리케이션**
2. **승인된 JavaScript 원본**에 앱 주소를 넣습니다 — `https://<배포 주소>`, `http://localhost:8752`, `http://127.0.0.1:8752`.
   리디렉션 URI는 넣지 않습니다. ID 토큰만 받는 방식이라 되돌아올 주소가 없습니다.
3. **브랜딩** 화면에 홈페이지·개인정보처리방침(`/privacy`)·이용약관(`/terms`) 주소를 넣고, **대상(Audience)** 화면에서 **앱 게시**를 눌러 프로덕션으로 올립니다. `테스트 중`으로 두면 거기 적힌 테스트 사용자만 로그인됩니다(기본 범위 openid·email·profile만 쓰므로 검토 절차는 없습니다).
4. 받은 클라이언트 ID를 `agents/.env`의 `PG_GOOGLE_CLIENT_ID`에 넣고 에이전트를 다시 켭니다.

```ini
# agents/.env
PG_GOOGLE_CLIENT_ID=<클라이언트 ID>.apps.googleusercontent.com
```

`.env`는 커밋되지 않습니다. **에이전트를 켜는 PC마다 이 줄을 넣어야 합니다.**

클라이언트 ID는 **비밀이 아닙니다** — 브라우저가 화면에 들고 다니는 값입니다. 클라이언트 비밀번호는 쓰지 않습니다.
브라우저는 이 값을 에이전트에게 물어서(`GET /auth/config`) 가져옵니다. 앱은 한 번 배포해 두고 에이전트는 사람마다
자기 PC에서 켜기 때문에, 앱에 박아 두면 다른 사람이 자기 에이전트를 쓸 때 ID를 바꿀 길이 없어서입니다.
앱에 박아 둔 `NEXT_PUBLIC_GOOGLE_CLIENT_ID`는 에이전트가 답하지 못할 때의 대비책입니다.

전부 무효로 만들려면 `agents/.data/auth_secret`을 지우고 다시 켭니다.

## 선택: 키를 넣어야 쓰는 기능

`agents/.env.example`을 `agents/.env`로 복사해 값을 채웁니다(`.env`는 커밋되지 않습니다). 터미널에 이미 설정된 환경변수가 있으면 그 값이 이깁니다.

```bash
cp agents/.env.example agents/.env      # Windows: copy agents\.env.example agents\.env
```

```ini
# agents/.env
ANTHROPIC_API_KEY=발급받은_키          # 기본. 모델은 claude-sonnet-5-5
PG_PROOF_METHODS=rules,kiwi_typo,llm
LANGSMITH_API_KEY=발급받은_키
LANGSMITH_PROJECT=printguard
```

| 기능 | 환경변수 | 받는 곳 | 쓰는 법 |
| --- | --- | --- | --- |
| LLM 교정 제안(규칙·Kiwi에 더해) | `ANTHROPIC_API_KEY`, 모델은 `ANTHROPIC_LLM_MODEL`(기본 `claude-sonnet-5-5` — `sonnet 5.5`처럼 적어도 알아듣습니다), 깊이는 `PG_LLM_EFFORT`(기본 `low`), `PG_PROOF_METHODS` | [Claude Platform](https://platform.claude.com/) → API keys | `.env`에 넣고 `python agents/run_agents.py` |
| 〃 (받쳐 주는 길) | `GEMINI_API_KEY`, 모델은 `PG_LLM_MODEL`(기본 `gemini-3.5-flash-lite`) | [Google AI Studio](https://aistudio.google.com/apikey) | `ANTHROPIC_API_KEY`가 비었을 때, 그리고 **Claude 잔액이 바닥났을 때** 이쪽으로 넘어갑니다. 무료 등급은 분당 횟수 한도가 있어 쪽이 많은 문서에서는 느립니다 |
| LLM 교정기 정량평가 | 위와 같음 | 위와 같음 | `python eval/proofread/eval_proofread.py` (키가 있으면 LLM 조합이 표에 더해집니다. API 호출 121회 — 무료 등급 하루 한도 안, 분당 한도에 걸리면 기다렸다 다시 부릅니다) |
| 추적을 LangSmith로 보내기 | `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`(기본 `printguard`) | [LangSmith](https://smith.langchain.com) → Settings → API Keys | `cd agents && python -m pg_agents.langsmith_export <context_id>` |

`.env`를 읽는 곳은 `run_agents.py`(자식 에이전트까지 물려 줍니다), `pg_agents.mcp_server`, `pg_agents.langsmith_export`, 교정 평가 스크립트입니다. 앱(브라우저) 쪽 설정은 Next.js 규칙대로 `frontend/.env.local`에 둡니다 — 오케스트레이터 주소(`NEXT_PUBLIC_PG_ORCHESTRATOR=http://127.0.0.1:8700`)와 구글 클라이언트 ID의 대비책(`NEXT_PUBLIC_GOOGLE_CLIENT_ID`) 둘입니다.

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
- 기본값은 로컬 조합입니다. LLM을 켜면 PDF 본문이 외부 API로 나가므로(앱의 나머지 계산은 모두 기기 안) `PG_PROOF_METHODS`로 직접 켜야 합니다. LLM 교정기와 LangSmith 추적은 사용자가 `ANTHROPIC_API_KEY`(또는 `GEMINI_API_KEY`)·`LANGSMITH_API_KEY`를 직접 넣을 때만 씁니다 — 키를 찾거나 읽지 않습니다.
- 오케스트레이터의 의뢰 목록은 **공통 로그와 같은 SQLite 파일**(`job_store` 표)에 남고 켤 때 다시 올라옵니다. 남기는 것은 **끝난 의뢰**와 **만든 문서**뿐입니다 — 돌던 중에 꺼진 의뢰는 멈춘 자리(`Job.pending`)가 함수라 적어 둘 수 없고, 적어 둔 척하면 '이어서'가 아무 일도 하지 않습니다. 만든 문서는 원본 폴더(`SRC/<src_ref>`)가 남아 있는 것만 올립니다.
- 의뢰와 소통 기록은 **그것을 넣은 쪽에만** 보입니다. 에이전트는 PC 한 대인데 공개 주소로는 누구나 들어오므로, 오케스트레이터가 토큰 속 주인이 맞는 의뢰만 돌려줍니다. 업로드한 PDF 자체는 애초에 내려받을 수 있는 주소가 없습니다.
- **로그인 전**에는 서버가 난수로 만든 익명 토큰을 내주고(`POST /auth/session`) 브라우저가 `localStorage`에 둡니다. 누구인지는 담기지 않고, 기한이 있습니다(기본 12시간).
- **로그인은 구글 하나**입니다(`POST /auth/google`). ID 토큰의 서명·발급자·청중(클라이언트 ID)·기한을 확인하고 계정에 묶인 토큰으로 바꿉니다. 비밀번호는 지나가지 않습니다. 받아 두는 것은 계정 번호와 이름·이메일·사진뿐이고, 계정 번호는 서버 비밀로 해시해서 씁니다 — 의뢰 기록과 로그에 남는 값이라, 그대로 쓰면 계정 번호가 같이 남습니다. 이름·이메일·사진은 화면 표시용이라 서버에 저장하지 않습니다. 검사에는 쓰지 않습니다.
- **로그인하는 순간 그 전에 한 것이 계정으로 옮겨 갑니다**(`POST /auth/claim`). 들고 있던 익명 토큰을 그대로 내밀어 권리를 증명하고(번호만 알면 남의 것을 가져갈 수 있어서는 안 됩니다), 옮긴 뒤 로컬의 익명 토큰은 지웁니다. 로그인한 토큰은 **기한과 함께 `localStorage`(`pg.sess`)에 둡니다** — 처음에는 두지 않고 새로 고칠 때마다 구글에 조용히 다시 물었는데, 그 자동 재로그인(FedCM)이 브라우저 설정에 따라 조용히 실패해서 새로 고치면 로그인이 풀린 것처럼 보였습니다. 기한이 지난 것은 읽지 않고, 로그아웃과 401에서 지웁니다.
- 처음에는 브라우저가 `crypto.randomUUID()`로 **스스로** 만든 값을 `localStorage`에 영구히 두고 주인 표시로 썼습니다. 서버가 발급하지 않으니 기한도 회수도 없었습니다. 지금 거기 있는 값은 서버가 발급해 서명한 토큰이고, 기한이 있으며, 로그인하면 지워집니다.

## 데이터 출처

한국제지연합회 「종이의 분류」, 두성종이·삼원페이퍼 제품 페이지와 국내 제지사 공식 제품 페이지, 행정안전부 LOCALDATA 기타_인쇄사(공공누리 출처표시), 파주출판도시 입주기업협의회, Kodak 공개 테스트 사진. 화면의 **출처** 탭에 논문·데이터·모델·라이브러리를 전부 적어 두었습니다.
