"""Синтетические листы-чертежи для диффа между редакциями (OS-INSP-3.4, OS-INSP-6.4.1).

Лист АР «План 1-го этажа»: рамка, штамп, координационные оси, помещения-прямоугольники с номерами,
перегородка, размерная линия. Редакция B — тот же лист, но:
  * весь лист смещён и чуть повёрнут (как при повторной печати/сканировании),
  * удалено помещение 105 (прямоугольник с подписью),
  * перегородка в помещении 102 перенесена.
Ответы (bbox изменений в долях листа A) — `answer()`; ответы не требуют рендера.

    uv run python synth/sheets.py [каталог]   # по умолчанию ../data/fixtures/sheetdiff

Отдельный каталог, а не OBJ-SEV-2: пакет объекта и его answer-key не меняются (ADR-0002 — только синтетика).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from inspector_ml.paths import repo_root

ROOT = repo_root()
FONT = ROOT / "assets/fonts/NotoSans.ttf"
if "Noto" not in pdfmetrics.getRegisteredFontNames():
    pdfmetrics.registerFont(TTFont("Noto", str(FONT)))

W, H = landscape(A4)  # 842 × 595 pt
# Помещения: номер, назначение, x, y, w, h (мм от левого нижнего угла листа)
ROOMS = [
    ("101", "Вестибюль", 30, 110, 60, 50),
    ("102", "Лестничная клетка", 90, 110, 45, 50),
    ("103", "Колясочная", 135, 110, 40, 50),
    ("104", "Помещение уборочного инвентаря", 175, 110, 45, 50),
    ("105", "Мусорокамера", 188, 62, 38, 40),
    ("106", "Электрощитовая", 80, 60, 45, 50),
    ("107", "ИТП", 125, 60, 55, 50),
]
REMOVED = "105"
# перегородка в 102: A — вертикаль x=105 мм, B — x=122 мм
WALL_A = ((105, 115), (105, 155))
WALL_B = ((122, 115), (122, 155))


def _to_frac(x0_mm: float, y0_mm: float, x1_mm: float, y1_mm: float) -> list[float]:
    """Прямоугольник в мм (начало — левый нижний угол) → [x0, y0, x1, y1] в долях, начало — левый верхний."""
    return [
        round(x0_mm * mm / W, 5),
        round(1 - y1_mm * mm / H, 5),
        round(x1_mm * mm / W, 5),
        round(1 - y0_mm * mm / H, 5),
    ]


def answer() -> dict:
    r = next(x for x in ROOMS if x[0] == REMOVED)
    return {
        "removed_room": {
            "number": REMOVED,
            "bbox_a": _to_frac(r[2], r[3], r[2] + r[4], r[3] + r[5]),
        },
        "wall_old": {
            "bbox_a": _to_frac(
                WALL_A[0][0] - 1, WALL_A[0][1], WALL_A[1][0] + 1, WALL_A[1][1]
            )
        },
        "wall_new": {
            "bbox_a": _to_frac(
                WALL_B[0][0] - 1, WALL_B[0][1], WALL_B[1][0] + 1, WALL_B[1][1]
            )
        },
    }


def _axes(c: canvas.Canvas) -> None:
    c.setLineWidth(0.4)
    c.setDash(6, 2)
    for i, x in enumerate(range(30, 230, 30)):
        c.line(x * mm, 45 * mm, x * mm, 175 * mm)
        c.setDash()
        c.circle(x * mm, 180 * mm, 4 * mm)
        c.setFont("Noto", 9)
        c.drawCentredString(x * mm, 178.5 * mm, str(i + 1))
        c.setDash(6, 2)
    for j, (y, name) in enumerate(zip((60, 110, 160), "АБВ")):
        c.line(22 * mm, y * mm, 235 * mm, y * mm)
        c.setDash()
        c.circle(16 * mm, y * mm, 4 * mm)
        c.drawCentredString(16 * mm, y * mm - 1.5 * mm, name)
        c.setDash(6, 2)
    c.setDash()


def draw_plan(
    path: Path,
    variant: str = "A",
    *,
    dx_mm: float = 0.0,
    dy_mm: float = 0.0,
    rot_deg: float = 0.0,
    rotate_page: int = 0,
) -> Path:
    """Лист плана. variant: A — исходная редакция, B — с изменениями. dx/dy/rot — смещение всего листа.
    rotate_page — /Rotate страницы (90 — лист «лёжа», как в альбомах)."""
    c = canvas.Canvas(str(path), pagesize=(W, H), invariant=1)
    c.setTitle(f"СК2-Р-АР лист 3 ред. {variant}")
    c.saveState()
    c.translate(W / 2 + dx_mm * mm, H / 2 + dy_mm * mm)
    c.rotate(rot_deg)
    c.translate(-W / 2, -H / 2)
    # рамка и штамп
    c.setLineWidth(1.0)
    c.rect(20 * mm, 8 * mm, W - 28 * mm, H - 16 * mm)
    sx, sy = W - 8 * mm - 150 * mm, 8 * mm
    c.rect(sx, sy, 150 * mm, 30 * mm)
    c.line(sx, sy + 15 * mm, sx + 150 * mm, sy + 15 * mm)
    c.line(sx + 110 * mm, sy, sx + 110 * mm, sy + 30 * mm)
    c.setFont("Noto", 9)
    c.drawString(sx + 3 * mm, sy + 22 * mm, "Шифр: СК2-Р-АР")
    c.drawString(sx + 3 * mm, sy + 17 * mm, "План 1-го этажа на отм. 0.000")
    c.drawString(sx + 3 * mm, sy + 5 * mm, "ЖК «Северный квартал», корпус 2")
    c.drawString(sx + 113 * mm, sy + 22 * mm, "Лист 3")
    c.drawString(sx + 113 * mm, sy + 17 * mm, f"Ред. {variant}")
    c.drawString(sx + 113 * mm, sy + 5 * mm, "М 1:100")
    _axes(c)
    # помещения
    for num, name, x, y, w, h in ROOMS:
        if variant == "B" and num == REMOVED:
            continue
        c.setLineWidth(1.6)
        c.rect(x * mm, y * mm, w * mm, h * mm)
        c.setFont("Noto", 10)
        c.drawCentredString((x + w / 2) * mm, (y + h / 2 + 2) * mm, num)
        c.setFont("Noto", 6)
        c.drawCentredString((x + w / 2) * mm, (y + h / 2 - 3) * mm, name[:22])
    # перегородка в 102
    (x0, y0), (x1, y1) = WALL_B if variant == "B" else WALL_A
    c.setLineWidth(1.2)
    c.line(x0 * mm, y0 * mm, x1 * mm, y1 * mm)
    # размерная линия под осями
    c.setLineWidth(0.4)
    c.line(30 * mm, 50 * mm, 210 * mm, 50 * mm)
    for x in (30, 90, 135, 175, 210):
        c.line((x - 1) * mm, 49 * mm, (x + 1) * mm, 51 * mm)
    c.setFont("Noto", 7)
    for a, b in ((30, 90), (90, 135), (135, 175), (175, 210)):
        c.drawCentredString((a + b) / 2 * mm, 51.5 * mm, f"{(b - a) * 100}")
    # примечания справа
    c.setFont("Noto", 8)
    for i, t in enumerate(
        (
            "1. Отметка 0.000 — уровень чистого пола.",
            "2. Перегородки — ГКЛ по металлокаркасу.",
            "3. Двери — по спецификации лист 7.",
        )
    ):
        c.drawString(240 * mm, 170 * mm - i * 5 * mm, t)
    c.restoreState()
    c.showPage()
    c.save()
    if rotate_page:
        import pypdfium2 as pdfium

        from inspector_ml.parse import PDFIUM_LOCK

        with PDFIUM_LOCK:
            pdf = pdfium.PdfDocument(str(path))
            pdf[0].set_rotation(rotate_page)
            tmp = path.with_suffix(".tmp")
            pdf.save(str(tmp))
            pdf.close()
        tmp.replace(path)
    return path


def draw_other(path: Path) -> Path:
    """Чужой лист: спецификация (таблица текста), без общей графики с планом."""
    c = canvas.Canvas(str(path), pagesize=(W, H), invariant=1)
    c.setFont("Noto", 11)
    c.drawString(30 * mm, H - 25 * mm, "Спецификация заполнения дверных проёмов")
    c.setFont("Noto", 8)
    for i in range(22):
        y = H - 40 * mm - i * 6.5 * mm
        c.drawString(30 * mm, y, f"Д-{i + 1:02d}")
        c.drawString(
            55 * mm, y, f"ГОСТ 475-2016 ДПН Г Оп Пр {2100 - i * 10}-{900 + i * 5}"
        )
        c.drawString(160 * mm, y, f"{(i * 7) % 13 + 1} шт.")
    c.showPage()
    c.save()
    return path


def build(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    draw_plan(out / "SEV-RD-AR-PLAN-A.pdf", "A")
    draw_plan(out / "SEV-RD-AR-PLAN-B.pdf", "B", dx_mm=3.0, dy_mm=-2.0, rot_deg=0.7)
    (out / "answer-key.json").write_text(
        json.dumps(answer(), ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(
        f"{out}: пара редакций листа АР (сдвиг 3/−2 мм, поворот 0,7°, удалено пом. {REMOVED}, перенесена перегородка)"
    )


if __name__ == "__main__":
    build(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data/fixtures/sheetdiff")
