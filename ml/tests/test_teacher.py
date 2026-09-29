"""Учитель разметки: отбор файлов, очередь, метки, выпуск набора по объектам (T-076, OS-INSP-6.4.10–6.4.11).
Только синтетика; документы пакета организатора в тесты не попадают (ADR-0002)."""

from __future__ import annotations

import json

import pytest

from inspector_ml.model import Extraction
from teacher import harvest as H
from teacher import labels as L


def row(
    path: str,
    stage: str = "PD",
    pages: int = 10,
    text: int = 10,
    size: int = 1000,
    ext: str = ".pdf",
) -> dict:
    return {
        "path": path,
        "stage_guess": stage,
        "pages": pages,
        "text_pages": text,
        "bytes": size,
        "ext": ext,
        "sha256": f"sha-{path}",
    }


def test_объект_и_годность_файла() -> None:
    assert (
        H.object_of("Изумрудная, 12/Проектная документация/ПЗ.pdf") == "Изумрудная, 12"
    )
    assert (
        H.object_of("ХАКАТОН/01_ДОКУМЕНТАЦИЯ/Новослободская/ПД/ПЗ.pdf")
        == "Новослободская"
    )
    assert H.eligible(row("a/ПЗ.pdf"))
    assert not H.eligible(row("a/ПЗ.pdf", stage="ID"))
    assert not H.eligible(
        row("a/ПЗ.pdf", text=8)
    )  # 80 % текста — скан-смесь, OCR не здесь
    assert not H.eligible(row("a/ПЗ.pdf", text=9))  # даже одна страница-скан — OCR, не берём
    assert not H.eligible(row("a/ПЗ.pdf", pages=151, text=151))
    assert not H.eligible(row("a/ПЗ.pdf", size=40_000_001))
    assert not H.eligible(row("a/ПЗ.dwg", ext=".dwg"))
    assert not H.eligible(row("a/ПЗ.pdf", pages=0, text=0))


def test_отбор_сначала_тэп_и_пз_детерминирован_и_без_экзамена_и_печати() -> None:
    inv = [
        row("O/ИОС5.pdf", size=10),
        row("O/АР1.pdf", size=500),
        row("O/ПЗ.pdf", size=900),
        row("O/ТЭП.pdf", size=100),
        row("P/ПЗУ.pdf"),
        row("ХАКАТОН/01_ДОКУМЕНТАЦИЯ/Речников ул. 7-7/ПД/ПЗ.pdf"),
        row("Q/ПЗ.pdf"),
    ]
    got = [r["path"] for r in H.select(inv, 3, frozenset({"sha-Q/ПЗ.pdf"}))]
    assert got == ["O/ТЭП.pdf", "O/ПЗ.pdf", "O/АР1.pdf", "P/ПЗУ.pdf"]
    assert H.select(list(reversed(inv)), 3, frozenset({"sha-Q/ПЗ.pdf"})) == H.select(
        inv, 3, frozenset({"sha-Q/ПЗ.pdf"})
    )


def test_печати_скрытого_теста_читаются_из_каталога(tmp_path) -> None:
    (tmp_path / "a.json").write_text(
        json.dumps({"files": [{"sha256": "x1", "role": "input"}]})
    )
    (tmp_path / "b.json").write_text(
        json.dumps({"files": [{"sha256": "x2", "role": "labels"}]})
    )
    assert H.sealed_shas(tmp_path) == {"x1", "x2"}
    assert len(H.sealed_shas()) >= 200  # печать организатора в репозитории (T-137)


def test_автопауза_ждёт_пока_замок_держит_замер_времени() -> None:
    states = iter(
        [
            f"scripts/local-gate.sh @ {H.BF_TREE}",  # гейт T-135 с пределами §11 — пауза
            "node scripts/load-100.mjs @ /x",
            "vitest tests/e2e.test.ts @ /y",
            "scripts/local-gate.sh @ /Users/u/code/building-tech-t139",  # гейт без замеров — работаем
        ]
    )
    slept = []
    assert H.wait_timed_runs(lambda: next(states), slept.append, lambda: False) == 3
    assert slept == [30, 30, 30]
    assert H.is_timed("bash perf-11.sh @ /z") and not H.is_timed("")
    assert H.wait_timed_runs(lambda: "", slept.append, lambda: False) == 0


def test_строки_очереди_из_извлечений() -> None:
    ex = Extraction(
        code="M-001",
        raw="1234",
        value_num=1234.0,
        page=3,
        bbox=None,
        line_text="Площадь застройки 1234 м²",
        confidence=0.95,
    )
    matrix = {
        "M-001": {
            "parameter_name": "Площадь застройки",
            "section": "ПЗ",
            "unit": "м²",
            "data_type": "number",
        }
    }
    [q] = H.queue_items("O", row("O/ПЗ.pdf"), [ex], matrix, {3: "ocr"})
    assert (
        q["object"] == "O"
        and q["section"] == "ПЗ"
        and q["page_source"] == "ocr"
        and q["unit"] == "м²"
    )
    assert (
        q["item_id"] == H.item_id("sha-O/ПЗ.pdf", ex.model_dump())
        and len(q["item_id"]) == 16
    )
    assert len(q["line_sha256"]) == 64
    [q2] = H.queue_items("O", row("O/ПЗ.pdf"), [ex], {}, {})
    assert q2["page_source"] == "text" and q2["parameter_name"] is None


def qitem(i: int, obj: str) -> dict:
    return {
        "item_id": f"i{i:03d}",
        "object": obj,
        "file_sha256": f"f{obj}",
        "line_sha256": f"l{i}",
        "code": "M-001",
        "section": "ПЗ",
        "page": 1,
        "raw": "1",
        "line_text": "x",
        "parameter_name": "П",
        "unit": "м²",
    }


def lab(i: int, label: str = "ACCEPT", **kw) -> dict:
    return {
        "item_id": f"i{i:03d}",
        "label": label,
        "reason": None if label == "ACCEPT" else "WRONG_VALUE",
        "rationale": "видно по строке",
        "labeler": "claude-teacher",
        "line_sha256": f"l{i}",
    } | kw


@pytest.mark.parametrize(
    "bad,msg",
    [
        ({"label": "MAYBE"}, "не из"),
        ({"label": "REJECT", "reason": "BAD"}, "справочника"),
        ({"reason": "WRONG_VALUE"}, "причины нет"),
        ({"rationale": " "}, "обоснования"),
        ({"labeler": ""}, "разметчик"),
        ({"line_sha256": "other"}, "хеш строки"),
    ],
)
def test_метка_без_справочной_причины_обоснования_или_к_чужой_строке_отклоняется(
    bad: dict, msg: str
) -> None:
    with pytest.raises(L.LabelError, match=msg):
        L.validate(lab(1) | bad, qitem(1, "A"))


def test_метка_к_несуществующей_строке() -> None:
    with pytest.raises(L.LabelError, match="нет такой строки"):
        L.validate(lab(1), None)
    L.validate(lab(1, "REJECT"), qitem(1, "A"))


def test_выпуск_набора_куратором_объект_целиком_в_одной_выборке() -> None:
    objs = ["A", "B", "C", "D", "E", "F", "G", "H"]
    queue = [qitem(i, objs[i % 8]) for i in range(80)]
    labels = [lab(i, "ACCEPT" if i % 3 else "REJECT") for i in range(80)] + [
        lab(5, "REJECT")
    ]  # исправление учителя
    ds = L.release(queue, labels, holdout={"H"}, released_by="owner")
    assert ds["objects"]["test"] == ["H"]
    seen: dict[str, str] = {}
    for it in ds["items"]:
        assert seen.setdefault(it["object"], it["split"]) == it["split"]
    assert (
        next(it for it in ds["items"] if it["item_id"] == "i005")["label"] == "REJECT"
    )
    assert len(ds["items"]) == 80 and ds["labelers"] == ["claude-teacher"]
    assert ds["dataset_version"].startswith("teacher-") and set(ds["split_hashes"]) == {
        "train",
        "validation",
        "test",
    }
    again = L.release(
        list(reversed(queue)), labels, holdout={"H"}, released_by="curator-2"
    )
    assert (
        again["dataset_version"] == ds["dataset_version"]
        and again["split_hashes"] == ds["split_hashes"]
    )
    forced = L.release(
        queue, labels, holdout={"H"}, released_by="owner", validation={"A"}
    )
    assert (
        "A" in forced["objects"]["validation"]
        and forced["dataset_version"] != ds["dataset_version"]
    )


def test_выпуск_без_куратора_и_с_файлом_скрытого_теста_запрещён() -> None:
    queue = [qitem(i, "A") for i in range(3)]
    with pytest.raises(L.LabelError, match="куратор"):
        L.release(queue, [lab(0)], holdout=set(), released_by=" ")
    with pytest.raises(L.LabelError, match="скрытого теста"):
        L.release(
            queue,
            [lab(0)],
            holdout=set(),
            released_by="owner",
            sealed=frozenset({"fA"}),
        )


def test_разбиение_по_хешу_объекта_детерминировано() -> None:
    assert L.split_of("X", {"X"}) == "test"
    assert L.split_of("Y", set()) == L.split_of("Y", set())
    assert {L.split_of(f"obj{i}", set()) for i in range(40)} == {"train", "validation"}
    assert L.split_of("Y", set(), validation_share=0.0) == "train"
    assert L.split_of("Y", set(), validation_share=1.01) == "validation"


def test_строка_sft_корпуса() -> None:
    it = qitem(1, "A") | {
        "label": "REJECT",
        "reason": "WRONG_VALUE",
        "correct_value": "1234",
        "split": "train",
        "labeler": "claude-teacher",
    }
    r = L.sft_record(it)
    assert [m["role"] for m in r["messages"]] == ["system", "user", "assistant"]
    assert json.loads(r["messages"][2]["content"]) == {
        "verdict": "REJECT",
        "reason": "WRONG_VALUE",
        "value": "1234",
    }
    assert "M-001" in r["messages"][1]["content"] and r["meta"]["split"] == "train"


def test_паспорт_набора_для_репозитория_без_текстов_документов() -> None:
    from teacher import iterate as I

    queue = [
        qitem(i, "AB"[i % 2]) | {"line_text": "СЕКРЕТНАЯ СТРОКА", "raw": "777"}
        for i in range(6)
    ]
    labels = [lab(i, "REJECT" if i == 0 else "ACCEPT") for i in range(6)]
    pp = I.passport(L.release(queue, labels, holdout={"B"}, released_by="owner"))
    text = json.dumps(pp, ensure_ascii=False)
    assert "СЕКРЕТНАЯ" not in text and "777" not in text
    assert (
        pp["counts"]["test"] == {"ACCEPT": 3}
        and pp["reject_reasons"] == {"WRONG_VALUE": 1}
        and pp["codes"] == 1
    )
    assert I.matrix_version().startswith("matrix-sha256-") and len(I.code_hash()) == 64


def test_спецификации_как_у_сервиса_экстрактор_из_паспорта(tmp_path) -> None:
    from eval.run import load_matrix

    sp = {s.code: s for s in H.service_specs(load_matrix())}
    assert (
        sp["M-001"].extractor["kind"] == "quantity_mentions"
        and "2" in sp["M-001"].extractor["superscripts"]
    )
    assert (
        "scale" in sp["M-023"].extractor
    )  # порядковая шкала — со шкалой и маркерами ограничения
    assert sp["M-022"].extractor["scale"] == ["V", "IV", "III", "II", "I"]
    assert sp["M-014"].extractor is None
    (tmp_path / "M-014.json").write_text(
        json.dumps({"extractor": {"kind": "x"}, "value": {"kind": "number"}})
    )
    assert H.service_specs(load_matrix(), tmp_path)[13].extractor == {"kind": "x"}


def test_отчёт_итерации_берёт_цифры_из_реестра_и_паспорта(
    tmp_path, monkeypatch
) -> None:
    from inspector_ml import verifier as V
    from inspector_ml import verifier_registry as R
    from teacher import iterate as I
    from teacher import report as P
    from test_verifier import dataset

    items = dataset()
    ds = {
        "dataset_version": "teacher-x",
        "released_by": "owner",
        "labelers": ["claude-teacher"],
        "split_hashes": {"train": "a" * 64, "validation": "b" * 64, "test": "c" * 64},
        "objects": {"train": ["O1"], "validation": ["O2"], "test": ["O3"]},
        "items": [
            it | {"reason": None if it["label"] == "ACCEPT" else "NOT_A_VALUE"}
            for it in items
        ],
    }
    (tmp_path / "datasets").mkdir()
    (tmp_path / "datasets" / "teacher-x.json").write_text(
        json.dumps(I.passport(ds), ensure_ascii=False)
    )
    R.record_iteration(
        tmp_path,
        V.train(items),
        {
            "model_version": "ev-1",
            "dataset_version": "teacher-x",
            "split_hashes": ds["split_hashes"],
            "matrix_version": "m",
            "training_code_hash": "c" * 64,
            "params": {"min_keep": 0.98},
            "trained_by": "ml",
            "labeler": ["claude-teacher"],
        },
    )
    monkeypatch.setattr(P, "ART", tmp_path)
    md = P.render("ev-1")
    assert (
        "AWAITING_APPROVAL" in md
        and "пройдены" in md
        and "teacher-x" in md
        and "NOT_A_VALUE" in md
    )
    assert (
        "100.0 %" in md and "Пропущено ошибочных" in md and "retrain-iter.sh ev-1" in md
    )
    assert P.pct(None) == "—" and P.ci([0.1, 0.25]) == "[10.0; 25.0]"
    art = json.loads((tmp_path / "ev-1.json").read_text())
    art["threshold"] = 0.0
    (tmp_path / "ev-1.json").write_text(json.dumps(art))
    with pytest.raises(ValueError, match="хеш весов"):
        P.render("ev-1")


def test_автопауза_в_закрытую_сторону_при_непрочитанном_замке(tmp_path, monkeypatch) -> None:
    assert H.is_timed(H.UNKNOWN)
    lock = tmp_path / "lock"
    monkeypatch.setattr(H, "LOCK_CMD", lock / "cmd")
    monkeypatch.setattr(H, "LOCK_PID", lock / "pid")
    assert H.lock_holder() == ""  # замка нет — свободно
    lock.mkdir()
    assert H.lock_holder() == H.UNKNOWN  # замок есть, файлов нет — пауза
    (lock / "cmd").write_text("scripts/local-gate.sh")
    (lock / "pid").write_text("1; rm -rf /")
    assert H.lock_holder() == H.UNKNOWN  # pid не число — в lsof не уходит
    assert H.is_timed(f"scripts/local-gate.sh @ {H.BF_TREE}/")  # каталог сравнивается по realpath


def test_пауза_пока_рубильник_морозит_держателя_замка() -> None:
    frozen = iter([True, True, False])
    slept = []
    assert H.wait_timed_runs(lambda: "", slept.append, lambda: next(frozen)) == 2
