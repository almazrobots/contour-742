# Стенд оценки по ТЗ §14

Считает приёмочные метрики §14 и 9.1.1 на эталонном наборе, публикует для каждой метрики размер
выборки, coverage и 95 % ДИ, сравнивает с порогами и выносит вердикт «принято / не принято»
(OS-INSP-6.5.1–6.5.3). Конвейер `inspector_ml` (parse → extract) вызывается напрямую, без HTTP.

```bash
cd ml
uv run python -m synth.factory --n 10 --seed 1 --out ../var/synth-v2      # эталон (фабрика v2)
uv run python -m eval.run --gold ../var/synth-v2 --out ../var/eval \
    [--bootstrap 1000] [--limit 3] [--md ../docs/qa/ACCEPTANCE-14.md]
```

Выход: `var/eval/report.json` (все метрики, ДИ, срезы, предсказания, версии, ресурсы) и `report.md`.

| Модуль | Что делает |
|---|---|
| `metrics.py` | CER, WER, Character Accuracy, Exact Match с политикой по типу поля, IoU, сопоставление находок, P/R/F1, FPR, coverage |
| `ci.py` | перцентильный бутстрап, ресэмплинг по `object_id` (объект — неделимая единица) |
| `thresholds.py` | пороги §14 и вердикт: любой непройденный порог — «не принято» |
| `decide.py` | решающий слой — зеркало `apps/api/src/domain/{revisions,compare}.ts` |
| `run.py` | прогон, агрегирование, срезы по объектам, разделам и типам, отчёты |
| `organizer.py` | адаптер листа «ПРИМЕРЫ РАЗМЕТКИ» из Матрицы организаторов → evidence_group |

## Формат эталона

Каталог набора: по подкаталогу на объект, в каждом — файлы документов, `manifest.json` (реестр,
формат генератора v1 и API: `file_id`, `file_name`, `sha256`, `doc_stage`, `discipline`,
`document_code`, `revision`, `approval_status`, `predecessor_id`, …) и `gold.json`:

```jsonc
{
  "schema": "inspector-eval-gold/1",
  "dataset_version": "synth-v2:seed=1",
  "object_id": "SYN-1-001",                    // единица изоляции: бутстрап и разбиение
  "profile": {"residential": true, "underground": false, "gas": false, "demolition": false},
  "files": [{"file_id", "file_name", "sha256", "doc_stage", "discipline", "document_code", "revision",
             "approval_status", "predecessor_id", "kind": "pdf|scan", "dpi", "skew_deg", "blur", "pages"}],
  "pages": [{"file_id", "page", "source": "text|scan",
             "text": "строки сверху вниз, слова слева направо, \n между строками",
             "dont_care": [[x0, y0, x1, y1]]}],  // зоны реквизитов — вне CER
  "key_fields": [{"file_id", "page", "field": "code|stage|revision|sheet|room", "value", "bbox"}],
  "values": [{"file_id", "page", "param": "M-002", "raw": "12 450,0", "bbox"}],
  "requisites": [{"file_id", "page", "kind": "seal|signature|stamp_production|stamp_done", "bbox", "text"}],
  "changes": [{"param", "file_old", "file_new", "old", "new", "change": "modified|added|removed",
               "page_old", "bbox_old", "page_new", "bbox_new"}],
  "evidence_groups": [{
    "evidence_group_id": "SYN-1-001:M-002", "object_id", "param": "M-002",
    "section": "ПЗ",                     // раздел Матрицы — срез «по разделам»
    "violation_type": "delta_pct",       // тип правила Матрицы — срез «по типам»
    "label": "CANDIDATE|CONFIRMED_VIOLATION|NEGATIVE_VERIFIED|MISSING_EVIDENCE|CLARIFICATION_REQUIRED|NOT_APPLICABLE",
    "superseded_trap": false,            // отрицательная группа, где нарушение есть только в устаревшей редакции
    "expected_value", "actual_value",
    "evidence": [{"file_id", "page", "bbox", "stage", "document_code", "revision", "approval_status"}]
  }],
  "conflict": false
}
```

Координаты — `[x0, y0, x1, y1]` в долях видимой страницы, начало — левый верхний угол (как у
`inspector_ml`, OS-INSP-2.2.2). Для сканов рамки даны после наклона листа.

## Как считаются метрики

| Метрика | Единица и правило | Порог |
|---|---|---|
| Character Accuracy | 1 − ΣLevenshtein / Σсимволов эталона; только OCR-страницы сканов ≥ 300 dpi (ТЗ 9.1.1); NFC + схлопывание пробелов; знаки и регистр значимы | ≥ 0,95 |
| CER, WER | то же; WER — по словам. Справочно — по всем сканам и всем страницам | — |
| Exact Match | поле штампа или номер помещения; нормализация `FIELD_POLICY`: шифр — знаки и регистр значимы, пробелы у «-./» и латинские двойники — нет; стадия — PD/П, регистр не значим; редакция — регистр значим; лист — число; помещение — точки значимы, регистр нет | ≥ 0,90 |
| Связка | группа: набор (object_id, стадия, шифр, редакция) источников системы = эталону | ≥ 0,95 |
| Локализация | группа: каждый фрагмент эталона найден — тот же file_id, та же страница, IoU ≥ 0,50 | ≥ 0,95 |
| Precision / Recall / F1 | по evidence_group, ключ (object_id, param); TP — CANDIDATE на положительной группе с полной локализацией; CANDIDATE с неполной — FP и FN; CANDIDATE вне эталона — FP | 0,90 / 0,80 / 0,85 |
| FPR | FP / число групп NEGATIVE_VERIFIED (в т.ч. ловушек устаревших редакций) | ≤ 0,10 |
| coverage | доля эталонных единиц, на которые система ответила (страница не ABSTAIN, поле прочитано, группа построена) | — |

Каждая метрика — отношение сумм счётчиков, поэтому считается одинаково по всему набору, по срезу
и в бутстрап-реплике. ДИ — 2,5 и 97,5 перцентили по B репликам с ресэмплингом объектов целиком.
Вердикт — по точечной оценке; колонка «весь ДИ за порогом» показывает устойчивость.

Статусы MISSING_EVIDENCE, CLARIFICATION_REQUIRED и NOT_APPLICABLE в P/R не входят — их точность
публикуется отдельно, а CANDIDATE на них считается FP.

## Разметка организаторов

`organizer.load_examples(path)` читает лист «ПРИМЕРЫ РАЗМЕТКИ» (`ТЗ/Матрица_параметров_редакция1.1.xlsx`,
вне git; путь ищется вверх от `ml/`) и строку источников вида
`PD:ALT79B-000015:стр.19:bbox [0.78,0.10,0.91,0.35];[…] | RD:…` переводит в `evidence` эталона:
элемент на каждую рамку, `bbox —` → `bbox: null`, object_id — префикс file_id. Параметра Матрицы
в примерах нет (`param: null`), сопоставление — по группе. Документов организаторов у нас нет —
адаптер проверен только на формате.

## Стенд мутаций L11 (T-179, OS-INSP-6.5.40–6.5.49)

### Два профиля: structural и adversarial

- **structural** (seed 7, 726+ примеров) — шаблоны генератора; меряет механику конвейера и роняет гейт QA-07 при
  регрессе. Совпадение с истиной 1,0 здесь — самосогласованность шаблонов, а не качество.
- **adversarial** (seed 29) — отложенный набор `eval/mutations/adversarial-w1.json`: другие подписи ТЭП, раскладки
  (единица в подписи, значение строкой ниже, фраза «составляет …», перенос подписи), форматы чисел (неразрывный пробел,
  точка, хвостовой ноль), обороты класса (ячейка таблицы, перенос строки внутри оборота, «относится к классу»), шум
  второго распознавателя (слитные слова, гомоглиф, число без пробела), шум значения (C/С, О/0, l/1), дистракторы
  (класс соседнего здания, норма «не ниже»). ПД и РД выбирают формулировку независимо. **На нём ничего не
  настраивается**: паспорта и экстракторы правят по своим dev-наборам, сюда — только прогон и цифры в отчёт.
  Отчёт добавляет «Разбор по формулировкам» — на каких признаках ошибается конвейер.
- Сводка рядом: `.venv/bin/python -m eval.mutation_run summary` → `var/mutations/summary.md`.
- Отложенные наборы других веток подключаются в `adversarial-w1.json → external.phrasers` строкой «модуль:функция»
  (функция `(код, rng) → фраза с {V} или None`); не влитый модуль — пометка в отчёте, а не падение.

Разметки мало — качество операторов меряется на синтетических мутациях с известной истиной (каталог TO-BE §15).
Генератор строит пару векторных PDF «ПД → РД» вымышленного объекта, вносит в РД одну мутацию и записывает истину:
тип мутации, пару «параметр × оператор», ожидаемый статус, страницу и рамку значения. Каждый пример проходит
**настоящий** конвейер: приём пакета с реестром → роли редакций → ML-сервис `/analyze` по HTTP → пересчёт протокола
паспортными операторами API. Статус группы — запись `checks`, как её видит инспектор.

```bash
cd ml
# всё — на раннере (ADR-0009, docs/ops/REMOTE-RUNNER.md); \$W1_THREADS — ядра слота, не больше 4 потоков на прогон
scripts/remote-run.sh "cd ml && .venv/bin/python -m eval.mutation_run light --parallel 2"          # 65 примеров, ~45 с, + гейт QA-07 (в local-gate)
scripts/remote-run.sh --get ml/var/mutations/structural/report.md "cd ml && .venv/bin/python -m eval.mutation_run run --profile structural --parallel 3"   # 726 примеров
.venv/bin/python -m eval.mutation_run gate --profile structural --report var/mutations/structural/report.json
.venv/bin/python -m eval.mutation_run baseline --profile structural --report var/mutations/structural/report.json  # храповик — только осознанно
.venv/bin/python -m eval.mutation_run rescore --profile structural   # пересчитать отчёт по dataset.json и api.json без прогона
## Стенд W1 на реальных объектах (T-180, OS-INSP-6.5.50–6.5.54)
Качество пар «параметр × оператор» W1 на объектах корпуса «Хакатон». Только на раннере (ADR-0009), только через
`scripts/runner/w1-real.sh`: своё пространство монтирования, где `/opt/corpus` и кэш разбора r4 `/opt/inspector/cache`
смонтированы **только на чтение** (запись падает EROFS, обёртка и стенд отказывают, если это не так), кэш ML — overlay
поверх r4 с верхним слоем в `$W1_EVAL/ml-cache-upper`. Файлы объекта не копируются: хранилище API и ML — блобы корпуса,
проверка создаётся серверным импортом по SHA-256 (T-169), реестр — `deriveRegistry` из путей архива, как у загрузчика.
# правило №0: сначала несколько лёгких файлов — замер, потом объект
scripts/remote-run.sh --light "scripts/runner/w1-real.sh run --object POL-17 --codes M-023 --limit-files 10 --workers 1"
scripts/remote-run.sh "nice -n 19 scripts/runner/w1-real.sh run --object POL-17 --codes M-001,M-002,M-003,M-004,M-005,M-023"
# --approval — статус утверждения ПД/РД по подтверждению оператора (OS-INSP-1.2.25); без него ворота честно дают уточнение редакции
scripts/remote-run.sh --light "scripts/runner/w1-real.sh gold summary"
scripts/remote-run.sh --light --get docs/qa/W1-QUALITY.md \
  "scripts/runner/w1-real.sh table --mutations /opt/w1-gate/wt/feat_t179-mutations/ml/var/mutations/full/report.json"
```

| Модуль | Что делает |
|---|---|
| `eval/mutations/w1.json` | **реестр мутаций — данные**: пары «параметр × оператор», как значение пишется, правило истины, сколько примеров каких мутаций |
| `synth/mutations.py` | генератор: план по реестру, объект, мутация, отрисовка PDF (примитивы фабрики v2), истина `truth_for` |
| `apps/api/scripts/mutation-bench.ts` | прогон набора через API (PGlite в памяти, файлы — во временном хранилище, ML — по `INSPECTOR_ML_URL`) |
| `eval/mutation_score.py` | QA-05/QA-06, локализация, гейт QA-07, метки для судьи T-156 |
| `eval/mutation_run.py` | оркестр: генерация → ML-сервис на случайном порту > 40000 → API → отчёт `var/mutations/<профиль>/` |
| `eval/baselines/w1-mutations.json` | базовая линия QA-07 (профили light и full), в git |

### Как подключить свой параметр (T-172…T-176)

1. **Параметр известного вида** — одна строка в `eval/mutations/w1.json → params`, кода не нужно:

   ```jsonc
   {"code": "M-021", "operator": "CMP-04", "wired": true, "kind": "class",
    "label": "Класс энергетической эффективности здания",           // так значение пишется в документе (якорь паспорта)
    "scale": ["G", "F", "E", "D", "C", "B", "B+", "B++", "A", "A+", "A++"],  // истина — отдельно от паспорта системы
    "rule": {"type": "rank_decrease"},
    "counts": {"MUT-06": {"pos": 100, "neg": 30}, "MUT-18": {"stale": 4, "conflict": 2, "swap": 2}, "MUT-17": 2}}
   ```

   Виды записи (`kind`): `quantity` — строка ТЭП «подпись — ед. — число» (`range` или `range_of: [код, доля от, доля до]`,
   `rule`: `abs` с `tol`, `pct` с `pct` и `tol`, `decrease` с `tol`); `class` — фраза «подпись — значение.» (`scale`,
   `rule: rank_decrease`); `mark` — марка кабеля (`value`, `downgrade`); `layers` — состав конструкции; `room_purpose`,
   `rooms_total` — экспликация; `branches` — подписи ветвей схемы.
2. **Оператор ещё не влит** — `"wired": false`: примеры строятся и прогоняются, но идут в раздел «ожидает оператора»
   (наблюдаемый статус против ожидаемого), не в метрики. Прогон API читает проверки всех кодов реестра
   (`mutation_run.registry_codes` → `--codes` скрипта `mutation-bench.ts`), поэтому раздел показывает, что система отвечает
   сегодня (например, лексическим путём Матрицы). После влития — `"wired": true` и пересборка базовой линии.
3. **Нужна чужая операция** — `"requires": ["CMP-29"]` у пары; когда операция влита, её код добавляется в верхний
   `"implemented": [...]` реестра — примеры пары переходят в метрики без правки генератора (MUT-17 ждёт CMP-29,
   MUT-18/swap — IDN-12 и VER-03).
4. **Новый вид записи** (таблица, которой ещё нет) — отрисовка в `synth/mutations.py` (`_page_general` / `_page_tep`),
   мутация в `_mutate`, имя вида в `KINDS`; тест в `tests/test_mutations.py`. Правило истины, если нужно новое, —
   `rule_breaks`.
5. Счёт: на каждый подключённый оператор — ≥ 100 положительных и ≥ 100 отрицательных групп (тест
   `test_full_plan_gives_100_pos_and_100_neg_per_wired_operator`). Отрицательные набираются и «поперёк»: мутация чужого
   параметра и контроли NEG-01…03 — отрицательные группы для всех подключённых пар примера.

### Как считается

Единица — группа «пример × параметр × оператор». Предсказание «нарушение» — CANDIDATE. Воздержание — MISSING_EVIDENCE,
NOT_COMPARABLE, CLARIFICATION_REQUIRED при известной метке (на положительной — промах Recall). FPR устаревших — доля
CANDIDATE на ловушках MUT-18/stale (нарушение только в заменённой редакции). Статус «прочих» групп (конфликт редакций —
CLARIFICATION_REQUIRED) — в «точности статуса». Доли — Уилсон 95 %, F1 — бутстрэп по примерам. Локализация — фрагмент
РД того же файла и страницы с IoU ≥ 0,5 к рамке мутации.

QA-07: обязательные категории — оператор, пара, тип мутации по целевому параметру (где есть положительные).
Строка базовой линии — профиль и ревизия разбора (`structural@parser4`): смена `PARSER_REV` (T-184) даёт новую строку, а не
ложное падение — без неё гейт сравнивает с прежней ревизией справочно и просит собрать строку командой `baseline`.
Ветку сверяют и с базовой линией `main` (OWASP T179-3): правка файла в ветке гейт не ослабляет. Гейт падает,
если Recall категории ниже базового, FPR (общий, категории, по устаревшим) выше базового больше чем на 2 п.п., категория
пропала, набор не тот (другой seed или реестр) или есть примеры с отказом разбора.

Метки для судьи (T-156) — `var/mutations/<профиль>/judge/`: `queue.jsonl` и `labels.jsonl` в формате учителя
(`teacher/labels.validate`), `sft.jsonl` (`teacher.labels.sft_record`), `decisions.jsonl` — решения по группам.
Синтетика — только `split: train` (OS-INSP-6.4.16: метрики модели — на реальных документах).

Не делается в W1 (геометрия и растр — W2): MUT-03, 04, 09, 10, 13, 14, 15, 16 — `not_in_w1` реестра с причиной.
## Отложенный состязательный набор W2 (T-195)
Качество операторов W2 (CMP-06, 07, 09, 12, 13, 14, 15, 16, 19, 30, 31) меряется только на этом наборе
(ADR-0010 п. 6): другой автор, чем у генератора разработки T-192, seed ≥ 100000, свои соглашения оформления.
Пары, правила и декларация эффектов мутаций — `mutations/w2.json`; базовая линия QA-07 — `baselines/w2-holdout.json`.
uv run python -m eval.w2_holdout.generate --seed 100000 --out ../var/w2-holdout      # 1115 примеров, ~6 мин, ≤ 200 МБ RAM
uv run python -m eval.w2_holdout.generate --seed 100000 --out ../var/w2h --only NEG-01 MUT-09/door --per 2
uv run python -m eval.w2_holdout.score --dataset ../var/w2-holdout/dataset.json --results run.json \
    --out ../var/w2-holdout/report.json --md ../var/w2-holdout/report.md \
    --baseline eval/baselines/w2-holdout.json --profile full [--write-baseline]
Пример — каталог `W2H-<seed>-<номер>/`: `PD-{AR,OV,PB,GP}.pdf`, `RD-…pdf`, `manifest.json` (реестр файлов как у
стенда T-179) и `*.geom.json` — истина листа по сущностям PlanGeometry. Вход `score.py` —
`{"results": [{"case_id", "rows": [{"code", "operator", "status", "fragments": [{"stage", "file_id", "page", "bbox"}]}],
"files": [{"parse_status"}], "error"}]}`; строка ищется по (case_id, code, operator), без operator — на все операторы кода.
| `apps/api/scripts/w1-real-bench.ts`, `src/domain/w1-real.ts` | проверка, импорт по хешу, разбор ML, пересчёт; схема входа, порции, окружение |
| `eval/w1_real.py` | оркестр: файлы объекта из каталога корпуса (только с разбором r4), ML-сервис на порту > 40000, API, группы, агрегат |
| `eval/w1_real_score.py` | эталон, исходы, метрики с ДИ, барьер агрегатов `assert_aggregate`, протокол разметки |
| `eval/w1_real_table.py` | `docs/qa/W1-QUALITY.md`: строка на пару, сводка по оператору, мутации T-179 рядом |
| `eval/w1_real_sources.json` | источники эталона по 47 параметрам — только коды объектов и счётчики |
**Что где лежит.** Всё подробное — только на сервере, `$W1_EVAL=/opt/w1-gate/eval/w1` (права 700): прогоны
`<объект>/<время>/` (spec, api.json со статусами, значениями и страницами, groups, журналы ML и API), эталон
`gold/<объект>.json`, разметка `labeling/<объект>/<параметр>/`. Наружу — агрегат (`aggregates/<объект>.json`,
`ml/var/w1-real/<объект>.json`): коды объектов, параметров, операторов, статусов и числа; всё прочее барьер отбивает.
**Эталон** (`gold/<объект>.json`, схема `inspector-w1-real-gold/1`): метки `{param, operator|null, label, source, quality,
ref}`; `label` — CONFIRMED_VIOLATION, NEGATIVE_VERIFIED, MISSING_EVIDENCE, NOT_APPLICABLE, CLARIFICATION_REQUIRED;
`source` по старшинству — `verified` (проверенный результат проекта, OS-INSP-6.5.8), `organizer`, `pilot`, `manual`;
`quality` — `final` (в метрики), `second_review`, `candidate` (нет); `ref` — код задачи, правила, проверки организатора или
`labeler:<логин>`. Метка ставится командой `gold set` или из формы разметки.
**Как считается.** Группа — объект × параметр × оператор; статус проверки параметра приписывается подключённой паре стенда
мутаций (`eval/mutations/w1.json`, иначе первому оператору W1 параметра). Исходы — как у стенда мутаций: CANDIDATE на
положительной — TP, воздержание на положительной — промах Recall, FPR — на NEGATIVE_VERIFIED. Интервалы — Уилсон на одном
объекте с метками, бутстрэп по объектам на нескольких; F1 на одном объекте без интервала.
### Протокол ручной разметки (OS-INSP-6.5.54)
Где эталона нет, группа в таблице — «нет эталона», а не цифры. Истину ставит инспектор:
1. Прогон объекта (`run`) — упоминания всех параметров прогона остаются в `api.json` на сервере.
2. `scripts/runner/w1-real.sh mentions --object LOS-3A --param M-023` — очередь упоминаний ПД/РД/ИД в формате учителя
   (`labeling/LOS-3A/M-023/queue.jsonl`) и форма `form.csv`: первая строка — группа (статус системы подсказкой),
   дальше по строке на упоминание (стадия, файл по идентификатору реестра, страница, значение, строка текста).
3. Инспектор на сервере заполняет `label`: у группы — метку из списка выше; у упоминания — `ACCEPT` или `REJECT` с причиной
   из `verifier.REASONS` и верным значением; `rationale` и `labeler` (логин латиницей) обязательны. Можно частями.
4. `gold import --object LOS-3A --param M-023` — метка группы уходит в эталон объекта (`source: manual`), метки
   упоминаний — в `labels.jsonl` рядом (формат `teacher/labels.py`: эталон дообучения судьи T-156, split по объекту).
