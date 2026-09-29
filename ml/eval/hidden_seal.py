"""Печать скрытого теста (T-137; OS-INSP-6.1.4–6.1.7; ТЗ 14.2-04, 9.4.2-03).

Организатор фиксирует состав скрытого теста и его SHA-256 до соревнования; метки участнику не передаются,
подбирать порог и обучаться на скрытом тесте нельзя. Печать хранит только SHA-256 файлов и роль
(«вход» — input, «метки» — labels), без путей: опись скрытого теста не публикуется (T-096).

КАНОН ОТПЕЧАТКА — тот же, что в apps/api/src/domain/hidden-seal.ts, байт в байт (паритет — тестами обеих сторон):

    digest = sha256_hex(utf8("hidden-seal/1\\n" + name + "\\n" + "".join(sorted(f"{role}:{sha256}\\n"))))

role ∈ {input, labels}; sha256 — 64 строчных hex-символа; name — [A-Za-z0-9._-]{1,100}, не «.» и не «..».
Пустая печать и повтор одного SHA-256 — ошибка.

Роль по пути (допущение плана T-137): «метки» — `data/annotations.jsonl`,
`data/hidden_gold_checks_organizer_only.jsonl`, `annotated_documents/*`, `VALIDATION.json`, `QA_SUMMARY.json`;
остальное — «вход». Дополнительные шаблоны меток — `--labels-glob` (fnmatch по пути с «/»).

CLI (`python -m eval.hidden_seal`):
    seal   --name N (--inventory опись.jsonl | --dir каталог) [--labels-glob ...] --out seals/N.json
    verify --seal S --dir D                          код 0 — состав совпал, 1 — нет (added/missing названы)
    commit --seal S --answer A --model-version V     запись ответа в журнал seals/<name>.journal.jsonl
    score  --seal S --answer A --labels L            балл табло eval/submission.py только по записанному ответу
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from eval import submission

CANON_VERSION = "hidden-seal/1"
ROLES = ("input", "labels")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_NAME = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
_LABEL_PARTS = (
    "/data/annotations.jsonl",
    "/data/hidden_gold_checks_organizer_only.jsonl",
    "/annotated_documents/",
)
_LABEL_SUFFIXES = ("/VALIDATION.json", "/QA_SUMMARY.json")
SEAL_KEYS = ("name", "digest", "sealed_at", "files", "n_files", "n_labels")


class SealError(ValueError):
    pass


# ─────────────────────────────────────────────── канон


def validate_name(name: str) -> str:
    if not isinstance(name, str) or not _NAME.fullmatch(name) or name in (".", ".."):
        raise SealError(
            f"имя печати {name!r}: латиница, цифры, «.», «_», «-», от 1 до 100 символов"
        )
    return name


def _strict_sha(s: object) -> str:
    if not isinstance(s, str) or not _HEX64.fullmatch(s):
        raise SealError(f"SHA-256 {s!r}: нужно 64 строчных шестнадцатеричных символа")
    return s


def _line(f: dict) -> str:
    return f"{f['role']}:{f['sha256']}\n"


def normalize_files(files: list[dict]) -> list[dict]:
    """Проверенные файлы печати в каноническом порядке (побайтовая сортировка строк канона)."""
    if not files:
        raise SealError("пустая печать: в скрытом тесте нет ни одного файла")
    seen: set[str] = set()
    out = []
    for f in files:
        if not isinstance(f, dict) or f.get("role") not in ROLES:
            raise SealError(
                f"роль {f.get('role') if isinstance(f, dict) else f!r}: допустимы input и labels"
            )
        s = _strict_sha(f.get("sha256"))
        if s in seen:
            raise SealError(f"SHA-256 {s} повторяется в печати")
        seen.add(s)
        out.append({"sha256": s, "role": f["role"]})
    return sorted(out, key=_line)


def seal_canon(name: str, files: list[dict]) -> str:
    return f"{CANON_VERSION}\n{validate_name(name)}\n" + "".join(
        _line(f) for f in normalize_files(files)
    )


def seal_digest(name: str, files: list[dict]) -> str:
    return hashlib.sha256(seal_canon(name, files).encode("utf-8")).hexdigest()


def _now() -> str:
    """UTC ISO 8601 с миллисекундами — как Date.toISOString() в API."""
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def make_seal(name: str, files: list[dict], sealed_at: str | None = None) -> dict:
    norm = normalize_files(files)
    return {
        "name": validate_name(name),
        "digest": seal_digest(name, norm),
        "sealed_at": sealed_at or _now(),
        "files": norm,
        "n_files": len(norm),
        "n_labels": sum(f["role"] == "labels" for f in norm),
    }


def load_seal(path: Path) -> dict:
    """Печать с диска; отпечаток и счётчики пересчитываются — подменённая печать не загружается."""
    s = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(s, dict) or set(s) != set(SEAL_KEYS):
        raise SealError(f"{path}: печать должна содержать ровно {', '.join(SEAL_KEYS)}")
    norm = normalize_files(s["files"])
    if seal_digest(s["name"], norm) != s["digest"]:
        raise SealError(f"{path}: отпечаток не совпадает с составом — печать изменена")
    if s["n_files"] != len(norm) or s["n_labels"] != sum(
        f["role"] == "labels" for f in norm
    ):
        raise SealError(f"{path}: счётчики n_files/n_labels не совпадают с составом")
    return s


def write_seal(seal: dict, out: Path) -> bool:
    """Записать печать. Та же печать уже есть — файл не трогается (False); другой отпечаток — отказ."""
    out = Path(out)
    if out.exists():
        old = load_seal(out)
        if old["digest"] != seal["digest"] or old["name"] != seal["name"]:
            raise SealError(
                f"{out}: печать «{old['name']}» уже есть с другим составом — печать только добавляется, возьмите новое имя"
            )
        return False
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps({k: seal[k] for k in SEAL_KEYS}, ensure_ascii=False, indent=1)
        + "\n",
        encoding="utf-8",
    )
    return True


# ─────────────────────────────────────────────── роли и источники


def role_of(path: str, labels_globs: list[str] | tuple[str, ...] = ()) -> str:
    p = "/" + str(path).replace("\\", "/").lstrip("/")
    if any(part in p for part in _LABEL_PARTS) or p.endswith(_LABEL_SUFFIXES):
        return "labels"
    if any(fnmatch.fnmatchcase(p.lstrip("/"), g) for g in labels_globs):
        return "labels"
    return "input"


def files_from_inventory(
    inventory: Path, labels_globs: list[str] = (), path_contains: str | None = None
) -> list[dict]:
    """Опись (JSONL: path, sha256) → файлы печати. Пути в печать не попадают.

    path_contains — взять только строки, в пути которых есть эта подстрока: оригиналы скрытого объекта лежат в общем
    пакете участника вперемешку с открытыми объектами (T-137: копии TEST_HIDDEN с разметкой и оригиналы из 01_ПАКЕТ
    имеют разные SHA-256, запечатывать нужно и те, и другие). Под фильтр не попал ни один файл — отказ.
    """
    out = []
    for n, line in enumerate(
        Path(inventory).read_text(encoding="utf-8").splitlines(), 1
    ):
        if not line.strip():
            continue
        row = json.loads(line)
        if (
            not isinstance(row, dict)
            or not isinstance(row.get("path"), str)
            or "sha256" not in row
        ):
            raise SealError(f"опись, строка {n}: нужны поля path и sha256")
        if path_contains is not None and path_contains not in row["path"]:
            continue
        out.append(
            {"sha256": row["sha256"], "role": role_of(row["path"], labels_globs)}
        )
    if path_contains is not None and not out:
        raise SealError(f"под фильтр пути «{path_contains}» не попал ни один файл описи")
    return out


def _file_sha(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def scan_dir(d: Path) -> dict[str, str]:
    """Относительный путь (с «/») → SHA-256 для каждого файла каталога."""
    d = Path(d)
    if not d.is_dir():
        raise SealError(f"{d}: каталог не найден")
    return {
        p.relative_to(d).as_posix(): _file_sha(p)
        for p in sorted(d.rglob("*"))
        if p.is_file()
    }


def files_from_dir(d: Path, labels_globs: list[str] = ()) -> list[dict]:
    return [
        {"sha256": s, "role": role_of(rel, labels_globs)}
        for rel, s in scan_dir(d).items()
    ]


# ─────────────────────────────────────────────── OS-INSP-6.1.5 сверка


def verify_dir(seal: dict, d: Path) -> dict:
    """added — файлы каталога не из печати (и повторные копии), по имени; missing — SHA-256 печати, которых нет."""
    want = {f["sha256"] for f in seal["files"]}
    got: set[str] = set()
    added = []
    for rel, s in scan_dir(d).items():
        if s not in want or s in got:
            added.append(rel)
        got.add(s)
    missing = sorted(want - got)
    return {"ok": not added and not missing, "added": sorted(added), "missing": missing}


# ─────────────────────────────────────────────── OS-INSP-6.1.7 журнал и балл


def journal_path(seal_path: Path, seal: dict) -> Path:
    return Path(seal_path).parent / f"{seal['name']}.journal.jsonl"


def read_journal(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [
        json.loads(x)
        for x in path.read_text(encoding="utf-8").splitlines()
        if x.strip()
    ]


def _answers(raw: object) -> list[dict]:
    """Ответ — объект по submission_schema.json или список таких объектов (по объекту на элемент)."""
    subs = raw if isinstance(raw, list) else [raw]
    if not subs:
        raise SealError("ответ пуст")
    for i, s in enumerate(subs):
        errors = submission.validate(s)
        if errors:
            raise SealError(
                f"ответ[{i}] не по схеме организатора: {'; '.join(errors[:3])}"
            )
    return subs


def commit(seal_path: Path, answer: Path, model_version: str) -> dict:
    seal = load_seal(seal_path)
    if not isinstance(model_version, str) or not 1 <= len(model_version) <= 200:
        raise SealError("версия модели: от 1 до 200 символов")
    data = Path(answer).read_bytes()
    _answers(json.loads(data.decode("utf-8")))
    sha = hashlib.sha256(data).hexdigest()
    jp = journal_path(seal_path, seal)
    if any(e.get("answer_sha256") == sha for e in read_journal(jp)):
        raise SealError(
            f"ответ {sha[:12]}… уже записан в журнал печати «{seal['name']}»"
        )
    entry = {
        "answer_sha256": sha,
        "model_version": model_version,
        "committed_at": _now(),
    }
    with jp.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


def can_score(
    seal: dict, journal: list[dict], answer_sha: str, labels_sha: str | None = None
) -> str | None:
    """Причина отказа или None (зеркало domain/hidden-seal.ts::canScore)."""
    a = _strict_sha(answer_sha.lower())
    if not any(e.get("answer_sha256") == a for e in journal):
        return f"ответа {a[:12]}… нет в журнале печати «{seal['name']}»: сначала commit, затем score"
    if labels_sha is not None:
        lab = _strict_sha(labels_sha.lower())
        if not any(f["role"] == "labels" and f["sha256"] == lab for f in seal["files"]):
            return f"файл меток {lab[:12]}… не входит в печать «{seal['name']}» с ролью «метки»"
    return None


def _gold(labels: Path) -> list[dict]:
    text = Path(labels).read_text(encoding="utf-8")
    try:
        data = json.loads(text)
        rows = data if isinstance(data, list) else [data]
    except json.JSONDecodeError:
        rows = [json.loads(x) for x in text.splitlines() if x.strip()]
    return [r for r in rows if isinstance(r, dict)]


def score(seal_path: Path, answer: Path, labels: Path) -> dict:
    seal = load_seal(seal_path)
    data = Path(answer).read_bytes()
    a_sha = hashlib.sha256(data).hexdigest()
    reason = can_score(
        seal,
        read_journal(journal_path(seal_path, seal)),
        a_sha,
        _file_sha(Path(labels)),
    )
    if reason:
        raise SealError(reason)
    gold = _gold(labels)
    objects = [
        submission.score(s, [g for g in gold if g.get("object_id") == s["object_id"]])
        for s in _answers(json.loads(data.decode("utf-8")))
    ]
    return {
        "seal": seal["name"],
        "answer_sha256": a_sha,
        "objects": objects,
        "mean_total": round(sum(o["total"] for o in objects) / len(objects), 2),
    }


# ─────────────────────────────────────────────── CLI


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m eval.hidden_seal", description="Печать скрытого теста (T-137)"
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("seal", help="запечатать скрытый тест")
    s.add_argument("--name", required=True)
    src = s.add_mutually_exclusive_group(required=True)
    src.add_argument(
        "--inventory", type=Path, help="опись JSONL с полями path и sha256"
    )
    src.add_argument("--dir", type=Path, help="каталог: SHA-256 файлов считается здесь")
    s.add_argument(
        "--labels-glob",
        action="append",
        default=[],
        help="дополнительный шаблон пути меток (fnmatch)",
    )
    s.add_argument(
        "--path-contains",
        help="только строки описи, в пути которых есть подстрока (оригиналы скрытого объекта в общем пакете)",
    )
    s.add_argument("--out", type=Path, required=True)
    v = sub.add_parser("verify", help="сверить каталог прогона с печатью")
    v.add_argument("--seal", type=Path, required=True)
    v.add_argument("--dir", type=Path, required=True)
    c = sub.add_parser("commit", help="записать ответ в журнал печати")
    c.add_argument("--seal", type=Path, required=True)
    c.add_argument("--answer", type=Path, required=True)
    c.add_argument("--model-version", required=True)
    sc = sub.add_parser("score", help="балл по меткам для записанного ответа")
    sc.add_argument("--seal", type=Path, required=True)
    sc.add_argument("--answer", type=Path, required=True)
    sc.add_argument("--labels", type=Path, required=True)
    return p


def _say(obj: object) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=1))


def main(argv: list[str] | None = None) -> int:
    a = _parser().parse_args(argv)
    try:
        if a.cmd == "seal":
            files = (
                files_from_inventory(a.inventory, a.labels_glob, a.path_contains)
                if a.inventory
                else files_from_dir(a.dir, a.labels_glob)
            )
            seal = make_seal(a.name, files)
            written = write_seal(seal, a.out)
            _say(
                {
                    "name": seal["name"],
                    "digest": seal["digest"],
                    "n_files": seal["n_files"],
                    "n_labels": seal["n_labels"],
                    "written": written,
                }
            )
            return 0
        if a.cmd == "verify":
            r = verify_dir(load_seal(a.seal), a.dir)
            _say(r)
            if not r["ok"]:
                print(
                    "прогон остановлен: состав скрытого теста расходится с печатью",
                    file=sys.stderr,
                )
            return 0 if r["ok"] else 1
        if a.cmd == "commit":
            _say(commit(a.seal, a.answer, a.model_version))
            return 0
        _say(score(a.seal, a.answer, a.labels))
        return 0
    except (
        SealError,
        OSError,
        json.JSONDecodeError,
        UnicodeDecodeError,
        submission.SubmissionError,
    ) as e:
        print(f"отказ: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
