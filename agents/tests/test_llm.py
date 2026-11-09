"""LLM을 부르는 자리 — 어느 길로 가는지, 무엇을 보내고 무엇을 안 보내는지.

진짜 API는 부르지 않는다(돈이 나간다). `anthropic` 자리에 가짜를 끼워 넣고 **보낸 몸통**을 본다.
여기서 지키려는 것은 하나다: Sonnet 5.5가 거절하는 값을 우리가 보내지 않는 것.
"""
from __future__ import annotations

import sys
import types

import pytest

from pg_agents import llm


class _Block:
    def __init__(self, text: str):
        self.type, self.text = "text", text


class _Msg:
    def __init__(self, text="안녕", stop_reason="end_turn", explanation=""):
        self.content = [_Block(text)]
        self.stop_reason = stop_reason
        self.stop_details = types.SimpleNamespace(explanation=explanation) if explanation else None


def fake_anthropic(monkeypatch, *, beta_raises=False, msg=None, raises: Exception | None = None):
    """가짜 anthropic 모듈. 보낸 몸통을 `sent`에 모아 돌려준다."""
    sent: list[tuple[str, dict]] = []

    class APIStatusError(Exception):
        pass

    class BadRequestError(APIStatusError):
        pass

    class RateLimitError(APIStatusError):
        pass

    class AuthenticationError(APIStatusError):
        pass

    errs = {"bad": BadRequestError, "rate": RateLimitError, "auth": AuthenticationError}

    class _Messages:
        def __init__(self, where): self.where = where
        def create(self, **kw):
            sent.append((self.where, kw))
            if self.where == "beta" and raises:
                kind, text = raises                      # ("bad"|"rate"|"auth", 메시지)
                raise errs[kind](text)
            if self.where == "beta" and beta_raises:
                raise BadRequestError("thinking.between_tools는 안 받습니다")
            return msg or _Msg()

    class Anthropic:
        def __init__(self, **kw):
            self.init = kw
            self.messages = _Messages("plain")
            self.beta = types.SimpleNamespace(messages=_Messages("beta"))

    mod = types.SimpleNamespace(Anthropic=Anthropic, APIStatusError=APIStatusError,
                                BadRequestError=BadRequestError, RateLimitError=RateLimitError,
                                AuthenticationError=AuthenticationError)
    monkeypatch.setitem(sys.modules, "anthropic", mod)
    return sent


def test_anthropic_key_wins_over_gemini(monkeypatch):
    """둘 다 있으면 Claude로 간다. 무료 등급의 분당 한도를 피하려고 바꾼 것이므로 그쪽이 기본이다."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("GEMINI_API_KEY", "g-test")
    assert llm.provider() == "anthropic" and llm.have_key() is True
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    assert llm.provider() == "gemini"
    monkeypatch.delenv("GEMINI_API_KEY")
    assert llm.provider() == "" and llm.have_key() is False


def test_no_key_means_no_call_and_a_plain_reason(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
        llm.ask("뭐든")


def test_sends_sonnet_and_never_sends_temperature(monkeypatch):
    """**Sonnet 5.5는 기본값이 아닌 샘플링 값을 400으로 거절한다.**

    Gemini 시절 코드는 `temperature=0.0`을 넣어 두었다. 그대로 옮겼으면 첫 호출부터 전부
    실패했을 자리라, 이 시험이 그 자리를 잡아 둔다.
    """
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    sent = fake_anthropic(monkeypatch)
    assert llm.ask("프롬프트", max_tokens=8192) == "안녕"
    where, body = sent[0]
    assert where == "beta"                       # 거절 대비 길을 켜고 부른다
    assert body["model"] == "claude-sonnet-5-5"
    assert "temperature" not in body and "top_p" not in body and "top_k" not in body
    assert body["max_tokens"] == 8192
    assert body["thinking"] == {"type": "between_tools"}


def test_falls_back_to_the_plain_call_when_the_beta_is_refused(monkeypatch):
    """베타를 안 받는 계정이라고 LLM을 통째로 못 쓰게 두지 않는다."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    sent = fake_anthropic(monkeypatch, beta_raises=True)
    assert llm.ask("프롬프트") == "안녕"
    assert [w for w, _ in sent] == ["beta", "plain"]
    assert "thinking" not in sent[1][1]          # 안 받던 것을 빼고 다시 부른다


def test_cut_off_answer_says_it_was_cut_off(monkeypatch):
    """조용히 돌려주면 부르는 쪽이 '못 알아들었다'로 읽는다."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    fake_anthropic(monkeypatch, msg=_Msg("{\"commands\": [", stop_reason="max_tokens"))
    with pytest.raises(llm.TruncatedAnswer):
        llm.ask("긴 부탁")


def test_a_refusal_is_not_an_empty_answer(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    fake_anthropic(monkeypatch, msg=_Msg("", stop_reason="refusal", explanation="거절합니다"))
    with pytest.raises(llm.Refused, match="거절"):
        llm.ask("무엇이든")


# ---------- 적어 둔 모델 이름 ----------
def test_a_model_name_written_the_human_way_still_works(monkeypatch):
    """`.env`에는 `sonnet 5.5`라고 적게 마련이다. 그대로 보내면 404가 나고, 화면에는
    '교정 실패' 한 줄만 남아 어디가 틀렸는지 알 수가 없다."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("ANTHROPIC_LLM_MODEL", "Sonnet 5.5")
    sent = fake_anthropic(monkeypatch)
    llm.ask("프롬프트")
    assert sent[0][1]["model"] == "claude-sonnet-5-5"


def test_an_unreadable_model_name_falls_back_instead_of_404(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("PG_CLAUDE_MODEL", "???")
    sent = fake_anthropic(monkeypatch)
    llm.ask("프롬프트")
    assert sent[0][1]["model"] == llm.CLAUDE_MODEL


# ---------- 잔액이 바닥났을 때 ----------
def test_when_the_credit_runs_out_it_falls_back_to_free_gemini(monkeypatch):
    """느려도 도는 것이 멈춰 서는 것보다 낫다. 잔액이 떨어진 그날 검수를 맡긴 사람에게는
    '교정 실패' 한 줄만 남는다."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("GEMINI_API_KEY", "g-test")
    fake_anthropic(monkeypatch, raises=("bad", "Your credit balance is too low to access the API"))
    called = {}

    def fake_gemini(prompt, key, **kw):
        called["key"] = key
        return "제미나이"

    monkeypatch.setattr(llm, "gemini", fake_gemini)
    assert llm.ask("프롬프트") == "제미나이"
    assert called["key"] == "g-test"


def test_a_daily_rate_limit_also_goes_to_gemini(monkeypatch):
    """분당 한도는 SDK가 이미 몇 번 다시 불러 본 뒤다. 여기까지 왔으면 더 기다릴 자리가 아니다."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("GEMINI_API_KEY", "g-test")
    fake_anthropic(monkeypatch, raises=("rate", "rate_limit_error"))
    monkeypatch.setattr(llm, "gemini", lambda *a, **k: "제미나이")
    assert llm.ask("프롬프트") == "제미나이"


def test_without_a_gemini_key_the_credit_error_surfaces(monkeypatch):
    """넘어갈 곳이 없으면 조용히 삼키지 않는다 — 왜 안 되는지는 사람이 알아야 고친다."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    fake_anthropic(monkeypatch, raises=("bad", "credit balance is too low"))
    with pytest.raises(llm.OutOfCredit):
        llm.ask("프롬프트")


def test_a_wrong_key_says_so_instead_of_falling_back(monkeypatch):
    """열쇠가 틀린 것은 잔액이 떨어진 것과 다르다. 몰래 느린 쪽으로 넘어가면 영영 못 고친다."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-wrong")
    monkeypatch.setenv("GEMINI_API_KEY", "g-test")
    fake_anthropic(monkeypatch, raises=("auth", "invalid x-api-key"))
    with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
        llm.ask("프롬프트")
