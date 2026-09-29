"""T-086: провайдер LLM в профиле gpu задаётся явно и проверяется при старте (ADR-0001: профиль «громко при старте»).

Раньше по умолчанию был ollama на 127.0.0.1:11434; на стенде Ollama нет — советник и эмбеддинги поиска по нормативам
отключались без единой ошибки.
"""

import pytest
from fastapi.testclient import TestClient

from inspector_ml import advisor, normsearch


@pytest.fixture
def env(monkeypatch):
    monkeypatch.delenv("INSPECTOR_LLM_PROVIDER", raising=False)
    return monkeypatch


@pytest.mark.l4_fault
def test_gpu_without_provider_fails_at_start(env):
    with pytest.raises(SystemExit, match="INSPECTOR_LLM_PROVIDER"):
        advisor.llm_mode("gpu")


@pytest.mark.l4_fault
@pytest.mark.parametrize("profile", ["dev", "gpu"])
def test_unknown_provider_fails_at_start(env, profile):
    env.setenv("INSPECTOR_LLM_PROVIDER", "vllm-typo")
    with pytest.raises(SystemExit, match="ollama, mlx или none"):
        advisor.llm_mode(profile)


@pytest.mark.l1_functional
@pytest.mark.parametrize("value", ["ollama", "mlx", "none"])
def test_gpu_accepts_explicit_provider(env, value):
    env.setenv("INSPECTOR_LLM_PROVIDER", value)
    assert advisor.llm_mode("gpu") == value


@pytest.mark.l1_functional
def test_dev_keeps_ollama_by_default(env):
    assert advisor.llm_mode("dev") == "ollama"


@pytest.mark.l1_functional
def test_none_gives_no_provider_and_no_embedder(env):
    env.setenv("INSPECTOR_LLM_PROVIDER", "none")
    env.setenv("INSPECTOR_PROFILE", "gpu")
    assert isinstance(advisor.get_provider(), advisor.NoProvider)
    env.setattr(normsearch, "_EMBEDDER", None)
    assert normsearch.embedder() is None, (
        "при none поиск по нормативам не стучится в Ollama — сразу BM25"
    )


@pytest.mark.l1_functional
def test_ollama_keeps_embedder(env):
    env.setenv("INSPECTOR_LLM_PROVIDER", "ollama")
    env.setattr(normsearch, "_EMBEDDER", None)
    assert isinstance(normsearch.embedder(), normsearch.OllamaEmbedder)


@pytest.mark.l1_functional
def test_health_shows_provider(monkeypatch):
    from inspector_ml import app as app_mod

    for mode in ("none", "mlx"):
        monkeypatch.setattr(app_mod, "LLM", mode)
        assert TestClient(app_mod.app).get("/health").json()["llm"] == mode
