"""종이 데이터(frontend/public/data/papers.json)를 만든다.
- 기본 종류: 한국제지연합회 '종이의 분류'(kpa_classification.txt) 정의와 독립출판 종이 가이드(brunch)를 근거로 한다.
- 브랜드 종이: 두성종이(doosung_raw.json)와 삼원페이퍼(samwon_raw.json)가 매긴 분류·태그로 기본 종류에 연결한다.
- 프로파일: 종류마다 공개 ICC를 연결한다. 그 종이를 직접 측정한 프로파일이 아니면 approx=True(근사)로 둔다.
- 프로파일의 잉크량 한도(tac)는 각 프로파일 설명서·레지스트리에 적힌 값, white/blackL은 eval/profile_facts.json 실측값."""
import json
import re
import sys
import time
from collections import Counter
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "frontend" / "public" / "data" / "papers.json"
FACTS = json.loads((HERE.parent / "profile_facts.json").read_text(encoding="utf-8"))
KPA = "한국제지연합회 '종이의 분류' (paper.or.kr/sub_3/3_3.php)"
GUIDE = "독립출판 종이 가이드 (brunch.co.kr/@chochoya/118)"
ECI09 = "ECI Offset 2009 프로파일 설명서"

# 프로파일: 파일, 이름, 대상 인쇄 조건(출처 원문 요약), 잉크량 한도와 그 출처
PROFILES = {
    "coated": ("PSOcoated_v3.icc", "PSO Coated v3 (FOGRA51)", "ISO 12647-2:2013 PS1 프리미엄 코팅지", 300, "ECI 2015 발표자료"),
    "uncoated": ("PSOuncoated_v3_FOGRA52.icc", "PSO Uncoated v3 (FOGRA52)", "ISO 12647-2:2013 PS5 백색 비코팅 상질지(형광증백제 많음)", 300, "ECI 2015 발표자료"),
    "yellowish": ("ISOuncoatedyellowish.icc", "ISO Uncoated Yellowish (FOGRA30)", "ISO 12647-2:2004 paper type 5 미색 비코팅지", 320, ECI09),
    "lwc_std": ("PSO_LWC_Standard_eci.icc", "PSO LWC Standard (FOGRA46)", "표준 LWC(경량 코트지)", 300, ECI09),
    "lwc_imp": ("PSO_LWC_Improved_eci.icc", "PSO LWC Improved (FOGRA45)", "개선 LWC(경량 코트지)", 300, ECI09),
    "mfc": ("PSO_MFC_Paper_eci.icc", "PSO MFC Paper (FOGRA41)", "MFC(machine finished coating) 미도공지", 280, ECI09),
    "sc": ("PSOsc-b_paper_v3_FOGRA54.icc", "PSO SC-B Paper v3 (FOGRA54)", "ISO 12647-2:2013 PS6 슈퍼캘린더 비도공지(SC-B)", 270, "ICC 프로파일 레지스트리"),
    "snp": ("PSO_SNP_Paper_eci.icc", "PSO SNP Paper (FOGRA42)", "표준 신문용지(SNP)", 260, ECI09),
    "inp": ("PSO_INP_Paper_eci.icc", "PSO INP Paper (FOGRA48)", "개선 신문용지(INP)", 260, "ECI Offset Profiles Supplement 2012-1 설명서"),
    "board": ("APTEC_PC10_CardBoard_2023_v1.icc", "APTEC Coated CardBoard (PC10)", "프리미엄 코팅 판지", 340, "ICC 프로파일 레지스트리"),
    "isocoatedv2": ("ISOcoated_v2_eci.icc", "ISO Coated v2 (FOGRA39)", "ISO 12647-2:2004 paper type 1·2 유광·무광 코팅지", 330, ECI09),
    "jc2011": ("JapanColor2011Coated.icc", "Japan Color 2011 Coated", "Japan Color 2011, paper type 1 프리미엄 코팅지", 350, "ICC 프로파일 레지스트리"),
}

W = {  # 종류별 경고 문구
    "special": "일반 흰 종이가 아니라서 흰 종이용 프로파일로 계산한 색 차이를 그대로 믿을 수 없습니다. 인쇄소가 이 종이로 만든 프로파일을 올리세요.",
    "approx": "이 종이를 직접 측정한 공개 프로파일이 없어 가장 가까운 등급의 프로파일로 근사합니다.",
    "digital": "디지털 인쇄기(인디고 등) 전용 종이라 오프셋 프로파일과 조건이 다릅니다.",
}

# 기본 종류: id, 이름, 묶음, 코팅 여부(None=일반 코팅/비코팅으로 나누기 어려움), 프로파일, 근사 여부, 설명, 용도, 출처, 경고
TYPES = [
    ("art", "아트지", "코팅지", True, "coated", False, "백상지를 원지로 도공하고 슈퍼캘린더 등으로 높은 광택을 낸 종이. 광택이 있고 색상 표현이 우수하다.", "카렌다, 카탈로그, 잡지, 전단지, 리플렛", KPA + ", " + GUIDE, None),
    ("snow", "스노우지", "코팅지", True, "coated", False, "아트지보다 광택감이 적은 코팅지. 색상 표현력은 아트지보다 살짝 떨어진다.", "카탈로그, 브로슈어", GUIDE, None),
    ("woodfree_coated", "상질코트지", "코팅지", True, "coated", False, "백상지를 원지로 양면 합해 1㎡당 20g 전후의 도료를 도공한 종이.", "—", KPA, None),
    ("mech_coated", "중질코트지", "코팅지", True, "lwc_imp", True, "중질지를 원지로 양면 합해 1㎡당 20g 전후의 도료를 도공한 종이.", "—", KPA, W["approx"]),
    ("lwc", "경량코트지 (LWC)", "코팅지", True, "lwc_std", False, "백상지 또는 중질지 원지에 1㎡당 양면 5~15g 전후를 도공한 종이.", "잡지 본문, DM, 전단지", KPA, None),
    ("ccp", "경면광택지 (CCP)", "코팅지", True, "coated", True, "백상지를 원지로 캐스트 코터로 도공해 아트지보다 표면 광택이 높은 종이.", "카탈로그, 고급 화보, 화장품 케이스", KPA, W["approx"]),
    ("emboss_coated", "엠보스 코트지", "코팅지", True, "coated", True, "아트지·코트지 등에 각종 무늬를 엠보스한 종이.", "—", KPA, W["approx"]),
    ("mfc", "미도공 인쇄용지 (MFC)", "코팅지", True, "mfc", False, "백상지 또는 중질지를 만드는 중 사이즈프레스에서 1㎡당 양면 10g 전후를 도공한 종이.", "학습지, 교과서, 전단지", KPA, None),
    ("woodfree", "백상지 · 모조지 (백색)", "비코팅지", False, "uncoated", False, "표백화학펄프 100%로 만들고 도공하지 않은 종이. 모조지는 광택이 없어 눈이 편하다. 내지는 보통 80g·100g을 쓴다.", "도서·간행물, 노트, 단행본 내지", KPA + ", " + GUIDE, None),
    ("woodfree_yellow", "미색 백상지 · 미색 모조", "비코팅지", False, "yellowish", False, "백상지 중 미색·연미색 종이(백상지 분류에 포함).", "단행본 내지, 노트", KPA + ", " + GUIDE, None),
    ("bulk", "벌크지 (하이벌크)", "비코팅지", False, "uncoated", True, "같은 평량의 다른 용지보다 두꺼운 두께감이 있어 책으로 만들면 가벼운 느낌을 주는 종이. 쪽수가 적은 책의 두께를 늘리는 데 많이 쓴다.", "단행본 내지", "프린트올데이 '알아두면 쓸데있는 기본 종이 상식' (printallday.com/properties-of-paper, 2020)", W["approx"]),
    ("mech1", "중질지 1급", "비코팅지", False, "uncoated", True, "표백화학펄프 50% 이상에 기계펄프를 섞고 도공하지 않은 종이.", "서적, 노트, 교과서", KPA, W["approx"] + " 기계펄프가 섞여 백상지보다 흰색이 낮을 수 있습니다."),
    ("mech2", "중질지 2급 (만화용지)", "비코팅지", False, "inp", True, "표백화학펄프 50% 미만에 기계펄프 또는 재생펄프를 섞고 도공하지 않은 종이.", "만화용지, 전화번호부용지", KPA, W["approx"] + " 개선 신문용지(INP) 조건으로 계산합니다."),
    ("sc", "슈퍼캘린더지 (SC)", "비코팅지", False, "sc", False, "슈퍼캘린더로 표면을 매끄럽게 한 비도공지(ISO PS6, SC-B).", "잡지, 카탈로그(윤전)", "ICC 프로파일 레지스트리 FOGRA54", None),
    ("news", "신문용지 · 갱지", "비코팅지", False, "snp", False, "신문 인쇄에 쓰는 종이로 주원료는 폐지이며 기계펄프가 포함되기도 한다.", "신문, 전단", KPA, None),
    ("india", "인디아지 (박엽지)", "비코팅지", False, "uncoated", True, "주로 표백화학펄프로 만든 아주 얇고 불투명도가 높은 종이.", "사전, 성경, 법전", KPA, W["approx"] + " 아주 얇아 뒤비침이 계산에 들어 있지 않습니다."),
    ("ppc", "복사용지 (PPC)", "비코팅지", False, "uncoated", True, "표백화학펄프로 만든 비도공 인쇄용지를 재단해 복사기·프린터에 쓰는 종이.", "사무용 서류, 복사, 프린터", KPA, W["approx"] + " 사무용 프린터는 오프셋과 인쇄 방식이 다릅니다."),
    ("board1", "백판지 1급 (도공)", "판지", True, "board", False, "모든 층을 표백화학펄프로 만든 고급 판지 중 도공한 것.", "고급 화장품, 의약품, 담배갑", KPA, None),
    ("board2", "백판지 2급 (도공, SC마닐라 계열)", "판지", True, "board", True, "표면층은 표백화학펄프, 나머지 층은 폐지로 만든 판지 중 도공한 것.", "제과·제약 낱개 포장", KPA, W["approx"] + " 뒷면이 회색일 수 있습니다."),
    ("ivory", "아이보리판지", "판지", True, "board", True, "표면과 이면층은 표백화학펄프, 중간층은 폐지로 만든 판지.", "패키지, 카드", KPA, W["approx"]),
    ("board_uncoated", "비도공 판지", "판지", False, "uncoated", True, "백판지 1·2급 중 도공하지 않은 것.", "—", KPA, W["approx"]),
    ("yellowboard", "황판지", "판지", None, "uncoated", True, "표백하지 않은 폐지로 만든 판지.", "서류 파일, 노트 표지", KPA, W["special"]),
    ("kraft", "크라프트지", "특수지", None, "uncoated", True, "쇼핑백·봉투 등 가벼운 포장에 쓰는 크라프트지(경포장 크라프트지).", "쇼핑백, 봉투, 포장", KPA, W["special"]),
    ("black", "흑지", "특수지", None, "uncoated", True, "검은 종이(한국제지연합회 기타판지에 포함).", "카드, 패키지", KPA, W["special"]),
    ("colored", "색지 · 팬시용지", "특수지", None, "uncoated", True, "무늬, 색상, 질감 등을 넣어 만든 종이.", "카드, 봉투, 책표지", KPA, W["special"]),
    ("pearl", "펄지 · 메탈지", "특수지", None, "coated", True, "표면에 펄이나 금속 광택이 있는 종이(제지사 분류).", "카드, 초대장, 패키지", "두성종이·삼원페이퍼 분류", W["special"]),
    ("tracing", "트레싱지", "특수지", None, "uncoated", True, "빛이 비치는 반투명 종이(제지사 분류).", "간지, 면지, 포장", "두성종이·삼원페이퍼 분류", W["special"]),
    ("synthetic", "합성지", "특수지", None, "coated", True, "플라스틱 계열로 만든 종이(제지사 분류).", "라벨, 방수 인쇄물", "삼원페이퍼 분류", W["special"]),
    ("hanji", "한지", "특수지", None, "uncoated", True, "한지(제지사 분류).", "카드, 공예, 포장", "두성종이·삼원페이퍼 분류", W["special"]),
    ("digital", "디지털 인쇄 전용지", "특수지", None, "uncoated", True, "디지털 인쇄기 전용으로 만든 종이(제지사 분류).", "소량 디지털 인쇄", "두성종이·삼원페이퍼 분류", W["digital"]),
    ("fine_art", "미술용지 (수채화·판화·코튼)", "특수지", None, "uncoated", True, "수채화지, 판화지, 코튼지 등 미술용 종이(제지사 분류).", "미술, 판화, 고급 카드", "삼원페이퍼 분류", W["special"]),
    ("functional", "기능지 · 기타", "특수지", None, "uncoated", True, "내유·내수 등 기능을 더하거나 위 분류에 들지 않는 종이(제지사 분류).", "—", "두성종이·삼원페이퍼 분류", W["special"]),
    ("coated_brand", "고급 코팅지 (브랜드)", "코팅지", True, "coated", True, "제지사가 코티드·매트·러프그로스로 분류한 브랜드 종이.", "—", "두성종이·삼원페이퍼 분류", W["approx"]),
    ("uncoated_brand", "고급 비코팅지 (브랜드)", "비코팅지", False, "uncoated", True, "제지사가 언코티드·비코팅으로 분류한 브랜드 종이.", "—", "두성종이·삼원페이퍼 분류", W["approx"]),
    ("board_brand", "보드지 (브랜드)", "판지", None, "uncoated", True, "제지사가 보드·판지로 분류한 두꺼운 종이.", "—", "두성종이·삼원페이퍼 분류", W["approx"]),
]
TYPE = {t[0]: t for t in TYPES}

# 두성종이 분류(상세 페이지의 '분류/상태' 앞부분) → 기본 종류
DOOSUNG = {"코티드": "coated_brand", "언코티드": "uncoated_brand", "컬러엠보스": "colored", "컬러플레인": "colored", "펄지": "pearl",
           "메탈": "pearl", "보드": "board_brand", "기능지": "functional", "한지": "hanji", "크라프트지": "kraft", "디지털용지": "digital",
           "흑지": "black", "트래싱지": "tracing", "롤바인딩": "functional", "티슈페이퍼": "functional", "골판지": "functional"}
SKIP_DOOSUNG = {"지제품"}  # 노트 등 완제품


def samwon_type(tags):
    t = set(tags)
    for keys, typ in ((("트레싱지",), "tracing"), (("미도공지",), "mfc"), (("아트지",), "coated_brand"), (("재생보드",), "board_brand"),
                      (("미술용지", "수채화지", "판화지", "코튼지"), "fine_art"), (("형광색지",), "colored"), (("합성지",), "synthetic"), (("메탈지", "메탈보드", "펄지"), "pearl"), (("흑지",), "black"),
                      (("한지",), "hanji"), (("디지털전용지", "인디고"), "digital"), (("크라프트",), "kraft"), (("매트보드", "보드", "판지", "모형보드"), "board_brand"),
                      (("색지", "고급색지"), "colored"), (("매트지", "러프그로스"), "coated_brand"), (("비코팅", "화이트크라프트", "재생지", "비목재"), "uncoated_brand"),
                      (("엠보스", "티끌", "패턴"), "colored")):
        if t & set(keys):
            return typ
    return None


def gsm_range(texts):
    v = sorted({int(x) for s in texts for x in re.findall(r"(\d{2,4})\s*g", s or "")})
    v = [x for x in v if 20 <= x <= 1500]
    return f"{v[0]}~{v[-1]}g" if len(v) > 1 else (f"{v[0]}g" if v else "")


papers = []
for t in TYPES:
    tid, name, group, coated, prof, approx, note, use, src, warn = t
    papers.append({"id": tid, "name": name, "kind": "type", "group": group, "type": tid, "coated": coated, "profile": prof, "approx": approx,
                   "note": note, "use": use, "src": src, "warn": warn, "maker": "", "gsm": "", "url": ""})

ds = json.loads((HERE / "doosung_raw.json").read_text(encoding="utf-8"))
skipped = Counter()
for g in ds["goods"]:
    cls = g["class"].split("/")[0].strip()
    if cls in SKIP_DOOSUNG or cls not in DOOSUNG:
        skipped["두성:" + (cls or "분류없음")] += 1
        continue
    typ = DOOSUNG[cls]
    t = TYPE[typ]
    feat = " ".join(g["features"][:3])
    papers.append({"id": "ds" + g["goodsNo"], "name": g["name"], "kind": "brand", "group": t[2], "type": typ, "coated": t[3], "profile": t[4],
                   "approx": True, "note": g["tagline"] or feat, "use": g["use"], "src": "두성종이 상품 정보 (분류: " + g["class"] + ")",
                   "warn": t[9] or W["approx"], "maker": "두성종이", "gsm": g["gsm"], "url": g["url"]})

sw = json.loads((HERE / "samwon_raw.json").read_text(encoding="utf-8"))
for b in sw["brands"]:
    tags = [x for s in b["skus"] for x in s["tags"]]
    typ = samwon_type(tags)
    if not typ:
        skipped["삼원:태그로 분류 안 됨"] += 1
        typ = "functional"
    t = TYPE[typ]
    common = [k for k, _ in Counter(tags).most_common(6)]
    papers.append({"id": "sw" + b["uid"].lower(), "name": b["name"], "kind": "brand", "group": t[2], "type": typ, "coated": t[3], "profile": t[4],
                   "approx": True, "note": "태그: " + ", ".join("#" + x for x in common) if common else "", "use": "",
                   "src": f"삼원페이퍼 제품 목록 (품목 {b['total']}개 중 {len(b['skus'])}개 확인)", "warn": t[9] or W["approx"],
                   "maker": "삼원페이퍼", "gsm": gsm_range([s["name"] for s in b["skus"]]), "url": b["url"]})

# 국내 제지사 브랜드: 프린트올데이 '알아두면 쓸데있는 기본 종이 상식'(2020-05-25) 표에서 확인한 제조사·색상·평량·설명
PAD = "프린트올데이 '알아두면 쓸데있는 기본 종이 상식' (printallday.com/properties-of-paper, 2020)"
DOMESTIC = [
    ("랑데뷰", "삼화제지", "coated_brand", "울트라화이트·내츄럴", "90~240g", "국내에서 가장 많이 쓰는 러프그로스(자연스러운 질감의 매트한 인쇄 광택). 수입지 반누보와 비슷하다."),
    ("아이리스", "삼화제지", "coated_brand", "백색", "105~230g", "러프그로스 계열 고급지."),
    ("몽블랑", "한솔제지", "coated_brand", "화이트·엑스트라화이트", "90~240g", "러프그로스 계열 고급지."),
    ("앙상블", "한솔제지", "coated_brand", "", "90~260g", "러프그로스 계열 고급지."),
    ("아르떼", "한국제지", "coated_brand", "울트라화이트·내츄럴화이트", "90~310g", "러프그로스 계열 고급지."),
    ("이라이트", "전주페이퍼", "bulk", "", "70~80g", "하이벌크 계열. 같은 평량의 다른 용지보다 두꺼워 책이 가벼운 느낌을 준다."),
    ("그린라이트", "전주페이퍼", "bulk", "", "70~100g", "하이벌크 계열."),
    ("만화용지", "전주페이퍼", "mech2", "백색", "70g", "벌크 계열 만화용지."),
    ("중질만화", "전주페이퍼", "mech2", "미색", "70~80g", "벌크 계열 중질 만화용지."),
    ("밍크", "삼화제지", "colored", "", "120~400g", "제책용 면지와 각종 싸바리 용도로 많이 쓰는 색지."),
    ("색지", "삼화제지", "colored", "황색·분홍·연두·옥색", "70~90g", "흑백 인쇄 때 색간지로 쓰는 경제적인 색지."),
    ("레자크", "삼화제지", "colored", "", "90~300g", "가죽 같은 질감의 무늬지. 주로 표지용."),
    ("매직쉐도우", "한솔제지", "colored", "", "90~200g", "고급 레터지에 많이 쓰는 무늬지."),
    ("매직매칭", "한솔제지", "colored", "", "120~250g", "고급스러운 자연 무늬지."),
    ("스타라이트", "삼화제지", "pearl", "", "120~250g", "펄지."),
    ("오로", "한솔제지", "pearl", "", "120~250g", "펄지."),
]
have = {p["name"] for p in papers}
for name, maker, typ, colors, gsm, note in DOMESTIC:
    if name in have:
        continue
    t = TYPE[typ]
    papers.append({"id": "kr-" + str(len(papers)), "name": name, "kind": "brand", "group": t[2], "type": typ, "coated": t[3], "profile": t[4],
                   "approx": True, "note": note + (f" 색상: {colors}." if colors else ""), "use": "", "src": PAD, "warn": t[9] or W["approx"],
                   "maker": maker, "gsm": gsm, "url": "https://printallday.com/properties-of-paper/"})

profiles = {}
for k, (f, n, cond, tac, tsrc) in PROFILES.items():
    fk = {"coated": "coated", "uncoated": "uncoated", "sc": "sc", "board": "board", "jc2011": "jc2011", "isocoatedv2": "isocoatedv2",
          "yellowish": "yellowish", "lwc_imp": "lwc_imp", "lwc_std": "lwc_std", "mfc": "mfc", "snp": "snp", "inp": "inp"}[k]
    fa = FACTS[fk]
    profiles[k] = {"file": f, "name": n, "condition": cond, "tac": tac if tac is not None else 300, "tacSource": tsrc if tac is not None else "문서 없음 — 기본값 300% (추정)",
                   "white": fa["paper_white_lab_abs"], "blackL": fa["cmyk400_lab_abs"][0], "tacMeasured": fa["tac_max_relative"]}

used = {p["profile"] for p in papers}
out = {"generated": time.strftime("%Y-%m-%d"),
       "sources": {"kpa": KPA, "guide": GUIDE, "doosung": ds["source"] + f" ({ds['fetched']}, {len(ds['goods'])}개)",
                   "samwon": sw["source"] + f"/product/packageBook/list ({sw['fetched']}, 브랜드 {len(sw['brands'])}개)"},
       "skipped": dict(skipped), "profiles": profiles, "papers": papers}
OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print("papers", len(papers), "types", len(TYPES), "bytes", OUT.stat().st_size)
print("by group", Counter(p["group"] for p in papers))
print("by type", Counter(p["type"] for p in papers).most_common())
print("skipped", dict(skipped))
print("profiles used", sorted(used))
