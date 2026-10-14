"""삼원페이퍼 공식 사이트의 종이 브랜드(패키지북)와 브랜드별 품목(평량·종류 태그)을 모은다.
브랜드 목록: /product/packageBook/list?search.page=N, 품목: /product/paper/list?searchPaper.uidPackageBookCode=UID
결과: eval/papers/samwon_raw.json"""
import html
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
HERE = Path(__file__).resolve().parent
BASE = "https://www.samwonpaper.com"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"}


def get(url):
    for _ in range(3):
        try:
            h = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40).read().decode("utf-8", "replace")
            return re.sub(r"<!--.*?-->", "", h, flags=re.S)
        except Exception as e:  # noqa: BLE001
            print("retry", url, e)
            time.sleep(2)
    return ""


def text(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


brands = []
for page in range(1, 40):
    h = get(f"{BASE}/product/packageBook/list?search.page={page}")
    items = re.findall(r'data-uid="([^"]+)"\s*>.*?item-subject"><div[^>]*>(.*?)</div>', h, re.S)
    if not items:
        break
    new = [(u, text(n)) for u, n in items if u not in {b["uid"] for b in brands}]
    if not new:
        break
    brands += [{"uid": u, "name": n} for u, n in new]
    time.sleep(0.3)
print("brands", len(brands))

ITEM = re.compile(r'item-subject"><div[^>]*>(.*?)</div>.*?<div class="item-tag">(.*?)</div>', re.S)
for b in brands:
    skus = []
    for page in range(1, 4):
        h = get(f"{BASE}/product/paper/list?searchPaper.uidPackageBookCode={b['uid']}&search.sort=NAME&search.page={page}")
        found = ITEM.findall(h)
        if not found:
            # 태그 블록 구조가 다르면 이름만이라도 모은다
            found = [(n, "") for n in re.findall(r'item-subject"><div[^>]*>(.*?)</div>', h, re.S)]
        names = [text(n) for n, _ in found]
        if not names or (skus and names[0] == skus[0]["name"]):
            break
        for n, tg in found:
            skus.append({"name": text(n), "tags": [t.strip() for t in re.findall(r">#([^<]+)<", tg)]})
        m = re.search(r"([\d,]+)개의 제품", h)
        total = int(m.group(1).replace(",", "")) if m else len(skus)
        if len(skus) >= total:
            break
        time.sleep(0.3)
    b["skus"] = skus
    b["total"] = total if skus else 0
    b["url"] = f"{BASE}/product/paper/list?searchPaper.uidPackageBookCode={b['uid']}&search.sort=NAME"
    print(b["name"], b["total"], skus[:1])
    time.sleep(0.3)

(HERE / "samwon_raw.json").write_text(json.dumps({"fetched": time.strftime("%Y-%m-%d"), "source": BASE, "brands": brands}, ensure_ascii=False, indent=1), encoding="utf-8")
print("saved", len(brands))
