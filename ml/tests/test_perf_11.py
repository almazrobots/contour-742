"""Предел §11 ТЗ для протокола PDF и DOCX (OS-INSP-6.5.11, TZA-11-05, T-135): протокол со всеми 132 параметрами Матрицы
рендерится не дольше 30 с. Протокол — синтетический (ADR-0002), структура — как у API (domain/protocol.ts).
Эшелоны: L7 (предел ТЗ роняет гейт), L3 (граница — худший случай: все параметры в каждом разделе, длинные тексты)."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.performance

from inspector_ml.render import render_docx, render_pdf

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
MATRIX = json.loads((ROOT / "data/seed/matrix.json").read_text("utf-8"))
LIMIT_S = 30.0  # §11 ТЗ: генерация протокола JSON/PDF ≤ 30 с


def protocol() -> dict:
    src = [
        {
            "stage": st,
            "document_code": f"П-2099-01-001-{st}",
            "revision": "1",
            "page": 7,
            "bbox": [0.1, 0.2, 0.3, 0.25],
        }
        for st in ("PD", "RD", "ID")
    ]
    card = lambda p, i: {  # noqa: E731
        "finding_id": f"F-SYN-{p['code']}-{i}",
        "param_code": p["code"],
        "parameter_name": p["parameter_name"],
        "expected": "100 м²",
        "actual": "97 м²",
        "delta": "-3,00 %",
        "sources": src,
        "reason": "Уменьшение значения " * 8,
        "decision": {"user_name": "Инспектор", "comment": "Проверено по листу " * 5},
    }
    sections = {
        "completeness": [
            {
                "param_code": p["code"],
                "parameter_name": p["parameter_name"],
                "status": "NEGATIVE_VERIFIED",
                "reason": "Значения совпадают " * 6,
            }
            for p in MATRIX
        ],
        "candidates": [card(p, 1) for p in MATRIX],
        "confirmed_violations": [card(p, 2) for p in MATRIX],
        "negative_verified": [
            {
                "param_code": p["code"],
                "parameter_name": p["parameter_name"],
                "expected": "B25",
                "actual": "B25",
                "by": "system",
                "reason": "совпадает",
            }
            for p in MATRIX
        ],
        "suspicions": [
            {
                "discovery_method": "INTERNAL_CONSISTENCY",
                "description": "Гипотеза о противоречии " * 10,
                "normative_base": "СП 2.13130.2020, п. 5",
                "review_priority": "HIGH",
            }
            for _ in range(20)
        ],
        "missing_evidence": [],
    }
    return {
        "process_id": "P-SYN-PERF",
        "protocol_version": 3,
        "status": "VERIFYING",
        "object": {
            "name": "Синтетический объект §11",
            "address": "г. Москва, условный адрес",
            "permit_number": "RU-00-000-0000",
        },
        "check_type": {"scenario": "FULL", "title": "Полная проверка ПД, РД, ИД"},
        "upload_status": ["PD_UPLOADED", "RD_UPLOADED", "ID_UPLOADED"],
        "versions": {
            "matrix_version": "1.1.2",
            "model_version": "dev",
            "dataset_version": "none",
            "input_manifest_hash": "0" * 64,
        },
        "summary": {},
        "sections": sections,
        "input_files": [],
    }


@pytest.mark.l7_discipline
@pytest.mark.parametrize("fmt,render", [("pdf", render_pdf), ("docx", render_docx)])
def test_protocol_with_all_132_params_renders_within_tz_limit(fmt, render):
    p = protocol()
    assert len(MATRIX) >= 132
    t0 = time.perf_counter()
    out = render(p)
    sec = time.perf_counter() - t0
    assert len(out) > 10_000, "протокол не пустой"
    print(f"§11 протокол {fmt}: {sec:.2f} с, {len(out)} байт")
    assert sec < LIMIT_S, (
        f"протокол {fmt} {sec:.1f} с — больше предела §11 ({LIMIT_S} с)"
    )


@pytest.mark.l7_discipline
@pytest.mark.parametrize("fmt", ["pdf", "docx"])
def test_appendix2_protocol_with_all_132_params_within_tz_limit(fmt):
    """Протокол по форме Приложения 2 (T-134) — тот же предел §11 на худшем случае: все 132 параметра в каждом разделе."""
    from copy import deepcopy

    from inspector_ml import render_appendix2 as A2
    from tests.test_render_appendix2 import sample

    p = deepcopy(sample())
    for s in p["appendix2"]["sections"]:
        if s["rows"]:
            s["rows"] = [[str(i + 1), *s["rows"][0][1:]] for i in range(len(MATRIX))]
    t0 = time.perf_counter()
    out = (A2.render_pdf if fmt == "pdf" else A2.render_docx)(p)
    sec = time.perf_counter() - t0
    print(f"§11 Приложение 2 {fmt}: {sec:.2f} с, {len(out)} байт")
    assert len(out) > 10_000
    assert sec < LIMIT_S, f"Приложение 2 {fmt} {sec:.1f} с — больше предела §11 ({LIMIT_S} с)"
