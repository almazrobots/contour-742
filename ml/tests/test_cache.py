"""Кэш разбора (OS-INSP-2.1.3, ТЗ 9.1.5): один контракт у файлового (dev) и Redis (gpu) кэша."""

from __future__ import annotations

import pytest

from inspector_ml.cache import FileCache, RedisCache, make_cache


class FakeRedis:
    def __init__(self) -> None:
        self.data: dict[str, bytes] = {}
        self.ttl: dict[str, int] = {}

    def get(self, k):
        return self.data.get(k)

    def set(self, k, v, ex=None):
        self.data[k] = v
        self.ttl[k] = ex


@pytest.fixture(params=["file", "redis"])
def cache(request, tmp_path):
    return FileCache(tmp_path / "c") if request.param == "file" else RedisCache(FakeRedis())


@pytest.mark.l1_functional
def test_roundtrip_miss_and_overwrite(cache):
    assert cache.get("parsed-abc") is None
    cache.set("parsed-abc", '{"x": "значение"}')
    assert cache.get("parsed-abc") == '{"x": "значение"}'
    cache.set("parsed-abc", "{}")
    assert cache.get("parsed-abc") == "{}"


@pytest.mark.l6_adversarial
def test_file_cache_rejects_path_keys_and_leaves_no_tmp(tmp_path):
    c = FileCache(tmp_path / "c")
    for bad in ("../etc", "a/b", ".hidden", ""):
        with pytest.raises(ValueError):
            c.set(bad, "x")
    c.set("k", "v")
    assert sorted(p.name for p in (tmp_path / "c").iterdir()) == ["k.json"]


@pytest.mark.l1_functional
def test_redis_keys_prefixed_and_expire():
    r = FakeRedis()
    RedisCache(r, ttl_s=60).set("diff-1", "{}")
    assert list(r.data) == ["inspector:ml:diff-1"] and r.ttl["inspector:ml:diff-1"] == 60


@pytest.mark.l7_discipline
def test_profile_config_fails_loudly(monkeypatch, tmp_path):
    monkeypatch.setenv("INSPECTOR_CACHE", "file")
    with pytest.raises(SystemExit, match="недопустим в профиле gpu"):
        make_cache("gpu", tmp_path)
    monkeypatch.setenv("INSPECTOR_CACHE", "redis")
    monkeypatch.delenv("INSPECTOR_REDIS_URL", raising=False)
    with pytest.raises(SystemExit, match="требует INSPECTOR_REDIS_URL"):
        make_cache("gpu", tmp_path)
    monkeypatch.setenv("INSPECTOR_CACHE", "memcached")
    with pytest.raises(SystemExit, match="ждём file или redis"):
        make_cache("dev", tmp_path)
    monkeypatch.delenv("INSPECTOR_CACHE")
    monkeypatch.setenv("INSPECTOR_ML_CACHE", str(tmp_path / "dev"))
    assert isinstance(make_cache("dev", tmp_path), FileCache)


@pytest.mark.l1_functional
def test_gpu_default_is_redis_from_url(monkeypatch, tmp_path):
    import sys
    import types

    made = {}

    class R:
        @staticmethod
        def from_url(url):
            made["url"] = url
            return FakeRedis()

    monkeypatch.setitem(sys.modules, "redis", types.SimpleNamespace(Redis=R))
    monkeypatch.delenv("INSPECTOR_CACHE", raising=False)
    monkeypatch.setenv("INSPECTOR_REDIS_URL", "redis://redis:6379/0")
    c = make_cache("gpu", tmp_path)
    assert isinstance(c, RedisCache) and isinstance(c.client, FakeRedis) and made == {"url": "redis://redis:6379/0"}
    c.set("k", "v")
    assert c.get("k") == "v"


@pytest.mark.l3_boundary
def test_dev_default_dir_nested_and_reopen(monkeypatch, tmp_path):
    monkeypatch.delenv("INSPECTOR_CACHE", raising=False)
    monkeypatch.delenv("INSPECTOR_ML_CACHE", raising=False)
    d = tmp_path / "a" / "b" / "c"
    c = make_cache("dev", d)
    assert isinstance(c, FileCache) and c.root == d and d.is_dir()
    FileCache(d).set("k", "значение")  # повторное открытие существующего каталога — без ошибки
    assert FileCache(d).get("k") == "значение"


@pytest.mark.l7_discipline
def test_config_error_messages_exact(monkeypatch, tmp_path):
    monkeypatch.setenv("INSPECTOR_CACHE", "file")
    with pytest.raises(SystemExit) as e:
        make_cache("gpu", tmp_path)
    assert str(e.value) == "INSPECTOR_CACHE=file недопустим в профиле gpu: кэш — Redis (ТЗ 9.1.5)"
    monkeypatch.setenv("INSPECTOR_CACHE", "redis")
    monkeypatch.delenv("INSPECTOR_REDIS_URL", raising=False)
    with pytest.raises(SystemExit) as e:
        make_cache("gpu", tmp_path)
    assert str(e.value) == "INSPECTOR_CACHE=redis требует INSPECTOR_REDIS_URL (redis://…)"
    with pytest.raises(ValueError, match="недопустимый ключ кэша: '../x'"):
        FileCache(tmp_path / "c").get("../x")
