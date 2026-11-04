# 되살리기

꺼진 걸 다시 켜는 것만 다룹니다. 처음 설치하는 이야기는 [README의 설치](README.md#설치)에 있습니다.

A2A(에이전트 검사)가 돌려면 **에이전트 10개**와 **Cloudflare 터널**이 둘 다 떠 있어야 합니다. 둘은 수명이 다릅니다 — 에이전트는 터미널을 닫으면 죽고, 터널은 서비스로 등록해 두면 PC를 켤 때 알아서 뜹니다. 그래서 대개 꺼진 쪽은 에이전트입니다.

## 에이전트 10개 켜기

```bash
cd /c/Users/403/Documents/PrintGuard-AI
conda activate dev
python agents/run_agents.py
```

이 창은 그대로 붙잡고 있어야 합니다. Ctrl+C 한 번이면 10개가 같이 내려갑니다. 포트 10개가 다 열리기까지 10~30초쯤 걸리므로(guide가 임베딩 모델을 올립니다) 바로 확인해 보고 안 떴다고 판단하지 마세요.

`conda activate`가 안 먹는 터미널에서는 경로를 직접 줍니다. 결과는 같습니다.

```bash
/c/Users/403/miniforge3/envs/dev/python.exe agents/run_agents.py   # Git Bash
C:\Users\403\miniforge3\envs\dev\python.exe agents\run_agents.py   # PowerShell·cmd
```

**환경을 켜는 걸 빼먹으면 절반만 뜹니다.** `run_agents.py`는 자기를 실행한 파이썬으로 자식 에이전트를 띄웁니다. 의존성은 conda 환경 `dev`에만 있으므로, 시스템 파이썬(`C:\Users\403\AppData\Local\Programs\Python\Python312\python.exe`)이 잡히면 파이썬 7개가 전부 죽고 Node 3개(preflight·color·paper)만 살아남습니다. 런처 화면에 이렇게 찍힙니다.

```
[종료됨] orchestrator (코드 1) — agents\.data\logs\orchestrator.log 확인
```

그 로그 끝에 있는 문구가 판정입니다.

```
ModuleNotFoundError: No module named 'uvicorn'
```

이 상태가 고약한 건 포트 3개가 열려 있어서 "뜬 것처럼" 보이는데, 바깥 창구인 orchestrator(8700)가 없어서 앱에서는 아무것도 안 된다는 점입니다. 포트를 셀 때 10개인지 보는 이유입니다.

## 터널

**이미 떠 있으면 다시 띄우지 마세요.** 둘째 cloudflared는 같은 터널에 중복으로 붙어 요청이 두 프로세스로 갈립니다.

에이전트와 달리 **폴더는 상관없습니다.** cloudflared는 현재 폴더를 보지 않고 터널 설정을 `%USERPROFILE%\.cloudflared\config.yml`에서 읽습니다.

```bash
tasklist | findstr cloudflared          # 있으면 그걸로 끝. 아무것도 안 나오면 아래
cloudflared tunnel run printguard
```

매번 켜기 번거로우면 Windows 서비스로 등록해 두면 PC 켤 때 알아서 뜹니다 — [README의 터널을 서비스로 등록해 두기](README.md#터널을-서비스로-등록해-두기)에 명령이 있습니다.

## 지금 떠 있나 (한 줄씩)

```powershell
netstat -ano | findstr "LISTENING" | findstr ":870"   # 줄이 10개여야 합니다(8700~8709)
curl.exe -s http://127.0.0.1:8700/health              # {"status":"ok","agent":"orchestrator",...}
curl.exe -s http://127.0.0.1:8700/agents              # 9개가 "status":"on"인지
curl.exe -s https://pg.2taeyoon.com/health            # 공개 주소까지 확인
tasklist | findstr cloudflared                        # 터널
```

PowerShell에서는 `curl`이 `Invoke-WebRequest`의 별칭이라 `-s` 같은 플래그를 다르게 받습니다. **`curl.exe`로 적어야** 합니다. Git Bash에서는 그냥 `curl`이면 됩니다.

## 증상 → 꺼진 것

| 증상 | 꺼진 것 | 할 일 |
|---|---|---|
| `curl.exe -s http://127.0.0.1:8700/health`가 무응답 | 에이전트 | 위 "에이전트 10개 켜기" |
| 공개 주소가 **502** | 에이전트 (**터널은 정상**) | 위 "에이전트 10개 켜기" |
| 공개 주소가 **530** | 터널 | `cloudflared tunnel run printguard` |
| 포트는 10개가 아니라 3개 | 파이썬 7개가 죽음 | 환경을 켜고 다시 — 위 함정 절 |
| 로컬·터널 다 200인데 화면만 안 붙음 | CORS | `agents/.env`의 `PG_CORS_ORIGIN_REGEX` |

상태 코드 대신 `000`이 나오면 HTTP 응답을 아예 못 받은 것입니다(502·530과 달리 Cloudflare까지 가지도 못한 상태). 간헐적으로 나므로 먼저 한 번 더 해 보고, 계속 그러면 네트워크나 DNS를 봅니다.

**502와 530을 헷갈리면 엉뚱한 걸 고칩니다.** 둘 다 공개 주소에서 나지만 내는 주체가 다릅니다. 530은 Cloudflare가 "붙어 있는 터널이 없다"고 내는 값이라 에이전트를 아무리 켜도 안 바뀝니다. 502는 터널이 PC까지 잘 닿았는데 원본 `127.0.0.1:8700`이 대답을 안 해서 나는 값이라, 터널을 다시 띄워도 안 바뀝니다. **530이면 터널, 502면 에이전트**입니다.

## 프론트엔드

```bash
cd frontend && npm run dev -- -H 127.0.0.1 -p 8752
```

띄운 뒤 브라우저는 **`http://localhost:8752`로 엽니다.** Next dev 서버는 자기 호스트 이름이 아닌 출처에서 오는 `/_next/*` 요청을 막는데, `127.0.0.1:8752`로 열면 그 판정에 걸려 클라이언트 번들이 통째로 차단됩니다. 화면은 그려지지만 버튼이 하나도 안 눌리고 콘솔에 오류도 안 남아서 원인을 찾기 어렵습니다. `frontend/next.config.ts`의 `allowedDevOrigins`에 두 호스트를 모두 넣어 막아 두었지만, 습관은 `localhost`로 두는 편이 안전합니다.

에이전트를 안 켜도 프론트엔드는 뜹니다. 바로 검사 모드로 전부 동작하고, 에이전트 검사만 멈춥니다.

## 로그

`agents/.data/logs/<이름>.log` — 켤 때마다 새로 씁니다. 어느 에이전트가 왜 죽었는지는 전부 여기 있습니다.
