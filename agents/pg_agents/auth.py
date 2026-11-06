"""서버가 발급하고 서명하는 토큰 — 브라우저 세션과 MCP 클라이언트가 같은 꼴을 쓴다.

왜 서버가 발급하는가. 전에는 브라우저가 `crypto.randomUUID()`로 **스스로** 값을 만들어
`localStorage`에 넣어 두고 그것을 주인 표시로 썼다. 서버가 발급하지 않으니 기한도 회수도
없고, 값이 영구 저장소에 있는 자격증명이라 스크립트 하나가 새면 그 브라우저의 지난 의뢰가
영구히 열린다. 발급을 서버로 가져오면 기한·회수·발급 제한이 생긴다.

꼴: ``pg1.<payload>.<sig>`` — payload는 base64url(JSON), sig는 payload **글자 그대로**에
대한 HMAC-SHA256이다. 인코딩된 글자에 서명해서 JSON 표기 차이(공백·키 순서)로 서명이
흔들릴 여지를 없앤다.

두 종류를 같은 꼴로 쓴다.

``browser``
    구글로 로그인하면 `POST /auth/google`이 내준다(`pg_agents.google`). subject는 구글 계정
    번호를 비밀로 해시한 값이라, 다시 로그인하면 **같은 주인**으로 돌아온다. 그래서 브라우저가
    이 토큰을 어디에 저장할 필요가 없다 — 잃으면 다시 받으면 그만이다.
``mcp``
    사람이 터미널에서 `python -m pg_agents.mktoken`으로 미리 받아 MCP 클라이언트 설정에
    적어 둔다. 브라우저가 없어 로그인 창을 띄울 수 없고, 수명이 길어야 한다.

쓰기 권한은 payload의 ``w``다. 브라우저 토큰은 사람이 직접 몰고 있으니 항상 쓰기까지 주고,
MCP 토큰은 `--write`로 받을 때만 준다. 상태를 바꾸는 일(보고서 작성, A 등급)은 이 값을 본다.
"""
from __future__ import annotations

import base64
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

from .config import DATA

VERSION = "pg1"
KINDS = ("browser", "mcp")
MAX_TOKEN = 1024          # 이보다 긴 것은 읽지도 않는다(서명 계산을 시키지 않는다)
MAX_SUBJECT = 64          # 의뢰에 주인으로 적히는 값의 길이 한도
SECRET_FILE = DATA / "auth_secret"

_secret: bytes | None = None


def secret() -> bytes:
    """서명 비밀. `PG_AUTH_SECRET`이 있으면 그것, 없으면 데이터 폴더에 한 번 만들어 둔다.

    파일로 두는 이유는 에이전트를 다시 켜도 발급해 둔 MCP 토큰이 살아 있어야 해서다.
    이 파일을 지우면 모든 토큰이 한꺼번에 무효가 된다 — 그게 회수 수단이다.
    """
    global _secret
    if _secret is not None:
        return _secret
    env = os.environ.get("PG_AUTH_SECRET", "").strip()
    if env:
        _secret = env.encode()
        return _secret
    try:
        _secret = SECRET_FILE.read_text(encoding="utf-8").strip().encode()
        if _secret:
            return _secret
    except OSError:
        pass
    SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
    made = secrets.token_hex(32)
    # 먼저 좁은 권한으로 만들고 나서 쓴다 — 내용이 들어간 뒤에 권한을 조이면 그 틈에 읽힌다.
    fd = os.open(SECRET_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(made)
    _secret = made.encode()
    return _secret


def tool_subject() -> str:
    """이 PC에서 stdio로 띄운 MCP 서버(클로드·커서)가 쓰는 주인 이름.

    그 서버는 **띄운 사람이 주인**이라 스스로 토큰을 만든다. 서명 비밀에서 뽑으므로 다시 켜도
    같은 주인이 되고, 그래서 지난 의뢰가 계속 보인다.

    이 값을 양쪽이 각자 계산하면 언젠가 어긋난다 — 한 글자만 달라도 '클로드가 만든 문서'가
    아무에게도 안 보이게 되고, 왜 안 보이는지는 아무 데도 안 적힌다. 그래서 여기 한 번만 적는다.
    """
    return sha256(secret() + b"mcp-local").hexdigest()[:32]


def forget_secret() -> None:
    """캐시를 비운다(테스트에서 데이터 폴더를 바꿔 끼울 때 쓴다)."""
    global _secret
    _secret = None


@dataclass(frozen=True)
class Claims:
    kind: str          # browser | mcp
    subject: str       # 의뢰의 주인으로 적히는 값
    write: bool        # 상태를 바꾸는 일을 할 수 있는가
    label: str         # 사람이 알아보기 위한 이름(발급할 때 적는다). 권한과 무관하다
    expires: int       # epoch 초


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sign(payload: str) -> str:
    return _b64(hmac.new(secret(), payload.encode(), sha256).digest())


def mint(kind: str, *, subject: str | None = None, hours: float = 12,
         write: bool | None = None, label: str = "") -> str:
    """토큰을 하나 만든다. `subject`를 주지 않으면 새로 뽑는다(= 새 세션)."""
    if kind not in KINDS:
        raise ValueError(f"모르는 종류입니다: {kind} (가능: {', '.join(KINDS)})")
    sub = (subject or secrets.token_urlsafe(16))[:MAX_SUBJECT]
    body = {
        "e": int(time.time() + hours * 3600),
        "k": kind,
        "l": label[:40],
        "s": sub,
        "w": bool(kind == "browser" if write is None else write),
    }
    payload = _b64(json.dumps(body, sort_keys=True, separators=(",", ":")).encode())
    return f"{VERSION}.{payload}.{_sign(payload)}"


def verify(token: str | None) -> Claims | None:
    """서명과 기한을 본다. 조금이라도 어긋나면 None — 왜 틀렸는지는 알려 주지 않는다."""
    if not token or len(token) > MAX_TOKEN:
        return None
    parts = token.strip().split(".")
    if len(parts) != 3 or parts[0] != VERSION:
        return None
    _, payload, sig = parts
    # 서명을 먼저 본다. 통하지 않은 payload는 JSON으로도 풀지 않는다.
    if not hmac.compare_digest(sig, _sign(payload)):
        return None
    try:
        body = json.loads(_unb64(payload))
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(body, dict) or body.get("k") not in KINDS:
        return None
    sub = str(body.get("s") or "")[:MAX_SUBJECT]
    if not sub:
        return None
    try:
        exp = int(body.get("e") or 0)
    except (TypeError, ValueError):
        return None
    if exp <= time.time():
        return None
    return Claims(kind=str(body["k"]), subject=sub, write=bool(body.get("w")),
                  label=str(body.get("l") or "")[:40], expires=exp)


def bearer(header: str | None) -> str | None:
    """`Authorization: Bearer <토큰>`에서 토큰만 꺼낸다. 꼴이 아니면 None."""
    if not header:
        return None
    scheme, _, rest = header.strip().partition(" ")
    return rest.strip() or None if scheme.lower() == "bearer" else None
