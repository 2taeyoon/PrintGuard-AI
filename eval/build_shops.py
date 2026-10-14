"""인쇄소 지도 데이터: 행정안전부 LOCALDATA '기타_인쇄사' 전국 파일(공공데이터포털 15045057)에서 영업 중인 업체만 골라
EPSG:5174 좌표를 위경도로 바꾸고, 파주출판도시 입주기업협의회 공식 목록(bookcity_raw.json)과 이름으로 맞춘다.
결과: frontend/public/data/shops.json

검증: 협의회 업체 중 인허가 데이터와 이름이 맞은 곳은 협의회 주소를 OSM(Nominatim)으로 찾은 도로 위치와 거리를 비교한다."""
import csv
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

from pyproj import Transformer

sys.stdout.reconfigure(encoding="utf-8")
HERE = Path(__file__).resolve().parent
SRC = HERE / "shops" / "printing_shops_localdata.csv"
BOOK = HERE / "shops" / "bookcity_raw.json"
OUT = HERE.parent / "frontend" / "public" / "data" / "shops.json"
CHECK = HERE / "shops" / "shops_check.json"

tf = Transformer.from_crs("EPSG:5174", "EPSG:4326", always_xy=True)
rows = list(csv.DictReader(open(SRC, encoding="cp949")))
status = Counter(r["영업상태명"] for r in rows)
live = [r for r in rows if r["영업상태명"] == "영업/정상"]
print("전체", len(rows), "영업/정상", len(live))

norm = lambda s: re.sub(r"\(주\)|㈜|주식회사|\(유\)|유한회사|\s|[()]", "", s or "")
out, nocoord = [], 0
for r in live:
    try:
        x, y = float(r["좌표정보(X)"]), float(r["좌표정보(Y)"])
    except ValueError:
        nocoord += 1
        continue
    lon, lat = tf.transform(x, y)
    if not (33 < lat < 39 and 124 < lon < 132):
        nocoord += 1
        continue
    addr = (r["도로명주소"] or r["지번주소"]).strip()
    parts = addr.split()
    out.append({"name": r["사업장명"].strip(), "addr": addr, "tel": r["전화번호"].strip(), "lat": round(lat, 6), "lon": round(lon, 6),
                "sido": parts[0] if parts else "", "sgg": parts[1] if len(parts) > 1 else "", "items": r["제작취급품목내용"].strip(),
                "since": r["인허가일자"], "updated": r["데이터갱신시점"][:10], "tags": []})
print("좌표 없음/범위 밖", nocoord, "지도 표시", len(out))


def geocode(q):
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({"q": q, "format": "jsonv2", "limit": 1, "countrycodes": "kr"})
    req = urllib.request.Request(url, headers={"User-Agent": "PrintGuardLocal/0.1 (local dev)"})
    r = json.loads(urllib.request.urlopen(req, timeout=30).read().decode("utf-8"))
    time.sleep(1.2)
    return (float(r[0]["lat"]), float(r[0]["lon"])) if r else None


def dist_m(a, b):
    R = 6371000
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


book = json.loads(BOOK.read_text(encoding="utf-8"))
paju = {}
for s in out:
    if s["sgg"] == "파주시":
        paju.setdefault(norm(s["name"]), []).append(s)
road_of = lambda a: next((p for p in a.split() if p.endswith(("로", "길")) and "*" not in p), "")
all_names = Counter()
for r in rows:
    if "파주" in r["도로명주소"] + r["지번주소"]:
        all_names[(norm(r["사업장명"]), r["영업상태명"])] += 1
check, only_book = [], []
for b in book["shops"]:
    # 이름이 같고 도로명도 같아야 같은 업체로 본다 (이름만 같은 다른 지역 업체를 막는다)
    m = [s for s in paju.get(norm(b["name"]), []) if road_of(s["addr"]) == road_of(b["addr"])]
    b["localdata_status"] = [st for (nm, st), c in all_names.items() if nm == norm(b["name"])]
    g = geocode(b["addr"])
    if m:
        s = m[0]
        s["tags"].append("출판도시")
        s["book_addr"], s["book_tel"] = b["addr"], b["tel"]
        d = round(dist_m((s["lat"], s["lon"]), g)) if g else None
        check.append({"name": b["name"], "book_addr": b["addr"], "localdata_addr": s["addr"], "osm_road": g, "localdata": [s["lat"], s["lon"]], "dist_m": d})
        print("맞음", b["name"], "|", s["addr"])
    else:
        only_book.append(b)
        if g:
            out.append({"name": b["name"], "addr": b["addr"], "tel": b["tel"], "lat": round(g[0], 6), "lon": round(g[1], 6), "sido": "경기도", "sgg": "파주시",
                        "items": "", "since": "", "updated": book["fetched"], "tags": ["출판도시", "도로위치", "인허가:" + ("주소다름" if "영업/정상" in b["localdata_status"] else ("·".join(b["localdata_status"]) or "없음"))]})
        print("인허가 데이터에서 영업 중으로 안 맞음", b["name"], b["addr"], "인허가 상태", b["localdata_status"], "OSM", g)

dists = [c["dist_m"] for c in check if c["dist_m"] is not None]
meta = {
    "generated": time.strftime("%Y-%m-%d"),
    "sources": [
        {"name": "행정안전부 LOCALDATA 기타_인쇄사 (공공데이터포털 15045057, 공공누리 출처표시)", "url": "https://file.localdata.go.kr/file/printing_shops/info",
         "rows": len(rows), "status": dict(status)},
        {"name": "파주출판도시 입주기업협의회 입주기업 게시판", "url": book["source"], "rows": book["all"], "printing": len(book["shops"]), "fetched": book["fetched"]},
    ],
    "shown": len(out), "nocoord": nocoord, "book_matched": len(check), "book_only": len(only_book),
    "check_dist_m": {"n": len(dists), "median": sorted(dists)[len(dists) // 2] if dists else None, "max": max(dists) if dists else None},
}
cols = ["name", "addr", "tel", "lat", "lon", "sido", "sgg", "items", "since", "updated", "tags"]
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({**meta, "cols": cols, "rows": [[s.get(c, "") for c in cols] for s in out]}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
CHECK.write_text(json.dumps({"meta": meta, "check": check, "only_book": only_book}, ensure_ascii=False, indent=1), encoding="utf-8")
print(json.dumps(meta, ensure_ascii=False))
print("bytes", OUT.stat().st_size)
