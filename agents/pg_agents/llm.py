"""Gemini를 부르는 한 자리.

전에는 교정(`proofread/detectors.py`) 안에만 있었다. 작업 만들기도 LLM을 쓰게 되면서 두 곳이
되었으므로 여기로 옮긴다 — 모델 이름과 분당 한도 대응이 두 군데로 갈라지면 한쪽만 고치게 된다.

**열쇠가 없으면 아무 일도 하지 않는다.** LLM은 늘 선택이다. 켜지 않은 사람에게도 앱은 그대로
돌아야 하고, 켤지 말지는 에이전트를 돌리는 쪽이 환경변수로 정한다(`GEMINI_API_KEY`).
"""
from __future__ import annotations

import os

class TruncatedAnswer(RuntimeError):
    """답이 길이 한도에 걸려 끝나기 전에 끊겼다. 받은 조각을 `args[0]`에 담는다."""


DEFAULT_MODEL = "gemini-3.5-flash-lite"      # 무료 등급이 있는 모델


def have_key() -> bool:
    return bool(os.environ.get("GEMINI_API_KEY"))


def gemini(prompt: str, key: str, *, tries: int = 4, temperature: float = 0.0,
           max_tokens: int | None = None) -> str:
    """기본 모델은 무료 등급이 있는 flash-lite. 분당 한도(429)에 걸리면 Retry-After만큼 기다렸다 다시 부른다.

    `max_tokens`를 주면 답 길이 한도를 그 값으로 올린다. 긴 답(명령 스무 개짜리 JSON)은 기본
    한도에서 **중간에 잘린다** — 잘린 JSON은 읽히지 않아 '아무것도 못 알아들었다'로 보인다.
    """
    import time

    import httpx
    model = os.environ.get("PG_LLM_MODEL", DEFAULT_MODEL)
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    cfg: dict[str, object] = {"temperature": temperature}
    if max_tokens:
        cfg["maxOutputTokens"] = int(max_tokens)
    body = {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": cfg}
    for i in range(tries):
        r = httpx.post(url, params={"key": key}, json=body, timeout=60)
        if r.status_code == 429 and i < tries - 1:
            wait = float(r.headers.get("Retry-After") or 5 * 2 ** i)
            print(f"[llm] 분당 한도(429) — {wait:.0f}초 기다립니다", flush=True)
            time.sleep(wait)
            continue
        r.raise_for_status()
        c = (r.json().get("candidates") or [{}])[0]
        txt = "".join(p.get("text", "") for p in ((c.get("content") or {}).get("parts") or []))
        # 한도에 걸려 끊긴 답은 끊겼다고 알려 준다. 조용히 돌려주면 부르는 쪽이 '못 알아들었다'로 읽는다.
        if c.get("finishReason") == "MAX_TOKENS":
            raise TruncatedAnswer(txt)
        return txt
    raise RuntimeError("Gemini 분당 한도를 넘겨 포기했습니다")  # 여기까지 오지 않는다(마지막 시도는 raise_for_status)
