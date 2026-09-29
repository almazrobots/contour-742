"""OS-INSP-2.2.8: семантические якоря — дополняют лексику, не спорят с ней, неоднозначное не берут."""

from __future__ import annotations

import numpy as np
import pytest

from inspector_ml.extract import extract
from inspector_ml.model import Line, Page, ParamSpec, ParsedDoc, Word
from inspector_ml.semantic import get_embedder


@pytest.fixture(autouse=True)
def _cold_embedding_cache():
    # эмбеддер общий (lru_cache), и кэш векторов пережил бы тест — тогда кодирование не выполнялось бы вовсе
    # и ошибка в нём не была бы видна (mutmut: 59 выживших в _embed_batch при прогретом кэше)
    emb = get_embedder()
    if emb is not None:
        emb._cache.clear()
    yield


class Fake:
    """Детерминированный эмбеддер: фраза → заданный вектор; неизвестная — ортогональна всему."""

    def __init__(self, table: dict[str, list[float]]) -> None:
        self.t = {k: np.array(v, dtype=np.float32) / np.linalg.norm(v) for k, v in table.items()}

    def embed(self, texts):
        out = []
        for i, t in enumerate(texts):
            v = self.t.get(t)
            if v is None:
                v = np.zeros(8, dtype=np.float32)
                v[7] = 1.0
            out.append(v)
        return np.stack(out)


def doc(*texts: str) -> ParsedDoc:
    lines = []
    for i, t in enumerate(texts):
        ws, x = [], 0.05
        for tok in t.split():
            ws.append(Word(text=tok, bbox=(x, 0.1 + i * 0.03, x + 0.04, 0.115 + i * 0.03)))
            x += 0.05
        lines.append(Line(text=t, words=ws))
    return ParsedDoc(sha256="x", kind="pdf", engine="pdfium", pages=[Page(page=1, width=595, height=842, source="text", lines=lines)])


FLOORS = ParamSpec(code="M-007", anchors=["Надземная этажность здания"], data_type="number")
AREA = ParamSpec(code="M-001", anchors=["Площадь застройки"], data_type="number")
E = [1, 0, 0, 0, 0, 0, 0, 0]
E2 = [0.92, 0.39, 0, 0, 0, 0, 0, 0]  # cos(E, E2) ≈ 0,92


@pytest.mark.l1_functional
def test_paraphrased_label_found_by_meaning_with_similarity():
    f = Fake({"Надземная этажность здания": E, "Количество этажей": E2})
    (e,) = extract(doc("Количество этажей эт. 12"), [FLOORS], f)
    assert (e.code, e.value_num, e.match) == ("M-007", 12.0, "semantic")
    assert 0.9 < e.similarity < 0.93 and e.confidence < e.similarity  # семантика уверена меньше лексики


@pytest.mark.l3_boundary
def test_weak_similarity_not_taken_and_no_embedder_stays_lexical():
    f = Fake({"Надземная этажность здания": E, "Количество этажей": [0.7, 0.71, 0, 0, 0, 0, 0, 0]})  # cos ≈ 0,70 < 0,80
    assert extract(doc("Количество этажей эт. 12"), [FLOORS], f) == []
    assert extract(doc("Количество этажей эт. 12"), [FLOORS]) == []


@pytest.mark.l6_adversarial
def test_ambiguous_two_lines_equally_close_not_taken():
    f = Fake({"Надземная этажность здания": E, "Количество этажей": E2, "Число этажей": E2})
    assert extract(doc("Количество этажей эт. 12", "Число этажей эт. 9"), [FLOORS], f) == []


@pytest.mark.l6_adversarial
def test_line_taken_lexically_is_not_reused_and_found_param_not_revised():
    # «Площадь застройки» найдена лексически; её строку семантика не может отдать другому параметру
    f = Fake({"Надземная этажность здания": E, "Площадь застройки": E2})
    got = {e.code: e.match for e in extract(doc("Площадь застройки м² 2 792,0"), [FLOORS, AREA], f)}
    assert got == {"M-001": "lexical"}


@pytest.mark.l6_adversarial
def test_line_goes_to_the_closest_param_only():
    # «Высота здания» тоже выше порога (cos ≈ 0,86), но «Надземная этажность здания» ближе (≈ 0,92) — строка достаётся ей
    third = ParamSpec(code="M-008", anchors=["Высота здания"], data_type="number")
    f = Fake({"Надземная этажность здания": E, "Высота здания": [0.6, 0.8, 0, 0, 0, 0, 0, 0], "Количество этажей": E2})
    got = [(e.code, e.value_num) for e in extract(doc("Количество этажей эт. 12"), [FLOORS, third], f)]
    assert got == [("M-007", 12.0)]


@pytest.mark.l2_differential
@pytest.mark.skipif(get_embedder() is None, reason="модель paraphrase-multilingual-MiniLM-L12-v2 не скачана")
def test_real_model_paraphrases_above_threshold_unrelated_below():
    # замер на реальной модели (qint8 arm64): эти перефразы 0,89–0,93, несвязанные 0,34–0,50 — порог 0,84 между ними.
    # Однословные тексты модель различает плохо («Этажность» ↔ «Отметка» 0,90) — поэтому они в семантику не допускаются.
    from inspector_ml.semantic import SEM_MIN

    emb = get_embedder()
    para = [("Общая площадь здания", "Суммарная площадь здания"), ("Класс бетона", "Класс прочности бетона"), ("Ширина эвакуационного выхода", "Ширина дверей эвакуационных выходов")]
    unrel = [("Общая площадь здания", "Класс бетона"), ("Ширина эвакуационного выхода", "Толщина плиты перекрытия")]
    v = emb.embed([x for p in para + unrel for x in p])
    sims = [float(v[2 * i] @ v[2 * i + 1]) for i in range(len(para + unrel))]
    assert all(s >= SEM_MIN for s in sims[: len(para)]), sims
    assert all(s < SEM_MIN - 0.1 for s in sims[len(para):]), sims
    assert abs(float(np.linalg.norm(v[0])) - 1.0) < 1e-4


@pytest.mark.l6_adversarial
def test_line_equally_close_to_two_params_not_taken():
    # «парковочные места в автостоянке» почти одинаково близки к машино-местам и местам МГН — не берём
    a = ParamSpec(code="M-012", anchors=["Количество машино-мест"], data_type="number")
    b = ParamSpec(code="M-038", anchors=["Количество парковочных мест для МГН"], data_type="number")
    f = Fake({"Количество машино-мест": E, "Количество парковочных мест для МГН": [0.9, 0.436, 0, 0, 0, 0, 0, 0]})
    mid = f.t["Количество машино-мест"] + f.t["Количество парковочных мест для МГН"]
    f.t["Парковочные места"] = mid / np.linalg.norm(mid)  # равноудалена от обоих якорей, косинус ≈ 0,97
    assert extract(doc("Парковочные места шт. 120"), [a, b], f) == []


@pytest.mark.l2_differential
@pytest.mark.skipif(get_embedder() is None, reason="модель paraphrase-multilingual-MiniLM-L12-v2 не скачана")
def test_semantic_bench_recall_up_and_no_false_bindings():
    from eval.semantic_bench import run

    r = run()
    assert r["лексика"]["найдено_верно"] <= 4
    assert r["лексика + семантика"]["найдено_верно"] >= 10 and r["лексика + семантика"]["ложных"] == 0


@pytest.mark.l3_boundary
def test_single_word_label_or_anchor_not_used_by_semantics():
    # «Отметка 0.000 …» → «Этажность»: на реальной модели 0,90 — ложная находка (синтетика e2e, OBJ-POL-115)
    f = Fake({"Этажность": E, "Отметка": E2, "Количество надземных этажей": E, "Число этажей над землёй": E2})
    one_word_anchor = ParamSpec(code="M-007", anchors=["Этажность"], data_type="number")
    assert extract(doc("Число этажей над землёй 12"), [one_word_anchor], f) == []
    two_words = ParamSpec(code="M-007", anchors=["Этажность", "Количество надземных этажей"], data_type="number")
    assert extract(doc("Отметка 0.000 соответствует уровню пола"), [two_words], f) == []
    (e,) = extract(doc("Число этажей над землёй 12"), [two_words], f)
    assert (e.code, e.value_num, e.match) == ("M-007", 12.0, "semantic")


@pytest.mark.l6_adversarial
@pytest.mark.skipif(get_embedder() is None, reason="модель paraphrase-multilingual-MiniLM-L12-v2 не скачана")
def test_real_model_lift_count_not_bound_to_lift_shaft_dimensions():
    # «Количество лифтов» ↔ «Привязки и габариты лифтовых шахт» на модели 0,796: при пороге 0,80 — ложная находка
    shaft = ParamSpec(code="M-064", anchors=["Привязки и габариты лифтовых шахт"], data_type="number")
    assert extract(doc("Количество лифтов шт. 0"), [shaft], get_embedder()) == []


@pytest.mark.l6_adversarial
@pytest.mark.skipif(get_embedder() is None, reason="модель paraphrase-multilingual-MiniLM-L12-v2 не скачана")
def test_real_model_embedding_does_not_depend_on_batch_neighbours():
    # в пакете с паддингом квантованная модель давала 0,798 / 0,795 / 0,793 для одной пары — находка зависела от соседей
    emb = get_embedder()
    a, b = "Привязки и габариты лифтовых шахт", "Количество лифтов"
    long = "Отметка 0.000 соответствует уровню чистого пола первого этажа по генеральному плану участка"
    alone = float(emb.embed([a])[0] @ emb.embed([b])[0])
    v = emb.embed([a, b, long])
    assert float(v[0] @ v[1]) == pytest.approx(alone, abs=1e-6)


@pytest.mark.l1_functional
@pytest.mark.skipif(get_embedder() is None, reason="модель paraphrase-multilingual-MiniLM-L12-v2 не скачана")
def test_fresh_embedder_equals_shared_and_cache_is_capped(monkeypatch):
    import os
    from pathlib import Path
    import inspector_ml.semantic as sem
    from inspector_ml.paths import repo_root

    fresh = sem.OnnxEmbedder(Path(os.environ.get("INSPECTOR_EMBED_MODEL", repo_root() / sem.MODEL_DIR)))
    texts = ["Общая площадь здания", "Класс прочности бетона", "Общая площадь здания"]
    v = fresh.embed(texts)
    assert v.shape == (3, 384) and v.dtype == np.float32
    assert np.allclose(np.linalg.norm(v, axis=1), 1.0, atol=1e-5)
    assert np.array_equal(v[0], v[2]) and not np.allclose(v[0], v[1])
    assert np.allclose(v, get_embedder().embed(texts), atol=1e-6)  # свежий экземпляр кодирует так же, как общий
    assert len(fresh._cache) == 2  # повтор взят из кэша
    monkeypatch.setattr(sem, "EMBED_CACHE_MAX", 2)
    w = fresh.embed(["Ширина проездов внутри участка"])
    assert len(fresh._cache) == 1 and np.allclose(np.linalg.norm(w), 1.0, atol=1e-5)  # потолок: кэш сброшен


@pytest.mark.l1_functional
def test_semantic_finding_has_value_and_label_boxes_and_one_reject_does_not_stop_others():
    # находка без рамок не проверяется инспектором (карточка доказательства); отказ по одному параметру
    # не обрывает поиск по остальным
    far = ParamSpec(code="M-008", anchors=["Высота здания от земли"], data_type="number")
    f = Fake({"Высота здания от земли": [0, 0, 1, 0, 0, 0, 0, 0], "Надземная этажность здания": E, "Количество этажей": E2})
    (e,) = extract(doc("Количество этажей эт. 12"), [far, FLOORS], f)
    assert e.code == "M-007"
    x0, y0, x1, y1 = e.bbox
    ax0, _, ax1, _ = e.anchor_bbox
    assert 0 <= ax0 < ax1 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1  # подпись левее значения, обе на листе


@pytest.mark.l3_boundary
def test_string_parameter_is_not_matched_by_meaning():
    # семантика — только для чисел без шаблона: у строки/перечисления нет «значения после подписи»
    text = ParamSpec(code="M-072", anchors=["Материал напорных труб"], data_type="string")
    f = Fake({"Материал напорных труб": E, "Трубы напорные материал ПЭ": E2})  # подпись — текст до первого числа
    assert extract(doc("Трубы напорные материал ПЭ 100"), [text], f) == []


@pytest.mark.l3_boundary
def test_model_file_matches_cpu_architecture():
    # на x86-сервере файла arm64 нет: семантика молча выключилась бы, и извлечение осталось бы лексическим
    from inspector_ml.semantic import model_file

    assert model_file("arm64") == model_file("aarch64") == "onnx/model_qint8_arm64.onnx"
    assert model_file("x86_64") == model_file("AMD64") == "onnx/model_quint8_avx2.onnx"
