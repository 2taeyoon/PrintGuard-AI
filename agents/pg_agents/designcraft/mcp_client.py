"""DesignCraft MCP 서버(`designcraft-cli mcp`)를 자식 프로세스로 띄워 stdio로 말한다.

MCP는 **stdin/stdout의 줄 단위 JSON-RPC 2.0**뿐이다. HTTP도 SSE도 없으므로 브라우저가 직접 부를 길이
없고, 이 PC에서 프로세스를 띄워 파이프로 말하는 방법밖에 없다. Claude 데스크톱이 하는 것과 같다.

**의뢰 하나에 프로세스 하나**를 쓴다. 오래 띄워 두고 돌려쓰지 않는 이유가 셋 있다.
  1. 열린 문서가 서버 전체의 상태다. 두 의뢰가 같이 돌면 서로의 문서를 덮어쓴다.
  2. `--automation-*-root`는 켤 때 정해진다. 의뢰 폴더에 가두려면 의뢰마다 새로 띄워야 한다.
  3. 한 번 깨진 프로세스가 뒤 의뢰까지 망치지 않는다.
시작에 1초쯤 걸리지만 그만한 값을 한다.

파일 접근은 반드시 가둔다. 안 걸면 에이전트가 이 PC의 디스크 전체를 읽고 쓴다.
"""
from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any

# 설치 위치. PG_DESIGNCRAFT_CLI가 1순위이고, 없으면 PATH, 그다음 각 OS의 기본 설치 경로를 본다.
_GUESSES = (
    Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "ArtCraft" / "DesignCraft" / "designcraft-cli.exe",
    Path("C:/Program Files/ArtCraft/DesignCraft/designcraft-cli.exe"),
    Path("/Applications/DesignCraft.app/Contents/MacOS/designcraft-cli"),
    Path("/usr/bin/designcraft-cli"),
)
START_TIMEOUT = float(os.environ.get("PG_DESIGNCRAFT_START_TIMEOUT", "30"))
CALL_TIMEOUT = float(os.environ.get("PG_DESIGNCRAFT_CALL_TIMEOUT", "120"))


class McpError(RuntimeError):
    """MCP 쪽이 거절했거나 대답을 못 한 경우. 메시지는 사람이 읽고 고칠 수 있는 것만 담는다."""


def cli_path() -> str | None:
    """designcraft-cli의 경로. 못 찾으면 None(설치 안내는 부르는 쪽이 한다)."""
    env = os.environ.get("PG_DESIGNCRAFT_CLI", "").strip().strip('"')
    if env:
        return env if Path(env).exists() else None
    if found := shutil.which("designcraft-cli"):
        return found
    return next((str(p) for p in _GUESSES if p.exists()), None)


def app_port() -> int | None:
    """켜 둔 DesignCraft 앱에 붙을 포트. **환경변수로 켤 때만** 값이 나온다.

    앱은 `designcraft --control 7979`로 띄운다. 붙으면 사람이 그 화면에서 보고 있는 문서에
    그대로 작업이 간다 — 대신 폴더 울타리가 없어지므로, 켜는 일은 사람이 한다.
    """
    v = os.environ.get("PG_DESIGNCRAFT_CONNECT", "").strip()
    if not v:
        return None
    try:
        n = int(v)
    except ValueError:
        return None
    return n if 1 <= n <= 65535 else None


def app_listening(port: int, timeout: float = 0.4) -> bool:
    """그 포트에 무언가 듣고 있나. 앱이 꺼져 있는데 붙으러 가면 한참 기다리다 실패한다."""
    import socket
    with socket.socket() as sk:
        sk.settimeout(timeout)
        return sk.connect_ex(("127.0.0.1", port)) == 0


class Mcp:
    """한 번 쓰고 닫는 MCP 세션. `with Mcp(...) as m:` 으로 쓴다."""

    def __init__(self, read_roots: list[Path], write_roots: list[Path]) -> None:
        exe = cli_path()
        if not exe:
            raise McpError("designcraft-cli를 찾을 수 없습니다. PG_DESIGNCRAFT_CLI에 경로를 넣어 주세요.")
        port = app_port()
        if port:
            # 켜 둔 앱에 붙는다. 이때는 **가둘 수 없다** — 가두기 플래그는 이 프로세스가 엔진을
            # 품을 때만 듣고, 돌고 있는 앱은 그 울타리 밖이다(CLI 도움말에 그렇게 적혀 있다).
            # 그래서 환경변수로 켠 사람만 이 길로 온다. 켠 사람은 자기 앱을 자기가 띄운 사람이다.
            args = [exe, "mcp", "--connect", str(port)]
        else:
            args = [exe, "mcp"]
            for r in read_roots:
                args += ["--automation-read-root", str(r)]
            for w in write_roots:
                args += ["--automation-write-root", str(w)]
            # 가두지 않은 채로는 띄우지 않는다. 플래그가 없으면 디스크 전체가 열린다.
            if not read_roots or not write_roots:
                raise McpError("읽기·쓰기 폴더를 모두 지정해야 합니다(가두지 않은 MCP는 띄우지 않습니다).")
        self.port = port
        self.exe = exe
        self._n = 0
        self._err: list[str] = []
        self._q: queue.Queue[str | None] = queue.Queue()
        self.p = subprocess.Popen(  # noqa: S603 - 경로는 설정값이고 인자는 우리가 만든다
            args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        threading.Thread(target=self._pump, args=(self.p.stdout, self._q), daemon=True).start()
        threading.Thread(target=self._pump_err, daemon=True).start()
        self.info = self._rpc("initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "printguard", "version": "0.1.0"},
        }, timeout=START_TIMEOUT)
        self._notify("notifications/initialized")

    # ---------- 배관 ----------
    def _pump(self, pipe: Any, q: queue.Queue[str | None]) -> None:
        for line in pipe:
            q.put(line)
        q.put(None)  # 파이프가 닫혔다는 표시

    def _pump_err(self) -> None:
        for line in self.p.stderr:
            self._err.append(line.rstrip())
            del self._err[:-40]  # 끝 40줄만 둔다(오류 알릴 때 쓴다)

    def _tail(self) -> str:
        return "\n".join(self._err[-8:]) or "(stderr 없음)"

    def _write(self, msg: dict[str, Any]) -> None:
        try:
            self.p.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
            self.p.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            raise McpError(f"MCP 서버가 닫혔습니다: {e}\n{self._tail()}") from e

    def _notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def _rpc(self, method: str, params: dict[str, Any] | None = None, timeout: float = CALL_TIMEOUT) -> Any:
        self._n += 1
        mine = self._n
        self._write({"jsonrpc": "2.0", "id": mine, "method": method, "params": params or {}})
        while True:
            try:
                line = self._q.get(timeout=timeout)
            except queue.Empty:
                raise McpError(f"{method}: {timeout:.0f}초 안에 대답이 없습니다.\n{self._tail()}") from None
            if line is None:
                raise McpError(f"{method}: MCP 서버가 대답 없이 끝났습니다.\n{self._tail()}")
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue  # 로그 줄 등은 넘긴다(규격상 stdout에는 JSON만 오지만 방어한다)
            if msg.get("id") != mine:
                continue  # 알림이나 지나간 응답
            if "error" in msg:
                e = msg["error"]
                raise McpError(f"{method}: {e.get('message', e)}")
            return msg.get("result")

    # ---------- 도구 ----------
    def tools(self) -> list[str]:
        return [t["name"] for t in self._rpc("tools/list").get("tools", [])]

    def tool(self, name: str, args: dict[str, Any] | None = None) -> Any:
        """도구 하나를 부른다. 본문이 JSON이면 파싱해서, 아니면 글자 그대로 돌려준다."""
        r = self._rpc("tools/call", {"name": name, "arguments": args or {}})
        parts: list[Any] = []
        for c in r.get("content", []):
            if c.get("type") == "text":
                try:
                    parts.append(json.loads(c["text"]))
                except json.JSONDecodeError:
                    parts.append(c["text"])
            else:
                parts.append({"type": c.get("type")})
        if r.get("isError"):
            raise McpError(f"{name}: {parts[0] if parts else '알 수 없는 오류'}")
        return parts[0] if len(parts) == 1 else parts

    def ex(self, command: str, **params: Any) -> Any:
        """엔진 명령 하나(`execute` 도구)."""
        return self.tool("execute", {"command": command, "params": params})

    # ---------- 뒷정리 ----------
    def close(self) -> None:
        if self.p.poll() is None:
            try:
                self.p.stdin.close()
            except OSError:
                pass
            try:
                self.p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.p.kill()
                self.p.wait(timeout=5)

    def __enter__(self) -> Mcp:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def probe() -> dict[str, Any]:
    """연결 상태 화면에 쓸 정보. 띄워 보고 바로 닫는다. 실패해도 예외를 던지지 않는다."""
    exe = cli_path()
    if not exe:
        return {"available": False, "reason": "designcraft-cli를 찾을 수 없습니다",
                "hint": "PG_DESIGNCRAFT_CLI에 designcraft-cli 실행 파일 경로를 넣어 주세요", "cli": None}
    try:
        v = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=20,  # noqa: S603
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        version = (v.stdout or v.stderr).strip().splitlines()[0] if (v.stdout or v.stderr) else "?"
    except (OSError, subprocess.SubprocessError) as e:
        return {"available": False, "reason": f"실행할 수 없습니다: {e}", "cli": exe}
    # 도구 목록까지 받아 봐야 '정말 연결된다'고 말할 수 있다
    tmp = Path(os.environ.get("TEMP", "/tmp")) / "pg-designcraft-probe"
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        port = app_port()
        if port and not app_listening(port):
            return {"available": False, "cli": exe, "version": version, "mode": "app",
                    "app_port": port, "app_running": False,
                    "reason": f"켜 둔 DesignCraft 앱을 {port} 포트에서 찾지 못했습니다",
                    "hint": f"앱을 `designcraft --control {port}`로 띄우거나, "
                            "PG_DESIGNCRAFT_CONNECT를 비우면 창 없이 돕니다"}
        with Mcp([tmp], [tmp]) as m:
            info = m.info or {}
            srv = info.get("serverInfo", {})
            return {"available": True, "cli": exe, "version": version,
                    "mode": "app" if port else "headless",
                    "app_port": port, "app_running": bool(port),
                    "protocol": info.get("protocolVersion"), "server": srv.get("name"),
                    "server_version": srv.get("version"), "tools": m.tools()}
    except McpError as e:
        return {"available": False, "reason": str(e)[:300], "cli": exe, "version": version,
                "mode": "app" if app_port() else "headless", "app_port": app_port()}
