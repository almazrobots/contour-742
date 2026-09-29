"""OS-INSP-2.2.135–2.2.144 (T-212): упоминания мероприятия (М-053, 063, 070, 092, 095, 122) и метода демонтажа (М-091)
по паспорту — есть / явно исключено, отрицание в своём предложении, чужой контекст, счётный аспект, словарь методов.

Только синтетические фразы (ADR-0002), написанные по формулировкам разделов ПД/РД, а не по корпусу. Проверяются
и отказы: отрицание чужого элемента, противопоставление, двойное отрицание, опасная зона обрушения, метод вне словаря.
Конфигурация — из паспортов data/seed/passports/M-*.json, собранная так же, как в API (passport.ts: extractorSpec).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from inspector_ml.extract import extract
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word
from inspector_ml.presence_mentions import (
    extract_presence_mentions,
    is_presence_mentions,
)

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)


def spec(code: str) -> ParamSpec:
    """Спецификация как у API: у метода — словарь (ключ и шаблоны), у мероприятия — вид значения."""
    path = ROOT / f"data/seed/passports/{code}.json"
    if not path.exists():  # паспорт без цифр замера лежит в draft/ (вариант А владельца), тест кода вида читает и его
        path = ROOT / f"data/seed/passports/draft/{code}.json"
    pp = json.loads(path.read_text("utf-8"))
    ext = dict(pp["extractor"], value_kind=pp["value"]["kind"])
    if pp["value"]["kind"] == "method":
        ext["terms"] = [
            {"key": k, "patterns": t["patterns"]}
            for k, t in pp["value"]["terms"].items()
        ]
    return ParamSpec(
        code=code, anchors=[pp["title"]], data_type="string", extractor=ext
    )


def mk_page(
    lines: list[str],
    n: int = 1,
    source: str = "text",
    disputed: frozenset[str] = frozenset(),
) -> Page:
    out = []
    for li, text in enumerate(lines):
        ws, x = [], 0.02
        y = 0.05 + 0.03 * li
        for t in text.split(" "):
            w = min(0.004 * max(1, len(t)), 0.5)
            ws.append(
                Word(
                    text=t,
                    bbox=(round(x, 5), y, round(min(x + w, 1.0), 5), y + 0.02),
                    disputed=t in disputed,
                )
            )
            x = min(x + w + 0.004, 0.99)
        out.append(Line(text=text, words=ws))
    return Page(
        page=n,
        width=595,
        height=842,
        source=source,
        ocr_confidence=80 if source == "ocr" else None,
        lines=out,
    )


def mk_doc(*pages: list[str] | Page) -> ParsedDoc:
    ps = [p if isinstance(p, Page) else mk_page(p, i + 1) for i, p in enumerate(pages)]
    return ParsedDoc(sha256="0" * 64, kind="pdf", engine="pdfium", pages=ps)


def states(code: str, *lines: str) -> list[tuple[str, str | None, str | None]]:
    """(состояние, аспект или метод, код отсева) каждого упоминания."""
    out = []
    for e in extract_presence_mentions(mk_doc(list(lines)), spec(code)):
        m = e.meta
        out.append(
            (
                m["state"],
                m["term"] if m["term"] is not None or code == "M-091" else m["aspect"],
                m["excluded"],
            )
        )
    return out


@pytest.mark.l1_functional
def test_bbox_is_deciding_predicate_when_label_and_value_are_apart():
    """T-233: строка «подпись … значение» — рамка на значении («не предусмотрены (исключены)»), не на подписи слева."""
    doc = mk_doc(
        ["Общие указания."],
        ["Демпферные ленты в сопряжениях перегородок не предусмотрены"],
    )
    (e,) = extract_presence_mentions(doc, spec("M-053"))
    assert e.value_text == "absent"
    assert e.anchor_bbox is not None and e.bbox is not None
    assert e.bbox[0] > e.anchor_bbox[2]  # правее подписи: слова сказуемого, а не оборот


@pytest.mark.l1_functional
def test_mention_kept_with_page_quote_bbox_and_ops():
    doc = mk_doc(
        ["Общие указания."],
        [
            "В местах примыкания перегородок к перекрытиям укладывается демпферная лента толщиной 10 мм."
        ],
    )
    (e,) = extract_presence_mentions(doc, spec("M-053"))
    assert (e.page, e.value_text, e.meta["aspect"], e.meta["excluded"]) == (
        2,
        "present",
        "damper",
        None,
    )
    assert e.meta["quote"].startswith("В местах примыкания") and e.bbox is not None
    # T-233: рамка упоминания — слова, решившие состояние («укладывается»); подпись пункта («демпферная лента») — anchor_bbox
    assert e.anchor_bbox is not None and e.bbox != e.anchor_bbox
    assert e.bbox[2] - e.bbox[0] == pytest.approx(0.004 * len("укладывается"), abs=1e-4)
    assert (
        e.meta["ops"] == ["ENT-19", "CMP-09"] and e.meta["predicate"] == "укладывается"
    )


@pytest.mark.l1_functional
def test_explicit_negation_before_and_after_anchor():
    assert states(
        "M-053", "Демпферные ленты в сопряжениях перегородок не предусматриваются."
    ) == [("absent", "damper", None)]
    assert states(
        "M-053", "Не предусматривается устройство упругих прокладок под перегородками."
    ) == [("absent", "damper", None)]
    assert states("M-063", "Деформационный шов по оси 7 исключить.") == [
        ("absent", "joint", None)
    ]
    assert states("M-063", "Исключить деформационный шов по оси 7.") == [
        ("absent", "joint", None)
    ]
    assert states(
        "M-122", "Тактильно-контрастные указатели перед лестницами отсутствуют."
    ) == [("absent", "tactile", None)]
    assert states("M-092", "Защита действующих коммуникаций не требуется.") == [
        ("absent", "protection", None)
    ]
    assert states("M-053", "Перегородки устанавливаются без демпферной ленты.") == [
        ("absent", "damper", None)
    ]


@pytest.mark.l1_functional
def test_affirmation_and_bare_mention_are_present():
    # «исключительно» — не отрицание
    assert states("M-053", "Применяются исключительно демпферные ленты.") == [
        ("present", "damper", None)
    ]
    assert states(
        "M-063", "Здание разделено деформационным швом, шов предусмотрен по оси 7."
    )[0] == ("present", "joint", None)
    assert states("M-122", "ТКУ — рифлёная плитка 300×300.") == [
        ("present", "tactile", None)
    ]
    assert states("M-053", "Демпферная лента ДЛ-10 — 120 м.") == [
        ("present", "damper", None)
    ]


@pytest.mark.l6_adversarial
def test_negation_of_other_element_is_not_ours():
    # противопоставление: отрицание во второй части относится к гидроизоляции
    assert states(
        "M-053", "Демпферные ленты предусмотрены, а гидроизоляция пола не требуется."
    ) == [("present", "damper", None)]
    # первое сказуемое после оборота — утверждение
    assert states(
        "M-053",
        "Демпферные ленты предусмотрены, устройство стяжки по плитам не требуется.",
    ) == [("present", "damper", None)]
    # сказуемое другой части предложения до запятой не наше
    assert states(
        "M-053",
        "Звукоизоляцию потолка исключить, демпферную ленту укладывать по контуру.",
    ) == [("present", "damper", None)]


@pytest.mark.l6_adversarial
def test_double_negation_is_present():
    assert states(
        "M-053", "Отсутствие демпферных лент в узлах примыкания не допускается."
    ) == [("present", "damper", None)]


@pytest.mark.l6_adversarial
def test_foreign_context_excluded_with_reason():
    out = extract_presence_mentions(
        mk_doc(["В существующем здании деформационные швы не предусматриваются."]),
        spec("M-063"),
    )
    assert [(e.meta["state"], e.meta["excluded"]) for e in out] == [
        ("absent", "FOREIGN")
    ]
    assert "существующему или соседнему зданию" in out[0].meta["excluded_why"]
    # шов между новым и существующим зданием — шов объекта
    assert states(
        "M-063",
        "Между проектируемым и существующим зданием устраивается деформационный шов 50 мм.",
    ) == [("present", "joint", None)]
    # «существующие сети» — объект защиты М-092, а не чужое здание
    assert states("M-092", "Над существующими сетями укладываются защитные плиты.") == [
        ("present", "protection", None)
    ]
    assert states("M-092", "На соседнем участке защитные плиты не требуются.") == [
        ("absent", "protection", "FOREIGN")
    ]


@pytest.mark.l1_functional
def test_aspects_and_ground_electrode_count():
    got = extract_presence_mentions(
        mk_doc(
            [
                "Молниезащита здания выполняется по III уровню. Контур заземления из 8 вертикальных заземлителей длиной 3 м."
            ]
        ),
        spec("M-070"),
    )
    assert [(e.meta["aspect"], e.meta["state"], e.meta["count"]) for e in got] == [
        ("lightning", "present", None),
        ("grounding", "present", 8),
    ]
    assert (
        extract_presence_mentions(
            mk_doc(["Заземлители вертикальные в количестве 6 шт."]), spec("M-070")
        )[0].value_num
        == 6
    )
    assert states("M-070", "Молниезащита здания не предусматривается.") == [
        ("absent", "lightning", None)
    ]
    assert states(
        "M-095",
        "Гидроорошение не предусматривается, фасад закрывается защитной сеткой.",
    ) == [("absent", "dust", None), ("present", "screens", None)]


@pytest.mark.l3_boundary
def test_one_mention_per_element_and_sentence_and_ocr_confidence():
    assert (
        len(
            states(
                "M-053", "Демпферная лента и упругие прокладки укладываются по контуру."
            )
        )
        == 1
    )
    doc = mk_doc(
        mk_page(
            ["Демпферная лента укладывается по контуру."],
            source="ocr",
            disputed=frozenset({"Демпферная"}),
        )
    )
    (e,) = extract_presence_mentions(doc, spec("M-053"))
    assert e.confidence == pytest.approx(0.8 * 0.6)


@pytest.mark.l1_functional
def test_method_dictionary_and_negation():
    assert states(
        "M-091", "Демонтаж здания выполняется методом поэлементной разборки."
    ) == [("present", "element", None)]
    assert states(
        "M-091", "Демонтаж каркаса ведётся обрушением экскаватором с гидроножницами."
    ) == [("present", "collapse", None), ("present", "shears", None)]
    assert states(
        "M-091", "Поэлементная разборка перекрытий автомобильным краном."
    ) == [("present", "crane", None)]
    assert states("M-091", "Демонтаж плит выполняется краном.") == [
        ("present", "crane", None)
    ]
    # запрет относится к обрушению, а не к разборке
    assert states(
        "M-091",
        "Разборку вести поэлементно, исключающим обрушение способом, плазменной резкой металлоконструкций.",
    ) == [
        ("present", "dismantle", None),
        ("absent", "collapse", None),
        ("present", "plasma", None),
    ]
    assert states("M-091", "Обрушение конструкций при демонтаже не допускается.") == [
        ("absent", "collapse", None)
    ]


@pytest.mark.l6_adversarial
def test_method_refusals_danger_zone_context_unknown():
    # опасная зона обрушения — требование ТБ, не метод; разборка в том же предложении остаётся
    got = states(
        "M-091",
        "Поэлементную разборку вести с ограждением опасной зоны обрушения конструкций.",
    )
    assert got == [("present", "element", None), ("present", "collapse", "DANGER_ZONE")]
    # обрушение не в разговоре о демонтаже — не метод
    assert states("M-091", "Кровля защищена от обрушения снега.") == []
    # метод назван, но не из словаря — не распознан, а не угадан
    assert states("M-091", "Метод демонтажа — по согласованию с заказчиком.") == [
        ("present", None, None)
    ]


@pytest.mark.l1_functional
def test_extract_routes_presence_param_its_own_way():
    sp = spec("M-053")
    doc = mk_doc(["Демпферная лента укладывается по контуру перегородок."])
    got = extract(doc, [sp])
    assert is_presence_mentions(sp) and sp.code == "M-053"
    assert [(e.code, e.meta["state"]) for e in got] == [("M-053", "present")]


def hints(code: str, *lines: str) -> list[tuple[str, str, str | None, float | None]]:
    """(состояние, аспект или метод, подсказка, число) каждого упоминания документа из строк."""
    got = extract_presence_mentions(mk_doc(list(lines)), spec(code))
    return [
        (
            e.meta["state"],
            e.meta["term"] or e.meta["aspect"],
            e.meta["hint"],
            e.meta["count"],
        )
        for e in got
    ]


@pytest.mark.l6_adversarial
def test_latin_lookalikes_and_line_hyphenation():
    assert hints("M-053", "Вдоль стен уложить дeмпфeр-", "ную ленту 8 мм.") == [
        ("present", "damper", None, None)
    ]
    assert hints("M-095", "Гидрooрошение зоны раз-", "борки до начала работ.") == [
        ("present", "dust", None, None)
    ]
    # латиница в латинском слове не трогается, перенос перед заглавной — не склейка
    assert hints("M-053", "Лента Damper-", "Демпферная лента не укладывается.") == [
        ("absent", "damper", None, None)
    ]


@pytest.mark.l1_functional
def test_table_header_column_and_row():
    assert hints("M-053", "Узел | Демпферная лента | Стяжка", "У-1 | нет | 50") == [
        ("absent", "damper", None, None)
    ]
    assert hints("M-053", "Узел | Демпферная лента | Стяжка", "У-2 | 10 мм | 50") == [
        ("present", "damper", None, None)
    ]
    assert hints(
        "M-053", "Поз. | Наименование | Кол.", "3 | Лента демпферная 10 мм | 300"
    ) == [("present", "damper", None, None)]
    assert hints(
        "M-122",
        "№ | Лист | Изменение",
        "2 | АР-3 | Тактильные полосы у входа исключить",
    ) == [("absent", "tactile", None, None)]
    # «—» в столбце — пусто, а не «нет»
    assert hints("M-053", "Узел | Демпферная лента", "У-3 | —") == [
        ("present", "damper", None, None)
    ]


@pytest.mark.l6_adversarial
def test_reference_without_content_is_not_presence():
    assert hints(
        "M-063", "Температурный шов — по типовому узлу серии 2.030 (в комплекте нет)."
    ) == [("present", "joint", "reference", None)]
    assert hints("M-092", "Мероприятия по защите сетей — согласно ПОД.") == [
        ("present", "protection", "reference", None)
    ]
    # ссылка на узел своего комплекта — упоминание есть
    assert hints("M-063", "Деформационный шов по оси 4 — см. узел 7.") == [
        ("present", "joint", None, None)
    ]
    # явное отрицание не отменяется ссылкой
    assert hints(
        "M-063", "Деформационный шов не предусматривается, см. раздел КР."
    ) == [("absent", "joint", None, None)]


@pytest.mark.l6_adversarial
def test_node_without_element_is_implied_absence():
    assert hints(
        "M-053", "Узел 4. Примыкание перегородки к потолку — на растворе."
    ) == [("absent", "damper", "implied", None)]
    # элемент в том же документе — узел без элемента не выдаётся
    assert hints(
        "M-053",
        "Узел 4. Примыкание перегородки к потолку.",
        "Демпферная лента по периметру.",
    ) == [("present", "damper", None, None)]
    # узел со ссылкой на альбом — не «нет», а ссылка
    assert hints("M-053", "Сопряжение перегородок с потолком — по альбому узлов.") == [
        ("present", "damper", "reference", None)
    ]


@pytest.mark.l6_adversarial
def test_lookalike_element_is_other():
    assert hints("M-063", "Холодный шов бетонирования по оси 3.") == [
        ("present", "joint", "other", None)
    ]
    assert hints("M-095", "Над проходом — козырёк-экран.") == [
        ("present", "screens", "other", None)
    ]
    assert hints("M-122", "Таблички со шрифтом Брайля у кабинетов.") == [
        ("present", "tactile", "other", None)
    ]


@pytest.mark.l1_functional
def test_generic_phrase_only_when_excluded_or_referenced():
    assert hints("M-095", "Снос зданий на участке не требуется.") == [
        ("absent", "dust", None, None),
        ("absent", "screens", None, None),
    ]
    assert hints("M-053", "Мероприятия по защите от шума: демпферная лента.") == [
        ("present", "damper", None, None)
    ]
    assert hints("M-122", "Пребывание МГН на объекте не предусмотрено.") == [
        ("absent", "tactile", None, None)
    ]
    assert hints("M-063", "Сопряжение плит — жёсткое, шов не делать.") == [
        ("absent", "joint", None, None)
    ]
    assert hints("M-063", "Шов по оси 2 заполнить герметиком.") == []


@pytest.mark.l6_adversarial
def test_colon_form_and_participle_negation():
    assert hints("M-070", "Молниезащита: предусмотрена, II уровень.") == [
        ("present", "lightning", None, None)
    ]
    assert hints("M-070", "Молниезащита: нет.") == [("absent", "lightning", None, None)]
    assert hints("M-122", "Тактильные полосы у входа не смонтированы.") == [
        ("absent", "tactile", None, None)
    ]
    # «не более» — ограничение, а не отрицание
    assert hints("M-070", "Сопротивление растеканию — не более 10 Ом.") == [
        ("present", "resistance", None, 10.0)
    ]


@pytest.mark.l1_functional
def test_measures_per_aspect_units_and_unreadable():
    assert hints("M-070", "Токоотводов — 6 шт.") == [
        ("present", "lightning", None, 6.0)
    ]
    assert hints("M-070", "Сечение токоотводов — 35 мм2.") == [
        ("present", "lightning", None, None)
    ]
    assert hints("M-070", "Сопротивление ЗУ, Ом | 30") == [
        ("present", "resistance", None, 30.0)
    ]
    assert hints(
        "M-070",
        "Поз. | Наименование | Ед. | Кол.",
        "1 | Электрод горизонтальный 40х4 | шт. | 3",
    ) == [("present", "grounding", None, 3.0)]
    assert hints("M-070", "Токоотводы — ? шт.") == [
        ("present", "lightning", "reference", None)
    ]
    assert (
        hints("M-063", "ДШ-1 по оси 3; ДШ-2 по оси 9; узел ДШ-1 — лист 5.")[0][3] == 2
    )


@pytest.mark.l1_functional
def test_method_forms_order_abbreviations_context():
    assert states("M-091", "Разборка поэлементная автокраном.") == [
        ("present", "crane", None)
    ]
    assert states("M-091", "Резка металлоконструкций — газовая.") == [
        ("present", "gas", None)
    ]
    assert states("M-091", "Снос — механизированный.") == [
        ("present", "mechanized", None)
    ]
    assert states(
        "M-091", "Демонтаж — экскаватор с навесными гидравлич. ножницами."
    ) == [("present", "shears", None)]
    assert states(
        "M-091", "Операция | Метод", "Демонтаж плит | алм. резка на блоки"
    ) == [("present", "diamond", None)]
    # «без» после метода — не отрицание метода
    assert states(
        "M-091", "Демонтаж перегородок — ручная разборка без применения техники."
    ) == [("present", "manual", None)]
    assert states(
        "M-091", "Снос объектов капитального строительства не предусмотрен."
    ) == [("absent", None, None)]


@pytest.mark.l6_adversarial
def test_generic_yields_to_element_foreign_site_and_abbreviation_sentence():
    # общий оборот накрывает элемент — берётся элемент
    assert hints("M-092", "Инженерные коммуникации проходят вдоль ограждения.") == []
    assert hints("M-092", "Действующие сети отключить и защитить.") == [
        ("present", "protection", None, None)
    ]
    # «(соседний участок)» — чужой объект; похожий элемент у соседнего здания остаётся подсказкой
    got = extract_presence_mentions(
        mk_doc(["Корпус 7 (соседний участок): защита кабеля щитами."]), spec("M-092")
    )
    assert [e.meta["excluded"] for e in got] == ["FOREIGN"]
    assert hints("M-095", "У соседнего здания — козырёк-экран над входом.") == [
        ("present", "screens", "other", None)
    ]
    # сокращение перед заглавной буквой-обозначением — не конец предложения
    assert hints("M-070", "Электрод гориз. L=6 м — ?, шт.") == [
        ("present", "grounding", "reference", None)
    ]


@pytest.mark.l6_adversarial
def test_change_record_old_value_is_not_current():
    # «было» — отменённое значение: в выбор стадии не идёт; «стало» — действующее
    got = extract_presence_mentions(
        mk_doc(
            [
                "Изм. 2: было — «механизированный демонтаж», стало — «поэлементная разборка краном»."
            ]
        ),
        spec("M-091"),
    )
    assert [(e.meta["term"], e.meta["excluded"]) for e in got] == [
        ("mechanized", "CHANGE_OLD"),
        ("crane", None),
    ]
    got = extract_presence_mentions(
        mk_doc(["Было: гидроорошение, стало: гидроорошение и защитные экраны."]),
        spec("M-095"),
    )
    assert [(e.meta["aspect"], e.meta["excluded"]) for e in got] == [
        ("dust", "CHANGE_OLD"),
        ("dust", None),
        ("screens", None),
    ]
    # «заменить X на Y»: X — отменённое
    got = extract_presence_mentions(
        mk_doc(["Демонтаж: гидромолот заменить на алмазную резку."]), spec("M-091")
    )
    assert [(e.meta["term"], e.meta["excluded"]) for e in got] == [
        ("hammer", "CHANGE_OLD"),
        ("diamond", None),
    ]
    # без записи изменения — оба действующие
    assert [
        e.meta["excluded"]
        for e in extract_presence_mentions(
            mk_doc(["Демонтаж: гидромолот и алмазная резка."]), spec("M-091")
        )
    ] == [None, None]


@pytest.mark.l6_adversarial
def test_prohibition_without_measure_means_measure_required():
    assert hints(
        "M-092", "Не допускается производство работ в охранной зоне без шурфования."
    ) == [("present", "protection", None, None)]
    assert hints("M-095", "Запрещается демонтаж перекрытий без гидроорошения.") == [
        ("present", "dust", None, None)
    ]
    assert hints("M-092", "Работы вблизи кабеля — только при защитном коробе.") == [
        ("present", "protection", None, None)
    ]
    # «без» без запрета — по-прежнему исключено
    assert hints("M-095", "Демонтаж перекрытий ведётся без гидроорошения.") == [
        ("absent", "dust", None, None)
    ]


@pytest.mark.l1_functional
def test_method_belongs_to_its_part_of_building():
    got = extract_presence_mentions(
        mk_doc(["Надземная часть — поэлементная разборка; фундаменты — гидромолотом."]),
        spec("M-091"),
    )
    assert [(e.meta["aspect"], e.meta["term"]) for e in got] == [
        ("above", "element"),
        ("foundation", "hammer"),
    ]
    # без названной части — общий метод
    assert [
        e.meta["aspect"]
        for e in extract_presence_mentions(
            mk_doc(["Демонтаж — поэлементная разборка."]), spec("M-091")
        )
    ] == ["main"]


@pytest.mark.l1_functional
def test_registered_in_extractor_kinds_both_kinds():
    from inspector_ml.extractor_kinds import way_by_kind

    assert way_by_kind("presence_mentions") is extract_presence_mentions
    assert way_by_kind("method_mentions") is extract_presence_mentions
    assert is_presence_mentions(spec("M-091")) and is_presence_mentions(spec("M-053"))


@pytest.mark.l6_adversarial
def test_method_negation_only_in_own_part_and_method_verb_sentence():
    # OWASP W3-07: «без …» через запятую не отрицает метод; предложение с глаголом метода — метод
    assert states(
        "M-091", "Обрушение стен экскаватором, без применения взрывчатки."
    ) == [("present", "collapse", None)]
    assert states("M-091", "Стены обрушить экскаватором.") == [
        ("present", "collapse", None)
    ]
    # отрицание в своей части — по-прежнему отрицание
    assert states("M-091", "Обрушение стен не допускается, разборка — краном.")[0] == (
        "absent",
        "collapse",
        None,
    )


@pytest.mark.l7_discipline
@pytest.mark.performance
def test_linear_time_on_page_without_sentence_ends():
    # OWASP W3-03: ~100 КБ без точек, 10 тыс. оборотов — не дольше секунд и не больше MAX_PER_DOC упоминаний
    import time

    from inspector_ml.presence_mentions import MAX_PER_DOC

    words = " ".join(["демонтаж обрушение"] * 5000)
    lines = [words[i : i + 200] for i in range(0, len(words), 200)]
    doc = mk_doc(lines)
    t0 = time.perf_counter()
    got = extract_presence_mentions(doc, spec("M-091"))
    took = time.perf_counter() - t0
    assert took < 5, took
    assert 0 < len(got) <= MAX_PER_DOC and all(e.meta.get("truncated") for e in got)
    # малый документ — без отметки
    assert not any(
        e.meta.get("truncated")
        for e in extract_presence_mentions(
            mk_doc(["Демонтаж — поэлементная разборка."]), spec("M-091")
        )
    )


@pytest.mark.l6_adversarial
def test_raw_is_bounded():
    # OWASP W3-06: сырой оборот не длиннее цитаты
    from inspector_ml.presence_mentions import QUOTE_MAX

    got = extract_presence_mentions(
        mk_doc(["Демонтаж: разборка" + " x" * 400 + " краном."]), spec("M-091")
    )
    assert got and all(len(e.raw) <= QUOTE_MAX for e in got)


@pytest.mark.l6_adversarial
def test_temporary_site_structures_are_own_part():
    got = extract_presence_mentions(
        mk_doc(["Временные здания бытового городка — ручная разборка."]), spec("M-091")
    )
    assert [(e.meta["aspect"], e.meta["term"]) for e in got] == [
        ("temporary", "manual")
    ]
    # часть после метода в той же части предложения
    got = extract_presence_mentions(
        mk_doc(["Демонтаж временного ограждения стройплощадки — вручную."]),
        spec("M-091"),
    )
    assert [e.meta["aspect"] for e in got] == ["temporary"]
    got = extract_presence_mentions(
        mk_doc(["Демонтаж: ручная разборка временных зданий."]), spec("M-091")
    )
    assert [(e.meta["aspect"], e.meta["term"]) for e in got] == [
        ("temporary", "manual")
    ]
    # основное здание — общий метод
    got = extract_presence_mentions(
        mk_doc(["Демонтаж здания — обрушение экскаватором."]), spec("M-091")
    )
    assert [(e.meta["aspect"], e.meta["term"]) for e in got] == [("main", "collapse")]


def test_method_table_heading_does_not_turn_danger_zone_into_method():
    got = states("M-091", "Границы опасных зон развала и обрушения конструкций 30,48 м. Метод демонтажа поэлементная разборка.")
    assert got == [("present", "collapse", "DANGER_ZONE"), ("present", "element", None)]
