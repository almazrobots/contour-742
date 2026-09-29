"""OS-INSP-2.1.8: строка таблицы на наклонном скане собирается в одну строку; ансамбль не теряет движки."""

from __future__ import annotations

import shutil

import pytest
from PIL import Image, ImageDraw, ImageFont

from inspector_ml.model import Word
from inspector_ml.ocr_ensemble import group_lines, run_ensemble, words_skew
from inspector_ml.render import FONT


def table(slope: float) -> list[Word]:
    """Три строки «подпись — ед. — значение»; правый край выше левого на slope (dy/dx в долях листа)."""
    out = []
    for r, (label, unit, val) in enumerate([("Площадь застройки", "м2", "2792"), ("Общая площадь", "м2", "7128"), ("Этажность", "эт.", "12")]):
        y = 0.2 + r * 0.03
        for x, t in [(0.10, label), (0.62, unit), (0.85, val)]:
            yy = y + slope * x
            out.append(Word(text=t, bbox=(x, yy, x + 0.08, yy + 0.012)))
    return out


@pytest.mark.l1_functional
def test_skewed_table_rows_grouped_label_unit_value():
    lines = group_lines(table(-0.02))  # правый край выше — на старом алгоритме значение уезжало в чужую строку
    assert [ln.text for ln in lines] == ["Площадь застройки м2 2792", "Общая площадь м2 7128", "Этажность эт. 12"]


@pytest.mark.l3_boundary
def test_no_skew_unchanged_and_few_words_zero():
    assert words_skew(table(0.0)) == 0.0
    assert [ln.text for ln in group_lines(table(0.0))][0] == "Площадь застройки м2 2792"
    assert words_skew(table(-0.02)[:5]) == 0.0  # мало слов — наклон не оцениваем


@pytest.mark.l8_regression
@pytest.mark.skipif(not shutil.which("tesseract"), reason="нет tesseract")
def test_ensemble_keeps_all_tesseract_engines():
    # регрессия: одноимённая функция перекрыла estimate_skew(изображение), и «tesseract-prep» тихо выбывал
    img = Image.new("L", (1200, 300), 255)
    ImageDraw.Draw(img).text((40, 100), "Общая площадь здания 7128,1", font=ImageFont.truetype(str(FONT), 48), fill=0)
    res = run_ensemble(img)
    assert {"tesseract-psm4", "tesseract-prep", "tesseract-psm6"} <= set(res.engines)
