"""색 변환에 쓰는 공개 ICC 프로파일 12개를 배포처에서 받아 frontend/public/icc에 넣는다.

저장소에는 프로파일을 넣지 않는다(재배포 조건 때문). 받는 곳은 ECI와 ICC 프로파일 레지스트리이고,
이 스크립트는 받아서 압축을 푸는 일만 한다. 이미 있는 파일은 건너뛴다.

    python deploy/fetch_icc.py            # 없는 것만 받는다
    python deploy/fetch_icc.py --force    # 전부 다시 받는다
"""
from __future__ import annotations

import io
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "frontend" / "public" / "icc"
UA = {"User-Agent": "Mozilla/5.0 (PrintGuard-AI setup)"}

# ECI 배포 zip 안에서 꺼낼 프로파일
ECI = {
    "https://eci.org/lib/exe/pso-coated_v3.zip": ["PSOcoated_v3.icc"],
    "https://eci.org/lib/exe/pso-uncoated_v3_fogra52.zip": ["PSOuncoated_v3_FOGRA52.icc"],
    "https://eci.org/lib/exe/pso_sc-b_paper_v3.zip": ["PSOsc-b_paper_v3_FOGRA54.icc"],
    "https://eci.org/lib/exe/eci_offset_2009.zip": [
        "ISOcoated_v2_eci.icc", "ISOuncoatedyellowish.icc", "PSO_LWC_Improved_eci.icc",
        "PSO_LWC_Standard_eci.icc", "PSO_MFC_Paper_eci.icc", "PSO_SNP_Paper_eci.icc",
    ],
    "https://eci.org/lib/exe/eci_offset_profiles_inp.zip": ["PSO_INP_Paper_eci.icc"],
}
# ICC 프로파일 레지스트리에서 바로 받는 것
REGISTRY = ["APTEC_PC10_CardBoard_2023_v1.icc", "JapanColor2011Coated.icc"]
REGISTRY_URL = "https://registry.color.org/profile-registry/profiles/"


def get(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read()


def main() -> None:
    force = "--force" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    got, skipped = [], []

    for url, names in ECI.items():
        need = [n for n in names if force or not (OUT / n).exists()]
        if not need:
            skipped += names
            continue
        print(f"받는 중: {url}")
        with zipfile.ZipFile(io.BytesIO(get(url))) as z:
            inside = {Path(m).name: m for m in z.namelist() if m.lower().endswith(".icc")}
            for n in need:
                if n not in inside:
                    print(f"  [없음] {n} — zip 안의 파일: {sorted(inside)[:5]}…")
                    continue
                (OUT / n).write_bytes(z.read(inside[n]))
                got.append(n)

    for n in REGISTRY:
        if not force and (OUT / n).exists():
            skipped.append(n)
            continue
        print(f"받는 중: {REGISTRY_URL + n}")
        (OUT / n).write_bytes(get(REGISTRY_URL + n))
        got.append(n)

    print(f"\n받음 {len(got)}개 {got}\n건너뜀 {len(skipped)}개 → {OUT}")
    missing = [n for ns in ECI.values() for n in ns] + REGISTRY
    missing = [n for n in missing if not (OUT / n).exists()]
    if missing:
        print(f"아직 없는 프로파일: {missing}")
        sys.exit(1)


main()
