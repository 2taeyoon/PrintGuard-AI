"""Kodak 공개 테스트 사진(eval/photos)을 A5 PDF 한 권으로 묶는다. 쪽마다 사진 1장(폭 128mm, DeviceRGB)."""
from pathlib import Path

import fitz

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "samples" / "kodak_photos_a5.pdf"
MM = 72 / 25.4
FONT = r"C:\Windows\Fonts\malgun.ttf"
ORDER = ["kodim03", "kodim07", "kodim08", "kodim13", "kodim15", "kodim20", "kodim22", "kodim23"]

doc = fitz.open()
for name in ORDER:
    png = (HERE / "photos" / f"{name}.png").read_bytes()
    page = doc.new_page(width=148 * MM, height=210 * MM)
    page.insert_font("kr", FONT)
    w = 128 * MM
    pix = fitz.Pixmap(png)
    h = w * pix.height / pix.width
    page.insert_image(fitz.Rect(10 * MM, 25 * MM, 10 * MM + w, 25 * MM + h), stream=png)
    page.insert_text((10 * MM, 18 * MM), f"{name}", fontname="kr", fontsize=12)
doc.save(OUT)
print("saved", OUT, len(doc), "pages")
