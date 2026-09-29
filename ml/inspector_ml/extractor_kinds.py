"""Реестр извлекателей по виду паспорта (T-186, OS-INSP-7.1.21): `extractor.kind` → функция(doc, spec) -> list[Extraction].

Параметр с зарегистрированным извлекателем идёт своим путём — все упоминания, а не лучшая строка: в лексический,
семантический путь и перечитывание OCR не попадает. Новый вид — одна строка `register("<kind>", <функция>)` в конце
файла (по алфавиту; сама функция — в своём модуле вида). Спецификация без извлекателя или с незнакомым kind идёт
прежним лексическим путём (OS-INSP-2.2.13) — незнакомый вид отсекает API при загрузке паспорта (domain/param-kinds.ts).
"""

from __future__ import annotations

import os

from collections.abc import Callable

from .category_mentions import KIND as CATEGORY_KIND
from .category_mentions import extract_category_mentions
from .class_mentions import KIND as CLASS_KIND
from .class_mentions import extract_class_mentions
from .direction_mentions import KIND as DIRECTION_KIND
from .direction_mentions import extract_direction_mentions
from .doc_requirements import extract_doc_requirements
from .geom_mentions import extract_geometry_mentions
from .layer_mentions import KIND as LAYER_KIND
from .layer_mentions import extract_layer_mentions
from .model import Extraction, ParamSpec, ParsedDoc
from .composition_mentions import extract_composition_mentions
from .presence_mentions import KIND as PRESENCE_KIND
from .presence_mentions import METHOD_KIND
from .presence_mentions import extract_presence_mentions
from .count_mentions import extract_count_mentions
from .quantity_mentions import KIND as QUANTITY_KIND
from .quantity_mentions import extract_quantity_mentions
from .schedule_rows import extract_schedule_rows

Way = Callable[[ParsedDoc, ParamSpec], list[Extraction]]

REGISTRY: dict[str, Way] = {}


def register(kind: str, way: Way) -> Way:
    """Регистрация извлекателя. Повтор kind — отказ при импорте, а не тихая подмена чужого извлекателя."""
    if not kind or kind in REGISTRY:
        raise ValueError(f"реестр извлекателей: вид «{kind}» пустой или уже зарегистрирован")
    REGISTRY[kind] = way
    return way


def way_by_kind(kind: object) -> Way | None:
    """Извлекатель по виду — без привязки к корню паспорта: так же берётся вид части паспорта (T-174, parts)."""
    return REGISTRY.get(kind) if isinstance(kind, str) else None


def skipped_kinds(env: dict | None = None) -> frozenset[str]:
    """INSPECTOR_SKIP_KINDS — виды извлекателей, выключенные в этом проходе (T-233, первичный проход по корпусу):
    «geometry_mentions» — геометрия векторных чертежей на CPU держала все процессы ML по 45+ мин на лист РД.
    Параметр такого вида — без упоминаний («нет доказательства»), а не лексический путь; вид входит в ревизию ML,
    поэтому включение вида переанализирует файлы из кэша разбора."""
    raw = (os.environ if env is None else env).get("INSPECTOR_SKIP_KINDS", "")
    return frozenset(k.strip() for k in raw.split(",") if k.strip())


def _skipped(doc, spec) -> list:
    return []


def way_of(spec: ParamSpec) -> Way | None:
    """Извлекатель своего пути для параметра; None — лексический путь (нет извлекателя или вид не зарегистрирован)."""
    kind = (spec.extractor or {}).get("kind")
    if kind and kind in skipped_kinds():
        return _skipped
    return way_by_kind(kind)


def has_way(spec: ParamSpec) -> bool:
    return way_of(spec) is not None


register(CLASS_KIND, extract_class_mentions)  # М-023, OS-INSP-2.2.13–2.2.16
register(DIRECTION_KIND, extract_direction_mentions)  # М-043, М-106, OS-INSP-2.2.152–2.2.159 (T-214)
register(METHOD_KIND, extract_presence_mentions)  # М-091 — тот же извлекатель, вид method (T-212)
register(PRESENCE_KIND, extract_presence_mentions)  # М-053…М-122, OS-INSP-2.2.135–2.2.144 (T-212)
register("geometry_mentions", extract_geometry_mentions)  # W2 геометрия плана, OS-INSP-2.2.110–2.2.122 (T-192)
register(QUANTITY_KIND, extract_quantity_mentions)  # М-001, OS-INSP-2.2.22–2.2.25
register("composition_mentions", extract_composition_mentions)  # М-011, OS-INSP-2.2.62 (T-175)
register("doc_requirements", extract_doc_requirements)  # М-096, OS-INSP-2.2.150–2.2.151 (T-213)
register("schedule_rows", extract_schedule_rows)  # М-082, М-087, OS-INSP-2.2.145–2.2.149 (T-213)
register(CATEGORY_KIND, extract_category_mentions)  # T-176: CMP-05, OS-INSP-2.2.70–2.2.75
register(LAYER_KIND, extract_layer_mentions)  # T-176: CMP-21, OS-INSP-2.2.76–2.2.79
register("count_mentions", extract_count_mentions)  # М-007, М-010: разбор чисел quantity_mentions + формы счёта (T-187), целое — в API
