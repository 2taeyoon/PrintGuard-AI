"""실제 사진(Kodak) PDF의 색 차이: 앱 코드(브라우저 TS, photo_color_js.json)와 Pillow(LittleCMS)를 원본 PNG로 대조하고
아티팩트용 썸네일/지도 이미지를 만든다. 결과: photo_color_result.json"""
import base64
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms

HERE = Path(__file__).resolve().parent
js = json.loads((HERE / "photo_color_js.json").read_text(encoding="utf-8"))
ORDER = ["kodim03", "kodim07", "kodim08", "kodim13", "kodim15", "kodim20", "kodim22", "kodim23"]
NOTE = {"kodim03": "형광에 가까운 노랑·주황·초록 모자, 흐린 하늘", "kodim07": "청록색 덧창과 붉은 꽃", "kodim08": "색이 다양한 유럽식 건물 거리", "kodim13": "초록 숲과 산, 개울의 회색 돌", "kodim15": "얼굴에 그림을 그린 아이, 빨강·초록 옷, 연한 청록 배경", "kodim20": "비행기와 밝은 하늘, 풀밭(채도가 낮음)", "kodim22": "붉은 헛간과 풀밭, 수면 반사", "kodim23": "파랑·노랑·빨강 앵무새, 초록 배경"}

srgb = ImageCms.createProfile("sRGB")
cmyk = ImageCms.getOpenProfile(str(HERE / "icc" / "RSWOP.icm"))
lab = ImageCms.createProfile("LAB")
F = ImageCms.Flags.BLACKPOINTCOMPENSATION
INT = {"relative": ImageCms.Intent.RELATIVE_COLORIMETRIC, "perceptual": ImageCms.Intent.PERCEPTUAL}


def de2000(l1, l2):
    L1, a1, b1 = l1.T
    L2, a2, b2 = l2.T
    C1, C2 = np.hypot(a1, b1), np.hypot(a2, b2)
    Cb = (C1 + C2) / 2
    G = 0.5 * (1 - np.sqrt(Cb**7 / (Cb**7 + 25.0**7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p, h2p = np.degrees(np.arctan2(b1, a1p)) % 360, np.degrees(np.arctan2(b2, a2p)) % 360
    dL, dC = L2 - L1, C2p - C1p
    dh = h2p - h1p
    dh = np.where(dh > 180, dh - 360, np.where(dh < -180, dh + 360, dh))
    dh = np.where(C1p * C2p == 0, 0, dh)
    dH = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dh) / 2)
    Lb, Cbp = (L1 + L2) / 2, (C1p + C2p) / 2
    hs = h1p + h2p
    hb = np.where(C1p * C2p == 0, hs, np.where(np.abs(h1p - h2p) <= 180, hs / 2, np.where(hs < 360, (hs + 360) / 2, (hs - 360) / 2)))
    T = (1 - 0.17 * np.cos(np.radians(hb - 30)) + 0.24 * np.cos(np.radians(2 * hb))
         + 0.32 * np.cos(np.radians(3 * hb + 6)) - 0.20 * np.cos(np.radians(4 * hb - 63)))
    dth = 30 * np.exp(-(((hb - 275) / 25) ** 2))
    Rc = 2 * np.sqrt(Cbp**7 / (Cbp**7 + 25.0**7))
    Sl = 1 + 0.015 * (Lb - 50) ** 2 / np.sqrt(20 + (Lb - 50) ** 2)
    Sc, Sh = 1 + 0.045 * Cbp, 1 + 0.015 * Cbp * T
    Rt = -np.sin(np.radians(2 * dth)) * Rc
    x, y, z = dL / Sl, dC / Sc, dH / Sh
    return np.sqrt(x * x + y * y + z * z + Rt * y * z)


def dec(im):
    a = np.asarray(im).reshape(-1, 3).astype(float)
    return np.stack([a[:, 0] * 100 / 255, (a[:, 1] + 128) % 256 - 128, (a[:, 2] + 128) % 256 - 128], axis=1)


def pillow_metrics(arr, intent):
    """arr: (h, w, 3) uint8"""
    img = Image.fromarray(arr, "RGB")
    to_c = ImageCms.buildTransform(srgb, cmyk, "RGB", "CMYK", renderingIntent=INT[intent], flags=F)
    c = ImageCms.applyTransform(img, to_c)
    c2l = ImageCms.buildTransform(cmyk, lab, "CMYK", "LAB", renderingIntent=INT[intent], flags=F)
    s2l = ImageCms.buildTransform(srgb, lab, "RGB", "LAB", renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC, flags=F)
    de = de2000(dec(ImageCms.applyTransform(img, s2l)), dec(ImageCms.applyTransform(c, c2l)))
    tac = np.asarray(c).reshape(-1, 4).astype(float).sum(axis=1) / 255 * 100
    return {"mean": float(de.mean()), "p95": float(np.percentile(de, 95)), "over5": float((de > 5).mean()), "over10": float((de > 10).mean()),
            "tac_max": float(tac.max()), "n": int(de.size)}, de


def jpeg_b64(im, q=78):
    b = io.BytesIO()
    im.convert("RGB").save(b, "JPEG", quality=q)
    return "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode()


rows = []
for k, name in enumerate(ORDER):
    full = np.asarray(Image.open(HERE / "photos" / f"{name}.png").convert("RGB"))
    f = 3  # 앱이 쓰는 축소 간격 (ceil(sqrt(768*512/60000)) = 3)
    sub = full[::f, ::f]
    row = {"name": name, "note": NOTE[name], "page": k + 1, "w": int(full.shape[1]), "h": int(full.shape[0]), "sub_w": int(sub.shape[1]), "sub_h": int(sub.shape[0])}
    for intent in ("relative", "perceptual"):
        m_js = js[intent]["images"][k]["metrics"]
        m_sub, de_sub = pillow_metrics(np.ascontiguousarray(sub), intent)
        m_full, _ = pillow_metrics(np.ascontiguousarray(full), intent)
        row[intent] = {
            "js": {"mean": m_js["meanDE"], "p95": m_js["p95DE"], "over5": m_js["shareOver5"], "over10": m_js["shareOver10"], "tac_max": m_js["maxTAC"], "median": m_js["medianDE"], "max": m_js["maxDE"], "n": m_js["sampled"]},
            "pillow_same_pixels": m_sub, "pillow_full": m_full, "severity": js[intent]["images"][k]["severity"],
        }
    # 이미지: 원본 썸네일 + 지도 합성 (상대 비색 기준)
    thumb = Image.fromarray(sub, "RGB").resize((240, 160), Image.LANCZOS)
    hj = js["relative"]["images"][k]["heat"]
    heat = Image.frombytes("RGBA", (hj["w"], hj["h"]), base64.b64decode(hj["rgba"])).resize((240, 160), Image.NEAREST)
    comp = thumb.convert("RGBA")
    comp.alpha_composite(heat)
    row["img_orig"], row["img_heat"] = jpeg_b64(thumb), jpeg_b64(comp)
    rows.append(row)

# 요약
summ = {}
for intent in ("relative", "perceptual"):
    d = [abs(r[intent]["js"]["mean"] - r[intent]["pillow_same_pixels"]["mean"]) for r in rows]
    d95 = [abs(r[intent]["js"]["p95"] - r[intent]["pillow_same_pixels"]["p95"]) for r in rows]
    dfull = [abs(r[intent]["js"]["mean"] - r[intent]["pillow_full"]["mean"]) for r in rows]
    summ[intent] = {"max_abs_mean_diff_same": max(d), "max_abs_p95_diff_same": max(d95), "max_abs_mean_diff_full": max(dfull),
                    "pdf_report": js[intent]["colorReport"], "ms": js[intent]["ms"]}
out = {"rows": rows, "summary": summ, "profile": js["relative"]["colorReport"]["profile"]}
(HERE / "photo_color_result.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
for r in rows:
    a, b, c = r["relative"]["js"], r["relative"]["pillow_same_pixels"], r["relative"]["pillow_full"]
    print(f"{r['name']} 평균 JS {a['mean']:.3f} / Pillow(같은 픽셀) {b['mean']:.3f} / Pillow(전체 {r['w']*r['h']//1000}k픽셀) {c['mean']:.3f} | p95 {a['p95']:.2f} vs {b['p95']:.2f} | >5 {a['over5']*100:.1f}% vs {b['over5']*100:.1f}%")
print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk != 'pdf_report'} for k, v in summ.items()}))
