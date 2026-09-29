"""Замер семантических якорей (OS-INSP-2.2.8, T-064): подписи ТЭП перефразированы так, как пишут в реальных
документах, — сколько параметров находит лексика и сколько лексика + семантика, и нет ли ложных привязок.

Перефразы составлены вручную (синтетика, ADR-0002); все 40 числовых параметров Матрицы участвуют как «соперники»,
чтобы ложная привязка была возможна. Использование: python -m eval.semantic_bench
"""

from __future__ import annotations

import json
import sys

from inspector_ml.extract import extract
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word
from inspector_ml.semantic import get_embedder

from .run import load_matrix

# код параметра → перефраз подписи (как в реальных ТЭП/ведомостях) и значение
PARAPHRASES = {
    "M-001": ("Застроенная площадь участка", "2 140,0"),
    "M-002": ("Суммарная площадь здания", "12 450,0"),
    "M-004": ("Объем здания строительный", "48 900"),
    "M-008": ("Высота здания от уровня земли", "41,6"),
    "M-010": ("Число квартир в доме", "248"),
    "M-012": ("Количество парковочных мест в подземной автостоянке", "120"),
    "M-014": ("Электрическая мощность расчётная", "860"),
    "M-025": ("Площадь покрытия из асфальтобетона", "3 120,0"),
    "M-027": ("Площадь газонов и озеленённых территорий", "5 257,7"),
    "M-028": ("Площадь спортивных и детских площадок", "940,0"),
    "M-030": ("Ширина проездов внутри участка", "6,0"),
    "M-040": ("Ширина коридоров на путях эвакуации", "1,60"),
    "M-041": ("Ширина дверей эвакуационных выходов", "1,20"),
    "M-058": ("Толщина плиты фундамента", "900"),
    "M-059": ("Толщина плит перекрытий", "220"),
    "M-061": ("Толщина монолитных несущих стен ядра", "300"),
}

# трудные отрицательные строки: число есть, параметра Матрицы нет — привязка любой из них = ложная находка.
# Первые две — из синтетики e2e (OBJ-POL-115): на них семантика ошибалась, пока допускала однословные тексты.
NEGATIVES = [
    ("Отметка 0.000 соответствует уровню чистого пола первого этажа", "0.000"),
    ("Количество лифтов шт.", "0"),
    ("Температура наружного воздуха расчётная", "-26"),
    ("Номер изменения", "2"),
    ("Количество листов в комплекте", "14"),
    ("Отметка", "0.000"),
]


def doc() -> ParsedDoc:
    lines = []
    for i, (label, value) in enumerate([*PARAPHRASES.values(), *NEGATIVES]):
        text = f"{label} {value}"
        ws, x = [], 0.05
        for tok in text.split():
            ws.append(Word(text=tok, bbox=(x, 0.1 + i * 0.03, x + 0.04, 0.115 + i * 0.03)))
            x += 0.05
        lines.append(Line(text=text, words=ws))
    return ParsedDoc(sha256="bench", kind="pdf", engine="pdfium", pages=[Page(page=1, width=595, height=842, source="text", lines=lines)])


def run() -> dict:
    m = load_matrix()
    specs = [ParamSpec(code=c, anchors=p["anchors"], data_type=p["data_type"], regex_pattern=p.get("regex_pattern"), compare_kind=p["compare"]["kind"])
             for c, p in m.items() if p["data_type"] == "number" and not p.get("regex_pattern")]
    want = {c: v for c, (_, v) in PARAPHRASES.items()}
    out = {}
    for mode, emb in (("лексика", None), ("лексика + семантика", get_embedder())):
        if mode != "лексика" and emb is None:
            out[mode] = None
            continue
        got = {e.code: e.raw for e in extract(doc(), specs, emb)}
        right = {c for c, v in got.items() if want.get(c) == v}
        wrong = {c: v for c, v in got.items() if want.get(c) != v}
        out[mode] = {"найдено_верно": len(right), "из": len(want), "ложных": len(wrong), "ложные": wrong,
                     "семантических": sum(1 for e in extract(doc(), specs, emb) if e.match == "semantic") if emb else 0}
    return out


if __name__ == "__main__":
    json.dump(run(), sys.stdout, ensure_ascii=False, indent=1)
    print()
