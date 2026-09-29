"""Фабрика синтетики v2 (OS-INSP-6.4.1): листы с известными ответами для стенда оценки §14.

Генератор v1 (synth/generate.py) не трогаем — на нём держатся answer-key и e2e. Фабрика v2 делает
произвольное число вымышленных объектов, детерминированно по seed:

- листы PDF с текстовым слоем и сканы (растр 150–300 dpi, наклон, размытие, шум, JPEG);
- штамп-рамка (шифр, стадия, редакция, статус, лист/листов, дата), синяя печать, подпись-росчерк,
  штампы «В производство работ» (РД) и «Выполнено согласно проекту» (ИД);
- таблица ТЭП с параметрами Матрицы (якорь = название параметра), экспликация помещений;
- пара редакций РД (A → B) с контролируемыми изменениями, иногда — конфликт редакций КЖ;
- эталон gold.json в формате стенда (eval/README.md): текст страниц, ключевые поля, значения
  с bbox, реквизиты с bbox, области изменений, evidence_group со статусами.

Эталонные статусы считаются тем же решающим слоем, что и у системы (eval/decide.py), по ИСТИННЫМ
значениям — эталон равен ответу системы при идеальном распознавании.

    uv run python -m synth.factory --n 10 --seed 1 --out ../var/synth-v2   # из каталога ml/

Правило №0: по умолчанию n = 3; сканы — самая дорогая часть (OCR при оценке ~5 с/страница).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import random
import sys
import time
from dataclasses import dataclass, field, replace
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

ML = Path(__file__).resolve().parents[1]
if str(ML) not in sys.path:  # запуск файлом: python synth/factory.py
    sys.path.insert(0, str(ML))

from eval.decide import StageValue, choose, evaluate, select_revisions
from inspector_ml.paths import repo_root

ROOT = repo_root()  # не ML.parent: песочница mutmut глубже исходников
FONT = ROOT / "assets/fonts/NotoSans.ttf"
MATRIX = {
    p["code"]: p
    for p in json.loads((ROOT / "data/seed/matrix.json").read_text("utf-8"))
}
pdfmetrics.registerFont(TTFont("Noto", str(FONT)))

PAGE_W, PAGE_H = 210.0, 297.0  # A4, мм
PT = 72 / 25.4  # пунктов в мм
SCHEMA = "inspector-eval-gold/1"

# ─────────────────────────────────────────────── параметры Матрицы и их значения

# код → (подпись в ТЭП = якорь Матрицы, единица, группа документа, генератор базы, форматтер)
# Группа: «AR» — ТЭП пояснительной записки и АР; «KR» — конструктив (КР/КЖ, ИД по бетону).


def _area(v: float) -> str:
    s = f"{v:,.1f}".replace(",", " ").replace(".", ",")
    return s


def _dec2(v: float) -> str:
    return f"{v:.2f}".replace(".", ",")


POOL: dict[str, dict] = {
    "M-001": {
        "label": "Площадь застройки",
        "unit": "м²",
        "grp": "AR",
        "base": lambda r: round(r.uniform(800, 4000), 1),
        "fmt": _area,
    },
    "M-002": {
        "label": "Общая площадь здания",
        "unit": "м²",
        "grp": "AR",
        "base": lambda r: round(r.uniform(5000, 20000), 1),
        "fmt": _area,
    },
    "M-007": {
        "label": "Этажность",
        "unit": "эт.",
        "grp": "AR",
        "base": lambda r: r.randint(3, 25),
        "fmt": str,
    },
    "M-010": {
        "label": "Количество квартир",
        "unit": "шт.",
        "grp": "AR",
        "base": lambda r: r.randint(40, 400),
        "fmt": str,
        "needs": "residential",
    },
    "M-012": {
        "label": "Количество машино-мест",
        "unit": "шт.",
        "grp": "AR",
        "base": lambda r: r.randint(20, 200),
        "fmt": str,
        "needs": "underground",
    },
    "M-040": {
        "label": "Ширина эвакуационного коридора",
        "unit": "м",
        "grp": "AR",
        "base": lambda r: r.choice([1.4, 1.5, 1.6, 1.8, 2.0]),
        "fmt": _dec2,
    },
    "M-041": {
        "label": "Ширина эвакуационного выхода",
        "unit": "м",
        "grp": "AR",
        "base": lambda r: r.choice([1.0, 1.1, 1.2, 1.35]),
        "fmt": _dec2,
    },
    "M-021": {
        "label": "Класс энергетической эффективности",
        "unit": "",
        "grp": "AR",
        "base": lambda r: r.choice(["A", "B", "A+"]),
        "fmt": str,
    },
    "M-103": {
        "label": "Предел огнестойкости противопожарных дверей",
        "unit": "мин",
        "grp": "AR",
        "base": lambda r: r.choice([60, 90]),
        "fmt": lambda v: f"EI {v}",
    },
    "M-055": {
        "label": "Класс бетона",
        "unit": "",
        "grp": "KR",
        "base": lambda r: r.choice([30, 35, 40]),
        "fmt": lambda v: f"B{v}",
    },
    "M-057": {
        "label": "Класс арматуры",
        "unit": "",
        "grp": "KR",
        "base": lambda r: r.choice([500, 600]),
        "fmt": lambda v: f"A{v}С",
    },
    "M-058": {
        "label": "Толщина фундаментной плиты",
        "unit": "мм",
        "grp": "KR",
        "base": lambda r: r.choice([600, 700, 800, 900, 1000]),
        "fmt": str,
    },
    "M-059": {
        "label": "Толщина плиты перекрытия",
        "unit": "мм",
        "grp": "KR",
        "base": lambda r: r.choice([180, 200, 220, 250]),
        "fmt": str,
    },
}

# Набор v2 фиксируется здесь: factory_v3.install() дописывает в POOL все 132 параметра, и без снимка
# v2 после v3 в том же процессе строила бы другие объекты — эталон зависел бы от порядка запуска.
V2_CODES = tuple(POOL)

ENERGY = ["E", "D", "C", "B", "A", "A+", "A++"]


def worse(code: str, v, r: random.Random):
    """Значение, нарушающее правило параметра относительно v (для CANDIDATE)."""
    if POOL.get(code, {}).get("worse"):  # генератор фабрики v3 для параметров вне ручного пула
        return POOL[code]["worse"](v, r)
    kind = MATRIX[code]["compare"]["kind"]
    if code == "M-021":
        return ENERGY[max(ENERGY.index(v) - r.randint(1, 2), 0)]
    if code == "M-041":
        return r.choice([0.8, 0.85])
    if code in ("M-055", "M-103"):
        return {30: 25, 35: 30, 40: 35, 60: 30, 90: 60}[v]
    if code == "M-057":
        return 400 if v == 500 else 500
    if kind == "delta_pct":
        tol = MATRIX[code]["compare"]["tolerance"]
        return round(
            v * (1 + r.choice([-1, 1]) * r.uniform(tol + 1.5, tol + 5) / 100), 1
        )
    if kind == "equal":
        return v + r.choice([-1, 1]) * r.randint(1, 3)
    if kind == "decrease":
        step = {"M-040": 0.2, "M-058": 100, "M-059": 20}.get(code)
        return round(v - step, 2) if step else v - r.randint(2, 10)
    raise ValueError(code)


def same(code: str, v, r: random.Random):
    """Значение, НЕ нарушающее правило (для NEGATIVE_VERIFIED): равное или в допуске."""
    if POOL.get(code, {}).get("same"):
        return POOL[code]["same"](v, r)
    kind = MATRIX[code]["compare"]["kind"]
    if (
        kind == "delta_pct"
        and MATRIX[code]["compare"]["tolerance"] > 0
        and r.random() < 0.5
    ):
        tol = MATRIX[code]["compare"]["tolerance"]
        return round(v * (1 + r.uniform(-tol, tol) * 0.5 / 100), 1)
    return v


def as_stage_value(code: str, v) -> tuple[float | None, str | None]:
    """Истинное значение в виде, в котором его отдаёт extract (value_num / value_text)."""
    p = MATRIX[code]
    if p["data_type"] == "number" and not p.get("regex_pattern"):
        return float(v), None
    from inspector_ml.extract import NUMERIC_RULES
    from inspector_ml.normalize import latinize_code, parse_number

    text = latinize_code(POOL[code]["fmt"](v))
    # OS-INSP-2.2.9: строка с числовым правилом несёт и главное число — как её отдаёт extract
    if p["data_type"] == "string" and not p.get("regex_pattern") and p["compare"]["kind"] in NUMERIC_RULES:
        return parse_number(POOL[code]["fmt"](v)), text
    return None, text


# ─────────────────────────────────────────────── вёрстка листа: операции и геометрия


@dataclass
class TextOp:
    x: float  # мм от левого края (для align="r" — правый край)
    base: float  # базовая линия, мм от верхнего края
    text: str
    size: float = 10.0
    align: str = "l"


@dataclass
class LineOp:
    x0: float
    y0: float
    x1: float
    y1: float
    width: float = 0.3


@dataclass
class ImgOp:
    kind: str  # seal | signature | stamp_production | stamp_done
    x: float
    y: float
    w: float
    h: float
    seed: int
    text: str = ""
    date: str = ""


@dataclass
class PageSpec:
    ops: list = field(default_factory=list)
    key_fields: list = field(default_factory=list)  # (field, value, bbox_mm)
    values: list = field(default_factory=list)  # (code, raw, bbox_mm, row_bbox_mm)
    rooms: list = field(default_factory=list)  # (number, bbox_mm)


@lru_cache(maxsize=64)
def _font(px: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT), px, layout_engine=ImageFont.Layout.BASIC)


EM = 1000  # размер эталонного шрифта для измерений, px на кегль


def _adv(text: str, size: float) -> float:
    return _font(EM).getlength(text) * size / EM / PT


def text_left(op: TextOp) -> float:
    return op.x - _adv(op.text, op.size) if op.align == "r" else op.x


INK = 200  # кегль растра для измерения чернил, px


@lru_cache(maxsize=4096)
def _ink(sub: str) -> tuple[float, float, float, float] | None:
    """Рамка чернил строки относительно начала базовой линии, в долях кегля.

    getbbox у Pillow по горизонтали берёт ширину по advance, а не по контуру: у узкой «1» рамка
    вдвое шире глифа. pdfium и OCR дают рамку контура — поэтому меряем по растру.
    """
    f = _font(INK)
    w = int(f.getlength(sub)) + 2 * INK
    im = Image.new("L", (w, 2 * INK))
    ImageDraw.Draw(im).text((INK, int(1.4 * INK)), sub, font=f, fill=255, anchor="ls")
    bb = im.getbbox()
    if not bb:
        return None
    return ((bb[0] - INK) / INK, (bb[1] - 1.4 * INK) / INK, (bb[2] - INK) / INK, (bb[3] - 1.4 * INK) / INK)


def ink_box(op: TextOp, start: int = 0, end: int | None = None) -> tuple[float, float, float, float]:
    """Рамка «чернил» подстроки [start, end) в мм — та же, что у pdfium (рамки глифов) и OCR."""
    end = len(op.text) if end is None else end
    sub = op.text[start:end]
    x = text_left(op) + _adv(op.text[:start], op.size)
    em = op.size / PT  # кегль в мм
    ink = _ink(sub)
    if ink is None:
        return (x, op.base, x, op.base)
    l, t, r, b = ink
    return (x + l * em, op.base + t * em, x + r * em, op.base + b * em)


def norm(b: tuple[float, float, float, float]) -> list[float]:
    return [
        round(b[0] / PAGE_W, 5),
        round(b[1] / PAGE_H, 5),
        round(b[2] / PAGE_W, 5),
        round(b[3] / PAGE_H, 5),
    ]


def _words(op: TextOp) -> list[tuple[str, tuple[float, float, float, float]]]:
    out, pos = [], 0
    for w in op.text.split(" "):
        if w:
            out.append((w, ink_box(op, pos, pos + len(w))))
        pos += len(w) + 1
    return out


def page_text(spec: PageSpec) -> str:
    """Эталонный текст страницы: строки по базовой линии сверху вниз, внутри — слева направо.

    Слова, центр которых попал в зону реквизита (печать, подпись, штамп), исключаются — как и при
    оценке (eval/run.py::page_reading): под печатью это не печатный текст в смысле ТЗ 9.1.1.
    """
    zones = [(o.x, o.y, o.x + o.w, o.y + o.h) for o in spec.ops if isinstance(o, ImgOp)]
    rows: dict[float, list[tuple[float, str]]] = {}
    for op in spec.ops:
        if not isinstance(op, TextOp):
            continue
        for w, b in _words(op):
            cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
            if not any(z[0] <= cx <= z[2] and z[1] <= cy <= z[3] for z in zones):
                rows.setdefault(round(op.base, 2), []).append((b[0], w))
    return "\n".join(" ".join(w for _, w in sorted(rows[k])) for k in sorted(rows))


# ─────────────────────────────────────────────── реквизиты-картинки (без текстового слоя)

BLUE = (35, 70, 190)
VIOLET = (90, 50, 170)


def seal_img(op: ImgOp, px_per_mm: float) -> Image.Image:
    w, h = int(op.w * px_per_mm), int(op.h * px_per_mm)
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    lw = max(2, int(0.5 * px_per_mm))
    d.ellipse((lw, lw, w - lw, h - lw), outline=BLUE + (215,), width=lw)
    d.ellipse(
        (w * 0.18, h * 0.18, w * 0.82, h * 0.82),
        outline=BLUE + (215,),
        width=max(1, lw // 2),
    )
    r = random.Random(op.seed)
    # «текст» по кольцу — штрихи, чтобы OCR не принимал печать за строки
    for i in range(48):
        a = 2 * math.pi * i / 48 + r.uniform(-0.02, 0.02)
        r0, r1 = w * 0.34, w * 0.44
        d.line(
            (
                w / 2 + r0 * math.cos(a),
                h / 2 + r0 * math.sin(a),
                w / 2 + r1 * math.cos(a),
                h / 2 + r1 * math.sin(a),
            ),
            fill=BLUE + (190,),
            width=max(1, lw // 2),
        )
    f = _font(max(8, int(3.2 * px_per_mm)))
    d.text((w / 2, h / 2), op.text, font=f, fill=BLUE + (215,), anchor="mm")
    return im.rotate(r.uniform(-25, 25), resample=Image.BICUBIC)


def signature_img(op: ImgOp, px_per_mm: float) -> Image.Image:
    w, h = int(op.w * px_per_mm), int(op.h * px_per_mm)
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    r = random.Random(op.seed)
    pts, x = [], w * 0.05
    while x < w * 0.95:
        pts.append(
            (
                x,
                h
                * (0.5 + 0.35 * math.sin(x / w * r.uniform(8, 16)) * r.uniform(0.5, 1)),
            )
        )
        x += w * r.uniform(0.02, 0.05)
    d.line(
        pts, fill=(20, 30, 120, 235), width=max(2, int(0.35 * px_per_mm)), joint="curve"
    )
    d.line(
        (w * 0.1, h * 0.8, w * 0.9, h * 0.72),
        fill=(20, 30, 120, 200),
        width=max(1, int(0.25 * px_per_mm)),
    )
    return im


def rect_stamp_img(op: ImgOp, px_per_mm: float) -> Image.Image:
    w, h = int(op.w * px_per_mm), int(op.h * px_per_mm)
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    lw = max(2, int(0.45 * px_per_mm))
    d.rectangle((lw, lw, w - lw, h - lw), outline=VIOLET + (220,), width=lw)
    f = _font(max(8, int(3.6 * px_per_mm)))
    d.text((w / 2, h * 0.35), op.text, font=f, fill=VIOLET + (220,), anchor="mm")
    d.text(
        (w / 2, h * 0.72),
        op.date,
        font=_font(max(8, int(3.0 * px_per_mm))),
        fill=VIOLET + (220,),
        anchor="mm",
    )
    return im.rotate(random.Random(op.seed).uniform(-4, 4), resample=Image.BICUBIC)


IMG = {
    "seal": seal_img,
    "signature": signature_img,
    "stamp_production": rect_stamp_img,
    "stamp_done": rect_stamp_img,
}


# ─────────────────────────────────────────────── документ и его листы


@dataclass
class Doc:
    file_id: str
    stage: str  # PD | RD | ID
    discipline: str
    code: str
    revision: str
    status: str
    date: str
    title: str
    rows: list[tuple[str, object]]  # (код параметра, истинное значение)
    kind: str = "pdf"  # pdf | scan
    predecessor: str | None = None
    rooms: list[tuple[str, str]] = field(default_factory=list)
    dpi: int = 0
    skew: float = 0.0
    blur: float = 0.0
    noise: int = 0

    @property
    def stage_ru(self) -> str:
        return {"PD": "П", "RD": "Р", "ID": "ИД"}[self.stage]


def _stamp(spec: PageSpec, d: Doc, sheet: int, sheets: int) -> None:
    """Штамп-рамка собственной формы (смысл ГОСТ Р 21.101, не его форма)."""
    x0, y0, bw, bh = PAGE_W - 10 - 120, PAGE_H - 10 - 30, 120.0, 30.0
    spec.ops += [
        LineOp(10, 10, PAGE_W - 10, 10, 0.8),
        LineOp(10, PAGE_H - 10, PAGE_W - 10, PAGE_H - 10, 0.8),
        LineOp(10, 10, 10, PAGE_H - 10, 0.8),
        LineOp(PAGE_W - 10, 10, PAGE_W - 10, PAGE_H - 10, 0.8),
        LineOp(x0, y0, x0 + bw, y0, 0.6),
        LineOp(x0, y0, x0, y0 + bh, 0.6),
        LineOp(x0, y0 + 15, x0 + bw, y0 + 15, 0.4),
        LineOp(x0 + 84, y0 + 15, x0 + 84, y0 + bh, 0.4),
    ]
    s = 8.0
    code = TextOp(x0 + 3, y0 + 6, f"Шифр: {d.code}", s)
    head = TextOp(
        x0 + 3,
        y0 + 12,
        f"Стадия: {d.stage_ru}   Ред.: {d.revision}   Статус: {d.status}",
        s,
    )
    title = TextOp(x0 + 3, y0 + 21, d.title[:44], s)
    sh = TextOp(x0 + 87, y0 + 21, f"Лист {sheet}", s)
    date = TextOp(x0 + 3, y0 + 27, f"Дата: {d.date}", s)
    shs = TextOp(x0 + 87, y0 + 27, f"Листов {sheets}", s)
    spec.ops += [code, head, title, sh, date, shs]
    i = head.text.index(d.stage_ru, len("Стадия: "))
    j = head.text.index("Ред.: ") + len("Ред.: ")
    spec.key_fields += [
        ("code", d.code, ink_box(code, len("Шифр: "))),
        ("stage", d.stage_ru, ink_box(head, i, i + len(d.stage_ru))),
        ("revision", d.revision, ink_box(head, j, j + len(d.revision))),
        ("sheet", str(sheet), ink_box(sh, len("Лист "))),
    ]


def _table(
    spec: PageSpec, title: str, rows: list[tuple[str, str, str, str | None]], y: float
) -> float:
    """Таблица «подпись — ед. — значение»: одна строка = одна базовая линия."""
    spec.ops.append(TextOp(20, y, title, 12))
    y += 10
    for code, label, unit, value in rows:
        lab = TextOp(20, y, label, 10)
        spec.ops.append(lab)
        if unit:
            spec.ops.append(TextOp(130, y, unit, 10))
        val = TextOp(190, y, value, 10, "r")
        spec.ops.append(val)
        spec.ops.append(LineOp(20, y + 2.2, 192, y + 2.2, 0.3))
        vb = ink_box(val)
        row = (ink_box(lab)[0], min(ink_box(lab)[1], vb[1]) - 1, vb[2], y + 2.2)
        if code and code.startswith("M-"):
            spec.values.append((code, value, vb, row))
        elif code == "room":
            spec.rooms.append((label.split(" ", 1)[1], ink_box(lab, len("Помещение "))))
        y += 7.5
    return y


def layout(d: Doc, rng: random.Random) -> list[PageSpec]:
    sheets = 2 if d.kind == "scan" else 3
    pages = [PageSpec() for _ in range(sheets)]
    # лист 1 — титул, общие указания, реквизиты
    p1 = pages[0]
    _stamp(p1, d, 1, sheets)
    p1.ops.append(TextOp(20, 25, d.title, 14))
    notes = [
        "Общие указания.",
        "Документация разработана в соответствии с заданием на проектирование.",
        "Отметка 0.000 соответствует уровню чистого пола первого этажа.",
        "Все размеры указаны в миллиметрах, если не оговорено иное.",
    ]
    for i, t in enumerate(notes[: 2 + rng.randint(0, 2)]):
        p1.ops.append(TextOp(20, 40 + i * 6, t, 10))
    p1.ops.append(TextOp(20, 238, "Главный инженер проекта", 9))
    s = rng.randrange(1 << 30)
    p1.ops += [
        ImgOp(
            "seal",
            20 + rng.uniform(0, 8),
            244 + rng.uniform(0, 4),
            34,
            34,
            s,
            text="ООО «Проект-Тест»",
        ),
        ImgOp(
            "signature", 64 + rng.uniform(0, 6), 240 + rng.uniform(0, 3), 26, 11, s + 1
        ),
    ]
    if d.stage == "RD" and d.status == "FOR_CONSTRUCTION":
        p1.ops.append(
            ImgOp(
                "stamp_production",
                120,
                205,
                62,
                22,
                s + 2,
                "В ПРОИЗВОДСТВО РАБОТ",
                d.date,
            )
        )
    if d.stage == "ID":
        p1.ops.append(
            ImgOp(
                "stamp_done",
                120,
                205,
                66,
                22,
                s + 3,
                "ВЫПОЛНЕНО СОГЛАСНО ПРОЕКТУ",
                d.date,
            )
        )
    # лист 2 — ТЭП и экспликация
    p2 = pages[1]
    _stamp(p2, d, 2, sheets)
    rows = [
        (c, POOL[c]["label"], POOL[c]["unit"], POOL[c]["fmt"](v)) for c, v in d.rows
    ]
    y = _table(p2, "Основные показатели", rows, 30)
    if d.rooms:
        _table(
            p2,
            "Экспликация помещений",
            [("room", f"Помещение {n}", "", name) for n, name in d.rooms],
            y + 6,
        )
    if sheets == 3:
        _stamp(pages[2], d, 3, sheets)
        pages[2].ops.append(
            TextOp(
                20,
                30,
                "Примечания: изменения вносятся только через согласованное изменение документации.",
                10,
            )
        )
    return pages


# ─────────────────────────────────────────────── отрисовка: PDF с текстовым слоем и скан


def render_pdf(d: Doc, pages: list[PageSpec], path: Path) -> None:
    w, h = PAGE_W * PT, PAGE_H * PT
    c = canvas.Canvas(
        str(path), pagesize=(w, h), invariant=1
    )  # invariant: без дат и ID — байты по seed
    c.setTitle(f"{d.code} ред. {d.revision}")
    for spec in pages:
        for op in spec.ops:
            if isinstance(op, LineOp):
                c.setLineWidth(op.width)
                c.line(op.x0 * PT, h - op.y0 * PT, op.x1 * PT, h - op.y1 * PT)
            elif isinstance(op, TextOp):
                c.setFont("Noto", op.size)
                fn = c.drawRightString if op.align == "r" else c.drawString
                fn(op.x * PT, h - op.base * PT, op.text)
            else:
                im = IMG[op.kind](op, 12.0)  # ~300 dpi
                buf = io.BytesIO()
                im.save(buf, format="PNG")
                buf.seek(0)
                c.drawImage(
                    ImageReader(buf),
                    op.x * PT,
                    h - (op.y + op.h) * PT,
                    op.w * PT,
                    op.h * PT,
                    mask="auto",
                )
        c.showPage()
    c.save()


def raster(spec: PageSpec, dpi: int) -> Image.Image:
    k = dpi / 25.4
    im = Image.new("RGB", (int(PAGE_W * k), int(PAGE_H * k)), (250, 250, 247))
    dr = ImageDraw.Draw(im)
    for op in spec.ops:
        if isinstance(op, LineOp):
            dr.line(
                (op.x0 * k, op.y0 * k, op.x1 * k, op.y1 * k),
                fill=(30, 30, 30),
                width=max(1, round(op.width / PT * k)),
            )
        elif isinstance(op, TextOp):
            f = _font(max(6, round(op.size / PT * k)))
            dr.text(
                (op.x * k, op.base * k),
                op.text,
                font=f,
                fill=(25, 25, 25),
                anchor="rs" if op.align == "r" else "ls",
            )
    for op in spec.ops:
        if isinstance(op, ImgOp):
            sub = IMG[op.kind](op, k)
            im.paste(sub, (int(op.x * k), int(op.y * k)), sub)
    return im


def rotate_box(
    b: tuple[float, float, float, float], deg: float
) -> tuple[float, float, float, float]:
    """Рамка после поворота листа PIL.rotate(deg) вокруг центра (против часовой, y вниз) — огибающая."""
    a = math.radians(deg)
    cx, cy = PAGE_W / 2, PAGE_H / 2
    pts = []
    for x, y in ((b[0], b[1]), (b[2], b[1]), (b[0], b[3]), (b[2], b[3])):
        dx, dy = x - cx, y - cy
        pts.append(
            (
                cx + dx * math.cos(a) + dy * math.sin(a),
                cy - dx * math.sin(a) + dy * math.cos(a),
            )
        )
    return (
        min(p[0] for p in pts),
        min(p[1] for p in pts),
        max(p[0] for p in pts),
        max(p[1] for p in pts),
    )


def render_scan(d: Doc, pages: list[PageSpec], path: Path, rng: random.Random) -> None:
    w, h = PAGE_W * PT, PAGE_H * PT
    c = canvas.Canvas(str(path), pagesize=(w, h), invariant=1)
    for spec in pages:
        im = raster(spec, d.dpi).rotate(
            d.skew, resample=Image.BICUBIC, fillcolor=(250, 250, 247)
        )
        if d.blur:
            im = im.filter(ImageFilter.GaussianBlur(d.blur))
        dr = ImageDraw.Draw(im)
        for _ in range(d.noise):
            v = rng.randrange(90, 230)
            dr.point(
                (rng.randrange(im.width), rng.randrange(im.height)), fill=(v, v, v)
            )
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=82)
        buf.seek(0)
        c.drawImage(ImageReader(buf), 0, 0, width=w, height=h)
        c.showPage()
    c.save()


# ─────────────────────────────────────────────── объект: состав, значения, сценарии

PREFIX = "АБВГДЕЖКЛМНПРСТУ"
ROOMS = [
    "Техническое помещение",
    "Регистратура",
    "Кабинет",
    "Вестибюль",
    "Склад",
    "Серверная",
    "Кладовая уборочного инвентаря",
]


def _date(r: random.Random, year: int, m0: int = 1, m1: int | None = None) -> str:
    """Дата в окне месяцев [m0; m1]: ПД раньше РД, ред. A раньше B, ИД — позже всех."""
    return f"{year}-{r.randint(m0, m1 or m0 + 2):02d}-{r.randint(1, 28):02d}"


def make_object(seed: int, i: int) -> tuple[dict, list[Doc], dict]:
    r = random.Random(f"synth-v2:{seed}:{i}")
    oid = f"SYN-{seed}-{i:03d}"
    pfx = "".join(r.choice(PREFIX) for _ in range(2)) + str(r.randint(1, 99))
    profile = {
        "residential": r.random() < 0.6,
        "underground": r.random() < 0.5,
        "gas": False,
        "demolition": False,
    }
    codes = [c for c in V2_CODES if not POOL[c].get("needs") or profile[POOL[c]["needs"]]]
    chosen = sorted(r.sample(codes, k=min(len(codes), r.randint(7, 10))))
    base = {c: POOL[c]["base"](r) for c in chosen}
    conflict_kr = r.random() < 0.3
    # сценарий каждого параметра: pos — нарушение, neg — совпадение, trap — нарушение только в устаревшей
    # редакции РД (A), missing — нет значения в РД/ИД
    scen = {}
    for c in chosen:
        roll = r.random()
        grp = POOL[c]["grp"]
        if roll < 0.40:
            scen[c] = "pos"
        elif roll < 0.55 and grp == "AR":
            scen[c] = "trap"
        elif roll < 0.63:
            scen[c] = "missing"
        else:
            scen[c] = "neg"
    ar = [c for c in chosen if POOL[c]["grp"] == "AR"]
    kr = [c for c in chosen if POOL[c]["grp"] == "KR"]
    id_params = [c for c in kr if c in ("M-055", "M-058") and scen[c] != "missing"]

    def rd_value(c):
        return worse(c, base[c], r) if scen[c] == "pos" else same(c, base[c], r)

    def scan_params():
        return {
            "kind": "scan",
            "dpi": r.choice([150, 200, 240, 300]),
            "skew": round(r.uniform(-1.5, 1.5), 2),
            "blur": round(r.uniform(0.0, 0.9), 2),
            "noise": r.randint(1500, 6000),
        }

    y = 2025
    rooms_pd = [
        (f"{r.randint(0, 3)}.{k:02d}", r.choice(ROOMS))
        for k in sorted(r.sample(range(1, 40), 3))
    ]
    docs = [
        Doc(
            f"{oid}-PD-PZ",
            "PD",
            "ПЗ",
            f"{pfx}-П-ПЗ",
            "1",
            "APPROVED",
            _date(r, y, 1),
            "Пояснительная записка. ТЭП",
            [(c, base[c]) for c in ar],
            rooms=rooms_pd,
        ),
    ]
    if kr:
        docs.append(
            Doc(
                f"{oid}-PD-KR",
                "PD",
                "КР",
                f"{pfx}-П-КР",
                "1",
                "APPROVED",
                _date(r, y, 1),
                "Конструктивные решения",
                [(c, base[c]) for c in kr],
            )
        )
    # РД АР: пара редакций A → B с контролируемыми изменениями
    rd_b = {c: rd_value(c) for c in ar if scen[c] != "missing"}
    rd_a = {}
    for c in ar:
        if scen[c] == "missing":
            continue
        if scen[c] == "trap":
            rd_a[c] = worse(c, base[c], r)
        elif r.random() < 0.3:
            rd_a[c] = worse(c, base[c], r) if scen[c] == "neg" else base[c]
        else:
            rd_a[c] = rd_b[c]
    if (
        r.random() < 0.3 and len(rd_a) > 2
    ):  # строка, которой не было в ред. A и которая добавлена в ред. B
        rd_a.pop(min(rd_a))
    a_kind = scan_params() if r.random() < 0.25 else {}
    docs.append(
        Doc(
            f"{oid}-RD-AR-A",
            "RD",
            "АР",
            f"{pfx}-Р-АР",
            "A",
            "SUPERSEDED",
            _date(r, y, 4),
            "Архитектурные решения. Общие данные",
            list(rd_a.items()),
            rooms=rooms_pd,
            **a_kind,
        )
    )
    rooms_rd = [
        (n, name if r.random() < 0.8 else r.choice(ROOMS)) for n, name in rooms_pd
    ]
    docs.append(
        Doc(
            f"{oid}-RD-AR-B",
            "RD",
            "АР",
            f"{pfx}-Р-АР",
            "B",
            "FOR_CONSTRUCTION",
            _date(r, y, 7),
            "Архитектурные решения. Общие данные",
            list(rd_b.items()),
            predecessor=f"{oid}-RD-AR-A",
            rooms=rooms_rd,
        )
    )
    if kr:
        kzh = {c: rd_value(c) for c in kr if scen[c] != "missing"}
        k_kind = scan_params() if r.random() < 0.3 else {}
        docs.append(
            Doc(
                f"{oid}-RD-KZH-1",
                "RD",
                "КЖ",
                f"{pfx}-Р-КЖ",
                "1",
                "FOR_CONSTRUCTION",
                _date(r, y, 7),
                "Конструкции железобетонные",
                list(kzh.items()),
                **k_kind,
            )
        )
        if (
            conflict_kr
        ):  # вторая утверждённая редакция без связи замены — конфликт (OS-INSP-1.3)
            docs.append(
                Doc(
                    f"{oid}-RD-KZH-2",
                    "RD",
                    "КЖ",
                    f"{pfx}-Р-КЖ",
                    "2",
                    "FOR_CONSTRUCTION",
                    _date(r, y, 10),
                    "Конструкции железобетонные",
                    list(kzh.items()),
                )
            )
    if id_params:
        idv = {
            c: (
                worse(c, base[c], r)
                if scen[c] == "pos" and r.random() < 0.5
                else same(c, base[c], r)
            )
            for c in id_params
        }
        docs.append(
            Doc(
                f"{oid}-ID-JBR",
                "ID",
                "КЖ",
                f"{pfx}-ИД-ЖБР",
                "1",
                "APPROVED",
                _date(r, 2026, 1),
                "Журнал бетонных работ (выписка)",
                list(idv.items()),
                **scan_params(),
            )
        )
    obj = {
        "object_id": oid,
        "name": f"Вымышленный объект {pfx}",
        "profile": profile,
        "scenarios": scen,
        "conflict_kr": conflict_kr,
    }
    return obj, docs, base


# ─────────────────────────────────────────────── эталон


def _group_gold(
    obj: dict, docs: list[Doc], placed: dict, roles: dict[str, str]
) -> list[dict]:
    """evidence_group по каждому параметру объекта: статус и фрагменты — решающим слоем по истине."""
    by_file = {d.file_id: d for d in docs}
    out = []
    for code in sorted({c for d in docs for c, _ in d.rows}):
        param = MATRIX[code]
        cands = []
        for d in docs:
            for c, v in d.rows:
                if c != code:
                    continue
                num, text = as_stage_value(code, v)
                page, bbox = placed[(d.file_id, code)]
                cands.append(
                    StageValue(
                        d.stage,
                        num,
                        text,
                        POOL[code]["fmt"](v),
                        d.file_id,
                        page,
                        bbox,
                        roles[d.file_id],
                        d.code,
                        d.revision,
                        1.0,
                        d.discipline,
                    )
                )
        used = choose(cands, param)
        ev = evaluate(param, obj["profile"], used, {d.stage for d in docs})
        trap = ev.status == "NEGATIVE_VERIFIED" and any(
            c.role == "SUPERSEDED" and superseded_would_violate(param, used, c) for c in cands
        )
        out.append(
            {
                "evidence_group_id": f"{obj['object_id']}:{code}",
                "object_id": obj["object_id"],
                "param": code,
                "section": param["section"],
                "violation_type": param["compare"]["kind"],
                "label": ev.status,
                "superseded_trap": bool(trap),
                "expected_value": ev.expected,
                "actual_value": ev.actual,
                "evidence": [
                    {
                        "file_id": f.file_id,
                        "page": f.page,
                        "bbox": f.bbox,
                        "stage": f.stage,
                        "document_code": f.document_code,
                        "revision": f.revision,
                        "approval_status": by_file[f.file_id].status,
                    }
                    for f in ev.fragments
                ],
            }
        )
    return out


def superseded_would_violate(param: dict, used: list[StageValue], old: StageValue) -> bool:
    """Нарушила бы устаревшая редакция правило, если бы её взяли вместо актуальной (ловушка для FPR)."""
    alt = [replace(old, role="CURRENT") if u.stage == old.stage else u for u in used]
    return evaluate(param, {}, alt, set()).status == "CANDIDATE"


def build_object(seed: int, i: int, out: Path, make=None, tag: str = "synth-v2") -> dict:
    obj, docs, _ = (make or make_object)(seed, i)
    r = random.Random(f"{tag}:{seed}:{i}:render")
    d_out = out / obj["object_id"]
    d_out.mkdir(parents=True, exist_ok=True)
    gold = {
        "schema": SCHEMA,
        "dataset_version": f"{tag}:seed={seed}",
        "generator": "ml/synth/factory.py" if tag == "synth-v2" else "ml/synth/factory_v3.py",
        "object_id": obj["object_id"],
        "profile": obj["profile"],
        "scenarios": obj["scenarios"],
        "files": [],
        "pages": [],
        "key_fields": [],
        "values": [],
        "rooms": [],
        "requisites": [],
        "changes": [],
        "evidence_groups": [],
    }
    manifest_files = []
    placed: dict[tuple[str, str], tuple[int, list[float]]] = {}
    row_boxes: dict[tuple[str, str], tuple[int, list[float]]] = {}
    for d in docs:
        pages = layout(d, r)
        path = d_out / f"{d.file_id}.pdf"
        skew = d.skew if d.kind == "scan" else 0.0

        def tf(b, skew=skew):
            return rotate_box(b, skew) if skew else b

        if d.kind == "scan":
            render_scan(d, pages, path, r)
        else:
            render_pdf(d, pages, path)
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
        gold["files"].append(
            {
                "file_id": d.file_id,
                "file_name": path.name,
                "sha256": sha,
                "doc_stage": d.stage,
                "discipline": d.discipline,
                "document_code": d.code,
                "revision": d.revision,
                "approval_status": d.status,
                "predecessor_id": d.predecessor,
                "kind": d.kind,
                "dpi": d.dpi or None,
                "skew_deg": d.skew,
                "blur": d.blur,
                "pages": len(pages),
            }
        )
        manifest_files.append(
            {
                "file_id": d.file_id,
                "file_name": path.name,
                "sha256": sha,
                "doc_stage": d.stage,
                "discipline": d.discipline,
                "document_code": d.code,
                "revision": d.revision,
                "approval_status": d.status,
                "approval_date": d.date,
                "sheet_page_range": f"1-{len(pages)}",
                "predecessor_id": d.predecessor,
                "signature_status": "SCAN_SIGNED" if d.kind == "scan" else "UKEP",
            }
        )
        for pn, spec in enumerate(pages, 1):
            reqs = []
            for op in spec.ops:
                if isinstance(op, ImgOp):
                    b = norm(tf((op.x, op.y, op.x + op.w, op.y + op.h)))
                    reqs.append(b)
                    gold["requisites"].append(
                        {
                            "file_id": d.file_id,
                            "page": pn,
                            "kind": op.kind,
                            "bbox": b,
                            "text": op.text or None,
                        }
                    )
            gold["pages"].append(
                {
                    "file_id": d.file_id,
                    "page": pn,
                    "source": "scan" if d.kind == "scan" else "text",
                    "text": page_text(spec),
                    "dont_care": reqs,
                }
            )
            for f_, v, b in spec.key_fields:
                gold["key_fields"].append(
                    {
                        "file_id": d.file_id,
                        "page": pn,
                        "field": f_,
                        "value": v,
                        "bbox": norm(tf(b)),
                    }
                )
            for code, raw, vb, rb in spec.values:
                placed[(d.file_id, code)] = (pn, norm(tf(vb)))
                row_boxes[(d.file_id, code)] = (pn, norm(tf(rb)))
                gold["values"].append(
                    {
                        "file_id": d.file_id,
                        "page": pn,
                        "param": code,
                        "raw": raw,
                        "bbox": norm(tf(vb)),
                    }
                )
            for num, b in spec.rooms:
                gold["rooms"].append(
                    {
                        "file_id": d.file_id,
                        "page": pn,
                        "field": "room",
                        "value": num,
                        "bbox": norm(tf(b)),
                    }
                )
                gold["key_fields"].append(
                    {
                        "file_id": d.file_id,
                        "page": pn,
                        "field": "room",
                        "value": num,
                        "bbox": norm(tf(b)),
                    }
                )
    # области изменений между редакциями одного шифра (A → B по predecessor)
    by_id = {d.file_id: d for d in docs}
    for d in docs:
        if not d.predecessor:
            continue
        old, new = dict(by_id[d.predecessor].rows), dict(d.rows)
        for code in sorted(set(old) | set(new)):
            if old.get(code) == new.get(code):
                continue
            gold["changes"].append(
                {
                    "param": code,
                    "file_old": d.predecessor,
                    "file_new": d.file_id,
                    "old": POOL[code]["fmt"](old[code]) if code in old else None,
                    "new": POOL[code]["fmt"](new[code]) if code in new else None,
                    "change": "modified"
                    if code in old and code in new
                    else ("added" if code in new else "removed"),
                    "page_old": row_boxes.get((d.predecessor, code), (None, None))[0],
                    "bbox_old": row_boxes.get((d.predecessor, code), (None, None))[1],
                    "page_new": row_boxes.get((d.file_id, code), (None, None))[0],
                    "bbox_new": row_boxes.get((d.file_id, code), (None, None))[1],
                }
            )
    roles = select_revisions(manifest_files)
    gold["evidence_groups"] = _group_gold(obj, docs, placed, roles)
    gold["conflict"] = obj["conflict_kr"]
    manifest = {
        "object": {
            "object_id": obj["object_id"],
            "name": obj["name"],
            "profile": obj["profile"],
        },
        "files": manifest_files,
    }
    (d_out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    (d_out / "gold.json").write_text(
        json.dumps(gold, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return gold


def build(n: int, seed: int, out: Path) -> list[dict]:
    out.mkdir(parents=True, exist_ok=True)
    golds = [build_object(seed, i, out) for i in range(1, n + 1)]
    (out / "dataset.json").write_text(
        json.dumps(
            {
                "schema": SCHEMA,
                "dataset_version": f"synth-v2:seed={seed}",
                "n_objects": n,
                "objects": [g["object_id"] for g in golds],
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    return golds


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Фабрика синтетики v2 (OS-INSP-6.4.1)")
    ap.add_argument(
        "--n",
        type=int,
        default=3,
        help="число объектов (правило №0: начинать с малого)",
    )
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", type=Path, default=ROOT / "var/synth-v2")
    a = ap.parse_args(argv)
    t = time.perf_counter()
    golds = build(a.n, a.seed, a.out)
    files = sum(len(g["files"]) for g in golds)
    scans = sum(f["kind"] == "scan" for g in golds for f in g["files"])
    print(
        f"{a.n} объектов, {files} файлов ({scans} сканов) → {a.out} за {time.perf_counter() - t:.1f} с"
    )


if __name__ == "__main__":
    main()
