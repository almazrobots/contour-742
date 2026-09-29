"""Отложенный (holdout) набор T-176: CMP-05 SUBST (M-050, M-072, M-075, M-079, M-130) и CMP-21 LAYER-SEQ
(M-032, M-044, M-125, M-128).

Написан независимо от экстракторов и написаний (aliases) справочника — только по контракту `__init__.py`, канону
`data/seed/analogs.json`, строкам матрицы и практике проектирования (ГОСТ 21.110, ГОСТ 21.501, СП 17/30/34/50/52).
Все объекты, шифры, адреса, фамилии, количества — вымышленные (ADR-0002). Торговые марки — как примеры каталога.

Метки пар вычисляются здесь же по правилам контракта (`_cat_label`, `_layers_label`): пара порождается из структуры
(упоминания и слои), размечается правилом и принимается, только если знак метки совпал с задуманным видом мутации.
`selfcheck()` пересчитывает метки и проверяет формат, детерминизм и счётчики.

API: samples(seed, n) и pairs(seed, n) — см. контракт. Только стандартная библиотека Python 3.12.
"""

from __future__ import annotations

import copy
import json
import random
import re
import textwrap
from functools import lru_cache
from pathlib import Path

CATEGORY = ["M-050", "M-072", "M-075", "M-079", "M-130"]
LAYERS = ["M-032", "M-044", "M-125", "M-128"]

FAMILY = {
    "M-072": "pipe_pressure",
    "M-075": "pipe_sewer",
    "M-130": "luminaire",
    "M-050": "finish",
    "M-079": "fan",
    "M-044": "envelope_layers",
    "M-125": "envelope_layers",
    "M-128": "envelope_layers",
    "M-032": "road_layers",
}
POS, NEG = "CANDIDATE", "NEGATIVE_VERIFIED"

# ------------------------------------------------------------------------------------------------ справочник и правила


def _root() -> Path:
    for p in Path(__file__).resolve().parents:
        if (p / "data" / "seed" / "matrix.json").exists():
            return p
    raise FileNotFoundError("не найден корень репозитория (data/seed/matrix.json)")


@lru_cache(maxsize=None)
def _families() -> dict:
    return json.loads((_root() / "data" / "seed" / "analogs.json").read_text("utf-8"))[
        "families"
    ]


def _canon(fam: str) -> dict:
    return _families()[fam]["canon"]


def _worse(fam: str, char: str, pd, rd) -> bool:
    spec = _families()[fam]["chars"][char]
    if spec["kind"] == "ordinal":
        sc = spec["scale"]
        return sc.index(rd) < sc.index(pd)
    tol = spec.get("tol_rel", 0.0)
    if spec["better"] == "up":
        return rd < pd * (1 - tol)
    return rd > pd * (1 + tol)


def verdict(fam: str, a: str, b: str) -> str:
    """Вердикт пары ключей «из ПД → в РД» по семейству (контракт, пункты 1–3)."""
    F = _families()[fam]
    for r in F.get("analogs", []):
        if r["from"] == a and r["to"] == b:
            return r["verdict"]
    d = F.get("derive")
    canon = F["canon"]
    if d and a in canon and b in canon:
        ca, cb = canon[a], canon[b]
        if (d.get("any_group") or ca["group"] == cb["group"]) and all(
            c in ca["chars"] and c in cb["chars"] for c in d["chars"]
        ):
            bad = any(
                _worse(fam, c, ca["chars"][c], cb["chars"][c]) for c in d["chars"]
            )
            return "NOT_EQUIVALENT" if bad else "EQUIVALENT"
    return "UNKNOWN"


def _not_worse_keys(fam: str, a: str, keys) -> list[str]:
    """Ключи, у которых по канону ни одна характеристика семейства не хуже, чем у a (для «или аналог»)."""
    canon = _canon(fam)
    out = []
    for k in keys:
        if k == a:
            continue
        cmp = [c for c in _families()[fam]["chars"] if c in canon[a]["chars"] and c in canon[k]["chars"]]
        if cmp and not any(_worse(fam, c, canon[a]["chars"][c], canon[k]["chars"][c]) for c in cmp):
            out.append(k)
    return out


_TWINS = str.maketrans("АВЕКМНОРСТУХ", "ABEKMHOPCTYX")


def fold_model(s: str) -> str:
    """Свёртка открытой марки M-079 по контракту."""
    return re.sub(r"[\s\-.,()/\\]", "", s.upper().translate(_TWINS))


# --------------------------------------------------------------------------------------------- метка CMP-05 (контракт)


def _support(rd: dict, pd_ms: list[dict]) -> list[dict]:
    it, el = rd["item"], rd["element"]
    for flt in (
        lambda m: m["item"] == it and m["element"] == el,
        lambda m: m["item"] == it and m["element"] is None,
        lambda m: m["item"] == it,
        lambda m: m["item"] is None and m["element"] is None,
    ):
        s = [m for m in pd_ms if flt(m)]
        if s:
            return s
    return []


def _char_of(fam: str, m: dict, c: str):
    if c in m.get("chars", {}):
        return m["chars"][c]
    canon = _canon(fam)
    return canon.get(m["value"], {}).get("chars", {}).get(c)


def _cat_violation(param: str, rd: dict, sup: list[dict]):
    """(нарушение, валидно). Невалидно — пару порождать нельзя (контракт: ни одна характеристика не сравнилась)."""
    fam = FAMILY[param]
    open_ = _families()[fam]["open"]
    key = fold_model if open_ else (lambda v: v)
    vals = [v for m in sup for v in [m["value"], *m["alts"]]]
    if key(rd["value"]) in {key(v) for v in vals}:
        return False, True
    ref = [m for m in sup if m["or_analog"]]
    if ref:
        if len(sup) != 1 or sup[0]["alts"]:
            return (
                False,
                False,
            )  # неоднозначная опора с «или аналог» — такие пары не порождаем
        pd = ref[0]
        compared, bad = 0, False
        for c in _families()[fam]["chars"]:
            a, b = _char_of(fam, pd, c), _char_of(fam, rd, c)
            if a is None or b is None:
                continue
            compared += 1
            bad = bad or _worse(fam, c, a, b)
        return bad, compared > 0
    if open_:
        return True, True
    return (not any(verdict(fam, v, rd["value"]) == "EQUIVALENT" for v in vals)), True


def _cat_label(param: str, pd_ms: list[dict], rd_ms: list[dict]):
    """Метка пары CMP-05 по контракту; None — пару порождать нельзя."""
    viol = False
    for rd in rd_ms:
        sup = _support(rd, pd_ms)
        if not sup:
            continue
        v, ok = _cat_violation(param, rd, sup)
        if not ok:
            return None
        viol = viol or v
    return POS if viol else NEG


# --------------------------------------------------------------------------------------------- метка CMP-21 (контракт)


def _match_comps(pd_c: list[dict], rd_c: list[dict]):
    out = []
    for p in pd_c:
        if p["item"] is not None:
            r = [x for x in rd_c if x["item"] == p["item"]]
            if r:
                out.append((p, r[0]))
                continue
        if (
            len(pd_c) == 1
            and len(rd_c) == 1
            and (p["item"] is None or rd_c[0]["item"] is None)
        ):
            out.append((p, rd_c[0]))
    return out


def _layer_ops(fam: str, p: dict, r: dict):
    """Операции выравнивания по слотам (слот — идентичность слоя при мутации). None — пару порождать нельзя."""
    ops = []
    rpos = {L["slot"]: (i, L) for i, L in enumerate(r["layers"])}
    seq = []
    for L in p["layers"]:
        if L["slot"] not in rpos:
            ops.append("delete_layer")
            continue
        i, R = rpos[L["slot"]]
        seq.append(i)
        if (L["t"] is None) != (R["t"] is None):
            return None  # толщина только в одной стадии
        if L["m"] != R["m"]:
            if L["m"] is None and R["m"] is None:
                return None
            v = verdict(fam, L["m"], R["m"]) if L["m"] and R["m"] else "UNKNOWN"
            ops.append(
                "substitute_material" if v != "EQUIVALENT" else "substitute_equivalent"
            )
        if L["t"] is not None:
            if R["t"] < L["t"] - 0.5:
                ops.append("thickness_down")
            elif R["t"] > L["t"] + 0.5:
                ops.append("thickness_up")
    if seq != sorted(seq):
        ops.append("reorder")
    pslots = {L["slot"] for L in p["layers"]}
    if any(R["slot"] not in pslots for R in r["layers"]):
        ops.append("insert_layer")
    return ops


_BAD_OPS = {"delete_layer", "substitute_material", "thickness_down", "reorder"}


def _layers_label(param: str, pd_c: list[dict], rd_c: list[dict]):
    fam = FAMILY[param]
    bad = False
    matched = _match_comps(pd_c, rd_c)
    if not matched:
        return None
    for p, r in matched:
        ops = _layer_ops(fam, p, r)
        if ops is None:
            return None
        bad = bad or any(o in _BAD_OPS for o in ops)
    return POS if bad else NEG


# ------------------------------------------------------------------------------------------------------ текстовый шум

_OBJ = [
    "Многоквартирный жилой дом с подземной автостоянкой, поз. 3",
    "Общеобразовательная школа на 825 мест",
    "Детский сад на 220 мест",
    "Поликлиника на 300 посещений в смену",
    "Административно-бытовой корпус",
    "Жилой комплекс «Северная долина», корпус 2",
    "Физкультурно-оздоровительный комплекс с бассейном",
    "Складской комплекс с АБК",
    "Многофункциональный центр по ул. Береговой, 7",
    "Жилой дом № 5 в микрорайоне «Липовая роща»",
]
_PLACE = [
    "г. Новоборск",
    "г. Краснолесье",
    "пос. Заречный",
    "г. Верхнекамск",
    "с. Луговое",
    "г. Светлогорье",
]
_NAMES = [
    "Сорокин",
    "Лебедева",
    "Галиев",
    "Орлова",
    "Мухин",
    "Зайцева",
    "Ткаченко",
    "Белов",
    "Нуриева",
    "Кравец",
]
_MAKERS = [
    "ООО «Вектор-Пласт»",
    "АО «Новоборский трубный завод»",
    "ООО «АкваЛайн-Н»",
    "ООО «ТермоСтрой-Урал»",
    "ООО «СветоТехПром»",
    "АО «Климат-Инжиниринг»",
    "ООО «ПолиКровля»",
    "ООО «Фасад-Систем»",
]
_SECT = {
    "M-072": ("ИОС2", "ВК"),
    "M-075": ("ИОС3", "ВК"),
    "M-079": ("ИОС4", "ОВ"),
    "M-130": ("ИОС1", "ЭО"),
    "M-050": ("АР", "АР"),
    "M-044": ("АР", "АР"),
    "M-125": ("АР", "АР"),
    "M-128": ("АР", "АР"),
    "M-032": ("ПЗУ", "ГП"),
}


def _base_code(rng: random.Random) -> str:
    org = rng.choice(["ХО", "СП", "ГП", "АБ", "НТ", "КСМ", "ПР", "ТС", "ВЛ"])
    return f"{org}-{rng.randint(1, 99):02d}/{rng.choice([23, 24, 25, 26])}"


def _cipher(rng: random.Random, base: str, param: str, stage: str) -> str:
    pd_s, rd_s = _SECT[param]
    if stage == "П":
        if param in ("M-125", "M-128") and rng.random() < 0.4:
            pd_s = "ЭЭ"
        return f"{base}-П-{pd_s}"
    if param == "M-032" and rng.random() < 0.4:
        rd_s = "АД"
    if param == "M-130" and rng.random() < 0.3:
        rd_s = "ЭМ"
    return f"{base}-{rng.choice(['Р-', 'РД-', ''])}{rd_s}"


def _stamp(rng: random.Random, cipher: str, stage: str, title: str) -> list[str]:
    head = rng.choice(
        [
            "Изм. Кол.уч. Лист №док. Подп. Дата",
            "Изм.  Кол.уч  Лист  № док.  Подпись  Дата",
            "Изм. | Кол.уч. | Лист | №док. | Подп. | Дата",
        ]
    )
    lines = [
        head,
        f"Разраб. {rng.choice(_NAMES)}",
        f"Пров. {rng.choice(_NAMES)}",
        f"ГИП {rng.choice(_NAMES)}",
        cipher,
        f"{rng.choice(_OBJ)}. {rng.choice(_PLACE)}",
        f"Стадия {stage}   Лист {rng.randint(2, 40)}   Листов {rng.randint(41, 90)}",
        title,
    ]
    if rng.random() < 0.5:
        lines.append("Инв. № подл.   Подп. и дата   Взам. инв. №")
    return lines


def _wrap(rng: random.Random, text: str) -> list[str]:
    return textwrap.wrap(
        text, width=rng.randint(58, 96), break_long_words=False, break_on_hyphens=False
    )


def _nbsp(rng: random.Random, s: str) -> str:
    if rng.random() < 0.25:
        s = re.sub(r"(\d) (мм|см|Вт|кВт|Па|м³/ч)", "\\1\u00a0\\2", s)
    if rng.random() < 0.2:
        s = s.replace(" ", "  ", 1)
    return s


def _spell(rng: random.Random, s: str) -> str:
    """Другое написание того же: кириллица/латиница в марках, ё/е, пробелы, регистр первой буквы."""
    lat2cyr = str.maketrans("ABEKMHOPCTYX", "АВЕКМНОРСТУХ")
    out = []
    for tok in re.split(r"(\s+)", s):
        if re.fullmatch(r"[A-ZА-Я0-9\-/]{2,}", tok) and rng.random() < 0.7:
            if re.search(r"[A-Z]", tok):
                tok = tok.translate(lat2cyr) if rng.random() < 0.5 else tok
            else:
                tok = tok.translate(_TWINS)
        out.append(tok)
    s2 = "".join(out).replace("ё", "е")
    if rng.random() < 0.4:
        s2 = re.sub(r"(\d) (мм)", "\\1\\2", s2)
    if rng.random() < 0.5 and s2[:1].isupper():
        s2 = s2[:1].lower() + s2[1:]
    if s2 == s:
        s2 = s.replace(" ", "  ", 1) if " " in s else s + " "
    return s2


def _dims(rng: random.Random, over: dict | None = None) -> dict:
    od = rng.choice([20, 25, 32, 40, 50, 63])
    d = {
        "du": rng.choice([15, 20, 25, 32, 40, 50]),
        "s": rng.choice(["2,5", "2,8", "3,2", "3,5"]),
        "od": od,
        "w": {20: "3,4", 25: "4,2", 32: "5,4", 40: "6,7", 50: "8,3", 63: "10,5"}[od],
        "wm": rng.choice(["1,0", "1,2", "1,5", "2,0", "2,8"]),
        "dn": rng.choice([50, 100, 150]),
        "d": rng.choice([50, 110, 160]),
        "a": rng.choice(["01", "03", "11", "22", "41", "62"]),
        "c": rng.choice(["001", "002", "004", "011"]),
        "wt": rng.choice([12, 18, 24, 36, 40, 45]),
        "ip": rng.choice([20, 40, 54, 65]),
        "eff": rng.choice([105, 110, 120, 130, 140]),
        "life": rng.choice([50000, 60000, 70000]),
        "noise": rng.choice([18, 19, 20]),
        "mk": rng.choice(_MAKERS),
        "km": None,
    }
    d.update(over or {})
    d["life_s"] = f"{d['life']:,}".replace(",", " ")
    return d


def _render(rng: random.Random, var: tuple, over: dict | None = None):
    tpl, chars = var
    dm = _dims(rng, over)
    text = tpl.format(**dm)
    ch = {c: (dm[v] if isinstance(v, str) else v) for c, v in chars.items()}
    return text, ch


def _row(rng: random.Random, cells: list[str], sep: str) -> str:
    if sep == "|":
        return " | ".join(cells)
    return (" " * rng.randint(2, 5)).join(c for c in cells if c != "")


# ================================================================================================ CMP-05: трубы (M-072)

_V072 = {
    "STEEL_GALV": {
        "short": ["стальные оцинкованные трубы", "трубы стальные оцинкованные"],
        "pz": [
            ("трубы стальные водогазопроводные оцинкованные по ГОСТ 3262-75", {}),
            ("стальные оцинкованные трубы ГОСТ 3262-75*", {}),
            ("трубы ВГП оцинкованные (ГОСТ 3262-75)", {}),
            ("оцинкованные водогазопроводные трубы обыкновенные", {}),
        ],
        "spec": [
            ("Труба стальная водогазопроводная оцинкованная Ду{du}×{s}", {}),
            ("Труба ВГП оц. {du}×{s} ГОСТ 3262-75*", {}),
            ("Труба ст. оцинк. легкая Ду {du}", {}),
            ("Труба стальная оцинкованная обыкновенная {du}×{s}", {}),
        ],
        "doc": "ГОСТ 3262-75*",
    },
    "STEEL_STAINLESS": {
        "short": ["трубы из нержавеющей стали"],
        "pz": [
            ("трубы из нержавеющей стали AISI 304", {}),
            ("трубы стальные нержавеющие (сталь 08Х18Н10)", {}),
            ("нержавеющие стальные трубы под пресс-фитинг", {}),
        ],
        "spec": [
            ("Труба нержавеющая 08Х18Н10 {od}×{wm}", {}),
            ("Труба из нерж. стали AISI 304 Ø{od}×{wm}", {}),
            ("Труба стальная нержавеющая для пресс-соединений {od}×{wm}", {}),
        ],
        "doc": "ГОСТ 9941-81",
    },
    "COPPER": {
        "short": ["медные трубы"],
        "pz": [
            ("медные трубы по ГОСТ Р 52318-2005", {}),
            ("трубы медные твёрдые Cu-DHP", {}),
        ],
        "spec": [
            ("Труба медная {od}×{wm} ГОСТ Р 52318-2005", {}),
            ("Труба Cu-DHP R290 Ø{od}×{wm}", {}),
            ("Труба медная тянутая твердая {od}×{wm}", {}),
        ],
        "doc": "ГОСТ Р 52318-2005",
    },
    "PPR": {
        "short": ["полипропиленовые трубы", "трубы полипропиленовые"],
        "pz": [
            ("трубы полипропиленовые PP-R PN20 по ГОСТ 32415-2013", {"pn": 20}),
            ("полипропиленовые трубы PN 20", {"pn": 20}),
            ("трубы из полипропилена рандомсополимера (PP-R)", {}),
            ("трубы ППР PN10", {"pn": 10}),
        ],
        "spec": [
            ("Труба полипропиленовая PP-R PN20 Ø{od}×{w}", {"pn": 20}),
            ("Труба PP-R 80 SDR 6 {od}×{w}", {}),
            ("Труба ППР PN 20 {od}×{w}", {"pn": 20}),
            ("Труба напорная из полипропилена PN10 Ø{od}", {"pn": 10}),
        ],
        "doc": "ГОСТ 32415-2013",
    },
    "PPR_FIBER": {
        "short": ["армированные полипропиленовые трубы"],
        "pz": [
            (
                "полипропиленовые трубы PP-R, армированные стекловолокном, PN20",
                {"pn": 20},
            ),
            ("трубы PP-R/GF/PP-R (армированные стекловолокном)", {}),
            ("трубы полипропиленовые армированные алюминием PN25", {"pn": 25}),
        ],
        "spec": [
            ("Труба PP-R армированная стекловолокном PN20 {od}×{w}", {"pn": 20}),
            ("Труба PP-R/AL/PP-R PN25 Ø{od}", {"pn": 25}),
            (
                "Труба полипропиленовая армированная (стекловолокно) PN20 Ø{od}",
                {"pn": 20},
            ),
        ],
        "doc": "ГОСТ 32415-2013",
    },
    "PEX": {
        "short": ["трубы из сшитого полиэтилена"],
        "pz": [
            ("трубы из сшитого полиэтилена PE-Xa", {}),
            ("трубы PE-X (сшитый полиэтилен) PN10", {"pn": 10}),
        ],
        "spec": [
            ("Труба PE-Xa {od}×{wm} PN10", {"pn": 10}),
            ("Труба из сшитого полиэтилена PEX-b Ø{od}", {}),
            ("Труба PE-Xa с кислородным барьером {od}×{wm}", {}),
        ],
        "doc": "ГОСТ 32415-2013",
    },
    "PERT": {
        "short": ["трубы из термостойкого полиэтилена"],
        "pz": [
            ("трубы из полиэтилена повышенной термостойкости PE-RT тип II", {}),
            ("трубы PE-RT (полиэтилен повышенной термостойкости)", {}),
        ],
        "spec": [
            ("Труба PE-RT тип II {od}×{wm}", {}),
            ("Труба PE-RT/EVOH/PE-RT Ø{od}", {}),
        ],
        "doc": "ГОСТ 32415-2013",
    },
    "MLP": {
        "short": ["металлополимерные трубы"],
        "pz": [
            ("металлополимерные трубы PEX-AL-PEX", {}),
            ("металлопластиковые трубы PE-RT/AL/PE-RT", {}),
            ("многослойные металлополимерные трубы (PE-Xb/Al/PE-Xb)", {}),
        ],
        "spec": [
            ("Труба металлополимерная PEX-AL-PEX {od}×{wm}", {}),
            ("Труба металлопластиковая {od}×{wm} (PE-RT/Al/PE-RT)", {}),
            ("Труба многослойная металлополимерная Ø{od}", {}),
        ],
        "doc": "ГОСТ Р 53630-2015",
    },
    "PVC_U": {
        "short": ["трубы НПВХ"],
        "pz": [
            ("напорные трубы НПВХ (PVC-U) PN10", {"pn": 10}),
            ("трубы из непластифицированного ПВХ напорные", {}),
        ],
        "spec": [
            ("Труба напорная НПВХ PN10 Ø{od}", {"pn": 10}),
            ("Труба PVC-U напорная {od}×{wm}", {}),
        ],
        "doc": "ГОСТ Р 51613-2000",
    },
}

_V075 = {
    "CAST_IRON_SML": {
        "short": ["чугунные безраструбные трубы"],
        "pz": [
            ("безраструбные чугунные трубы системы SML", {}),
            ("трубы чугунные безраструбные (SML) по DIN EN 877", {}),
            ("чугунные трубы SML на хомутовых соединениях", {}),
        ],
        "spec": [
            ("Труба чугунная безраструбная SML DN{dn}", {}),
            ("Труба SML Ду{dn} L=3000", {}),
            ("Труба канализационная чугунная без раструба DN {dn}", {}),
        ],
        "doc": "DIN EN 877",
    },
    "CAST_IRON": {
        "short": ["чугунные трубы", "трубы чугунные"],
        "pz": [
            ("чугунные канализационные трубы по ГОСТ 6942-98", {}),
            ("трубы чугунные раструбные канализационные", {}),
        ],
        "spec": [
            ("Труба чугунная канализационная ЧК {dn}-2000 ГОСТ 6942-98", {}),
            ("Труба ЧК Ду{dn}", {}),
            ("Труба чугунная раструбная {dn}×2000", {}),
        ],
        "doc": "ГОСТ 6942-98",
    },
    "PP_NOISE": {
        "short": ["малошумные трубы"],
        "pz": [
            (
                "малошумные полипропиленовые трубы с минеральным наполнителем (типа Sinikon Comfort Plus)",
                {},
            ),
            (
                "шумопоглощающие трёхслойные трубы из полипропилена (уровень шума не более {noise} дБ(А))",
                {"noise": "noise"},
            ),
            ("трубы Rehau Raupiano Plus", {}),
            ("малошумные канализационные трубы PP-MD", {}),
        ],
        "spec": [
            ("Труба малошумная PP-MD Ø{d} (Sinikon Comfort Plus)", {}),
            ("Труба Raupiano Plus DN{dn} L=1000", {}),
            ("Труба канализационная малошумная трёхслойная ПП Ø{d}", {}),
            ("Труба Skolan dB Ø{d}×5,3", {}),
        ],
        "doc": "ТУ 4926-010-42943419",
    },
    "PP": {
        "short": ["полипропиленовые трубы"],
        "pz": [
            ("полипропиленовые канализационные трубы по ГОСТ 32414-2013", {}),
            ("трубы ПП канализационные серые", {}),
            ("канализационные трубы из полипропилена", {}),
        ],
        "spec": [
            ("Труба ПП канализационная Ø{d}×2,7 ГОСТ 32414-2013", {}),
            ("Труба полипропиленовая раструбная {d}×2,7×1000", {}),
            ("Труба PP-H канализационная Ø{d}", {}),
        ],
        "doc": "ГОСТ 32414-2013",
    },
    "PVC": {
        "short": ["трубы ПВХ"],
        "pz": [
            ("трубы НПВХ канализационные", {}),
            ("канализационные ПВХ трубы", {}),
            ("трубы из поливинилхлорида (PVC-U) канализационные", {}),
        ],
        "spec": [
            ("Труба НПВХ канализационная {d}×3,2", {}),
            ("Труба ПВХ канализационная Ø{d}", {}),
            ("Труба PVC-U раструбная {d}×3,2", {}),
        ],
        "doc": "ГОСТ Р 51613-2000",
    },
    "PE_HD": {
        "short": ["трубы ПНД"],
        "pz": [
            ("трубы из полиэтилена высокой плотности (ПЭНД) на сварке", {}),
            ("сварные трубы HDPE", {}),
            ("полиэтиленовые трубы ПЭНД со стыковой сваркой", {}),
        ],
        "spec": [
            ("Труба ПЭНД канализационная сварная Ø{d}", {}),
            ("Труба HDPE (PE-HD) {d}×4,3", {}),
            ("Труба полиэтиленовая ПЭНД для сварки Ø{d}×4,3", {}),
        ],
        "doc": "EN 1519-1",
    },
}

_PIPE = {
    "M-072": {
        "fam": "pipe_pressure",
        "voc": _V072,
        "generic": "водоснабжения",
        "items": {
            "В1": (
                ["хозяйственно-питьевого водопровода В1", "холодного водоснабжения В1"],
                [
                    "Система В1. Водопровод хозяйственно-питьевой",
                    "В1 — Хозяйственно-питьевой водопровод",
                    "Водопровод хоз.-питьевой В1",
                ],
            ),
            "Т3": (
                ["горячего водоснабжения Т3", "ГВС Т3 (подающий трубопровод)"],
                [
                    "Система Т3. Горячее водоснабжение",
                    "Т3 — Трубопровод горячего водоснабжения (подающий)",
                    "ГВС Т3",
                ],
            ),
            "Т4": (
                ["циркуляции ГВС Т4", "циркуляционного трубопровода Т4"],
                [
                    "Система Т4. Циркуляционный трубопровод ГВС",
                    "Т4 — Циркуляция горячей воды",
                ],
            ),
        },
        "els": {
            "main": (
                ["магистральные трубопроводы", "магистрали в техподполье"],
                ["Магистральные трубопроводы", "Магистрали"],
            ),
            "riser": (["стояки"], ["Стояки", "Стояки (в шахтах)"]),
            "branch": (
                ["поквартирная разводка", "подводки к санитарным приборам"],
                ["Поквартирная разводка", "Подводки к приборам"],
            ),
        },
        "item_els": {
            "В1": ["main", "riser", "branch"],
            "Т3": ["main", "riser", "branch"],
            "Т4": ["main", "riser"],
        },
        "item_sets": [["В1", "Т3"], ["В1", "Т3", "Т4"], ["В1"], ["Т3", "Т4"]],
        "keys": {
            "В1": [
                "STEEL_GALV",
                "STEEL_STAINLESS",
                "COPPER",
                "PPR",
                "PPR_FIBER",
                "PEX",
                "PERT",
                "MLP",
                "PVC_U",
            ],
            "Т3": [
                "STEEL_GALV",
                "STEEL_STAINLESS",
                "COPPER",
                "PPR",
                "PPR_FIBER",
                "PEX",
                "PERT",
                "MLP",
            ],
            "Т4": [
                "STEEL_GALV",
                "STEEL_STAINLESS",
                "COPPER",
                "PPR",
                "PPR_FIBER",
                "PEX",
                "PERT",
                "MLP",
            ],
            None: [
                "STEEL_GALV",
                "STEEL_STAINLESS",
                "COPPER",
                "PPR",
                "PPR_FIBER",
                "PEX",
                "PERT",
                "MLP",
            ],
        },
        "traps_pz": [
            "Трубопроводы системы отопления Т1, Т2 — трубы стальные водогазопроводные по ГОСТ 3262-75 (Ду до 50) "
            "и электросварные по ГОСТ 10704-91.",
            "Существующие сети водопровода В1 из стальных оцинкованных труб, проходящие в техподполье, подлежат демонтажу.",
            "Допускается применение металлополимерных труб и труб из сшитого полиэтилена по ГОСТ 32415-2013 "
            "при условии соответствия классу эксплуатации.",
            "Ввод водопровода соседнего жилого дома (корп. 2) выполнен из чугунных труб ВЧШГ — существующий, "
            "проектом не затрагивается.",
            "Трубопроводы противопожарного водопровода В2 — стальные электросварные по ГОСТ 10704-91.",
            "Разводка системы отопления от коллекторов — трубы PE-Xa с антидиффузионным слоем (Т1, Т2).",
            "Запрещается прокладка полипропиленовых трубопроводов в местах возможного механического повреждения.",
            "Трубопроводы теплоснабжения калориферов Т11, Т21 — стальные электросварные.",
        ],
        "traps_spec": [
            (
                "Система отопления Т1, Т2",
                [
                    "Труба PP-R армированная стекловолокном PN20 Ø25",
                    "Труба стальная электросварная 57×3,5",
                ],
            ),
            (
                "Демонтируемые трубопроводы (существующие)",
                [
                    "Труба стальная оцинкованная Ду50",
                    "Труба стальная оцинкованная Ду32",
                ],
            ),
            (
                "Противопожарный водопровод В2",
                ["Труба стальная электросварная 76×3,5 ГОСТ 10704-91"],
            ),
        ],
    },
    "M-075": {
        "fam": "pipe_sewer",
        "voc": _V075,
        "generic": "канализации",
        "items": {
            "К1": (
                ["бытовой канализации К1", "хозяйственно-бытовой канализации К1"],
                [
                    "Система К1. Бытовая канализация",
                    "К1 — Канализация хозяйственно-бытовая",
                    "Канализация К1",
                ],
            ),
            "К2": (
                ["внутренних водостоков К2", "внутреннего водостока К2"],
                ["Система К2. Внутренние водостоки", "К2 — Водосток внутренний"],
            ),
        },
        "els": {
            "riser": (["стояки"], ["Стояки"]),
            "branch": (
                ["отводные трубопроводы", "горизонтальные отводы от приборов"],
                ["Отводные трубопроводы", "Отводы от приборов"],
            ),
            "outlet": (["выпуски"], ["Выпуски", "Выпуски из здания"]),
        },
        "item_els": {"К1": ["riser", "branch", "outlet"], "К2": ["riser", "outlet"]},
        "item_sets": [["К1"], ["К1", "К2"], ["К2"]],
        "keys": {
            "К1": ["CAST_IRON_SML", "CAST_IRON", "PP_NOISE", "PP", "PVC", "PE_HD"],
            "К2": ["CAST_IRON_SML", "CAST_IRON", "PP_NOISE", "PVC", "PE_HD"],
            None: ["CAST_IRON_SML", "CAST_IRON", "PP_NOISE", "PP", "PVC", "PE_HD"],
        },
        "traps_pz": [
            "Наружные сети дождевой канализации К2 выполнить из гофрированных полипропиленовых труб SN8.",
            "Наружная сеть бытовой канализации К1 до колодца КК-1 — из труб НПВХ SN4 (см. раздел НВК).",
            "Существующие чугунные канализационные трубопроводы подвала подлежат демонтажу.",
            "Допускается применение труб НПВХ при условии установки противопожарных муфт в местах прохода перекрытий.",
            "Дренажные трубопроводы от кондиционеров К13 — из труб ПВХ Ø32.",
            "Трубопроводы производственной канализации К3 от моечных — из полипропилена.",
            "Канализация соседнего здания (корп. 1) выполнена из чугунных труб — не затрагивается.",
        ],
        "traps_spec": [
            (
                "Наружные сети К2 (раздел НВК)",
                ["Труба гофрированная ПП SN8 Ø315", "Колодец полимерный Ø1000"],
            ),
            (
                "Демонтаж существующих трубопроводов К1",
                ["Труба чугунная канализационная Ду100"],
            ),
            ("Система К13. Дренаж кондиционеров", ["Труба ПВХ Ø32", "Трап дренажный"]),
        ],
    },
}


def _pipe_join_items(rng, cfg, items, long: bool) -> str:
    if long:
        names = [rng.choice(cfg["items"][i][0]) for i in items]
    else:
        names = list(items)
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + " и " + names[-1]


def _pipe_join_els(rng, cfg, els) -> str:
    names = [rng.choice(cfg["els"][e][0]) for e in els]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " и " + names[-1]


def _analog_word(rng) -> str:
    return rng.choice(
        [" или аналог", " (или аналог)", " или эквивалент", " или равноценные"]
    )


def _pipe_phrase(rng, cfg, st, reg: str):
    voc = cfg["voc"][st["key"]]
    if reg == "short":
        text, ch = rng.choice(voc["short"]), {}
    else:
        vs = voc[reg]
        vi = st.get("vi")
        if vi is None or vi >= len(vs):
            vi = rng.randrange(len(vs))
        st["vi"] = vi
        text, ch = _render(rng, vs[vi], st.get("over"))
    if st["alts"]:
        alt = cfg["voc"][st["alts"][0]]
        text = f"{text} или {rng.choice(alt['short'])}"
    if st["or_analog"]:
        text += _analog_word(rng)
    if st.get("respell"):
        text = _spell(rng, text)
    st["chars"] = ch
    return text


def _pipe_sentence(rng, cfg, st, reg="pz") -> str:
    X = _pipe_phrase(rng, cfg, st, reg)
    items, els = st["items"], st["elements"]
    if els == [None]:
        if items == [None]:
            g = cfg["generic"]
            return rng.choice(
                [
                    f"Для внутренних сетей {g} здания приняты {X}.",
                    f"Трубопроводы внутренних сетей {g} — {X}.",
                    f"Внутренние сети {g} монтируются из следующих материалов: {X}.",
                ]
            )
        return rng.choice(
            [
                f"Для систем {_pipe_join_items(rng, cfg, items, True)} приняты {X}.",
                f"Трубопроводы систем {_pipe_join_items(rng, cfg, items, False)} — {X}.",
                f"Материал трубопроводов {_pipe_join_items(rng, cfg, items, False)}: {X}.",
            ]
        )
    el = _pipe_join_els(rng, cfg, els)
    el = el[:1].upper() + el[1:]
    if items == [None]:
        return f"{el} — {X}."
    return rng.choice(
        [
            f"{el} систем {_pipe_join_items(rng, cfg, items, False)} — {X}.",
            f"{el} {_pipe_join_items(rng, cfg, items, True)} выполняются: {X}.",
        ]
    )


def _pipe_expand(sts) -> list[dict]:
    out = []
    for st in sts:
        for it in st["items"]:
            for el in st["elements"]:
                out.append(
                    {
                        "item": it,
                        "element": el,
                        "value": st["key"],
                        "alts": list(st["alts"]),
                        "or_analog": st["or_analog"],
                        "chars": dict(st.get("chars", {})),
                    }
                )
    return out


def _st(items, els, key, alts=(), or_analog=False):
    return {
        "items": list(items),
        "elements": list(els),
        "key": key,
        "alts": list(alts),
        "or_analog": or_analog,
    }


def _pipe_pd(rng, cfg, scen: str):
    items = list(rng.choice(cfg["item_sets"]))
    keys_for = lambda its: sorted(set.intersection(*[set(cfg["keys"][i]) for i in its]))  # noqa: E731
    if scen == "all_none":
        return [_st(items, [None], rng.choice(keys_for(items)))]
    if scen == "generic":
        return [_st([None], [None], rng.choice(cfg["keys"][None]))]
    if scen == "per_item":
        return [_st([i], [None], rng.choice(cfg["keys"][i])) for i in items]
    # el_split: первые элементы одним материалом, последний элемент — другим
    common = sorted(set.intersection(*[set(cfg["item_els"][i]) for i in items]))
    if len(common) < 2:
        items = [items[0]]
        common = cfg["item_els"][items[0]]
    order = [e for e in ("main", "riser", "branch", "outlet") if e in common]
    last = order[-1] if cfg["fam"] == "pipe_pressure" else rng.choice(order)
    rest = [e for e in order if e != last]
    k1 = rng.choice(keys_for(items))
    k2 = rng.choice([k for k in keys_for(items) if k != k1])
    return [_st(items, rest, k1), _st(items, [last], k2)]


def _pipe_rd_from_pd(rng, cfg, pd_sts, split_prob=0.5):
    """РД — спецификация по системам: одно упоминание на строку; иногда уточняет элементы (стояки, подводки)."""
    rd = []
    for st in pd_sts:
        for it in st["items"]:
            for el in st["elements"]:
                if it is None:
                    it2 = rng.choice(list(cfg["items"]))
                    rd.append(_st([it2], [el], st["key"]))
                    continue
                if el is None and rng.random() < split_prob:
                    els = cfg["item_els"][it]
                    for e in rng.sample(els, rng.randint(1, len(els))):
                        rd.append(_st([it], [e], st["key"]))
                else:
                    rd.append(_st([it], [el], st["key"]))
    # дубли (item, element, key) в спецификации не множим
    seen, out = set(), []
    for s in rd:
        k = (s["items"][0], s["elements"][0], s["key"])
        if k not in seen:
            seen.add(k)
            out.append(s)
    return out


def _pipe_render_pz(rng, cfg, sts, header=True) -> list[str]:
    lines = []
    if header:
        lines.append(
            rng.choice(
                [
                    f"Система {cfg['generic']}".upper(),
                    "Пояснительная записка",
                    f"Сети {cfg['generic']}. Материалы трубопроводов",
                ]
            )
        )
    for st in sts:
        lines += _wrap(rng, _pipe_sentence(rng, cfg, st))
    return lines


def _pipe_render_notes(rng, cfg, sts, reg="pz") -> list[str]:
    lines = [rng.choice(["Общие указания", "ОБЩИЕ УКАЗАНИЯ", "Указания по монтажу"])]
    n = 1
    for st in sts:
        n += rng.randint(0, 2)
        lines += _wrap(rng, f"{n}. {_pipe_sentence(rng, cfg, st, reg)}")
        n += 1
    return lines


def _pipe_render_pdspec(rng, cfg, sts) -> list[str]:
    sep = rng.choice(["|", " "])
    lines = [
        rng.choice(["Спецификация основных материалов", "Основные материалы"]),
        _row(rng, ["Поз.", "Наименование", "Система", "Ед. изм.", "Кол."], sep),
    ]
    for i, st in enumerate(sts, 1):
        name = _pipe_phrase(rng, cfg, st, "pz")
        name = name[:1].upper() + name[1:]
        sysn = ", ".join(x for x in st["items"] if x) or "—"
        lines.append(
            _row(rng, [str(i), name, sysn, "м", f"{rng.randint(40, 2400)}"], sep)
        )
    return lines


def _pipe_render_spec(rng, cfg, sts, traps=0) -> list[str]:
    """Спецификация по ГОСТ 21.110: разделы по системам, подразделы по элементам."""
    sep = rng.choice(["|", " "])
    lines = [
        _row(
            rng,
            [
                "Поз.",
                "Наименование и техническая характеристика",
                "Тип, марка, обозначение документа",
                "Код",
                "Завод-изготовитель",
                "Ед. изм.",
                "Кол.",
                "Масса ед., кг",
                "Примечание",
            ],
            sep,
        )
    ]
    groups: dict = {}
    for st in sts:
        groups.setdefault(st["items"][0], []).append(st)
    trap_list = list(cfg["traps_spec"])
    rng.shuffle(trap_list)
    order = list(groups)
    pos = 1
    for gi, it in enumerate(order):
        if it is not None:
            lines.append(rng.choice(cfg["items"][it][1]))
        by_el: dict = {}
        for st in groups[it]:
            by_el.setdefault(st["elements"][0], []).append(st)
        for el, lst in by_el.items():
            if el is not None:
                lines.append(rng.choice(cfg["els"][el][1]))
            for st in lst:
                an = st["or_analog"]
                st2 = dict(st, or_analog=False)
                name = _pipe_phrase(rng, cfg, st2, "spec")
                st["chars"] = st2["chars"]
                note = ""
                if an:
                    if rng.random() < 0.5:
                        name += _analog_word(rng)
                    else:
                        note = rng.choice(["или аналог", "или эквивалент"])
                cells = [
                    str(pos),
                    name,
                    cfg["voc"][st["key"]]["doc"],
                    "",
                    rng.choice(_MAKERS),
                    "м",
                    f"{rng.randint(6, 900)},0",
                    "",
                    note,
                ]
                row = _row(rng, cells, sep)
                if rng.random() < 0.15 and sep == "|":
                    cut = row.find(" ", len(str(pos)) + 3 + len(name) // 2)
                    if 0 < cut < len(str(pos)) + 3 + len(name):
                        lines += [row[:cut], row[cut + 1 :]]
                        pos += 1
                        continue
                lines.append(_nbsp(rng, row))
                pos += 1
        if gi < traps and trap_list:
            h, rows = trap_list.pop()
            lines.append(h)
            for r in rows:
                lines.append(
                    _row(
                        rng,
                        [
                            str(pos),
                            r,
                            "",
                            "",
                            "",
                            "м",
                            f"{rng.randint(5, 300)}",
                            "",
                            "",
                        ],
                        sep,
                    )
                )
                pos += 1
    return lines


def _pipe_pair(rng, param, mut):
    cfg = _PIPE[param]
    fam = cfg["fam"]
    scen = rng.choice(["all_none", "el_split", "per_item", "generic"])
    if mut == "NEG-DETAIL":
        scen = rng.choice(["generic", "all_none", "per_item"])
    pd = _pipe_pd(rng, cfg, scen)
    cls = scen
    rd = _pipe_rd_from_pd(rng, cfg, pd)
    pd_reg = rng.choice(["pz", "pz", "pdspec", "notes"])
    rd_fmt = rng.choice(["spec", "spec", "spec", "notes"])
    if mut == "MUT-07":
        strat = rng.choice(
            ["plain", "plain", "or_analog", "support_el"]
            if scen == "el_split"
            else ["plain", "plain", "or_analog"]
        )
        if strat == "support_el":
            other = pd[1]["key"]
            tgt = [s for s in rd if s["elements"][0] in pd[0]["elements"]]
            if not tgt:
                return None
            rng.choice(tgt)["key"] = other
            cls = "support_by_element"
        else:
            if strat == "or_analog":
                st0 = rng.choice(pd)
                st0["or_analog"] = True
                cand = [s for s in rd if s["key"] == st0["key"]]
            else:
                cand = rd
            if not cand:
                return None
            t = rng.choice(cand)
            t["key"] = rng.choice(
                [k for k in cfg["keys"][t["items"][0]] if k != t["key"]]
            )
            if strat == "or_analog":
                cls = "or_analog_worse"
            else:
                sup = _support(_pipe_expand([t])[0], _pipe_expand(pd))
                v = {verdict(fam, s["value"], t["key"]) for s in sup}
                cls = "subst_unknown" if v == {"UNKNOWN"} else "subst_not_equivalent"
    elif mut == "NEG-ANALOG":
        t = rng.choice(rd)
        sup = _support(_pipe_expand([t])[0], _pipe_expand(pd))
        eq = [
            k
            for k in cfg["keys"][t["items"][0]]
            if k != t["key"]
            and any(verdict(fam, s["value"], k) == "EQUIVALENT" for s in sup)
        ]
        if not eq:
            return None
        t["key"] = rng.choice(eq)
        cls = "analog_equivalent"
    elif mut == "NEG-CHARS":
        st0 = rng.choice(pd)
        st0["or_analog"] = True
        cand = [s for s in rd if s["key"] == st0["key"]]
        if not cand:
            return None
        t = rng.choice(cand)
        t["key"] = rng.choice(_not_worse_keys(fam, t["key"], cfg["keys"][t["items"][0]]))
        cls = "or_analog_not_worse"
    elif mut == "NEG-SPELL":
        for s in rd:
            s["respell"] = True
        rd_fmt = "notes_same"
        cls = "respell"
    elif mut == "NEG-SYN":
        rd_fmt = "notes_syn"
        cls = "other_wording"
    elif mut == "NEG-DETAIL":
        pd_reg = "short"
        rd = _pipe_rd_from_pd(rng, cfg, pd, split_prob=1.0)
        rd_fmt = "spec"
        cls = "rd_details_" + scen
    elif mut == "NEG-ORDER":
        rng.shuffle(rd)
        cls = "rd_order"
    elif mut == "NEG-MORE":
        if any(s["items"] == [None] for s in pd):
            return None
        used = {i for s in pd for i in s["items"]}
        free = [i for i in cfg["items"] if i not in used]
        if not free:
            return None
        it = rng.choice(free)
        rd.append(
            _st(
                [it],
                [rng.choice([None, *cfg["item_els"][it]])],
                rng.choice(cfg["keys"][it]),
            )
        )
        cls = "rd_item_without_pd_support"
    else:
        cls = "same_" + scen
    # ---- рендер ПД
    base = _base_code(rng)
    pd_lines = [
        f"Раздел 5. Подраздел {'2' if param == 'M-072' else '3'}. "
        f"{'Система водоснабжения' if param == 'M-072' else 'Система водоотведения'}"
    ]
    if pd_reg == "pdspec" and all(s["elements"] == [None] for s in pd):
        pd_lines += _pipe_render_pdspec(rng, cfg, pd)
    elif pd_reg == "notes":
        pd_lines += _pipe_render_notes(rng, cfg, pd)
    elif pd_reg == "short":
        for s in pd:
            X = _pipe_phrase(rng, cfg, s, "short")
            items = [i for i in s["items"] if i]
            who = (
                f"систем {', '.join(items)}"
                if items
                else f"внутренних сетей {cfg['generic']}"
            )
            pd_lines += _wrap(
                rng,
                rng.choice(
                    [
                        f"Трубопроводы {who} — {X}.",
                        f"Материал трубопроводов {who}: {X}.",
                    ]
                ),
            )
    else:
        pd_lines += _pipe_render_pz(rng, cfg, pd, header=False)
    pd_lines = _page_noise(
        rng,
        param,
        pd_lines,
        _cipher(rng, base, param, "П"),
        "П",
        traps=rng.randint(0, 2),
    )
    # ---- рендер РД
    if rd_fmt == "notes_same":
        for s in rd:
            src = [p for p in pd if p["key"] == s["key"] and p.get("vi") is not None]
            s["vi"] = src[0]["vi"] if src else None
        rd_lines = _pipe_render_notes(rng, cfg, rd, "pz")
    elif rd_fmt == "notes_syn":
        # те же ключи, другое написание: иной вариант той же записи справочника
        for s in rd:
            src = [p for p in pd if s["key"] == p["key"]]
            if src and src[0].get("vi") is not None:
                n = len(cfg["voc"][s["key"]]["pz"])
                s["vi"] = (src[0]["vi"] + 1 + rng.randrange(max(1, n - 1))) % n
        rd_lines = _pipe_render_notes(rng, cfg, rd, "pz")
    elif rd_fmt == "notes":
        rd_lines = _pipe_render_notes(rng, cfg, rd, "pz")
    else:
        rd_lines = _pipe_render_spec(rng, cfg, rd, traps=rng.randint(0, 2))
    rd_lines = _page_noise(
        rng, param, rd_lines, _cipher(rng, base, param, "Р"), "Р", traps=0
    )
    return pd_lines, rd_lines, _pipe_expand(pd), _pipe_expand(rd), cls


def _pipe_sample(rng, param):
    cfg = _PIPE[param]
    if rng.random() < 0.15:
        lines = [rng.choice(["Пояснительная записка", "Общие данные"])]
        lines += sum(
            (_wrap(rng, t) for t in rng.sample(cfg["traps_pz"], rng.randint(1, 3))), []
        )
        return _page_noise(
            rng,
            param,
            lines,
            _cipher(rng, _base_code(rng), param, rng.choice("ПР")),
            "П",
        ), []
    scen = rng.choice(["all_none", "el_split", "per_item", "generic"])
    sts = _pipe_pd(rng, cfg, scen)
    for s in sts:
        r = rng.random()
        if r < 0.15 and s["items"] != [None]:
            s["alts"] = [rng.choice([k for k in cfg["keys"][None] if k != s["key"]])]
        elif r < 0.3:
            s["or_analog"] = True
    fmt = rng.choice(["pz", "pz", "notes", "pdspec", "spec", "spec"])
    if fmt == "spec":
        sts = _pipe_rd_from_pd(rng, cfg, sts)
        for s in sts:
            s["or_analog"] = rng.random() < 0.15
        body = _pipe_render_spec(rng, cfg, sts, traps=rng.randint(0, 2))
        stage = "Р"
    elif fmt == "pdspec" and all(s["elements"] == [None] for s in sts):
        body = _pipe_render_pdspec(rng, cfg, sts)
        stage = "П"
    elif fmt == "notes":
        body = _pipe_render_notes(rng, cfg, sts)
        stage = rng.choice("ПР")
    else:
        body = _pipe_render_pz(rng, cfg, sts)
        stage = "П"
    lines = _page_noise(
        rng,
        param,
        body,
        _cipher(rng, _base_code(rng), param, stage),
        stage,
        traps=rng.randint(0, 2) if fmt != "spec" else 0,
    )
    return lines, _pipe_expand(sts)


# =========================================================================================== CMP-05: вентиляторы (M-079)

_FAN_SYS = {
    "П": "Приточная система",
    "В": "Вытяжная система",
    "ПВ": "Приточно-вытяжная установка",
    "ПД": "Система подпора воздуха",
}


def _fan_model(rng) -> str:
    return rng.choice(
        [
            lambda: (
                f"ВКП {rng.choice([40, 50, 60, 70])}-{rng.choice([20, 25, 30, 35])}-4D"
            ),
            lambda: f"ВР 80-75-{rng.choice(['2,5', '3,15', '4', '5', '6,3'])}",
            lambda: f"КЦ-{rng.choice([160, 200, 250, 315])}",
            lambda: f"ПВУ-{rng.choice([350, 600, 1000, 1500, 2500])}ЕС",
            lambda: f"АэроНорд АН-{rng.choice([800, 1200, 2000, 3500])}",
            lambda: f"Вент-М {rng.choice([500, 900, 1600])}Е",
            lambda: f"КВАРТ-{rng.choice([125, 160, 200])}С",
            lambda: f"ТВ-П {rng.choice([2, 3, 4, 6])}.{rng.choice([1, 2])}",
            lambda: (
                f"AirLine AL {rng.choice([250, 315, 400])}-{rng.choice(['A', 'B'])}"
            ),
            lambda: (
                f"Nordvent NV-{rng.choice([1100, 1800, 2600])}/{rng.choice(['E', 'W'])}"
            ),
            lambda: f"ВРАН 9-{rng.choice(['035', '040', '050', '063'])}",
            lambda: f"СКАТ ПУ-{rng.choice([3, 5, 8])}.{rng.choice([0, 5])}-Э",
        ]
    )()


def _fan_respell(rng, m: str) -> str:
    for _ in range(6):
        s = m
        tr = (
            str.maketrans("АВЕКМНОРСТУХ", "ABEKMHOPCTYX")
            if rng.random() < 0.5
            else str.maketrans("ABEKMHOPCTYX", "АВЕКМНОРСТУХ")
        )
        s = s.translate(tr)
        if rng.random() < 0.5:
            s = s.replace("-", " ", 1) if "-" in s else s.replace(" ", "-", 1)
        if rng.random() < 0.4:
            s = s.replace(",", ".")
        if rng.random() < 0.3:
            s = s.replace(" ", "")
        if s != m and fold_model(s) == fold_model(m):
            return s
    return m.replace(" ", "  ") if " " in m else m + " "


def _fan_systems(rng) -> list[str]:
    pat = rng.choice(
        [
            ["П1", "В1"],
            ["П1", "В1", "В2"],
            ["П1", "П2", "В1", "В2"],
            ["ПВ1", "ПВ2"],
            ["П1", "В1", "В2", "ПД1"],
            ["ПВ1", "В3", "В4"],
            ["П2", "В5"],
        ]
    )
    return list(pat)


def _fan_sts(rng) -> list[dict]:
    out, used = [], set()
    for s in _fan_systems(rng):
        m = _fan_model(rng)
        while fold_model(m) in used:
            m = _fan_model(rng)
        used.add(fold_model(m))
        L = rng.choice([450, 800, 1200, 1650, 2500, 3200, 4800, 6300])
        P = rng.choice([150, 200, 250, 300, 350, 450, 600])
        out.append(
            {
                "sys": s,
                "model": m,
                "L": L,
                "P": P,
                "N": rng.choice(["0,37", "0,55", "0,75", "1,1", "2,2"]),
                "or_analog": False,
                "show": rng.random() < 0.7,
            }
        )
    return out


def _fan_kind(sys: str) -> str:
    pref = re.match(r"[А-Я]+", sys).group(0)
    return _FAN_SYS.get(pref, "Система")


def _fan_render(rng, sts, fmt) -> list[str]:
    lines = []
    sep = rng.choice(["|", " "])
    if fmt == "pz":
        lines.append(
            rng.choice(
                ["Характеристика систем вентиляции", "Вентиляция", "4.3. Вентиляция"]
            )
        )
        for st in sts:
            w = "установка" if st["sys"].startswith(("П", "ПВ")) else "вентилятор"
            txt = f"{_fan_kind(st['sys'])} {st['sys']} — {w} {st['model']}"
            if st["show"]:
                txt += rng.choice(
                    [
                        f" (L = {st['L']} м³/ч, Pсв = {st['P']} Па, N = {st['N']} кВт)",
                        f", производительностью {st['L']} м³/ч при давлении {st['P']} Па",
                    ]
                )
            if st["or_analog"]:
                txt += _analog_word(rng)
            lines += _wrap(rng, txt + ".")
    elif fmt == "table":
        lines.append(
            rng.choice(
                ["Таблица характеристик вентиляционных систем", "Характеристика систем"]
            )
        )
        lines.append(
            _row(
                rng,
                [
                    "Обозначение системы",
                    "Обслуживаемые помещения",
                    "Тип установки",
                    "L, м³/ч",
                    "Pсв, Па",
                    "N, кВт",
                    "Примечание",
                ],
                sep,
            )
        )
        for st in sts:
            zone = rng.choice(
                [
                    "жилая часть",
                    "автостоянка",
                    "офисы 1 эт.",
                    "санузлы",
                    "ИТП",
                    "лестнично-лифтовой узел",
                ]
            )
            lines.append(
                _row(
                    rng,
                    [
                        st["sys"],
                        zone,
                        st["model"],
                        str(st["L"]) if st["show"] else "",
                        str(st["P"]) if st["show"] else "",
                        st["N"],
                        "или аналог" if st["or_analog"] else "",
                    ],
                    sep,
                )
            )
    else:  # spec ОВ
        lines.append(
            _row(
                rng,
                [
                    "Поз.",
                    "Наименование и техническая характеристика",
                    "Тип, марка",
                    "Код",
                    "Завод-изготовитель",
                    "Ед.",
                    "Кол.",
                    "Примечание",
                ],
                sep,
            )
        )
        for st in sts:
            lines.append(
                rng.choice(
                    [
                        f"Система {st['sys']}",
                        f"{st['sys']}",
                        f"{_fan_kind(st['sys'])} {st['sys']}",
                    ]
                )
            )
            w = (
                "Установка приточная"
                if st["sys"].startswith("П") and not st["sys"].startswith("ПД")
                else "Вентилятор радиальный"
            )
            ch = (
                f"L={st['L']} м³/ч; Pсв={st['P']} Па; N={st['N']} кВт"
                if st["show"]
                else f"N={st['N']} кВт"
            )
            lines.append(
                _nbsp(
                    rng,
                    _row(
                        rng,
                        [
                            f"{st['sys']}.1",
                            f"{w} {st['model']}, {ch}",
                            "",
                            "",
                            rng.choice(_MAKERS),
                            "шт.",
                            "1",
                            "или аналог" if st["or_analog"] else "",
                        ],
                        sep,
                    ),
                )
            )
            for k in range(rng.randint(0, 2)):
                acc = rng.choice(
                    [
                        f"Клапан воздушный КВУ {rng.choice(['500×300', '400×200', '600×350'])}",
                        f"Шумоглушитель ГТК 2-{rng.choice([1, 2, 3])}",
                        "Гибкая вставка ВГ 500×300",
                        "Фильтр карманный F7 592×592",
                    ]
                )
                lines.append(
                    _row(
                        rng,
                        [f"{st['sys']}.{k + 2}", acc, "", "", "", "шт.", "1", ""],
                        sep,
                    )
                )
    return lines


_FAN_TRAPS = [
    "Существующий вытяжной вентилятор ВР 86-77-4 на кровле демонтируется.",
    "Допускается применение оборудования других производителей с характеристиками не ниже указанных.",
    "Вентиляция соседнего корпуса 2 (установка ПВУ-3500 ЕС) проектом не затрагивается.",
    "Кондиционирование серверной — сплит-системой, см. раздел ХС.",
    "Удаление воздуха из квартир — естественное, через вентблоки (системы ВЕ1–ВЕ12).",
]


def _fan_expand(sts) -> list[dict]:
    out = []
    for st in sts:
        ch = {"flow": st["L"], "pressure": st["P"]} if st["show"] else {}
        out.append(
            {
                "item": st["sys"],
                "element": None,
                "value": st["model"],
                "alts": [],
                "or_analog": st["or_analog"],
                "chars": ch,
            }
        )
    return out


def _fan_pair(rng, param, mut):
    pd = _fan_sts(rng)
    rd = copy.deepcopy(pd)
    for s in rd:
        s["show"] = s["show"] or rng.random() < 0.6
    cls = "same"
    if mut == "MUT-07":
        t = rng.choice(rd)
        i = rd.index(t)
        if rng.random() < 0.4:
            pd[i]["or_analog"] = True
            pd[i]["show"] = t["show"] = True
            if rng.random() < 0.5:
                t["L"] = int(t["L"] * rng.choice([0.8, 0.85, 0.9]))
                cls = "or_analog_flow_lower"
            else:
                t["P"] = int(t["P"] * rng.choice([0.7, 0.8, 0.9]))
                cls = "or_analog_pressure_lower"
        else:
            cls = "model_changed_same_chars" if rng.random() < 0.5 else "model_changed"
            if cls == "model_changed":
                t["L"] = int(t["L"] * rng.choice([0.9, 1.0, 1.1]))
        new = _fan_model(rng)
        while fold_model(new) == fold_model(t["model"]):
            new = _fan_model(rng)
        t["model"] = new
    elif mut == "NEG-SPELL":
        for s in rd:
            s["model"] = _fan_respell(rng, s["model"])
        cls = "model_respelled"
    elif mut == "NEG-CHARS":
        t = rng.choice(rd)
        i = rd.index(t)
        pd[i]["or_analog"] = True
        pd[i]["show"] = t["show"] = True
        t["L"] = int(t["L"] * rng.choice([1.0, 1.05, 1.2]))
        t["P"] = int(t["P"] * rng.choice([1.0, 1.1]))
        new = _fan_model(rng)
        while fold_model(new) == fold_model(t["model"]):
            new = _fan_model(rng)
        t["model"] = new
        cls = "or_analog_not_worse"
    elif mut == "NEG-ORDER":
        rng.shuffle(rd)
        cls = "systems_reordered"
    elif mut == "NEG-DETAIL":
        for s in pd:
            s["show"] = False
        for s in rd:
            s["show"] = True
        cls = "rd_adds_parameters"
    elif mut == "NEG-MORE":
        used = {s["sys"] for s in pd}
        extra = rng.choice(
            [x for x in ["П3", "В6", "В7", "ПД2", "ПВ3"] if x not in used]
        )
        rd.append(
            {
                "sys": extra,
                "model": _fan_model(rng),
                "L": 900,
                "P": 250,
                "N": "0,55",
                "or_analog": False,
                "show": True,
            }
        )
        cls = "rd_new_system_without_pd"
    elif mut in ("NEG-SYN", "NEG-ANALOG"):
        return None  # у открытой марки нет синонимов и таблицы аналогов
    base = _base_code(rng)
    pd_lines = _page_noise(
        rng,
        param,
        _fan_render(rng, pd, rng.choice(["pz", "table"])),
        _cipher(rng, base, param, "П"),
        "П",
        traps=rng.randint(0, 2),
    )
    rd_lines = _page_noise(
        rng,
        param,
        _fan_render(rng, rd, rng.choice(["spec", "spec", "table"])),
        _cipher(rng, base, param, "Р"),
        "Р",
        traps=rng.randint(0, 1),
    )
    return pd_lines, rd_lines, _fan_expand(pd), _fan_expand(rd), cls


def _fan_sample(rng, param):
    if rng.random() < 0.15:
        lines = _wrap(rng, " ".join(rng.sample(_FAN_TRAPS, 3)))
        return _page_noise(
            rng, param, lines, _cipher(rng, _base_code(rng), param, "П"), "П"
        ), []
    sts = _fan_sts(rng)
    for s in sts:
        if rng.random() < 0.2:
            s["or_analog"] = True
        if rng.random() < 0.25:
            s["model"] = _fan_respell(rng, s["model"])
    fmt = rng.choice(["pz", "table", "spec"])
    lines = _page_noise(
        rng,
        param,
        _fan_render(rng, sts, fmt),
        _cipher(rng, _base_code(rng), param, "Р" if fmt == "spec" else "П"),
        "Р" if fmt == "spec" else "П",
        traps=rng.randint(0, 2),
    )
    return lines, _fan_expand(sts)


# ============================================================================================= CMP-05: отделка (M-050)

_V050 = {
    "PAINT_WD": [
        "окраска водно-дисперсионной краской",
        "окраска ВД-АК краской за 2 раза",
        "покраска водоэмульсионной краской",
        "шпатлёвка, окраска водно-дисперсионной акриловой краской",
    ],
    "PLASTER_MINERAL": [
        "штукатурка цементно-песчаная",
        "гипсовая штукатурка",
        "улучшенная штукатурка цементным раствором",
    ],
    "DECOR_PLASTER": ["декоративная штукатурка «короед»", "декоративная штукатурка"],
    "CERAMIC_TILE": [
        "облицовка керамической плиткой",
        "плитка керамическая глазурованная 200×300",
        "керамическая плитка на клею",
    ],
    "PORCELAIN": [
        "керамогранит 600×600",
        "керамогранитная плитка",
        "плиты керамогранитные неглазурованные 300×300",
    ],
    "WALLPAPER_VINYL": ["обои виниловые", "виниловые обои на флизелиновой основе"],
    "WALLPAPER_GLASS": ["стеклообои под окраску", "стеклотканевые обои с окраской"],
    "PVC_PANEL": ["панели ПВХ", "облицовка пластиковыми панелями (ПВХ)"],
    "MDF_PANEL": ["панели МДФ", "стеновые панели МДФ с ламинированным покрытием"],
    "GKL": [
        "облицовка гипсокартонными листами",
        "подвесной потолок из гипсокартона",
        "ГКЛ по металлокаркасу",
    ],
    "LINOLEUM_COMM": ["линолеум коммерческий гетерогенный", "линолеум коммерческий"],
    "LINOLEUM_HOUSE": [
        "линолеум бытовой",
        "линолеум бытовой на теплоизолирующей подоснове",
    ],
    "LAMINATE": ["ламинат 33 класса", "ламинированная доска"],
    "CARPET": ["ковровое покрытие", "ковролин"],
    "EPOXY": ["наливной полимерный пол", "эпоксидный наливной пол"],
    "ARMSTRONG": [
        "подвесной потолок типа «Армстронг»",
        "потолок подвесной из минераловатных плит 600×600",
        "потолок Армстронг",
    ],
    "STRETCH_PVC": ["натяжной потолок ПВХ", "натяжной потолок (плёнка ПВХ)"],
    "RACK_AL": ["реечный алюминиевый потолок", "потолок реечный алюминиевый"],
}
_V050_SHORT = {
    "PAINT_WD": "окраска ВД",
    "CERAMIC_TILE": "плитка",
    "PORCELAIN": "керамогранит",
    "LINOLEUM_COMM": "линолеум коммерческий",
    "ARMSTRONG": "подвесной потолок «Армстронг»",
    "GKL": "ГКЛ",
    "PLASTER_MINERAL": "штукатурка",
    "RACK_AL": "реечный потолок",
}
_V050_DET = {
    "PAINT_WD": "шпатлёвка, окраска водно-дисперсионной краской «Интерьер-Люкс» (КМ1) за 2 раза",
    "CERAMIC_TILE": "плитка керамическая глазурованная 250×400 на клею С1, затирка швов",
    "PORCELAIN": "керамогранит 600×600×10 неглазурованный, противоскользящий, R10",
    "LINOLEUM_COMM": "линолеум коммерческий гетерогенный, толщиной 2,0 мм, класс 34/43 (КМ2)",
    "ARMSTRONG": "подвесной потолок типа «Армстронг», плиты 600×600×12 на подвесной системе Т24",
    "GKL": "ГКЛ по металлокаркасу, шпатлёвка",
    "PLASTER_MINERAL": "штукатурка гипсовая машинного нанесения 15 мм",
    "RACK_AL": "реечный алюминиевый потолок, рейка 100 мм, белая",
}
_KM_TEXT = {
    "PAINT_WD": "КМ1",
    "CERAMIC_TILE": "КМ0",
    "PORCELAIN": "КМ0",
    "LINOLEUM_COMM": "КМ2",
    "GKL": "КМ1",
    "ARMSTRONG": "КМ1",
    "RACK_AL": "КМ0",
    "PLASTER_MINERAL": "КМ0",
    "LAMINATE": "КМ4",
    "WALLPAPER_GLASS": "КМ2",
    "EPOXY": "КМ2",
    "DECOR_PLASTER": "КМ1",
}
_EL_KEYS = {
    "wall": [
        "PAINT_WD",
        "PLASTER_MINERAL",
        "DECOR_PLASTER",
        "CERAMIC_TILE",
        "PORCELAIN",
        "WALLPAPER_VINYL",
        "WALLPAPER_GLASS",
        "PVC_PANEL",
        "MDF_PANEL",
        "GKL",
    ],
    "floor": [
        "CERAMIC_TILE",
        "PORCELAIN",
        "LINOLEUM_COMM",
        "LINOLEUM_HOUSE",
        "LAMINATE",
        "CARPET",
        "EPOXY",
    ],
    "ceiling": ["PAINT_WD", "GKL", "ARMSTRONG", "STRETCH_PVC", "RACK_AL"],
}
_ROOM_GROUPS = [
    (
        "Помещения общего пользования (вестибюль, коридоры, лифтовые холлы)",
        ["Вестибюль", "Коридор", "Лифтовой холл"],
        {
            "wall": ["PAINT_WD", "DECOR_PLASTER", "PORCELAIN"],
            "floor": ["PORCELAIN", "CERAMIC_TILE", "LINOLEUM_COMM"],
            "ceiling": ["ARMSTRONG", "GKL", "PAINT_WD", "RACK_AL"],
        },
    ),
    (
        "Лестничные клетки",
        ["Лестничная клетка Л1", "Лестничная клетка Л2"],
        {
            "wall": ["PAINT_WD", "PLASTER_MINERAL"],
            "floor": ["CERAMIC_TILE", "PORCELAIN"],
            "ceiling": ["PAINT_WD"],
        },
    ),
    (
        "Санузлы и душевые",
        ["Санузел", "Душевая", "ПУИ"],
        {
            "wall": ["CERAMIC_TILE", "PORCELAIN"],
            "floor": ["CERAMIC_TILE", "PORCELAIN"],
            "ceiling": ["RACK_AL", "PAINT_WD"],
        },
    ),
    (
        "Кабинеты и учебные классы",
        ["Кабинет", "Учебный класс", "Учительская"],
        {
            "wall": ["PAINT_WD", "WALLPAPER_GLASS"],
            "floor": ["LINOLEUM_COMM", "LAMINATE"],
            "ceiling": ["ARMSTRONG", "GKL"],
        },
    ),
    (
        "Технические помещения (ИТП, электрощитовая, насосная)",
        ["ИТП", "Электрощитовая", "Насосная"],
        {
            "wall": ["PAINT_WD", "PLASTER_MINERAL"],
            "floor": ["EPOXY", "CERAMIC_TILE"],
            "ceiling": ["PAINT_WD"],
        },
    ),
]
_EL_RU = {
    "wall": ("стены", "Стены"),
    "floor": ("полы", "Пол"),
    "ceiling": ("потолки", "Потолок"),
}
_FIN_TRAPS = [
    "Запрещается применение на путях эвакуации материалов с пожарной опасностью выше КМ2 "
    "(обои виниловые, панели ПВХ, ковровые покрытия).",
    "Допускается применение отделочных материалов класса не ниже КМ2 по согласованию с заказчиком.",
    "Отделка фасада: облицовка керамогранитом по навесной фасадной системе (см. раздел АР, лист 12).",
    "Существующая облицовка стен кафелем в помещениях подвала демонтируется.",
    "Отделка помещений арендаторов выполняется силами арендаторов по отдельному проекту.",
    "Отделка соседнего корпуса 1 не входит в объём проекта.",
]


def _fin_phrase(rng, key, reg, km_text=False, respell=False, vi=None):
    if reg == "short" and key in _V050_SHORT:
        t = _V050_SHORT[key]
    elif reg == "det" and key in _V050_DET:
        t = _V050_DET[key]
    else:
        vs = _V050[key]
        t = vs[vi % len(vs)] if vi is not None else rng.choice(vs)
    ch = {}
    if km_text and key in _KM_TEXT and "КМ" not in t:
        t += f" ({_KM_TEXT[key]})"
    if "КМ" in t:
        ch["km"] = re.search(r"КМ\d", t).group(0)
    if respell:
        t = _spell(rng, t)
    return t, ch


def _fin_pd(rng):
    groups = rng.sample(_ROOM_GROUPS, rng.randint(1, 3))
    out = []
    for title, rooms, opts in groups:
        els = {
            e: {"key": rng.choice(opts[e]), "or_analog": False}
            for e in rng.sample(list(opts), rng.randint(2, 3))
        }
        out.append({"title": title, "rooms": list(rooms), "els": els})
    return out


def _fin_expand(groups, per_room=False) -> list[dict]:
    out = []
    for g in groups:
        for e, v in g["els"].items():
            reps = g["rooms"] if per_room else [None]
            for r in reps:
                vv = v if not per_room else g.get("room_els", {}).get(r, {}).get(e, v)
                out.append(
                    {
                        "item": None,
                        "element": e,
                        "value": vv["key"],
                        "alts": [],
                        "or_analog": vv["or_analog"],
                        "chars": dict(vv.get("chars", {})),
                    }
                )
    return out


def _fin_render_pz(rng, groups, reg="pz", respell=False) -> list[str]:
    lines = [
        rng.choice(
            ["Внутренняя отделка помещений", "Отделка помещений", "3.6. Отделка"]
        )
    ]
    for g in groups:
        parts = []
        for e, v in g["els"].items():
            t, ch = _fin_phrase(
                rng,
                v["key"],
                reg,
                km_text=rng.random() < 0.3,
                respell=respell,
                vi=v.get("vi"),
            )
            v["chars"] = ch
            if v["or_analog"]:
                t += _analog_word(rng)
            parts.append(f"{_EL_RU[e][0]} — {t}")
        lines += _wrap(rng, f"{g['title']}: {'; '.join(parts)}.")
    return lines


def _fin_render_table(rng, groups, reg="pz", respell=False) -> list[str]:
    """Ведомость отделки помещений по ГОСТ 21.501: строка — помещение."""
    sep = rng.choice(["|", " "])
    lines = [
        rng.choice(["Ведомость отделки помещений", "ВЕДОМОСТЬ ОТДЕЛКИ ПОМЕЩЕНИЙ"]),
        _row(
            rng,
            [
                "Наименование или номер помещения",
                "Потолок",
                "Площадь, м²",
                "Стены или перегородки",
                "Площадь, м²",
                "Пол",
                "Площадь, м²",
                "Примечание",
            ],
            sep,
        ),
    ]
    for g in groups:
        for r in g["rooms"]:
            re_ = g.setdefault("room_els", {}).setdefault(r, {})
            cells = [f"{r} ({rng.randint(101, 420)})"]
            for e in ("ceiling", "wall", "floor"):
                v = re_.get(e) or g["els"].get(e)
                if v is None:
                    cells += ["—", ""]
                    continue
                t, ch = _fin_phrase(
                    rng,
                    v["key"],
                    reg,
                    km_text=rng.random() < 0.2,
                    respell=respell,
                    vi=v.get("vi"),
                )
                if v["or_analog"]:
                    t += _analog_word(rng)
                v2 = dict(v, chars=ch)
                re_[e] = v2
                cells += [t, f"{rng.randint(4, 180)},{rng.randint(0, 9)}"]
            cells.append("")
            lines.append(_nbsp(rng, _row(rng, cells, sep)))
    return lines


def _fin_table_expand(groups) -> list[dict]:
    out = []
    for g in groups:
        for r in g["rooms"]:
            for e, v in g.get("room_els", {}).get(r, {}).items():
                out.append(
                    {
                        "item": None,
                        "element": e,
                        "value": v["key"],
                        "alts": [],
                        "or_analog": v["or_analog"],
                        "chars": dict(v.get("chars", {})),
                    }
                )
    return out


def _fin_pair(rng, param, mut):
    pd = _fin_pd(rng)
    rd = copy.deepcopy(pd)
    cls = "same"
    pd_reg, rd_reg, rd_respell = "pz", "pz", False

    # РД — ведомость по помещениям; ключи помещения берутся из группы, мутация — в одном помещении
    def room_override(new_key, e=None):
        g = rng.choice(rd)
        e = e or rng.choice(list(g["els"]))
        r = rng.choice(g["rooms"])
        g.setdefault("room_els", {}).setdefault(r, {})[e] = {
            "key": new_key(g["els"][e]["key"], e),
            "or_analog": False,
        }
        return g, e, r

    if mut == "MUT-07":
        if len(pd) == 1 and rng.random() < 0.4:
            e = rng.choice(list(pd[0]["els"]))
            pd[0]["els"][e]["or_analog"] = True
            room_override(
                lambda k, e_: rng.choice([x for x in _EL_KEYS[e_] if x != k]), e
            )
            cls = "or_analog_worse_km"
        else:
            room_override(
                lambda k, e_: rng.choice(
                    [
                        x
                        for x in _EL_KEYS[e_]
                        if x != k and verdict("finish", k, x) != "EQUIVALENT"
                    ]
                )
            )
            cls = "subst_worse_km"
    elif mut == "NEG-ANALOG":

        def eq(k, e_):
            c = [
                x
                for x in _EL_KEYS[e_]
                if x != k and verdict("finish", k, x) == "EQUIVALENT"
            ]
            return rng.choice(c) if c else k

        room_override(eq)
        cls = "analog_km_not_worse"
    elif mut == "NEG-CHARS":
        if len(pd) != 1:
            pd = pd[:1]
            rd = copy.deepcopy(pd)
        e = rng.choice(list(pd[0]["els"]))
        pd[0]["els"][e]["or_analog"] = True
        room_override(lambda k, e_: rng.choice(_not_worse_keys("finish", k, _EL_KEYS[e_])), e)
        cls = "or_analog_not_worse_km"
    elif mut == "NEG-SPELL":
        for g in pd:
            for v in g["els"].values():
                v["vi"] = rng.randrange(8)
        for g, g2 in zip(pd, rd):
            for e in g["els"]:
                g2["els"][e]["vi"] = g["els"][e]["vi"]
        rd_respell = True
        cls = "respell"
    elif mut == "NEG-SYN":
        for g in pd:
            for v in g["els"].values():
                v["vi"] = rng.randrange(8)
        for g, g2 in zip(pd, rd):
            for e in g["els"]:
                g2["els"][e]["vi"] = g["els"][e]["vi"] + 1
        cls = "other_wording"
    elif mut == "NEG-DETAIL":
        pd_reg, rd_reg = "short", "det"
        cls = "rd_details"
    elif mut == "NEG-ORDER":
        rd.reverse()
        for g in rd:
            g["rooms"].reverse()
        cls = "rooms_reordered"
    elif mut == "NEG-MORE":
        g = rng.choice(rd)
        g["rooms"].append(
            rng.choice(["Коридор 2", "Холл 2-го этажа", "Тамбур", "Кладовая"])
        )
        cls = "rd_more_rooms"
    base = _base_code(rng)
    pd_body = _fin_render_pz(rng, pd, pd_reg) if rng.random() < 0.7 else None
    if pd_body is None:
        pd_body = _fin_render_table(rng, pd, pd_reg)
        pd_ms = _fin_table_expand(pd)
    else:
        pd_ms = _fin_expand(pd)
    rd_body = _fin_render_table(rng, rd, rd_reg, respell=rd_respell)
    pd_lines = _page_noise(
        rng,
        param,
        pd_body,
        _cipher(rng, base, param, "П"),
        "П",
        traps=rng.randint(0, 2),
    )
    rd_lines = _page_noise(
        rng,
        param,
        rd_body,
        _cipher(rng, base, param, "Р"),
        "Р",
        traps=rng.randint(0, 1),
    )
    return pd_lines, rd_lines, pd_ms, _fin_table_expand(rd), cls


def _fin_sample(rng, param):
    if rng.random() < 0.15:
        lines = sum((_wrap(rng, t) for t in rng.sample(_FIN_TRAPS, 3)), [])
        return _page_noise(
            rng, param, lines, _cipher(rng, _base_code(rng), param, "П"), "П"
        ), []
    groups = _fin_pd(rng)
    for g in groups:
        for v in g["els"].values():
            v["or_analog"] = rng.random() < 0.12
    if rng.random() < 0.5:
        body, ms = _fin_render_pz(rng, groups), None
        ms = _fin_expand(groups)
    else:
        body = _fin_render_table(rng, groups)
        ms = _fin_table_expand(groups)
    return _page_noise(
        rng,
        param,
        body,
        _cipher(rng, _base_code(rng), param, "П"),
        "П",
        traps=rng.randint(0, 2),
    ), ms


# =========================================================================================== CMP-05: светильники (M-130)

_V130 = {
    "LED": {
        "pz": [
            "светодиодные светильники",
            "светильники со светодиодными источниками света",
            "LED-светильники",
            "светодиодные светильники со световой отдачей не менее {eff} лм/Вт",
        ],
        "spec": [
            ("Светильник светодиодный ДПО{a}-{wt}-{c} {wt} Вт IP{ip}", {}),
            (
                "Светильник LED-панель 595×595 {wt} Вт 4000 К, {eff} лм/Вт",
                {"efficacy": "eff"},
            ),
            (
                "Светильник ДВО {a}-{wt}-{c} (светодиодный), {wt} Вт, срок службы {life_s} ч",
                {"life": "life"},
            ),
            ("Светильник светодиодный уличный ДКУ {a}-{wt}", {}),
            ("Светильник ДСП {a}-{wt}-{c} IP65", {}),
        ],
    },
    "FLUOR": {
        "pz": [
            "светильники с люминесцентными лампами",
            "люминесцентные светильники ЛПО",
            "светильники с линейными люминесцентными лампами T8",
        ],
        "spec": [
            ("Светильник ЛПО {a}-2×36-{c} с ЭПРА", {}),
            ("Светильник люминесцентный ЛСП {a}-2×58 IP65", {}),
            ("Светильник ЛВО 4×18 встраиваемый", {}),
        ],
    },
    "CFL": {
        "pz": ["светильники с компактными люминесцентными лампами"],
        "spec": [
            ("Светильник НББ {a}-18 с КЛЛ 18 Вт", {}),
            ("Светильник ФБО {a}-2×18 (КЛЛ)", {}),
        ],
    },
    "INCAND": {
        "pz": ["светильники с лампами накаливания"],
        "spec": [
            ("Светильник НПП {a}-100 IP54", {}),
            ("Светильник НББ 64-60 с лампой накаливания 60 Вт", {}),
        ],
    },
    "HALOGEN": {
        "pz": ["галогенные светильники"],
        "spec": [
            ("Прожектор галогенный ИО {a}-500", {}),
            ("Светильник встраиваемый с галогенной лампой MR16 50 Вт", {}),
        ],
    },
    "DRL": {
        "pz": ["светильники с лампами ДРЛ"],
        "spec": [
            ("Светильник РСП {a}-250 с лампой ДРЛ-250", {}),
            ("Светильник РКУ {a}-125 (ДРЛ)", {}),
        ],
    },
    "HPS": {
        "pz": ["светильники с натриевыми лампами ДНаТ"],
        "spec": [
            ("Светильник ЖКУ {a}-150 с лампой ДНаТ", {}),
            ("Светильник ЖСП {a}-250 (ДНаТ)", {}),
        ],
    },
    "MH": {
        "pz": ["светильники с металлогалогенными лампами"],
        "spec": [
            ("Светильник ГСП {a}-400 с лампой ДРИ", {}),
            ("Прожектор ГО {a}-150 (МГЛ)", {}),
        ],
    },
}
_LUM_ZONES = {
    "LED": [
        "рабочего освещения помещений",
        "освещения квартир и мест общего пользования",
        "освещения лестничных клеток",
        "наружного освещения территории",
    ],
    "FLUOR": ["освещения технических помещений", "рабочего освещения классов"],
    "CFL": ["освещения кладовых"],
    "INCAND": ["освещения подвала"],
    "HALOGEN": ["подсветки фасада"],
    "DRL": ["освещения автостоянки"],
    "HPS": ["наружного освещения проездов"],
    "MH": ["освещения спортивного зала"],
}
_LUM_TRAPS = [
    "Существующие светильники с лампами ДРЛ на фасаде демонтируются.",
    "Запрещается применение ламп накаливания мощностью 100 Вт и более для целей освещения (261-ФЗ).",
    "Освещение соседнего здания (корп. 1) выполнено светильниками ЛПО — проектом не затрагивается.",
    "Допускается замена светильников на аналогичные по светотехническим характеристикам.",
]
_LUM_TRAP_ROWS = [
    "Светильник аварийного освещения «ВЫХОД» 3 Вт, 1 ч, IP20",
    "Светильник накладной 600×600 IP40, 36 Вт",
    "Светильник пылевлагозащищённый IP65, 2×18 Вт",
    "Выключатель одноклавишный 10 А",
]


def _lum_expand(sts) -> list[dict]:
    return [
        {
            "item": None,
            "element": None,
            "value": s["key"],
            "alts": [],
            "or_analog": s["or_analog"],
            "chars": dict(s.get("chars", {})),
        }
        for s in sts
    ]


def _lum_render_pz(rng, sts, reg="pz", respell=False) -> list[str]:
    lines = [
        rng.choice(
            ["Электроосвещение", "5.4. Освещение", "Рабочее и аварийное освещение"]
        )
    ]
    for s in sts:
        vs = _V130[s["key"]]["pz"]
        vi = s.get("vi")
        t = vs[vi % len(vs)] if vi is not None else rng.choice(vs)
        if reg == "short":
            t = vs[0]
        dm = _dims(rng)
        ch = {"efficacy": dm["eff"]} if "{eff}" in t else {}
        t = t.format(**dm)
        if s["or_analog"]:
            t += _analog_word(rng)
        if respell:
            t = _spell(rng, t)
        s["chars"] = ch
        zone = s.get("zone") or rng.choice(_LUM_ZONES[s["key"]])
        s["zone"] = zone
        lines += _wrap(
            rng,
            rng.choice(
                [
                    f"Для {zone} приняты {t}.",
                    f"В качестве источников света для {zone} предусмотрены {t}.",
                    f"Светильники {zone} — {t}.",
                ]
            ),
        )
    return lines


def _lum_render_spec(rng, rows, traps=0) -> list[str]:
    sep = rng.choice(["|", " "])
    lines = [
        _row(
            rng,
            [
                "Поз.",
                "Наименование и техническая характеристика",
                "Тип, марка",
                "Код",
                "Завод-изготовитель",
                "Ед.",
                "Кол.",
                "Масса",
                "Примечание",
            ],
            sep,
        )
    ]
    pos = 1
    trap_rows = rng.sample(_LUM_TRAP_ROWS, min(traps, len(_LUM_TRAP_ROWS)))
    for r in rows:
        name, ch = _render(rng, rng.choice(_V130[r["key"]]["spec"]), r.get("over"))
        r["chars"] = ch
        note = ""
        if r["or_analog"]:
            if rng.random() < 0.5:
                name += _analog_word(rng)
            else:
                note = "или аналог"
        lines.append(
            _nbsp(
                rng,
                _row(
                    rng,
                    [
                        str(pos),
                        name,
                        "",
                        "",
                        rng.choice(_MAKERS),
                        "шт.",
                        str(rng.randint(2, 180)),
                        "",
                        note,
                    ],
                    sep,
                ),
            )
        )
        pos += 1
        if trap_rows and rng.random() < 0.5:
            lines.append(
                _row(
                    rng,
                    [
                        str(pos),
                        trap_rows.pop(),
                        "",
                        "",
                        "",
                        "шт.",
                        str(rng.randint(2, 40)),
                        "",
                        "",
                    ],
                    sep,
                )
            )
            pos += 1
    for t in trap_rows:
        lines.append(
            _row(
                rng,
                [str(pos), t, "", "", "", "шт.", str(rng.randint(2, 40)), "", ""],
                sep,
            )
        )
        pos += 1
    return lines


def _lum_pd(rng):
    keys = ["LED"] + rng.sample(
        ["FLUOR", "HPS", "DRL", "CFL", "MH", "INCAND", "HALOGEN"], rng.randint(0, 2)
    )
    if rng.random() < 0.25:
        keys = [rng.choice(["FLUOR", "HPS", "DRL", "INCAND", "CFL", "MH"])]
    return [{"key": k, "or_analog": False} for k in keys]


def _lum_rows(rng, pd):
    rows = []
    for s in pd:
        for _ in range(rng.randint(1, 3)):
            rows.append({"key": s["key"], "or_analog": False})
    rng.shuffle(rows)
    return rows


def _lum_pair(rng, param, mut):
    pd = _lum_pd(rng)
    rd = _lum_rows(rng, pd)
    cls = "same"
    pd_reg, rd_fmt = "pz", "spec"
    keys = list(_V130)
    if mut == "MUT-07":
        if len(pd) == 1 and rng.random() < 0.4:
            pd[0]["or_analog"] = True
            cls = "or_analog_worse"
        else:
            cls = "subst_lower_efficacy"
        t = rng.choice(rd)
        t["key"] = rng.choice([k for k in keys if k != t["key"]])
    elif mut == "NEG-ANALOG":
        t = rng.choice(rd)
        c = [
            k
            for k in keys
            if k != t["key"]
            and any(verdict("luminaire", s["key"], k) == "EQUIVALENT" for s in pd)
        ]
        if not c:
            return None
        t["key"] = rng.choice(c)
        cls = "analog_better_source"
    elif mut == "NEG-CHARS":
        pd = [{"key": rng.choice(["FLUOR", "CFL", "DRL", "HPS", "MH", "INCAND", "HALOGEN"]), "or_analog": False}]
        rd = _lum_rows(rng, pd)
        pd[0]["or_analog"] = True
        t = rng.choice(rd)
        t["key"] = rng.choice(_not_worse_keys("luminaire", t["key"], keys))
        cls = "or_analog_not_worse"
    elif mut == "NEG-SPELL":
        for s in pd:
            s["vi"] = rng.randrange(4)
        rd = copy.deepcopy(pd)
        for s in rd:
            s["zone"] = None
        rd_fmt = "pz_respell"
        cls = "respell"
    elif mut == "NEG-SYN":
        for s in pd:
            s["vi"] = rng.randrange(4)
        rd = [dict(s, vi=s["vi"] + 1, zone=None) for s in pd]
        rd_fmt = "pz"
        cls = "other_wording"
    elif mut == "NEG-DETAIL":
        pd_reg = "short"
        for r in rd:
            if r["key"] == "LED":
                r["over"] = {"eff": rng.choice([110, 120, 130])}
        cls = "rd_details"
    elif mut == "NEG-ORDER":
        rng.shuffle(rd)
        cls = "rows_reordered"
    elif mut == "NEG-MORE":
        rd += [
            {"key": rng.choice(pd)["key"], "or_analog": False}
            for _ in range(rng.randint(2, 4))
        ]
        cls = "rd_more_rows"
    base = _base_code(rng)
    pd_lines = _page_noise(
        rng,
        param,
        _lum_render_pz(rng, pd, pd_reg),
        _cipher(rng, base, param, "П"),
        "П",
        traps=rng.randint(0, 2),
    )
    if rd_fmt == "spec":
        body = _lum_render_spec(rng, rd, traps=rng.randint(0, 2))
    else:
        body = _lum_render_pz(rng, rd, "pz", respell=(rd_fmt == "pz_respell"))
    rd_lines = _page_noise(rng, param, body, _cipher(rng, base, param, "Р"), "Р")
    return pd_lines, rd_lines, _lum_expand(pd), _lum_expand(rd), cls


def _lum_sample(rng, param):
    if rng.random() < 0.15:
        body = sum((_wrap(rng, t) for t in rng.sample(_LUM_TRAPS, 2)), [])
        if rng.random() < 0.5:
            body += _lum_render_spec(rng, [], traps=3)
        return _page_noise(
            rng, param, body, _cipher(rng, _base_code(rng), param, "Р"), "Р"
        ), []
    pd = _lum_pd(rng)
    for s in pd:
        s["or_analog"] = rng.random() < 0.15
    if rng.random() < 0.5:
        body = _lum_render_pz(rng, pd)
        ms = _lum_expand(pd)
        stage = "П"
    else:
        rows = _lum_rows(rng, pd)
        for r in rows:
            r["or_analog"] = rng.random() < 0.1
        body = _lum_render_spec(rng, rows, traps=rng.randint(0, 2))
        ms = _lum_expand(rows)
        stage = "Р"
    return _page_noise(
        rng,
        param,
        body,
        _cipher(rng, _base_code(rng), param, stage),
        stage,
        traps=rng.randint(0, 1),
    ), ms


# ============================================================================================= общий шум страницы

_PAGE_TRAPS = {
    "M-072": _PIPE["M-072"]["traps_pz"],
    "M-075": _PIPE["M-075"]["traps_pz"],
    "M-079": _FAN_TRAPS,
    "M-050": _FIN_TRAPS,
    "M-130": _LUM_TRAPS,
    "M-044": [
        "Существующая кровля соседнего здания (рубероид в 3 слоя по цементной стяжке) — без изменений.",
        "Допускается замена утеплителя на материал с теплопроводностью не выше 0,040 Вт/(м·°С) при толщине не менее расчётной.",
        "Существующее покрытие над входом (профлист, минвата 100 мм) разбирается.",
        "Водосточные воронки Ø110 с электрообогревом, см. раздел ВК.",
    ],
    "M-128": [
        "Существующее чердачное перекрытие (засыпка шлаком 200 мм по деревянному настилу) демонтируется.",
        "Допускается применение утеплителя другой марки с λ не более 0,040 Вт/(м·°С).",
        "Требуемое сопротивление теплопередаче покрытия R0тр = 4,65 м²·°С/Вт.",
    ],
    "M-125": [
        "Существующая стена соседнего здания (кирпич 510 мм) — без утепления, проектом не затрагивается.",
        "Требуемое сопротивление теплопередаче стен R0тр = 3,08 м²·°С/Вт; приведённое R0пр = 3,21 м²·°С/Вт.",
        "Допускается замена облицовки на материал группы НГ по согласованию с автором проекта.",
        "Кронштейны подсистемы НФС крепить анкерами с шагом по расчёту.",
    ],
    "M-032": [
        "Существующее асфальтобетонное покрытие (асфальтобетон 50 мм по щебню 150 мм) подлежит разборке.",
        "Бортовой камень БР 100.30.15 на бетонном основании B15 толщиной 100 мм.",
        "Допускается замена щебня на щебёночно-песчаную смесь по согласованию с заказчиком и после перерасчёта.",
        "Площадь покрытия проездов — 1 240 м², тротуаров — 615 м².",
    ],
}


def _page_noise(rng, param, body, cipher, stage, traps=0) -> list[str]:
    lines = list(body)
    for t in rng.sample(_PAGE_TRAPS[param], min(traps, len(_PAGE_TRAPS[param]))):
        # ловушка встаёт только на границу абзаца или строки таблицы, не внутрь перенесённой фразы
        ok = [0, len(lines)] + [
            i for i in range(1, len(lines))
            if (lines[i - 1].rstrip().endswith((".", ":")) or " | " in lines[i - 1]
                or re.search(r"\S {2,}\S", lines[i - 1]))
            and not lines[i][:1].islower()
        ]
        at = rng.choice(ok)
        lines[at:at] = _wrap(rng, t)
    if rng.random() < 0.4:
        lines.insert(
            0,
            rng.choice(
                [
                    "Общие данные",
                    "Пояснительная записка",
                    "Лист 3",
                    "Раздел проекта",
                    "Изменение 1 от 12.03.2025",
                ]
            ),
        )
    st = _stamp(
        rng,
        cipher,
        stage,
        rng.choice(
            [
                "Общие указания",
                "Спецификация оборудования",
                "Узлы",
                "Разрезы",
                "Ведомость",
                "Текстовая часть",
            ]
        ),
    )
    return (st + lines) if rng.random() < 0.3 else (lines + st)


# ================================================================================================= CMP-21: слои

_LV = {
    "MEMBRANE_PVC": (
        ["Полимерная мембрана ПВХ", "Мембрана ПВХ армированная", "ПВХ-мембрана"],
        [
            "Мембрана LOGICROOF V-RP (ПВХ), армированная полиэфирной сеткой",
            "Полимерная мембрана ПВХ «ПолиКров-П», армированная",
        ],
    ),
    "MEMBRANE_TPO": (
        [
            "Мембрана ТПО",
            "Полимерная мембрана на основе термопластичных полиолефинов (ТПО)",
        ],
        ["Мембрана LOGICROOF T-SL (ТПО)", "Мембрана TPO «ОлефинРуф» армированная"],
    ),
    "MEMBRANE_EPDM": (
        ["Мембрана EPDM", "Мембрана из этилен-пропилен-диенового каучука (ЭПДМ)"],
        ["Мембрана EPDM «КаучукРуф» армированная"],
    ),
    "BITUMEN_POLYMER": (
        [
            "Битумно-полимерный наплавляемый материал",
            "Наплавляемый материал на СБС-модифицированном битуме",
            "Кровельный ковёр из битумно-полимерного материала",
        ],
        ["Техноэласт ЭКП (верхний слой)", "Унифлекс ЭПП (нижний слой)"],
    ),
    "BITUMEN_OXID": (
        ["Рубероид", "Рулонный материал на окисленном битуме"],
        ["Рубероид РКП-350", "Бикрост ХКП"],
    ),
    "VAPOR_PE": (
        [
            "Пароизоляция — плёнка полиэтиленовая",
            "Пароизоляционная плёнка ПЭ",
            "Пароизоляция из п/э плёнки",
        ],
        ["Плёнка полиэтиленовая пароизоляционная ГОСТ 10354-82"],
    ),
    "VAPOR_BITUMEN": (
        [
            "Пароизоляция битумно-полимерная наплавляемая",
            "Пароизоляционный слой из наплавляемого битумно-полимерного материала",
        ],
        ["Биполь ЭПП (пароизоляция)", "Пароизоляция из материала Техноэласт ЭПП"],
    ),
    "VAPOR_MEMBRANE": (
        ["Пароизоляционная мембрана", "Пароизоляция — армированная плёнка"],
        [
            "Пароизоляционная плёнка «Ютафол Н 110»",
            "Пароизоляционная армированная плёнка ПарБарьер-А",
        ],
    ),
    "WIND_BARRIER": (
        ["Ветрогидрозащитная мембрана", "Ветрозащитная паропроницаемая мембрана"],
        ["Мембрана ветрогидрозащитная «ВентЗащита-А»"],
    ),
    "INSUL_MW": (
        [
            "Плиты минераловатные",
            "Утеплитель — минераловатные плиты",
            "Каменная вата",
            "Минплита",
        ],
        [
            "Плиты ТЕХНОРУФ Н ПРОФ",
            "Плиты ROCKWOOL РУФ БАТТС В ЭКСТРА",
            "Плиты минераловатные ТЕХНОВЕНТ СТАНДАРТ (γ = 80 кг/м³)",
            "Каменная вата ФАСАД БАТТС (ρ=145 кг/м³)",
        ],
    ),
    "INSUL_XPS": (
        [
            "Экструзионный пенополистирол",
            "ЭППС",
            "XPS",
            "Плиты из экструдированного пенополистирола",
        ],
        ["ТЕХНОПЛЕКС", "XPS CARBON PROF 300", "Пеноплэкс Кровля"],
    ),
    "INSUL_EPS": (
        ["Пенополистирол ПСБ-С", "Плиты пенополистирольные", "ПСБ-С-25"],
        [
            "Пенополистирол ПСБ-С 35 ГОСТ 15588-2014",
            "Плиты EPS 100 (ПСБ-С-25Ф фасадный)",
        ],
    ),
    "INSUL_PIR": (
        ["Плиты PIR", "Теплоизоляция из полиизоцианурата (PIR)"],
        ["LOGICPIR PROF", "Плиты PIR «ПолиТерм-ПИР» с флизелином"],
    ),
    "INSUL_FOAMGLASS": (
        ["Пеностекло", "Плиты из пеностекла"],
        ["Пеностекло «ТермоГласс» плиты"],
    ),
    "INSUL_ECOWOOL": (
        ["Эковата", "Целлюлозный утеплитель (эковата)"],
        ["Эковата «Экотерм» напыляемая"],
    ),
    "INSUL_CLAYDITE": (
        [
            "Засыпка керамзитовым гравием (утеплитель)",
            "Утепляющая засыпка из керамзита",
        ],
        ["Керамзитовый гравий фр. 10–20, γ=400 кг/м³ (теплоизоляционная засыпка)"],
    ),
    "SLOPE_CLAYDITE": (
        [
            "Уклонообразующий слой из керамзитового гравия",
            "Разуклонка — керамзит",
            "Керамзитовый гравий по уклону",
        ],
        ["Уклонообразующая засыпка из керамзитового гравия фр. 5–10 мм"],
    ),
    "SLOPE_WEDGE": (
        [
            "Клиновидная теплоизоляция (уклонообразующие плиты)",
            "Уклонообразующие клиновидные плиты",
        ],
        ["ТЕХНОРУФ Н ПРОФ КЛИН 1,7 %"],
    ),
    "SLOPE_CONCRETE": (
        ["Уклонообразующий слой из лёгкого бетона", "Разуклонка из керамзитобетона"],
        ["Керамзитобетон D1200 по уклону"],
    ),
    "SCREED_CS": (
        [
            "Цементно-песчаная стяжка",
            "Стяжка из ЦПР М150",
            "Армированная цементно-песчаная стяжка",
        ],
        ["Стяжка цементно-песчаная М150, армированная сеткой Вр-1 4 с ячейкой 100×100"],
    ),
    "SCREED_PREFAB": (
        ["Сборная стяжка из двух слоёв ЦСП", "Сборная стяжка (2 слоя АЦЛ)"],
        ["Сборная стяжка из листов ЦСП в два слоя на клею"],
    ),
    "SLAB_RC": (
        [
            "Железобетонная плита покрытия",
            "Ж/б плита",
            "Монолитная железобетонная плита",
        ],
        ["Монолитная ж.б. плита из бетона B25"],
    ),
    "PROFILED_SHEET": (
        ["Профилированный лист", "Стальной профнастил"],
        ["Профлист Н75-750-0,8 ГОСТ 24045-2016"],
    ),
    "STEEL_ARMOR": (
        [
            "Стальной защитный лист",
            "Лист стальной рифлёный (защитный)",
            "Бронированный стальной лист",
        ],
        ["Лист стальной рифлёный ГОСТ 8568-77, ст. С245 (защитный)"],
    ),
    "PRIMER": (
        ["Праймер битумный", "Огрунтовка битумным праймером"],
        ["Праймер битумный ТЕХНОНИКОЛЬ № 01"],
    ),
    "GEOTEXTILE": (
        ["Геотекстиль", "Геотекстиль иглопробивной"],
        ["Геотекстиль иглопробивной 300 г/м²", "Геотекстиль «Дорнит» 350 г/м²"],
    ),
    "SEPARATION": (
        [
            "Разделительный слой — стеклохолст",
            "Разделительный слой из полиэтиленовой плёнки",
        ],
        ["Стеклохолст разделительный 50 г/м²"],
    ),
    "DRAIN_MEMBRANE": (
        ["Профилированная дренажная мембрана"],
        ["Дренажная мембрана PLANTER geo"],
    ),
    "BALLAST_GRAVEL": (
        ["Гравий (балласт)", "Балластный слой из гравия"],
        ["Гравий окатанный фр. 20–40 мм (пригруз)"],
    ),
    "PAVING_TILE": (
        ["Тротуарная плитка", "Бетонная плитка на опорах"],
        ["Плитка тротуарная 400×400 на регулируемых опорах"],
    ),
    "WALL_RC": (
        ["Монолитная железобетонная стена", "Стена ж/б"],
        ["Стена монолитная ж.б. B25 F150"],
    ),
    "WALL_GASBLOCK": (
        ["Кладка из газобетонных блоков", "Газобетон D500"],
        ["Блоки газобетонные D500 B3,5 F100 на клею"],
    ),
    "WALL_BRICK": (
        ["Кладка из керамического кирпича", "Кирпичная кладка"],
        ["Кирпич КР-р-по 250×120×65/1НФ/150/2,0/50 ГОСТ 530-2012"],
    ),
    "AIR_GAP": (
        ["Вентилируемый воздушный зазор", "Вентзазор"],
        ["Воздушный зазор (вентилируемый)"],
    ),
    "FACADE_PORCELAIN": (
        ["Облицовка керамогранитом на подсистеме", "Керамогранитные плиты НФС"],
        ["Керамогранит 600×600 на подсистеме «СтройФасад-КГ»"],
    ),
    "FACADE_FC": (
        ["Фиброцементные панели на подсистеме", "Фиброцементные плиты"],
        ["Панели фиброцементные «ФиброФасад» на подсистеме"],
    ),
    "FACADE_CASSETTE": (
        ["Металлические кассеты", "Облицовка металлокассетами"],
        ["Кассеты фасадные из оцинкованной стали с полимерным покрытием"],
    ),
    "FACING_BRICK": (
        ["Облицовочный кирпич", "Облицовочная кладка из лицевого кирпича"],
        ["Кирпич лицевой КР-л-пу 1НФ/175/1,4/75"],
    ),
    "PLASTER_THIN": (
        [
            "Тонкослойная штукатурка по армирующей сетке",
            "Декоративно-защитный штукатурный слой (СФТК)",
        ],
        ["Штукатурка тонкослойная минеральная по стеклосетке"],
    ),
    "PLASTER_INT": (
        ["Внутренняя штукатурка", "Штукатурка гипсовая (внутренняя)"],
        ["Штукатурка гипсовая машинного нанесения"],
    ),
    # дорожная одежда
    "ASPHALT_SMA": (
        ["Щебёночно-мастичный асфальтобетон ЩМА-16", "ЩМА-20 на ПБВ-60"],
        [
            "Щебёночно-мастичная асфальтобетонная смесь ЩМА-16 на битуме БНД 70/100 с добавкой"
        ],
    ),
    "ASPHALT_FINE_DENSE": (
        [
            "Асфальтобетон плотный мелкозернистый тип Б марки II",
            "Горячий плотный мелкозернистый а/б тип А марки I",
        ],
        [
            "Асфальтобетон горячий плотный мелкозернистый тип Б марки II на БНД 70/100 (ГОСТ 9128-2013)"
        ],
    ),
    "ASPHALT_SAND": (
        ["Асфальтобетон песчаный тип Г марки II", "Песчаный а/б тип Д"],
        ["Асфальтобетон горячий песчаный тип Г марки II (ГОСТ 9128-2013)"],
    ),
    "ASPHALT_COARSE_POROUS": (
        [
            "Асфальтобетон пористый крупнозернистый марки II",
            "Крупнозернистый пористый а/б",
        ],
        ["Асфальтобетон горячий пористый крупнозернистый марки II на БНД 70/100"],
    ),
    "ASPHALT_COARSE_DENSE": (
        [
            "Асфальтобетон плотный крупнозернистый тип Б",
            "А/б крупнозернистый плотный марки I",
        ],
        [
            "Асфальтобетон горячий плотный крупнозернистый тип Б марки I (ГОСТ 9128-2013)"
        ],
    ),
    "PAVING": (
        [
            "Бетонная тротуарная плитка",
            "Брусчатка бетонная вибропрессованная",
            "Плитка тротуарная «Кирпичик»",
        ],
        ["Плитка бетонная тротуарная 1П.8 ГОСТ 17608-2017, серая"],
    ),
    "CONCRETE_ROAD": (
        ["Цементобетон B30 Btb4,0", "Монолитный дорожный бетон B30"],
        ["Бетон дорожный B30 Btb4,0 F200 W6 армированный"],
    ),
    "CRUSHED_STONE": (
        [
            "Щебень фр. 40–80 мм, устроенный по способу заклинки",
            "Щебень гранитный фракции 20–40 мм М1200",
            "Щебень известняковый фр. 40–70 с расклинцовкой",
        ],
        ["Щебень гранитный фр. 40–80 мм М1200 по способу заклинки (ГОСТ 8267-93)"],
    ),
    "CRUSHED_STONE_MIX": (
        ["Щебёночно-песчаная смесь С4", "ЩПС С5", "ЩПС С-4 0–80 мм"],
        ["Щебёночно-песчаная смесь С4 (ГОСТ 25607-2009), уплотнённая"],
    ),
    "GRAVEL": (
        ["Гравийно-песчаная смесь", "ГПС", "Гравий фр. 20–40"],
        ["Гравийно-песчаная смесь С2 (ГОСТ 25607-2009)"],
    ),
    "RECYCLED": (
        ["Щебень из дроблёного бетона", "Асфальтогранулят"],
        ["Щебень из бетонного лома фр. 20–40 мм"],
    ),
    "CEMENT_STABILIZED": (
        ["Щебень, укреплённый цементом М60", "Грунт, укреплённый цементом (5 %)"],
        ["Щебёночная смесь, обработанная цементом, марки М60 (ГОСТ 23558-94)"],
    ),
    "SAND_DRAIN": (
        [
            "Песок средней крупности (Кф ≥ 1 м/сут)",
            "Песок средней крупности дренирующий",
            "Песок средний Кф не менее 1,0 м/сут",
        ],
        ["Песок средней крупности ГОСТ 8736-2014, Кф не менее 1 м/сут"],
    ),
    "SAND_FINE": (
        ["Песок мелкий", "Песок мелкозернистый"],
        ["Песок мелкий ГОСТ 8736-2014"],
    ),
    "SAND_CEMENT_BED": (
        ["Пескоцементная смесь 1:10", "Сухая пескоцементная смесь М150"],
        ["Сухая пескоцементная смесь М150 (выравнивающий слой)"],
    ),
    "GEOGRID": (
        ["Георешётка объёмная", "Геосетка стеклянная ССНП"],
        ["Георешётка объёмная h=100 мм, ячейка 210×210"],
    ),
    "BITUMEN_EMULSION": (
        ["Розлив битумной эмульсии", "Подгрунтовка битумной эмульсией"],
        ["Розлив битумной эмульсии ЭБК-2 (0,8 л/м²)"],
    ),
}
_LV_NONE = {
    "green": "Растительный субстрат",
    "glue": "Клеевой состав",
    "soil": "Грунт земляного полотна, уплотнённый до Ку=0,98",
}


def _L(m, t=None, tmax=None, nm=None):
    return {"m": m, "t": t, "t_max": tmax, "nm": nm}


def _roof(rng, param):
    kind = rng.choice(
        ["membrane", "membrane", "bitumen", "armor", "inverted", "profiled"]
        + (["attic", "attic", "attic"] if param == "M-128" else [])
    )
    if kind == "attic":
        L = [
            rng.choice(
                [_L("SCREED_CS", rng.choice([30, 40, 50])), _L("SCREED_PREFAB", 20)]
            )
        ]
        ins = rng.choice(
            [
                ("INSUL_MW", [150, 200, 250]),
                ("INSUL_ECOWOOL", [250, 300]),
                ("INSUL_CLAYDITE", [250, 300]),
                ("INSUL_EPS", [150, 200]),
                ("INSUL_XPS", [120, 150]),
            ]
        )
        L.append(_L(ins[0], rng.choice(ins[1])))
        L.append(_L(rng.choice(["VAPOR_PE", "VAPOR_MEMBRANE", "VAPOR_BITUMEN"])))
        L.append(_L("SLAB_RC", rng.choice([200, 220, 250])))
        return "attic", L
    if kind == "armor":
        return "roof", [
            _L("STEEL_ARMOR", 6),
            _L("GEOTEXTILE"),
            _L("MEMBRANE_PVC", 1.5),
            _L(rng.choice(["INSUL_PIR", "INSUL_MW"]), rng.choice([100, 150, 180])),
            _L("VAPOR_BITUMEN"),
            _L("SLAB_RC", 250),
        ]
    if kind == "profiled":
        L = [
            _L(rng.choice(["MEMBRANE_PVC", "MEMBRANE_TPO"]), rng.choice([1.2, 1.5])),
            _L("INSUL_MW", rng.choice([40, 50])),
            _L("INSUL_MW", rng.choice([120, 150, 170])),
            _L(rng.choice(["VAPOR_MEMBRANE", "VAPOR_PE"])),
            _L("PROFILED_SHEET"),
        ]
        return "roof", L
    if kind == "inverted":
        top = rng.choice(
            [
                _L("PAVING_TILE", rng.choice([40, 50])),
                _L("BALLAST_GRAVEL", rng.choice([50, 60])),
            ]
        )
        L = [
            top,
            _L("GEOTEXTILE"),
            _L("INSUL_XPS", rng.choice([100, 120, 150])),
            _L("BITUMEN_POLYMER", 4.0),
            _L("BITUMEN_POLYMER", 3.0),
            _L("PRIMER"),
            _L("SCREED_CS", rng.choice([40, 50])),
            _L("SLOPE_CONCRETE", rng.choice([30, 40]), rng.choice([150, 180, 200])),
            _L("SLAB_RC", rng.choice([200, 220])),
        ]
        if rng.random() < 0.2:
            L.insert(0, _L(None, 200, nm=_LV_NONE["green"]))
            L[1] = _L("DRAIN_MEMBRANE")
        return "roof", L
    if kind == "bitumen":
        L = [
            _L("BITUMEN_POLYMER", 4.0),
            _L("BITUMEN_POLYMER", 3.0),
            _L("PRIMER"),
            rng.choice(
                [_L("SCREED_CS", rng.choice([40, 50])), _L("SCREED_PREFAB", 20)]
            ),
            _L(
                rng.choice(["INSUL_MW", "INSUL_MW", "INSUL_XPS", "INSUL_EPS"]),
                rng.choice([150, 170, 200]),
            ),
            _L(rng.choice(["VAPOR_PE", "VAPOR_BITUMEN"])),
        ]
        if rng.random() < 0.6:
            L.append(
                _L(
                    "SLOPE_CLAYDITE",
                    rng.choice([20, 30, 40]),
                    rng.choice([120, 150, 200]),
                )
            )
        L.append(_L("SLAB_RC", rng.choice([200, 220, 250])))
        return "roof", L
    L = [
        _L(
            rng.choice(
                ["MEMBRANE_PVC", "MEMBRANE_PVC", "MEMBRANE_TPO", "MEMBRANE_EPDM"]
            ),
            rng.choice([1.2, 1.5, 2.0]),
        )
    ]
    if rng.random() < 0.5:
        L.append(_L("GEOTEXTILE"))
    ins = rng.choice(["INSUL_MW", "INSUL_MW", "INSUL_PIR", "INSUL_XPS"])
    if ins == "INSUL_MW" and rng.random() < 0.6:
        L += [
            _L("INSUL_MW", rng.choice([30, 40, 50])),
            _L("INSUL_MW", rng.choice([100, 150, 170, 200])),
        ]
    else:
        L.append(_L(ins, rng.choice([100, 120, 150, 200])))
    slope = rng.choice(["SLOPE_CLAYDITE", "SLOPE_WEDGE", "SLOPE_CONCRETE", None])
    if slope == "SLOPE_WEDGE":
        L.insert(
            len(L), _L("SLOPE_WEDGE", rng.choice([10, 20]), rng.choice([100, 120]))
        )
    L.append(_L(rng.choice(["VAPOR_PE", "VAPOR_BITUMEN", "VAPOR_MEMBRANE"])))
    if slope in ("SLOPE_CLAYDITE", "SLOPE_CONCRETE"):
        L.append(_L("SCREED_CS", rng.choice([40, 50])))
        L.append(_L(slope, rng.choice([20, 30, 50]), rng.choice([150, 180, 200])))
    L.append(_L("SLAB_RC", rng.choice([200, 220, 250])))
    return "roof", L


def _wall(rng):
    kind = rng.choice(["nfs", "nfs", "sftk", "brick3", "fc"])
    if kind == "nfs":
        L = [
            _L(rng.choice(["FACADE_PORCELAIN", "FACADE_CASSETTE"]), None),
            _L("AIR_GAP", rng.choice([40, 50, 60])),
            _L("WIND_BARRIER"),
        ]
        if rng.random() < 0.5:
            L += [
                _L("INSUL_MW", rng.choice([50, 30])),
                _L("INSUL_MW", rng.choice([100, 120, 150])),
            ]
        else:
            L.append(_L("INSUL_MW", rng.choice([120, 150, 180, 200])))
        L += [
            _L(rng.choice(["WALL_GASBLOCK", "WALL_RC"]), rng.choice([200, 250, 300])),
            _L("PLASTER_INT", rng.choice([10, 15, 20])),
        ]
        return "wall", L
    if kind == "fc":
        return "wall", [
            _L("FACADE_FC", 8),
            _L("AIR_GAP", 40),
            _L("WIND_BARRIER"),
            _L("INSUL_MW", rng.choice([150, 180])),
            _L("WALL_RC", rng.choice([180, 200])),
        ]
    if kind == "sftk":
        L = [
            _L("PLASTER_THIN", rng.choice([6, 8, 10])),
            _L(rng.choice(["INSUL_MW", "INSUL_EPS"]), rng.choice([100, 120, 150])),
        ]
        if rng.random() < 0.3:
            L.append(_L(None, 5, nm=_LV_NONE["glue"]))
        L += [_L("WALL_BRICK", rng.choice([250, 380, 510])), _L("PLASTER_INT", 20)]
        return "wall", L
    return "wall", [
        _L("FACING_BRICK", 120),
        _L("AIR_GAP", rng.choice([20, 30])),
        _L(rng.choice(["INSUL_MW", "INSUL_XPS"]), rng.choice([100, 120, 150])),
        _L("WALL_GASBLOCK", rng.choice([250, 300])),
        _L("PLASTER_INT", 15),
    ]


def _road(rng):
    kind = rng.choice(["drive", "drive", "walk", "concrete", "sandwalk"])
    if kind == "drive":
        L = [
            _L(rng.choice(["ASPHALT_SMA", "ASPHALT_FINE_DENSE"]), rng.choice([40, 50])),
            _L("BITUMEN_EMULSION"),
            _L(
                rng.choice(["ASPHALT_COARSE_POROUS", "ASPHALT_COARSE_DENSE"]),
                rng.choice([60, 70, 80]),
            ),
            _L(
                rng.choice(["CRUSHED_STONE", "CRUSHED_STONE", "CRUSHED_STONE_MIX"]),
                rng.choice([180, 200, 250]),
            ),
            _L(
                rng.choice(["SAND_DRAIN", "SAND_DRAIN", "SAND_FINE"]),
                rng.choice([300, 400, 500]),
            ),
        ]
        if rng.random() < 0.4:
            L.append(_L("GEOTEXTILE"))
        if rng.random() < 0.2:
            L.append(_L(None, None, nm=_LV_NONE["soil"]))
        return "drive", L
    if kind == "walk":
        return "walk", [
            _L("PAVING", rng.choice([60, 70, 80])),
            _L("SAND_CEMENT_BED", rng.choice([30, 40, 50])),
            _L(
                rng.choice(["CRUSHED_STONE", "CRUSHED_STONE_MIX", "GRAVEL"]),
                rng.choice([100, 150, 200]),
            ),
            _L("SAND_DRAIN", rng.choice([150, 200, 300])),
        ]
    if kind == "concrete":
        return "drive", [
            _L("CONCRETE_ROAD", rng.choice([180, 200, 220])),
            _L("CEMENT_STABILIZED", rng.choice([150, 200])),
            _L("SAND_DRAIN", rng.choice([300, 400])),
        ]
    return "walk", [
        _L("ASPHALT_SAND", rng.choice([30, 40, 50])),
        _L(rng.choice(["CRUSHED_STONE", "GRAVEL"]), rng.choice([120, 150])),
        _L("SAND_DRAIN", rng.choice([150, 200])),
    ]


def _comp(rng, param, item):
    if param == "M-032":
        kind, L = _road(rng)
    elif param == "M-125":
        kind, L = _wall(rng)
    else:
        kind, L = _roof(rng, param)
    for i, x in enumerate(L):
        x["slot"] = f"{item}:{i}"
    return {"item": item, "kind": kind, "layers": L}


def _items_for(rng, param, k):
    pools = {
        "M-032": [["Тип 1", "Тип 2"], ["Тип 1", "Тип 2", "Тип 3"], ["Тип 2", "Тип 4"]],
        "M-044": [["Кр-1", "Кр-2"], ["Кр-1", "Кр-3"], ["К-1", "К-2"]],
        "M-128": [["П-1", "П-2"], ["Кр-1", "П-1"], ["ПК-1", "ПК-2"]],
        "M-125": [["НС-1", "НС-2"], ["НС-1", "НС-3"], ["С-1", "С-2"]],
    }
    return rng.choice(pools[param])[:k]


def _num(t: float) -> str:
    return (f"{t:g}").replace(".", ",")


def _thick(rng, x, style: str) -> str:
    t, tm = x["t"], x["t_max"]
    if t is None:
        return ""
    if tm is not None:
        return rng.choice(
            [
                f"{_num(t)}–{_num(tm)} мм",
                f"от {_num(t)} до {_num(tm)} мм",
                f"{_num(t)}...{_num(tm)} мм",
                f"h={_num(t)}÷{_num(tm)} мм",
            ]
        )
    if style == "cm" and t >= 10 and t % 10 == 0:
        return rng.choice([f"{_num(t / 10)} см", f"h={_num(t / 10)} см"])
    return rng.choice(
        [
            f"{_num(t)} мм",
            f"δ={_num(t)} мм",
            f"t={_num(t)} мм",
            f"{_num(t)}мм",
            f"— {_num(t)} мм",
        ]
    )


def _lname(rng, x, reg: str, vi=None):
    if x["m"] is None:
        return x["nm"]
    gen, det = _LV[x["m"]]
    pool = det if reg == "det" else gen
    return pool[vi % len(pool)] if vi is not None else rng.choice(pool)


_TITLES = {
    "roof": [
        "{it}. Кровля над жилой частью",
        "Состав кровли {it}",
        "{it} — покрытие над техническим этажом",
        "Кровля {it} (плоская, неэксплуатируемая)",
        "Узел 1. Состав покрытия {it}",
    ],
    "attic": [
        "{it}. Чердачное перекрытие",
        "Состав перекрытия {it} (тёплый контур)",
        "Перекрытие над последним этажом {it}",
    ],
    "wall": [
        "{it}. Наружная стена",
        "Состав наружной стены {it}",
        "Стена {it} с навесным фасадом",
        "Разрез стены {it}",
    ],
    "drive": [
        "{it}. Проезд",
        "Конструкция дорожной одежды {it} — проезды",
        "{it} — покрытие проездов и автостоянок",
    ],
    "walk": [
        "{it}. Тротуар",
        "Конструкция дорожной одежды {it} — тротуары",
        "{it} — пешеходные дорожки",
    ],
}
_NOTITLE = {
    "roof": "Состав кровли",
    "attic": "Состав чердачного перекрытия",
    "wall": "Состав наружной стены",
    "drive": "Конструкция дорожной одежды проезда",
    "walk": "Конструкция дорожной одежды тротуара",
}


def _order_marker(kind: str, rev: bool) -> str:
    if kind == "wall":
        return "(изнутри наружу)" if rev else "(снаружи внутрь)"
    return "(снизу вверх)" if rev else "(сверху вниз)"


def _render_comp(
    rng, comp, fmt, reg="gen", rev=False, names=None, respell=False
) -> tuple[list[str], list[str]]:
    """Возвращает (строки, названия слоёв в каноническом порядке)."""
    kind = comp["kind"]
    it = comp["item"]
    title = rng.choice(_TITLES[kind]).format(it=it) if it else _NOTITLE[kind]
    marker = _order_marker(kind, rev) if (rev or rng.random() < 0.3) else ""
    style = (
        "cm" if (comp["kind"] in ("drive", "walk") and rng.random() < 0.35) else "mm"
    )
    nm = []
    for i, x in enumerate(comp["layers"]):
        n = names[i] if names is not None else _lname(rng, x, reg)
        if respell:
            n = _spell(rng, n)
        nm.append(n)
    seq = list(zip(comp["layers"], nm))
    if rev:
        seq.reverse()
    lines = []
    if fmt == "table":
        sep = rng.choice(["|", " "])
        lines.append(f"{title} {marker}".strip())
        lines.append(_row(rng, ["№", "Наименование слоя", "Толщина, мм"], sep))
        for i, (x, n) in enumerate(seq, 1):
            if x["t"] is None:
                tt = "—"
            elif x["t_max"] is not None:
                tt = f"{_num(x['t'])}–{_num(x['t_max'])}"
            else:
                tt = _num(x["t"])
            lines.append(_nbsp(rng, _row(rng, [str(i), n, tt], sep)))
    elif fmt == "inline":
        parts = []
        for x, n in seq:
            th = _thick(rng, x, style)
            parts.append(
                f"{n} {th}".strip() if rng.random() < 0.8 or not th else f"{th.lstrip('— ')} {n}"
            )
        lines += _wrap(
            rng, f"{title}{' ' + marker if marker else ''}: " + "; ".join(parts) + "."
        )
    elif fmt == "pz":
        parts = []
        for x, n in seq:
            th = _thick(rng, x, style)
            n0 = n[:1].lower() + n[1:] if not re.match(r"[A-ZА-Я]{2}", n) else n
            parts.append(f"{n0} {th}".strip())
        lead = rng.choice(
            [
                f"Принят следующий состав ({title.lower() if it is None else title})",
                f"{title}. Состав",
                f"Конструкция{' ' + it if it else ''} выполняется из следующих слоёв",
            ]
        )
        lines += _wrap(rng, f"{lead}{' ' + marker if marker else ''}: {', '.join(parts)}.")
    else:  # vyn — выноска узла
        lines.append(f"{title} {marker}".strip())
        pat = rng.choice(
            [
                "{i}. {n} – {t}",
                "{i}) {n}, {t}",
                "- {n} {t}",
                "{i}. {t} – {n}",
                "{i}. {n} {t}",
            ]
        )
        for i, (x, n) in enumerate(seq, 1):
            th = _thick(rng, x, style)
            if not th:
                line = (
                    f"- {n}"
                    if pat.startswith("-")
                    else (f"{i}) {n}" if pat.startswith("{i})") else f"{i}. {n}")
                )
            else:
                line = pat.format(i=i, n=n, t=th.lstrip("— "))
            if len(line) > 60 and rng.random() < 0.25:
                cut = line.rfind(" ", 0, len(line) // 2 + 10)
                lines += [line[:cut], line[cut + 1 :]]
            else:
                lines.append(_nbsp(rng, line))
    return lines, nm


def _truth_comp(comp) -> dict:
    return {
        "item": comp["item"],
        "layers": [
            {
                "m": x["m"],
                "t": float(x["t"]) if x["t"] is not None else None,
                "t_max": float(x["t_max"]) if x["t_max"] is not None else None,
            }
            for x in comp["layers"]
        ],
    }


def _layers_page(
    rng,
    param,
    comps,
    fmt,
    stage,
    base,
    reg="gen",
    rev=False,
    names=None,
    respell=False,
    traps=0,
):
    body = []
    allnames = []
    for i, c in enumerate(comps):
        nm = names[i] if names else None
        ls, used = _render_comp(rng, c, fmt, reg, rev, nm, respell)
        allnames.append(used)
        body += ls
        if rng.random() < 0.3:
            body.append(
                rng.choice(
                    [
                        "Уклон кровли — 1,5 %.",
                        "Примыкание к парапету — см. узел 4.",
                        "Разрез 1-1",
                        "Экспликация покрытий",
                        "Площадь — 860 м²",
                        "* Толщина указана после уплотнения",
                    ]
                )
            )
    return _page_noise(
        rng, param, body, _cipher(rng, base, param, stage), stage, traps=traps
    ), allnames


_LAYER_SUBST_GROUPS = {
    "waterproofing",
    "insulation",
    "vapor_barrier",
    "slope",
    "screed",
    "wearing",
    "binder",
    "base",
    "subbase",
    "cladding",
    "auxiliary",
    "structure",
}


def _subst_candidates(fam, m, want_eq: bool):
    canon = _canon(fam)
    g = canon[m]["group"]
    if g not in _LAYER_SUBST_GROUPS:
        return []
    out = []
    for k, v in canon.items():
        if k == m or v["group"] != g:
            continue
        if g in ("auxiliary", "structure") and not any(
            {m, k} <= st for st in _SUBST_SETS
        ):
            continue
        eq = verdict(fam, m, k) == "EQUIVALENT"
        if eq == want_eq:
            out.append(k)
    return out


_SUBST_SETS = [
    {"GEOTEXTILE", "SEPARATION"},
    {"GEOTEXTILE", "GEOGRID"},
    {"WALL_RC", "WALL_GASBLOCK", "WALL_BRICK"},
]
_INSERT = {
    "envelope_layers": ["GEOTEXTILE", "SEPARATION", "PRIMER"],
    "road_layers": ["GEOTEXTILE", "GEOGRID"],
}


def _layers_pair(rng, param, mut):
    fam = FAMILY[param]
    k = 1 if rng.random() < 0.6 else 2
    items = _items_for(rng, param, k)
    if k == 1 and rng.random() < 0.3:
        items = [None]
    pd = [_comp(rng, param, it) for it in items]
    rd = copy.deepcopy(pd)
    if k == 1 and items == [None] and rng.random() < 0.5:
        rd[0]["item"] = _items_for(rng, param, 1)[0]
    tc = rng.choice(rd)
    Ls = tc["layers"]
    cls = ""
    rd_reg, rd_rev, pd_rev, rd_names, rd_respell = "gen", False, False, None, False
    known = [i for i, x in enumerate(Ls) if x["m"] is not None]
    if mut == "MUT-08":
        op = rng.choice(
            ["thickness_down", "thickness_down", "delete", "delete", "reorder"]
        )
        if op == "thickness_down":
            c = [i for i in known if Ls[i]["t"] is not None and Ls[i]["t"] >= 3]
            if param in ("M-125", "M-128"):
                c = [
                    i for i in c if _canon(fam)[Ls[i]["m"]]["group"] == "insulation"
                ] or c
            if not c:
                return None
            x = Ls[rng.choice(c)]
            f = rng.choice([0.5, 0.6, 0.67, 0.75, 0.8])
            new = round(x["t"] * f) if x["t"] >= 10 else round(x["t"] - 1.0, 1)
            if new >= x["t"] - 0.5:
                return None
            x["t"] = float(new)
            cls = f"thickness_down_{_canon(fam)[x['m']]['group']}" + (
                "_variable" if x["t_max"] else ""
            )
        elif op == "delete":
            pri = [
                i
                for i in known
                if _canon(fam)[Ls[i]["m"]]["group"]
                in (
                    "vapor_barrier",
                    "protection",
                    "wind_barrier",
                    "subbase",
                    "insulation",
                    "waterproofing",
                )
            ]
            i = rng.choice(pri or known)
            cls = f"delete_{_canon(fam)[Ls[i]['m']]['group']}"
            del Ls[i]
        else:
            c = [
                i
                for i in range(len(Ls) - 1)
                if Ls[i]["m"] and Ls[i + 1]["m"] and Ls[i]["m"] != Ls[i + 1]["m"]
            ]
            if not c:
                return None
            i = rng.choice(c)
            Ls[i], Ls[i + 1] = Ls[i + 1], Ls[i]
            cls = "reorder_adjacent"
    elif mut == "MUT-07":
        c = [(i, _subst_candidates(fam, Ls[i]["m"], False)) for i in known]
        c = [(i, s) for i, s in c if s]
        if not c:
            return None
        i, s = rng.choice(c)
        new = rng.choice(s)
        cls = (
            "subst_"
            + verdict(fam, Ls[i]["m"], new).lower()
            + "_"
            + _canon(fam)[new]["group"]
        )
        Ls[i]["m"] = new
    elif mut == "NEG-ANALOG":
        c = [(i, _subst_candidates(fam, Ls[i]["m"], True)) for i in known]
        c = [(i, s) for i, s in c if s]
        if not c:
            return None
        i, s = rng.choice(c)
        Ls[i]["m"] = rng.choice(s)
        cls = "analog_" + _canon(fam)[Ls[i]["m"]]["group"]
    elif mut == "NEG-MORE":
        if rng.random() < 0.5:
            c = [i for i in known if Ls[i]["t"] is not None]
            x = Ls[rng.choice(c)]
            x["t"] = float(
                x["t"]
                + (
                    rng.choice([10, 20, 50])
                    if x["t"] >= 10
                    else 0.5 + rng.choice([0.5, 1.0])
                )
            )
            cls = "thickness_up"
        else:
            present = {x["m"] for x in Ls}
            pool = (
                ["VAPOR_MEMBRANE", "WIND_BARRIER"] if param == "M-125" else _INSERT[fam]
            )
            ins = [m for m in pool if m not in present]
            if not ins:
                return None
            pos = rng.randint(1, len(Ls) - 1)
            Ls.insert(pos, _L(rng.choice(ins)))
            Ls[pos]["slot"] = "new"
            cls = "insert_layer"
    elif mut == "NEG-ORDER":
        if rng.random() < 0.7:
            rd_rev = True
            cls = "rd_reverse_explicit"
        else:
            pd_rev = True
            cls = "pd_reverse_explicit"
    elif mut == "NEG-DETAIL":
        rd_reg = "det"
        cls = "rd_brand_details"
    elif mut == "NEG-SPELL":
        rd_respell = True
        cls = "respell"
    elif mut == "NEG-SYN":
        cls = "other_wording"
    else:
        cls = "same"
    lab = _layers_label(param, pd, rd)
    if lab is None:
        return None
    base = _base_code(rng)
    pd_fmt = rng.choice(["pz", "vyn", "vyn", "inline"])
    rd_fmt = rng.choice([f for f in ["vyn", "table", "inline"] if f != pd_fmt])
    if mut == "NEG-ORDER" and rng.random() < 0.3:
        pd_fmt, rd_fmt, rd_rev, pd_rev = "vyn", "table", False, False
        cls = "table_vs_callout"
    pd_lines, pd_names = _layers_page(
        rng,
        param,
        pd,
        pd_fmt,
        "П",
        base,
        reg="gen",
        rev=pd_rev,
        traps=rng.randint(0, 1),
    )
    if mut in ("NEG-SPELL",):
        rd_names = pd_names
    if mut == "NEG-SYN":
        # другое написание того же материала: иной общий вариант названия, где он есть
        rd_names = []
        for ci, c in enumerate(rd):
            row = []
            for li, x in enumerate(c["layers"]):
                old = pd_names[ci][li]
                if x["m"] is None:
                    row.append(old)
                    continue
                alts = [v for v in _LV[x["m"]][0] + _LV[x["m"]][1] if v != old]
                row.append(rng.choice(alts) if alts else old)
            rd_names.append(row)
    rd_lines, _ = _layers_page(
        rng,
        param,
        rd,
        rd_fmt,
        "Р",
        base,
        reg=rd_reg,
        rev=rd_rev,
        names=rd_names,
        respell=rd_respell,
        traps=0,
    )
    return pd_lines, rd_lines, pd, rd, cls


def _layers_sample(rng, param):
    base = _base_code(rng)
    if rng.random() < 0.12:
        lines = sum((_wrap(rng, t) for t in rng.sample(_PAGE_TRAPS[param], 2)), [])
        return _page_noise(rng, param, lines, _cipher(rng, base, param, "П"), "П"), []
    k = rng.choice([1, 1, 1, 2, 2, 3])
    items = _items_for(rng, param, k)
    if k == 1 and rng.random() < 0.25:
        items = [None]
    comps = [_comp(rng, param, it) for it in items]
    fmt = rng.choice(["vyn", "vyn", "table", "inline", "pz"])
    rev = rng.random() < 0.2
    lines, _ = _layers_page(
        rng,
        param,
        comps,
        fmt,
        rng.choice("ПР"),
        base,
        reg=rng.choice(["gen", "gen", "det"]),
        rev=rev,
        traps=rng.randint(0, 2),
    )
    return lines, [_truth_comp(c) for c in comps]


# ========================================================================================================== API


_CAT_PAIR = {
    "M-072": _pipe_pair,
    "M-075": _pipe_pair,
    "M-079": _fan_pair,
    "M-050": _fin_pair,
    "M-130": _lum_pair,
}
_CAT_SAMPLE = {
    "M-072": _pipe_sample,
    "M-075": _pipe_sample,
    "M-079": _fan_sample,
    "M-050": _fin_sample,
    "M-130": _lum_sample,
}

_CAT_POS = ["MUT-07"]
_CAT_NEG = [
    "NEG-SAME",
    "NEG-SPELL",
    "NEG-SYN",
    "NEG-ANALOG",
    "NEG-CHARS",
    "NEG-DETAIL",
    "NEG-ORDER",
    "NEG-MORE",
]
_LAY_POS = ["MUT-08", "MUT-08", "MUT-07"]
_LAY_NEG = [
    "NEG-SAME",
    "NEG-SPELL",
    "NEG-SYN",
    "NEG-ANALOG",
    "NEG-ORDER",
    "NEG-MORE",
    "NEG-MORE",
    "NEG-DETAIL",
]


def _public_truth(ms: list[dict]) -> list[dict]:
    seen, out = set(), []
    for m in ms:
        k = (m["item"], m["element"], m["value"], tuple(m["alts"]), m["or_analog"])
        if k in seen:
            continue
        seen.add(k)
        out.append(
            {
                "item": m["item"],
                "element": m["element"],
                "value": m["value"],
                "alts": list(m["alts"]),
                "or_analog": m["or_analog"],
            }
        )
    return out


def samples(seed: int, n: int) -> list[dict]:
    rng = random.Random(seed)
    out = []
    for param in CATEGORY + LAYERS:
        for i in range(n):
            prng = random.Random(rng.getrandbits(64))
            if param in CATEGORY:
                lines, ms = _CAT_SAMPLE[param](prng, param)
                truth, kind = _public_truth(ms), "category"
            else:
                lines, truth = _layers_sample(prng, param)
                kind = "layers"
            out.append(
                {
                    "id": f"H176-S-{param}-{i:03d}",
                    "param": param,
                    "kind": kind,
                    "lines": lines,
                    "truth": truth,
                }
            )
    return out


def _pairs_struct(seed: int, n: int) -> list[dict]:
    rng = random.Random(seed)
    out = []
    for param in CATEGORY + LAYERS:
        is_cat = param in CATEGORY
        negs = _CAT_NEG if is_cat else _LAY_NEG
        if param == "M-079":  # у открытой марки нет синонимов и таблицы аналогов
            negs = [m for m in negs if m not in ("NEG-SYN", "NEG-ANALOG")]
        for want, muts in (
            (POS, _CAT_POS if is_cat else _LAY_POS),
            (NEG, negs),
        ):
            for i in range(n):
                prng = random.Random(rng.getrandbits(64))
                res = None
                for attempt in range(400):
                    # один вид мутации — до 25 попыток, затем следующий по кругу, чтобы виды не вытеснялись
                    mut = (
                        muts[(i + attempt // 25) % len(muts)]
                        if attempt < 25 * len(muts)
                        else prng.choice(muts)
                    )
                    try:
                        r = (_CAT_PAIR[param] if is_cat else _layers_pair)(
                            prng, param, mut
                        )
                    except (
                        IndexError
                    ):  # пустой список кандидатов замены — пробуем иначе
                        r = None
                    if r is None:
                        continue
                    pd_l, rd_l, pd_s, rd_s, cls = r
                    lab = (
                        _cat_label(param, pd_s, rd_s)
                        if is_cat
                        else _layers_label(param, pd_s, rd_s)
                    )
                    if lab == want:
                        res = (mut, pd_l, rd_l, pd_s, rd_s, cls)
                        break
                if res is None:
                    raise RuntimeError(f"не удалось построить пару {param} {want} #{i}")
                mut, pd_l, rd_l, pd_s, rd_s, cls = res
                out.append(
                    {
                        "id": f"H176-P-{param}-{'C' if want == POS else 'N'}{i:03d}",
                        "param": param,
                        "kind": "category" if is_cat else "layers",
                        "pd_lines": pd_l,
                        "rd_lines": rd_l,
                        "label": want,
                        "mutation": mut,
                        "cls": cls,
                        "_pd": pd_s,
                        "_rd": rd_s,
                    }
                )
    return out


def pairs(seed: int, n: int) -> list[dict]:
    return [
        {k: v for k, v in p.items() if not k.startswith("_")}
        for p in _pairs_struct(seed, n)
    ]


# ================================================================================================== самопроверка


def selfcheck(seed: int = 7, n: int = 60) -> dict:
    """Пересчёт меток по контракту, формат, детерминизм, счётчики. Бросает AssertionError при расхождении."""
    import collections

    s1, s2 = samples(seed, n), samples(seed, n)
    assert s1 == s2, "samples недетерминирован"
    ps = _pairs_struct(seed, n)
    assert pairs(seed, n) == pairs(seed, n), "pairs недетерминирован"
    allowed_el = {
        "M-072": {"main", "riser", "branch", None},
        "M-075": {"riser", "branch", "outlet", None},
        "M-079": {None},
        "M-050": {"wall", "floor", "ceiling"},
        "M-130": {None},
    }
    allowed_it = {
        "M-072": {"В1", "Т3", "Т4", None},
        "M-075": {"К1", "К2", None},
        "M-050": {None},
        "M-130": {None},
    }
    empty = collections.Counter()
    for s in s1:
        assert set(s) == {"id", "param", "kind", "lines", "truth"}
        assert s["lines"] and all(isinstance(x, str) for x in s["lines"])
        fam = FAMILY[s["param"]]
        if not s["truth"]:
            empty[s["param"]] += 1
        if s["kind"] == "category":
            for t in s["truth"]:
                assert set(t) == {"item", "element", "value", "alts", "or_analog"}
                assert t["element"] in allowed_el[s["param"]], t
                if s["param"] in allowed_it:
                    assert t["item"] in allowed_it[s["param"]], t
                if s["param"] != "M-079":
                    assert t["value"] in _canon(fam) and all(
                        a in _canon(fam) for a in t["alts"]
                    ), t
                else:
                    assert t["item"] and " ".join(t["value"].split()) in " ".join(
                        " ".join(s["lines"]).split()
                    ), t
        else:
            for c in s["truth"]:
                assert set(c) == {"item", "layers"} and c["layers"]
                for L in c["layers"]:
                    assert L["m"] is None or L["m"] in _canon(fam), L
                    assert L["t_max"] is None or (
                        L["t"] is not None and L["t_max"] > L["t"]
                    )
    cnt = collections.Counter()
    muts = collections.Counter()
    for p in ps:
        lab = (
            _cat_label(p["param"], p["_pd"], p["_rd"])
            if p["kind"] == "category"
            else _layers_label(p["param"], p["_pd"], p["_rd"])
        )
        assert lab == p["label"], (p["id"], lab, p["label"])
        assert p["mutation"].startswith("MUT") == (p["label"] == POS), p["id"]
        assert p["pd_lines"] != p["rd_lines"]
        cnt[(p["param"], p["label"])] += 1
        muts[(p["param"], p["mutation"])] += 1
    for param in CATEGORY + LAYERS:
        assert cnt[(param, POS)] == n and cnt[(param, NEG)] == n, (param, cnt)
        assert sum(1 for s in s1 if s["param"] == param) == n
    return {
        "samples": len(s1),
        "pairs": len(ps),
        "empty_truth": dict(empty),
        "mutations": dict(sorted(muts.items())),
        "cls": dict(collections.Counter((p["param"], p["cls"]) for p in ps)),
    }


if __name__ == "__main__":
    import pprint

    pprint.pprint(selfcheck(), width=160)
