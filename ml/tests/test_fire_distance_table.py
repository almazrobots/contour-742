"""Geometry regressions: interleaved cells must not transfer a neighbour's degree."""
import pytest

from inspector_ml.model import Line, Page, ParsedDoc, Word
from inspector_ml.class_mentions import extract_class_mentions
from inspector_ml.fire_distance_table import columns
from test_class_scales import spec


def line(y, *cells):
    words = [Word(text=text, bbox=(x, y, x + width, y + .01)) for x, width, text in cells]
    return Line(text=" ".join(w.text for w in words), words=words)


def fixture():
    return Page(page=1, width=600, height=800, source="text", lines=[
        line(.1, (.12, .4, "Противопожарные расстояния между проектируемыми объектами и соседями")),
        line(.2, (.15, .15, "Наименование"), (.36, .08, "Объект"), (.45, .11, "до которого"), (.62, .11, "Требуемое"), (.8, .14, "Минимальное")),
        line(.22, (.15, .15, "объекта, от которого"), (.36, .2, "определяется расстояние"), (.62, .11, "расстояние"), (.8, .14, "фактическое расстояние")),
        line(.3, (.13, .18, "Проектируемый жилой дом"), (.35, .2, "Соседний жилой дом")),
        line(.4, (.35, .2, "Степень огнестойкости")),
        line(.42, (.35, .03, "– V;")),
        line(.7, (.13, .08, "Степень")),
        line(.71, (.04, .01, "Взам.")),
        line(.72, (.13, .17, "огнестойкости – I;"), (.35, .2, "Площадка для ТП")),
        line(.74, (.6, .14, "До здания ТП")),
        line(.76, (.6, .14, "Степень огнестойкости")),
        line(.78, (.6, .04, "– III;")),
    ])


def test_columns_recover_project_and_preserve_neighbour_evidence():
    page = fixture()
    doc = ParsedDoc(sha256="a" * 64, kind="pdf", engine="test", pages=[page])
    values = extract_class_mentions(doc, spec("M-022"))
    assert [(x.value_text, x.meta["excluded"]) for x in values] == [("I", None), ("V", "NEIGHBOR"), ("III", "TABLE_REFERENCE")]
    assert values[0].bbox[0] == .13
    assert "Взам." not in values[0].meta["quote"]
    assert all(x.bbox and x.anchor_bbox for x in values)


@pytest.mark.parametrize("change", ["no_geometry", "no_distance_heading", "incomplete_header"])
def test_unrecognized_layout_is_not_assigned_column_subjects(change):
    page = fixture()
    if change == "no_geometry":
        for word in page.lines[1].words:
            word.bbox = None
    elif change == "no_distance_heading":
        page.lines[0] = line(.1, (.1, .3, "Ведомость объектов"))
    else:
        page.lines[1].words.pop()
    assert columns(page) is None


def test_table_roles_do_not_leak_into_following_full_width_prose():
    page = fixture()
    page.lines.append(line(.85, (.13, .7, "Проектируемый корпус 2 имеет степень огнестойкости II.")))
    doc = ParsedDoc(sha256="a" * 64, kind="pdf", engine="test", pages=[page])
    values = extract_class_mentions(doc, spec("M-022"))
    assert values[-1].value_text == "II"
    assert values[-1].meta["excluded"] is None
    assert "table_subject_role" not in values[-1].meta
