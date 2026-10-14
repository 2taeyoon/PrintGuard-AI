"""정답을 아는 테스트 PDF 생성 (결함이 의도적으로 삽입됨)."""
import io
from pathlib import Path

import fitz
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "samples"
OUT.mkdir(exist_ok=True)
FONT = r"C:\Windows\Fonts\malgun.ttf"
MM = 72 / 25.4


def rgb_png(w, h):
    im = Image.new("RGB", (w, h))
    px = im.load()
    for x in range(w):
        for y in range(h):
            px[x, y] = (int(255 * x / w), 80, int(255 * y / h))
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


def defective():
    """A5 148x210mm. 결함: RGB 저해상도 이미지, 미임베딩 폰트, 재활용률/율 불일치, 수치 불일치, 페이지 밖 텍스트, TrimBox 없음."""
    doc = fitz.open()
    w, h = 148 * MM, 210 * MM
    p1 = doc.new_page(width=w, height=h)
    p1.insert_font("kr", FONT)
    p1.insert_text((40, 80), "PrintGuard 샘플 보고서", fontname="kr", fontsize=22)
    p1.insert_text((40, 120), "재활용률: 45%", fontname="kr", fontsize=14)
    p1.insert_text((40, 140), "본 제품은 친환경 소재를 사용합니다.", fontname="kr", fontsize=12)
    p1.insert_text((40, 170), "Helvetica fallback text (not embedded)", fontname="helv", fontsize=11)

    p2 = doc.new_page(width=w, height=h)
    p2.insert_font("kr", FONT)
    p2.insert_image(fitz.Rect(40, 60, 300, 260), stream=rgb_png(80, 60))  # 저해상도 RGB
    p2.insert_text((40, 300), "재활용율: 52%", fontname="kr", fontsize=14)
    p2.insert_text((40, 330), "이 이 문장은 단어가 반복됩니다.", fontname="kr", fontsize=12)

    p3 = doc.new_page(width=w, height=h)
    p3.insert_font("kr", FONT)
    p3.insert_text((300, 100), "페이지 오른쪽 밖으로 나가는 텍스트입니다 입니다", fontname="kr", fontsize=14)
    p3.insert_text((40, 400), "재활용률: 45%", fontname="kr", fontsize=14)
    doc.save(OUT / "defective_a5.pdf")


def clean():
    """A5 + 3mm 도련 TrimBox 지정, 폰트 임베딩, 결함 없음."""
    doc = fitz.open()
    bl = 3 * MM
    w, h = 148 * MM + 2 * bl, 210 * MM + 2 * bl
    for i in range(2):
        p = doc.new_page(width=w, height=h)
        p.set_trimbox(fitz.Rect(bl, bl, w - bl, h - bl))
        p.insert_font("kr", FONT)
        p.draw_rect(fitz.Rect(0, 0, w, h), color=None, fill=(0.9, 0.9, 0.9))
        p.insert_text((60, 150), f"정상 샘플 {i + 1}쪽", fontname="kr", fontsize=18)
    doc.save(OUT / "clean_a5_bleed.pdf")


if __name__ == "__main__":
    defective()
    clean()
    print("ok", [f.name for f in OUT.glob("*.pdf")])

