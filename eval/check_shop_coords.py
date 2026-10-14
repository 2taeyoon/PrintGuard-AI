"""EPSG:5174 → WGS84 변환 검증. (1) pyproj 기본 변환과 국내에서 흔히 쓰는 towgs84 7변수 proj 문자열의 차이,
(2) 주소가 가려지지 않은 업체를 Nominatim으로 찾아 건물·번지 단위로 잡힌 경우의 거리. 결과: eval/shops/coord_check.json"""
import csv
import json
import math
import random
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from pyproj import Transformer

sys.stdout.reconfigure(encoding="utf-8")
HERE = Path(__file__).resolve().parent
rows = [r for r in csv.DictReader(open(HERE / "shops" / "printing_shops_localdata.csv", encoding="cp949"))
        if r["영업상태명"] == "영업/정상" and r["좌표정보(X)"].strip()]
a = Transformer.from_crs("EPSG:5174", "EPSG:4326", always_xy=True)
b = Transformer.from_crs("+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m "
                         "+towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43 +no_defs", "EPSG:4326", always_xy=True)


def d(p, q):
    R = 6371000
    p1, p2 = math.radians(p[0]), math.radians(q[0])
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(q[1] - p[1]) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


diff = []
for r in rows[::50]:
    x, y = float(r["좌표정보(X)"]), float(r["좌표정보(Y)"])
    lo1, la1 = a.transform(x, y)
    lo2, la2 = b.transform(x, y)
    diff.append(d((la1, lo1), (la2, lo2)))
diff.sort()
print("변환식 차이(m) n", len(diff), "중앙", round(diff[len(diff) // 2], 2), "최대", round(diff[-1], 2))

random.seed(0)
clear = [r for r in rows if "*" not in r["도로명주소"] and r["도로명주소"].strip()]
random.shuffle(clear)
res = []
for r in clear[:15]:
    addr = r["도로명주소"].split("(")[0].split(",")[0].strip()
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({"q": addr, "format": "jsonv2", "limit": 1, "countrycodes": "kr", "addressdetails": 1})
    try:
        g = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "PrintGuardLocal/0.1 (local dev)"}), timeout=30).read())
    except Exception as e:
        print("err", e)
        g = []
    time.sleep(1.2)
    if not g:
        continue
    g = g[0]
    level = "house" if g.get("address", {}).get("house_number") or g.get("addresstype") in ("building", "house") else g.get("addresstype")
    lo, la = a.transform(float(r["좌표정보(X)"]), float(r["좌표정보(Y)"]))
    res.append({"name": r["사업장명"], "addr": addr, "level": level, "dist_m": round(d((la, lo), (float(g["lat"]), float(g["lon"]))))})
house = sorted(x["dist_m"] for x in res if x["level"] == "house")

# (3) 역지오코딩: 변환한 좌표가 주소의 시군구·동·도로와 같은 곳을 가리키는지 (정방향 검색이 실패해도 쓸 수 있다)
rev = []
for r in rows[7::max(1, len(rows) // 80)][:80]:
    lo, la = a.transform(float(r["좌표정보(X)"]), float(r["좌표정보(Y)"]))
    url = "https://nominatim.openstreetmap.org/reverse?" + urllib.parse.urlencode({"lat": la, "lon": lo, "format": "jsonv2", "zoom": 18, "addressdetails": 1, "accept-language": "ko"})
    try:
        g = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "PrintGuardLocal/0.1 (local dev)"}), timeout=30).read())
    except Exception as e:
        print("err", e)
        continue
    time.sleep(1.2)
    ad, txt = g.get("address", {}), r["도로명주소"] + " " + r["지번주소"]
    parts = r["도로명주소"].split() or r["지번주소"].split()
    sgg = parts[1] if len(parts) > 1 else ""
    gu = parts[2] if len(parts) > 2 and parts[2].endswith("구") else ""
    road = next((p for p in parts if p.endswith(("로", "길")) and "*" not in p), "")
    names = " ".join(str(v) for v in ad.values())
    rev.append({"name": r["사업장명"], "addr": r["도로명주소"], "sgg_ok": sgg in names or (gu and gu in names), "road": road,
                "road_ok": bool(road) and road in names, "osm": g.get("display_name", "")})
n = len(rev)
sgg_ok = sum(x["sgg_ok"] for x in rev)
with_road = [x for x in rev if x["road"]]
road_ok = sum(x["road_ok"] for x in with_road)
print("역지오코딩", n, "시군구 일치", sgg_ok, "도로명 확인 가능", len(with_road), "도로명 일치", road_ok)
print("지오코딩 성공", len(res), "번지 단위", len(house))
if house:
    print("번지 단위 거리 중앙", house[len(house) // 2], "m, 90%", house[int(len(house) * 0.9)], "m, 최대", house[-1], "m")
out = {"transform_diff_m": {"n": len(diff), "median": diff[len(diff) // 2], "max": diff[-1]},
       "geocode": res, "house_n": len(house), "house_median_m": house[len(house) // 2] if house else None,
       "house_p90_m": house[int(len(house) * 0.9)] if house else None,
       "reverse": {"n": n, "sgg_ok": sgg_ok, "road_n": len(with_road), "road_ok": road_ok, "rows": rev}}
(HERE / "shops" / "coord_check.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
