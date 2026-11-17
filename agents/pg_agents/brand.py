"""브랜드 키트 — 로고·색·글꼴을 한 번 등록해 두면 '작업 만들기'가 늘 그 브랜드로 만든다.

명함을 만들고 포스터를 만들고 리플렛을 만들 때마다 "남색은 C100 M85…, 글꼴은…"을 다시 말하지
않아도 되게 한다. 클로드가 MCP로 부탁하면(`compose`) 오케스트레이터가 이 키트를 찾아 함께 넘기고,
엔진 명령을 짜는 쪽(designcraft)이 그 색·글꼴·로고로 짠다.

누구의 키트인가 — 문서의 주인과 같은 규칙을 쓴다(orchestrator `_at_this_pc`).
- 이 PC의 브라우저와 이 PC의 클로드(MCP)는 **같은 사람**이다. 둘은 한 키트를 나눠 쓴다.
- 바깥에서 들어온 사람은 자기 키트를 따로 갖는다.

글꼴은 **이 PC에 깔린, 한글이 들어 있는 글꼴**만 받는다. 없는 글꼴 이름을 적으면 엔진이 기본
글꼴로 바꿔 찍는데, 그 기본 글꼴에는 한글이 없어 글자가 통째로 사라진다.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import struct
import threading
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from typing import Any

from .config import DATA

BRAND = DATA / "brand"
MAX_COLORS = 6
NAME_RE = re.compile(r"^[0-9A-Za-z가-힣 _\-]{1,20}$")


# 한 사람의 키트를 읽고-고치고-쓰는 동안 다른 변경이 끼어들지 않게 한다. 로고 올리기(스레드)와
# 필드 저장이 겹치면, 늦게 끝난 쪽이 먼저 읽어 둔 옛 값을 다시 써서 방금 저장한 필드가 사라진다.
_LOCKS: defaultdict[str, threading.Lock] = defaultdict(threading.Lock)


def _key(owner: str) -> str:
    return hashlib.sha256(owner.encode()).hexdigest()[:20]


def _json(owner: str) -> Path:
    return BRAND / f"{_key(owner)}.json"


def load(owner: str) -> dict[str, Any] | None:
    p = _json(owner)
    if not owner or not p.exists():
        return None
    try:
        kit = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    logo = kit.get("logo") or {}
    if logo and not Path(logo.get("path", "")).exists():   # 로고 파일이 지워졌으면 적힌 것도 지운다
        kit["logo"] = None
    return kit


def validate(body: dict[str, Any], fonts: list[str] | None = None) -> dict[str, Any]:
    """화면에서 온 값을 고른다. 틀린 값은 고쳐 넣지 않고 **이유와 함께 거절한다** —
    조용히 고치면 사람이 등록한 색과 실제 찍히는 색이 달라진다."""
    name = str(body.get("name") or "").strip()[:40]
    colors_in = body.get("colors") or []
    if not isinstance(colors_in, list) or len(colors_in) > MAX_COLORS:
        raise ValueError(f"색은 {MAX_COLORS}개까지 등록합니다")
    colors, seen = [], set()
    for c in colors_in:
        n = str((c or {}).get("name") or "").strip()
        if not NAME_RE.match(n):
            raise ValueError(f"색 이름은 한글·영문·숫자 20자까지입니다: '{n}'")
        if n in seen:
            raise ValueError(f"색 이름이 겹칩니다: '{n}'")
        seen.add(n)
        vals = {}
        for k in ("c", "m", "y", "k"):
            v = c.get(k)
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= 100:
                raise ValueError(f"'{n}'의 {k.upper()} 값은 0~100이어야 합니다")
            # 소수는 반올림하지 않고 거절한다 — 12.4를 12로 저장하면 등록한 색과 찍히는 색이 달라진다.
            if v != int(v):
                raise ValueError(f"'{n}'의 {k.upper()} 값은 정수(0~100)로 적어 주세요: {v}")
            vals[k] = int(v)
        colors.append({"name": n, **vals})
    out: dict[str, Any] = {"name": name, "colors": colors}
    for slot in ("title_font", "body_font"):
        f = str(body.get(slot) or "").strip()[:60]
        if f and fonts is not None and f not in fonts:
            raise ValueError(f"이 PC에 없는(또는 한글이 없는) 글꼴입니다: '{f}'")
        out[slot] = f
    return out


def _write(owner: str, kit: dict[str, Any]) -> None:
    """임시 파일에 쓴 뒤 바꿔 끼운다. 쓰다 멈춰도 반쯤 쓴 JSON이 남지 않는다."""
    tmp = _json(owner).with_suffix(".tmp")
    tmp.write_text(json.dumps(kit, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, _json(owner))


def save(owner: str, kit: dict[str, Any]) -> dict[str, Any]:
    BRAND.mkdir(parents=True, exist_ok=True)
    with _LOCKS[_key(owner)]:
        old = load(owner) or {}
        kit = {**kit, "logo": old.get("logo")}        # 로고는 따로 올리므로 저장할 때 지키기만 한다
        _write(owner, kit)
    return kit


def set_logo(owner: str, data: bytes, ext: str, original: str) -> dict[str, Any]:
    """새 로고를 **다 쓴 다음에** 옛 로고를 지운다. 먼저 지우면, 쓰다가 실패했을 때(디스크 부족 등)
    옛 로고까지 잃는다 — 다음 load()가 사라진 파일의 기록도 지워 버리기 때문이다."""
    BRAND.mkdir(parents=True, exist_ok=True)
    dest = BRAND / f"{_key(owner)}_logo{ext}"
    with _LOCKS[_key(owner)]:
        tmp = dest.with_name(dest.name + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, dest)
        for old in BRAND.glob(f"{_key(owner)}_logo.*"):
            if old != dest and not old.name.endswith(".tmp"):
                old.unlink(missing_ok=True)
        kit = load(owner) or {"name": "", "colors": [], "title_font": "", "body_font": ""}
        kit["logo"] = {"path": str(dest), "name": original, "bytes": len(data)}
        _write(owner, kit)
    return kit


def delete(owner: str) -> bool:
    gone = False
    with _LOCKS[_key(owner)]:
        for p in [_json(owner), *BRAND.glob(f"{_key(owner)}_logo.*")] if BRAND.exists() else []:
            if p.exists():
                p.unlink()
                gone = True
    return gone


def is_empty(kit: dict[str, Any] | None) -> bool:
    return not kit or not (kit.get("colors") or kit.get("title_font") or kit.get("body_font") or kit.get("logo"))


def prompt_block(kit: dict[str, Any], logo_path: str | None, ko_font: str) -> str:
    """명령을 짜는 LLM에게 줄 안내문. 부탁에 따로 적힌 것이 없으면 **반드시** 이대로 짜게 한다."""
    lines = ["브랜드 키트 — 이 사람의 브랜드다. <부탁>에 다른 색·글꼴이 적혀 있지 않으면 **반드시** 이대로 짠다."]
    if kit.get("name"):
        lines.append(f"- 브랜드 이름: {kit['name']}")
    if kit.get("colors"):
        cs = ", ".join(f"{c['name']}(c{c['c']} m{c['m']} y{c['y']} k{c['k']})" for c in kit["colors"])
        lines.append(f"- 색: {cs}. swatch.create로 **이 이름과 이 값 그대로** 만든다. 첫 색이 주된 색이다. "
                     "제목·띠·강조에 쓰고, 본문 글자는 어두운 색 하나로 둔다.")
    tf, bf = kit.get("title_font") or "", kit.get("body_font") or ""
    if tf or bf:
        lines.append(f"- 글꼴: 제목은 \"{tf or bf or ko_font}\", 본문은 \"{bf or tf or ko_font}\". "
                     "type.char의 attrs.fontFamily에 이 이름을 그대로 쓴다(이 PC에 깔린, 한글이 들어 있는 글꼴이다). "
                     f"위 명령 쓰는 법의 \"{ko_font}\" 대신 이 글꼴을 쓴다.")
    if logo_path:
        lines.append(f"- 로고: {logo_path} — file.place의 path에 **이 값을 그대로** 써서 넣는다. "
                     "여백 안쪽 상자의 위쪽 왼쪽이나 아래쪽처럼 눈에 띄되 제목을 가리지 않는 자리에, "
                     "폭은 판형 폭의 15~25%로 둔다.")
    return "\n".join(lines) + "\n\n"


# ---------------------------------------------------------------- 이 PC의 한글 글꼴
# 글꼴 파일의 name 표(패밀리 이름)와 cmap 표(한글 '가'가 있는지)만 읽는 작은 파서다.
# fontTools를 들이지 않으려고 직접 읽는다 — 필요한 것은 두 표뿐이다.

FONT_DIRS = [Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts",
             Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Windows" / "Fonts",
             Path("/usr/share/fonts"), Path("/usr/local/share/fonts"), Path.home() / ".fonts"]
HANGUL = 0xAC00


def _tables(buf: bytes, off: int) -> dict[bytes, tuple[int, int]]:
    n = struct.unpack_from(">H", buf, off + 4)[0]
    return {buf[off + 12 + i * 16: off + 16 + i * 16]: struct.unpack_from(">II", buf, off + 20 + i * 16) for i in range(n)}


def _family(buf: bytes, t: dict[bytes, tuple[int, int]]) -> str | None:
    if b"name" not in t:
        return None
    base, _ = t[b"name"]
    count, sto = struct.unpack_from(">HH", buf, base + 2)
    cand: dict[int, tuple[int, str]] = {}          # 이름 번호 → (순위, 이름)
    for i in range(count):
        pid, _eid, lid, nid, ln, of = struct.unpack_from(">HHHHHH", buf, base + 6 + i * 12)
        if nid not in (1, 16) or pid != 3:
            continue
        s = buf[base + sto + of: base + sto + of + ln].decode("utf-16-be", "ignore").strip()
        # 영어 이름(0x409)을 먼저 쓴다. 엔진이 패밀리를 영어 이름으로 부른다("Malgun Gothic").
        rank = 0 if lid == 0x409 else 1
        if s and (nid not in cand or rank < cand[nid][0]):
            cand[nid] = (rank, s)
    # 16번(묶음 패밀리)이 있으면 그것을 쓴다 — 맑은 고딕 Semilight 파일도 패밀리는 'Malgun Gothic'이다.
    v = cand.get(16) or cand.get(1)
    return v[1] if v else None


def _glyph4(buf: bytes, sub: int, cp: int) -> int:
    """format 4에서 cp의 글리프 번호. 범위 안에 있어도 0(없음)일 수 있어 끝까지 계산한다."""
    seg = struct.unpack_from(">H", buf, sub + 6)[0] // 2
    ends = struct.unpack_from(f">{seg}H", buf, sub + 14)
    o_start = sub + 16 + seg * 2
    starts = struct.unpack_from(f">{seg}H", buf, o_start)
    deltas = struct.unpack_from(f">{seg}h", buf, o_start + seg * 2)
    o_range = o_start + seg * 4
    ranges = struct.unpack_from(f">{seg}H", buf, o_range)
    for i, (s, e) in enumerate(zip(starts, ends)):
        if not s <= cp <= e:
            continue
        if ranges[i] == 0:
            return (cp + deltas[i]) & 0xFFFF
        at = o_range + i * 2 + ranges[i] + (cp - s) * 2
        g = struct.unpack_from(">H", buf, at)[0]
        return (g + deltas[i]) & 0xFFFF if g else 0
    return 0


def _has(buf: bytes, t: dict[bytes, tuple[int, int]], cp: int) -> bool:
    """글꼴이 cp를 **실제로 그리는지**(글리프 번호가 0이 아닌지). 범위에 드는지만 보면,
    범위 안의 빈 자리를 '있다'로 읽는다 — 그러면 한글 없는 글꼴이 목록에 들어와 글자가 사라진다."""
    if b"cmap" not in t:
        return False
    base, _ = t[b"cmap"]
    n = struct.unpack_from(">H", buf, base + 2)[0]
    for i in range(n):
        _pid, _eid, of = struct.unpack_from(">HHI", buf, base + 4 + i * 8)
        sub = base + of
        fmt = struct.unpack_from(">H", buf, sub)[0]
        if fmt == 4 and _glyph4(buf, sub, cp):
            return True
        if fmt == 12:
            ng = struct.unpack_from(">I", buf, sub + 12)[0]
            for g in range(ng):
                s, e, start_glyph = struct.unpack_from(">III", buf, sub + 16 + g * 12)
                if s <= cp <= e and start_glyph + (cp - s):
                    return True
    return False


def _faces(path: Path) -> list[tuple[str, bool]]:
    """(패밀리, 한글 있음) — ttc는 여러 개, 가변 글꼴(fvar)은 뺀다(엔진이 한 굵기로만 읽는다)."""
    try:
        buf = path.read_bytes()
    except OSError:
        return []
    offs = [0]
    if buf[:4] == b"ttcf":
        # 잘린 ttc는 헤더를 읽다 struct.error가 난다. 파일 하나 때문에 글꼴 조회 전체가 죽지 않게 건너뛴다.
        try:
            n = struct.unpack_from(">I", buf, 8)[0]
            offs = list(struct.unpack_from(f">{n}I", buf, 12))
        except struct.error:
            return []
    out = []
    for o in offs:
        try:
            t = _tables(buf, o)
            if b"fvar" in t:
                continue
            fam = _family(buf, t)
            if fam:
                out.append((fam, _has(buf, t, HANGUL)))
        except (struct.error, IndexError):
            continue
    return out


@lru_cache(maxsize=1)
def hangul_fonts() -> tuple[str, ...]:
    """이 PC에 깔린, 한글이 들어 있는 글꼴 패밀리(가나다·ABC 순). 한 번 읽고 기억한다."""
    fams: set[str] = set()
    for d in FONT_DIRS:
        if not d.is_dir():
            continue
        # 하위 폴더까지 본다 — 리눅스는 /usr/share/fonts/truetype/noto/처럼 한 단계 더 들어가 있다.
        for root, _dirs, files in os.walk(d):
            for name in files:
                if name.lower().endswith((".ttf", ".otf", ".ttc")):
                    fams.update(f for f, ko in _faces(Path(root) / name) if ko)
    return tuple(sorted(fams))
