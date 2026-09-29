"""Сборка геометрических строк из слов текстового слоя (PRM-03, T-129).

Регрессия реального листа ПОС: высокая рамка вертикального текста штампа растягивала строку, и две строки абзаца
перемешивались пословно — оборот «класс конструктивной пожарной опасности – С0» терялся. Координаты PDF, ось y вверх.
"""

import pytest

from inspector_ml.parse import group_rows


def w(text, x, y, h=10.0, width=None):
    width = width or 6.0 * len(text)
    return (text, (x, y, x + width, y + h))


def texts(rows):
    return [" ".join(t for t, _ in sorted(r, key=lambda z: z[1][0])) for r in rows]


@pytest.mark.l8_regression
@pytest.mark.l6_adversarial
def test_tall_stamp_word_does_not_merge_adjacent_lines():
    words = [
        w("Степень", 10, 100), w("огнестойкости", 70, 100), w("–", 160, 100), w("II.", 170, 100),
        w("Класс", 10, 87), w("конструктивной", 50, 87), w("пожарной", 140, 87), w("опасности", 200, 87), w("-", 260, 87), w("С0.", 270, 87),
        w("Подп.", 400, 60, h=60, width=10),  # вертикальный текст штампа: рамка на несколько строк
    ]
    got = texts(group_rows(words))
    assert "Степень огнестойкости – II." in got
    assert "Класс конструктивной пожарной опасности - С0." in got


@pytest.mark.l1_functional
def test_cells_of_one_table_row_join_in_x_order():
    got = texts(group_rows([w("значение", 200, 50), w("Параметр", 10, 50.5), w("м²", 300, 49.6)]))
    assert got == ["Параметр значение м²"]


@pytest.mark.l3_boundary
@pytest.mark.parametrize(("dy", "joined"), [(0.0, True), (4.9, True), (5.1, False), (10.0, False)])
def test_vertical_tolerance_is_half_of_line_height(dy, joined):
    rows = group_rows([w("А", 10, 100), w("Б", 50, 100 - dy)])
    assert (len(rows) == 1) is joined


@pytest.mark.l3_boundary
def test_empty_page_and_single_word():
    assert group_rows([]) == []
    assert texts(group_rows([w("одно", 0, 0)])) == ["одно"]


@pytest.mark.l5_property
@pytest.mark.parametrize("shift", [0, 1, 2, 3])
def test_input_order_does_not_change_rows(shift):
    base = [w("а", 10, 100), w("б", 40, 100), w("в", 10, 80), w("г", 40, 80), w("д", 70, 60, h=40, width=8)]
    rot = base[shift:] + base[:shift]
    assert sorted(texts(group_rows(rot))) == sorted(texts(group_rows(base)))


@pytest.mark.l8_regression
def test_right_column_with_shifted_baseline_stays_one_line():
    """Реальный лист АР: правая колонка сдвинута по вертикали на треть строки относительно левой; «опасности –»
    не отрывается от «конструктивной пожарной … С0.» (рамки в долях высоты листа, пересчитаны в ось y вверх)."""
    H = 1000.0
    def z(text, x, top, bottom):  # доли листа, y вниз → координаты PDF, y вверх
        return (text, (x * H, H - bottom * H, x * H + 30, H - top * H))
    words = [
        z("Акт", 0.411, 0.6146, 0.6207), z("время.", 0.611, 0.6146, 0.6224),
        z("конструктивной", 0.719, 0.6175, 0.6253), z("пожарной", 0.764, 0.6175, 0.6253),
        z("опасности", 0.792, 0.6193, 0.6235), z("-", 0.821, 0.6214, 0.622), z("С0.", 0.827, 0.6175, 0.6235),
    ]
    rows = group_rows(words)
    row = next(r for r in rows if any(t == "опасности" for t, _ in r))
    assert {"конструктивной", "пожарной", "опасности", "-", "С0."} <= {t for t, _ in row}


# ─────────────── L8: границы, найденные mutmut (T-129)


@pytest.mark.l8_regression
def test_words_after_a_tall_word_are_not_lost():
    """Высокое слово стоит первым в обходе (выше всех) — остальные слова всё равно разбираются."""
    rows = group_rows([w("Инв.", 0, 500, h=200), w("класс", 100, 300), w("С0", 140, 300), w("ниже", 100, 100)])
    assert sorted(texts(rows)) == ["Инв.", "класс С0", "ниже"]


@pytest.mark.l8_regression
def test_normal_word_never_joins_a_tall_row_even_inside_its_extent():
    rows = group_rows([w("Подп.", 0, 0, h=200, width=10), w("дата", 12, 50), w("x", 300, 50), w("y", 300, 90), w("z", 300, 130)])
    assert "Подп." in texts(rows) and all("Подп." not in t or t == "Подп." for t in texts(rows))


@pytest.mark.l8_regression
def test_overlap_of_exactly_half_the_smaller_height_joins():
    assert texts(group_rows([w("а", 0, 0), w("б", 20, 5)])) == ["а б"]  # перекрытие 5 из 10 — ровно половина
    assert len(group_rows([w("а", 0, 0), w("б", 20, 5.01)])) == 2


@pytest.mark.l8_regression
def test_tall_threshold_uses_the_true_median_height():
    """Высоты 10, 10, 30, 30: медиана 30 — слова высотой 30 обычные и стоят в строке со словами высотой 10."""
    rows = group_rows([w("а", 0, 10), w("б", 20, 10), w("В", 40, 0, h=30), w("Г", 60, 0, h=30)])
    assert texts(rows) == ["а б В Г"]


class _FakeTextPage:
    """Текстовый слой pdfium: символы и их рамки (координаты PDF)."""

    def __init__(self, chars):
        self.chars = chars

    def count_chars(self):
        return len(self.chars)

    def get_text_range(self, i, n):
        return self.chars[i][0]

    def get_charbox(self, i):
        return self.chars[i][1]

    def close(self):
        pass


class _FakePage:
    def __init__(self, chars):
        self.tp = _FakeTextPage(chars)

    def get_textpage(self):
        return self.tp


def _line(text, x, y, adv=6.0, h=10.0):
    out = []
    for ch in text:
        out.append((ch, (x, y, x + adv, y + h)) if ch not in "￾" else (ch, (x, y, x + 3, y + h)))
        x += adv
    return out


@pytest.mark.l8_regression
@pytest.mark.l6_adversarial
@pytest.mark.parametrize("mark", ["￾", "­", "\u0002"])
def test_hyphenated_word_across_lines_is_glued_without_the_marker(mark):
    """Реальный лист ПБ (T-129): pdfium отдал «конструктив\\ufffeной» — якорь М-023 не находил оборот."""
    from inspector_ml.parse import _raw_words

    chars = _line("класса конструктив" + mark, 100, 500) + _line("ной пожарной", 20, 488)
    words = [w for w, _ in _raw_words(_FakePage(chars))]
    assert "конструктивной" in words
    assert not any(mark in w for w in words)
