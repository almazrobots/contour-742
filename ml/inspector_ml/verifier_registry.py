"""Реестр итераций верификатора извлечения: артефакт, ворота, подпись, откат (T-076, OS-INSP-6.4.13–6.4.15).

Каталог `ml/artifacts/extract-verifier/`: `<model_version>.json` — артефакт (веса, порог, карточка итерации),
`registry.json` — журнал итераций. Статусы: AWAITING_APPROVAL → PUBLISHED (подпись ответственного) → SUPERSEDED;
REJECTED_BY_GATE — не подписывается; откат возвращает предыдущую опубликованную и пишет запись в журнал.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .paths import repo_root
from .verifier import gate, weights_hash

DEFAULT_DIR = repo_root() / "ml/artifacts/extract-verifier"


class RegistryError(ValueError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read(root: Path) -> dict:
    p = root / "registry.json"
    return (
        json.loads(p.read_text("utf-8"))
        if p.exists()
        else {"iterations": [], "events": []}
    )


def _write(root: Path, reg: dict) -> None:
    root.mkdir(parents=True, exist_ok=True)
    tmp = root / "registry.json.tmp"
    tmp.write_text(json.dumps(reg, ensure_ascii=False, indent=1) + "\n", "utf-8")
    tmp.replace(root / "registry.json")


def published(reg: dict) -> dict | None:
    return next(
        (it for it in reversed(reg["iterations"]) if it["status"] == "PUBLISHED"), None
    )


def record_iteration(root: Path, result: dict, meta: dict) -> dict:
    """Записать итерацию: артефакт + строка реестра. Ворота — против опубликованной модели (или базовой)."""
    if not result.get("ok"):
        raise RegistryError("; ".join(result.get("reasons", ["обучение не удалось"])))
    reg = _read(root)
    prev = published(reg)
    g = gate(prev["metrics"]["test"] if prev else None, result["metrics"])
    version = meta["model_version"]
    if any(it["model_version"] == version for it in reg["iterations"]):
        raise RegistryError(f"версия {version} уже есть в реестре")
    entry = {
        "model_version": version,
        "weights_hash": result["weights_hash"],
        "dataset_version": meta["dataset_version"],
        "split_hashes": meta["split_hashes"],
        "matrix_version": meta["matrix_version"],
        "training_code_hash": meta["training_code_hash"],
        "params": meta["params"],
        "labeler": meta.get("labeler"),
        "metrics": result["metrics"],
        "gate": g,
        "status": "AWAITING_APPROVAL" if g["ok"] else "REJECTED_BY_GATE",
        "previous_model": prev["model_version"] if prev else None,
        "trained_by": meta["trained_by"],
        "created_at": _now(),
        "approved_by": None,
        "approved_at": None,
        "rollback_to": None,
    }
    root.mkdir(parents=True, exist_ok=True)
    artifact = result["model"] | {
        "model_version": version,
        "weights_hash": result["weights_hash"],
    }
    (root / f"{version}.json").write_text(
        json.dumps(artifact, ensure_ascii=False, indent=1) + "\n", "utf-8"
    )
    reg["iterations"].append(entry)
    _write(root, reg)
    return entry


def publish(root: Path, version: str, approved_by: str) -> dict:
    """Подпись ответственного: только итерация, прошедшая ворота; прежняя опубликованная становится точкой отката."""
    if not approved_by.strip():
        raise RegistryError("публикация без подписи ответственного запрещена")
    reg = _read(root)
    it = next((x for x in reg["iterations"] if x["model_version"] == version), None)
    if it is None:
        raise RegistryError(f"нет итерации {version}")
    if it["status"] != "AWAITING_APPROVAL":
        raise RegistryError(
            f"итерация {version} в статусе {it['status']} — подписать нельзя"
        )
    if it["trained_by"] == approved_by:
        raise RegistryError("подписывает ответственный, а не тот, кто обучал")
    art = load_artifact(root, version)
    if weights_hash(art) != it["weights_hash"]:
        raise RegistryError("артефакт изменён после обучения: хеш весов не совпал")
    prev = published(reg)
    if prev:
        prev["status"] = "SUPERSEDED"
    it |= {
        "status": "PUBLISHED",
        "approved_by": approved_by,
        "approved_at": _now(),
        "rollback_to": prev["model_version"] if prev else None,
    }
    reg["events"].append(
        {
            "event": "PUBLISHED",
            "model_version": version,
            "by": approved_by,
            "at": it["approved_at"],
        }
    )
    _write(root, reg)
    return it


def rollback(root: Path, by: str, reason: str) -> dict | None:
    """Откат: снять опубликованную, вернуть её rollback_to (или конвейер без верификатора). Причина обязательна."""
    if not reason.strip():
        raise RegistryError("откат без причины запрещён")
    reg = _read(root)
    cur = published(reg)
    if cur is None:
        raise RegistryError("нет опубликованной модели")
    cur["status"] = "ROLLED_BACK"
    back = next(
        (x for x in reg["iterations"] if x["model_version"] == cur["rollback_to"]), None
    )
    if back:
        back["status"] = "PUBLISHED"
    reg["events"].append(
        {
            "event": "ROLLED_BACK",
            "model_version": cur["model_version"],
            "to": cur["rollback_to"],
            "by": by,
            "reason": reason,
            "at": _now(),
        }
    )
    _write(root, reg)
    return back


def load_artifact(root: Path, version: str) -> dict:
    return json.loads((root / f"{version}.json").read_text("utf-8"))


def load_published(root: Path = DEFAULT_DIR) -> dict | None:
    """Модель для конвейера: только опубликованная и с целым хешем весов, иначе — None (извлечение без изменений)."""
    reg = _read(root)
    cur = published(reg)
    if cur is None:
        return None
    art = load_artifact(root, cur["model_version"])
    if weights_hash(art) != cur["weights_hash"]:
        raise RegistryError(f"артефакт {cur['model_version']} не совпал с реестром")
    return art
