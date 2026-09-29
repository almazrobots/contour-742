"""OS-INSP-2.2.76–2.2.79 (T-176): состав конструкции по паспорту (CMP-21, ENT-17) — М-044, М-032, М-125, М-128.
Выноска, перечень через «;», таблица состава, разворот «снизу вверх», толщина в мм/см, переменная толщина, слой вне
справочника. Только синтетические строки."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from inspector_ml.extractor_kinds import way_by_kind
from inspector_ml.layer_mentions import extract_layer_mentions, thickness
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
FAM = json.loads((ROOT / "data/seed/analogs.json").read_text("utf-8"))["families"]
FILES = {
    "M-044": "M-044.json",
    "M-032": "M-032.json",
    "M-125": "parts/M-125.layers.json",
    "M-128": "parts/M-128.layers.json",
}


def spec(code: str) -> ParamSpec:
    pp = json.loads((ROOT / "data/seed/passports" / FILES[code]).read_text("utf-8"))
    fam = FAM[pp["value"]["family"]]
    aliases = [
        {"key": k, "patterns": c["aliases"]}
        for k, c in fam["canon"].items()
        if c.get("aliases")
    ]
    return ParamSpec(
        code=code,
        anchors=["x"],
        data_type="string",
        extractor={**pp["extractor"], "aliases": aliases},
    )


def page(lines: list[str]) -> ParsedDoc:
    out = []
    for li, text in enumerate(lines):
        ws = [
            Word(
                text=t,
                bbox=(
                    0.02 + 0.05 * i,
                    0.05 + 0.02 * li,
                    0.06 + 0.05 * i,
                    0.065 + 0.02 * li,
                ),
            )
            for i, t in enumerate(text.split())
        ]
        out.append(Line(text=text, words=ws))
    return ParsedDoc(
        sha256="0" * 64,
        kind="pdf",
        engine="pdfium",
        pages=[Page(page=1, width=595, height=842, source="text", lines=out)],
    )


def stacks(code: str, lines: list[str]) -> list[tuple]:
    es = extract_layer_mentions(page(lines), spec(code))
    return [
        (
            e.meta["item"],
            [(x["m"], x["t"]) for x in e.meta["layers"]],
            e.meta["excluded"],
        )
        for e in es
    ]


ROOF = [
    "Состав кровли Кр-1:",
    "1. Мембрана ПВХ Logicroof V-RP – 1,5 мм",
    "2. Геотекстиль иглопробивной 300 г/м²",
    "3. Техноруф Н30, δ=150 мм",
    "4. Пароизоляция Бикроэласт ТПП (h=3)",
    "5. Профлист Н75-750-0,8",
]
EXPECT = [
    ("MEMBRANE_PVC", 1.5),
    ("GEOTEXTILE", None),
    ("INSUL_MW", 150.0),
    ("VAPOR_BITUMEN", 3.0),
    ("PROFILED_SHEET", None),
]


@pytest.mark.l1_functional
def test_callout_stack_with_item_and_thickness():
    assert stacks("M-044", ROOF) == [("Кр-1", EXPECT, None)]


@pytest.mark.l1_functional
def test_inline_list_and_table_give_the_same_stack():
    inline = [
        "Состав кровли Кр-1: мембрана ПВХ 1,5 мм; геотекстиль; техноруф Н30 150 мм; пароизоляция Бикроэласт, δ=3 мм; профлист Н75."
    ]
    assert stacks("M-044", inline)[0][1] == EXPECT
    table = [
        "Состав кровли Кр-1",
        "№ | Наименование слоя | Толщина, мм",
        "1 | Мембрана ПВХ | 1,5",
        "2 | Геотекстиль | ",
        "3 | Техноруф Н30 | 150",
        "4 | Пароизоляция битумно-полимерная | 3",
        "5 | Профилированный лист Н75 | ",
    ]
    assert stacks("M-044", table)[0][1] == EXPECT


@pytest.mark.l1_functional
def test_bottom_up_marker_reverses_to_canonical_order():
    rev = [
        "Состав кровли Кр-1 (снизу вверх):",
        *[f"{i}. {x.split('. ', 1)[1]}" for i, x in enumerate(reversed(ROOF[1:]), 1)],
    ]
    assert stacks("M-044", rev)[0][1] == EXPECT
    wall = [
        "Состав наружной стены НС-1 (изнутри наружу):",
        "1. Внутренняя штукатурка 20 мм",
        "2. Кладка из газобетонных блоков D500 – 300 мм",
        "3. Минераловатные плиты Техновент 150 мм",
        "4. Облицовка керамогранитом на подсистеме",
    ]
    assert stacks("M-125", wall)[0][1] == [
        ("FACADE_PORCELAIN", None),
        ("INSUL_MW", 150.0),
        ("WALL_GASBLOCK", 300.0),
        ("PLASTER_INT", 20.0),
    ]


@pytest.mark.l3_boundary
def test_thickness_units_ranges_and_non_thickness_numbers():
    assert thickness("мембрана 1,5 мм") == (1.5, 1.5)
    assert thickness("стяжка 5 см") == (50.0, 50.0)
    assert thickness("керамзит – 30…200 мм") == (30.0, 200.0)
    assert thickness("щебень фракции 40-70 мм, по способу заклинки – 200 мм") == (
        200.0,
        200.0,
    )
    assert thickness("песок Кф ≥ 1 м/сут, δ=300 мм") == (300.0, 300.0)
    assert thickness("δ=150") == (150.0, 150.0)
    assert thickness("профлист Н75-750-0,8") == (None, None)
    assert thickness("| Керамзит | 30-200", head_mm=True) == (30.0, 200.0)


@pytest.mark.l1_functional
def test_road_stack_and_unknown_material_layer_kept():
    lines = [
        "Конструкция дорожной одежды тип 1:",
        "1. Асфальтобетон мелкозернистый плотный тип Б – 50 мм",
        "2. Асфальтобетон пористый крупнозернистый – 70 мм",
        "3. Щебень фракции 40-70 мм по способу заклинки – 200 мм",
        "4. Песок средней крупности – 300 мм",
        "5. Полотно Termotex-500",
    ]
    item, ls, _ = stacks("M-032", lines)[0]
    assert item == "тип 1"
    assert ls[:4] == [
        ("ASPHALT_FINE_DENSE", 50.0),
        ("ASPHALT_COARSE_POROUS", 70.0),
        ("CRUSHED_STONE", 200.0),
        ("SAND_DRAIN", 300.0),
    ]
    assert ls[4] == (None, None)


@pytest.mark.l1_functional
def test_wall_concrete_is_remapped_to_wall_key():
    assert stacks(
        "M-125",
        [
            "Конструкция наружной стены НС-2:",
            "1. Минеральная вата Технофас 120 мм",
            "2. Железобетон 200 мм",
        ],
    )[0][1] == [("INSUL_MW", 120.0), ("WALL_RC", 200.0)]


@pytest.mark.l6_adversarial
def test_existing_structure_is_excluded_and_next_anchor_stops_stack():
    ex = stacks(
        "M-044",
        [
            "Существующий состав кровли (демонтаж):",
            "1. Рубероид 4 мм",
            "2. Стяжка 30 мм",
        ],
    )
    assert ex[0][2] == "EXISTING"
    two = stacks(
        "M-044",
        [
            "Состав кровли Кр-1:",
            "1. Мембрана ПВХ 1,5 мм",
            "Состав кровли Кр-2:",
            "1. Техноэласт ЭКП 4 мм",
        ],
    )
    assert [(s[0], s[1]) for s in two] == [
        ("Кр-1", [("MEMBRANE_PVC", 1.5)]),
        ("Кр-2", [("BITUMEN_POLYMER", 4.0)]),
    ]


@pytest.mark.l3_boundary
def test_no_stack_without_layers_and_prose_after_stack_ends_it():
    assert (
        stacks(
            "M-044",
            ["Состав кровли принят по серии.", "Примечание: работы вести летом."],
        )
        == []
    )
    s = stacks(
        "M-128",
        [
            "Состав чердачного перекрытия П-1:",
            "1. Минераловатные плиты 200 мм",
            "2. Плита перекрытия ж/б 220 мм",
            "",
            "Общие указания по производству работ.",
        ],
    )
    assert s[0][1] == [("INSUL_MW", 200.0), ("SLAB_RC", 220.0)]


@pytest.mark.l1_functional
def test_registered_in_extractor_registry():
    assert way_by_kind("layer_mentions") is extract_layer_mentions
