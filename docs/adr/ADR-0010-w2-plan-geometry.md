---
id: ADR-0010
title: "Волна W2: геометрия векторного плана — отдельный слой PlanGeometry рядом с ParsedDoc, паспорт вида geometry, VER-04 в понижающем слое"
status: accepted
owner: CTO (сессия T-190, тимлид W2)
date: 2026-09-28
task: T-190
related: [ADR-0008, ADR-0009]
---

# ADR-0010. Волна W2: геометрия векторного плана

## Контекст

Каталог TO-BE (§16–17) относит к волне W2 50 параметров Матрицы. 16 из них требуют геометрических операторов
(CMP-12 GEO-DIM, 13 GEO-AREA, 14 GEO-POS, 15 GEO-SHAPE, 16 GEO-REL, 19 GRAPH-TOPO, CMP-06 по измерению), ещё 15 —
сущностей, которые берутся только с чертежа (оси, размеры, стены, трассы, генплан), 19 работают по тексту и таблицам
на операторах W1.

Что есть в коде (разведка 28.09):

- `ParsedDoc` (`ml/inspector_ml/model.py`) несёт только текст, слова и рамки; путей, толщин и цветов в нём нет.
  `PARSER_REV = 4`, `ParsedDoc`, `parse_file` заморожены до влития T-165 (ADR-0008 п. 5).
- Векторные пути страницы уже извлекаются: `pagekind.page_vectors` (pypdfium2, XObject-матрицы, Безье → 8 отрезков,
  отсечение по видимой области) — T-127. В продукте не вызывается. Прецедент отдельного прохода pdfium поверх
  ParsedDoc — `change_marks.py` (T-177).
- `/measure` (OS-INSP-2.4.1–2.4.7) — растровый: Хаф и профиль чернил, по запросу инспектора, в оценку параметров не входит.
- PyMuPDF исключён (AGPL), Shapely в зависимостях нет.

## Решение

1. **Геометрия — отдельный слой `PlanGeometry`, ParsedDoc не меняется.** Модуль `ml/inspector_ml/plan_geom.py`
   делает свой проход pdfium под `PDFIUM_LOCK` поверх `pagekind.page_vectors` и слов ParsedDoc (подписи, марки,
   числа размеров) и строит `PlanGeometry` страницы. Кэш — `geom-{sha}-p{page}-g{GEOM_REV}` рядом с кэшем разбора,
   свой номер ревизии `GEOM_REV`; `PARSER_REV` не трогается. Растровая ветка и сканы — W3: страница без векторного
   слоя получает `quality.status = NOT_COMPARABLE`, причина `NO_VECTOR_LAYER`.
2. **Без новых зависимостей.** Площадь, пересечение, IoU, Хаусдорф, RANSAC-подобие и граф — на numpy (ML) и на чистом
   TypeScript (API). Shapely и networkx не добавляются: новая зависимость — новая поверхность атаки и новый пункт
   `uv.lock`, а объёмы (сотни полигонов на лист) этого не требуют.
3. **Параметр = паспорт + оператор (как ADR-0008).** Новый вид паспорта `value.kind = "geometry"` и экстрактор
   `extractor.kind = "geometry_mentions"`. Код появляется только для нового вида оператора:
   `apps/api/src/domain/geom-*.ts`. Нормативный порог (CMP-06 по измерению) — данные `data/seed/norms.json`
   (Normative_Base: документ, пункт, min/max, **правило измерения**, срок действия).
4. **Контракт ML → API** — ниже, общий для веток W2. Ветка извлечения (T-192) выдаёт ровно его, ветка операторов
   (T-193) пишет тесты на фикстурах этого вида и не ждёт T-192.
5. **VER-04 — шаг общего понижающего слоя** `verify-l8.ts` (ADR-0008 п. 2): у геометрического результата
   остаток регистрации или разброс масштаба вне допуска → только понижение до NOT_COMPARABLE. VER-06 (второй источник:
   размер-надпись против измерения, ведомость проёмов против дуги двери) и VER-10 (калибровка уверенности) — там же.
6. **Качество меряется на отложенном состязательном наборе, а не на генераторе разработки.** Генератор планов ветки
   T-192 (`ml/synth/plans.py`, seed 0–9999) — только для разработки. Отложенный набор T-195 пишет другой исполнитель,
   не читая `plans.py`, по каталогу и этому контракту, на своих seed ≥ 100000 и в других чертёжных соглашениях
   (масштабы 1:50/1:200/1:500, стрелки вместо засечек, поворот листа, негоризонтальные стены, текст кривыми,
   шум). Цифры для QA-отчёта и таблицы качества — только с него.

## Контракт `PlanGeometry` (ML) и геометрического упоминания (ML → API)

Координаты: `sheet` — мм листа от левого верхнего угла видимой области; `bld` — мм в системе осей здания (NRM-09),
есть только при успешной регистрации; `bbox` — доли видимой страницы, как в ParsedDoc (для provenance и подсветки).

```text
PlanGeometry {
  page: int, rev: GEOM_REV,
  quality: { status: "OK" | "NOT_COMPARABLE", why: null | "NO_VECTOR_LAYER" | "NO_SCALE" | "SCALE_SPREAD" | "TIMEOUT" },
  scale: { n: float | null, method: "stamp" | "dimensions" | "both", spread_pct: float, n_dims: int },      # ENT-06
  frame: { to_bld: [a,b,c,d,e,f] | null, residual_mm: float | null, anchors: int },                          # NRM-09
  axes:     [{ mark, p0, p1, bbox }],                                                                          # ENT-03
  dims:     [{ value_mm, measured_mm, p0, p1, bbox, conditional: bool }],                                      # ENT-04
  levels:   [{ value_m, kind: "floor"|"slab_top"|"bottom"|"other", absolute: bool, bbox }],                    # ENT-05
  walls:    [{ a, b, thickness_mm, fire: bool, hatch, bbox }],                                                 # ENT-11
  openings: [{ mark, kind: "door"|"window"|"gate", width_mm, clear_mm, swing, wall, bbox }],                   # ENT-10
  stairs:   [{ kind: "stair"|"ramp"|"lift", steps, riser_mm, tread_mm, slope_pct, shaft_mm: [w,d], bbox }],   # ENT-12
  routes:   [{ system, section, points: [[x,y]…], nodes: [{ id, kind, mark, at }], edges: [[id,id]…], bbox }], # ENT-09
  symbols:  [{ kind, mark, at, bbox }],        # условные знаки по легенде: извещатель, оповещатель, ОЗК, кран ВПВ
  rooms:    [{ number, polygon, area_m2, bbox }],
  site:     [{ kind: "building"|"road"|"parking"|"parking_mgn"|"asphalt"|"paving"|"lawn"|"playground"|"fence",
               polygon, width_mm, area_m2, count, bbox }]                                                      # ENT-21
}

GeomMention (Extraction.meta.geom, одна запись = одно измерение для паспорта) {
  entity: "ENT-03" | … | "ENT-21",
  measure: "length" | "area" | "position" | "shape" | "relation" | "topology" | "count",
  value: float | null, unit: "мм" | "м" | "м²" | "шт",
  by: "dimension" | "geometry" | "both",                  # откуда значение: надпись размера, измерение, оба (VER-06)
  label_value: float | null, measured_value: float | null, # обе стороны для VER-06 и флага «не в масштабе»
  key: str,                                                # ключ сопоставления LNK-06: марка, номер помещения, ось…
  at: [x, y] | null, polygon: [[x,y]…] | null, graph: { nodes, edges } | null, frame: "bld" | "sheet",
  scale_n: float | null, scale_spread_pct: float, residual_mm: float | null,
  page, bbox, quote
}
```

Уточнения контракта (T-190, 28.09, по вопросам T-194):

- Регистрация вида — реестрами T-186 (`docs/ops/WAVES.md` «Как добавить вид параметра»): API — `apps/api/src/domain/kinds/geometry.ts`
  (`registerKind({kind: "geometry", …})`), ML — `register("geometry_mentions", …)` в `extractor_kinds.py`. Экстрактор
  называется `geometry_mentions` (соглашение `<вид>_mentions`), а не `plan_geometry`; модуль ML `plan_geom.py` не меняет имени.
  `passport.ts`, `inspections.ts`, `extract.py` не правятся.

- `frame.to_bld = [a, b, c, d, e, f]` — порядок матрицы PDF: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`, вход — `sheet` мм,
  выход — мм в осях здания.
- `symbols[].kind` — закрытый словарь: `smoke_detector`, `heat_detector`, `manual_call_point`, `sounder`, `exit_sign`,
  `fire_damper`, `fire_hydrant_valve`, `call_button`, `meter`, `lift_platform`, `handrail`, `other`. Неизвестный знак
  легенды — `other` с `mark`, а не новый вид.

## Последствия

- Ветки W2 почти не пересекаются: извлечение (`ml/inspector_ml/plan_geom*.py`, `ml/synth/plans.py`), операторы
  (`apps/api/src/domain/geom-*.ts`, `data/seed/norms.json`, паспорта геометрии), понижающий слой и кросс-проверки
  (`verify-l8.ts`, `domain/xdisc.ts`), текстовые паспорта W2. Общие точки — диспетчер в `inspections.ts` и
  `extract.py`, union в `passport.ts`, `model.yaml`, `vitest.unit.config.ts`, `echelons.json`; конфликты решает тимлид.
- `EXTRACT_REV` поднимается при влитии T-192 (следующий свободный на тот момент).
- `pagekind.py` попадает в `paths_to_mutate` mutmut вместе с `plan_geom*.py`.
- Цена: для геометрического результата нужен свой вид provenance на экране (полигон, отрезок измерения); общий
  компонент подсветки расширяется, а не копируется — после ядра волны.
