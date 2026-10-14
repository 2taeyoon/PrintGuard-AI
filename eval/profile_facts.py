"""종이 프로파일에서 직접 잴 수 있는 값: (1) 프로파일이 만드는 최대 총 잉크량(TAC) — sRGB 64^3 격자를 CMYK로 바꿔 C+M+Y+K 최대,
(2) 종이 흰색(CMYK 0,0,0,0)과 최대 검정의 Lab(절대 비색), (3) 프로파일 설명·저작권 태그. 결과: eval/profile_facts.json"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms

sys.stdout.reconfigure(encoding="utf-8")
HERE = Path(__file__).resolve().parent
P = {"swop": "RSWOP.icm", "coated": "PSOcoated_v3.icc", "uncoated": "PSOuncoated_v3_FOGRA52.icc",
     "sc": "PSOsc-b_paper_v3_FOGRA54.icc", "board": "APTEC_PC10_CardBoard_2023_v1.icc", "jc2011": "JapanColor2011Coated.icc",
     "fogra47": "Uncoated_Fogra47L_VIGC_300.icc", "fogra39": "Coated_Fogra39L_VIGC_300.icc",
     "isocoatedv2": "ISOcoated_v2_eci.icc", "yellowish": "ISOuncoatedyellowish.icc", "lwc_imp": "PSO_LWC_Improved_eci.icc",
     "lwc_std": "PSO_LWC_Standard_eci.icc", "mfc": "PSO_MFC_Paper_eci.icc", "snp": "PSO_SNP_Paper_eci.icc", "inp": "PSO_INP_Paper_eci.icc"}
srgb, lab = ImageCms.createProfile("sRGB"), ImageCms.createProfile("LAB")
g = np.linspace(0, 255, 64).astype(np.uint8)
grid = np.stack(np.meshgrid(g, g, g, indexing="ij"), -1).reshape(-1, 3)
img = Image.fromarray(grid.reshape(512, 512, 3), "RGB")


def dec(a):
    a = np.asarray(a).reshape(-1, 3).astype(float)
    return np.stack([a[:, 0] * 100 / 255, (a[:, 1] + 128) % 256 - 128, (a[:, 2] + 128) % 256 - 128], 1)


out = {}
for k, f in P.items():
    prof = ImageCms.getOpenProfile(str(HERE / "icc" / f))
    row = {"file": f, "desc": ImageCms.getProfileDescription(prof).strip(), "copyright": (ImageCms.getProfileCopyright(prof) or "").strip()}
    for it, name in ((ImageCms.Intent.RELATIVE_COLORIMETRIC, "relative"), (ImageCms.Intent.PERCEPTUAL, "perceptual")):
        t = ImageCms.buildTransform(srgb, prof, "RGB", "CMYK", renderingIntent=it, flags=ImageCms.Flags.BLACKPOINTCOMPENSATION)
        c = np.asarray(ImageCms.applyTransform(img, t)).reshape(-1, 4).astype(float) / 255 * 100
        tac = c.sum(1)
        row[f"tac_max_{name}"] = round(float(tac.max()), 1)
        row[f"tac_p999_{name}"] = round(float(np.percentile(tac, 99.9)), 1)
    a2l = ImageCms.buildTransform(prof, lab, "CMYK", "LAB", renderingIntent=ImageCms.Intent.ABSOLUTE_COLORIMETRIC)
    probe = Image.fromarray(np.array([[[0, 0, 0, 0], [255, 255, 255, 255], [0, 0, 0, 255]]], np.uint8), "CMYK")
    L = dec(ImageCms.applyTransform(probe, a2l))
    row["paper_white_lab_abs"] = [round(v, 1) for v in L[0]]
    row["cmyk400_lab_abs"] = [round(v, 1) for v in L[1]]
    row["k100_lab_abs"] = [round(v, 1) for v in L[2]]
    out[k] = row
    print(k, json.dumps(row, ensure_ascii=False))
(HERE / "profile_facts.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
