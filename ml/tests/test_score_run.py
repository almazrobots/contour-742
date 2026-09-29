"""Прогон табло по объектам (OS-INSP-6.5.6, 6.5.7): таблица балла, потолок 59, пропущенные критические точки.

Эталон и ответы — синтетические, по форме `public_train_checks.jsonl` и `submission_schema.json`: реальные строки
организатора в репозиторий не попадают.
"""

from __future__ import annotations

import json

import pytest

from eval import score_run as sr


def g(obj, cid, code, loc, status="CRITICAL", label="VIOLATION_PRESENT", page=1):
    return {
        "check_id": cid,
        "object_id": obj,
        "parameter_code": code,
        "location": loc,
        "violation_label": label,
        "protocol_status": status,
        "score_eligible": True,
        "evidence": [{"stage": "RD", "file_id": f"{obj}-F1", "pdf_page_number": page}],
    }


def answer(obj, *checks):
    return {
        "object_id": obj,
        "checks": [
            {
                "parameter_code": c["parameter_code"],
                "location": c["location"],
                "violation_label": c["violation_label"],
                "protocol_status": c["protocol_status"],
                "evidence": c["evidence"],
            }
            for c in checks
        ],
    }


GOLD = [
    g("OBJ-A", "A-1", "P001", "140"),
    g("OBJ-A", "A-2", "P002", "141", status="WARNING"),
    g("OBJ-B", "B-1", "P001", "10"),
    g("OBJ-B", "B-2", "P003", "11"),  # критическая точка, которую ответ пропустит
    g("OBJ-B", "B-3", "P004", "12", status="WARNING"),
    g("OBJ-C", "C-1", "P005", "1"),
    g("OBJ-C", "C-2", "P006", "2"),
]


def rows():
    subs = {
        "OBJ-A": answer("OBJ-A", GOLD[0], GOLD[1]),
        "OBJ-B": answer("OBJ-B", GOLD[2], GOLD[4]),
    }
    return sr.build_rows(GOLD, subs, integrity={"OBJ-A": 1.0, "OBJ-B": 1.0})


@pytest.mark.l1_functional
def test_score_run_full_answer_scores_hundred():
    a = rows()[0]
    assert a["object_id"] == "OBJ-A" and a["total"] == pytest.approx(100.0)
    assert not a["capped"] and a["critical_missed"] == []


@pytest.mark.l1_functional
def test_score_run_missed_critical_point_caps_and_is_listed():
    b = rows()[1]
    assert b["uncapped"] > sr.CRITICAL_CAP and b["total"] == sr.CRITICAL_CAP
    assert b["capped"] and b["critical_missed"] == ["B-2"]


@pytest.mark.l1_functional
def test_score_run_object_without_answer_zero_and_all_critical_missed():
    c = rows()[2]
    assert c["object_id"] == "OBJ-C" and c["note"] == "ответа нет"
    assert c["total"] == 0 and c["uncapped"] == 0
    assert c["critical_missed"] == ["C-1", "C-2"]


@pytest.mark.l4_fault
def test_score_run_invalid_answer_scored_as_zero_with_reason():
    r = sr.build_rows(GOLD[:2], {"OBJ-A": {"object_id": "OBJ-A"}})
    assert r[0]["total"] == 0 and r[0]["note"].startswith("ответ не по схеме")
    assert r[0]["critical_missed"] == ["A-1"]


@pytest.mark.l1_functional
def test_score_run_markdown_table_mean_and_archive_disclaimer():
    md = sr.to_markdown(rows())
    assert "40 баллов экспертов" in md and "архивн" in md and "тай-брейк" in md
    assert "| OBJ-B |" in md and "B-2" in md and "| да |" in md
    assert "ответа нет" in md
    mean = (100.0 + sr.CRITICAL_CAP + 0) / 3
    assert f"{mean:.2f}".replace(".", ",") in md.split("| Среднее |")[1].splitlines()[0]


@pytest.mark.l1_functional
def test_score_run_cli_reads_gold_submissions_and_writes_md(tmp_path):
    gold = tmp_path / "gold.jsonl"
    gold.write_text(
        "\n".join(json.dumps(x, ensure_ascii=False) for x in GOLD) + "\n",
        encoding="utf-8",
    )
    subs = tmp_path / "subs"
    subs.mkdir()
    (subs / "OBJ-B.json").write_text(
        json.dumps(answer("OBJ-B", GOLD[2], GOLD[4])), encoding="utf-8"
    )
    integ = tmp_path / "integrity.json"
    integ.write_text(json.dumps({"OBJ-B": 0.5}), encoding="utf-8")
    out = tmp_path / "SCORE.md"
    sr.main(
        [
            "--gold",
            str(gold),
            "--submissions",
            str(subs),
            "--integrity",
            str(integ),
            "--md",
            str(out),
        ]
    )
    md = out.read_text("utf-8")
    assert md.count("ответа нет") == 2 and "B-2" in md and "0,500" in md


# ---- Таблица отчёта по ячейкам: убивают выживших mutmut в to_markdown/main/build_rows (T-136) ----

HEADS = [
    "Объект",
    "F1",
    "Локализация",
    "Значения/статусы",
    "Целостность",
    "Балл без потолка",
    "Балл",
    "Потолок 59",
    "Пропущенные критические точки",
]


def cells(line: str) -> list[str]:
    """Ячейки строки markdown-таблицы; строка обязана начинаться с «| » и кончаться « |»."""
    assert line.startswith("| ") and line.endswith(" |"), line
    return line[2:-2].split(" | ")


def table(md: str) -> list[list[str]]:
    """Строки таблицы после шапки и разделителя, ячейки каждой — списком."""
    lines = md.split("\n")
    i = lines.index("| " + " | ".join(HEADS) + " |")
    assert lines[i + 1] == "|---" * len(HEADS) + "|"
    out = []
    for ln in lines[i + 2 :]:
        if not ln.startswith("|"):
            break
        out.append(cells(ln))
    return out


FRONT = [
    "---",
    "id: QA-SCORE-ORGANIZER",
    'title: "Табло балла организатора по объектам"',
    "type: qa-report",
    "status: draft",
    'owner: "@almaz"',
    "created: 2026-09-27",
    "traces_to: [OS-INSP-6.5.6, OS-INSP-6.5.7, OS-INSP-6.5.12]",
    "tags: [qa, scoring, organizer]",
    "---",
]


@pytest.mark.l1_functional
def test_score_run_markdown_frontmatter_title_and_layout():
    lines = sr.to_markdown(rows(), "2026-09-27").split("\n")
    assert lines[:10] == FRONT
    # пустые строки разделяют блоки: без них таблица не отрисуется, а сноска прилипнет к таблице строкой
    assert lines[10] == "" and lines[11] == "# Табло балла организатора по объектам"
    assert lines[12] == "" and lines[13].startswith("> ") and lines[14] == ""
    assert [ln[:2] for ln in lines[15:18]] == ["- "] * 3 and lines[18] == ""
    assert cells(lines[19]) == HEADS
    assert lines[20] == "|---" * 9 + "|"
    assert [ln[:2] for ln in lines[21:25]] == ["| "] * 4
    assert lines[25] == "" and lines[26].startswith("Средние компонентов") and lines[27] == ""
    assert len(lines) == 28  # документ кончается переводом строки


@pytest.mark.l1_functional
def test_score_run_markdown_created_empty_by_default():
    assert "created: " in sr.to_markdown(rows()).split("\n")


@pytest.mark.l1_functional
def test_score_run_markdown_summary_counts():
    lines = sr.to_markdown(rows()).split("\n")
    assert lines[15] == "- Объектов: **3**, с ответом: 2; с потолком 59: 1."


@pytest.mark.l1_functional
def test_score_run_markdown_rows_cell_by_cell():
    t = table(sr.to_markdown(rows()))
    assert t == [
        ["OBJ-A", "1,000", "1,000", "1,000", "1,000", "100,00", "100,00", "нет", "—"],
        ["OBJ-B", "0,800", "0,667", "0,667", "1,000", "78,00", "59,00", "да", "B-2"],
        ["OBJ-C", "ответа нет", "—", "—", "—", "0,00", "0,00", "нет", "C-1, C-2"],
        ["Среднее", "0,900", "0,833", "0,833", "1,000", "59,33", "53,00", "1 из 3", "3"],
    ]


@pytest.mark.l3_boundary
def test_score_run_markdown_mean_without_any_answer_is_dash():
    t = table(sr.to_markdown(sr.build_rows(GOLD[5:], {})))
    assert t == [
        ["OBJ-C", "ответа нет", "—", "—", "—", "0,00", "0,00", "нет", "C-1, C-2"],
        ["Среднее", "—", "—", "—", "—", "0,00", "0,00", "0 из 1", "2"],
    ]


@pytest.mark.l3_boundary
def test_score_run_markdown_empty_rows_has_no_mean_row():
    assert table(sr.to_markdown([])) == []


@pytest.mark.l1_functional
def test_score_run_integrity_not_given_shown_as_dash():
    r = sr.build_rows(GOLD[:2], {"OBJ-A": answer("OBJ-A", GOLD[0], GOLD[1])})
    assert r[0]["components"]["document_integrity_and_split_handling"] is None
    assert table(sr.to_markdown(r))[0][4] == "—"


@pytest.mark.l1_functional
def test_score_run_rows_follow_gold_order_and_answered_note_empty():
    r = rows()
    assert [x["object_id"] for x in r] == ["OBJ-A", "OBJ-B", "OBJ-C"]
    assert r[0]["note"] == "" and r[1]["note"] == ""
    assert r[2]["capped"] is False  # нет ответа — балл 0, а не потолок


@pytest.mark.l4_fault
def test_score_run_invalid_answer_does_not_stop_other_objects():
    subs = {
        "OBJ-A": {"object_id": "OBJ-A"},
        "OBJ-B": answer("OBJ-B", GOLD[2], GOLD[4]),
    }
    r = sr.build_rows(GOLD[:5], subs)
    assert [x["object_id"] for x in r] == ["OBJ-A", "OBJ-B"]
    assert r[0]["capped"] is False and r[1]["capped"] is True


@pytest.mark.l3_boundary
def test_score_run_critical_point_without_check_id_marked_question():
    x = g("OBJ-X", "X-1", "P001", "1")
    del x["check_id"]
    assert sr.critical_points([x]) == ["?"]


def _cli_files(tmp_path, with_integrity=True):
    gold = tmp_path / "gold.jsonl"
    gold.write_text(
        "\n".join(json.dumps(x, ensure_ascii=False) for x in GOLD) + "\n\n",
        encoding="utf-8",
    )
    subs = tmp_path / "subs"
    subs.mkdir()
    (subs / "OBJ-A.json").write_text(
        json.dumps(answer("OBJ-A", GOLD[0], GOLD[1])), encoding="utf-8"
    )
    (subs / "OBJ-B.json").write_text(
        json.dumps(answer("OBJ-B", GOLD[2], GOLD[4])), encoding="utf-8"
    )
    args = ["--gold", str(gold), "--submissions", str(subs)]
    if with_integrity:
        integ = tmp_path / "integrity.json"
        integ.write_text(json.dumps({"OBJ-A": 1.0, "OBJ-B": 0.5}), encoding="utf-8")
        args += ["--integrity", str(integ)]
    return args


@pytest.mark.l1_functional
def test_score_run_cli_creates_nested_dir_dates_report_and_prints_total(
    tmp_path, capsys
):
    import datetime

    out = tmp_path / "a" / "b" / "SCORE.md"
    before = datetime.date.today().isoformat()
    res = sr.main(_cli_files(tmp_path) + ["--md", str(out)])
    after = datetime.date.today().isoformat()
    md = out.read_text("utf-8")
    lines = md.split("\n")
    assert lines[6] in (f"created: {before}", f"created: {after}")
    assert [r["object_id"] for r in res] == ["OBJ-A", "OBJ-B", "OBJ-C"]
    t = table(md)
    assert [row[0] for row in t] == ["OBJ-A", "OBJ-B", "OBJ-C", "Среднее"]
    assert t[1][4] == "0,500"
    assert capsys.readouterr().out == f"объектов 3; с потолком 1; → {out}\n"


@pytest.mark.l1_functional
def test_score_run_cli_without_integrity_leaves_component_unmeasured(tmp_path):
    out = tmp_path / "SCORE.md"
    sr.main(_cli_files(tmp_path, with_integrity=False) + ["--md", str(out)])
    t = table(out.read_text("utf-8"))
    assert [row[4] for row in t] == ["—", "—", "—", "—"]


@pytest.mark.l4_fault
@pytest.mark.parametrize("flag", ["--gold", "--submissions", "--md"])
def test_score_run_cli_required_flags(tmp_path, capsys, flag):
    args = _cli_files(tmp_path, with_integrity=False) + [
        "--md",
        str(tmp_path / "SCORE.md"),
    ]
    i = args.index(flag)
    del args[i : i + 2]
    with pytest.raises(SystemExit) as e:
        sr.main(args)
    assert e.value.code == 2
    assert flag in capsys.readouterr().err
    assert not (tmp_path / "SCORE.md").exists()
