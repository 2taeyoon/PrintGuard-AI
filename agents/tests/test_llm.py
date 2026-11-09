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


def fake_anthropic(monkeypatch, *, beta_raises=False, msg=None):
    """가짜 anthropic 모듈. 보낸 몸통을 `sent`에 모아 돌려준다."""
    sent: list[tuple[str, dict]] = []

    class BadRequestError(Exception):
        pass

    class _Messages:
        def __init__(self, where): self.where = where
        def create(self, **kw):
            sent.append((self.where, kw))
            if self.where == "beta" and beta_raises:
                raise BadRequestError("thinking.between_tools는 안 받습니다")
            return msg or _Msg()

    class Anthropic:
        def __init__(self, **kw):
            self.init = kw
            self.messages = _Messages("plain")
            self.beta = types.SimpleNamespace(messages=_Messages("beta"))

    mod = types.SimpleNamespace(Anthropic=Anthropic, BadRequestError=BadRequestError)
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
