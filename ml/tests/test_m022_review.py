"""T-241: adversarial audit regressions M-022; synthetic, not an independent holdout.

Cases originate from the code review. No production document text or images.
"""
import pytest

from inspector_ml.class_mentions import extract_class_mentions
from inspector_ml.vlm_verify import mention_box
from test_class_mentions import mk_doc
from test_class_scales import spec


def mentions(*lines):
    return extract_class_mentions(mk_doc(list(lines)), spec("M-022"))


@pytest.mark.parametrize('text', [
    'Проектируемое здание предусмотрено III степени огнестойкости и разделено стенами на два пожарных отсека.',
    'Реконструируемый объект проектируется степенью огнестойкости не ниже II в пределах одного пожарного отсека.',
])
def test_compartment_count_is_not_unresolved_subject_id(text):
    xs = mentions(text)
    assert xs and not any(x.meta.get('excluded') for x in xs)


@pytest.mark.parametrize('text', [
    'Минимальный предел огнестойкости конструкций для здания степени огнестойкости III.',
    'Конструкции имеют характеристики, соответствующие пределам огнестойкости стен для зданий II степени огнестойкости.',
])
def test_construction_requirement_is_not_building_degree(text):
    xs = mentions(text)
    assert xs and all(x.meta.get('excluded') for x in xs)


@pytest.mark.parametrize("text", [
    "Здание II или III степени огнестойкости.",
    "Здание II либо III степени огнестойкости.",
    "Здание II–III степени огнестойкости.",
    "Здание II/III степени огнестойкости.",
])
def test_alternative_before_anchor_is_retained_as_ambiguous(text):
    xs = mentions(text)
    assert xs, "Ambiguity must remain visible to the comparison gate"
    assert all(x.meta.get("excluded") == "AMBIGUOUS_DEGREE" for x in xs)


@pytest.mark.parametrize("heading", [
    "Корпус 1а", "Корпус 2а", "Корпус «А»", "Корпус «Б»",
])
def test_explicit_subject_never_silently_becomes_general_object(heading):
    xs = mentions(f"{heading}: степень огнестойкости — II.")
    assert len(xs) == 1
    item = xs[0]
    assert item.meta.get("subject_key") or item.meta.get("excluded") == "AMBIGUOUS_SUBJECT"
    # A parser may support the spelling or explicitly abstain; neither may lose its evidence.
    assert item.meta.get("subject_quote")
    assert item.meta.get("subject_bbox") is not None


@pytest.mark.parametrize("first,second", [
    ("Корпус 1а", "Корпус 2а"), ("Корпус «А»", "Корпус «Б»"),
])
def test_distinct_subject_spellings_do_not_collapse_to_one_accepted_key(first, second):
    a = mentions(f"{first}: степень огнестойкости — II.")[0]
    b = mentions(f"{second}: степень огнестойкости — II.")[0]
    if not a.meta.get("excluded") and not b.meta.get("excluded"):
        keys = [a.meta.get("subject_key"), b.meta.get("subject_key")]
        assert all(keys)
        assert "unresolved" in keys or keys[0] != keys[1]


@pytest.mark.parametrize("heading", [
    "Корпуса 1 и 2", "Корпуса 1, 2", "Секции 1 и 2",
])
def test_subject_list_does_not_silently_keep_only_first_subject(heading):
    xs = mentions(f"{heading}: степень огнестойкости — II.")
    assert xs
    assert all(x.meta.get("excluded") == "AMBIGUOUS_SUBJECT" for x in xs)


@pytest.mark.parametrize("unrelated,exclusion", [
    ("Соседнее здание: степень огнестойкости — II или III.", "NEIGHBOR"),
    ("Согласно таблице 21 степень огнестойкости I, II, III, IV, V.", "NORM_TABLE"),
])
def test_unrelated_ambiguity_does_not_replace_applicability_exclusion(unrelated, exclusion):
    xs = mentions("Проектируемое здание II степени огнестойкости.", unrelated)
    assert [x.value_text for x in xs if not x.meta.get("excluded")] == ["II"]
    dropped = [x for x in xs if x.meta.get("excluded")]
    assert dropped
    assert all(x.meta["excluded"] == exclusion for x in dropped)


def test_subject_evidence_and_judge_crop_include_inherited_heading():
    xs = mentions("Корпус 1", "Секция 2", "Степень огнестойкости — II.")
    assert len(xs) == 1
    item = xs[0]
    assert item.meta["subject_key"] == "building:1/section:2"
    assert "Корпус 1" in item.meta["subject_quote"]
    assert "Секция 2" in item.meta["subject_quote"]
    subject = item.meta["subject_bbox"]
    assert subject is not None
    assert subject[1] < item.bbox[1]
    crop = mention_box(item)
    assert crop is not None
    for box in (subject, item.bbox, item.anchor_bbox):
        assert box is not None
        assert crop[0] <= box[0] and crop[1] <= box[1]
        assert crop[2] >= box[2] and crop[3] >= box[3]


@pytest.mark.parametrize("heading", [
    "Корпуса А и Б", "Корпуса А, Б", "Секции А и Б", "Секции А, Б",
])
def test_letter_subject_list_is_retained_as_ambiguous(heading):
    xs = mentions(f"{heading}: степень огнестойкости — II.")
    assert xs
    assert all(x.meta.get("excluded") == "AMBIGUOUS_SUBJECT" for x in xs)


@pytest.mark.parametrize("heading,key", [
    ("Корпус 1.", "building:1"),
    ("Корпус 2.", "building:2"),
    ("Корпус 1. Секция 2.", "building:1/section:2"),
])
def test_same_line_pure_subject_heading_keeps_identity_and_location(heading, key):
    xs = mentions(f"{heading} Степень огнестойкости — II.")
    assert len(xs) == 1
    item = xs[0]
    assert item.meta.get("excluded") is None
    assert item.meta.get("subject_key") == key
    assert "Корпус" in item.meta.get("subject_quote", "")
    assert item.meta.get("subject_bbox") is not None
    if "/section:" in key:
        assert "Секция 2" in item.meta["subject_quote"]


@pytest.mark.parametrize("text", [
    "Соседнее здание — корпус 7. Степень огнестойкости проектируемого здания — II.",
    "Корпус 7. Рядом расположено соседнее здание. Степень огнестойкости проектируемого здания — II.",
])
def test_subject_heading_does_not_cross_arbitrary_neighbor_sentence(text):
    xs = mentions(text)
    assert len(xs) == 1
    assert xs[0].meta.get("excluded") is None
    assert xs[0].meta.get("subject_key") is None
    assert xs[0].meta.get("subject_bbox") is None


@pytest.mark.parametrize("side", ["юга", "севера", "запада", "востока"])
def test_neighbor_relative_to_reconstruction_is_not_the_reconstructed_object(side):
    xs = mentions(f"Здание находится с {side} от реконструируемого здания, степень огнестойкости — II.")
    assert len(xs) == 1
    assert xs[0].meta.get("excluded") == "NEIGHBOR"


def test_existing_reconstructed_object_remains_eligible():
    xs = mentions("Существующее здание реконструируемое, степень огнестойкости — II.")
    assert len(xs) == 1
    assert xs[0].meta.get("excluded") is None


@pytest.mark.parametrize('explicit_project', [False, True])
def test_previous_location_sentence_only_applies_without_explicit_subject_switch(explicit_project):
    target = 'проектируемого здания' if explicit_project else 'здания'
    xs = mentions('Находится с востока от реконструируемого здания.',
                  f'Степень огнестойкости {target} — III.')
    assert len(xs) == 1
    assert xs[0].meta.get('excluded') == (None if explicit_project else 'NEIGHBOR')
