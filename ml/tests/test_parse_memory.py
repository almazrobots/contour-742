"""Память этапа parse не растёт от файла к файлу (T-230).

Замер 28.09 на сервере (9 томов, PP-OCR на CUDA + VL): после разбора файла освобождённая память оставалась в куче
процесса — malloc_trim(0) возвращал 0,8–2,8 ГБ за файл, а RSS процесса пачки дорастал до 18–24 ГБ (OOM дважды).
Причины: сотня потоков ONNX Runtime (intra_op по числу ядер на каждую из трёх сессий PP-OCR, с чужими ядрами
в маске) и пул страниц — каждый поток со своей ареной glibc, освобождённые растры в арене остаются за процессом.
Синтетика (ADR-0002): тот же PDF-скан разбирается N раз поддельным движком, который, как настоящий, держит растр
страницы в своих потоках."""

from __future__ import annotations

import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pytest

from inspector_ml import memory
from inspector_ml import ocr_ensemble as oe
from inspector_ml import ocr_gpu as og
from inspector_ml import parse

ROOT = next(
    p
    for p in Path(__file__).resolve().parents
    if (p / "data/seed/matrix.json").exists()
)
DOOR = ROOT / "data/synth/OBJ-SEV-2/SEV-ID-DOOR-1.pdf"


class Churn:
    """Подделка PP-OCR: на странице — растры и тысячи мелких буферов в своих потоках (как ORT и RapidOCR)."""

    name = "ppocr-v5"
    reason = ""

    def __init__(self):
        self.pool = ThreadPoolExecutor(max_workers=8)

    def available(self) -> bool:
        return True

    def _work(self, k: int) -> int:
        big = [np.full((1200, 1700, 3), k % 251, np.uint8) for _ in range(3)]
        small = [bytes(1024 + (i * 37 % 60000)) for i in range(1500)]
        keep = small[::50]  # часть мелких живёт дольше растра — дырявит арену
        del big, small
        return len(keep)

    def read_page(self, image):
        sum(self.pool.map(self._work, range(8)))
        return og.EngineReading([], 0)

    def read(self, image):
        return []


def _rss_mb() -> float:
    for ln in open("/proc/self/status"):
        if ln.startswith("VmRSS:"):
            return int(ln.split()[1]) / 1024
    raise RuntimeError("нет VmRSS")


@pytest.mark.l1_functional
def test_parse_pdf_releases_memory_after_each_document(monkeypatch):
    calls = []
    monkeypatch.setattr(memory, "release", lambda: calls.append(1))
    monkeypatch.setattr(oe, "default_engines", lambda: [Churn()])
    parse.parse_file(DOOR, "0" * 64)
    parse.parse_file(DOOR, "1" * 64)
    assert len(calls) == 2


@pytest.mark.l4_fault
@pytest.mark.skipif(
    not sys.platform.startswith("linux"),
    reason="куча glibc и /proc — Linux (раннер, прод)",
)
def test_rss_does_not_grow_over_n_scan_documents():
    """Замер — в отдельном процессе: куча процесса pytest после сотен тестов шумит сильнее, чем сам рост."""
    import json
    import os
    import subprocess

    ml = Path(__file__).resolve().parents[1]
    out = subprocess.run(
        [sys.executable, __file__, "8"],
        env={**os.environ, "PYTHONPATH": str(ml)},
        cwd=ml,
        capture_output=True,
        text=True,
        timeout=300,
        check=True,
    )
    rss = json.loads(out.stdout.strip().splitlines()[-1])
    # без фикса (замер 28.09): 426, 485, 542, 601, 661… МБ — +59 МБ за файл, пока не заполнятся арены потоков
    grow = max(rss[2:]) - rss[1]
    assert grow < 64, f"RSS растёт от файла к файлу: {[round(x) for x in rss]} МБ"


def _measure(n: int) -> list[float]:
    eng = Churn()
    oe.default_engines = lambda: [eng]
    rss = []
    for i in range(n):
        parse.parse_file(DOOR, f"{i:064d}")
        rss.append(_rss_mb())
    return rss


if (
    __name__ == "__main__"
):  # процесс замера test_rss_does_not_grow_over_n_scan_documents
    import json

    print(json.dumps(_measure(int(sys.argv[1]))))


@pytest.mark.l1_functional
def test_ppocr_threads_bounded():
    """ONNX Runtime PP-OCR не заводит поток на каждое ядро машины: intra_op — из INSPECTOR_PPOCR_THREADS (2)."""
    e = og._ppocr("ppocr-v5", og.PPOCR_DET, "dev", {})
    assert e.threads == 2
    assert (
        og._ppocr(
            "ppocr-v5", og.PPOCR_DET, "dev", {"INSPECTOR_PPOCR_THREADS": "99"}
        ).threads
        == 16
    )
    p = e._ort_threads()
    assert p == {
        "EngineConfig.onnxruntime.intra_op_num_threads": 2,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
    }
