"""Печать скрытого теста (T-137; OS-INSP-6.1.4–6.1.7; ТЗ 14.2-04, 9.4.2-03): eval/hidden_seal.py.

Синтетика во временном каталоге; корпус и файлы организатора не открываются. Паритет отпечатка с
apps/api/src/domain/hidden-seal.ts — одна фикстура и один hex в обоих тестах.
"""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pytest

from eval import hidden_seal as hs
from eval import submission as sb

H = lambda c: c * 64  # noqa: E731
# Фикстура паритета: тот же вход и тот же hex зашиты в apps/api/tests/domain-hidden-seal.test.ts
PARITY_FILES = [
    {"sha256": H("b"), "role": "labels"},
    {"sha256": "0123456789abcdef" * 4, "role": "input"},
    {"sha256": H("a"), "role": "input"},
]
PARITY_HEX = "9fdf617e45711e5bfa6bcb25d67a4145630e59d388105ab2b9b9a3fcf4125a80"
REAL_SEAL = Path(hs.__file__).parent / "seals" / "organizer-test-hidden-213.json"


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def write_inventory(path: Path, rows: list[dict]) -> Path:
    path.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
        encoding="utf-8",
    )
    return path


INV_ROWS = [
    {"path": "HIDDEN/QA_SUMMARY.json", "sha256": H("1")},
    {"path": "HIDDEN/VALIDATION.json", "sha256": H("2")},
    {"path": "HIDDEN/data/annotations.jsonl", "sha256": H("3")},
    {"path": "HIDDEN/data/hidden_gold_checks_organizer_only.jsonl", "sha256": H("4")},
    {"path": "HIDDEN/annotated_documents/F1__РАЗМЕЧЕНО.pdf", "sha256": H("5")},
    {"path": "HIDDEN/data/files_index.jsonl", "sha256": H("6")},
    {"path": "HIDDEN/docs/F1.pdf", "sha256": H("7")},
]


def gold(cid: str, code: str, loc: str) -> dict:
    return {
        "check_id": cid,
        "object_id": "OBJ-S",
        "parameter_code": code,
        "location": loc,
        "violation_label": "VIOLATION_PRESENT",
        "protocol_status": "WARNING",
        "criticality": None,
        "score_eligible": True,
        "evidence": [{"stage": "PD", "file_id": "F1", "pdf_page_number": 1}],
    }


GOLD = [gold("G1", "M-001", "1"), gold("G2", "M-002", "2")]
ANSWER = {
    "object_id": "OBJ-S",
    "checks": [
        {
            k: g[k]
            for k in (
                "parameter_code",
                "location",
                "violation_label",
                "protocol_status",
                "criticality",
                "evidence",
            )
        }
        for g in GOLD[:1]
    ],
}


def hidden_dir(tmp_path: Path) -> tuple[Path, Path, Path]:
    """Каталог скрытого теста: вход, метки (annotations.jsonl), и где лежат печати."""
    d = tmp_path / "hidden"
    (d / "docs").mkdir(parents=True)
    (d / "data").mkdir()
    (d / "docs" / "F1.pdf").write_bytes(b"%PDF-1.7 synthetic\n%%EOF")
    labels = d / "data" / "annotations.jsonl"
    labels.write_text(
        "".join(json.dumps(g, ensure_ascii=False) + "\n" for g in GOLD),
        encoding="utf-8",
    )
    seals = tmp_path / "seals"
    seals.mkdir()
    return d, labels, seals


# ─────────────────────────────── OS-INSP-6.1.4 печать


@pytest.mark.l2_differential
def test_parity_digest_matches_typescript():
    """отпечаток печати совпадает с domain/hidden-seal.ts байт в байт (фикстура паритета)"""
    assert hs.seal_digest("parity-fixture", PARITY_FILES) == PARITY_HEX
    assert hs.seal_canon("parity-fixture", PARITY_FILES) == (
        "hidden-seal/1\nparity-fixture\n"
        f"input:{'0123456789abcdef' * 4}\ninput:{H('a')}\nlabels:{H('b')}\n"
    )
    assert hs.seal_digest("parity-fixture", list(reversed(PARITY_FILES))) == PARITY_HEX


@pytest.mark.l1_functional
def test_role_rule_from_inventory_paths():
    """роль «метки» — annotations, hidden_gold_checks, annotated_documents, VALIDATION.json, QA_SUMMARY.json; прочее — «вход»"""
    roles = [hs.role_of(r["path"]) for r in INV_ROWS]
    assert roles == ["labels"] * 5 + ["input"] * 2
    assert hs.role_of("VALIDATION.json") == "labels"
    assert hs.role_of("x/NOT_VALIDATION.json.bak") == "input"
    assert hs.role_of("x\\annotated_documents\\a.pdf") == "labels"
    assert hs.role_of("HIDDEN/docs/F1.pdf", ["*/docs/*"]) == "labels"


@pytest.mark.l1_functional
def test_seal_from_inventory_keeps_only_hashes_and_roles(tmp_path, capsys):
    """печать из описи хранит только имя, отпечаток, время, SHA-256 с ролью и счётчики — без путей"""
    inv = write_inventory(tmp_path / "inv.jsonl", INV_ROWS)
    out = tmp_path / "seals" / "s.json"
    assert (
        hs.main(["seal", "--name", "s", "--inventory", str(inv), "--out", str(out)])
        == 0
    )
    data = json.loads(out.read_text(encoding="utf-8"))
    assert set(data) == {"name", "digest", "sealed_at", "files", "n_files", "n_labels"}
    assert (data["n_files"], data["n_labels"]) == (7, 5)
    assert all(set(f) == {"sha256", "role"} for f in data["files"])
    text = out.read_text(encoding="utf-8")
    assert "HIDDEN" not in text and "/" not in text.replace("hidden-seal/1", "")
    assert data["digest"] == hs.seal_digest("s", data["files"])
    assert hs.load_seal(out)["digest"] == data["digest"]


@pytest.mark.l1_functional
def test_reseal_same_is_noop_other_is_refused(tmp_path):
    """повторная печать того же состава не меняет файл; другой состав под тем же именем — отказ"""
    inv = write_inventory(tmp_path / "inv.jsonl", INV_ROWS)
    out = tmp_path / "s.json"
    assert (
        hs.main(["seal", "--name", "s", "--inventory", str(inv), "--out", str(out)])
        == 0
    )
    before = out.read_bytes()
    assert (
        hs.main(["seal", "--name", "s", "--inventory", str(inv), "--out", str(out)])
        == 0
    )
    assert out.read_bytes() == before
    inv2 = write_inventory(tmp_path / "inv2.jsonl", INV_ROWS[:-1])
    assert (
        hs.main(["seal", "--name", "s", "--inventory", str(inv2), "--out", str(out)])
        == 1
    )
    assert out.read_bytes() == before


@pytest.mark.l1_functional
def test_seal_from_dir_computes_hashes(tmp_path):
    """печать каталога считает SHA-256 файлов сама, роль — по тому же правилу путей"""
    d, labels, seals = hidden_dir(tmp_path)
    out = seals / "dir.json"
    assert hs.main(["seal", "--name", "dir", "--dir", str(d), "--out", str(out)]) == 0
    s = hs.load_seal(out)
    assert {f["sha256"]: f["role"] for f in s["files"]} == {
        sha((d / "docs" / "F1.pdf").read_bytes()): "input",
        sha(labels.read_bytes()): "labels",
    }


@pytest.mark.l6_adversarial
@pytest.mark.parametrize(
    "rows, name",
    [
        ([{"path": "a", "sha256": "z" * 64}], "s"),
        ([{"path": "a", "sha256": H("a")[1:]}], "s"),
        ([{"path": "a", "sha256": H("A")}], "s"),
        ([{"path": "a", "sha256": H("a")}, {"path": "b", "sha256": H("a")}], "s"),
        ([], "s"),
        ([{"path": "a"}], "s"),
        ([{"path": "a", "sha256": H("a")}], "../etc"),
        ([{"path": "a", "sha256": H("a")}], ""),
        ([{"path": "a", "sha256": H("a")}], "x" * 101),
    ],
)
def test_hostile_seal_inputs_are_refused(tmp_path, rows, name):
    """враждебные входы печати: не-hex, короткий, заглавные, дубли, пустая опись, нет sha256, плохое имя — отказ"""
    inv = write_inventory(tmp_path / "inv.jsonl", rows)
    out = tmp_path / "s.json"
    assert (
        hs.main(["seal", "--name", name, "--inventory", str(inv), "--out", str(out)])
        == 1
    )
    assert not out.exists()


@pytest.mark.l3_boundary
def test_name_bounds():
    """границы имени печати: 1 и 100 символов допустимы"""
    f = [{"sha256": H("a"), "role": "input"}]
    assert hs.seal_digest("x", f)
    assert hs.seal_digest("x" * 100, f)
    with pytest.raises(hs.SealError):
        hs.seal_digest(".", f)


@pytest.mark.l4_fault
def test_tampered_seal_file_is_rejected_on_load(tmp_path):
    """печать с подменённым составом или счётчиком не загружается"""
    s = hs.make_seal("t", PARITY_FILES)
    p = tmp_path / "t.json"
    bad = copy.deepcopy(s)
    bad["files"][0]["sha256"] = H("c")
    p.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(hs.SealError, match="отпечаток"):
        hs.load_seal(p)
    bad = copy.deepcopy(s)
    bad["n_labels"] = 0
    p.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(hs.SealError):
        hs.load_seal(p)


# ─────────────────────────────── OS-INSP-6.1.5 сверка


@pytest.mark.l1_functional
def test_verify_before_run_names_added_changed_missing(tmp_path, capsys):
    """сверка перед прогоном: совпадение — код 0; добавленный, изменённый и пропавший файл — код 1 и имя файла"""
    d, labels, seals = hidden_dir(tmp_path)
    s = seals / "v.json"
    assert hs.main(["seal", "--name", "v", "--dir", str(d), "--out", str(s)]) == 0
    assert hs.main(["verify", "--seal", str(s), "--dir", str(d)]) == 0
    (d / "docs" / "extra.pdf").write_bytes(b"extra")
    capsys.readouterr()
    assert hs.main(["verify", "--seal", str(s), "--dir", str(d)]) == 1
    assert "docs/extra.pdf" in capsys.readouterr().out
    (d / "docs" / "extra.pdf").unlink()
    old = sha((d / "docs" / "F1.pdf").read_bytes())
    (d / "docs" / "F1.pdf").write_bytes(b"%PDF-1.7 changed\n%%EOF")
    assert hs.main(["verify", "--seal", str(s), "--dir", str(d)]) == 1
    out = capsys.readouterr().out
    assert "docs/F1.pdf" in out and old in out
    r = hs.verify_dir(hs.load_seal(s), d)
    assert r["ok"] is False and r["added"] == ["docs/F1.pdf"] and r["missing"] == [old]


# ─────────────────────────────── OS-INSP-6.1.7 журнал и балл


@pytest.mark.l1_functional
def test_score_only_for_committed_answer(tmp_path, capsys):
    """балл по меткам — только для ответа, заранее записанного в журнал печати; балл — табло submission.score"""
    d, labels, seals = hidden_dir(tmp_path)
    s = seals / "j.json"
    assert hs.main(["seal", "--name", "j", "--dir", str(d), "--out", str(s)]) == 0
    ans = tmp_path / "answer.json"
    ans.write_text(json.dumps(ANSWER, ensure_ascii=False), encoding="utf-8")
    assert (
        hs.main(
            ["score", "--seal", str(s), "--answer", str(ans), "--labels", str(labels)]
        )
        == 1
    )
    assert "нет в журнале" in capsys.readouterr().err
    assert (
        hs.main(
            [
                "commit",
                "--seal",
                str(s),
                "--answer",
                str(ans),
                "--model-version",
                "rank-v1",
            ]
        )
        == 0
    )
    journal = [
        json.loads(x)
        for x in (seals / "j.journal.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert journal == [
        {
            "answer_sha256": sha(ans.read_bytes()),
            "model_version": "rank-v1",
            "committed_at": journal[0]["committed_at"],
        }
    ]
    assert journal[0]["committed_at"].endswith("Z")
    capsys.readouterr()
    assert (
        hs.main(
            ["score", "--seal", str(s), "--answer", str(ans), "--labels", str(labels)]
        )
        == 0
    )
    result = json.loads(capsys.readouterr().out)
    assert result["objects"][0]["total"] == sb.score(ANSWER, GOLD)["total"]
    assert result["answer_sha256"] == sha(ans.read_bytes())


@pytest.mark.l6_adversarial
def test_score_refuses_labels_outside_seal_and_changed_answer(tmp_path, capsys):
    """метки не из печати или входной файл как метки — отказ; ответ, изменённый после записи в журнал, — отказ"""
    d, labels, seals = hidden_dir(tmp_path)
    s = seals / "k.json"
    assert hs.main(["seal", "--name", "k", "--dir", str(d), "--out", str(s)]) == 0
    ans = tmp_path / "answer.json"
    ans.write_text(json.dumps(ANSWER), encoding="utf-8")
    assert (
        hs.main(
            ["commit", "--seal", str(s), "--answer", str(ans), "--model-version", "m"]
        )
        == 0
    )
    fake = tmp_path / "fake.jsonl"
    fake.write_text(labels.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    assert (
        hs.main(
            ["score", "--seal", str(s), "--answer", str(ans), "--labels", str(fake)]
        )
        == 1
    )
    assert (
        hs.main(
            [
                "score",
                "--seal",
                str(s),
                "--answer",
                str(ans),
                "--labels",
                str(d / "docs" / "F1.pdf"),
            ]
        )
        == 1
    )
    ans.write_text(json.dumps({**ANSWER, "checks": []}), encoding="utf-8")
    capsys.readouterr()
    assert (
        hs.main(
            ["score", "--seal", str(s), "--answer", str(ans), "--labels", str(labels)]
        )
        == 1
    )
    assert "нет в журнале" in capsys.readouterr().err


@pytest.mark.l4_fault
def test_commit_refuses_invalid_or_repeated_answer(tmp_path):
    """в журнал не пишется ответ не по схеме организатора и повтор того же ответа"""
    d, labels, seals = hidden_dir(tmp_path)
    s = seals / "c.json"
    assert hs.main(["seal", "--name", "c", "--dir", str(d), "--out", str(s)]) == 0
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"checks": "нет"}), encoding="utf-8")
    assert (
        hs.main(
            ["commit", "--seal", str(s), "--answer", str(bad), "--model-version", "m"]
        )
        == 1
    )
    assert not (seals / "c.journal.jsonl").exists()
    ans = tmp_path / "answer.json"
    ans.write_text(json.dumps(ANSWER), encoding="utf-8")
    assert (
        hs.main(
            ["commit", "--seal", str(s), "--answer", str(ans), "--model-version", "m"]
        )
        == 0
    )
    assert (
        hs.main(
            ["commit", "--seal", str(s), "--answer", str(ans), "--model-version", "m2"]
        )
        == 1
    )
    assert (
        len((seals / "c.journal.jsonl").read_text(encoding="utf-8").splitlines()) == 1
    )
    assert (
        hs.main(
            ["commit", "--seal", str(s), "--answer", str(ans), "--model-version", ""]
        )
        == 1
    )


# ─────────────────────────────── реальная печать описи организатора


@pytest.mark.l7_discipline
def test_real_organizer_seal_is_valid_and_has_no_paths():
    """печать TEST_HIDDEN организатора валидна: отпечаток пересчитывается, 222 файла, путей нет"""
    s = hs.load_seal(REAL_SEAL)
    assert s["name"] == "organizer-test-hidden-213"
    assert s["n_files"] == 222 == len(s["files"])
    assert s["digest"] == hs.seal_digest(s["name"], s["files"])
    assert s["n_labels"] == sum(f["role"] == "labels" for f in s["files"]) == 217
    raw = REAL_SEAL.read_text(encoding="utf-8")
    assert (
        "РАЗМЕЧЕН" not in raw
        and ".pdf" not in raw
        and '.json"' not in raw
        and "/" not in raw
    )


@pytest.mark.l1_functional
def test_seal_from_package_inventory_keeps_only_hidden_object_originals(tmp_path):
    """оригиналы скрытого объекта лежат в общем пакете участника: --path-contains берёт в печать только их, ролью «вход»,
    без путей (T-137: размеченные копии TEST_HIDDEN и оригиналы из 01_ПАКЕТ имеют разные SHA-256)"""
    rows = [
        {"path": "PKG/01_ДОКУМЕНТАЦИЯ/Речников ул. 7-7/РД/КЖ.pdf", "sha256": H("1")},
        {"path": "PKG/01_ДОКУМЕНТАЦИЯ/Речников ул. 7-7/РД/ЭОМ.7z", "sha256": H("2")},
        {"path": "PKG/01_ДОКУМЕНТАЦИЯ/Полярная 16/ПД/АР.pdf", "sha256": H("3")},
    ]
    inv = write_inventory(tmp_path / "inv.jsonl", rows)
    out = tmp_path / "o.json"
    argv = ["seal", "--name", "o", "--inventory", str(inv), "--path-contains", "/Речников ул. 7-7/", "--out", str(out)]
    assert hs.main(argv) == 0
    data = json.loads(out.read_text(encoding="utf-8"))
    assert sorted(f["sha256"] for f in data["files"]) == [H("1"), H("2")]
    assert {f["role"] for f in data["files"]} == {"input"}
    assert "Речников" not in out.read_text(encoding="utf-8")


@pytest.mark.l3_boundary
def test_path_filter_matching_nothing_is_refused(tmp_path):
    """фильтр, под который не попал ни один файл, — отказ, а не пустая печать"""
    inv = write_inventory(tmp_path / "inv.jsonl", [{"path": "PKG/A/x.pdf", "sha256": H("1")}])
    argv = ["seal", "--name", "o", "--inventory", str(inv), "--path-contains", "/Нет такого/", "--out", str(tmp_path / "o.json")]
    assert hs.main(argv) != 0
    assert not (tmp_path / "o.json").exists()


@pytest.mark.l7_discipline
def test_every_committed_seal_is_valid_and_has_no_paths():
    """каждая печать в ml/eval/seals: отпечаток пересчитывается, путей и имён файлов нет; печать TEST_HIDDEN (копии
    с разметкой) и печать оригиналов Речникова из 01_ПАКЕТ не пересекаются по SHA-256 — нужны обе"""
    seals = sorted((Path(hs.__file__).parent / "seals").glob("*.json"))
    by_name = {}
    for p in seals:
        s = hs.load_seal(p)
        assert s["digest"] == hs.seal_digest(s["name"], s["files"]), p.name
        text = p.read_text(encoding="utf-8")
        assert "/" not in text.replace("hidden-seal/1", "") and ".pdf" not in text, p.name
        by_name[s["name"]] = {f["sha256"] for f in s["files"]}
    copies, originals = by_name["organizer-test-hidden-213"], by_name["organizer-rechnikov-originals-213"]
    assert len(originals) == 213 and not copies & originals
