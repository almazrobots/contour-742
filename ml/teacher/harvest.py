"""Сбор очереди учителя: извлечения локального конвейера на объектах пакета организатора (T-076, OS-INSP-6.4.10).

Файл читается точечно из zip на Яндексе (remote_zip), разбирается и извлекается тем же путём, что в сервисе
(`parse_file` → `extract_refined`), каждое извлечение становится строкой очереди `var/teacher/queue.jsonl`.
Документы и очередь — вне git: в репозиторий попадают только модель, хеши и сводка.

Использование (правило №0 — сначала мало):
    python -m teacher.harvest --objects 17 --per-object 2
    python -m teacher.harvest --objects 01,14,15,16,17,18 --per-object 10
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path

from inspector_ml.paths import repo_root

ROOT = repo_root()
OUT = ROOT / "var/teacher"
REMOTE_DIR = "yandex:Загрузки/Хакатон/_ZIP_ДУБЛИ"
INVENTORY_DIR = Path(os.path.expanduser("~/Documents/2026.09 ЛЦТ НАДЗОРИУМ/Хакатон"))
ARCHIVES = {
    "01": "01_ПАКЕТ_УЧАСТНИКАМ_3_ОБЪЕКТА",
    "10": "10_Полярная_25_СОШ1100к7",
    "11": "11_Полярная_16",
    "12": "12_Полярная_25_ДОО220к9",
    "13": "13_УНДМС",
    "14": "14_Алтуфьевское_79Б",
    "15": "15_Полярная_17",
    "16": "16_Лосевская_3А",
    "17": "17_Изумрудная_12",
    "18": "18_Октябрьская_103",
}
# Разделы по убыванию улова значений Матрицы: ТЭП и пояснительные записки, затем решения по разделам
TIERS = (
    re.compile(r"ПЗ|пояснит|ТЭП|ПЗУ|СПОЗУ|общие данные|\bОД\b", re.I),
    re.compile(r"АР|КР|ПБ|ППМ|МОПБ|ОДИ|ЭЭ|ЭФ|ПОС|ООС", re.I),
)
# Скрытый тест организатора в обучение не идёт (ТЗ 9.4.2-03, OS-INSP-6.1.8): файлы из печатей ml/eval/seals
# отсеиваются по SHA-256, а объект экзамена — целиком (печать держит размеченные копии, у оригиналов иные хеши)
EXCLUDED_OBJECTS = {"Речников ул. 7-7"}
LOCK_CMD = Path("/tmp/building-tech-heavy.lock/cmd")
TIMED = re.compile(
    r"load-100|bench|stand|ocr|perf|e2e\.test\.ts", re.I
)  # замеры времени: не мешать (T-140, 81)
LOCK_PID = Path("/tmp/building-tech-heavy.lock/pid")
BF_TREE = str(
    Path.home() / "code/building-tech"
)  # гейт T-135 (bf) несёт пределы §11 — во время него тоже пауза
MAX_PAGES = 150
MAX_BYTES = 40_000_000


def object_of(path: str) -> str:
    """Объект — первый каталог пути («Изумрудная, 12/…»); в пакете участникам — каталог под 01_ДОКУМЕНТАЦИЯ."""
    parts = path.split("/")
    if len(parts) > 3 and parts[1] == "01_ДОКУМЕНТАЦИЯ":
        return parts[2]
    return parts[0]


def sealed_shas(seals_dir: Path | None = None) -> set[str]:
    d = seals_dir or ROOT / "ml/eval/seals"
    return {
        f["sha256"]
        for p in sorted(d.glob("*.json"))
        for f in json.loads(p.read_text("utf-8"))["files"]
    }


UNKNOWN = "<замок не прочитан>"


def lock_holder() -> str:
    """Команда замка и рабочий каталог держателя: local-gate из дерева T-135 меряет время, прочие — нет.
    Замка нет — пусто; замок есть, но не прочитан — UNKNOWN, и это пауза (отказ в закрытую сторону)."""
    if not LOCK_CMD.parent.exists():
        return ""
    try:
        cmd = LOCK_CMD.read_text()
        pid = LOCK_PID.read_text().strip()
        if not pid.isdigit():  # в lsof уходит только число
            return UNKNOWN
        out = subprocess.run(
            ["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"],
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout
        cwd = next((ln[1:] for ln in out.splitlines() if ln.startswith("n")), "")
    except (OSError, subprocess.SubprocessError):
        return UNKNOWN
    return f"{cmd.strip()} @ {cwd}"


def is_timed(holder: str) -> bool:
    if holder == UNKNOWN:
        return True
    cmd, _, cwd = holder.partition(" @ ")
    same_tree = bool(cwd) and os.path.realpath(cwd) == os.path.realpath(BF_TREE)
    return bool(TIMED.search(cmd)) or ("local-gate" in cmd and same_tree)


def guard_frozen() -> bool:
    """Рубильник load-guard заморозил держателя замка (SIGSTOP по температуре) — значит, и сбору стоять (диспетчер db)."""
    try:
        pid = LOCK_PID.read_text().strip()
        if not pid.isdigit():
            return False
        st = subprocess.run(
            ["ps", "-o", "stat=", "-p", pid], capture_output=True, text=True, timeout=10
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return "T" in st


def wait_timed_runs(read_cmd=lock_holder, sleep=time.sleep, frozen=guard_frozen) -> int:
    """Автопауза: пока замок держит прогон, меряющий время, сбор не качает и не разбирает. Возвращает число ожиданий."""
    n = 0
    while is_timed(read_cmd() or "") or frozen():
        n += 1
        sleep(30)
    return n


def service_specs(matrix: dict, passports_dir: Path | None = None) -> list:
    """Спецификации параметров как у сервиса (apps/api services/inspections.ts → extractorSpec): экстрактор из паспорта
    параметра, у порядковой шкалы — шкала и маркеры ограничения. Без паспорта M-001…M-005 шли бы общим путём, а не
    путём упоминаний, и учитель размечал бы не то, что выдаёт прод."""
    from eval.run import specs

    d = passports_dir or ROOT / "data/seed/passports"
    out = []
    for sp in specs(matrix):
        f = d / f"{sp.code}.json"
        if f.exists():
            pp = json.loads(f.read_text("utf-8"))
            ex = dict(pp["extractor"])
            if pp.get("value", {}).get("kind") == "ordinal":
                value = pp["value"]
                registry = json.loads((ROOT / "data/seed/scales.json").read_text("utf-8"))["scales"]
                shared = registry[value["scale_ref"]] if value.get("scale_ref") else {}
                scale = value["scale"] if "scale" in value else shared["values"]
                ex |= {"scale": scale, "constraint_markers": value.get("constraint_markers", [])}
                aliases = {**shared.get("aliases", {}), **value.get("aliases", {})}
                if aliases: ex["aliases"] = aliases
                if value.get("alt_systems"): ex["alt_systems"] = value["alt_systems"]
            sp = sp.model_copy(update={"extractor": ex})
        out.append(sp)
    return out


def eligible(row: dict) -> bool:
    """Полностью текстовый PDF/DOCX ПД или РД разумного размера: без сканов — без OCR и нагрузки на мак (диспетчер db)."""
    return (
        row.get("ext") in (".pdf", ".docx")
        and row.get("stage_guess") in ("PD", "RD")
        and (row.get("pages") or 0) > 0
        and (row.get("text_pages") or 0)
        >= row["pages"]  # ни одной страницы-скана: OCR (tesseract) на маке не нужен
        and row["pages"] <= MAX_PAGES
        and row.get("bytes", 0) <= MAX_BYTES
    )


def tier(path: str) -> int:
    name = path.rsplit("/", 1)[-1]
    return next((i for i, rx in enumerate(TIERS) if rx.search(name)), len(TIERS))


def select(
    inventory: list[dict], per_object: int, sealed: frozenset[str] = frozenset()
) -> list[dict]:
    """Детерминированный отбор: по объекту сначала разделы по TIERS, внутри — от меньших к большим."""
    by_obj: dict[str, list[dict]] = {}
    for r in inventory:
        if (
            eligible(r)
            and object_of(r["path"]) not in EXCLUDED_OBJECTS
            and r["sha256"] not in sealed
        ):
            by_obj.setdefault(object_of(r["path"]), []).append(r)
    out: list[dict] = []
    for obj in sorted(by_obj):
        rows = sorted(
            by_obj[obj], key=lambda r: (tier(r["path"]), r["bytes"], r["path"])
        )
        out += rows[:per_object]
    return out


def item_id(file_sha: str, e: dict) -> str:
    key = "|".join(
        str(x) for x in (file_sha, e["code"], e["page"], e["raw"], e["line_text"])
    )
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def queue_items(
    obj: str, row: dict, extractions: list, matrix: dict, page_sources: dict[int, str]
) -> list[dict]:
    """Строки очереди учителя из извлечений одного файла."""
    items = []
    for ex in extractions:
        e = ex.model_dump()
        p = matrix.get(e["code"], {})
        items.append(
            {
                "item_id": item_id(row["sha256"], e),
                "object": obj,
                "stage": row["stage_guess"],
                "path": row["path"],
                "file_sha256": row["sha256"],
                "page": e["page"],
                "page_source": page_sources.get(e["page"], "text"),
                "code": e["code"],
                "parameter_name": p.get("parameter_name"),
                "section": p.get("section"),
                "unit": p.get("unit"),
                "data_type": p.get("data_type"),
                "raw": e["raw"],
                "value_num": e["value_num"],
                "value_text": e["value_text"],
                "line_text": e["line_text"],
                "confidence": e["confidence"],
                "match": e["match"],
                "similarity": e["similarity"],
                "bbox": e["bbox"],
                "anchor_bbox": e["anchor_bbox"],
                "line_sha256": hashlib.sha256(e["line_text"].encode()).hexdigest(),
            }
        )
    return items


def run(
    codes: list[str], per_object: int, max_files: int | None = None
) -> int:  # pragma: no cover — IO
    """Порция сбора: не больше max_files файлов за захват замка (≈10 мин, договорённость с 81). Возвращает число файлов."""
    from eval.run import load_matrix
    from inspector_ml.parse import parse_file
    from inspector_ml.reread import extract_refined

    from .remote_zip import RemoteZip, rclone_fetch, remote_size

    matrix = load_matrix()
    all_specs = service_specs(matrix)
    files_dir = OUT / "files"
    files_dir.mkdir(parents=True, exist_ok=True)
    done_path = OUT / "done.jsonl"
    done = (
        {json.loads(line)["sha256"] for line in done_path.open()}
        if done_path.exists()
        else set()
    )
    taken = 0
    for code in codes:
        name = ARCHIVES[code]
        inventory = [
            json.loads(line) for line in (INVENTORY_DIR / f"ОПИСЬ__{name}.jsonl").open()
        ]
        chosen = [
            r
            for r in select(inventory, per_object, frozenset(sealed_shas()))
            if r["sha256"] not in done
        ]
        if max_files is not None:
            chosen = chosen[: max(0, max_files - taken)]
        if not chosen:
            continue
        remote = f"{REMOTE_DIR}/{name}.zip"
        rz = RemoteZip(rclone_fetch(remote), remote_size(remote))
        for row in chosen:
            taken += 1
            wait_timed_runs()
            t0 = time.perf_counter()
            rec = {"sha256": row["sha256"], "archive": code, "path": row["path"]}
            try:
                data = rz.read(row["path"])
                if hashlib.sha256(data).hexdigest() != row["sha256"]:
                    raise ValueError("sha256 не совпал с описью")
                local = files_dir / (row["sha256"][:16] + row["ext"])
                local.write_bytes(data)
                t1 = time.perf_counter()
                doc = parse_file(local, row["sha256"])
                ex = extract_refined(local, doc, all_specs)
                local.unlink(
                    missing_ok=True
                )  # копия документа нужна только на разбор (диск < 20 ГБ)
                items = queue_items(
                    object_of(row["path"]),
                    row,
                    ex,
                    matrix,
                    {p.page: p.source for p in doc.pages},
                )
                with (OUT / "queue.jsonl").open("a") as q:
                    for it in items:
                        q.write(json.dumps(it, ensure_ascii=False) + "\n")
                rec |= {
                    "status": "ok",
                    "items": len(items),
                    "pages": len(doc.pages),
                    "fetch_s": round(t1 - t0, 1),
                    "parse_extract_s": round(time.perf_counter() - t1, 1),
                    "local": local.name,
                }
            except Exception as e:  # noqa: BLE001 — сбой файла — данные прогона, а не остановка
                rec |= {"status": "error", "error": f"{type(e).__name__}: {e}"[:300]}
            with done_path.open("a") as d:
                d.write(json.dumps(rec, ensure_ascii=False) + "\n")
            print(json.dumps(rec, ensure_ascii=False), flush=True)
        time.sleep(
            45
        )  # пауза между архивами — окно для чужих захватов (договорённость с 81)
    return taken


def main() -> None:  # pragma: no cover
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--objects", required=True, help="коды архивов через запятую: 01,14,17"
    )
    ap.add_argument("--per-object", type=int, default=10)
    ap.add_argument(
        "--max-files", type=int, default=None, help="порция за один захват замка"
    )
    a = ap.parse_args()
    n = run(a.objects.split(","), a.per_object, a.max_files)
    print(json.dumps({"files": n}))


if __name__ == "__main__":  # pragma: no cover
    main()
