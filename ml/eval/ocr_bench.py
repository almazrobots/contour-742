"""Стенд качества OCR по ТЗ 9.1.1 и 14.3 (OS-INSP-6.5.18; TZA-9.1.1-02/03/04/06).

Набор — синтетические сканы печатного текста 300 и 400 dpi без текстового слоя, с искажениями реального скана:
наклон, размытие, шум, сжатие JPEG. На каждой странице — штамп с ключевыми полями (шифр, стадия, редакция, лист,
номер помещения) и связный текст ПЗ с числами, марками и шифрами. Отдельно — страницы, испорченные до нечитаемости:
по ним проверяется, что система помечает их LOW_QUALITY/ABSTAIN, а не выдаёт мусор за текст (TZA-9.1.1-05/06).

Метрики — отношения сумм счётчиков, ДИ 95 % — бутстрап по документам (eval/ci.py):
  Character Accuracy = 1 − CER; CER — Левенштейн после Unicode NFC и схлопывания пробелов, знаки и регистр не
  трогаются (eval/metrics.py::norm_text — TZA-9.1.1-04); WER; Exact Match по каждому виду ключевого поля
  (политика нормализации поля — FIELD_POLICY) и в целом; coverage — доля эталонных полей с ответом системы и доля
  страниц с полученным текстом; доля нечитаемых зон — страниц LOW_QUALITY/ABSTAIN и сомнительных слов OCR.
Вердикт — пороги §14 (thresholds.py): CA ≥ 0,95, EM ≥ 0,90.

Только синтетика (ADR-0002). OCR тяжёлый — запуск через scripts/heavy.sh (правило №0):
    uv run python -m eval.ocr_bench [--docs 12] [--pages 3] [--seed 1] [--out ../var/ocr-bench.json] [--md ../docs/qa/OCR-9.1.1.md]
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import platform
import random
import tempfile
import time
from collections import Counter
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from inspector_ml.extract import rooms
from inspector_ml.paths import repo_root

from . import ci as ci_mod
from .metrics import char_errors, norm_field, word_errors
from .run import key_fields, page_reading
from .thresholds import THRESHOLDS, passes

FONT = repo_root() / "assets/fonts/NotoSans.ttf"
FIELDS = ("code", "stage", "revision", "sheet", "room")
FIELD_RU = {
    "code": "шифр",
    "stage": "стадия",
    "revision": "редакция",
    "sheet": "лист",
    "room": "номер помещения",
}
BODY = [
    "Здание запроектировано {n}-этажным с техническим подпольем.",
    "Площадь застройки составляет {a} м², строительный объём {v} м³.",
    "Класс бетона фундаментной плиты B{b}, арматура класса A500С.",
    "Степень огнестойкости здания II, класс конструктивной пожарной опасности С0.",
    "Ширина эвакуационного выхода не менее {w} м согласно СП 1.13130.2020.",
    "Предел огнестойкости перекрытий REI {r}, стен лестничной клетки REI 120.",
    "Толщина наружной стены {t} мм, утеплитель — минеральная вата {u} мм.",
    "Высота этажа {h} м, отметка чистого пола первого этажа 0,000.",
]


def _field_values(r: random.Random, doc_no: int, page_no: int) -> dict[str, str]:
    return {
        "code": f"{r.choice(['ALT', 'POL', 'SEV'])}-{r.randint(10, 99)}.{r.randint(1, 9)}-{r.choice(['АР', 'КР', 'ОВ', 'ПЗ'])}{r.randint(1, 3)}",
        "stage": r.choice(["П", "Р", "ИД"]),
        "revision": r.choice(["0", "1", "2", "3", "B", "C"]),
        "sheet": str(page_no),
        "room": f"{r.randint(1, 9)}.{r.randint(1, 30)}{r.choice(['', 'а', 'б'])}",
    }


def _page_text(r: random.Random, f: dict[str, str]) -> tuple[list[str], dict[str, str]]:
    """Строки страницы сверху вниз: штамп, затем текст. Строки штампа — такие, какими их читает key_fields/rooms."""
    head = [
        f"Шифр: {f['code']}   Стадия: {f['stage']}   Ред. {f['revision']}   Лист {f['sheet']}",
        f"Помещение {f['room']} Техническое помещение",
    ]
    body = [
        t.format(
            n=r.randint(3, 25),
            a=f"{r.randint(300, 9999)},{r.randint(0, 9)}",
            v=r.randint(5000, 99999),
            b=r.choice([25, 30, 35]),
            w=f"{r.choice([0.8, 0.9, 1.2, 1.35])}".replace(".", ","),
            r=r.choice([45, 60, 90]),
            t=r.choice([380, 510, 640]),
            u=r.choice([100, 150, 200]),
            h=f"{r.choice([2.8, 3.0, 3.3])}".replace(".", ","),
        )
        for t in r.sample(BODY, k=len(BODY))
    ]
    return head + body, f


def _render(lines: list[str], dpi: int, r: random.Random, degrade: dict) -> Image.Image:
    w, h = int(210 / 25.4 * dpi), int(297 / 25.4 * dpi)
    img = Image.new("L", (w, h), 250)
    d = ImageDraw.Draw(img)
    size = int(11 / 72 * dpi)  # кегль 11 pt — как в пояснительной записке
    font = ImageFont.truetype(str(FONT), size)
    y = int(20 / 25.4 * dpi)
    for i, t in enumerate(lines):
        d.text((int(20 / 25.4 * dpi), y), t, font=font, fill=20)
        y += int(size * (2.2 if i == 1 else 1.6))
    img = img.rotate(degrade["skew"], resample=Image.BICUBIC, fillcolor=250)
    if degrade["blur"]:
        img = img.filter(ImageFilter.GaussianBlur(degrade["blur"] * dpi / 300))
    if degrade["noise"]:
        import numpy as np

        a = np.asarray(img, dtype=np.float32)
        a += np.random.default_rng(r.randrange(1 << 30)).normal(
            0, degrade["noise"], a.shape
        )
        img = Image.fromarray(np.clip(a, 0, 255).astype("uint8"))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=degrade["jpeg"])
    return Image.open(io.BytesIO(buf.getvalue())).convert("L")


def _degrade(r: random.Random, broken: bool) -> dict:
    if broken:  # нечитаемая страница: сильное размытие и шум — система обязана не выдать её за текст
        return {
            "skew": r.uniform(-3, 3),
            "blur": r.uniform(4.0, 6.0),
            "noise": r.uniform(45, 60),
            "jpeg": 20,
        }
    return {
        "skew": round(r.uniform(-1.5, 1.5), 2),
        "blur": round(r.uniform(0, 0.9), 2),
        "noise": round(r.choice([0, 0, 6, 12]), 1),
        "jpeg": r.choice([95, 85, 75, 60]),
    }


def build(out: Path, docs: int, pages: int, seed: int) -> list[dict]:
    """Набор: PDF-сканы и эталон по страницам. Каждый 4-й документ получает одну нечитаемую страницу."""
    r = random.Random(seed)
    items = []
    for n in range(docs):
        dpi = 300 if n % 2 == 0 else 400
        imgs, gold = [], []
        for p in range(pages):
            broken = n % 4 == 3 and p == pages - 1
            lines, f = _page_text(r, _field_values(r, n, p + 1))
            deg = _degrade(r, broken)
            imgs.append(_render(lines, dpi, r, deg))
            gold.append(
                {
                    "page": p + 1,
                    "text": "\n".join(lines),
                    "fields": f,
                    "broken": broken,
                    "dpi": dpi,
                    **deg,
                }
            )
        path = out / f"ocr-{n:03d}.pdf"
        imgs[0].save(path, "PDF", resolution=dpi, save_all=True, append_images=imgs[1:])
        items.append({"doc": f"ocr-{n:03d}", "path": str(path), "pages": gold})
    return items


def _slice(g: dict) -> dict[str, str]:
    return {
        "dpi": str(g["dpi"]),
        "jpeg": "JPEG ≤ 75" if g["jpeg"] <= 75 else "JPEG > 75",
        "blur": "размытие ≥ 0,5" if g["blur"] >= 0.5 else "размытие < 0,5",
        "noise": "шум" if g["noise"] else "без шума",
    }


def evaluate(items: list[dict]) -> dict:
    from inspector_ml.parse import parse_file

    per_doc: dict[str, Counter] = {}
    slices: dict[str, dict[str, Counter]] = {}
    broken_seen = broken_flagged = 0
    misses: list[dict] = []
    t0 = time.perf_counter()
    for it in items:
        path = Path(it["path"])
        doc = parse_file(path, hashlib.sha256(path.read_bytes()).hexdigest())
        kf = key_fields(doc)
        rm = {}
        for fact in rooms(doc):
            rm.setdefault(fact.page, fact.number)
        c: Counter = Counter()
        for g, pg in zip(it["pages"], doc.pages):
            flagged = pg.quality in ("LOW_QUALITY", "ABSTAIN")
            c["pages"] += 1
            c["illegible_pages"] += flagged
            c["covered_pages"] += pg.quality != "ABSTAIN" and bool(pg.lines)
            words = sum(len(ln.words) for ln in pg.lines)
            c["ocr_words"] += words
            c["doubtful_words"] += min(pg.disputed_words, words)
            if g["broken"]:
                broken_seen += 1
                broken_flagged += flagged
                continue  # нечитаемая страница — не печатный текст ≥ 300 dpi: в CA/EM не входит (ТЗ 9.1.1)
            d, n = char_errors(g["text"], page_reading(pg, []))
            wd, wn = word_errors(g["text"], page_reading(pg, []))
            sl = Counter({"err": d, "chars": n})
            c.update({"err": d, "chars": n, "werr": wd, "words": wn})
            for kind in FIELDS:
                pred = (
                    rm.get(g["page"]) if kind == "room" else kf.get((g["page"], kind))
                )
                ok = pred is not None and norm_field(kind, pred) == norm_field(
                    kind, g["fields"][kind]
                )
                if not ok:  # расхождение «эталон → ответ» — для разбора причин
                    misses.append({"doc": it["doc"], "page": g["page"], "field": kind, "gold": g["fields"][kind], "pred": pred})
                c.update(
                    {
                        f"em_{kind}": ok,
                        f"n_{kind}": 1,
                        f"ans_{kind}": pred is not None,
                        "em": ok,
                        "n_em": 1,
                        "ans": pred is not None,
                    }
                )
                sl.update({"em": ok, "n_em": 1})
            for axis, v in _slice(g).items():
                slices.setdefault(axis, {}).setdefault(v, Counter()).update(sl)
        per_doc[it["doc"]] = c
    elapsed = time.perf_counter() - t0

    ratio = lambda a, b: lambda c: c[a] / c[b] if c[b] else float("nan")  # noqa: E731
    specs = {
        "character_accuracy": (
            lambda c: 1 - c["err"] / c["chars"] if c["chars"] else float("nan"),
            "chars",
        ),
        "cer": (ratio("err", "chars"), "chars"),
        "wer": (ratio("werr", "words"), "words"),
        "exact_match": (ratio("em", "n_em"), "n_em"),
        "key_field_coverage": (ratio("ans", "n_em"), "n_em"),
        "page_coverage": (ratio("covered_pages", "pages"), "pages"),
        "illegible_share": (ratio("illegible_pages", "pages"), "pages"),
        "doubtful_word_share": (ratio("doubtful_words", "ocr_words"), "ocr_words"),
        **{f"exact_match_{k}": (ratio(f"em_{k}", f"n_{k}"), f"n_{k}") for k in FIELDS},
    }
    total: Counter = sum(per_doc.values(), Counter())
    metrics = {}
    for name, (fn, n_key) in specs.items():
        lo, hi = ci_mod.bootstrap_ci(per_doc, fn)
        v = fn(total)
        metrics[name] = {
            "value": round(v, 4),
            "n": total[n_key],
            "ci": [round(lo, 4), round(hi, 4)],
        }
        if name in THRESHOLDS:
            op, thr, tz = THRESHOLDS[name]
            bound = lo if op == ">=" else hi
            metrics[name] |= {
                "threshold": f"{op} {thr}",
                "tz": tz,
                "passed": passes(name, v),
                "ci_passed": passes(name, bound),
            }
    by_slice = {
        axis: {
            v: {
                "character_accuracy": round(1 - c["err"] / c["chars"], 4)
                if c["chars"]
                else None,
                "chars": c["chars"],
                "exact_match": round(c["em"] / c["n_em"], 4) if c["n_em"] else None,
                "fields": c["n_em"],
            }
            for v, c in sorted(vals.items())
        }
        for axis, vals in slices.items()
    }
    ok = (
        all(metrics[m]["passed"] for m in ("character_accuracy", "exact_match"))
        and broken_flagged == broken_seen
    )
    return {
        "metrics": metrics,
        "slices": by_slice,
        "illegible_detection": {"broken_pages": broken_seen, "flagged": broken_flagged},
        "mismatches": misses,
        "per_doc": {k: dict(v) for k, v in per_doc.items()},
        "elapsed_s": round(elapsed, 1),
        "verdict": "принято" if ok else "не принято",
    }


def to_markdown(res: dict) -> str:
    m = res["metrics"]
    f = lambda x: "—" if x is None else f"{x:.3f}".replace(".", ",")  # noqa: E731
    rows = [
        ("Character Accuracy = 1 − CER", "character_accuracy"),
        ("Exact Match ключевых полей", "exact_match"),
        *[(f"Exact Match — {FIELD_RU[k]}", f"exact_match_{k}") for k in FIELDS],
        ("CER", "cer"),
        ("WER", "wer"),
        ("Coverage ключевых полей (есть ответ)", "key_field_coverage"),
        ("Coverage страниц (получен текст)", "page_coverage"),
        ("Доля нечитаемых страниц", "illegible_share"),
        ("Доля сомнительных слов OCR", "doubtful_word_share"),
    ]
    out = [
        "---",
        "id: QA-OCR-9.1.1",
        'title: "Качество OCR по ТЗ 9.1.1 — стенд на синтетических сканах ≥ 300 dpi"',
        "type: qa-report",
        "status: generated",
        'owner: "@almaz"',
        f"created: {res['at'][:10]}",
        "traces_to: [OS-INSP-6.5.18, OS-INSP-2.1.16, NFR-OCR-Q]",
        "tags: [qa, ocr, synthetic]",
        "---",
        "",
        "# Качество OCR по ТЗ 9.1.1 — стенд на синтетических сканах",
        "",
        "> Генерируется `python -m eval.ocr_bench`. **Синтетика, не скрытая выборка организатора**: цифры — о нашем OCR на наших",
        "> сканах с известным текстом; приёмку по TZA-9.1.1-02/03 решает прогон на скрытой выборке (GPU-стенд).",
        "",
        f"- Набор: {res['config']['docs']} документов × {res['config']['pages']} стр., seed {res['config']['seed']}; 300 и 400 dpi, наклон ±1,5°, "
        "размытие до 0,9 px, шум σ до 12, JPEG 60–95; каждый 4-й документ — одна страница, испорченная до нечитаемости.",
        "- Нормализация (TZA-9.1.1-04): Unicode NFC, схлопывание пробелов; знаки и регистр не удаляются; ключевые поля — по политике вида поля.",
        f"- ДИ 95 %: перцентильный бутстрап по документам, B = {ci_mod.DEFAULT_B}. OCR: {res['elapsed_s']} с; хост {res['host']}.",
        "",
        f"## Вердикт: **{res['verdict'].upper()}**",
        "",
        "| Метрика | Порог | Значение | 95 % ДИ | n | Порог пройден | Весь ДИ за порогом |",
        "|---|---|---|---|---|---|---|",
    ]
    for title, k in rows:
        x = m[k]
        out.append(
            f"| {title} | {x.get('threshold', '—')} | {f(x['value'])} | [{f(x['ci'][0])}; {f(x['ci'][1])}] | {x['n']} | {'да' if x.get('passed') else ('нет' if 'passed' in x else '—')} | {'да' if x.get('ci_passed') else ('нет' if 'ci_passed' in x else '—')} |"
        )
    d = res["illegible_detection"]
    out += [
        "",
        f"Нечитаемые страницы помечены LOW_QUALITY/ABSTAIN: **{d['flagged']} из {d['broken_pages']}** (TZA-9.1.1-05/06).",
        "",
        "## Срезы по искажениям",
        "",
        "| Срез | Значение | CA | символов | EM | полей |",
        "|---|---|---|---|---|---|",
    ]
    for axis, vals in res["slices"].items():
        for v, s in vals.items():
            out.append(
                f"| {axis} | {v} | {f(s['character_accuracy'])} | {s['chars']} | {f(s['exact_match'])} | {s['fields']} |"
            )
    if res.get("mismatches"):
        out += ["", "## Расхождения ключевых полей (первые 30)", "", "| Документ | Стр. | Поле | Эталон | Ответ OCR |", "|---|---|---|---|---|"]
        for x in res["mismatches"][:30]:
            pred = x["pred"] if x["pred"] is not None else "—"
            out.append(f"| {x['doc']} | {x['page']} | {FIELD_RU[x['field']]} | `{x['gold']}` | `{pred}` |")
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> dict:
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs", type=int, default=12)
    ap.add_argument("--pages", type=int, default=3)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default="../var/ocr-bench.json")
    ap.add_argument("--md", default=None)
    a = ap.parse_args(argv)
    with tempfile.TemporaryDirectory(prefix="ocr-bench-") as tmp:
        items = build(Path(tmp), a.docs, a.pages, a.seed)
        res = evaluate(items)
    res = {
        "schema": "inspector-ocr-bench/1",
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "host": f"{platform.machine()}, Python {platform.python_version()}",
        "config": {"docs": a.docs, "pages": a.pages, "seed": a.seed},
        **res,
    }
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(res, ensure_ascii=False, indent=2), "utf-8")
    if a.md:
        Path(a.md).write_text(to_markdown(res), "utf-8")
    print(
        "verdict",
        res["verdict"],
        {
            k: res["metrics"][k]["value"]
            for k in ("character_accuracy", "exact_match", "illegible_share")
        },
        res["illegible_detection"],
    )
    return res


if __name__ == "__main__":
    main()
