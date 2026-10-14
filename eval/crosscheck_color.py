"""브라우저용 색 차이 엔진(lcms-wasm, TS)을 Pillow(LittleCMS) + 별도 구현 ΔE2000과 대조한다.
frontend/scripts/test-color.mts 가 만든 color_check_js.json 을 읽는다."""
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms

HERE = Path(__file__).resolve().parent
js = json.loads((HERE / "color_check_js.json").read_text(encoding="utf-8"))
steps = js["steps"]
rgb = np.array([[r, g, b] for r in steps for g in steps for b in steps], dtype=np.uint8)


def de2000(l1, l2):
    """Sharma 2005 공식, 벡터 구현 (JS 구현과 따로 작성)."""
    L1, a1, b1 = l1.T
    L2, a2, b2 = l2.T
    C1, C2 = np.hypot(a1, b1), np.hypot(a2, b2)
    Cb = (C1 + C2) / 2
    G = 0.5 * (1 - np.sqrt(Cb**7 / (Cb**7 + 25.0**7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360
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


# Sharma 검증 쌍
t = de2000(np.array([[50, 2.6772, -79.7751], [50, -1, 2]]), np.array([[50, 0, -82.7485], [50, 0, 0]]))
print("sharma pairs", t.round(4), "expected [2.0425 2.3669]")

srgb = ImageCms.createProfile("sRGB")
cmyk = ImageCms.getOpenProfile(str(HERE / "icc" / "RSWOP.icm"))
lab = ImageCms.createProfile("LAB")
F = ImageCms.Flags.BLACKPOINTCOMPENSATION
img = Image.fromarray(rgb.reshape(1, -1, 3), "RGB")
to_cmyk = ImageCms.buildTransform(srgb, cmyk, "RGB", "CMYK", renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC, flags=F)
c = ImageCms.applyTransform(img, to_cmyk)
cmyk_to_lab = ImageCms.buildTransform(cmyk, lab, "CMYK", "LAB", renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC, flags=F)
src_to_lab = ImageCms.buildTransform(srgb, lab, "RGB", "LAB", renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC, flags=F)


def dec(im):
    a = np.asarray(im).reshape(-1, 3).astype(float)
    # Pillow LAB 8비트: L=v*100/255, a/b는 부호 있는 8비트를 unsigned로 저장(0=중성)
    return np.stack([a[:, 0] * 100 / 255, (a[:, 1] + 128) % 256 - 128, (a[:, 2] + 128) % 256 - 128], axis=1)


L_print = dec(ImageCms.applyTransform(c, cmyk_to_lab))
L_src = dec(ImageCms.applyTransform(img, src_to_lab))
py = de2000(L_src, L_print)
jsde = np.array(js["de"])
cm = np.asarray(c).reshape(-1, 4).astype(float)
tac = cm.sum(axis=1) / 255 * 100
print(f"n={len(py)}")
print(f"mean ΔE00  JS {jsde.mean():.3f}  Pillow {py.mean():.3f}  차이 {abs(jsde.mean() - py.mean()):.3f}")
print(f"p95  ΔE00  JS {np.percentile(jsde, 95):.3f}  Pillow {np.percentile(py, 95):.3f}")
print(f"픽셀별 |JS-Pillow| 평균 {np.abs(jsde - py).mean():.3f}, 최대 {np.abs(jsde - py).max():.3f}")
print(f"상관계수 {np.corrcoef(jsde, py)[0, 1]:.4f}")
print(f"TAC 평균 JS {js['stats']['meanTAC']:.1f}  Pillow {tac.mean():.1f}, 최대 JS {js['stats']['maxTAC']:.1f}  Pillow {tac.max():.1f}")
out = {
    "n": len(py), "mean_js": float(jsde.mean()), "mean_pillow": float(py.mean()),
    "p95_js": float(np.percentile(jsde, 95)), "p95_pillow": float(np.percentile(py, 95)),
    "mean_abs_diff": float(np.abs(jsde - py).mean()), "max_abs_diff": float(np.abs(jsde - py).max()),
    "corr": float(np.corrcoef(jsde, py)[0, 1]),
    "tac_mean_js": js["stats"]["meanTAC"], "tac_mean_pillow": float(tac.mean()),
}
(HERE / "color_check_result.json").write_text(json.dumps(out, indent=1), encoding="utf-8")


# ---- B. PDF 안의 이미지 end-to-end: 샘플 PDF에 넣은 그라데이션(80x60)을 Python에서 직접 만들어 같은 변환을 한 값과 비교 ----
import io, sys
sys.path.insert(0, str(HERE))
from make_samples import rgb_png
im = Image.open(io.BytesIO(rgb_png(80, 60))).convert('RGB')
arr = np.asarray(im).reshape(-1, 3)
img2 = Image.fromarray(arr.reshape(1, -1, 3), 'RGB')
c2 = ImageCms.applyTransform(img2, to_cmyk)
pyde = de2000(dec(ImageCms.applyTransform(img2, src_to_lab)), dec(ImageCms.applyTransform(c2, cmyk_to_lab)))
pj = json.loads((HERE / 'color_check_pdf_js.json').read_text(encoding='utf-8'))
print('PDF 이미지 평균 ΔE00  브라우저(pdf.js→lcms) %.3f  Python(원본 픽셀→Pillow) %.3f' % (pj['meanDE'], pyde.mean()))
print('상위 5%%  %.3f vs %.3f,  ΔE>5 비율 %.3f vs %.3f' % (pj['p95DE'], np.percentile(pyde, 95), pj['shareOver5'], (pyde > 5).mean()))
out['pdf_image'] = {'mean_js': pj['meanDE'], 'mean_pillow': float(pyde.mean()), 'p95_js': pj['p95DE'], 'p95_pillow': float(np.percentile(pyde, 95)),
                    'over5_js': pj['shareOver5'], 'over5_pillow': float((pyde > 5).mean())}
(HERE / 'color_check_result.json').write_text(json.dumps(out, indent=1), encoding='utf-8')
