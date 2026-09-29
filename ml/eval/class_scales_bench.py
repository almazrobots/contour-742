"""Синтетический стенд качества CMP-04 ORD-RANK / CMP-26 для 12 параметров-шкал W1 (T-172, каталог TO-BE §15).

Своя замена стенду мутаций T-179, пока его интерфейса нет в ветке: пары «ПД → РД (→ ИД)» из синтетических строк,
истинная метка известна по построению (мутация задаётся явно, а не функцией сравнения API — иначе проверка была бы
замкнута на себя). Извлечение — настоящий `extract_class_mentions` по паспорту; сравнение — настоящий
`evaluateClassParam` в `apps/api/scripts/class-scales-eval.ts`.

    cd ml && uv run python -m eval.class_scales_bench --n 100 --seed 1 --out ../var/class-scales/cases.jsonl
    cd apps/api && npx tsx scripts/class-scales-eval.ts ../../var/class-scales/cases.jsonl

Формат строки cases.jsonl (`inspector-class-bench/1`):

    {"schema", "param", "id", "label": 1|0, "kind": "MUT-06|MUT-07|CMP-26|NEG-01|BETTER|CONSTRAINT|NEIGHBOR|NORM_TABLE|MUT-18|ELEMENTS|CMP-26-OK",
     "docs": [{"stage": "PD|RD|ID", "discipline", "document_code", "role": "CURRENT|SUPERSEDED",
               "mentions": [{"value", "qualifier", "excluded", "excluded_why", "element", "page", "bbox", "quote", "confidence"}]}]}

label = 1 — в РД/ИД класс понижен (ожидается CANDIDATE), 0 — нет (ожидается NEGATIVE_VERIFIED).
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from inspector_ml.class_mentions import extract_class_mentions
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
SCHEMA = "inspector-class-bench/1"
W1 = [
    "M-015",
    "M-021",
    "M-022",
    "M-050",
    "M-055",
    "M-056",
    "M-057",
    "M-069",
    "M-103",
    "M-107",
    "M-109",
    "M-124",
]
NEIGHBOR = "Соседнее существующее здание, расположенное с северной стороны участка: "
HOMO = str.maketrans(
    {
        "А": "A",
        "В": "B",
        "С": "C",
        "Е": "E",
        "К": "K",
        "М": "M",
        "Н": "H",
        "Р": "P",
        "Т": "T",
        "Х": "X",
    }
)

# поверхность элемента в тексте: ключ паспорта → слово, которое ловит шаблон элемента
EL_CONCRETE = {
    "фундаменты": "Фундаментная плита",
    "колонны": "Колонны",
    "стены": "Стены",
    "перекрытия": "Плиты перекрытия",
    "лестницы": "Лестничные марши",
    "балки": "Балки",
}
EL_STEEL = {
    "колонны": "Колонны",
    "балки": "Балки",
    "связи": "Связи",
    "фермы": "Фермы",
    "прогоны": "Прогоны",
    "закладные": "Закладные детали",
}
EL_FINISH = {
    "лестничные клетки": "лестничных клеток",
    "вестибюли": "вестибюлей",
    "коридоры": "коридоров",
    "залы": "залов",
    "полы": "полов",
}
EL_FINISH107 = {
    "лестничные клетки": "в лестничных клетках",
    "вестибюли": "в вестибюлях",
    "коридоры": "в коридорах",
    "залы": "в залах",
    "полы": "для полов",
}
EL_POWER = {
    "СПЗ": "систем противопожарной защиты",
    "лифты": "лифтов",
    "ИТП": "ИТП",
    "насосные": "насосной станции",
    "аварийное освещение": "аварийного освещения",
}
EL_CABLE = {"СПЗ": "СПЗ", "освещение": "освещения", "силовые сети": "силовые"}
EL_SPZ = {
    "АПС": "АПС",
    "СОУЭ": "СОУЭ",
    "ПДЗ": "системы дымоудаления",
    "ППА": "ППА",
    "ВПВ": "ВПВ",
}
EL_DOOR = {
    "1-й тип": "двери 1-го типа",
    "2-й тип": "двери 2-го типа",
    "3-й тип": "двери 3-го типа",
    "лифты": "двери шахт лифтов",
    "ворота": "ворота",
    "люки": "люки",
}
ENERGY_NAME = {
    "A++": "высочайший",
    "A+": "высочайший",
    "A": "очень высокий",
    "B": "высокий",
    "C": "повышенный",
    "D": "нормальный",
    "E": "пониженный",
    "F": "низкий",
    "G": "очень низкий",
}


def _swap(rng: random.Random, v: str) -> str:
    """Написание значения: кириллица ↔ латиница у гомоглифов (NRM-03) — проверка нормализации, а не мутация."""
    return v.translate(HOMO) if rng.random() < 0.4 else v


def render(code: str, v: str, rng: random.Random) -> str:
    if code == "M-103":
        letters, mins = v.split()
        return f"{letters}{rng.choice(['', ' ', '-'])}{mins}"
    if code == "M-015" and v == "I (особая группа)":
        return rng.choice(["I (особая группа)", "особой группы I"])
    if code == "M-055" and "," in v and rng.random() < 0.3:
        v = v.replace(",", ".")
    return _swap(rng, v)


def line(
    code: str, v: str, el: str | None, rng: random.Random, marker: str = ""
) -> str:
    """Предложение документа с классом v (сырой вид) для элемента el; marker — «не ниже » и т. п."""
    r = marker + render(code, v, rng)
    if code == "M-015":
        who = EL_POWER.get(el or "", "здания")
        return f"Категория надежности электроснабжения электроприемников {who} – {r}."
    if code in ("M-021", "M-124"):
        return f"Класс энергетической эффективности здания – {r} ({ENERGY_NAME[v]})."
    if code == "M-022":
        return (
            rng.choice(
                [
                    f"Степень огнестойкости здания – {r}.",
                    f"Здание {r} степени огнестойкости.",
                ]
            )
            if not marker
            else f"Степень огнестойкости здания {r}."
        )
    if code == "M-050":
        return f"Отделка стен {EL_FINISH.get(el or '', 'помещений')} – {r}."
    if code == "M-107":
        return f"Класс пожарной опасности отделочных материалов {EL_FINISH107.get(el or '', 'на путях эвакуации')} – {r}."
    if code == "M-055":
        return f"{EL_CONCRETE.get(el or '', 'Монолитные конструкции')} – бетон класса {r} W8 F150."
    if code == "M-056":
        return f"{EL_STEEL.get(el or '', 'Металлоконструкции')} – сталь {r} по ГОСТ 27772-2015."
    if code == "M-057":
        return (
            f"{EL_CONCRETE.get(el or '', 'Конструкции')}: рабочая арматура класса {r}."
        )
    if code == "M-069":
        return (
            f"Сети {EL_CABLE.get(el or '', 'распределительные')}: кабель ВВГ{r} 3х2,5."
        )
    if code == "M-109":
        return f"Кабельные линии {EL_SPZ.get(el or '', 'СПЗ')} выполняются кабелем КПС{r} 1х2х0,75."
    if code == "M-103":
        return f"Противопожарные {EL_DOOR.get(el or '', 'двери')} – {r}."
    raise KeyError(code)


def norm_table(code: str, vals: list[str]) -> str | None:
    """Строка таблицы норм с тремя значениями подряд (отсев NORM_TABLE); у кабелей и дверей такого отсева нет."""
    if code in ("M-069", "M-109", "M-103"):
        return None
    joined = ", ".join(vals)
    return {
        "M-015": f"Категории надежности электроснабжения: {joined}.",
        "M-021": f"Класс энергетической эффективности по таблице: {joined}.",
        "M-124": f"Класс энергетической эффективности по таблице: {joined}.",
        "M-022": f"Степень огнестойкости по таблице: {joined}.",
        "M-050": f"Отделка по таблице норм: {joined}.",
        "M-107": f"Класс пожарной опасности отделочных материалов: {joined}.",
        "M-055": f"Классы бетона по таблице: {joined}.",
        "M-056": f"Сталь по таблице: {joined}.",
        "M-057": f"Арматура по таблице: {joined}.",
    }[code]


# ─────────────── мутации: явные операции понижения и повышения (метка по построению)


def _rank_moves(scale: list[str]):
    def down(rng, v):
        i = scale.index(v)
        return scale[rng.randrange(0, i)] if i > 0 else None

    def up(rng, v):
        i = scale.index(v)
        return scale[rng.randrange(i, len(scale))]

    return down, up


def _rebar_moves():
    num = {
        "А240": 240,
        "А300": 300,
        "А400": 400,
        "А400С": 400,
        "А500": 500,
        "А500С": 500,
        "А600": 600,
        "А600С": 600,
        "А800": 800,
        "А1000": 1000,
    }
    vals = list(num)

    def down(rng, v):  # MUT-06: ниже класс; MUT-07: потеря индекса С
        opts = [
            x
            for x in vals
            if num[x] < num[v] and (x.endswith("С") or not v.endswith("С"))
        ]
        if v.endswith("С"):
            opts.append(v[:-1])
        return rng.choice(opts) if opts else None

    def up(rng, v):
        return rng.choice(
            [
                x
                for x in vals
                if num[x] >= num[v] and (x.endswith("С") or not v.endswith("С"))
            ]
        )

    return down, up, vals


def _door_moves():
    mins = [15, 30, 45, 60, 90, 120]
    letters = ["E", "EI", "EIS", "EIW", "EIWS"]
    rank = {
        "E": {"E"},
        "EI": {"E", "I"},
        "EIW": {"E", "I"},
        "EIS": {"E", "I", "S"},
        "EIWS": {"E", "I", "S"},
    }

    def down(rng, v):
        let, m = v.split()
        m = int(m)
        if rng.random() < 0.5 and m > 15:  # MUT-06: меньше минут, буквы не лучше
            return f"{rng.choice([x for x in letters if rank[x] <= rank[let]])} {rng.choice([x for x in mins if x < m])}"
        worse = [
            x for x in letters if not rank[let] <= rank[x]
        ]  # MUT-07: потеряна буква
        return f"{rng.choice(worse)} {m}" if worse else None

    def up(rng, v):
        let, m = v.split()
        return f"{rng.choice([x for x in letters if rank[let] <= rank[x]])} {rng.choice([x for x in mins if x >= int(m)])}"

    return down, up, [f"{a} {m}" for a in letters for m in mins]


def _cable_moves():
    lad = ["нг(D)", "нг(С)", "нг(В)", "нг(А)"]
    suf = {
        "LS": {"LS"},
        "HF": {"HF"},
        "FRLS": {"FR", "LS"},
        "FRHF": {"FR", "HF"},
        "LSLTx": {"LS", "LTx"},
        "FRLSLTx": {"FR", "LS", "LTx"},
    }

    def split(v):
        a, s = v.split("-")
        return lad.index(a), s

    def down(rng, v):
        i, s = split(v)
        if rng.random() < 0.3 and i > 0:  # MUT-06: ниже категория пучка
            return f"{lad[rng.randrange(0, i)]}-{s}"
        worse = [x for x in suf if not suf[s] <= suf[x]]  # MUT-07: FRLS → LS
        return f"{lad[i]}-{rng.choice(worse)}"

    def up(rng, v):
        i, s = split(v)
        return f"{lad[rng.randrange(i, len(lad))]}-{rng.choice([x for x in suf if suf[s] <= suf[x]])}"

    return down, up, [f"{a}-{s}" for a in lad for s in suf]


def _steel_moves(scale: list[str]):
    """Сталь сравнивается по пределу текучести (ГОСТ 27772): С355П и С355К — не понижение друг друга."""
    num = {v: int("".join(ch for ch in v.split("-")[0] if ch.isdigit())) for v in scale}

    def down(rng, v):
        opts = [x for x in scale if num[x] < num[v]]
        return rng.choice(opts) if opts else None

    def up(rng, v):
        return rng.choice([x for x in scale if num[x] >= num[v]])

    return down, up, scale


def moves(code: str, scale: list[str]):
    if code == "M-056":
        return _steel_moves(scale)
    if code == "M-057":
        return _rebar_moves()
    if code == "M-103":
        return _door_moves()
    if code in ("M-069", "M-109"):
        return _cable_moves()
    down, up = _rank_moves(scale)
    return down, up, scale


# ─────────────── сборка документов и извлечение


def mk_doc(lines: list[str], seed: int) -> ParsedDoc:
    out = []
    for li, text in enumerate(lines):
        ws, x = [], 0.02
        for t in text.split(" "):
            w = min(0.004 * max(1, len(t)), 0.5)
            ws.append(
                Word(
                    text=t,
                    bbox=(
                        round(x, 5),
                        0.05 + 0.03 * li,
                        round(min(x + w, 1.0), 5),
                        0.07 + 0.03 * li,
                    ),
                )
            )
            x = min(x + w + 0.004, 0.99)
        out.append(Line(text=text, words=ws))
    return ParsedDoc(
        sha256=f"{seed:064d}",
        kind="pdf",
        engine="pdfium",
        pages=[Page(page=1, width=595, height=842, source="text", lines=out)],
    )


def spec(code: str, scales: dict) -> ParamSpec:
    pp = json.loads((ROOT / f"data/seed/passports/{code}.json").read_text("utf-8"))
    sc = scales[pp["value"]["scale_ref"]]
    ext = pp["extractor"] | {
        "scale": sc["values"],
        "constraint_markers": pp["value"]["constraint_markers"],
        "aliases": {**sc.get("aliases", {}), **pp["value"].get("aliases", {})},
    }
    return ParamSpec(
        code=code, anchors=[pp["title"]], data_type="string", extractor=ext
    )


DISC = {
    "PD": {
        "M-015": "ПЗ",
        "M-021": "ПЗ",
        "M-022": "ПЗ",
        "M-050": "АР",
        "M-055": "КР",
        "M-056": "КР",
        "M-057": "КР",
        "M-069": "ИОС",
        "M-103": "ПБ",
        "M-107": "ПБ",
        "M-109": "ПБ",
        "M-124": "ЭЭ",
    },
    "RD": {
        "M-015": "ЭОМ",
        "M-021": "АР",
        "M-022": "АР",
        "M-050": "АР",
        "M-055": "КЖ",
        "M-056": "КМ",
        "M-057": "КЖ",
        "M-069": "ЭОМ",
        "M-103": "АР",
        "M-107": "АР",
        "M-109": "ЭОМ",
        "M-124": "АР",
    },
}


def doc(
    code: str,
    sp: ParamSpec,
    stage: str,
    lines: list[str],
    seed: int,
    role: str = "CURRENT",
    suffix: str = "",
) -> dict:
    disc = DISC.get(stage, {}).get(code, "ИД")
    ms = extract_class_mentions(mk_doc(lines, seed), sp)
    return {
        "stage": stage,
        "discipline": disc,
        "document_code": f"{'П' if stage == 'PD' else 'Р' if stage == 'RD' else 'ИД'}-2099-01-001-{disc}{suffix}",
        "role": role,
        "lines": lines,
        "mentions": [
            {
                "value": e.value_text,
                "qualifier": e.meta["qualifier"],
                "excluded": e.meta["excluded"],
                "excluded_why": e.meta["excluded_why"],
                "element": e.meta.get("element"),
                "page": e.page,
                "bbox": list(e.bbox) if e.bbox else None,
                "quote": e.meta["quote"],
                "confidence": e.confidence,
            }
            for e in ms
        ],
    }


def cases(code: str, n: int, rng: random.Random, scales: dict) -> list[dict]:
    """n положительных и n отрицательных пар для параметра; виды мутаций — по кругу."""
    pp = json.loads((ROOT / f"data/seed/passports/{code}.json").read_text("utf-8"))
    sp = spec(code, scales)
    scale = scales[pp["value"]["scale_ref"]]["values"]
    down, up, pool = moves(code, scale)
    els = [e["key"] for e in pp["extractor"].get("elements", [])]
    cert = bool(pp["value"].get("cert_match"))
    marker = pp["value"]["constraint_markers"][0] + " "
    out: list[dict] = []
    seed = 0

    def pick_down():
        while True:
            a = rng.choice(pool)
            b = down(rng, a)
            if b is not None:
                return a, b

    def elements() -> list[str | None]:
        return rng.sample(els, k=min(len(els), rng.randint(1, 3))) if els else [None]

    def add(label, kind, docs):
        out.append(
            {
                "schema": SCHEMA,
                "param": code,
                "id": f"{code}:{kind}:{len(out)}",
                "label": label,
                "kind": kind,
                "docs": docs,
            }
        )

    pos_kinds = ["MUT-06"] + (["CMP-26"] if cert else [])
    neg_kinds = (
        ["NEG-01", "BETTER", "CONSTRAINT", "NEIGHBOR", "MUT-18"]
        + (["NORM_TABLE"] if norm_table(code, scale[:3]) else [])
        + (["ELEMENTS"] if els else [])
        + (["CMP-26-OK"] if cert else [])
    )
    for i in range(n):
        seed += 1
        kind = pos_kinds[i % len(pos_kinds)]
        es = elements()
        base = {e: rng.choice(pool) for e in es}
        hit = rng.choice(es)
        a, b = pick_down()
        base[hit] = a
        mut = {**base, hit: b}
        k = (
            "MUT-07"
            if kind == "MUT-06"
            and code in ("M-057", "M-069", "M-103", "M-109")
            and _lost_flag(code, a, b)
            else kind
        )
        pd = doc(code, sp, "PD", [line(code, base[e], e, rng) for e in es], seed)
        if kind == "CMP-26":
            rd = doc(
                code, sp, "RD", [line(code, base[e], e, rng) for e in es], seed + 1
            )
            idd = doc(code, sp, "ID", [line(code, mut[hit], hit, rng)], seed + 2)
            add(1, k, [pd, rd, idd])
        else:
            add(
                1,
                k,
                [
                    pd,
                    doc(
                        code,
                        sp,
                        "RD",
                        [line(code, mut[e], e, rng) for e in es],
                        seed + 1,
                    ),
                ],
            )
    for i in range(n):
        seed += 1
        kind = neg_kinds[i % len(neg_kinds)]
        es = elements()
        base = {e: rng.choice(pool) for e in es}
        pd_lines = [line(code, base[e], e, rng) for e in es]
        rd_vals = dict(base)
        extra: list[str] = []
        docs_extra: list[dict] = []
        if kind == "BETTER":
            rd_vals = {e: up(rng, v) for e, v in base.items()}
        elif kind == "CONSTRAINT":
            pd_lines = [line(code, base[e], e, rng, marker) for e in es]
            rd_vals = {e: up(rng, v) for e, v in base.items()}
        elif kind in ("NEIGHBOR", "NORM_TABLE", "MUT-18"):
            a, b = pick_down()
            e0 = es[0]
            base[e0] = a
            rd_vals = dict(base)
            pd_lines = [line(code, base[e], e, rng) for e in es]
            if kind == "NEIGHBOR":
                extra = [NEIGHBOR + line(code, b, e0, rng)]
            elif kind == "NORM_TABLE":
                extra = [norm_table(code, rng.sample(scale, 3))]
            else:
                docs_extra = [
                    doc(
                        code,
                        sp,
                        "RD",
                        [line(code, b, e0, rng)],
                        seed + 7,
                        role="SUPERSEDED",
                        suffix="-изм0",
                    )
                ]
        elif kind == "ELEMENTS":
            # разные классы разных элементов одной стадии — не противоречие и не понижение
            rd_vals = dict(base)
        pd = doc(code, sp, "PD", pd_lines, seed)
        rd = doc(
            code,
            sp,
            "RD",
            [line(code, rd_vals[e], e, rng) for e in es] + extra,
            seed + 1,
        )
        docs = [pd, rd, *docs_extra]
        if kind == "CMP-26-OK":
            docs.append(
                doc(
                    code,
                    sp,
                    "ID",
                    [line(code, up(rng, rd_vals[es[0]]), es[0], rng)],
                    seed + 2,
                )
            )
        add(0, kind, docs)
    return out


def _lost_flag(code: str, a: str, b: str) -> bool:
    """MUT-07 — замена марки с потерей признака (С, буква EI, индекс кабеля), а не только понижение числа."""
    if code == "M-057":
        return a.endswith("С") and not b.endswith("С")
    if code == "M-103":
        return a.split()[1] == b.split()[1]
    return a.split("-")[0] == b.split("-")[0]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--n", type=int, default=100, help="положительных и отрицательных на параметр"
    )
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--params", default=",".join(W1))
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    scales = json.loads((ROOT / "data/seed/scales.json").read_text("utf-8"))["scales"]
    rng = random.Random(a.seed)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with a.out.open("w", encoding="utf-8") as f:
        for code in a.params.split(","):
            for c in cases(code, a.n, rng, scales):
                f.write(json.dumps(c, ensure_ascii=False) + "\n")
                total += 1
    print(f"{total} пар → {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
