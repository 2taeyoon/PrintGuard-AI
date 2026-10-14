"""두성종이 공식 사이트(전체 종이 리스트, 282개)의 상품별 분류·평량·특징·용도를 모은다.
목록: /goods/goods_list.php?cateCd=001&page=N, 상세: /goods/goods_view.php?goodsNo=...
결과: eval/papers/doosung_raw.json"""
import html
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
HERE = Path(__file__).resolve().parent
BASE = "https://www.doosungpaper.co.kr"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"}


def get(url):
    for _ in range(3):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40).read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            print("retry", url, e)
            time.sleep(2)
    return ""


def flat(h):
    h = re.sub(r"<(script|style).*?</\1>", "", h, flags=re.S)
    h = re.sub(r"<!--.*?-->", "", h, flags=re.S)
    t = html.unescape(re.sub(r"<[^>]+>", "|", h))
    return [x.strip() for x in re.split(r"\s*\|\s*", re.sub(r"[ \t\r\n]+", " ", t)) if x.strip()]


# 페이지를 넘기면 일부가 빠져서(223/282) 한 페이지에 전부 불러온다
h = get(f"{BASE}/goods/goods_list.php?cateCd=001&pageNum=400")
m = re.search(r"개의 상품이 있습니다(.*?)CS CENTER", h, re.S)
ids = list(dict.fromkeys(re.findall(r"goods_view\.php\?goodsNo=(\d+)", m.group(1) if m else h)))
print("ids", len(ids))


def after(parts, key, n=1):
    try:
        i = parts.index(key)
        return parts[i + 1:i + 1 + n]
    except ValueError:
        return []


OUT = HERE / "doosung_raw.json"
goods = json.loads(OUT.read_text(encoding="utf-8"))["goods"] if OUT.exists() else []
have = {x["goodsNo"] for x in goods}
for g in [i for i in ids if i not in have]:
    url = f"{BASE}/goods/goods_view.php?goodsNo={g}"
    p = flat(get(url))
    try:
        k = p.index("SNS 공유하기")
        name = p[k + 5] if p[k + 1] == "페이스북" else p[k + 1]
    except ValueError:
        name = ""
    # 이름 다음 줄이 한 줄 소개
    tagline = ""
    if name and name in p:
        i = p.index(name, p.index("SNS 공유하기") if "SNS 공유하기" in p else 0)
        tagline = p[i + 1] if i + 1 < len(p) and p[i + 1] != "분류/상태" else ""
    cls = (after(p, "분류/상태") or [""])[0]
    gsm = (after(p, "평량/두께") or [""])[0]
    size = (after(p, "사이즈") or [""])[0]
    use = (after(p, "용도") or [""])[0]
    feats = []
    if "상세설명" in p and "상품 구성" in p:
        a, b = p.index("상세설명"), p.index("상품 구성")
        feats = [x for x in p[a + 1:b] if x not in ("-", "®")]
    goods.append({"goodsNo": g, "url": url, "name": name, "tagline": tagline, "class": cls, "gsm": gsm, "size": size, "use": use, "features": feats})
    print(g, name, "|", tagline, "|", cls, "|", gsm)
    time.sleep(0.3)

(HERE / "doosung_raw.json").write_text(json.dumps({"fetched": time.strftime("%Y-%m-%d"), "source": BASE + "/goods/goods_list.php?cateCd=001", "goods": goods}, ensure_ascii=False, indent=1), encoding="utf-8")
print("saved", len(goods))
