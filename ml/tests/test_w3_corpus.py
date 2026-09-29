"""OS-INSP-6.5.70 (T-210): замер W3 на корпусе — только агрегаты наружу (docs/ops/REMOTE-RUNNER.md, ADR-0002).

Мини-«каталог» и мини-«кэш» r4 собираются в tmp из синтетических ParsedDoc; корпус тест не читает. Страж: ни одно слово
текста документов, ни имя папки объекта, ни имя файла не попадают в --out, --md и stdout; разбор — только в --detail-dir
(700/600); --limit-docs режет прочитанные документы.
"""

from __future__ import annotations

import json
import re
import stat

import pytest

from eval import w3_corpus
from eval.t173_eval import mk_doc
from eval.w3_eval import SKIPPED
from inspector_ml.docstore import parsed_key

OBJ = "Зюзякино_Квазимодо"
DOCS = {
    # sha: (путь в каталоге, строки документа); стадия — по папке, как у загрузчика пакета
    "a" * 64: (
        f"{OBJ}/01_Проектная документация/1. П-2099-01.001-ПЗУ.pdf",
        ["Таблица ТЭП Шмурдяковская", "Площадь застройки 3009,4 м2"],
    ),
    "b" * 64: (
        f"{OBJ}/02_Рабочая документация/РД-2099-01-001-ГП.pdf",
        ["Общие данные Гвоздецкий", "Площадь застройки 3120,0 м2"],
    ),
    "c" * 64: (
        f"{OBJ}/РД/РД-2099-01-001-АР1.pdf",
        ["Площадь застройки (до реконструкции) 1562,6 м2 Перепёлкин"],
    ),
    # стадии нет ни в папке, ни в имени — загрузчик ставит ПД по умолчанию; в кэше их нет
    "d" * 64: (f"{OBJ}/Прочее/Письмо Зубастикова.pdf", ["Площадь застройки 5000,0 м2"]),
    "e" * 64: (f"{OBJ}/Прочее/133-0000-ОК-1-ГП1.pdf", ["Площадь застройки 5100,0 м2"]),
    # служебный мусор архиватора — не документ
    "f" * 64: (f"{OBJ}/__MACOSX/._Кракозябров.pdf", ["Площадь застройки 5200,0 м2"]),
}
# архив эталонной разметки — вне пакетов объектов, исключается по полю archive (даже если документ есть в кэше)
REF = ("9" * 64, "Разметка/Эталонщикова.pdf", ["Площадь застройки 9999,9 м2 Эталонщикова"])
TEXT_WORDS = {
    w.lower()
    for path, lines in [*DOCS.values(), REF[1:]]
    for w in re.findall(
        r"[А-Яа-яЁёA-Za-z]{4,}|\d+[,.]\d+", " ".join(lines) + " " + path
    )
}


@pytest.fixture
def corpus(tmp_path):
    cat, cache = tmp_path / "catalog", tmp_path / "cache"
    cat.mkdir()
    cache.mkdir()
    rows = [
        {
            "archive": "99_Архив.tar",
            "path": p,
            "sha256": sha,
            "ext": ".pdf",
            "object": OBJ,
        }
        for sha, (p, _) in DOCS.items()
    ]
    rows.append({"mark": "взял"})
    rows.append(rows[0])  # дубль того же файла в объекте
    rows.append({"archive": "02_ЭТАЛОННАЯ_РАЗМЕТКА.tar", "path": REF[1], "sha256": REF[0], "ext": ".pdf", "object": "Разметка"})
    (cat / "99_Архив.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", "utf-8"
    )
    for sha, (_, lines) in [*list(DOCS.items())[:3], (REF[0], (None, REF[2]))]:
        doc = mk_doc(lines).model_copy(update={"sha256": sha})
        (cache / f"{parsed_key(sha)}.json").write_text(doc.model_dump_json(), "utf-8")
    return cat, cache


def run_cli(tmp_path, corpus, *extra):
    cat, cache = corpus
    out, md = tmp_path / "out/agg.json", tmp_path / "out/agg.md"
    w3_corpus.main(
        [
            "--catalog",
            str(cat),
            "--cache",
            str(cache),
            "--params",
            "M-001,M-023,M-999",
            "--out",
            str(out),
            "--md",
            str(md),
            *extra,
        ]
    )
    return json.loads(out.read_text("utf-8")), out.read_text("utf-8") + md.read_text(
        "utf-8"
    )


@pytest.mark.l1_functional
def test_real_pipeline_aggregates(tmp_path, corpus):
    agg, _ = run_cli(tmp_path, corpus, "--detail-dir", str(tmp_path / "detail"))
    run = agg["run"]
    assert (run["objects"], run["docs_read"], run["docs_PD"], run["docs_RD"]) == (
        1,
        3,
        1,
        2,
    )
    assert run["skipped"] == {"archive_excluded": 1, "junk": 1, "duplicate": 1}
    assert run["no_stage"] == 2
    assert run["no_stage_reason"] == {"no_cipher": 1, "cipher_without_stage": 1}
    assert run["stage_source"] == {"folder": 3, "default": 2}
    assert run["not_cached"] == 2 and run["not_cached_ext"] == {".pdf": 2}
    assert run["peak_rss"]["self_mb"] > 0 and run["seconds"] >= 0
    (code,) = {m["object"] for m in agg["by_param_object"].values()}
    assert re.fullmatch(r"OBJ-[0-9a-f]{8}", code)
    m = agg["by_param"]["M-001"]
    assert m["status"] == {"CANDIDATE": 1}
    assert m["docs_with_mentions"] == {"PD": 1, "RD": 2, "ID": 0}
    # значение «до реконструкции» — отсев EXISTING, доля от всех упоминаний параметра
    assert m["excluded"] == {"EXISTING": 1} and m["excluded_share"] == {
        "EXISTING": round(1 / m["mentions"], 3)
    }
    assert agg["by_param"]["M-023"]["status"] == {SKIPPED: 1}
    assert agg["by_param"]["M-999"]["status"] == {SKIPPED: 1}


@pytest.mark.l6_adversarial
def test_output_has_no_document_text_names_or_paths(tmp_path, corpus, capsys):
    _, text = run_cli(tmp_path, corpus, "--detail-dir", str(tmp_path / "detail"))
    text += capsys.readouterr().out
    low = text.lower()
    leaked = sorted(w for w in TEXT_WORDS if w in low)
    assert leaked == [], leaked
    # полей цитаты и страницы нет; расширение как счётчик (".pdf": 2) допустимо, имя файла — нет
    assert '"quote"' not in text and '"page"' not in text
    assert not re.search(r"\w\.pdf", text)  # слова путей и папок — в TEXT_WORDS


@pytest.mark.l6_adversarial
def test_detail_only_in_detail_dir_with_private_modes(tmp_path, corpus):
    d = tmp_path / "detail"
    run_cli(tmp_path, corpus, "--detail-dir", str(d))
    assert stat.S_IMODE(d.stat().st_mode) == 0o700
    files = [f for f in d.rglob("*") if f.is_file()]
    assert {f.name for f in files} == {"objects.json", "detail.jsonl"}
    assert all(stat.S_IMODE(f.stat().st_mode) == 0o600 for f in files)
    body = (d / "detail.jsonl").read_text("utf-8")
    assert (
        "Шмурдяковская" in body or "3009,4" in body
    )  # разбор с цитатами — только здесь
    assert OBJ in (d / "objects.json").read_text("utf-8")
    # без --detail-dir разбора нет нигде рядом с выходом
    other = tmp_path / "other"
    other.mkdir()
    cat, cache = corpus
    w3_corpus.main(
        [
            "--catalog",
            str(cat),
            "--cache",
            str(cache),
            "--params",
            "M-001",
            "--out",
            str(other / "a.json"),
        ]
    )
    assert [f.name for f in other.iterdir()] == ["a.json"]


@pytest.mark.l3_boundary
def test_limit_docs_cuts_reads(tmp_path, corpus):
    agg, _ = run_cli(tmp_path, corpus, "--limit-docs", "2")
    assert agg["run"]["docs_read"] == 2 and agg["run"]["limited"] == 3
    agg, _ = run_cli(tmp_path, corpus, "--limit-docs", "0")
    assert agg["run"]["docs_read"] == 0
    # документов нет — стадии не загружены: воздержание, а не нарушение
    assert "CANDIDATE" not in agg["by_param"]["M-001"]["status"]


@pytest.mark.l3_boundary
def test_objects_filter_and_object_map(tmp_path, corpus):
    mp = tmp_path / "map.json"
    mp.write_text(json.dumps({OBJ: "SYN-1"}, ensure_ascii=False), "utf-8")
    agg, _ = run_cli(tmp_path, corpus, "--object-map", str(mp), "--objects", "SYN-1")
    assert {m["object"] for m in agg["by_param_object"].values()} == {"SYN-1"}
    agg, _ = run_cli(tmp_path, corpus, "--object-map", str(mp), "--objects", "SYN-2")
    assert agg["run"]["objects"] == 0 and agg["by_param_object"] == {}


@pytest.mark.l1_functional
def test_object_code_resolution():
    assert (
        w3_corpus.object_code({"object_code": "POL-17", "object": "x"}, {}) == "POL-17"
    )
    assert w3_corpus.object_code({"object": "ALT-79B"}, {}) == "ALT-79B"
    assert (
        w3_corpus.object_code({"object": "x", "archive": "a.tar"}, {"a.tar": "LOS-3A"})
        == "LOS-3A"
    )
    alias = w3_corpus.object_code({"object": "Улица 5", "archive": "a.tar"}, {})
    assert alias.startswith("OBJ-") and "Улица" not in alias


@pytest.mark.l3_boundary
def test_default_stage_follows_loader_or_is_skipped(tmp_path, corpus):
    agg, _ = run_cli(tmp_path, corpus, "--skip-default-stage")
    run = agg["run"]
    # причина «без стадии» считается и при пропуске; прочитаны только документы со стадией из папки
    assert run["no_stage"] == 2 and run["skipped"]["default_stage"] == 2
    assert run["not_cached"] == 0 and run["docs_read"] == 3
    # исключение архивов отключено — эталонная разметка становится объектом
    agg, _ = run_cli(tmp_path, corpus, "--exclude-archive", "")
    assert agg["run"]["objects"] == 2 and "archive_excluded" not in agg["run"]["skipped"]
