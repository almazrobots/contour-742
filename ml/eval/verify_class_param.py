"""Автоматическая верификация параметра-класса независимым пересчётом (OS-INSP-6.5.8, 6.5.9; T-129).

Независимость от системы — по пути, а не по спецификации: текст берётся из poppler (`pdftotext`, а система читает
pdfium), упоминания ищутся своими регулярными выражениями, стадия и раздел — по папке и имени файла, выбор источника
и сравнение по шкале написаны заново. Общая у системы и проверки только спецификация — паспорт параметра
(шкала, приоритет разделов, маркеры «не ниже»). Совпадение двух независимых путей — доказательство (qa-standard L2);
расхождение — стенд помечает выходной набор непроверенным и называет поле.

    uv run python -m eval.verify_class_param --package <папка пакета> --protocol protocol.json \\
        --passport ../data/seed/passports/M-023.json --out verification.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

STAGE_DIRS = {"проектная": "PD", "рабочая": "RD", "исполнительная": "ID"}
LAT2CYR = str.maketrans({"C": "С", "c": "С", "O": "0", "О": "0", "o": "0", "о": "0"})
MARKS = [
    "ПЗУ",
    "ОПЗ",
    "ПЗ",
    "ПБ",
    "АР",
    "КР",
    "КЖ",
    "КМ",
    "ПОС",
    "ООС",
    "ОДИ",
    "ТБЭО",
    "БЭО",
    "ЭЭ",
    "ТХ",
    "ОВ",
    "ВК",
    "ИОС",
    "ПГМ",
]
ANCHOR = re.compile(r"конструктивн\w*\s+пожарн\w*\s+опасност\w*", re.I)
SENTENCE_END = re.compile(r"[.!?]\s+(?=[А-ЯЁA-Z])")
NUMBER = re.compile(r"\d+(?:[.,/]\d+)*")
VALUE = re.compile(r"(?<![А-Яа-яA-Za-z0-9])([СC])\s?([0-3ОO])(?![0-9А-Яа-яA-Za-z])")
# соседнее здание: сторона света, адрес, кадастровый номер, расстояние до него — перед упоминанием или сразу после
NEIGHBOR = re.compile(
    r"(находится|расположен\w*)\s+(с|к|в)\s+\w*(север|юг|запад|восток)|кадастров|расстояни\w*\s*[–—-]?\s*\d|соседн|существующ\w*\s+здани",
    re.I,
)


@dataclass
class Mention:
    file: str
    sha256: str
    stage: str
    discipline: str | None
    base: str | None
    page: int
    value: str
    minimum: bool
    neighbor: bool


@dataclass
class Pick:
    chosen: Mention | None
    values: set[str] = field(default_factory=set)


def stage_of(path: Path) -> str | None:
    for part in reversed(path.parts[:-1]):
        for k, v in STAGE_DIRS.items():
            if part.lower().startswith(k):
                return v
    return None


def discipline_of(name: str) -> str | None:
    """Раздел из имени файла: последняя марка, стоящая отдельным словом после шифра или «Раздел N»."""
    up = name.upper().replace("СПОЗУ", "ПЗУ").replace("ОПЗ", "ПЗ")
    hits = [
        (m.start(), mark)
        for mark in MARKS
        for m in re.finditer(rf"(?<![А-ЯA-Z]){mark}(?![А-Я])", up)
    ]
    return max(hits)[1] if hits else None


def base_of(name: str) -> str | None:
    """Базовый шифр: «2025-04.266» и «2025-04-266» — один комплект; для «ЖС-РД-270121-П-…» — часть до стадии."""
    up = name.upper()
    m = re.search(r"(\d{4})[-.](\d{2})[-.](\d{3})", up)
    if m:
        return "-".join(m.groups())
    m = re.search(r"([А-Я]{2}-[А-Я]{2}[-_]\d{4,6}(?:[-_]\d{4})?)[-_]П[-_]", up)
    return m.group(1).replace("_", "-") if m else None


def page_texts(pdf: Path) -> list[str]:
    out = subprocess.run(
        ["pdftotext", "-q", str(pdf), "-"], capture_output=True, text=True, timeout=600
    ).stdout
    return out.split("\f")


def mentions_in(
    text: str, markers: list[str], window: int = 160
) -> list[tuple[str, bool, bool]]:
    """Упоминания класса на странице: (класс, «не ниже», соседнее здание). Текст склеивается в одну строку."""
    t = re.sub(r"\s+", " ", text)
    anchors = list(ANCHOR.finditer(t))
    out = []
    for i, a in enumerate(anchors):
        end = min(
            a.end() + window, anchors[i + 1].start() if i + 1 < len(anchors) else len(t)
        )
        # значение — в том же предложении: «опасности. Кадастровый номер…» — уже другая фраза
        stop = SENTENCE_END.search(t, a.end(), end)
        if stop:
            end = stop.start() + 1
        v = VALUE.search(t, a.end(), end)
        if not v:
            continue
        if len(NUMBER.findall(t[a.end() : v.start()])) >= 3:
            continue  # между оборотом и значением ряд чисел — ячейка таблицы норм, а не класс здания
        seg = t[a.end() : v.end() + 40]
        if len(VALUE.findall(seg)) >= 3:
            continue  # таблица нормативных значений
        val = (v.group(1) + v.group(2)).translate(LAT2CYR)
        pre = t[max(0, a.start() - 40) : v.start()].lower()
        ctx = t[max(0, a.start() - 120) : v.end() + 40]
        out.append((val, any(m in pre for m in markers), bool(NEIGHBOR.search(ctx))))
    return out


def scan(package: Path, markers: list[str]) -> list[Mention]:
    res: list[Mention] = []
    for pdf in sorted(package.rglob("*.pdf")):
        st = stage_of(pdf.relative_to(package))
        if not st:
            continue
        sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
        for n, txt in enumerate(page_texts(pdf), start=1):
            for val, mn, nb in mentions_in(txt, markers):
                res.append(
                    Mention(
                        str(pdf.relative_to(package)),
                        sha,
                        st,
                        discipline_of(pdf.name),
                        base_of(pdf.name),
                        n,
                        val,
                        mn,
                        nb,
                    )
                )
    return res


def rank_src(order: list[str], d: str | None) -> int:
    return (
        order.index(d)
        if d in order
        else (order.index("*") if "*" in order else len(order))
    )


def pick(ms: list[Mention], stage: str, pp: dict, rd_bases: set[str]) -> Pick:
    scale = pp["value"]["scale"]
    order = [s["discipline"] for s in pp["sources"][stage]]
    use = [m for m in ms if m.stage == stage and not m.neighbor and m.value in scale]
    if stage == "PD" and rd_bases:
        linked = [m for m in use if m.base in rd_bases]
        use = linked or use
    better = -1 if stage == "PD" else 1
    use.sort(
        key=lambda m: (
            rank_src(order, m.discipline),
            m.minimum,
            better * -scale.index(m.value),
            m.file,
            m.page,
        )
    )
    return Pick(use[0] if use else None, {m.value for m in use})


def oracle(ms: list[Mention], pp: dict) -> dict:
    scale = pp["value"]["scale"]
    rd_bases = {m.base for m in ms if m.stage == "RD" and m.base}
    pd, rd = pick(ms, "PD", pp, rd_bases), pick(ms, "RD", pp, rd_bases)
    if not pd.chosen or not rd.chosen:
        status = "MISSING_EVIDENCE"
    else:
        status = (
            "CANDIDATE"
            if scale.index(rd.chosen.value) < scale.index(pd.chosen.value)
            else "NEGATIVE_VERIFIED"
        )
    show = lambda m: (
        None if m is None else (f"не ниже {m.value}" if m.minimum else m.value)
    )  # noqa: E731
    return {
        "status": status,
        "PD": show(pd.chosen),
        "RD": show(rd.chosen),
        "pd_pick": pd,
        "rd_pick": rd,
        "pd_conflict": len(pd.values) > 1,
    }


def compare(system: dict, orc: dict, ms: list[Mention]) -> list[dict]:
    """Поля сверки: статус, значения стадий и доказательства (файл по SHA-256 и страница выбранного упоминания)."""
    frag = {f["role"]: f for f in system.get("sources", [])}
    fields = [
        {"field": "status", "system": system.get("status"), "oracle": orc["status"]},
        {"field": "PD", "system": system.get("expected"), "oracle": orc["PD"]},
        {"field": "RD", "system": system.get("actual"), "oracle": orc["RD"]},
    ]
    if "pd_conflict" in system:
        yes = lambda v: "есть" if v else "нет"  # noqa: E731
        fields.append({"field": "PD.internal_conflict", "system": yes(system["pd_conflict"]), "oracle": yes(orc["pd_conflict"])})
    for role, stage in (("expected", "PD"), ("actual", "RD")):
        f = frag.get(role)
        chosen = orc["pd_pick" if stage == "PD" else "rd_pick"].chosen
        sys_ref = f"{f['sha256'][:12]}@{f['page']}" if f else None
        orc_ref = f"{chosen.sha256[:12]}@{chosen.page}" if chosen else None
        # равноценные упоминания того же значения в том же разделе — не расхождение доказательства
        same = (
            chosen
            and f
            and any(
                m.sha256 == f["sha256"]
                and m.page == f["page"]
                and m.value == chosen.value
                and m.discipline == chosen.discipline
                for m in ms
            )
        )
        fields.append(
            {
                "field": f"{stage}.evidence",
                "system": sys_ref,
                "oracle": orc_ref,
                "ok_override": bool(same),
            }
        )
    out = []
    for x in fields:
        # «равноценно» — только когда указатели действительно разные; совпавшие помечать незачем
        eq = bool(x.pop("ok_override", None)) and x["system"] != x["oracle"]
        # ok — для отчёта скрипта; сервер его не учитывает и считает совпадение сам, «равноценно» — только для *.evidence
        out.append({**x, "ok": eq or x["system"] == x["oracle"], **({"equivalent": True} if eq else {})})
    return out


SECTION_STATUS = {
    "candidates": "CANDIDATE",
    "confirmed_violations": "CONFIRMED_VIOLATION",
    "negative_verified": "NEGATIVE_VERIFIED",
    "missing_evidence": "MISSING_EVIDENCE",
}


def system_check(protocol: dict, code: str, inspection: dict | None = None) -> dict:
    """Результат системы по параметру. Статус — из записи или из раздела протокола (в «нет расхождения» записи короткие,
    без статуса и источников). Доказательства — из источников записи, иначе из фрагментов проверки (GET /inspections/:id)."""
    for name, sec in protocol.get("sections", {}).items():
        if name == "completeness":
            continue
        for c in sec if isinstance(sec, list) else []:
            if c.get("param_code") == code:
                out = {**c, "status": c.get("status") or c.get("finding_status") or SECTION_STATUS.get(name)}
                if not out.get("sources") and inspection:
                    chk = next((x for x in inspection.get("checks", []) if x.get("param_code") == code), None)
                    out["sources"] = [
                        {"role": f["role_expected_actual"], "sha256": f["sha256"], "page": f["sheet_page"]}
                        for f in (chk or {}).get("fragments", [])
                    ]
                if inspection is not None:
                    # гипотеза «внутреннее противоречие ПД» (OS-INSP-3.1.12) — сверяется с независимым выводом оракула
                    out["pd_conflict"] = any(
                        (x.get("description") or "").startswith(f"{code}: Внутреннее противоречие ПД")
                        for x in inspection.get("suspicions", [])
                    )
                return out
    raise SystemExit(f"в протоколе нет записи {code}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--package", required=True, type=Path)
    ap.add_argument("--protocol", required=True, type=Path)
    ap.add_argument("--passport", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--inspection", type=Path, help="GET /api/v1/inspections/:id — фрагменты доказательств, если их нет в протоколе")
    a = ap.parse_args(argv)
    pp = json.loads(a.passport.read_text())
    ms = scan(a.package, pp["value"]["constraint_markers"])
    orc = oracle(ms, pp)
    fields = compare(
        system_check(json.loads(a.protocol.read_text()), pp["code"], json.loads(a.inspection.read_text()) if a.inspection else None), orc, ms
    )
    res = {
        "param_code": pp["code"],
        "method": "pdftotext (poppler) + независимые regex и выбор источника; спецификация — паспорт",
        "verdict": "MATCH" if all(f["ok"] for f in fields) else "MISMATCH",
        "fields": fields,
        "oracle": {
            "status": orc["status"],
            "PD": orc["PD"],
            "RD": orc["RD"],
            "pd_internal_conflict": orc["pd_conflict"],
            "mentions": len(ms),
        },
    }
    a.out.write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print(
        res["verdict"],
        *(f"{f['field']}: {f['system']} | {f['oracle']}" for f in fields),
        sep="\n",
    )
    return 0 if res["verdict"] == "MATCH" else 2


if __name__ == "__main__":
    sys.exit(main())
