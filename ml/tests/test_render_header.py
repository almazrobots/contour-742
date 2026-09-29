"""Шапка протокола PDF/DOCX (render._header), T-129."""

import pytest



@pytest.mark.l3_boundary
def test_protocol_header_object_without_address_has_no_dangling_comma():
    """Шапка протокола (PDF/DOCX): без адреса — «Объект» без висячей запятой; с адресом — через запятую (T-129)."""
    from inspector_ml import render

    base = {
        "versions": {"matrix_version": "1", "model_version": "m", "dataset_version": "d", "input_manifest_hash": "h"},
        "process_id": "P-1", "protocol_version": 1, "status": "READY", "check_type": {"scenario": "S", "title": "T"},
        "upload_status": {"pd": "PD_UPLOADED", "rd": "RD_UPLOADED", "id": "ID_MISSING"},
    }
    row = lambda obj: dict(render._header({**base, "object": obj}))["Объект"]  # noqa: E731
    assert row({"name": "Дом"}) == "Дом"
    assert row({"name": "Дом", "address": ""}) == "Дом"
    assert row({"name": "Дом", "address": "ул. Лесная, 1"}) == "Дом, ул. Лесная, 1"
