"""Многостраничный «скан» для бенчмарка §11 (TZA-11-02/03): N страниц таблицы ТЭП растром 200 dpi без текстового слоя.

Только синтетика (ADR-0002). Использование: python -m synth.bench_pages N out.pdf [номер_первого_листа]
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from inspector_ml.paths import repo_root

FONT = repo_root() / "assets/fonts/NotoSans.ttf"
LABELS = ["Площадь застройки", "Общая площадь здания", "Строительный объем", "Этажность", "Высота здания", "Количество квартир", "Класс бетона", "Толщина плиты перекрытия"]


def page(i: int, r: random.Random) -> Image.Image:
    dpi = 200
    w, h = int(210 / 25.4 * dpi), int(297 / 25.4 * dpi)
    img = Image.new("L", (w, h), 250)
    d = ImageDraw.Draw(img)
    big, small = ImageFont.truetype(str(FONT), 34), ImageFont.truetype(str(FONT), 28)
    d.text((140, 160), f"Исполнительная документация. Лист {i}", font=big, fill=20)
    y = 300
    for _ in range(18):
        d.text((140, y), f"{r.choice(LABELS)}  {r.randint(10, 99999)}", font=small, fill=25)
        y += 60
    for _ in range(3000):
        d.point((r.randrange(w), r.randrange(h)), fill=r.randrange(120, 220))
    return img.rotate(r.uniform(-0.8, 0.8), fillcolor=250).filter(ImageFilter.GaussianBlur(0.5))


def main(n: int, out: Path, start: int = 1) -> None:
    r = random.Random(11 + start)  # у каждой части свой SHA-256, иначе разбор возьмётся из кэша
    pages = [page(start + i, r) for i in range(n)]
    pages[0].save(out, "PDF", resolution=200, save_all=True, append_images=pages[1:])


if __name__ == "__main__":
    main(int(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3]) if len(sys.argv) > 3 else 1)
