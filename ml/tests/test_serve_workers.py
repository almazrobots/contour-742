"""T-233: число процессов ML-сервера (INSPECTOR_ML_WORKERS) и TLS 1.3 в каждом процессе."""
import importlib.util
import ssl
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("serve", Path(__file__).resolve().parents[1] / "serve.py")
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


@pytest.mark.l1_functional
@pytest.mark.parametrize("raw,n", [(None, 1), ("3", 3), ("0", 1), ("-2", 1), ("12", 8)])
def test_workers_bounds(raw, n):
    assert serve.workers({} if raw is None else {"INSPECTOR_ML_WORKERS": raw}) == n


@pytest.mark.l4_fault
def test_workers_not_a_number_fails_loudly():
    with pytest.raises(SystemExit):
        serve.workers({"INSPECTOR_ML_WORKERS": "три"})


@pytest.mark.l1_functional
def test_tls13_set_on_load(monkeypatch):
    """Контекст SSL собирается в load() каждого процесса — минимальная версия там же, а не только в родителе."""
    c = serve.Tls13Config("inspector_ml.app:app")
    c.ssl = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    monkeypatch.setattr(serve.uvicorn.Config, "load", lambda self: None)  # сборка приложения не нужна для проверки
    c.load()
    assert c.ssl.minimum_version == ssl.TLSVersion.TLSv1_3


# ─────────────────────────────── T-233: фаза судьи

from inspector_ml import vlm  # noqa: E402


@pytest.mark.l1_functional
def test_judge_phase_off_keeps_reader(monkeypatch):
    """Фаза разбора: судья выключен, VL-читатель (backend) — нет; неверное значение — громкий отказ."""
    monkeypatch.setattr(vlm, "backend", lambda: "openai")
    assert vlm.judge_enabled({"INSPECTOR_JUDGE_PHASE": "off"}) is False
    assert vlm.enabled() is True
    assert vlm.judge_enabled({}) is True and vlm.judge_enabled({"INSPECTOR_JUDGE_PHASE": "ON"}) is True
    monkeypatch.setattr(vlm, "backend", lambda: "none")
    assert vlm.judge_enabled({"INSPECTOR_JUDGE_PHASE": "on"}) is False
    with pytest.raises(ValueError):
        vlm.judge_enabled({"INSPECTOR_JUDGE_PHASE": "maybe"})
