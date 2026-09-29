"""Листы чертежа A3–A0 для замера CV-анализа по ТЗ §11 (TZA-11-08, OS-INSP-6.5.17).

Только синтетика (ADR-0002). План этажа в масштабе 1:100: сетка осей, стены двойной линией, цепочки размеров
с числами по каждой оси, штамп с масштабом. Плотность растёт с форматом: на A0 — сотни отрезков и десятки
размерных линий, как на реальном листе АР.

Использование: python -m synth.bench_drawings A0 out.pdf [seed]
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

# ГОСТ 2.301: формат → (ширина, высота) в мм, альбомная ориентация
FORMATS = {"A3": (420, 297), "A2": (594, 420), "A1": (841, 594), "A0": (1189, 841)}
SCALE = 100  # 1:100 — 1 мм листа = 100 мм в натуре


def drawing(fmt: str, out: Path, seed: int = 1) -> dict:
    """Пишет PDF листа и возвращает его паспорт: формат, число осей, стен и размерных линий."""
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    from inspector_ml.render import FONT

    r = random.Random(seed)
    w, h = FORMATS[fmt]
    pdfmetrics.registerFont(TTFont("Noto", str(FONT)))
    c = canvas.Canvas(str(out), pagesize=(w * mm, h * mm))
    margin, stamp_h = 25, 55
    x0, y0, x1, y1 = (
        margin + 20,
        margin + stamp_h + 20,
        w - margin - 20,
        h - margin - 20,
    )
    # оси с шагом 3–7,2 м (30–72 мм на листе)
    xs, ys = [x0], [y0]
    while xs[-1] < x1 - 30:
        xs.append(xs[-1] + r.choice([30, 36, 42, 48, 60, 72]))
    while ys[-1] < y1 - 30:
        ys.append(ys[-1] + r.choice([30, 36, 42, 48, 60]))
    xs, ys = xs[:-1] if xs[-1] > x1 else xs, ys[:-1] if ys[-1] > y1 else ys
    walls = 0
    c.setLineWidth(1.4)
    for x in xs:  # стена 200 мм в натуре = 2 мм на листе: две линии
        for dx in (-1, 1):
            c.line((x + dx) * mm, ys[0] * mm, (x + dx) * mm, ys[-1] * mm)
            walls += 1
    for y in ys:
        for dy in (-1, 1):
            c.line(xs[0] * mm, (y + dy) * mm, xs[-1] * mm, (y + dy) * mm)
            walls += 1
    # цепочки размеров снизу и слева: засечки и число в миллиметрах натуры
    c.setFont("Noto", 7)
    c.setLineWidth(0.5)
    dims = 0
    for a, b in zip(xs, xs[1:]):
        yy = ys[0] - 12
        c.line(a * mm, yy * mm, b * mm, yy * mm)
        for x in (a, b):
            c.line((x - 1.2) * mm, (yy - 1.2) * mm, (x + 1.2) * mm, (yy + 1.2) * mm)
        c.drawCentredString(
            (a + b) / 2 * mm, (yy + 1.5) * mm, str(round((b - a) * SCALE))
        )
        dims += 1
    for a, b in zip(ys, ys[1:]):
        xx = xs[0] - 12
        c.line(xx * mm, a * mm, xx * mm, b * mm)
        for y in (a, b):
            c.line((xx - 1.2) * mm, (y - 1.2) * mm, (xx + 1.2) * mm, (y + 1.2) * mm)
        c.saveState()
        c.translate((xx - 1.5) * mm, (a + b) / 2 * mm)
        c.rotate(90)
        c.drawCentredString(0, 0, str(round((b - a) * SCALE)))
        c.restoreState()
        dims += 1
    # проёмы и перегородки — шум для детектора линий
    c.setLineWidth(0.3)
    for _ in range(len(xs) * len(ys) * 2):
        cx, cy = r.uniform(xs[0], xs[-1]), r.uniform(ys[0], ys[-1])
        c.line(cx * mm, cy * mm, (cx + r.uniform(3, 12)) * mm, cy * mm)
    # штамп по ГОСТ Р 21.101: рамка и масштаб
    c.setLineWidth(1)
    c.rect((w - margin - 185) * mm, margin * mm, 185 * mm, stamp_h * mm)
    c.setFont("Noto", 9)
    c.drawString(
        (w - margin - 180) * mm, (margin + 10) * mm, f"План 1 этажа. Масштаб 1:{SCALE}"
    )
    c.drawString((w - margin - 180) * mm, (margin + 20) * mm, f"Формат {fmt}")
    c.showPage()
    c.save()
    return {
        "format": fmt,
        "axes": len(xs) + len(ys),
        "walls": walls,
        "dimension_lines": dims,
    }


def main(argv: list[str]) -> None:
    fmt, out = argv[0], Path(argv[1])
    print(drawing(fmt, out, int(argv[2]) if len(argv) > 2 else 1))


if __name__ == "__main__":
    main(sys.argv[1:])
