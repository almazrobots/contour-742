import pytest

from inspector_ml.model import ParsedDoc, Page
from inspector_ml.count_mentions import extract_count_mentions
from test_count_mentions import spec_of
from test_fire_distance_table import line


def test_neighbour_legend_is_bounded_in_both_axes_and_by_next_heading():
    page = Page(page=1, width=600, height=800, source="text", lines=[
        line(.1, (.6, .35, "Экспликация зданий на участке строительства:")),
        line(.12, (.65, .25, "Проектируемый 11-ти этажный дом.")),
        line(.2, (.6, .35, "Экспликация зданий на прилегающих территориях:")),
        line(.23, (.65, .25, "17-ти этажный жилой дом.")),
        line(.25, (.1, .25, "Проектируемый 12-ти этажный дом.")),
        line(.3, (.6, .35, "Экспликация зданий на участке строительства:")),
        line(.32, (.65, .25, "Проектируемый 13-ти этажный дом.")),
    ])
    doc = ParsedDoc(sha256="b" * 64, engine="test", kind="pdf", pages=[page])
    values = extract_count_mentions(doc, spec_of("M-007"))
    assert {(x.value_num, x.meta["excluded"]) for x in values} == {
        (11, None), (17, "NEIGHBOR_HEADER"), (12, None), (13, None)}
    neighbour = next(x for x in values if x.value_num == 17)
    assert neighbour.meta["subject_header_bbox"] == pytest.approx([.6, .2, .95, .21])
