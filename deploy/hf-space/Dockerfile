# PrintGuard-AI 에이전트 메시 — Hugging Face Space(Docker)용 한 컨테이너
#
# 왜 한 컨테이너인가: 에이전트 9개는 서로 http로 부르며 계속 떠 있어야 한다(요청 때만 깨는 함수로는 안 된다).
# 저장소를 빌드 때 통째로 받아 쓰므로, 이 Space에는 이 Dockerfile과 README만 두면 된다.
#
# 담지 않는 것: ICC 프로파일과 임베딩 모델은 저장소에 없다. 빌드할 때 각자의 배포처에서 받는다
# (프로파일은 컨테이너 안에서 쓰기만 하고 밖으로 내보내지 않는다 — 재배포가 아니다).
FROM python:3.12-slim

ARG REPO=https://github.com/2taeyoon/PrintGuard-AI
ARG REF=main

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PG_HOST=0.0.0.0 \
    PORT=7860 \
    PG_DATA_DIR=/home/user/data \
    HF_HOME=/home/user/.cache/huggingface \
    PG_CORS_ORIGIN_REGEX="https://.*\\.vercel\\.app|http://(127\\.0\\.0\\.1|localhost):[0-9]+"

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 user
USER user
ENV PATH=/home/user/.local/bin:$PATH
WORKDIR /home/user/app

RUN git clone --depth 1 --branch ${REF} ${REPO} . \
 && mkdir -p /home/user/data

# 파이썬 에이전트(토치 없음 — 가이드 검색은 onnxruntime로 int8 모델을 돌린다)
RUN pip install --user --no-warn-script-location -r agents/requirements.txt

# Node 에이전트(preflight·color·paper)는 frontend의 의존성으로 돈다
RUN cd frontend && npm ci --no-audit --no-fund

# 색 변환에 쓰는 공개 ICC 프로파일 12개(ECI·ICC 레지스트리에서 받아 컨테이너 안에만 둔다)
RUN python deploy/fetch_icc.py

# 가이드 검색 모델(브라우저가 쓰는 것과 같은 int8 ONNX)을 미리 받아 둔다 — 첫 요청이 빨라진다
RUN python -c "from huggingface_hub import hf_hub_download as d; r='Xenova/multilingual-e5-small'; d(r,'tokenizer.json'); d(r,'onnx/model_quantized.onnx')"

EXPOSE 7860
CMD ["python", "agents/run_agents.py"]
