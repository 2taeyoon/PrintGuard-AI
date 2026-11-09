"""LLM을 부르는 한 자리. **기본은 Claude Sonnet 5.5**다.

왜 바꿨나. 무료 등급 Gemini로 돌리면 20쪽짜리 문서의 교정이 분당 한도(429)에 걸려 쪽마다
35초씩 기다렸다 결국 실패했다. 기다리는 사람은 검수가 끝나기를 기다리는 사람인데, 공짜로 쓰는
대가를 그 사람이 치르고 있었다. 열쇠를 바꾸면 그 줄서기가 없어진다.

두 길을 다 둔다. `ANTHROPIC_API_KEY`가 있으면 Claude로, 없고 `GEMINI_API_KEY`만 있으면 Gemini로
간다. **열쇠가 하나도 없으면 아무 일도 하지 않는다** — LLM은 늘 선택이고, 켜지 않은 사람에게도
앱은 그대로 돌아야 한다(규칙·Kiwi 교정은 열쇠 없이 돈다).

부르는 쪽은 `ask()` 하나만 쓴다. 모델 이름과 한도 대응이 두 군데로 갈라지면 한쪽만 고치게 된다.
"""
from __future__ import annotations

import os

# Sonnet 5.5. 빠르고(이게 바꾼 이유다) 한국어 교정에 충분하다.
CLAUDE_MODEL = "claude-sonnet-5-5"
GEMINI_MODEL = "gemini-3.5-flash-lite"      # 무료 등급이 있는 모델(둘째 길)


class TruncatedAnswer(RuntimeError):
    """답이 길이 한도에 걸려 끝나기 전에 끊겼다. 받은 조각을 `args[0]`에 담는다."""


class Refused(RuntimeError):
    """모델이 답하기를 거절했다. 까닭을 `args[0]`에 담는다."""


def provider() -> str:
    """지금 쓸 길. `""`면 열쇠가 없다는 뜻이고, 그러면 LLM 탐지는 아예 돌지 않는다."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    if os.environ.get("GEMINI_API_KEY"):
        return "gemini"
    return ""


def have_key() -> bool:
    return bool(provider())


def ask(prompt: str, *, max_tokens: int | None = None, tries: int = 4) -> str:
    """한 번 물어 글로 받는다. 열쇠에 따라 Claude나 Gemini로 간다.

    `max_tokens`를 주면 답 길이 한도를 그 값으로 올린다. 긴 답(명령 스무 개짜리 JSON)은 기본
    한도에서 **중간에 잘린다** — 잘린 JSON은 읽히지 않아 '아무것도 못 알아들었다'로 보인다.
    """
    p = provider()
    if p == "anthropic":
        return claude(prompt, max_tokens=max_tokens)
    if p == "gemini":
        return gemini(prompt, os.environ["GEMINI_API_KEY"], tries=tries, max_tokens=max_tokens)
    raise RuntimeError("LLM 열쇠가 없습니다. agents/.env에 ANTHROPIC_API_KEY를 넣어 주세요")


def claude(prompt: str, *, max_tokens: int | None = None) -> str:
    """Claude에 한 번 묻는다.

    세 가지를 일부러 이렇게 둔다.

    - **`temperature`를 보내지 않는다.** Sonnet 5.5는 기본값이 아닌 샘플링 값을 400으로 거절한다.
      (Gemini 시절에는 0.0을 넣어 두었는데, 그대로 옮겼으면 첫 호출부터 전부 실패했을 자리다.)
    - **생각을 끈다**(`between_tools`). 오탈자를 찾고 명령을 짜는 일은 오래 생각할수록 나아지는
      종류가 아니고, 여기서 기다리는 사람은 검수가 끝나기를 기다리는 사람이다. 더 깊게 보고
      싶으면 `PG_LLM_EFFORT`를 올린다(low·medium·high).
    - **되풀이는 SDK에 맡긴다.** 429와 5xx는 SDK가 백오프로 다시 부른다. 손으로 재던 자리를
      지웠다 — 두 곳에서 기다리면 기다린 시간이 더해진다.
    """
    try:
        import anthropic
    except ImportError as e:  # noqa: F841
        raise RuntimeError(
            "anthropic 패키지가 없습니다. 에이전트를 돌리는 PC에서 `pip install anthropic`을 한 번 해 주세요"
        ) from None

    model = os.environ.get("PG_CLAUDE_MODEL") or CLAUDE_MODEL
    client = anthropic.Anthropic(max_retries=int(os.environ.get("PG_LLM_RETRIES", "3")))
    body: dict[str, object] = {
        "model": model,
        "max_tokens": max(1024, int(max_tokens or 4096)),
        "messages": [{"role": "user", "content": prompt}],
        "thinking": {"type": "between_tools"},
        "output_config": {"effort": os.environ.get("PG_LLM_EFFORT", "low")},
    }
    try:
        # 거절당하면 서버가 알아서 다른 모델로 넘겨 준다. 우리 글은 인쇄물 교정이라 거절날 일이
        # 거의 없지만, 났을 때 사람이 받는 것은 '검수 실패' 한 줄뿐이라 길을 하나 더 둔다.
        msg = client.beta.messages.create(
            betas=["server-side-fallback-2026-07-01"], fallbacks="default", **body)  # type: ignore[arg-type]
    except anthropic.BadRequestError:
        # 베타나 생각 끄기를 이 계정/이 모델이 안 받으면, 받는 것만으로 한 번 더 부른다.
        # 여기서 포기하면 열쇠를 제대로 넣은 사람이 이유도 모른 채 LLM 없이 쓰게 된다.
        body.pop("thinking", None)
        msg = client.messages.create(**body)  # type: ignore[arg-type]

    if msg.stop_reason == "refusal":
        why = getattr(getattr(msg, "stop_details", None), "explanation", "") or "까닭을 밝히지 않았습니다"
        raise Refused(str(why)[:200])
    txt = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    # 한도에 걸려 끊긴 답은 끊겼다고 알려 준다. 조용히 돌려주면 부르는 쪽이 '못 알아들었다'로 읽는다.
    if msg.stop_reason == "max_tokens":
        raise TruncatedAnswer(txt)
    return txt


def gemini(prompt: str, key: str, *, tries: int = 4, temperature: float = 0.0,
           max_tokens: int | None = None) -> str:
    """둘째 길. `ANTHROPIC_API_KEY`가 없고 `GEMINI_API_KEY`만 있을 때 쓴다.

    무료 등급은 분당 횟수가 정해져 있어 429에 걸린다. Retry-After만큼 기다렸다 다시 부르지만,
    쪽마다 부르는 교정에서는 그 기다림이 쌓여 검수를 멈춰 세운다 — 그래서 기본이 아니다.
    """
    import time

    import httpx
    model = os.environ.get("PG_LLM_MODEL", GEMINI_MODEL)
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
        if c.get("finishReason") == "MAX_TOKENS":
            raise TruncatedAnswer(txt)
        return txt
    raise RuntimeError("Gemini 분당 한도를 넘겨 포기했습니다")  # 여기까지 오지 않는다(마지막 시도는 raise_for_status)
