"""T-241: независимые адресные случаи M-022, только синтетический текст."""
import pytest
from inspector_ml.class_mentions import extract_class_mentions
from test_class_mentions import mk_doc
from test_class_scales import spec


def accepted(*lines):
    return [x for x in extract_class_mentions(mk_doc(list(lines)), spec("M-022")) if not x.meta.get("excluded")]


@pytest.mark.parametrize("text,value", [
    ("Степень огнестойкости здания — II.", "II"),
    ("Здание III степени огнестойкости.", "III"),
    ("Степень огнестойкости здания не ниже II.", "II"),
    ("Степень огнестойкости здания — IV. Предел огнестойкости колонн R 15.", "IV"),
    ("Существующее соседнее здание V степени огнестойкости. Проектируемое здание II степени огнестойкости.", "II"),
    ("Реконструируемое существующее здание II степени огнестойкости.", "II"),
])
def test_m022_valid(text, value):
    assert [x.value_text for x in accepted(text)] == [value]


@pytest.mark.parametrize("text", [
    "Степень огнестойкости здания — П.",
    "Степень огнестойкости здания — Ш.",
    "Степень огнестойкости здания — 1.",
    "Предел огнестойкости перекрытия REI 60.",
    "Степень огнестойкости здания — II–III.",
    "Степень огнестойкости здания — II или III.",
    "Степень огнестойкости здания не II.",
    "Степень огнестойкости здания не выше II.",
    "Согласно таблице 21 степень огнестойкости I, II, III, IV, V.",
])
def test_m022_ambiguous_not_fact(text):
    assert accepted(text) == []


@pytest.mark.parametrize("lines,subject", [
    (["Корпус 1: степень огнестойкости — II."], "building:1"),
    (["Степень огнестойкости корпуса 2 — III."], "building:2"),
    (["Секция 3: степень огнестойкости — I."], "section:3"),
    (["Пожарный отсек 2: степень огнестойкости — II."], "fire_compartment:2"),
    (["Корпус 1. Секция 2.", "Степень огнестойкости — II."], "building:1/section:2"),
])
def test_m022_subject(lines, subject):
    xs = accepted(*lines)
    assert len(xs) == 1
    assert xs[0].meta.get("subject_key") == subject
    assert xs[0].bbox is not None


def test_m022_separate_headings():
    xs = accepted("Корпус 1", "Секция 2", "Степень огнестойкости — II.")
    assert len(xs) == 1
    assert xs[0].meta["subject_key"] == "building:1/section:2"


def test_m022_next_line_roman_is_not_degree_suffix():
    assert [x.value_text for x in accepted("Степень огнестойкости — I", "II очередь строительства")] == ["I"]
