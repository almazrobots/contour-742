"""DEV-набор фраз T-176: на нём настраиваются паспорта, написания справочника и экстракторы CMP-05 и CMP-21.
Итоговое качество — только на отложенном `holdout.py` (написан отдельно, без знания экстракторов). API и метки —
по контракту `__init__.py`; метки вычисляются из data/seed/analogs.json по правилам контракта. Только вымышленные
объекты, шифры и числа (ADR-0002).
"""

from __future__ import annotations

import json
import random
from pathlib import Path

CATEGORY = ["M-050", "M-072", "M-075", "M-079", "M-130"]
LAYERS = ["M-032", "M-044", "M-125", "M-128"]
ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
FAM = json.loads((ROOT / "data/seed/analogs.json").read_text("utf-8"))["families"]
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
STAMP = [
    "Изм. Кол.уч. Лист №док. Подп. Дата",
    "Разраб. Сидоров",
    "ГИП Петрова",
    "Стадия П Лист Листов",
]

# ------------------------------------------------------------------ вердикт по контракту


def _worse(ch: dict, a, b) -> bool | None:
    if ch["kind"] == "ordinal":
        sc = ch["scale"]
        if a not in sc or b not in sc:
            return None
        return sc.index(b) < sc.index(a)
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        return None
    t = ch.get("tol_rel", 0)
    return b < a * (1 - t) if ch["better"] == "up" else b > a * (1 + t)


def verdict(fam: str, a: str, b: str) -> str:
    f = FAM[fam]
    if a == b:
        return "EQUIVALENT"
    for r in f["analogs"]:
        if r["from"] == a and r["to"] == b:
            return r["verdict"]
    d = f.get("derive")
    ca, cb = f["canon"].get(a), f["canon"].get(b)
    if (
        d
        and ca
        and cb
        and (d.get("any_group") or ca["group"] == cb["group"])
        and all(k in ca["chars"] and k in cb["chars"] for k in d["chars"])
    ):
        worse = [
            _worse(f["chars"][k], ca["chars"][k], cb["chars"][k]) for k in d["chars"]
        ]
        if None not in worse:
            return "NOT_EQUIVALENT" if any(worse) else "EQUIVALENT"
    return "UNKNOWN"


def chars_worse(
    fam: str, a: str, b: str, ta: dict | None = None, tb: dict | None = None
) -> bool | None:
    f = FAM[fam]
    ca = {**f["canon"].get(a, {}).get("chars", {}), **(ta or {})}
    cb = {**f["canon"].get(b, {}).get("chars", {}), **(tb or {})}
    res = [
        _worse(f["chars"][k], ca[k], cb[k]) for k in f["chars"] if k in ca and k in cb
    ]
    res = [x for x in res if x is not None]
    return any(res) if res else None


# ------------------------------------------------------------------ написания (DEV — свои, не holdout)

SPELL = {
    "pipe_pressure": {
        "STEEL_GALV": [
            "стальные водогазопроводные оцинкованные трубы по ГОСТ 3262-75",
            "трубы стальные оцинкованные",
            "оцинкованные стальные трубы",
            "ВГП оц. Ду25",
        ],
        "STEEL_STAINLESS": [
            "трубы из нержавеющей стали",
            "нержавеющие гофрированные трубы",
            "трубы нерж. сталь AISI 304",
        ],
        "COPPER": ["медные трубы по ГОСТ Р 52318-2005", "трубы медные"],
        "PPR": [
            "полипропиленовые трубы PP-R PN20",
            "трубы PPR",
            "трубы из полипропилена",
            "ППР трубы",
        ],
        "PPR_FIBER": [
            "трубы PP-R, армированные стекловолокном",
            "полипропиленовые трубы, армированные алюминием",
            "трубы PP-R GF PN20",
        ],
        "PEX": ["трубы из сшитого полиэтилена PE-Xa", "трубы PEX", "сшитый полиэтилен"],
        "PERT": ["трубы PE-RT", "трубы из полиэтилена повышенной термостойкости"],
        "MLP": [
            "металлополимерные трубы",
            "металлопластиковые трубы PEX-AL-PEX",
            "трубы PE-RT/AL/PE-RT",
        ],
        "PE": ["трубы ПЭ 100 SDR17 по ГОСТ 18599-2001", "полиэтиленовые трубы ПЭ100"],
        "PVC_U": ["трубы НПВХ напорные", "трубы PVC-U"],
        "CAST_IRON_DUCT": [
            "трубы ВЧШГ",
            "трубы из высокопрочного чугуна с шаровидным графитом",
        ],
    },
    "pipe_sewer": {
        "CAST_IRON_SML": [
            "безраструбные чугунные трубы SML",
            "трубы SML",
            "чугунные безраструбные трубы",
        ],
        "CAST_IRON": [
            "чугунные канализационные трубы по ГОСТ 6942-98",
            "трубы чугунные раструбные",
        ],
        "PP_NOISE": [
            "малошумные трубы Sinikon Comfort Plus",
            "малошумные полипропиленовые трубы",
            "трубы Raupiano Plus",
            "трёхслойные трубы с минеральным наполнителем",
        ],
        "PP": [
            "полипропиленовые канализационные трубы по ГОСТ 32414-2013",
            "трубы ПП",
            "трубы PP-HT",
        ],
        "PVC": ["трубы ПВХ", "трубы из НПВХ", "поливинилхлоридные трубы"],
        "PE_HD": ["трубы ПНД", "полиэтиленовые трубы низкого давления"],
    },
    "luminaire": {
        "LED": [
            "светодиодные светильники",
            "светильник светодиодный ДПО 01-36-001",
            "LED-светильники",
            "светильник ДВО 12-40",
        ],
        "FLUOR": [
            "люминесцентные светильники ЛПО 2х36",
            "светильник ЛСП 22-2х58",
            "светильники с люминесцентными лампами",
        ],
        "CFL": [
            "светильники с компактными люминесцентными лампами",
            "светильник с КЛЛ",
        ],
        "INCAND": ["светильники с лампами накаливания", "светильник НПП 03-100"],
        "HALOGEN": ["галогенные прожекторы", "прожектор ИО 04-500"],
        "DRL": ["светильники с лампами ДРЛ", "светильник РСП 17-250"],
        "HPS": ["светильники ДНаТ", "светильник ЖКУ 21-150"],
        "MH": ["светильники с лампами ДРИ", "прожектор ГСП 05-400"],
    },
    "finish": {
        "PAINT_WD": [
            "окраска водно-дисперсионной краской",
            "окраска ВД-АК краской",
            "вододисперсионная акриловая краска",
        ],
        "PLASTER_MINERAL": ["штукатурка гипсовая", "цементно-песчаная штукатурка"],
        "DECOR_PLASTER": ["декоративная штукатурка", "фактурная штукатурка"],
        "CERAMIC_TILE": ["керамическая плитка", "облицовка керамической плиткой"],
        "PORCELAIN": ["керамогранит", "плиты керамогранитные"],
        "WALLPAPER_VINYL": ["виниловые обои", "флизелиновые обои"],
        "WALLPAPER_GLASS": ["стеклообои под окраску", "стеклохолст"],
        "PVC_PANEL": ["панели ПВХ", "пластиковые панели"],
        "MDF_PANEL": ["панели МДФ"],
        "GKL": ["гипсокартон", "листы ГКЛ", "ГКЛВ"],
        "LINOLEUM_COMM": [
            "коммерческий линолеум",
            "линолеум коммерческий гетерогенный",
        ],
        "LINOLEUM_HOUSE": ["бытовой линолеум"],
        "LAMINATE": ["ламинат 33 класса"],
        "CARPET": ["ковролин", "ковровая плитка"],
        "EPOXY": ["наливной полимерный пол", "эпоксидное покрытие"],
        "ARMSTRONG": [
            "подвесной потолок Armstrong",
            "минераловатные плиты потолка типа Армстронг",
        ],
        "STRETCH_PVC": ["натяжной потолок ПВХ"],
        "RACK_AL": ["реечный алюминиевый потолок"],
    },
}
FAN_MODELS = [
    "Systemair K 315 M",
    "Вентс ВКП 60-35-4Д",
    "ВКР-5,0",
    "ВЦ 14-46-2,5",
    "Ровен ВКП 50-30",
    "Korf WNK 60-35/31.4D",
    "Shuft RFE 400x200-4",
    "Salda RIS 700 PE",
    "ВЕЗА ВРАН6-040",
    "Арктос КВАРК-П 50-25",
]
RESPELL = {
    "Systemair K 315 M": "SYSTEMAIR K315M",
    "ВКР-5,0": "ВКР 5,0",
    "ВЦ 14-46-2,5": "ВЦ14-46-2,5",
    "Salda RIS 700 PE": "Salda RIS700PE",
    "Shuft RFE 400x200-4": "Shuft RFE 400х200-4",
}

ITEMS = {
    "M-072": [
        (
            "В1",
            [
                "В1",
                "системы хозяйственно-питьевого водопровода В1",
                "В1 (хоз.-питьевой водопровод)",
            ],
        ),
        ("Т3", ["Т3", "горячего водоснабжения Т3", "Т3 (ГВС)"]),
        ("Т4", ["Т4", "циркуляционного трубопровода Т4"]),
    ],
    "M-075": [
        ("К1", ["К1", "бытовой канализации К1"]),
        ("К2", ["К2", "внутренних водостоков К2"]),
    ],
}
ELEMS = {
    "M-072": [
        ("riser", "стояки"),
        ("branch", "подводки к приборам"),
        ("main", "магистрали"),
    ],
    "M-075": [
        ("riser", "стояки"),
        ("branch", "отводные трубопроводы"),
        ("outlet", "выпуски"),
    ],
    "M-050": [("wall", "стены"), ("floor", "пол"), ("ceiling", "потолок")],
}
SUBJECT = {
    "M-072": "трубы",
    "M-075": "трубы",
    "M-130": "светильники",
    "M-050": "отделка",
    "M-079": "вентилятор",
}
TRAPS = {
    "M-072": [
        "Трубопроводы отопления Т1, Т2 выполнить из стальных водогазопроводных оцинкованных труб.",
        "Существующие трубы водопровода из чугуна подлежат демонтажу.",
        "Допускается применение полипропиленовых труб по СП 30.13330.2020.",
    ],
    "M-075": [
        "Наружные сети канализации выполнить из полипропиленовых гофрированных труб.",
        "Существующие чугунные трубы канализации демонтируются.",
        "Трубопроводы водопровода В1 — стальные оцинкованные.",
    ],
    "M-130": [
        "Не допускается применение светильников с лампами накаливания.",
        "Существующие светильники ЛПО демонтируются.",
    ],
    "M-050": [
        "Существующая отделка стен из панелей ПВХ демонтируется.",
        "Не допускается применение горючих отделочных материалов на путях эвакуации.",
    ],
    "M-079": [
        "Существующий вентилятор ВЦ 4-75 демонтируется.",
        "Сплит-система Daikin FTXB35C для серверной.",
    ],
}


def _cipher(r: random.Random, stage: str, disc: str) -> str:
    return f"ДВ-{r.randint(10, 99)}/{r.randint(20, 26)}-{'П' if stage == 'PD' else 'РД'}-{disc}"


def _disc(param: str, stage: str) -> str:
    return {
        "M-072": ("ИОС2", "ВК"),
        "M-075": ("ИОС3", "ВК"),
        "M-130": ("ИОС1", "ЭО"),
        "M-050": ("АР", "АР"),
        "M-079": ("ИОС4", "ОВ"),
        "M-044": ("АР", "АР"),
        "M-125": ("АР", "АР"),
        "M-128": ("АР", "АР"),
        "M-032": ("ПЗУ", "ГП"),
    }[param][0 if stage == "PD" else 1]


def _page(r: random.Random, param: str, stage: str, body: list[str]) -> list[str]:
    head = [
        _cipher(r, stage, _disc(param, stage)),
        r.choice(
            [
                "Общие указания",
                "Спецификация оборудования, изделий и материалов",
                "Пояснительная записка",
                "Ведомость",
            ]
        ),
    ]
    return head + body + STAMP[: r.randint(1, 4)] + [str(r.randint(2, 40))]


# ------------------------------------------------------------------ CMP-05: упоминание → строки


def _spell(r: random.Random, param: str, key: str) -> str:
    return r.choice(SPELL[FAMILY[param]][key]) if param != "M-079" else key


def _chars_text(param: str, chars: dict) -> str:
    if param == "M-079":
        return (
            f", L = {chars['flow']} м³/ч, Р = {chars['pressure']} Па" if chars else ""
        )
    if param == "M-072" and "pn" in chars:
        return f" PN{int(chars['pn'])}"
    return ""


def render_cat(r: random.Random, param: str, ms: list[dict]) -> list[str]:
    """Упоминания (item, element, value, alts, or_analog, chars) → строки страницы одним из форматов."""
    fmt = r.choice(["prose", "spec", "list"])
    out: list[str] = []
    subj = SUBJECT[param]
    for m in ms:
        val = (
            _spell(r, param, m["value"])
            + "".join(f" или {_spell(r, param, a)}" for a in m.get("alts", []))
            + _chars_text(param, m.get("chars", {}))
        )
        if m.get("or_analog"):
            val += r.choice([" или аналог", " (или аналог)", " или эквивалент"])
        it = m.get("item_text") or m.get("item") or ""
        el = dict(ELEMS.get(param, [])).get(m.get("element"), "")
        if param == "M-079":
            if fmt == "spec":
                out.append(f"{m['item']} | Приточная установка | {val} | 1 | шт.")
            else:
                out.append(f"Для системы {m['item']} принят вентилятор {val}.")
            continue
        if param == "M-050":
            room = r.choice(
                [
                    "Коридор 1.05",
                    "Лестничная клетка ЛК-1",
                    "Вестибюль 1.01",
                    "Лифтовой холл 2.03",
                ]
            )
            surf = el or r.choice(["стены", "потолок"])
            if fmt == "spec" and r.random() < 0.5:
                cells = {"потолок": 1, "стены": 3, "пол": 5}
                row = [room, "—", "", "—", "", "—", ""]
                row[cells[surf]] = val
                row[cells[surf] + 1] = str(r.randint(20, 300))
                out += ["Помещение | Потолок | Площадь, м2 | Стены и перегородки | Площадь, м2 | Пол | Площадь, м2", " | ".join(row)]
            elif fmt == "spec":
                out.append(f"{room} | {surf[:1].upper() + surf[1:]} | {val} | м2 | {r.randint(20, 300)}")
            else:
                out.append(f"{room}: {surf} — {val}.")
            continue
        if param == "M-130":
            if fmt == "spec":
                out.append(
                    f"{r.randint(1, 30)} | {val} | IP20 | шт. | {r.randint(5, 200)}"
                )
            else:
                out.append(f"Для освещения помещений предусмотрены {val}.")
            continue
        # трубы
        if fmt == "spec":
            if it:
                out.append(f"Система {it}")
            out.append(
                f"{r.randint(1, 40)} | {(el + ' — ') if el else ''}{val[:1].upper() + val[1:]} Ø{r.choice([20, 25, 32, 40, 50, 110])} | м | {r.randint(10, 900)}"
            )
        elif fmt == "list":
            out.append(f"Для системы {it}:" if it else "Трубопроводы:")
            out.append(
                f"- {el or r.choice(['магистральные трубопроводы', 'трубопроводы'])} — {val};"
            )
        else:
            where = f" системы {it}" if it else ""
            lead = f"{el[:1].upper() + el[1:]}{where}" if el else f"Трубопроводы{where}"
            out.append(
                f"{lead} выполнить из {val}."
                if r.random() < 0.5
                else f"{lead} приняты {subj} {val}."
            )
    return out


def _mention(r: random.Random, param: str) -> dict:
    fam = FAMILY[param]
    if param == "M-079":
        return {
            "item": f"{r.choice(['П', 'В', 'ПВ'])}{r.randint(1, 12)}",
            "element": None,
            "value": r.choice(FAN_MODELS),
            "alts": [],
            "or_analog": False,
            "chars": {},
        }
    keys = list(FAM[fam]["canon"])
    items = ITEMS.get(param)
    it = r.choice(items) if items and r.random() < 0.8 else None
    el = r.choice(ELEMS[param])[0] if param in ELEMS and r.random() < 0.5 else None
    m = {
        "item": it[0] if it else None,
        "element": el,
        "value": r.choice(keys),
        "alts": [],
        "or_analog": False,
        "chars": {},
    }
    if it:
        m["item_text"] = r.choice(it[1])
    return m


def samples(seed: int, n: int) -> list[dict]:
    r = random.Random(seed)
    out: list[dict] = []
    for param in CATEGORY + LAYERS:
        for i in range(n):
            if param in LAYERS:
                st = _stack(r, param)
                out.append(
                    {
                        "id": f"dev-s-{param}-{i}",
                        "param": param,
                        "kind": "layers",
                        "lines": _page(r, param, "PD", render_stack(r, param, st)),
                        "truth": [{"item": st["item"], "layers": _truth_layers(st)}],
                    }
                )
                continue
            if r.random() < 0.15:
                out.append(
                    {
                        "id": f"dev-s-{param}-{i}",
                        "param": param,
                        "kind": "category",
                        "lines": _page(r, param, "PD", [r.choice(TRAPS[param])]),
                        "truth": [],
                    }
                )
                continue
            ms = [_mention(r, param)]
            body = render_cat(r, param, ms)
            if r.random() < 0.3:
                body = [r.choice(TRAPS[param])] + body
            truth = [
                {k: m[k] for k in ("item", "element", "value", "alts", "or_analog")}
                for m in ms
            ]
            out.append(
                {
                    "id": f"dev-s-{param}-{i}",
                    "param": param,
                    "kind": "category",
                    "lines": _page(r, param, "PD", body),
                    "truth": truth,
                }
            )
    return out


def _cat_label(param: str, pd: dict, rd: dict) -> str:
    fam = FAMILY[param]
    if param == "M-079":
        fold = lambda s: "".join(
            ch
            for ch in s.upper().translate(str.maketrans("АВЕКМНОРСТУХ", "ABEKMHOPCTYX"))
            if ch.isalnum()
        )  # noqa: E731
        if fold(pd["value"]) == fold(rd["value"]):
            return "NEGATIVE_VERIFIED"
        if pd["or_analog"]:
            w = chars_worse(fam, "", "", pd["chars"], rd["chars"])
            return "CANDIDATE" if w else "NEGATIVE_VERIFIED"
        return "CANDIDATE"
    if rd["value"] in [pd["value"], *pd["alts"]]:
        return "NEGATIVE_VERIFIED"
    if pd["or_analog"]:
        return (
            "CANDIDATE"
            if chars_worse(fam, pd["value"], rd["value"], pd["chars"], rd["chars"])
            else "NEGATIVE_VERIFIED"
        )
    return (
        "NEGATIVE_VERIFIED"
        if any(
            verdict(fam, v, rd["value"]) == "EQUIVALENT"
            for v in [pd["value"], *pd["alts"]]
        )
        else "CANDIDATE"
    )


def _cat_pair(r: random.Random, param: str, want: str) -> tuple[dict, dict, str]:
    fam = FAMILY[param]
    for _ in range(200):
        pd = _mention(r, param)
        rd = dict(pd)
        if param == "M-079":
            kind = r.choice(["same", "spell", "other", "analog"])
            if kind == "spell" and pd["value"] in RESPELL:
                rd["value"] = RESPELL[pd["value"]]
            elif kind == "other":
                rd["value"] = r.choice([m for m in FAN_MODELS if m != pd["value"]])
            elif kind == "analog":
                pd["or_analog"] = True
                pd["chars"] = {
                    "flow": r.choice([1500, 2500, 4000]),
                    "pressure": r.choice([200, 300, 450]),
                }
                rd["value"] = r.choice([m for m in FAN_MODELS if m != pd["value"]])
                k = r.choice([0.8, 1.0, 1.2])
                rd["chars"] = {
                    "flow": int(pd["chars"]["flow"] * k),
                    "pressure": pd["chars"]["pressure"],
                }
                rd["or_analog"] = False
            mut = {
                "same": "NEG-SAME",
                "spell": "NEG-SPELL",
                "other": "MUT-07",
                "analog": "NEG-CHARS",
            }[kind]
        else:
            keys = list(FAM[fam]["canon"])
            kind = r.choice(["same", "subst", "subst", "analog_or", "alts"])
            if kind == "subst":
                rd["value"] = r.choice(keys)
            elif kind == "analog_or":
                pd["or_analog"] = True
                rd["value"] = r.choice(keys)
            elif kind == "alts":
                pd["alts"] = [r.choice([k for k in keys if k != pd["value"]])]
                rd["value"] = r.choice([pd["value"], *pd["alts"]])
            mut = "NEG-SAME"
        lab = _cat_label(param, pd, rd)
        if param != "M-079":
            if lab == "CANDIDATE":
                mut = "MUT-07"
            elif rd["value"] == pd["value"]:
                mut = r.choice(["NEG-SAME", "NEG-SPELL"])
            elif pd["or_analog"]:
                mut = "NEG-CHARS"
            else:
                mut = "NEG-ANALOG"
        if (
            pd["or_analog"]
            and param != "M-079"
            and chars_worse(fam, pd["value"], rd["value"], pd["chars"], rd["chars"])
            is None
        ):
            continue
        if lab == want:
            return pd, rd, mut
    raise RuntimeError("не удалось построить пару")


# ------------------------------------------------------------------ CMP-21: составы

ROOF = [
    [
        (
            "MEMBRANE_PVC",
            1.5,
            ["Мембрана ПВХ Logicroof V-RP", "Полимерная мембрана ПВХ"],
        ),
        ("GEOTEXTILE", None, ["Геотекстиль иглопробивной 300 г/м²"]),
        ("INSUL_MW", 50, ["Техноруф В60"]),
        ("INSUL_MW", 150, ["Техноруф Н30"]),
        ("VAPOR_BITUMEN", 3, ["Пароизоляция Бикроэласт ТПП"]),
        ("PROFILED_SHEET", None, ["Профлист Н75-750-0,8"]),
    ],
    [
        ("BITUMEN_POLYMER", 4, ["Техноэласт ЭКП"]),
        ("BITUMEN_POLYMER", 3, ["Унифлекс ЭПП"]),
        ("PRIMER", None, ["Праймер битумный"]),
        ("SCREED_CS", 50, ["Стяжка из ЦПР М150, армированная сеткой"]),
        ("SLOPE_CLAYDITE", 30, ["Уклонообразующий слой из керамзитового гравия"], 200),
        ("INSUL_XPS", 100, ["Экструзионный пенополистирол Техноплекс"]),
        ("VAPOR_PE", 0.2, ["Пароизоляция — полиэтиленовая плёнка"]),
        ("SLAB_RC", 200, ["Монолитная ж/б плита покрытия"]),
    ],
    [
        ("PAVING_TILE", 60, ["Тротуарная плитка на опорах"]),
        ("DRAIN_MEMBRANE", None, ["Профилированная мембрана PLANTER"]),
        ("INSUL_XPS", 120, ["XPS CARBON PROF"]),
        ("GEOTEXTILE", None, ["Геотекстиль"]),
        ("MEMBRANE_TPO", 2, ["Мембрана ТПО Logicroof T-SL"]),
        ("SLAB_RC", 220, ["Железобетонная плита"]),
    ],
]
ATTIC = [
    [
        ("SCREED_CS", 40, ["Защитная стяжка из цементно-песчаного раствора"]),
        ("SEPARATION", None, ["Разделительный слой — полиэтиленовая плёнка"]),
        ("INSUL_MW", 200, ["Минераловатные плиты Технолайт"]),
        ("VAPOR_PE", 0.2, ["Пароизоляционная плёнка"]),
        ("SLAB_RC", 200, ["Железобетонная плита перекрытия"]),
    ],
    [
        ("INSUL_CLAYDITE", 250, ["Засыпка керамзитом"]),
        ("VAPOR_MEMBRANE", None, ["Пароизоляционная мембрана Изоспан В"]),
        ("SLAB_RC", 220, ["Плита перекрытия ж/б"]),
    ],
]
WALL = [
    [
        ("FACADE_PORCELAIN", 10, ["Облицовка керамогранитом на подсистеме"]),
        ("AIR_GAP", 40, ["Вентилируемый воздушный зазор"]),
        ("WIND_BARRIER", None, ["Ветрозащитная мембрана"]),
        ("INSUL_MW", 150, ["Минераловатные плиты Техновент Стандарт"]),
        ("WALL_GASBLOCK", 300, ["Кладка из газобетонных блоков D500"]),
        ("PLASTER_INT", 20, ["Внутренняя штукатурка"]),
    ],
    [
        ("PLASTER_THIN", 8, ["Тонкослойная штукатурка по армирующей сетке"]),
        ("INSUL_MW", 120, ["Минеральная вата Технофас Эффект"]),
        ("WALL_RC", 200, ["Монолитная ж/б стена"]),
        ("PLASTER_INT", 15, ["Гипсовая штукатурка"]),
    ],
]
ROAD = [
    [
        (
            "ASPHALT_FINE_DENSE",
            50,
            ["Асфальтобетон мелкозернистый плотный тип Б марки II"],
        ),
        ("BITUMEN_EMULSION", None, ["Розлив битумной эмульсии 0,5 л/м²"]),
        (
            "ASPHALT_COARSE_POROUS",
            70,
            ["Асфальтобетон пористый крупнозернистый марки II"],
        ),
        (
            "CRUSHED_STONE",
            200,
            ["Щебень фракции 40-70 мм, устроенный по способу заклинки"],
        ),
        ("SAND_DRAIN", 300, ["Песок средней крупности Кф ≥ 1 м/сут"]),
        ("GEOTEXTILE", None, ["Геотекстиль Дорнит"]),
    ],
    [
        ("PAVING", 80, ["Бетонная тротуарная плитка"]),
        ("SAND_CEMENT_BED", 40, ["Пескоцементная смесь"]),
        ("CRUSHED_STONE_MIX", 150, ["Щебёночно-песчаная смесь С4"]),
        ("SAND_DRAIN", 200, ["Песок средней крупности"]),
    ],
]
STACKS = {"M-044": ROOF, "M-128": ATTIC, "M-125": WALL, "M-032": ROAD}
HEAD = {
    "M-044": ["Состав кровли {it}", "Пирог кровли {it}", "Конструкция покрытия {it}"],
    "M-128": [
        "Состав чердачного перекрытия {it}",
        "Конструкция перекрытия над чердаком {it}",
    ],
    "M-125": ["Состав наружной стены {it}", "Конструкция наружной стены {it}"],
    "M-032": ["Конструкция дорожной одежды {it}", "Тип дорожной одежды {it}"],
}
MARK = {
    "M-044": ["Кр-1", "Кр-2", "К-3"],
    "M-128": ["П-1", "ПК-2"],
    "M-125": ["НС-1", "НС-2"],
    "M-032": ["тип 1", "тип 2", "ДО-1"],
}


def _stack(r: random.Random, param: str) -> dict:
    base = r.choice(STACKS[param])
    ls = [
        {
            "m": x[0],
            "t": x[1],
            "t_max": x[3] if len(x) > 3 else None,
            "raw": r.choice(x[2]),
        }
        for x in base
    ]
    return {"item": r.choice(MARK[param]) if r.random() < 0.8 else None, "layers": ls}


def _merged(ls: list[dict]) -> list[dict]:
    out: list[dict] = []
    for x in ls:
        if out and out[-1]["m"] == x["m"]:
            p = out[-1]
            p["t"] = (
                (p["t"] or 0) + (x["t"] or 0)
                if p["t"] is not None and x["t"] is not None
                else None
            )
        else:
            out.append(dict(x))
    return out


def _truth_layers(st: dict) -> list[dict]:
    return [{"m": x["m"], "t": x["t"], "t_max": x["t_max"]} for x in st["layers"]]


def _t(x: dict, r: random.Random) -> str:
    if x["t"] is None:
        return ""
    v = x["t"]
    s = f"{v:g}".replace(".", ",") if r.random() < 0.7 else f"{v:g}"
    if x.get("t_max"):
        return f" – {s}…{x['t_max']:g} мм"
    return (
        r.choice([f" – {s} мм", f", δ={s} мм", f" {s} мм", f" (h={s})"])
        if v >= 1
        else f" – {s} мм"
    )


def render_stack(
    r: random.Random, param: str, st: dict, rev: bool | None = None
) -> list[str]:
    it = st["item"] or ""
    head = r.choice(HEAD[param]).format(it=it).strip()
    ls = st["layers"]
    rev = (r.random() < 0.2) if rev is None else rev
    order = list(reversed(ls)) if rev else ls
    marker = (
        (" (" + ("изнутри наружу" if param == "M-125" else "снизу вверх") + ")")
        if rev
        else ""
    )
    fmt = r.choice(["callout", "table", "inline"])
    if fmt == "inline":
        return [
            head
            + marker
            + ": "
            + "; ".join(x["raw"].lower() + _t(x, r) for x in order)
            + "."
        ]
    if fmt == "table":
        out = [head + marker, "№ | Наименование слоя | Толщина, мм"]
        for i, x in enumerate(order, 1):
            t = (
                ""
                if x["t"] is None
                else (
                    f"{x['t']:g}".replace(".", ",")
                    + (f"-{x['t_max']:g}" if x.get("t_max") else "")
                )
            )
            out.append(f"{i} | {x['raw']} | {t}")
        return out
    out = [head + marker + ":"]
    for i, x in enumerate(order, 1):
        out.append(f"{i}. {x['raw']}{_t(x, r)}")
    return out


def _lay_label(fam: str, pd: dict, rd: dict) -> str:
    """Метка по контракту на слоях, выровненных по построению (одинаковые позиции генератора)."""
    a, b = _merged(pd["layers"]), _merged(rd["layers"])
    am = [x["m"] for x in a]
    bm = [x["m"] for x in b]
    if [m for m in am if m in bm] != [m for m in bm if m in am]:
        return "CANDIDATE"  # перестановка
    for x in a:
        y = next((z for z in b if z["m"] == x["m"]), None)
        if y is None:
            sub = rd.get("_sub", {}).get(x["m"])
            if sub is None:
                return "CANDIDATE"  # слой удалён
            if verdict(fam, x["m"], sub) != "EQUIVALENT":
                return "CANDIDATE"
            y = next(z for z in b if z["m"] == sub)
        if x["t"] is not None and y["t"] is not None and y["t"] < x["t"] - 0.5:
            return "CANDIDATE"
    return "NEGATIVE_VERIFIED"


def _lay_pair(r: random.Random, param: str, want: str) -> tuple[dict, dict, str]:
    fam = FAMILY[param]
    keys = list(FAM[fam]["canon"])
    for _ in range(300):
        pd = _stack(r, param)
        rd = {"item": pd["item"], "layers": [dict(x) for x in pd["layers"]], "_sub": {}}
        kind = r.choice(
            [
                "same",
                "thin",
                "thick",
                "delete",
                "insert",
                "reorder",
                "subst",
                "spell",
                "reverse",
                "merge",
            ]
        )
        ls = rd["layers"]
        i = r.randrange(len(ls))
        if kind == "thin" and ls[i]["t"]:
            ls[i]["t"] = round(ls[i]["t"] * r.choice([0.5, 0.75]), 1)
        elif kind == "thick" and ls[i]["t"]:
            ls[i]["t"] = round(ls[i]["t"] * 1.5, 1)
        elif kind == "delete" and len(ls) > 2:
            del ls[i]
        elif kind == "insert" and (fam == "road_layers" and "GEOTEXTILE" not in [x["m"] for x in ls] or fam != "road_layers" and "SEPARATION" not in [x["m"] for x in ls]):
            ls.insert(
                i,
                {
                    "m": "SEPARATION" if fam != "road_layers" else "GEOTEXTILE",
                    "t": None,
                    "t_max": None,
                    "raw": "Разделительный слой — стеклохолст"
                    if fam != "road_layers"
                    else "Геотекстиль",
                },
            )
        elif kind == "reorder" and i + 1 < len(ls) and ls[i]["m"] != ls[i + 1]["m"]:
            ls[i], ls[i + 1] = ls[i + 1], ls[i]
        elif kind == "subst":
            grp = FAM[fam]["canon"][ls[i]["m"]]["group"]
            same = [
                k
                for k in keys
                if FAM[fam]["canon"][k]["group"] == grp
                and k != ls[i]["m"]
                and k not in [x["m"] for x in ls]
                and k not in ("SLAB_RC", "WALL_RC")  # у стены паспорт уточняет канон (remap)
            ]
            if not same:
                continue
            k = r.choice(same)
            rd["_sub"][ls[i]["m"]] = k
            ls[i] = {
                "m": k,
                "t": ls[i]["t"],
                "t_max": ls[i]["t_max"],
                "raw": FAM[fam]["canon"][k]["title"][:1].upper() + FAM[fam]["canon"][k]["title"][1:],
            }
        elif kind == "merge":
            ms = _merged(ls)
            ls[:] = ms
        elif kind in ("same", "spell", "reverse"):
            pass
        else:
            continue
        lab = _lay_label(fam, pd, rd)
        mut = (
            ("MUT-08" if kind in ("thin", "delete", "reorder") else "MUT-07")
            if lab == "CANDIDATE"
            else {
                "same": "NEG-SAME",
                "spell": "NEG-SPELL",
                "reverse": "NEG-ORDER",
                "thick": "NEG-MORE",
                "insert": "NEG-MORE",
                "subst": "NEG-ANALOG",
                "merge": "NEG-DETAIL",
            }.get(kind, "NEG-SAME")
        )
        if lab == want:
            rd["_rev"] = kind == "reverse"
            return pd, rd, mut
    raise RuntimeError("не удалось построить пару")


def pairs(seed: int, n: int) -> list[dict]:
    r = random.Random(seed + 1)
    out: list[dict] = []
    for param in CATEGORY + LAYERS:
        for want in ("CANDIDATE", "NEGATIVE_VERIFIED"):
            for i in range(n):
                if param in LAYERS:
                    pd, rd, mut = _lay_pair(r, param, want)
                    pl = _page(r, param, "PD", render_stack(r, param, pd, rev=False))
                    rl = _page(
                        r,
                        param,
                        "RD",
                        render_stack(r, param, rd, rev=rd.get("_rev") or None),
                    )
                    out.append(
                        {
                            "id": f"dev-p-{param}-{want[0]}-{i}",
                            "param": param,
                            "kind": "layers",
                            "pd_lines": pl,
                            "rd_lines": rl,
                            "label": want,
                            "mutation": mut,
                            "cls": mut,
                        }
                    )
                    continue
                pd, rd, mut = _cat_pair(r, param, want)
                pl = _page(r, param, "PD", render_cat(r, param, [pd]))
                rl = _page(r, param, "RD", render_cat(r, param, [rd]))
                out.append(
                    {
                        "id": f"dev-p-{param}-{want[0]}-{i}",
                        "param": param,
                        "kind": "category",
                        "pd_lines": pl,
                        "rd_lines": rl,
                        "label": want,
                        "mutation": mut,
                        "cls": mut,
                        "pd_truth": pd["value"],
                        "rd_truth": rd["value"],
                    }
                )
    return out
