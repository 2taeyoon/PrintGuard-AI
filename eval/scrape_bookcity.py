"""파주출판도시 입주기업협의회 공식 목록(bookcity.or.kr)에서 업종이 '인쇄'인 업체를 모은다.
결과: eval/shops_raw.json (이름, 주소, 전화, 업종, 원본 페이지). 지오코딩은 geocode_shops.py."""
import json
import re
import sys
import time
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

URL = "https://www.bookcity.or.kr/bbs/board.php?bo_table=tenant&page={}"
OUT = Path(__file__).resolve().parent / "shops" / "bookcity_raw.json"


class T(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows, self.row, self.cell, self.in_td = [], None, "", False

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.row = []
        if tag in ("td", "th"):
            self.in_td, self.cell = True, ""

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.in_td:
            self.in_td = False
            if self.row is not None:
                self.row.append(re.sub(r"\s+", " ", self.cell).strip())
        if tag == "tr" and self.row is not None:
            if self.row:
                self.rows.append(self.row)
            self.row = None

    def handle_data(self, d):
        if self.in_td:
            self.cell += d


def get(page):
    req = urllib.request.Request(URL.format(page), headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")


shops, seen_pages = [], 0
last = int(sys.argv[1]) if len(sys.argv) > 1 else 100
for p in range(1, last + 1):
    try:
        html = get(p)
    except Exception as e:
        print("page", p, "failed", e)
        break
    t = T()
    t.feed(html)
    rows = [r for r in t.rows if len(r) >= 5 and r[0].isdigit()]
    if not rows:
        print("page", p, "no rows -> stop")
        break
    seen_pages += 1
    for r in rows:
        shops.append({"no": r[0], "name": r[1], "addr": r[2], "tel": r[3], "kind": r[4], "page": p})
    time.sleep(0.4)

print("pages", seen_pages, "rows", len(shops))
print_shops = [s for s in shops if "인쇄" in s["kind"]]
print("인쇄 업종:", len(print_shops))
OUT.write_text(json.dumps({"source": "https://www.bookcity.or.kr/bbs/board.php?bo_table=tenant", "fetched": time.strftime("%Y-%m-%d"), "all": len(shops), "shops": print_shops}, ensure_ascii=False, indent=1), encoding="utf-8")
