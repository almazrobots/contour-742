"""Синтетика уровня помещения (T-123, карта сценариев T-103): тёплый пол в ПД → радиаторы в РД под облаком «Изм. №3»."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pypdfium2 as pdfium

from synth import rooms


def _text(p: Path) -> str:
    doc = pdfium.PdfDocument(str(p))
    try:
        return "\n".join(doc[i].get_textpage().get_text_range() for i in range(len(doc)))
    finally:
        doc.close()


def test_rooms_triple_shows_floor_heating_replaced_by_radiators(tmp_path: Path) -> None:
    m = rooms.build(tmp_path)
    by = {f["doc_stage"]: tmp_path / f["file_name"] for f in m["files"]}
    pd, rd, idd = _text(by["PD"]), _text(by["RD"]), _text(by["ID"])
    for t in (pd, rd, idd):
        assert "267" in t and "272" in t
    assert "Тёплый пол" in pd and "Изм. №3" not in pd
    assert "PRADO" in rd and "Тёплый пол" not in rd and "Изм. №3" in rd
    assert "факт 800 Вт" in idd


def test_rooms_manifest_hashes_and_key(tmp_path: Path) -> None:
    m = rooms.build(tmp_path)
    for f in m["files"]:
        assert hashlib.sha256((tmp_path / f["file_name"]).read_bytes()).hexdigest() == f["sha256"]
    key = json.loads((tmp_path / "rooms.json").read_text(encoding="utf-8"))
    changed = sorted(r["room"] for r in key["rooms"] if r["changed"])
    assert changed == ["267", "270", "271", "272"]
    assert key["expected_findings"][0]["kind"] == "ROOM_EQUIPMENT_CHANGED"


def test_rooms_deterministic(tmp_path: Path) -> None:
    a = rooms.build(tmp_path / "a")
    b = rooms.build(tmp_path / "b")
    assert [f["sha256"] for f in a["files"]] == [f["sha256"] for f in b["files"]]
