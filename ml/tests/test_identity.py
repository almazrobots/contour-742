"""T-178 L1: штамп листа (IDN-02), таблица изменений (IDN-03), сводка документа, статус редакции (VER-03, MUT-18),
этажность и этаж листа (IDN-10). Только синтетика (ADR-0002): страницы model.Page со словами в ячейках формы 3/5
ГОСТ Р 21.101 прил. Ж — центры ячеек заданы здесь независимо от сетки titleblock."""

from __future__ import annotations

import pytest

from inspector_ml import identity as I
from inspector_ml.model import Line, Page, ParsedDoc, Word
from inspector_ml.titleblock import NO_WORDS

A3L = (420.0, 297.0)
MM_PT = 72 / 25.4
LABELS3 = [
    ("Изм.", 5, 17.5),
    ("Кол.уч", 15, 17.5),
    ("Лист", 25, 17.5),
    ("№док.", 35, 17.5),
    ("Подп.", 47.5, 17.5),
    ("Дата", 60, 17.5),
    ("Разраб.", 7, 22.5),
    ("Н.контр.", 8, 52.5),
    ("Стадия", 142.5, 27.5),
    ("Лист", 157.5, 27.5),
    ("Листов", 175, 27.5),
]
POS3 = {
    "code": (125, 5),
    "building": (100, 32.5),
    "stage": (142.5, 35),
    "sheet": (157.5, 35),
    "sheets": (175, 35),
    "sheet_title": (100, 47.5),
    "org": (160, 47.5),
}
CX = {"izm": 5, "kol_uch": 15, "sheet": 25, "doc_no": 35, "date": 60}
ROW_Y = (2.5, 7.5, 12.5)  # строки изменений формы 3 сверху вниз над шапкой


def stamp_page(
    values: dict,
    changes: list[dict] = (),
    *,
    page: int = 1,
    size=A3L,
    labels: bool = True,
) -> Page:
    wmm, hmm = size
    ox, oy = wmm - 5 - 185, hmm - 5 - 55
    items = [(v, *POS3[k]) for k, v in values.items()] + (LABELS3 if labels else [])
    for y, ch in zip(ROW_Y, changes):
        items += [(v, CX[k], y) for k, v in ch.items()]
    lines = []
    for text, x, y in items:
        ws, cx = [], ox + x - 0.8 * len(text) * (len(text.split()) - 1) / 2
        for part in text.split():
            half = 0.8 * len(part) / 2
            ws.append(
                Word(
                    text=part,
                    bbox=(
                        (cx - half) / wmm,
                        (oy + y - 1.2) / hmm,
                        (cx + half) / wmm,
                        (oy + y + 1.2) / hmm,
                    ),
                )
            )
            cx += 0.8 * len(part) + 0.8
        lines.append(Line(text=text, words=ws))
    return Page(
        page=page, width=wmm * MM_PT, height=hmm * MM_PT, source="text", lines=lines
    )


def text_page(text: str, page: int = 1) -> Page:
    lines = []
    for i, ln in enumerate(text.split("\n")):
        ws, x = [], 0.05
        for part in ln.split():
            ws.append(
                Word(
                    text=part,
                    bbox=(x, 0.05 + i * 0.02, x + 0.01 * len(part), 0.065 + i * 0.02),
                )
            )
            x += 0.01 * len(part) + 0.005
        lines.append(Line(text=" ".join(ln.split()), words=ws))
    return Page(page=page, width=595, height=842, source="text", lines=lines)


def doc(*pages: Page) -> ParsedDoc:
    return ParsedDoc(sha256="0" * 64, kind="pdf", pages=list(pages), engine="test")


V = {
    "code": "СК2-Р-АР",
    "building": "Корпус 2",
    "stage": "Р",
    "sheet": "3",
    "sheets": "12",
    "sheet_title": "План 3 этажа",
}


# ─────────────────────────────── IDN-02 поля штампа


@pytest.mark.l1_functional
def test_stamp_fields_with_bbox_and_confidence():
    sid = I.read_identity(stamp_page(V))
    assert sid.ok and sid.form == 3
    assert (sid.code, sid.stage, sid.doc_stage, sid.sheet, sid.sheets) == (
        "СК2-Р-АР",
        "Р",
        "RD",
        "3",
        12,
    )
    assert sid.sheet_title == "План 3 этажа"
    f = sid.fields["code"]
    assert (
        f.graph == 1
        and 0.5 < f.bbox[0] < f.bbox[2] <= 1
        and 0.8 < f.bbox[1] < 1
        and f.confidence == 0.9
    )
    assert sid.revision is None and sid.changes == []


@pytest.mark.l1_functional
def test_stage_p_maps_to_pd_and_i_has_no_doc_stage():
    assert I.read_identity(stamp_page({**V, "stage": "П"})).doc_stage == "PD"
    assert I.read_identity(stamp_page({**V, "stage": "И"})).doc_stage is None


@pytest.mark.l3_boundary
def test_sheet_with_letter_kept_as_text_and_blank_sheets_none():
    sid = I.read_identity(stamp_page({**V, "sheet": "2а", "sheets": "—"}))
    assert sid.sheet == "2а" and sid.sheets is None


@pytest.mark.l4_fault
def test_no_stamp_gives_reason_and_structured_page_abstains():
    empty = Page(page=4, width=420 * MM_PT, height=297 * MM_PT, source="text", lines=[])
    sid = I.read_identity(empty)
    assert not sid.ok and sid.reason == NO_WORDS and sid.page == 4 and sid.code is None
    st = Page(page=1, width=0, height=0, source="structured", lines=[])
    assert "структурированного" in I.read_identity(st).reason


# ─────────────────────────────── IDN-03 таблица изменений


@pytest.mark.l1_functional
def test_change_rows_parsed_and_revision_is_max_izm():
    ch = [
        {
            "izm": "3",
            "kol_uch": "Зам.",
            "sheet": "3",
            "doc_no": "45-25",
            "date": "03.25",
        },
        {
            "izm": "2",
            "kol_uch": "2",
            "sheet": "3,5",
            "doc_no": "12-24",
            "date": "12.2024",
        },
        {
            "izm": "1",
            "kol_uch": "Нов.",
            "sheet": "4-6",
            "doc_no": "1-24",
            "date": "01.02.2024",
        },
    ]
    sid = I.read_identity(stamp_page(V, ch))
    assert sid.revision == 3
    assert [c.izm for c in sid.changes] == [3, 2, 1]
    a, b, c = sid.changes
    assert (a.action, a.kol_uch, a.sheets, a.doc_no, a.date) == (
        "Зам.",
        None,
        ["3"],
        "45-25",
        "2025-03",
    )
    assert (b.action, b.kol_uch, b.sheets, b.date) == (None, 2, ["3", "5"], "2024-12")
    assert (c.action, c.sheets, c.date) == ("Нов.", ["4", "5", "6"], "2024-02-01")


@pytest.mark.parametrize(
    "row, want",
    [
        ({"izm": "Изм.4", "kol_uch": "Аннул."}, (4, "Аннул.", None)),
        ({"izm": "2", "kol_uch": "-"}, (2, None, None)),
        ({"izm": "12", "kol_uch": "15"}, (12, None, 15)),
    ],
)
@pytest.mark.l1_functional
def test_parse_change_number_action_and_count(row, want):
    c = I.parse_change(row)
    assert (c.izm, c.action, c.kol_uch) == want


@pytest.mark.l3_boundary
def test_parse_change_rejects_rows_without_number_and_long_numbers():
    assert I.parse_change({"izm": "", "doc_no": "12-24"}) is None
    assert I.parse_change({"izm": "Изм."}) is None
    assert (
        I.parse_change({"izm": "20245"}) is None
    )  # длинное число — не номер изменения
    assert I.parse_change({"izm": "0"}) is None
    assert I.parse_change({"izm": "0", "doc_no": "1-24"}).izm == 0


@pytest.mark.parametrize(
    "raw, iso",
    [
        ("03.25", "2025-03"),
        ("3.2025", "2025-03"),
        ("01.02.24", "2024-02-01"),
        ("13.25", "13.25"),
        ("32.01.2024", "32.01.2024"),
        ("01.13.2024", "01.13.2024"),
        ("май 2024", "май 2024"),
    ],
)
@pytest.mark.l3_boundary
def test_change_date_iso_or_as_written(raw, iso):
    assert I.parse_change({"izm": "1", "date": raw}).date == iso


@pytest.mark.l3_boundary
def test_change_sheets_all_ranges_and_cap():
    assert I._sheets("Все") == ["*"]
    assert I._sheets("1; 2а") == ["1", "2а"]
    assert I._sheets("5-5") == ["5"]
    assert I._sheets("9-3") == ["9-3"]  # обратный диапазон не раскрывается
    assert len(I._sheets(f"1-{1 + I.MAX_SHEET_RANGE}")) == I.MAX_SHEET_RANGE + 1
    assert I._sheets(f"1-{2 + I.MAX_SHEET_RANGE}") == [f"1-{2 + I.MAX_SHEET_RANGE}"]


# ─────────────────────────────── сводка документа


@pytest.mark.l1_functional
def test_doc_identity_majority_max_revision_and_sheet_map():
    d = doc(
        stamp_page(V, [{"izm": "1"}], page=1),
        stamp_page({**V, "sheet": "4"}, [{"izm": "2"}], page=2),
        stamp_page({**V, "code": "СК2-Р-АР1", "sheet": "5"}, page=3),
        text_page("Примечания", page=4),
    )
    di = I.doc_identity(d)
    assert (di.code, di.stage, di.doc_stage, di.revision, di.read) == (
        "СК2-Р-АР",
        "Р",
        "RD",
        2,
        3,
    )
    assert di.sheet_map == {1: "3", 2: "4", 3: "5"}
    assert [x.field for x in di.disagreements] == ["code"]
    assert di.disagreements[0].values == {"СК2-Р-АР": [1, 2], "СК2-Р-АР1": [3]}
    assert len(di.pages) == 4 and not di.pages[3].ok


@pytest.mark.l1_functional
def test_doc_identity_stage_disagreement_and_homoglyph_codes_are_one():
    d = doc(
        stamp_page(V, page=1),
        stamp_page({**V, "code": "CK2-P-AP"}, page=2),
        stamp_page({**V, "stage": "П"}, page=3),
    )
    di = I.doc_identity(d)
    assert di.code == "СК2-Р-АР" and not any(
        x.field == "code" for x in di.disagreements
    )
    st = next(x for x in di.disagreements if x.field == "stage")
    assert st.values == {"Р": [1, 2], "П": [3]} and di.stage == "Р"


@pytest.mark.l3_boundary
def test_doc_identity_empty_and_tie_goes_to_earlier_sheet():
    di = I.doc_identity(doc(text_page("нет штампа")))
    assert (
        di.code is None
        and di.revision is None
        and di.read == 0
        and di.doc_stage is None
    )
    tie = I.doc_identity(
        doc(
            stamp_page({**V, "code": "Б-1"}, page=1),
            stamp_page({**V, "code": "А-1"}, page=2),
        )
    )
    assert tie.code == "Б-1"


# ─────────────────────────────── VER-03 / MUT-18 статус редакции


def ev(fid, reg=None, stamp=None, status="APPROVED", code="СК2-Р-АР", stage="RD"):
    return I.RevisionEvidence(
        file_id=fid,
        doc_stage=stage,
        code=code,
        registry_revision=reg,
        approval_status=status,
        stamp_revision=stamp,
    )


@pytest.mark.l1_functional
def test_revision_current_and_stale_by_registry_and_by_stamp():
    v = I.revision_status([ev("a", "1", 1), ev("b", "2", 2)])
    assert (
        v["a"].status == "STALE" and v["a"].newer == "b" and v["b"].status == "CURRENT"
    )
    v = I.revision_status([ev("a", None, 1), ev("b", None, 3)])
    assert v["a"].status == "STALE" and v["b"].status == "CURRENT"
    v = I.revision_status([ev("a", "1", 1, status="SUPERSEDED"), ev("b", "1", 1)])
    assert (
        v["a"].status == "STALE"
        and "SUPERSEDED" in v["a"].reason
        and v["b"].status == "CURRENT"
    )


@pytest.mark.l1_functional
def test_mut18_old_revision_passed_as_current_is_registry_conflict():
    # реестр подменён: у обоих ред. 2, но штамп «a» — изм. 1, у «b» — изм. 2
    v = I.revision_status([ev("a", "2", 1), ev("b", "2", 2)])
    assert (
        v["a"].status == "REGISTRY_CONFLICT"
        and v["a"].newer == "b"
        and v["b"].status == "CURRENT"
    )
    # реестр называет «b» новее, а штамп новее у «a»
    v = I.revision_status([ev("a", "1", 3), ev("b", "2", 2)])
    assert v["a"].status == "REGISTRY_CONFLICT" and v["b"].status == "REGISTRY_CONFLICT"


@pytest.mark.l3_boundary
def test_revision_stamp_ahead_of_registry_unknown_and_groups():
    assert I.revision_status([ev("a", "1", 2)])["a"].status == "REGISTRY_CONFLICT"
    assert I.revision_status([ev("a", "2", 2)])["a"].status == "CURRENT"
    assert I.revision_status([ev("a")])["a"].status == "UNKNOWN"
    v = I.revision_status(
        [ev("a", "1", 1), ev("b", "2", 2, stage="PD"), ev("c", "3", 3, code="ДРУГОЙ")]
    )
    assert {k: x.status for k, x in v.items()} == {
        "a": "CURRENT",
        "b": "CURRENT",
        "c": "CURRENT",
    }
    v = I.revision_status([ev("a", "Изм.1", 1), ev("b", "ред. 2", None)])
    assert v["a"].status == "STALE" and v["b"].status == "CURRENT"


@pytest.mark.parametrize(
    "raw, n",
    [
        ("2", 2),
        ("Изм.2", 2),
        ("C02", 2),
        ("ред. 1 изм 3", 3),
        ("", None),
        (None, None),
        ("А", None),
    ],
)
@pytest.mark.l3_boundary
def test_rev_no(raw, n):
    assert I.rev_no(raw) == n


# ─────────────────────────────── IDN-10 этажность и этаж листа


@pytest.mark.parametrize(
    "text, above, below",
    [
        ("Проектируемый 9-этажный жилой дом с подвалом", 9, None),
        ("Здание 16-ти этажное", 16, None),
        ("Этажность здания — 12", 12, None),
        ("Этажность: 10 (в т.ч. подземных 1)", 10, 1),
        ("Количество этажей — 11, в т.ч. подземных — 1", 10, 1),
        ("Количество этажей, шт. 14", 14, None),
    ],
)
@pytest.mark.l1_functional
def test_building_floors_from_title_pages(text, above, below):
    fc = I.building_floors(doc(text_page(text)))
    assert (fc.status, fc.above, fc.below) == ("ok", above, below)
    m = fc.mentions[0]
    assert m.page == 1 and m.bbox is not None and m.quote


@pytest.mark.l1_functional
def test_floors_conflict_excluded_and_none():
    fc = I.building_floors(
        doc(text_page("9-этажный дом"), text_page("Этажность 10", page=2))
    )
    assert fc.status == "conflict" and fc.above is None and len(fc.mentions) == 2
    fc = I.building_floors(
        doc(
            text_page(
                "высотой не более 5-этажного здания. Существующий 3-этажный корпус"
            )
        )
    )
    assert fc.status == "none" and {m.excluded for m in fc.mentions} == {
        "constraint",
        "existing",
    }
    assert I.building_floors(doc(text_page("Общие сведения"))).status == "none"


@pytest.mark.l3_boundary
def test_floor_count_bounds_and_decimals_and_title_pages_only():
    assert I.building_floors(doc(text_page("Этажность 0"))).status == "none"
    assert I.building_floors(doc(text_page("Этажность 151"))).status == "none"
    assert I.building_floors(doc(text_page("Этажность 12,5 м"))).status == "none"
    pages = [text_page("План", page=i) for i in range(1, 8)] + [
        text_page("Этажность 7", page=8)
    ]
    assert (
        I.building_floors(doc(*pages)).status == "none"
    )  # восьмой лист — не заглавный
    pages[-1] = text_page("Общие данные\nЭтажность 7", page=8)
    assert I.building_floors(doc(*pages)).above == 7


@pytest.mark.parametrize(
    "title, kind, floor, floors, elev, section",
    [
        ("План 3 этажа", "floor", 3, None, None, None),
        ("План 1-го этажа на отм. 0.000", "floor", 1, None, 0.0, None),
        ("План типового этажа 2-9. Секция 2", "typical", None, (2, 9), None, "2"),
        ("План 5-7 этажей на отм. +12.600", "typical", None, (5, 7), 12.6, None),
        ("План подвала на отм. −3.300", "basement", None, None, -3.3, None),
        ("План технического этажа", "technical", None, None, None, None),
        ("План кровли", "roof", None, None, None, None),
        ("Разрез 1-1", None, None, None, None, None),
        (None, None, None, None, None, None),
    ],
)
@pytest.mark.l1_functional
def test_sheet_floor(title, kind, floor, floors, elev, section):
    s = I.sheet_floor(title)
    assert (s.kind, s.floor, s.floors, s.elevation, s.section) == (
        kind,
        floor,
        floors,
        elev,
        section,
    )


@pytest.mark.parametrize("s, ok", [("3", True), ("2а", True), ("1.1", True), (" 12 ", True), ("III", False), ("1.123", False), ("", False), (None, False)])
@pytest.mark.l3_boundary
def test_sheet_number_forms(s, ok):
    from inspector_ml.titleblock import is_sheet_no
    assert is_sheet_no(s) is ok
