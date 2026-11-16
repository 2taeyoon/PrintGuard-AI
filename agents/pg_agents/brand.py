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
from functools import lru_cache
from pathlib import Path
from typing import Any

from .config import DATA

BRAND = DATA / "brand"
MAX_COLORS = 6
NAME_RE = re.compile(r"^[0-9A-Za-z가-힣 _\-]{1,20}$")


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
            if not isinstance(v, (int, float)) or not 0 <= v <= 100:
                raise ValueError(f"'{n}'의 {k.upper()} 값은 0~100이어야 합니다")
            vals[k] = int(round(v))
        colors.append({"name": n, **vals})
    out: dict[str, Any] = {"name": name, "colors": colors}
    for slot in ("title_font", "body_font"):
        f = str(body.get(slot) or "").strip()[:60]
        if f and fonts is not None and f not in fonts:
            raise ValueError(f"이 PC에 없는(또는 한글이 없는) 글꼴입니다: '{f}'")
        out[slot] = f
    return out


def save(owner: str, kit: dict[str, Any]) -> dict[str, Any]:
    BRAND.mkdir(parents=True, exist_ok=True)
    old = load(owner) or {}
    kit = {**kit, "logo": old.get("logo")}            # 로고는 따로 올리므로 저장할 때 지키기만 한다
    _json(owner).write_text(json.dumps(kit, ensure_ascii=False, indent=1), encoding="utf-8")
    return kit


def set_logo(owner: str, data: bytes, ext: str, original: str) -> dict[str, Any]:
    BRAND.mkdir(parents=True, exist_ok=True)
    for old in BRAND.glob(f"{_key(owner)}_logo.*"):
        old.unlink(missing_ok=True)
    dest = BRAND / f"{_key(owner)}_logo{ext}"
    dest.write_bytes(data)
    kit = load(owner) or {"name": "", "colors": [], "title_font": "", "body_font": ""}
    kit["logo"] = {"path": str(dest), "name": original, "bytes": len(data)}
    _json(owner).write_text(json.dumps(kit, ensure_ascii=False, indent=1), encoding="utf-8")
    return kit


def delete(owner: str) -> bool:
    gone = False
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


def _has(buf: bytes, t: dict[bytes, tuple[int, int]], cp: int) -> bool:
    if b"cmap" not in t:
        return False
    base, _ = t[b"cmap"]
    n = struct.unpack_from(">H", buf, base + 2)[0]
    for i in range(n):
        pid, eid, of = struct.unpack_from(">HHI", buf, base + 4 + i * 8)
        sub = base + of
        fmt = struct.unpack_from(">H", buf, sub)[0]
        if fmt == 4:
            seg = struct.unpack_from(">H", buf, sub + 6)[0] // 2
            ends = struct.unpack_from(f">{seg}H", buf, sub + 14)
            starts = struct.unpack_from(f">{seg}H", buf, sub + 16 + seg * 2)
            if any(s <= cp <= e for s, e in zip(starts, ends)):
                return True
        elif fmt == 12:
            ng = struct.unpack_from(">I", buf, sub + 12)[0]
            for g in range(ng):
                s, e, _ = struct.unpack_from(">III", buf, sub + 16 + g * 12)
                if s <= cp <= e:
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
        n = struct.unpack_from(">I", buf, 8)[0]
        offs = list(struct.unpack_from(f">{n}I", buf, 12))
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
        for p in d.iterdir():
            if p.suffix.lower() in (".ttf", ".otf", ".ttc"):
                fams.update(f for f, ko in _faces(p) if ko)
    return tuple(sorted(fams))
