"""Реестр итераций верификатора: артефакт, ворота, подпись, откат (T-076, OS-INSP-6.4.13–6.4.15). Синтетика."""

from __future__ import annotations

import json

import pytest

from inspector_ml import verifier as V
from inspector_ml import verifier_registry as R

from test_verifier import dataset

META = {
    "dataset_version": "teacher-abc",
    "split_hashes": {"train": "t", "validation": "v", "test": "x"},
    "matrix_version": "1.1",
    "training_code_hash": "c0de",
    "params": {"l2": 1.0},
    "trained_by": "ml-engineer",
    "labeler": ["claude-teacher"],
}


def _iter(tmp_path, version: str = "ev-1", data=None, params=None):
    res = V.train(data or dataset(), params)
    return R.record_iteration(tmp_path, res, META | {"model_version": version})


def test_итерация_пишет_артефакт_и_строку_реестра_и_ждёт_подписи(tmp_path) -> None:
    e = _iter(tmp_path)
    assert (
        e["status"] == "AWAITING_APPROVAL"
        and e["gate"]["ok"]
        and e["previous_model"] is None
    )
    for k in (
        "weights_hash",
        "dataset_version",
        "split_hashes",
        "matrix_version",
        "training_code_hash",
        "params",
        "metrics",
        "trained_by",
        "labeler",
        "created_at",
    ):
        assert e[k] not in (None, "")
    art = R.load_artifact(tmp_path, "ev-1")
    assert V.weights_hash(art) == e["weights_hash"] == art["weights_hash"]
    assert R.load_published(tmp_path) is None  # без подписи конвейер не меняется


def test_подпись_ответственного_публикует_а_обучавший_подписать_не_может(
    tmp_path,
) -> None:
    _iter(tmp_path)
    with pytest.raises(R.RegistryError, match="ответственный"):
        R.publish(tmp_path, "ev-1", "ml-engineer")
    with pytest.raises(R.RegistryError, match="подписи"):
        R.publish(tmp_path, "ev-1", "  ")
    p = R.publish(tmp_path, "ev-1", "owner")
    assert (
        p["status"] == "PUBLISHED"
        and p["approved_by"] == "owner"
        and p["rollback_to"] is None
    )
    assert R.load_published(tmp_path)["model_version"] == "ev-1"
    with pytest.raises(R.RegistryError, match="PUBLISHED"):
        R.publish(tmp_path, "ev-1", "owner")
    with pytest.raises(R.RegistryError, match="нет итерации"):
        R.publish(tmp_path, "ev-9", "owner")


def test_вторая_итерация_сравнивается_с_опубликованной_и_хранит_ссылку_отката(
    tmp_path,
) -> None:
    _iter(tmp_path)
    R.publish(tmp_path, "ev-1", "owner")
    e2 = _iter(tmp_path, "ev-2", params=V.TrainParams(l2=2.0))
    assert e2["previous_model"] == "ev-1" and e2["gate"]["compared_to"] == "previous"
    p2 = R.publish(tmp_path, "ev-2", "owner")
    assert p2["rollback_to"] == "ev-1"
    reg = json.loads((tmp_path / "registry.json").read_text())
    assert [i["status"] for i in reg["iterations"]] == ["SUPERSEDED", "PUBLISHED"]
    back = R.rollback(tmp_path, "owner", "рост ложных отбрасываний на новом объекте")
    assert (
        back["model_version"] == "ev-1"
        and R.load_published(tmp_path)["model_version"] == "ev-1"
    )
    reg = json.loads((tmp_path / "registry.json").read_text())
    assert reg["events"][-1] | {"at": None} == {
        "event": "ROLLED_BACK",
        "model_version": "ev-2",
        "to": "ev-1",
        "by": "owner",
        "reason": "рост ложных отбрасываний на новом объекте",
        "at": None,
    }


def test_откат_первой_модели_возвращает_конвейер_без_верификатора(tmp_path) -> None:
    _iter(tmp_path)
    R.publish(tmp_path, "ev-1", "owner")
    assert R.rollback(tmp_path, "owner", "причина") is None
    assert R.load_published(tmp_path) is None
    with pytest.raises(R.RegistryError, match="нет опубликованной"):
        R.rollback(tmp_path, "owner", "причина")
    with pytest.raises(R.RegistryError, match="без причины"):
        R.rollback(tmp_path, "owner", " ")


def test_модель_не_прошедшая_ворота_не_подписывается(tmp_path) -> None:
    res = V.train(dataset())
    res["metrics"]["test"]["keep_recall"] = 0.5  # тренер насчитал провал Recall
    e = R.record_iteration(tmp_path, res, META | {"model_version": "ev-bad"})
    assert e["status"] == "REJECTED_BY_GATE" and not e["gate"]["ok"]
    with pytest.raises(R.RegistryError, match="REJECTED_BY_GATE"):
        R.publish(tmp_path, "ev-bad", "owner")


def test_подменённый_артефакт_не_публикуется_и_не_загружается(tmp_path) -> None:
    _iter(tmp_path)
    p = tmp_path / "ev-1.json"
    art = json.loads(p.read_text())
    art["threshold"] = 0.0  # пропускать всё
    p.write_text(json.dumps(art))
    with pytest.raises(R.RegistryError, match="хеш весов"):
        R.publish(tmp_path, "ev-1", "owner")
    _iter(tmp_path, "ev-2")
    R.publish(tmp_path, "ev-2", "owner")
    q = tmp_path / "ev-2.json"
    art2 = json.loads(q.read_text())
    art2["weights"][0] += 1
    q.write_text(json.dumps(art2))
    with pytest.raises(R.RegistryError, match="не совпал"):
        R.load_published(tmp_path)


def test_повтор_версии_и_неудачное_обучение_не_записываются(tmp_path) -> None:
    _iter(tmp_path)
    with pytest.raises(R.RegistryError, match="уже есть"):
        _iter(tmp_path)
    bad = [it for it in dataset() if it["split"] != "test"]
    with pytest.raises(R.RegistryError, match="test"):
        R.record_iteration(tmp_path, V.train(bad), META | {"model_version": "ev-x"})
