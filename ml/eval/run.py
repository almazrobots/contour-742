"""Стенд оценки §14: прогон текущего конвейера parse+extract по эталонному набору → отчёт.

Конвейер вызывается напрямую (inspector_ml.parse.parse_file, inspector_ml.extract), без HTTP.
Решающий слой — зеркало домена API (eval/decide.py), роли редакций — по реестру manifest.json,
как в проде. Метрики — eval/metrics.py, ДИ — eval/ci.py, вердикт — eval/thresholds.py.

    uv run python -m eval.run --gold ../var/synth-v2 --out ../var/eval [--md ../docs/qa/ACCEPTANCE-14.md]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import resource
import subprocess
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path

from inspector_ml.extract import extract, rooms
from inspector_ml.model import Extraction, ParamSpec, ParsedDoc
from inspector_ml.cipher import fix_code
from inspector_ml.reread import extract_refined
from inspector_ml.semantic import get_embedder
from inspector_ml.parse import parse_file

from . import ci as ci_mod
from .decide import StageValue, choose, evaluate, select_revisions
from .metrics import (
    METRICS,
    char_errors,
    evidence_localized,
    exact_match,
    match_findings,
    total,
    word_errors,
)
from .thresholds import THRESHOLDS, verdict
from . import composition as comp_mod
from inspector_ml.paths import repo_root

ML = Path(__file__).resolve().parents[1]
ROOT = repo_root()  # не ML.parent: песочница mutmut глубже исходников
MATRIX_PATH = ROOT / "data/seed/matrix.json"
OCR_ACCEPT_DPI = 300  # ТЗ 9.1.1: CA ≥ 0,95 — на печатном тексте ≥ 300 dpi

# Ключевые поля штампа читаются тем же экстрактором, что и параметры Матрицы: якорь + regex хвоста.
KEY_SPECS = [
    # шифр всегда содержит цифру: иначе на OCR-странице якорь «Шифр» нечётко совпадал со строкой «Ширина эвакуационного…»
    # и шифром становилось слово «эвакуационного» (T-138, стенд OCR 9.1.1)
    ParamSpec(code="code", anchors=["Шифр"], regex_pattern=r"^[\s:]*(?=\S*\d)\S+"),
    ParamSpec(
        code="stage",
        anchors=["Стадия"],
        regex_pattern=r"^[\s:]*(?:ИД|П|P)(?=[\s.,;]|$)",
    ),
    ParamSpec(
        code="revision",
        anchors=["Ред."],
        regex_pattern=r"^[\s:.]*[0-9A-Z]{1,3}(?=[\s.,;]|$)",
    ),
    ParamSpec(code="sheet", anchors=["Лист"], regex_pattern=r"^[\s:]*\d+"),
]


def load_matrix() -> dict[str, dict]:
    return {p["code"]: p for p in json.loads(MATRIX_PATH.read_text("utf-8"))}


def passport_specs() -> dict[str, dict]:
    """T-233: спецификации извлекателей паспорта (то, что API кладёт в ParamSpec.extractor при /analyze) для параметров,
    которые стенд решает путём паспорта (apps/api/scripts/eval-passports.ts). Это параметры, которые фабрика v3 пишет
    формой паспорта (synth/forms_w3.py): направление, мероприятие, метод, количество с единицей. Лексический путь такую
    строку не читает вовсе (coverage 0), а зеркало decide.py не знает оценщиков видов. Остальные параметры с паспортом
    (М-001…М-020 и др.) синтетика пишет прежней формой — они решаются как раньше, лексически."""
    from synth.forms_w3 import FORMS

    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "specs.json"
        subprocess.run(
            ["npx", "tsx", "scripts/eval-passports.ts", "specs", str(out)],
            cwd=ROOT / "apps/api",
            check=True,
        )
        return {c: v for c, v in json.loads(out.read_text("utf-8")).items() if c in FORMS}


def specs(matrix: dict[str, dict], by_passport: dict[str, dict] | None = None) -> list[ParamSpec]:
    by_passport = by_passport or {}
    return [
        ParamSpec(
            code=p["code"],
            anchors=p["anchors"],
            data_type=p["data_type"],
            regex_pattern=p.get("regex_pattern"),
            compare_kind=p["compare"]["kind"],
            **(
                {"extractor": by_passport[p["code"]]["spec"], "unit": p.get("unit") or None}
                if p["code"] in by_passport
                else {}
            ),
        )
        for p in matrix.values()
    ]


def passport_evaluate(
    oid: str,
    files: dict[str, dict],
    profile: dict,
    loaded: set[str],
    roles: dict[str, str],
    extractions: dict[str, list[Extraction]],
    codes: set[str],
) -> dict[str, dict]:
    """Решение параметров путём паспорта: упоминания ML → настоящий оценщик API (scripts/eval-passports.ts), как recompute().
    Возвращает предсказанные группы по коду; параметр без упоминаний в результат не попадает (как у лексического пути)."""
    rows = []
    for code in sorted(codes):
        got = []
        for fid, exs in extractions.items():
            f = files[fid]
            for e in exs:
                if e.code != code:
                    continue
                got.append(
                    {
                        "file_id": fid,
                        "sha256": f["sha256"],
                        "doc_stage": f["doc_stage"],
                        "document_code": f["document_code"],
                        "revision": f["revision"],
                        "approval_status": f.get("approval_status"),
                        "revision_role": roles.get(fid, "UNRESOLVED"),
                        "discipline": f.get("discipline"),
                        "value_num": e.value_num,
                        "value_text": e.value_text,
                        "page": e.page,
                        "bbox_json": json.dumps(list(e.bbox)) if e.bbox else None,
                        "anchor_bbox_json": json.dumps(list(e.anchor_bbox)) if e.anchor_bbox else None,
                        "meta_json": json.dumps(e.meta) if e.meta else None,
                        "line_text": e.line_text,
                        "confidence": e.confidence,
                    }
                )
        if got:
            rows.append(
                {
                    "id": code,
                    "code": code,
                    "rows": got,
                    "files": [
                        {"doc_stage": f["doc_stage"], "document_code": f["document_code"], "file_name": f["file_name"]}
                        for f in files.values()
                    ],
                    "loadedStages": sorted(loaded),
                    "profile": profile,
                }
            )
    if not rows:
        return {}
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "in.jsonl", Path(tmp) / "out.jsonl"
        src.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", "utf-8")
        subprocess.run(
            ["npx", "tsx", "scripts/eval-passports.ts", "eval", str(src), str(dst)],
            cwd=ROOT / "apps/api",
            check=True,
        )
        res = [json.loads(x) for x in dst.read_text("utf-8").splitlines() if x]
    return {
        r["id"]: {
            "object_id": oid,
            "param": r["id"],
            "status": r["status"],
            "reason": r.get("reason"),
            "evidence": [
                {"file_id": v["file_id"], "page": v["page"], "bbox": v["bbox"]}
                for v in r["fragments"]
            ],
            "sources": sorted(
                {(oid, v["stage"], v["document_code"], v["revision"]) for v in r["fragments"]}
            ),
        }
        for r in res
    }


# ─────────────────────────────────────────────── чтение страницы в порядке строк


def _inside(b, zones) -> bool:
    if not b:
        return False
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    return any(z[0] <= cx <= z[2] and z[1] <= cy <= z[3] for z in zones)


def _slope(lines) -> float:
    """Наклон строк скана (dy/dx в долях страницы) — медиана по парам крайних слов длинных строк."""
    ks = []
    for ws in lines:
        bs = [w.bbox for w in ws if w.bbox]
        if len(bs) >= 2:
            a, b = min(bs, key=lambda x: x[0]), max(bs, key=lambda x: x[2])
            dx = (b[0] + b[2]) / 2 - (a[0] + a[2]) / 2
            if dx > 0.05:
                ks.append(((b[1] + b[3]) / 2 - (a[1] + a[3]) / 2) / dx)
    ks.sort()
    return ks[len(ks) // 2] if ks else 0.0


def page_reading(page, dont_care: list) -> str:
    """Текст страницы: слова вне зон реквизитов; строки — сверху вниз, соседние по высоте — в один ряд.

    Та же геометрическая сборка, что у эталона (базовая линия → ряд), чтобы CER мерил распознавание,
    а не разницу порядков чтения: OCR режет строку таблицы на колонки, а наклон скана разводит их по
    высоте — поэтому ряды собираются после компенсации наклона (медиана по строкам). Зоны реквизитов
    (печать, подпись, штампы) — «don't care»: это не печатный текст (ТЗ 9.1.1).
    """
    lines = [
        [w for w in ln.words if not _inside(w.bbox, dont_care)] for ln in page.lines
    ]
    lines = [ws for ws in lines if ws]
    k = _slope(lines)
    items = []
    for ws in lines:
        boxes = [w.bbox for w in ws if w.bbox]
        if boxes:
            y0, y1 = min(b[1] for b in boxes), max(b[3] for b in boxes)
            x0, x1 = min(b[0] for b in boxes), max(b[2] for b in boxes)
            h = sorted(b[3] - b[1] for b in boxes)[len(boxes) // 2]
        else:
            y0 = y1 = x0 = x1 = 0.0
            h = 1e-3
        yc = (y0 + y1) / 2 - k * (
            x0 + x1
        ) / 2  # центр строки в «выпрямленных» координатах
        items.append((yc, max(h, 1e-3), x0, " ".join(w.text for w in ws)))
    items.sort()
    rows: list[list] = []
    for it in items:
        if rows and abs(it[0] - rows[-1][0][0]) < 0.5 * max(it[1], rows[-1][0][1]):
            rows[-1].append(it)
        else:
            rows.append([it])
    return "\n".join(
        " ".join(t for *_, t in sorted(r, key=lambda x: x[2])) for r in rows
    )


# ─────────────────────────────────────────────── прогон объекта


def _single(doc: ParsedDoc, page) -> ParsedDoc:
    return ParsedDoc(sha256=doc.sha256, kind=doc.kind, pages=[page], engine=doc.engine)


def key_fields(doc: ParsedDoc, registry: list[str] | None = None) -> dict[tuple[int, str], str]:
    out = {}
    for page in doc.pages:
        for e in extract(_single(doc, page), KEY_SPECS):
            v = e.raw.strip(" :.")
            if e.code == "code" and registry:
                v = fix_code(v, registry).value  # OS-INSP-2.2.6: гомоглифы по реестру
            out[(page.page, e.code)] = v
    return out


def run_object(obj_dir: Path, matrix: dict, all_specs: list[ParamSpec], by_passport: dict[str, dict] | None = None) -> dict:
    by_passport = by_passport or {}
    gold = json.loads((obj_dir / "gold.json").read_text("utf-8"))
    manifest = json.loads((obj_dir / "manifest.json").read_text("utf-8"))
    oid = gold["object_id"]
    files = {f["file_id"]: f for f in manifest["files"]}
    parsed: dict[str, ParsedDoc] = {}
    extractions: dict[str, list[Extraction]] = {}
    keys: dict[str, dict] = {}
    room_facts: dict[str, list] = {}
    t_parse = t_extract = 0.0
    for fid, f in files.items():
        p = obj_dir / f["file_name"]
        if not f.get("sha256") or not p.exists():
            continue
        t = time.perf_counter()
        parsed[fid] = parse_file(p, f["sha256"])
        t_parse += time.perf_counter() - t
        t = time.perf_counter()
        extractions[fid] = extract_refined(p, parsed[fid], all_specs, get_embedder())  # 2.2.8, 2.2.12 — как в сервисе
        keys[fid] = key_fields(parsed[fid], [x["document_code"] for x in files.values()])
        room_facts[fid] = rooms(parsed[fid])
        t_extract += time.perf_counter() - t

    obs: list[tuple[str, dict, Counter]] = []  # (object_id, срезы, счётчики)
    disc = {fid: f["discipline"] for fid, f in files.items()}
    kind = {f["file_id"]: f for f in gold["files"]}

    def page_type(fid: str) -> str:
        k = kind[fid]
        return f"скан {k['dpi']} dpi" if k["kind"] == "scan" else "текстовый слой"

    # OCR / текст: CER, WER, CA, coverage, доля LOW_QUALITY — по трём пулам страниц (metrics._text_metrics)
    for gp in gold["pages"]:
        fid, pn = gp["file_id"], gp["page"]
        doc = parsed.get(fid)
        page = next((x for x in doc.pages if x.page == pn), None) if doc else None
        answered = page is not None and page.quality != "ABSTAIN" and bool(page.lines)
        hyp = page_reading(page, gp.get("dont_care", [])) if answered else ""
        d, n = char_errors(gp["text"], hyp)
        wd, wn = word_errors(gp["text"], hyp)
        k = kind[fid]
        pools = ["all"] + (["scan"] if k["kind"] == "scan" else [])
        if k["kind"] == "scan" and (k["dpi"] or 0) >= OCR_ACCEPT_DPI:
            pools.append("ocr")  # условие приёмки ТЗ 9.1.1: печатный текст ≥ 300 dpi
        c = Counter()
        for p in pools:
            c.update(
                {
                    f"{p}_err": d,
                    f"{p}_chars": n,
                    f"{p}_werr": wd,
                    f"{p}_words": wn,
                    f"{p}_pages": 1,
                    f"{p}_answered": int(answered),
                    f"{p}_low": int(page is not None and page.quality != "OK"),
                }
            )
        obs.append((oid, {"section": disc[fid], "type": page_type(fid)}, c))

    # ключевые поля: Exact Match по политике нормализации поля
    for kf in gold["key_fields"]:
        fid, pn = kf["file_id"], kf["page"]
        if kf["field"] == "room":
            gb = kf["bbox"]
            cx, cy = (gb[0] + gb[2]) / 2, (gb[1] + gb[3]) / 2
            pred = next(
                (
                    r.number
                    for r in room_facts.get(fid, [])
                    if r.page == pn
                    and r.bbox
                    and r.bbox[0] <= cx <= r.bbox[2]
                    and r.bbox[1] <= cy <= r.bbox[3]
                ),
                None,
            )
        else:
            pred = keys.get(fid, {}).get((pn, kf["field"]))
        c = Counter(
            em_n=1,
            em_answered=int(pred is not None),
            em_ok=int(exact_match(kf["field"], kf["value"], pred)),
        )
        obs.append((oid, {"section": disc[fid], "type": f"поле {kf['field']}"}, c))

    # решения по параметрам: роли редакций по реестру → выбор источника → сравнение
    roles = select_revisions(list(files.values()))
    loaded = {files[fid]["doc_stage"] for fid in parsed}
    by_param: dict[str, list[StageValue]] = {}
    for fid, exs in extractions.items():
        f = files[fid]
        for e in exs:
            if e.code in by_passport:
                continue  # решается путём паспорта ниже (T-233)
            by_param.setdefault(e.code, []).append(
                StageValue(
                    f["doc_stage"],
                    e.value_num,
                    e.value_text,
                    e.raw,
                    fid,
                    e.page,
                    list(e.bbox) if e.bbox else None,
                    roles.get(fid, "UNRESOLVED"),
                    f["document_code"],
                    f["revision"],
                    e.confidence,
                    f["discipline"],
                )
            )
    pred_groups = []
    for code, cands in by_param.items():
        ev = evaluate(
            matrix[code],
            manifest["object"].get("profile", {}),
            choose(cands, matrix[code]),
            loaded,
        )
        pred_groups.append(
            {
                "object_id": oid,
                "param": code,
                "status": ev.status,
                "evidence": [
                    {"file_id": v.file_id, "page": v.page, "bbox": v.bbox}
                    for v in ev.fragments
                ],
                "sources": sorted(
                    {(oid, v.stage, v.document_code, v.revision) for v in ev.fragments}
                ),
            }
        )
    pred_by = {g["param"]: g for g in pred_groups}
    if by_passport:  # T-233: параметры с паспортом видов — настоящий оценщик API по упоминаниям ML
        via = passport_evaluate(oid, files, manifest["object"].get("profile", {}), loaded, roles, extractions, set(by_passport))
        pred_groups += list(via.values())
        pred_by.update(via)

    for g in gold["evidence_groups"]:
        tags = {"section": g["section"], "type": g["violation_type"], "param": g["param"]}  # param — OS-INSP-6.5.4
        p = pred_by.get(g["param"])
        c = Counter()
        if g["label"] != "NOT_APPLICABLE" and g["evidence"]:
            gs = sorted(
                {
                    (oid, e["stage"], e["document_code"], e["revision"])
                    for e in g["evidence"]
                }
            )
            c.update(
                link_n=1,
                link_answered=int(p is not None),
                link_ok=int(p is not None and p["sources"] == gs),
            )
            c.update(
                loc_n=1,
                loc_answered=int(bool(p and p["evidence"])),
                loc_ok=int(
                    bool(p) and evidence_localized(g["evidence"], p["evidence"])
                ),
            )
        c.update(match_findings([g], [p] if p else [])[oid])
        obs.append((oid, tags, c))
    # лишние находки: CANDIDATE по параметру, которого нет в эталоне объекта
    gold_params = {g["param"] for g in gold["evidence_groups"]}
    for p in pred_groups:
        if p["param"] not in gold_params and p["status"] in (
            "CANDIDATE",
            "CONFIRMED_VIOLATION",
        ):
            m = matrix[p["param"]]
            obs.append(
                (
                    oid,
                    {"section": m["section"], "type": m["compare"]["kind"], "param": p["param"]},
                    Counter(fp=1, extra_fp=1),
                )
            )

    return {
        "object_id": oid,
        "obs": obs,
        "pred_groups": [
            {k: v for k, v in g.items() if k != "sources"} for g in pred_groups
        ],
        "timing": {
            "parse_s": round(t_parse, 2),
            "extract_s": round(t_extract, 2),
            "pages": sum(len(d.pages) for d in parsed.values()),
            "ocr_pages": sum(
                pg.source == "ocr" for d in parsed.values() for pg in d.pages
            ),
        },
        "manifest_hash": hashlib.sha256(
            (obj_dir / "manifest.json").read_bytes()
        ).hexdigest(),
        "dataset_version": gold.get("dataset_version"),
    }


# ─────────────────────────────────────────────── агрегирование, ДИ, срезы


def per_object(obs, pred=lambda tags: True) -> dict[str, Counter]:
    out: dict[str, Counter] = {}
    for oid, tags, c in obs:
        if pred(tags):
            out.setdefault(oid, Counter()).update(c)
    return out


# OS-INSP-6.5.10: метрики-доли k/n — успехи k из счётчиков, n — METRICS[name]["n"]. F1 и Character Accuracy
# долями независимых испытаний не являются (F1 — гармоническое среднее, CA = 1 − ошибки/символы и бывает < 0):
# интервала Уилсона для них нет.
PROPORTION_K = {
    "exact_match": lambda c: c["em_ok"],
    "linkage": lambda c: c["link_ok"],
    "localization": lambda c: c["loc_ok"],
    "precision": lambda c: c["tp"],
    "recall": lambda c: c["tp"],
    "fpr": lambda c: c["neg_fp"],
    "fpr_superseded": lambda c: c["trap_fp"],
    "other_status_accuracy": lambda c: c["other_ok"],
}
NO_CI_ONE_OBJECT = "ДИ нет: один объект, а метрика не доля k/n"


def summarize(po: dict[str, Counter], b: int, seed: int, names=None, ci: str = "bootstrap") -> dict:
    """Значение, n, coverage и 95 % ДИ метрик по счётчикам объектов.

    ci="bootstrap" (общие метрики, OS-INSP-6.5.2): всегда бутстрэп по объектам.
    ci="auto" (срезы, OS-INSP-6.5.10): если выборка метрики — из одного объекта, бутстрэп по объектам
    вырожден, и доля получает интервал Уилсона по группам, а не-доля (F1, CA) — пометку «ДИ нет»;
    иначе — бутстрэп по объектам.
    ci="none": точечные оценки (срез по параметру, OS-INSP-6.5.4).
    """
    tot = total(po)
    res = {}
    for name in names or METRICS:
        spec = METRICS[name]
        v, n = spec["value"](tot), spec["n"](tot)
        objects = sum(1 for c in po.values() if spec["n"](c))  # объекты с ненулевой выборкой
        lo = hi = float("nan")
        method = note = None
        if n and ci != "none":
            if ci == "auto" and objects == 1 and name in PROPORTION_K:
                lo, hi = ci_mod.wilson(int(PROPORTION_K[name](tot)), int(n))
                method = "wilson"
            elif ci == "auto" and objects == 1:
                note = NO_CI_ONE_OBJECT
            else:
                lo, hi = ci_mod.bootstrap_ci(po, spec["value"], b, seed)
                method = "bootstrap"
        res[name] = {
            "value": _num(v),
            "n": int(n),
            "unit": spec["unit"],
            "coverage": _num(spec["cov"](tot)),
            "ci": [_num(lo), _num(hi)],
            "ci_method": method,
            "objects": objects,
        }
        if note:
            res[name]["ci_note"] = note
    return res


def _num(x):
    return (
        None
        if x is None or (isinstance(x, float) and math.isnan(x))
        else round(float(x), 4)
    )


SLICE_METRICS = [
    "character_accuracy",
    "character_accuracy_all_pages",
    "exact_match",
    "linkage",
    "localization",
    "precision",
    "recall",
    "f1",
    "fpr",
]


def build_slices(obs, b: int, seed: int) -> dict:
    """Срезы метрик (OS-INSP-6.5.10): по объектам, разделам и типам — с n, coverage и 95 % ДИ; по параметрам
    Матрицы — точечные оценки (OS-INSP-6.5.4: по 3–5 групп на параметр интервал неинформативен).

    Объект — один объект, ДИ долей по Уилсону; разделы и типы — бутстрэп по объектам, а если в срезе
    данные одного объекта — тоже Уилсон (решает summarize по каждой метрике).
    """
    slices = {}
    for dim in ("section", "type"):
        vals = sorted({t[dim] for _, t, _ in obs})
        slices[dim] = {
            v: summarize(per_object(obs, lambda t, v=v, dim=dim: t[dim] == v), b, seed, SLICE_METRICS, ci="auto")
            for v in vals
        }
    params_seen = sorted({t["param"] for _, t, _ in obs if "param" in t})
    slices["param"] = {
        v: summarize(per_object(obs, lambda t, v=v: t.get("param") == v), 0, seed, SLICE_METRICS, ci="none")
        for v in params_seen
    }
    slices["object"] = {oid: summarize({oid: c}, b, seed, SLICE_METRICS, ci="auto") for oid, c in per_object(obs).items()}
    return slices


def run(
    gold_dir: Path,
    out_dir: Path,
    b: int = ci_mod.DEFAULT_B,
    seed: int = ci_mod.DEFAULT_SEED,
    limit: int | None = None,
) -> dict:
    t0 = time.perf_counter()
    matrix = load_matrix()
    by_passport = passport_specs()
    all_specs = specs(matrix, by_passport)
    dirs = sorted(p.parent for p in gold_dir.glob("*/gold.json"))[:limit]
    results = [run_object(d, matrix, all_specs, by_passport) for d in dirs]
    t_pipe = time.perf_counter() - t0
    obs = [o for r in results for o in r["obs"]]
    overall = summarize(per_object(obs), b, seed)
    vd = verdict(
        {
            k: {
                "value": v["value"] if v["value"] is not None else float("nan"),
                "n": v["n"],
                "ci": v["ci"],
            }
            for k, v in overall.items()
            if k in THRESHOLDS
        }
    )
    # OS-INSP-6.5.13/6.5.14: состав выборки по пяти классам ТЗ §14.2; нет класса — «не принято»
    comp = comp_mod.composition([json.loads((d / "gold.json").read_text("utf-8")) for d in dirs])
    vd = comp_mod.apply_composition(vd, comp)
    slices = build_slices(obs, b, seed)
    self_ru, child_ru = (
        resource.getrusage(resource.RUSAGE_SELF),
        resource.getrusage(resource.RUSAGE_CHILDREN),
    )
    scale = (
        1 if sys.platform == "darwin" else 1024
    )  # ru_maxrss: байты на macOS, КиБ на Linux
    report = {
        "schema": "inspector-eval-report/1",
        "generated": time.strftime("%Y-%m-%d"),
        "disclaimer": "Синтетический набор фабрики v2, НЕ скрытый тест организатора",
        "dataset_version": sorted(
            {r["dataset_version"] for r in results if r["dataset_version"]}
        ),
        "matrix_version": hashlib.sha256(MATRIX_PATH.read_bytes()).hexdigest()[:12],
        "model_version": "inspector_ml parse(pdfium+tesseract rus+eng psm4)+extract(rapidfuzz)+reread(tesseract psm7/8), профиль dev",
        "input_manifest_hash": hashlib.sha256(
            "".join(r["manifest_hash"] for r in results).encode()
        ).hexdigest(),
        "bootstrap": {"B": b, "seed": seed, "unit": "object_id", "level": 0.95},
        "n_objects": len(results),
        "overall": overall,
        "verdict": vd,
        "composition": comp,
        "slices": slices,
        "per_object_timing": {r["object_id"]: r["timing"] for r in results},
        "resources": {
            "pipeline_wall_s": round(t_pipe, 1),
            "total_wall_s": round(time.perf_counter() - t0, 1),
            "peak_rss_mb_python": round(self_ru.ru_maxrss * scale / 2**20, 1),
            "peak_rss_mb_children": round(child_ru.ru_maxrss * scale / 2**20, 1),
            "pages": sum(r["timing"]["pages"] for r in results),
            "ocr_pages": sum(r["timing"]["ocr_pages"] for r in results),
        },
        "predictions": {r["object_id"]: r["pred_groups"] for r in results},
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    (out_dir / "report.md").write_text(to_markdown(report), encoding="utf-8")
    return report


# ─────────────────────────────────────────────── markdown

TITLES = {
    "character_accuracy": "Character Accuracy (OCR, скан ≥ 300 dpi)",
    "cer": "CER (OCR, скан ≥ 300 dpi)",
    "wer": "WER (OCR, скан ≥ 300 dpi)",
    "character_accuracy_scans_all_dpi": "Character Accuracy, все сканы 150–300 dpi",
    "cer_scans_all_dpi": "CER, все сканы 150–300 dpi",
    "wer_scans_all_dpi": "WER, все сканы 150–300 dpi",
    "character_accuracy_all_pages": "Character Accuracy, все страницы (текстовый слой + сканы)",
    "cer_all_pages": "CER, все страницы (текстовый слой + сканы)",
    "wer_all_pages": "WER, все страницы (текстовый слой + сканы)",
    "exact_match": "Exact Match ключевых полей",
    "linkage": "Связка документов",
    "localization": "Локализация (file+стр.+IoU≥0,5)",
    "precision": "Precision",
    "recall": "Recall",
    "f1": "F1",
    "fpr": "FPR (NEGATIVE_VERIFIED + устаревшие)",
    "fpr_superseded": "FPR только устаревшие редакции",
    "other_status_accuracy": "Статусы MISSING_EVIDENCE / CLARIFICATION_REQUIRED",
    "low_quality_share": "Доля страниц LOW_QUALITY/ABSTAIN",
}


def _f(x) -> str:
    return "—" if x is None else f"{x:.3f}".replace(".", ",")


CI_IN_CELL = {"exact_match", "linkage", "localization", "precision", "recall", "f1", "fpr"}


def slice_cell(name: str, m: dict) -> str:
    """Ячейка таблицы среза: «0,800 [0,490; 0,943]† n=10 cov 0,900»; † — ДИ Уилсона (OS-INSP-6.5.10)."""
    if not m["n"]:
        return "—"
    if name not in CI_IN_CELL:
        return f"{_f(m['value'])} ({m['n']})"
    s = _f(m["value"])
    lo, hi = m["ci"]
    if lo is not None and hi is not None:
        s += f" [{_f(lo)}; {_f(hi)}]" + ("†" if m.get("ci_method") == "wilson" else "")
    elif m.get("ci_note"):
        s += " [ДИ —]"
    s += f" n={m['n']}"
    if m.get("coverage") is not None:
        s += f" cov {_f(m['coverage'])}"
    return s


def to_markdown(r: dict) -> str:
    vd = r["verdict"]
    L = [
        "---",
        "id: QA-ACCEPTANCE-14",
        'title: "Приёмка по ТЗ §14 — прогон стенда оценки"',
        "type: qa-report",
        "status: draft",
        'owner: "@almaz"',
        f"created: {r.get('generated', '')}",
        "traces_to: [OS-INSP-6.5.1, OS-INSP-6.5.2, OS-INSP-6.5.3, OS-INSP-6.5.10, OS-INSP-6.4.1]",
        "tags: [qa, acceptance, synthetic]",
        "---",
        "",
        "# Приёмка по ТЗ §14 — прогон стенда оценки",
        "",
        f"> **{r['disclaimer']}.** Цифры ниже — о нашем конвейере на наших листах с известными ответами; "
        "приёмку решает только прогон на скрытом тесте организатора.",
        "",
        f"- Набор: `{', '.join(r['dataset_version'])}`, объектов: **{r['n_objects']}**; Матрица `{r['matrix_version']}`; "
        f"input_manifest_hash `{r['input_manifest_hash'][:16]}…`",
        f"- Модель: {r['model_version']}",
        f"- ДИ 95 %: перцентильный бутстрап, B = {r['bootstrap']['B']}, ресэмплинг по `object_id`, seed {r['bootstrap']['seed']}",
        f"- Ресурсы: конвейер {r['resources']['pipeline_wall_s']} с, всего {r['resources']['total_wall_s']} с; страниц {r['resources']['pages']}, "
        f"из них OCR {r['resources']['ocr_pages']}; пик RSS Python {r['resources']['peak_rss_mb_python']} МБ, "
        f"дочерних (tesseract) {r['resources']['peak_rss_mb_children']} МБ",
        "",
        f"## Вердикт: **{vd['verdict'].upper()}**"
        + (
            f" — не пройдено: {', '.join(TITLES[m] for m in vd['failed'])}"
            if vd["failed"]
            else ""
        ),
        "",
        "| Метрика | Порог | Значение | 95 % ДИ | n | объектов | coverage | Порог пройден | Весь ДИ за порогом |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for m, row in vd["metrics"].items():
        o = r["overall"][m]
        L.append(
            f"| {TITLES[m]} | {row['threshold'].replace('.', ',')} | {_f(o['value'])} | [{_f(o['ci'][0])}; {_f(o['ci'][1])}] | {o['n']} {o['unit']} | {o['objects']} | "
            f"{_f(o['coverage'])} | {'да' if row['pass'] else '**нет**'} | {'да' if row['robust'] else 'нет'} |"
        )
    if "composition" in r:  # OS-INSP-6.5.15: состав выборки рядом с метриками
        L += comp_mod.markdown(r["composition"], vd.get("missing_classes", []))
    L += [
        "",
        "## Справочные метрики (без порога)",
        "",
        "| Метрика | Значение | 95 % ДИ | n |",
        "|---|---|---|---|",
    ]
    for m in (
        "cer",
        "wer",
        "character_accuracy_scans_all_dpi",
        "cer_scans_all_dpi",
        "character_accuracy_all_pages",
        "cer_all_pages",
        "fpr_superseded",
        "other_status_accuracy",
        "low_quality_share",
    ):
        o = r["overall"][m]
        L.append(
            f"| {TITLES[m]} | {_f(o['value'])} | [{_f(o['ci'][0])}; {_f(o['ci'][1])}] | {o['n']} {o['unit']} |"
        )
    heads = [
        "CA скан ≥300 dpi",
        "CA все стр.",
        "EM",
        "Связка",
        "Локал.",
        "P",
        "R",
        "F1",
        "FPR",
    ]
    for dim, title in (
        ("object", "По объектам"),
        (
            "section",
            "По разделам (раздел файла для OCR/EM, раздел Матрицы для находок)",
        ),
        (
            "type",
            "По типам (страница/поле для OCR/EM, тип правила Матрицы для находок)",
        ),
        ("param", "По параметрам Матрицы (OS-INSP-6.5.4)"),
    ):
        L += [
            "",
            f"## {title}",
            "",
            "| Срез | " + " | ".join(heads) + " |",
            "|---" * (len(heads) + 1) + "|",
        ]
        for key, ms in r["slices"][dim].items():
            cells = [slice_cell(m, ms[m]) for m in SLICE_METRICS]
            L.append(f"| {key} | " + " | ".join(cells) + " |")
    L += [
        "",
        "Ячейка среза: значение [95 % ДИ] n=размер выборки (поля, группы, находки) cov coverage; для Character Accuracy — "
        "значение (символов). ДИ: срез одного объекта — интервал Уилсона по группам (†); F1 на одном объекте — "
        "«ДИ —» (не доля k/n); разделы и типы — перцентильный бутстрэп по объектам, а если данные среза — из одного "
        "объекта, то тоже Уилсон (OS-INSP-6.5.10). Срез по параметрам Матрицы — точечные оценки без ДИ (OS-INSP-6.5.4).",
        "",
        "## Как считалось",
        "",
        "- Конвейер: `inspector_ml.parse.parse_file` → `inspector_ml.extract.extract` напрямую, без HTTP; роли редакций — "
        "по реестру `manifest.json`; статусы — зеркало домена API (`ml/eval/decide.py`, сверено с answer-key v1 тестом).",
        "- Character Accuracy / CER / WER — только OCR-страницы сканов ≥ 300 dpi (условие ТЗ 9.1.1); после NFC и схлопывания "
        "пробелов; зоны печати, подписи и штампов исключены (не печатный текст); строки собраны в ряды с компенсацией наклона.",
        "- Exact Match — шифр, стадия, редакция, лист со штампа и номер помещения; нормализация по типу поля (`FIELD_POLICY`).",
        "- Связка — группа засчитана, если набор (object_id, стадия, шифр, редакция) выбранных системой источников равен эталону.",
        "- Локализация и находки — все фрагменты эталона найдены: тот же file_id, та же страница, IoU ≥ 0,50; "
        "CANDIDATE с неполным доказательством — одновременно FP и FN.",
        "- FPR — CANDIDATE на группах NEGATIVE_VERIFIED, в том числе «ловушках», где нарушение есть только в устаревшей редакции.",
        "",
        "Воспроизвести (из `ml/`): `uv run python -m synth.factory --n 10 --seed 1 --out ../var/synth-v2` → "
        "`uv run python -m eval.run --gold ../var/synth-v2 --out ../var/eval --md ../docs/qa/ACCEPTANCE-14.md`.",
        "",
    ]
    return "\n".join(L)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Стенд оценки §14 (OS-INSP-6.5)")
    ap.add_argument("--gold", type=Path, default=ROOT / "var/synth-v2")
    ap.add_argument("--out", type=Path, default=ROOT / "var/eval")
    ap.add_argument("--bootstrap", type=int, default=ci_mod.DEFAULT_B)
    ap.add_argument("--seed", type=int, default=ci_mod.DEFAULT_SEED)
    ap.add_argument(
        "--limit",
        type=int,
        default=None,
        help="первые N объектов (правило №0: замер на малом)",
    )
    ap.add_argument(
        "--md", type=Path, default=None, help="куда ещё положить markdown-отчёт"
    )
    a = ap.parse_args(argv)
    rep = run(a.gold, a.out, a.bootstrap, a.seed, a.limit)
    if a.md:
        a.md.parent.mkdir(parents=True, exist_ok=True)
        a.md.write_text(to_markdown(rep), encoding="utf-8")
    print(
        f"{rep['verdict']['verdict']}; не пройдено: {rep['verdict']['failed']}; {rep['resources']}"
    )


if __name__ == "__main__":
    main()
