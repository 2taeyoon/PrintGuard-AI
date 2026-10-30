---
title: PrintGuard-AI Agents
emoji: 🖨️
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
short_description: PrintGuard-AI의 로컬 에이전트 메시(A2A)를 그대로 올린 서버
---

# PrintGuard-AI 에이전트

인쇄 전 PDF 검수 앱 [PrintGuard-AI](https://github.com/2taeyoon/PrintGuard-AI)의 에이전트 9개를 한 컨테이너에서 띄웁니다.
바깥에 열리는 창구는 **오케스트레이터 하나**(`/health`, `/jobs`, `/agents`, `/logs`, `/trace`, `/guide`)이고,
나머지 여덟(안전 관문·사전 검사·색·종이·가이드·교정·인쇄소·보고서)은 컨테이너 안에서만 서로 부릅니다.

| 길 | 하는 일 |
|---|---|
| `GET /health` | 살아 있는지 |
| `GET /agents` | 에이전트와 각자 할 수 있는 일(skill)·등급 |
| `POST /jobs` | PDF를 맡긴다(검수 의뢰) |
| `GET /jobs/{context_id}` | 의뢰 진행과 결과 |
| `GET /logs`, `GET /trace` | 공통 로그와 의뢰 추적(입력 본문은 남기지 않습니다) |
| `GET /guide?q=` | 인쇄 가이드 검색 |

## 알아 둘 것

- **PDF가 이 서버로 올라옵니다.** 브라우저 안에서만 처리하는 '바로 검사' 모드와 다릅니다.
- 저장은 컨테이너 안에서만 이뤄지고, 컨테이너가 다시 뜨면 기록(공통 로그·관문 기록)은 사라집니다.
- ICC 프로파일과 임베딩 모델은 저장소에 없고 빌드할 때 각 배포처(ECI·ICC 레지스트리·Hugging Face)에서 받습니다.
- 견적·주문 같은 돈이 오가는 기능은 없습니다. 인쇄소는 공공 인허가 데이터에서 찾아 주기만 합니다.
