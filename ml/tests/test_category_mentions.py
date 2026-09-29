"""OS-INSP-2.2.70–2.2.75 (T-176): упоминания марки, материала, типа по паспорту (CMP-05) — М-072, М-075, М-079,
М-130, М-050. Только синтетические строки. Конфигурация — паспорт или часть паспорта и написания канона из
data/seed/analogs.json, как их собирает API (вид category из реестра, spec)."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

import pytest

from inspector_ml.category_mentions import (
    alias_hits,
    chars_near,
    extract_category_mentions,
    segments,
    to_number,
)
from inspector_ml.extractor_kinds import way_by_kind
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
FAM = json.loads((ROOT / "data/seed/analogs.json").read_text("utf-8"))["families"]
PARTS = {"M-050": "subst", "M-072": "subst", "M-079": "subst"}


def passport(code: str) -> dict:
    part = PARTS.get(code)
    return json.loads(
        (
            ROOT
            / (
                f"data/seed/passports/parts/{code}.{part}.json"
                if part
                else f"data/seed/passports/{code}.json"
            )
        ).read_text("utf-8")
    )


def spec(code: str) -> ParamSpec:
    pp = passport(code)
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


def page(lines: list[str], source: str = "text") -> ParsedDoc:
    out = []
    for li, text in enumerate(lines):
        ws, x = [], 0.02
        for t in text.split(" "):
            if not t:
                continue
            w = 0.004 * len(t)
            ws.append(
                Word(text=t, bbox=(x, 0.05 + 0.02 * li, x + w, 0.065 + 0.02 * li))
            )
            x += w + 0.004
        out.append(Line(text=text, words=ws))
    return ParsedDoc(
        sha256="0" * 64,
        kind="pdf",
        engine="pdfium",
        pages=[
            Page(
                page=1,
                width=595,
                height=842,
                source=source,
                ocr_confidence=80 if source == "ocr" else None,
                lines=out,
            )
        ],
    )


def found(code: str, lines: list[str], live: bool = True) -> list[tuple]:
    es = extract_category_mentions(page(lines), spec(code))
    return [
        (e.meta["item"], e.meta["element"], e.value_text, e.meta["or_analog"])
        for e in es
        if not (live and e.meta["excluded"])
    ]


@pytest.mark.l1_functional
def test_pipe_material_with_system_and_element():
    assert found(
        "M-072",
        [
            "Стояки системы В1 выполнить из стальных водогазопроводных оцинкованных труб по ГОСТ 3262-75."
        ],
    ) == [("В1", "riser", "STEEL_GALV", False)]
    assert found(
        "M-072",
        ["Подводки к приборам Т3 — трубы PP-R, армированные стекловолокном, PN20."],
    ) == [("Т3", "branch", "PPR_FIBER", False)]


@pytest.mark.l1_functional
def test_system_header_gives_item_to_table_rows_below():
    lines = [
        "Система В1 хозяйственно-питьевого водопровода",
        "3 | Трубы медные Ø22 | м | 120",
        "4 | стояки — трубы PEX Ø25 | м | 40",
    ]
    assert found("M-072", lines) == [
        ("В1", None, "COPPER", False),
        ("В1", "riser", "PEX", False),
    ]


@pytest.mark.l1_functional
def test_list_header_gives_item_to_list_items():
    lines = [
        "Для системы горячего водоснабжения Т3 приняты трубы:",
        "- магистрали — стальные оцинкованные;",
        "- подводки — металлополимерные.",
    ]
    assert found("M-072", lines) == [
        ("Т3", "main", "STEEL_GALV", False),
        ("Т3", "branch", "MLP", False),
    ]


@pytest.mark.l1_functional
def test_alternatives_and_or_analog():
    assert (
        found(
            "M-072",
            ["Трубопроводы В1 — из полипропилена PP-R или металлополимерных труб."],
        )[0][2]
        == "PPR"
    )
    e = extract_category_mentions(
        page(["Трубопроводы В1 — из полипропилена PP-R или металлополимерных труб."]),
        spec("M-072"),
    )[0]
    assert e.meta["alts"] == ["MLP"]
    assert found(
        "M-075", ["Стояки К1 — малошумные трубы Sinikon Comfort Plus или аналог."]
    ) == [("К1", "riser", "PP_NOISE", True)]


@pytest.mark.l1_functional
def test_or_analog_after_characteristics_up_to_next_value():
    es = extract_category_mentions(
        page(
            [
                "П6 | Приточная установка | ВЦ 14-46-2,5, L = 1500 м³/ч, Р = 450 Па или эквивалент | 1 | шт."
            ]
        ),
        spec("M-079"),
    )
    assert [
        (e.meta["item"], e.value_text, e.meta["or_analog"], e.meta["chars"]) for e in es
    ] == [("П6", "ВЦ 14-46-2,5", True, {"flow": 1500.0, "pressure": 450.0})]


@pytest.mark.l1_functional
def test_same_value_twice_in_segment_is_one_mention():
    assert found(
        "M-072",
        [
            "Трубопроводы системы В1 — трубы полиэтиленовые трубы ПЭ100 по ГОСТ 18599-2001."
        ],
    ) == [("В1", None, "PE", False)]


@pytest.mark.l1_functional
def test_luminaire_code_letter_is_source_type():
    assert found("M-130", ["12 | Светильник ДПО 01-36-001 IP40 | шт. | 40"]) == [
        (None, None, "LED", False)
    ]
    assert found("M-130", ["13 | Светильник ЛПО 46-2х36 | шт. | 12"]) == [
        (None, None, "FLUOR", False)
    ]
    assert found(
        "M-130",
        ["Для освещения лестничных клеток приняты светильники с лампами накаливания."],
    ) == [(None, None, "INCAND", False)]


@pytest.mark.l1_functional
def test_finish_surface_is_element():
    assert found("M-050", ["Коридор 1.05: потолок — подвесной потолок Armstrong."]) == [
        (None, "ceiling", "ARMSTRONG", False)
    ]
    assert found("M-050", ["Вестибюль | Пол | Керамогранит | м2 | 80"]) == [
        (None, "floor", "PORCELAIN", False)
    ]


@pytest.mark.l1_functional
def test_fan_model_is_open_value_with_system_mark():
    assert found("M-079", ["Для системы П1 принят вентилятор Systemair K 315 M."]) == [
        ("П1", None, "Systemair K 315 M", False)
    ]
    assert found(
        "M-079", ["ПВ3 | Приточная установка | Арктос КВАРК-П 50-25 | 1 | шт."]
    ) == [("ПВ3", None, "Арктос КВАРК-П 50-25", False)]
    assert (
        found("M-079", ["Для системы П12 принят вентилятор SYSTEMAIR K315M."])[0][2]
        == "SYSTEMAIR K315M"
    )


@pytest.mark.l6_adversarial
def test_traps_are_excluded_with_reason():
    all_ = extract_category_mentions(
        page(["Существующие трубы водопровода из чугунных труб подлежат демонтажу."]),
        spec("M-072"),
    )
    assert [e.meta["excluded"] for e in all_] == ["EXISTING"]
    assert (
        found(
            "M-072",
            ["Трубопроводы отопления Т1, Т2 выполнить из стальных оцинкованных труб."],
        )
        == []
    )
    assert (
        found(
            "M-072",
            ["Допускается применение полипропиленовых труб по СП 30.13330.2020."],
        )
        == []
    )
    assert (
        found(
            "M-075",
            [
                "Наружные сети канализации выполнить из полипропиленовых гофрированных труб."
            ],
        )
        == []
    )
    assert (
        found(
            "M-130", ["Не допускается применение светильников с лампами накаливания."]
        )
        == []
    )


@pytest.mark.l6_adversarial
def test_value_without_subject_is_not_a_mention():
    assert found("M-072", ["Пароизоляция — полипропиленовая плёнка по ГОСТ."]) == []
    assert found("M-072", ["Каркас — сталь оцинкованная."]) == []


@pytest.mark.l3_boundary
def test_segments_split_prose_and_keep_table_rows():
    segs = segments(
        page(["Трубы В1 — PP-R. Трубы Т3 — медь.", "1 | Трубы | м | 5"]).pages[0]
    )
    assert [s.text for s in segs] == [
        "Трубы В1 — PP-R.",
        "Трубы Т3 — медь.",
        "1 | Трубы | м | 5",
    ]
    assert [s.table for s in segs] == [False, False, True]
    glued = segments(
        page(["Трубопроводы выполнить из поли-", "пропиленовых труб."]).pages[0]
    )
    assert glued[0].text == "Трубопроводы выполнить из полипропиленовых труб."


@pytest.mark.l3_boundary
def test_alias_hits_longest_wins_and_remap():
    al = [
        {"key": "A", "patterns": ["pp-?r"]},
        {"key": "B", "patterns": ["pp-?r армированн\\w+"]},
    ]
    assert alias_hits(al, "трубы PPR армированные") == [(6, 22, "B")]
    assert alias_hits(al, "трубы PPR", {"A": "C"}) == [(6, 9, "C")]
    assert (
        to_number("2 500") == 2500.0
        and to_number("1,5") == 1.5
        and to_number("x") is None
    )
    assert chars_near(
        {"chars": [{"key": "pn", "pattern": "PN(\\d+)", "factor": 1}]},
        "PN10 труба PN20",
        5,
        10,
    ) == {"pn": 10.0}


@pytest.mark.l1_functional
def test_registered_in_extractor_registry():
    assert way_by_kind("category_mentions") is extract_category_mentions


@pytest.mark.l6_adversarial
@pytest.mark.performance
def test_passport_regexes_linear_on_pathological_text():
    """Страж ReDoS: все шаблоны паспортов T-176 и написания справочника на патологическом тексте — быстро (лучшее из трёх)."""
    pats: list[str] = []
    for code in [
        "M-050",
        "M-072",
        "M-075",
        "M-079",
        "M-130",
        "M-032",
        "M-044",
        "M-125",
        "M-128",
    ]:
        part = PARTS.get(code) or {"M-125": "layers", "M-128": "layers"}.get(code)
        p = json.loads(
            (
                ROOT
                / (
                    f"data/seed/passports/parts/{code}.{part}.json"
                    if part
                    else f"data/seed/passports/{code}.json"
                )
            ).read_text("utf-8")
        )["extractor"]
        for k in ("anchor", "item_pattern", "value"):
            if p.get(k):
                pats.append(p[k])
        for k in ("items", "elements", "chars"):
            pats += [x["pattern"] for x in p.get(k) or []]
        pats += (
            [x["pattern"] for x in p.get("exclude") or []]
            + list(p.get("or_analog") or [])
            + list(p.get("reverse") or [])
        )
    for f in FAM.values():
        for c in f["canon"].values():
            pats += c.get("aliases") or []
    evil = [
        "а" * 3000,
        "труб " * 600,
        "1-" * 1500,
        "Systemair " * 300 + "1",
        "В1 " * 800,
        "пароизоляц" + " x" * 1500,
        "мембран" + "а" * 2000 + "ПВХ",
    ]
    for p in pats:
        rx = re.compile(p, flags=re.I)
        best = min(_timed(rx, evil) for _ in range(3))
        assert best < 0.25, f"шаблон медленный ({best:.3f} с): {p[:80]}"


def _timed(rx, texts) -> float:
    t0 = time.perf_counter()
    for t in texts:
        list(rx.finditer(t))
    return time.perf_counter() - t0


@pytest.mark.l1_functional
def test_adjacent_spellings_give_one_specific_value():
    assert found("M-075", ["Стояки К1 — малошумные полипропиленовые трубы Ø110."]) == [("К1", "riser", "PP_NOISE", False)]
    assert found("M-072", ["30 | ВГП оц. Ду25 | м | 747"]) == [(None, None, "STEEL_GALV", False)]
