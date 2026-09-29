"""Синтетический объект «132 параметра, 14 нарушений» (OS-INSP-6.5.16, ТЗ 9.3.6, T-081).

Объект замера полного цикла верификации: в протоколе все 132 параметра Матрицы, ровно 14 из них — кандидаты в
нарушения. Детерминирован по seed: seed выбирает, какие 14, и значения; повторная генерация даёт те же байты.

Устройство — поверх фабрики v3 (генераторы значений всех 132 параметров) и общей отрисовки v2 (synth/factory.py):

- все параметры применимы (профиль: жильё, подземная часть, газ, снос — да), у каждого три стадии ПД/РД/ИД;
- документ = раздел Матрицы на стадии (дисциплина документа = раздел параметра): система берёт значение только из
  профильного раздела (OS-INSP-2.2.21), документ «ПЗ» с параметрами КР дал бы MISSING_EVIDENCE вместо сверки;
- раздел длиннее ROWS_MAX строк делится на части (ПЗ.1, ПЗ.2): таблица ТЭП помещается на один лист;
- 14 нарушений выбираются по seed только среди параметров, где нарушение достижимо (две стадии для сравнения
  или правило min/max, и домен умеет сравнить значения — detectable); у нарушения значение последней стадии хуже, у остальных стадии совпадают;
- без сканов: объект для людей, OCR-шум замеру времени не нужен и сделал бы «ровно 14» зависимым от распознавания.

Метку эталона ставит зеркало домена eval/decide.py по истинным значениям (как в v2/v3), answer-key.json выводится
из эталона — «14» проверяется по нему, а не по намерению генератора.

    uv run python -m synth.usability_132 --seed 1 --out ../var/usability   # из каталога ml/

Пакет в репозиторий не кладётся (51 PDF, ~7 МБ: печати и подписи растром): его байты по seed стабильны, e2e и стенд
генерируют его сами. И не в data/synth: тот набор раздаёт заглушка «РиН» и демо, счётчики их тестов на него завязаны.
"""

from __future__ import annotations

import argparse
import json
import random
import time
from pathlib import Path

from synth import factory as F
from synth import factory_v3 as V3
from synth import forms_w3 as W3
from synth import w2_text as W2

OBJECT_ID = "OBJ-USB-132"
TAG = "synth-usb132"
N_VIOLATIONS = 14
ROWS_MAX = 22  # строк ТЭП на лист, как GROUP фабрики v3
STAGE_RU = {"PD": "П", "RD": "Р", "ID": "ИД"}
TITLES = {
    "PD": "Раздел {}. Основные показатели",
    "RD": "Рабочая документация {}. Общие данные",
    "ID": "Исполнительная документация {}. Сводные показатели",
}
STATUS = {"PD": "APPROVED", "RD": "FOR_CONSTRUCTION", "ID": "APPROVED"}
# Подпись строки ТЭП вместо самого короткого якоря v3 — там, где система читает параметр по паспорту (T-132): якорь
# паспорта М-005 требует «…подземной части», и «Строительный объем (Подземный)» система не находит (MISSING_EVIDENCE).
LABELS = {
    "M-005": "Строительный объём подземной части",
    **W2.active(),
}  # T-191: паспорта количества W2, принятые из draft/


def is_reachable(p: dict) -> bool:
    """Может ли параметр дать «нарушение»: сравнение требует двух стадий, порог min/max нарушается и одной."""
    from eval.decide import STAGES, stage_required

    n = sum(stage_required(p, s) for s in STAGES)
    return n >= 2 or (n == 1 and p["compare"]["kind"] in ("min", "max"))


def detectable(code: str) -> bool:
    """Видит ли зеркало домена нарушение, которое пишет генератор: «хуже» на последней стадии → CANDIDATE.

    Не у всех параметров: шкала класса в Матрице кириллицей, а extract отдаёт код латиницей (М-023), у перечисления
    без шкалы нет порядка (М-072) — такие параметры домен честно не сравнивает (NOT_COMPARABLE), нарушением их не делаем.
    """
    from eval.decide import StageValue, evaluate

    V3.install()
    p = F.MATRIX[code]
    r = random.Random(f"{TAG}:detectable:{code}")
    v = F.POOL[code]["base"](r)
    st = V3.stages_of(p)
    vals = [v] * (len(st) - 1) + [F.worse(code, v, r)]
    used = [
        StageValue(s, *F.as_stage_value(code, x), "", s, 1, None, "CURRENT")
        for s, x in zip(st, vals)
    ]
    return evaluate(p, {}, used, set(st)).status == "CANDIDATE"


def reachable() -> list[str]:
    """Параметры, где нарушение достижимо: хватает стадий и домен умеет сравнить значения."""
    return sorted(c for c, p in F.MATRIX.items() if is_reachable(p) and detectable(c))


PENDING_FILE = Path(__file__).with_name("usability_132_pending.json")


def pending() -> dict[str, dict]:
    """Переходный список (T-210): параметры с паспортом вида, чью форму генератор ещё не рисует, — код → запись.

    Генератор пишет параметр строкой «Подпись: значение»; паспортный экстрактор такого вида (таблица графика, ведомость
    дверей, продольный профиль) её законно не читает, и система честно ставит MISSING_EVIDENCE. Список явный и только
    сокращается (храповик — tests/test_usability_132_pending.py): форма, которая бывает в реальных документах, сюда не
    идёт — её обязан читать экстрактор.
    """
    return {
        e["code"]: e for e in json.loads(PENDING_FILE.read_text("utf-8"))["pending"]
    }


def pick_violations(seed: int) -> list[str]:
    """Ровно N_VIOLATIONS параметров-нарушений, детерминированно по seed; параметры из переходного списка нарушением
    не выбираются. Выбор без них прежний: переигрывается, только если прежний выбор задел переходный список."""
    r = random.Random(f"{TAG}:{seed}:pick")
    pool = reachable()
    picked = r.sample(pool, N_VIOLATIONS)
    skip = pending()
    if skip.keys() & set(picked):
        picked = [c for c in r.sample(pool, len(pool)) if c not in skip][:N_VIOLATIONS]
    return sorted(picked)


def chunks(codes: list[str]) -> list[tuple[str, list[str]]]:
    """(раздел, параметры) по документам: раздел по алфавиту, внутри — по коду, не длиннее ROWS_MAX."""
    by: dict[str, list[str]] = {}
    for c in sorted(codes):
        by.setdefault(F.MATRIX[c]["section"], []).append(c)
    out = []
    for sec in sorted(by):
        lst = by[sec]
        n = -(-len(lst) // ROWS_MAX)  # частей
        size = -(-len(lst) // n)  # поровну: 23 → 12 + 11, а не 22 + 1
        out += [(sec, lst[i : i + size]) for i in range(0, len(lst), size)]
    return out


def make_object(seed: int, i: int = 1):
    """Объект, документы, базовые значения — сигнатура make фабрики (F.build_object)."""
    V3.install()
    r = random.Random(f"{TAG}:{seed}")
    bad = set(pick_violations(seed))
    codes = sorted(F.MATRIX)
    pfx = "".join(r.choice(F.PREFIX) for _ in range(2)) + str(r.randint(1, 99))
    base = {c: F.POOL[c]["base"](r) for c in codes}
    stages = {c: V3.stages_of(F.MATRIX[c]) for c in codes}
    scen = {c: "pos" if c in bad else "neg" for c in codes}
    values: dict[tuple[str, str], object] = {}
    for c in codes:
        st, minmax = stages[c], F.MATRIX[c]["compare"]["kind"] in ("min", "max")
        for n, s in enumerate(st):
            v = base[c]
            if c in bad and n == len(st) - 1:
                v = F.worse(c, base[c], r)
            elif n > 0 or minmax:
                v = F.same(c, base[c], r)
            values[(s, c)] = v
    docs = []
    for s in ("PD", "RD", "ID"):
        parts = chunks([c for c in codes if s in stages[c]])
        count: dict[str, int] = {}
        for sec, _ in parts:
            count[sec] = count.get(sec, 0) + 1
        seen: dict[str, int] = {}
        for n, (sec, lst) in enumerate(parts, 1):
            seen[sec] = k = seen.get(sec, 0) + 1
            suffix = f".{k}" if count[sec] > 1 else ""
            docs.append(
                F.Doc(
                    f"USB-{s}-{n:02d}",  # латиница и номер: имя файла без кириллицы, как у data/synth
                    s,
                    sec,
                    # Все стадии относятся к одному вымышленному комплекту.
                    # Шифр ИД без литеры стадии: стадия задана в manifest.
                    f"{STAGE_RU[s] + '-' if s != 'ID' else ''}2099-01-{pfx[2:]}-{sec}{suffix}",
                    "1",
                    STATUS[s],
                    F._date(r, {"PD": 2024, "RD": 2025, "ID": 2026}[s], 1, 6),
                    TITLES[s].format(sec + suffix),
                    [(c, values[(s, c)]) for c in lst],
                )
            )
    obj = {
        "object_id": OBJECT_ID,
        "name": f"Вымышленный объект {pfx} (юзабилити-тест, 132 параметра)",
        "profile": {
            "residential": True,
            "underground": True,
            "gas": True,
            "demolition": True,
        },
        "scenarios": scen,
        "conflict_kr": False,
    }
    return obj, docs, base


def ordinal_scale(code: str) -> list[str] | None:
    """Шкала паспорта параметра-класса (data/seed/passports, value.kind = ordinal) или None."""
    f = F.ROOT / "data/seed/passports" / f"{code}.json"
    if not f.exists():
        return None
    v = json.loads(f.read_text("utf-8"))["value"]
    if v.get("kind") != "ordinal":
        return None
    if "scale" in v:
        return v["scale"]
    # T-172: шкала по ссылке value.scale_ref — справочник data/seed/scales.json (как resolveScaleRef в passport.ts)
    ref = json.loads((F.ROOT / "data/seed/scales.json").read_text("utf-8"))["scales"]
    return ref[v["scale_ref"]]["values"] if v.get("scale_ref") in ref else None


def system_label(group: dict, gold: dict) -> str:
    """Статус, который выдаст система. Совпадает с эталоном зеркала, кроме параметра-класса с паспортом (М-023):
    зеркало сравнивает латинизированный код с кириллической шкалой Матрицы и даёт NOT_COMPARABLE, а система
    (domain/class-param.ts) сравнивает класс по шкале паспорта — пересчитываем по исходной записи значения."""
    from eval.decide import StageValue, evaluate

    scale = ordinal_scale(group["param"])
    if group["label"] != "NOT_COMPARABLE" or not scale:
        return group["label"]
    raw = {(v["file_id"], v["param"]): v["raw"] for v in gold["values"]}
    used = [
        StageValue(
            e["stage"],
            None,
            raw[(e["file_id"], group["param"])],
            "",
            e["file_id"],
            e["page"],
            e["bbox"],
            "CURRENT",
        )
        for e in group["evidence"]
    ]
    param = {**F.MATRIX[group["param"]], "value_scale": scale}
    return evaluate(
        param, gold["profile"], used, {e["stage"] for e in group["evidence"]}
    ).status


def draft_w3_codes() -> set[str]:
    """Параметры с паспортной формой W3, чей паспорт лежит в draft/: форма нарисована, а система паспорт не читает."""
    return {
        p.stem for p in (F.ROOT / "data/seed/passports/draft").glob("M-*.json")
    } & W3.FORMS.keys()


def answer_key(gold: dict) -> dict[str, str]:
    """Ключ ответов в формате data/synth/*/answer-key.json: параметр → ожидаемый статус сверки системы, плюс сценарий."""
    # паспорт без цифр замера лежит в data/seed/passports/draft/ и системой не читается (вариант А владельца, T-233):
    # форма в PDF может быть нарисована (фабрика строит формы и по черновикам), но у применимого параметра значения нет
    # только паспортные формы W3 (наличие, направление, способ): их не читает лексический путь, у остальных черновиков
    # система по-прежнему находит значение обычным поиском — ожидание не меняется
    skip = pending().keys() | draft_w3_codes()
    # переходный список: форму генератора паспортный экстрактор не читает — у применимого параметра значения нет
    key = {
        e["param"]: "MISSING_EVIDENCE"
        if e["param"] in skip and e["label"] != "NOT_APPLICABLE"
        else system_label(e, gold)
        for e in gold["evidence_groups"]
    }
    stages = {f["doc_stage"] for f in gold["files"]}
    key["scenario"] = "FULL" if stages == {"PD", "RD", "ID"} else "PARTIALLY_LOADED"
    return key


def build(seed: int, out: Path) -> dict:
    """Пакет в out/OBJECT_ID: PDF, manifest.json, gold.json, answer-key.json. Возвращает эталон."""
    out.mkdir(parents=True, exist_ok=True)
    V3.install()
    saved = {c: F.POOL[c] for c in LABELS}
    F.POOL.update({c: W2.entry(c, lbl) for c, lbl in LABELS.items()})
    try:  # общий пул фабрики не меняется: объекты v2/v3 после этого объекта те же
        gold = F.build_object(seed, 1, out, make=make_object, tag=TAG)
    finally:
        F.POOL.update(saved)
    gold["generator"] = "ml/synth/usability_132.py"
    d = out / OBJECT_ID
    (d / "gold.json").write_text(
        json.dumps(gold, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    (d / "answer-key.json").write_text(
        json.dumps(answer_key(gold), ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return gold


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(
        description="Объект «132 параметра, 14 нарушений» (OS-INSP-6.5.16, ТЗ 9.3.6)"
    )
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument(
        "--out",
        type=Path,
        default=F.ROOT / "var/usability",
        help="каталог; пакет — в <out>/" + OBJECT_ID,
    )
    a = ap.parse_args(argv)
    t = time.perf_counter()
    gold = build(a.seed, a.out)
    labels = [e["label"] for e in gold["evidence_groups"]]
    pages = sum(f["pages"] for f in gold["files"])
    print(
        f"{OBJECT_ID}: {len(labels)} параметра, {labels.count('CANDIDATE')} нарушений; "
        f"{len(gold['files'])} документов, {pages} листов → {a.out / OBJECT_ID} за {time.perf_counter() - t:.1f} с"
    )


if __name__ == "__main__":
    main()
