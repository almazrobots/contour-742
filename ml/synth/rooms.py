"""Синтетика уровня помещения (карта сценариев T-103, живые документы, 09-живые-документы.md).

Эталонные нарушения организатора — не числа ТЭП, а состав оборудования помещения: «в ПД тёплый пол, в РД радиаторы».
Этот генератор рисует вымышленный двойник такого случая (ADR-0002: только синтетика, свои шифры и объект):

  ПД  — принципиальная схема отопления: в помещениях МГН 267/270 и 271/272 тёплый пол и регулятор;
  РД  — план 2 этажа, изм. 3: в тех же помещениях радиаторы, изменение обведено облаком «Изм. №3» (ГОСТ Р 21.101);
  ИД  — исполнительный чертёж: смонтированы радиаторы, рядом с проектной мощностью — фактическая.

Рядом — rooms.json: что стоит в каждом помещении по стадиям (разметка для будущего детектора «по помещению»).

    uv run python synth/rooms.py [каталог]   # по умолчанию ../data/synth-rooms/OBJ-ROOM-1 (вне data/synth: тот набор раздаёт заглушка «РиН» в тестах)
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

from reportlab.lib.pagesizes import A3, landscape
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from inspector_ml.paths import repo_root

ROOT = repo_root()
FONT = ROOT / "assets/fonts/NotoSans.ttf"
if "Noto" not in pdfmetrics.getRegisteredFontNames():
    pdfmetrics.registerFont(TTFont("Noto", str(FONT)))

OBJECT = {
    "object_id": "OBJ-ROOM-1",
    "name": "Школа на 600 мест (синтетический двойник)",
    "address": "г. Москва, ул. Вымышленная Тюменская, вл. 5",
    "customer": "АНО «Вымышленная инфраструктура»",
    "contractor": "ООО «Условный подрядчик»",
    "permit_number": "77-000-0005-2025",
    "profile": {
        "residential": False,
        "underground": True,
        "gas": False,
        "demolition": False,
    },
}

# помещения второго этажа: номер, название, оборудование по ПД, по РД, по ИД (фактическая мощность)
ROOMS = [
    ("267", "Раздевальная для МГН", "тёплый пол", "радиатор PRADO Universal 22-500-700", "радиатор 800 Вт"),
    ("270", "Санузел с душем для МГН", "тёплый пол", "радиатор PRADO Universal 22-500-700", "радиатор 800 Вт"),
    ("263", "Раздевальная", "радиатор PRADO Universal 21-300-500", "радиатор PRADO Universal 21-300-500", "радиатор 500 Вт"),
    ("271", "Раздевальная для МГН", "тёплый пол", "радиатор PRADO Universal 22-500-800", "радиатор 800 Вт"),
    ("272", "Санузел с душем для МГН", "тёплый пол", "радиатор PRADO Universal 22-500-800", "радиатор 800 Вт"),
    ("277", "ПУИ", "радиатор PRADO Universal 10-300-500", "радиатор PRADO Universal 10-300-500", "радиатор 170 Вт"),
]
CHANGED = {"267", "270", "271", "272"}  # помещения под облаком «Изм. №3»

W, H = landscape(A3)
ROOM_W, ROOM_H = 60 * mm, 42 * mm
X0, Y0 = 30 * mm, 150 * mm


def _stamp(c: canvas.Canvas, code: str, title: str, izm: str, sheet: int) -> None:
    """Основная надпись по ГОСТ Р 21.101 (упрощённо): шифр, наименование листа, изменение, номер листа."""
    x, y, w, h = W - 195 * mm, 10 * mm, 185 * mm, 40 * mm
    c.setLineWidth(1.2)
    c.rect(x, y, w, h)
    c.line(x, y + 26 * mm, x + w, y + 26 * mm)
    c.line(x + 150 * mm, y, x + 150 * mm, y + 26 * mm)
    c.setFont("Noto", 11)
    c.drawString(x + 4 * mm, y + 30 * mm, code)
    c.setFont("Noto", 8)
    c.drawString(x + 4 * mm, y + 18 * mm, title)
    c.drawString(x + 4 * mm, y + 8 * mm, f"Изм. {izm}" if izm else "Изм. —")
    c.drawString(x + 153 * mm, y + 12 * mm, f"Лист {sheet}")


def _room(c: canvas.Canvas, i: int, num: str, name: str) -> tuple[float, float]:
    x = X0 + (i % 3) * (ROOM_W + 8 * mm)
    y = Y0 - (i // 3) * (ROOM_H + 20 * mm)
    c.setLineWidth(2.2)
    c.rect(x, y, ROOM_W, ROOM_H)
    c.setFont("Noto", 9)
    c.drawString(x + 3 * mm, y + ROOM_H - 6 * mm, f"{num} {name}")
    return x, y


def _floor_heating(c: canvas.Canvas, x: float, y: float) -> None:
    """Змеевик тёплого пола и регулятор — так их рисует схема ПД."""
    c.setLineWidth(0.9)
    step = 4 * mm
    px, py = x + 6 * mm, y + 6 * mm
    for k in range(6):
        c.line(px, py + k * step, px + 40 * mm, py + k * step)
        if k < 5:
            xe = px + 40 * mm if k % 2 == 0 else px
            c.line(xe, py + k * step, xe, py + (k + 1) * step)
    c.rect(x + ROOM_W - 12 * mm, y + ROOM_H - 16 * mm, 7 * mm, 7 * mm)
    c.setFont("Noto", 7)
    c.drawString(x + 6 * mm, y + 2 * mm, "Тёплый пол · регулятор Multibox C/RTL")


def _radiator(c: canvas.Canvas, x: float, y: float, label: str) -> None:
    c.setLineWidth(1.1)
    c.rect(x + 8 * mm, y + 8 * mm, 30 * mm, 5 * mm)
    for k in range(1, 6):
        c.line(
            x + 8 * mm + k * 5 * mm, y + 8 * mm, x + 8 * mm + k * 5 * mm, y + 13 * mm
        )
    c.setFont("Noto", 7)
    c.drawString(x + 8 * mm, y + 16 * mm, label)


def _cloud(
    c: canvas.Canvas, x: float, y: float, w: float, h: float, label: str
) -> None:
    """Облако изменения: контур из дуг по периметру и номер изменения (ГОСТ Р 21.101-2020, п. 7.5)."""
    c.setLineWidth(1)
    r = 5 * mm

    def arcs(x1: float, y1: float, x2: float, y2: float) -> None:
        n = max(int(math.hypot(x2 - x1, y2 - y1) // (2 * r)), 1)
        for k in range(n):
            ax = x1 + (x2 - x1) * k / n
            ay = y1 + (y2 - y1) * k / n
            bx = x1 + (x2 - x1) * (k + 1) / n
            by = y1 + (y2 - y1) * (k + 1) / n
            c.arc(
                min(ax, bx) - (r if ax == bx else 0),
                min(ay, by) - (r if ay == by else 0),
                max(ax, bx) + (r if ax == bx else 0),
                max(ay, by) + (r if ay == by else 0),
                0,
                180,
            )

    arcs(x, y + h, x + w, y + h)
    arcs(x, y, x + w, y)
    c.line(x, y, x, y + h)
    c.line(x + w, y, x + w, y + h)
    c.setFont("Noto", 10)
    c.drawString(x + 2 * mm, y + h + 8 * mm, label)


def _sheet(path: Path, stage: str) -> None:
    c = canvas.Canvas(str(path), pagesize=(W, H), invariant=1)
    c.setFont("Noto", 13)
    titles = {
        "PD": ("РУМ-П-ИОС4.2", "Принципиальная схема системы отопления", "", 21),
        "RD": ("РУМ-РД-ОВ2.1", "План 2 этажа (отопление)", "3", 4),
        "ID": ("РУМ-ИД-ОВ2.1", "Исполнительный чертёж. План 2 этажа. Отопление", "", 1),
    }
    code, title, izm, sheet = titles[stage]
    c.drawString(30 * mm, H - 20 * mm, title)
    for i, (num, name, pd, rd, fact) in enumerate(ROOMS):
        x, y = _room(c, i, num, name)
        if stage == "PD":
            if pd == "тёплый пол":
                _floor_heating(c, x, y)
            else:
                _radiator(c, x, y, pd)
        elif stage == "RD":
            _radiator(c, x, y, rd)
        else:
            _radiator(
                c,
                x,
                y,
                f"{rd.replace('радиатор ', '')} · факт {fact.replace('радиатор ', '')}",
            )
    if stage == "RD":
        # облако — только вокруг изменённых 267, 270, 271, 272 (два первых столбца обоих рядов)
        _cloud(
            c,
            X0 - 4 * mm,
            Y0 - ROOM_H - 24 * mm,
            2 * ROOM_W + 16 * mm,
            2 * ROOM_H + 28 * mm,
            "Изм. №3",
        )
    # экспликация помещений
    c.setFont("Noto", 8)
    ty = 110 * mm
    c.drawString(250 * mm, ty + 6 * mm, "Экспликация помещений 2 этажа")
    for k, (num, name, *_rest) in enumerate(ROOMS):
        c.drawString(250 * mm, ty - k * 5 * mm, f"{num}  {name}")
    _stamp(c, code, title, izm, sheet)
    c.showPage()
    c.save()


def _sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def build(out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    spec = [
        ("ROOM-PD-OV", "PD", "ИОС4", "РУМ-П-ИОС4.2", "1", "APPROVED", "2024-03-10"),
        (
            "ROOM-RD-OV21",
            "RD",
            "ОВ",
            "РУМ-РД-ОВ2.1",
            "3",
            "FOR_CONSTRUCTION",
            "2025-04-23",
        ),
        ("ROOM-ID-ISP", "ID", "ОВ", "РУМ-ИД-ОВ2.1", "1", "APPROVED", "2025-10-07"),
    ]
    files = []
    for fid, stage, disc, code, rev, status, date in spec:
        p = out / f"{fid}.pdf"
        _sheet(p, stage)
        files.append(
            {
                "file_id": fid,
                "file_name": p.name,
                "sha256": _sha256(p),
                "doc_stage": stage,
                "discipline": disc,
                "document_code": code,
                "revision": rev,
                "approval_status": status,
                "approval_date": date,
                "sheet_page_range": "1",
                "predecessor_id": None,
                "signature_status": "SCAN_SIGNED",
            }
        )
    manifest = {"object": OBJECT, "files": files}
    (out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    rooms = {
        "about": "Состав оборудования помещений по стадиям; changed — помещения под облаком «Изм. №3» на листе РД.",
        "rooms": [
            {
                "room": n,
                "name": nm,
                "PD": pd,
                "RD": rd,
                "ID": f,
                "changed": n in CHANGED,
            }
            for n, nm, pd, rd, f in ROOMS
        ],
        "expected_findings": [
            {
                "rooms": sorted(CHANGED),
                "kind": "ROOM_EQUIPMENT_CHANGED",
                "pd": "тёплый пол",
                "rd": "радиаторы",
                "evidence": {
                    "PD": "РУМ-П-ИОС4.2, лист 21",
                    "RD": "РУМ-РД-ОВ2.1, изм. 3, лист 4 (облако «Изм. №3»)",
                    "ID": "РУМ-ИД-ОВ2.1",
                },
            },
        ],
    }
    (out / "rooms.json").write_text(
        json.dumps(rooms, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return manifest


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data/synth-rooms/OBJ-ROOM-1"
    m = build(target)
    print(f"{m['object']['object_id']}: {len(m['files'])} файла → {target}")
