"""Корень репозитория — ближайший вверх каталог с pnpm-workspace.yaml.

Не «N уровней вверх от файла»: песочница mutmut (ml/mutants/…) глубже исходников, и data/seed, assets, var
оттуда по фиксированной глубине не находятся. INSPECTOR_ROOT — явное переопределение (контейнер без репозитория).
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=None)
def repo_root(start: str | None = None) -> Path:
    env = os.environ.get("INSPECTOR_ROOT", "").strip()
    if env:
        return Path(env)
    here = Path(start or __file__).resolve()
    for p in [here, *here.parents]:
        if (p / "pnpm-workspace.yaml").exists():
            return p
    return Path(__file__).resolve().parents[2]  # вне репозитория — прежнее правило
