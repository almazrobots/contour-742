"""Компонент балла «целостность документов и обработка частей» (OS-INSP-6.5.12, T-120).

Манифест и отчёт — синтетические, по форме `document_manifest.jsonl` организатора: реальные строки в репозиторий
не попадают.
"""

from __future__ import annotations

import pytest

from eval import integrity as ig


def mf(fid, sha, pages=3, excl=None, group=None):
    return {
        "file_id": fid,
        "sha256": sha,
        "pdf_pages": pages,
        "exclusion_reason": excl,
        "duplicate_group": group,
        "distribution_status": "DISTRIBUTED",
    }


def rp(fid, status="ACCEPTED", sha=None, pages=3, **kw):
    return {
        "file_id": fid,
        "status": status,
        "sha256": sha,
        "pages": pages,
        "declared_pages": pages,
        "reason": kw.get("reason"),
        "duplicate_of": kw.get("duplicate_of"),
        "part_of": kw.get("part_of"),
    }


MANIFEST = [
    mf("F1", "a" * 64),
    mf("F2", "b" * 64, pages=10),
    mf("F3", "c" * 64, excl="черновик, вне комплекта"),
    mf("F4", "d" * 64, group="G1"),
    mf("F5", "e" * 64, group="G1"),
]


def good_report():
    return {
        "files": [
            rp("F1", sha="a" * 64),
            rp("F2", "PART", sha="b" * 64, pages=10, part_of="TOM-2"),
            rp("F3", "EXCLUDED", sha="c" * 64, reason="черновик, вне комплекта"),
            rp("F4", sha="d" * 64),
            rp("F5", "DUPLICATE", sha="e" * 64, duplicate_of="F4"),
        ],
        "share": 1.0,
    }


@pytest.mark.l1_functional
def test_integrity_all_files_accounted_share_one():
    r = ig.integrity_share(MANIFEST, good_report())
    assert r == {"share": 1.0, "n": 5, "wrong": []}


@pytest.mark.l1_functional
def test_integrity_excluded_file_must_be_excluded():
    rep = good_report()
    rep["files"][2] = rp(
        "F3", sha="c" * 64
    )  # принят в сверку, хотя реестр его исключил
    r = ig.integrity_share(MANIFEST, rep)
    assert r["share"] == pytest.approx(4 / 5)
    assert [w["file_id"] for w in r["wrong"]] == ["F3"] and "EXCLUDED" in r["wrong"][0][
        "why"
    ]


@pytest.mark.l1_functional
def test_integrity_split_policy_excluded_ids_count_as_excluded():
    rep = good_report()
    rep["files"][0] = rp("F1", "EXCLUDED", sha="a" * 64)
    assert ig.integrity_share(MANIFEST, rep)["wrong"][0]["file_id"] == "F1"
    assert ig.integrity_share(MANIFEST, rep, excluded_ids={"F1"})["share"] == 1.0


@pytest.mark.l1_functional
def test_integrity_second_file_of_duplicate_group_or_same_hash_is_duplicate():
    rep = good_report()
    rep["files"][4] = rp("F5", sha="e" * 64)  # второй файл группы G1 принят повторно
    r = ig.integrity_share(MANIFEST, rep)
    assert [w["file_id"] for w in r["wrong"]] == ["F5"] and "DUPLICATE" in r["wrong"][
        0
    ]["why"]
    # тот же SHA-256 под другим file_id — дубль и без duplicate_group
    man = [mf("X1", "f" * 64), mf("X2", "f" * 64)]
    ok = {
        "files": [
            rp("X1", sha="f" * 64),
            rp("X2", "DUPLICATE", sha="f" * 64, duplicate_of="X1"),
        ]
    }
    assert ig.integrity_share(man, ok)["share"] == 1.0


@pytest.mark.l1_functional
def test_integrity_hash_or_page_mismatch_is_wrong():
    rep = good_report()
    rep["files"][0] = rp("F1", sha="0" * 64)
    rep["files"][1] = rp(
        "F2", "PART", sha="b" * 64, pages=7, part_of="TOM-2"
    )  # неполный: 7 из 10 страниц
    r = ig.integrity_share(MANIFEST, rep)
    why = {w["file_id"]: w["why"] for w in r["wrong"]}
    assert (
        set(why) == {"F1", "F2"}
        and "SHA-256" in why["F1"]
        and "7" in why["F2"]
        and "10" in why["F2"]
    )
    assert r["share"] == pytest.approx(3 / 5)


@pytest.mark.l1_functional
def test_integrity_incomplete_and_rejected_accepted_file_is_wrong():
    rep = good_report()
    rep["files"][0] = rp("F1", "INCOMPLETE", sha="a" * 64)
    rep["files"][3] = rp("F4", "REJECTED", sha="d" * 64, reason="HASH_MISMATCH")
    r = ig.integrity_share(MANIFEST, rep)
    assert [w["file_id"] for w in r["wrong"]] == ["F1", "F4"]


@pytest.mark.l1_functional
def test_integrity_missing_in_report_is_wrong():
    rep = good_report()
    del rep["files"][0]
    r = ig.integrity_share(MANIFEST, rep)
    assert r["wrong"] == [{"file_id": "F1", "why": "нет в отчёте о целостности"}]


@pytest.mark.l1_functional
def test_integrity_pages_not_declared_in_manifest_not_checked():
    man = [mf("F1", "a" * 64, pages=None)]
    assert (
        ig.integrity_share(man, {"files": [rp("F1", sha="a" * 64, pages=42)]})["share"]
        == 1.0
    )


@pytest.mark.l1_functional
def test_integrity_empty_manifest_not_measured():
    assert ig.integrity_share([], {"files": []}) == {"share": None, "n": 0, "wrong": []}


@pytest.mark.l1_functional
def test_integrity_wrong_reasons_exact_text():
    rep = good_report()
    rep["files"][0] = rp("F1", sha="0" * 64)
    rep["files"][1] = rp("F2", "PART", sha="b" * 64, pages=7, part_of="TOM-2")
    why = {w["file_id"]: w["why"] for w in ig.integrity_share(MANIFEST, rep)["wrong"]}
    assert why == {
        "F1": "SHA-256 в отчёте не совпадает с реестром",
        "F2": "страниц 7, в реестре 10",
    }
