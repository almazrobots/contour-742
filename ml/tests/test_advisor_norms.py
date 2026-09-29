"""Тесты советника с проверкой ссылки (OS-INSP-3.2.4, 3.2.5) и поиска по нормативам (OS-INSP-3.2.6).

Чат-LLM в тестах не нужна: провайдер поддельный. Ollama не требуется: реранк проверяется на закрытом порту.
"""

from __future__ import annotations

import hashlib
import importlib
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from inspector_ml import advisor
from inspector_ml.advisor import (
    BAD_PAGE,
    BBOX_MISMATCH,
    NO_QUOTE,
    QUOTE_NOT_FOUND,
    UNKNOWN_FILE,
    AdvisorContext,
    parse_hypotheses,
    validate,
)
from inspector_ml.normsearch import (
    NormIndex,
    OllamaEmbedder,
    index_for,
    load_seed,
    tokens,
)
from inspector_ml.parse import parse_file

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/synth/OBJ-POL-115").exists()
)
POL = ROOT / "data/synth/OBJ-POL-115"


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


@pytest.fixture(scope="module")
def rd():
    p = POL / "POL-RD-AR-1.pdf"
    s = sha(p)
    return s, parse_file(p, s)


def line_box(doc, page: int, startswith: str):
    ln = next(
        ln
        for ln in next(p for p in doc.pages if p.page == page).lines
        if ln.text.startswith(startswith)
    )
    xs = [w.bbox for w in ln.words if w.bbox]
    return [
        min(b[0] for b in xs),
        min(b[1] for b in xs),
        max(b[2] for b in xs),
        max(b[3] for b in xs),
    ]


def good(s, doc) -> dict:
    return {
        "description": "Помещение 0.12 в РД названо «Склад ГСМ» — в ПД оно техническое",
        "sha256": s,
        "page": 2,
        "bbox": line_box(doc, 2, "Помещение 0.12"),
        "quote": "Помещение 0.12 Склад ГСМ",
    }


# ─────────────────────────────── валидатор (OS-INSP-3.2.4, 3.2.5)


@pytest.mark.l1_functional
def test_validator_accepts_hypothesis_with_verified_reference(rd):
    """OS-INSP-3.2.4: гипотеза со ссылкой файл+страница+bbox+дословная цитата принимается."""
    s, doc = rd
    ok, bad = validate(good(s, doc), {s: doc})
    assert bad is None and ok is not None
    assert ok["page"] == 2 and ok["match_score"] >= 95
    assert len(ok["evidence_bbox"]) == 4


@pytest.mark.l6_adversarial
def test_validator_rejects_quote_from_other_page(rd):
    """OS-INSP-3.2.5: цитата есть в файле, но не на указанной странице → QUOTE_NOT_FOUND."""
    s, doc = rd
    h = good(s, doc) | {"page": 3}
    ok, bad = validate(h, {s: doc})
    assert ok is None and bad["reason"] == QUOTE_NOT_FOUND


@pytest.mark.l6_adversarial
def test_validator_rejects_unknown_sha(rd):
    """OS-INSP-3.2.5: ссылка на файл не из пакета → UNKNOWN_FILE."""
    s, doc = rd
    ok, bad = validate(good(s, doc) | {"sha256": "0" * 64}, {s: doc})
    assert ok is None and bad["reason"] == UNKNOWN_FILE


@pytest.mark.l6_adversarial
def test_validator_rejects_bbox_off_quote(rd):
    """OS-INSP-3.2.5: bbox не пересекается со словами цитаты → BBOX_MISMATCH."""
    s, doc = rd
    h = good(s, doc) | {"bbox": [0.6, 0.6, 0.7, 0.7]}
    ok, bad = validate(h, {s: doc})
    assert ok is None and bad["reason"] == BBOX_MISMATCH


@pytest.mark.l3_boundary
def test_validator_rejects_missing_quote_and_bad_page(rd):
    """OS-INSP-3.2.4: без цитаты — NO_QUOTE; несуществующая страница — BAD_PAGE."""
    s, doc = rd
    assert validate(good(s, doc) | {"quote": ""}, {s: doc})[1]["reason"] == NO_QUOTE
    assert validate(good(s, doc) | {"quote": "ГСМ"}, {s: doc})[1]["reason"] == NO_QUOTE
    assert validate(good(s, doc) | {"page": 9}, {s: doc})[1]["reason"] == BAD_PAGE
    assert validate(good(s, doc) | {"page": "2"}, {s: doc})[1]["reason"] == BAD_PAGE


@pytest.mark.l3_boundary
def test_validator_tolerates_ocr_noise_but_not_invention(rd):
    """Нечёткость ≥ 95: одна опечатка в длинной цитате проходит, выдуманная фраза — нет."""
    s, doc = rd
    near = good(s, doc) | {"quote": "Помещение 0.12 Склад ГСМ."}  # пунктуация
    assert validate(near, {s: doc})[0] is not None
    made_up = good(s, doc) | {"quote": "Помещение 0.12 Склад взрывчатых веществ"}
    assert validate(made_up, {s: doc})[1]["reason"] == QUOTE_NOT_FOUND


@pytest.mark.l1_functional
def test_context_has_pages_and_line_bboxes(rd):
    """Контекст советника: файл по sha256, номера страниц, bbox строк — чтобы модель могла сослаться."""
    s, doc = rd
    t = AdvisorContext(
        docs={s: doc},
        extracted=[{"code": "M-041", "raw": "1,20", "sha256": s, "page": 2}],
    ).text()
    assert (
        f"sha256={s}" in t
        and "СТРАНИЦА 2" in t
        and "Склад ГСМ" in t
        and "bbox=[" in t
        and "M-041" in t
    )


@pytest.mark.l6_adversarial
def test_parse_hypotheses_ignores_garbage():
    assert parse_hypotheses('Вот ответ: {"hypotheses": [{"quote": "x"}, 5]} конец') == [
        {"quote": "x"}
    ]
    assert parse_hypotheses("не JSON") == []
    assert parse_hypotheses('[{"quote": "y"}]') == [{"quote": "y"}]


# ─────────────────────────────── /advise end-to-end на поддельном провайдере


class FakeProvider:
    name = "fake"

    def __init__(self, answers):
        self.answers = answers
        self.seen = None

    def available(self) -> bool:
        return True

    def propose(self, context):
        self.seen = context
        return self.answers(context)


def advise_client(tmp_path, monkeypatch):
    import inspector_ml.app as app_mod

    blobs = tmp_path / "blobs"
    blobs.mkdir()
    shas = []
    for name in ("POL-PD-PZ-1.pdf", "POL-RD-AR-1.pdf"):
        f = POL / name
        shutil.copy(f, blobs / sha(f))
        shas.append(sha(f))
    monkeypatch.setenv("INSPECTOR_ML_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("INSPECTOR_BLOB_DIR", str(blobs))
    importlib.reload(app_mod)
    return TestClient(app_mod.app), shas


@pytest.mark.l1_functional
def test_advise_endpoint_fake_provider_end_to_end(tmp_path, monkeypatch, rd):
    """OS-INSP-3.2.4/3.2.5 через HTTP: одна честная гипотеза принята, три выдуманные отклонены с причинами."""
    client, (pd_sha, rd_sha) = advise_client(tmp_path, monkeypatch)
    _, doc = rd

    def answers(ctx):
        assert set(ctx.docs) == {pd_sha, rd_sha}
        h = good(rd_sha, doc)
        return [
            h,
            h | {"page": 1},  # цитата не с той страницы
            h | {"sha256": "f" * 64},  # чужой файл
            h | {"bbox": [0.5, 0.5, 0.9, 0.9]},  # bbox мимо
        ]

    fake = FakeProvider(answers)
    advisor.set_provider(fake)
    try:
        r = client.post(
            "/advise",
            json={
                "sha256": [pd_sha, rd_sha],
                "params": [
                    {
                        "code": "M-041",
                        "anchors": ["Ширина эвакуационного выхода"],
                        "data_type": "number",
                    }
                ],
            },
        )
    finally:
        advisor.set_provider(None)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provider"] == "fake" and body["available"] is True
    assert len(body["accepted"]) == 1 and body["accepted"][0]["sha256"] == rd_sha
    assert sorted(x["reason"] for x in body["rejected"]) == sorted(
        [QUOTE_NOT_FOUND, UNKNOWN_FILE, BBOX_MISMATCH]
    )
    assert any(e["code"] == "M-041" for e in fake.seen.extracted)


@pytest.mark.l4_fault
def test_advise_unavailable_provider_returns_empty(tmp_path, monkeypatch):
    """Провайдер недоступен → пустой ответ, available=false, без ошибки и без разбора файлов."""
    client, shas = advise_client(tmp_path, monkeypatch)
    monkeypatch.setenv("INSPECTOR_LLM_PROVIDER", "ollama")
    monkeypatch.setenv("INSPECTOR_LLM_MODEL", "")
    advisor.set_provider(None)
    r = client.post("/advise", json={"sha256": ["0" * 64]})
    assert r.status_code == 200
    assert r.json() == {
        "provider": "ollama",
        "available": False,
        "accepted": [],
        "rejected": [],
    }


@pytest.mark.l6_adversarial
def test_advise_rejects_path_instead_of_sha(tmp_path, monkeypatch):
    """Защита: файл — только по sha256 из хранилища блобов, путь не принимается."""
    client, _ = advise_client(tmp_path, monkeypatch)
    advisor.set_provider(FakeProvider(lambda ctx: []))
    try:
        assert (
            client.post("/advise", json={"sha256": ["../../etc/passwd"]}).status_code
            == 422
        )
        assert client.post("/advise", json={"sha256": ["a" * 64]}).status_code == 404
    finally:
        advisor.set_provider(None)


# ─────────────────────────────── поиск по нормативам (OS-INSP-3.2.6)


@pytest.mark.l1_functional
def test_bm25_finds_sp1_for_evacuation_exit_width():
    """OS-INSP-3.2.6: «ширина эвакуационного выхода 0,85 м» → СП 1.13130.2020 первым."""
    idx = NormIndex(load_seed(), embedder=None)
    top = idx.search("ширина эвакуационного выхода 0,85 м", top_k=3)["results"]
    assert top[0]["document_number"] == "СП 1.13130.2020"
    assert top[0]["id"] == "SP1-EXIT-WIDTH"
    assert top[0]["summary_is_paraphrase"] is True


@pytest.mark.l4_fault
def test_rerank_without_ollama_falls_back_to_bm25():
    """Ollama не запущен (закрытый порт) → реранк молча выключен, результат BM25, без исключения."""
    idx = NormIndex(
        load_seed(),
        embedder=OllamaEmbedder(url="http://127.0.0.1:9", model="qwen3-embedding:0.6b"),
    )
    r = idx.search("ширина эвакуационного выхода 0,85 м", top_k=3)
    assert r["method"] == "bm25"
    assert r["results"][0]["document_number"] == "СП 1.13130.2020"


@pytest.mark.l1_functional
def test_norms_search_endpoint_merges_api_rows(tmp_path, monkeypatch):
    """/norms/search индексирует и сид, и записи normative_base из API; неактивные — нет."""
    monkeypatch.setenv("INSPECTOR_EMBED", "0")
    import inspector_ml.normsearch as ns

    monkeypatch.setattr(ns, "_EMBEDDER", None)
    client, _ = advise_client(tmp_path, monkeypatch)
    extra = [
        {
            "id": 7,
            "document_name": "Свод правил о кровлях",
            "document_number": "СП 17.13330",
            "section": "п. 1",
            "parameter_name": "Уклон кровли",
            "param_code": None,
            "is_active": 1,
        },
        {
            "id": 8,
            "document_name": "Отменённый",
            "document_number": "СП 0.0",
            "section": "",
            "parameter_name": "Уклон кровли старый",
            "param_code": None,
            "is_active": 0,
        },
    ]
    r = client.post(
        "/norms/search", json={"query": "уклон кровли", "top_k": 5, "extra": extra}
    ).json()
    ids = [x["id"] for x in r["results"]]
    assert ids[0] == "db:7" and "db:8" not in ids


@pytest.mark.l3_boundary
def test_tokens_normalize_russian_forms():
    assert tokens("Ширина эвакуационных выходов") == tokens(
        "ширина эвакуационного выхода"
    )
    assert "0.85" in tokens("0,85 м") and tokens("и в на") == []
    assert index_for().search("", 3)["results"] == []
