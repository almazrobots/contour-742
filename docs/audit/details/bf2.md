# Аудит БФ-2 (OS-INSP-2.*.*): распознавание, извлечение, реквизиты, измерения

Коммит 7e1f886, worktree `building-tech-audit`. Все 97 ссылок impl (code и tests) по области существуют буквально: подстроки найдены, тесты с такими именами есть. Вердикты ниже выставлены по смыслу: делает ли код то, что сказано в правиле, и проверяет ли это тест.

Итог: GREEN 13 · YELLOW 10 · RED 1 · GREY 2 (всего 26).

| Код | Правило (кратко, ≤ 12 слов) | Вердикт | Причина | Код-ссылка | Тест |
|---|---|---|---|---|---|
| OS-INSP-2.1.1 | Текстовый слой, если есть; OCR только для страниц без слоя | GREEN | Решение принимается по каждой странице отдельно (`chars >= MIN_TEXT_CHARS`, parse.py:210); тест проверяет source=text и source=ocr | parse.py::def parse_pdf, ::MIN_TEXT_CHARS | test_text_layer_first_ocr_only_without_layer |
| OS-INSP-2.1.2 | Качество страницы ниже порога — LOW_QUALITY | YELLOW | Код верен (parse.py:177), но тест допускает `ABSTAIN` и выбирает страницу без строк: сравнение с порогом 60 не проверяется | parse.py::LOW_QUALITY_CONF | test_noise_page_marked_low_quality |
| OS-INSP-2.1.3 | Кэш результата разбора по SHA-256 файла | GREEN | Ключ = sha256 + ревизии разборщика и извлечения + хеш параметров (app.py:62-69); тест проверяет `cached` и совпадение извлечений | app.py::def _cache_key | test_analyze_cached_by_sha256 |
| OS-INSP-2.1.4 | Тайм-аут: до 2 повторов, затем уведомление администратора | YELLOW | Проверена общая очередь с `maxRetries: 2`, заданным в самом тесте; прод-конфиг `parseWork` (inspections.ts:258-263) и `notify(admin)` тестом не проверяются | inspections.ts::maxRetries: 2, queue.ts::export function inProcessQueue | queue.test.ts::повторяет сбойное задание до 2 раз, затем уведомляет |
| OS-INSP-2.1.5 | Несколько движков OCR, текст выбирается голосованием | GREEN | Голосование большинством с правилом ничьей реализовано (ocr_ensemble.py:309-355) и проверено фейковыми движками. Оговорка: в dev это три прогона одного Tesseract с разными настройками | ocr_ensemble.py::def run_ensemble, ::def vote, parse.py::def _ocr_page | test_vote_majority_picks_text_and_marks_disputed, test_no_available_engine_abstains |
| OS-INSP-2.1.6 | Расхождение движков — слово сомнительное, уверенность значения ниже | GREEN | Пометка `disputed` в vote, штраф ×0,6 в extract.py:164-165; тест сравнивает уверенность одного значения со спорным словом и без него | extract.py::DISPUTED_PENALTY | test_disputed_word_lowers_value_confidence |
| OS-INSP-2.1.7 | Сохраняются движки страницы и характер их расхождения | YELLOW | Ссылка ведёт на объявление поля pydantic, а не на логику; сохраняются только агрегаты (движки, число спорных слов, доля согласия) в pages_json; тест пропускается без tesseract | model.py::agreement | test_scan_parsed_by_ensemble_keeps_extraction |
| OS-INSP-2.1.8 | Наклонный скан: слова строки таблицы собираются с поправкой | GREEN | `words_skew` и группировка с поправкой на наклон (ocr_ensemble.py:364-418); тест на наклоне −0,02 проверяет, что каждая строка «подпись — ед. — значение» собрана целиком | ocr_ensemble.py::def words_skew, ::k = words_skew(words) | test_skewed_table_rows_grouped_label_unit_value и 2 других |
| OS-INSP-2.2.1 | У значения хранятся file_id, SHA-256, стадия, шифр, редакция, статус, страница, bbox | YELLOW | Ссылка и тест покрывают только страницу и bbox (ML Extraction). Остальные 6 атрибутов берутся соединением с `files` и `evidence_fragments` в API, но это не прослежено и не проверено | extract.py::def extract | test_extraction_keeps_page_and_bbox |
| OS-INSP-2.2.2 | bbox в [0;1] видимой области с учётом CropBox и Rotate | YELLOW | Используется `FPDF_PageToDevice` (parse.py:66-83); тест проверяет только /Rotate 90. CropBox нет ни в тестах, ни в синтетике | parse.py::def norm_box | test_bbox_normalized_on_rotated_page |
| OS-INSP-2.2.3 | Значения нет — не выдумывается, параметр без извлечения | GREEN | Если `_find_value` вернул None, строка пропускается (extract.py:148-150); тест проверяет отсутствие извлечения | extract.py::def _find_value | test_missing_value_not_invented |
| OS-INSP-2.2.4 | Поиск 132 параметров в источниках, заданных Матрицей для стадии | GREY | Записи impl нет. Фактически extract ищет каждый параметр во всех документах, без учёта source_pd/source_rd/source_id | — | — |
| OS-INSP-2.2.5 | Значение ячейки связано с наименованием и единицей своей строки | GREY | Записи impl нет. Единица измерения из строки не извлекается и не связывается | — | — |
| OS-INSP-2.2.6 | Шифр с гомоглифами исправляется по реестру с пометкой | RED | `fix_code` вызывается только из оценочного стенда ml/eval/run.py:157 (флаг `.corrected` отбрасывается). В /analyze и API вызова нет: система шифр не исправляет | cipher.py::def fix_code, ::def canon, eval/run.py::fix_code(v, registry) | test_homoglyphs_corrected_to_registry и 3 других |
| OS-INSP-2.2.7 | Вид документа: спецификация, ведомость, ОД, смета, ОЛ, расчёт | GREEN | `classify` по заголовку и шапке ГОСТ 21.110; API отфильтровывает сметы и ОЛ (inspections.ts:410); тесты ML, домена и e2e | doctype.py::def classify, doctype.ts::isDesignSource, inspections.ts::.filter(...) | test_kind_by_title и др., domain-doctype, e2e |
| OS-INSP-2.2.8 | Семантическое сопоставление якоря ниже порога, мера близости сохраняется | YELLOW | ML возвращает `match` и `similarity`, но API их не хранит: в таблице extractions нет таких столбцов (db.ts:29-31, INSERT в inspections.ts:313). Семантика работает только для числовых параметров без шаблона | semantic.py::def semantic_extract, ::class OnnxEmbedder | test_paraphrased_label_found_by_meaning_with_similarity и др. |
| OS-INSP-2.2.9 | Строковый с числовым правилом: главное число и текст; без числа — NOT_COMPARABLE | GREEN | `num_rule` (extract.py:154), `compare_kind` передаётся из API (inspections.ts:298); NOT_COMPARABLE проверяется в domain.test | extract.py::NUMERIC_RULES, ::num_rule =, inspections.ts::compare_kind | test_string_numeric ×2, domain.test ×2 |
| OS-INSP-2.2.10 | Строка — одному из соперников с лучшим и более конкретным якорем | GREEN | `_rivals` и `_claim` (кортеж сходство, длина), пропуск на extract.py:144; тест со «Строительный объем (Подземный)» | extract.py::def _rivals, ::def _claim | test_rival_anchor_does_not_steal_row и 3 других |
| OS-INSP-2.2.11 | Строковое или перечислимое без шаблона — весь хвост после якоря | GREEN | extract.py:94-98 с очисткой `STRIP`; тесты на string, enum и соринку скана | extract.py::if spec.data_type in ("string", "enum"):, ::STRIP = | test_string_value_is_whole_tail и 2 других |
| OS-INSP-2.3.1 | Печати, подписи, штампы ВПР и ВСП находятся с bbox | YELLOW | `detect` находит все виды, но тесты в impl проверяют только печать и отсутствие ложных срабатываний. Тесты подписей и штампов есть, но в трассу не включены | requisites.py::def detect | test_seal_found_with_bbox, test_clean_page_has_no_requisites |
| OS-INSP-2.3.2 | Нет обязательного реквизита у документа ИД — MISSING_EVIDENCE | GREEN | `evaluateRequisites` (обязательна подпись) и `writeRequisites` пишут проверку REQ-файла; тесты на отказ и исключения | domain/requisites.ts::evaluateRequisites, services/requisites.ts::writeRequisites | domain-requisites ×2 |
| OS-INSP-2.3.3 | Рабочий чертёж ИД без штампа ВПР или ВСП — MISSING_EVIDENCE | YELLOW | Логика верна (REQUIRED_DRAWING, isWorkingDrawing) и протестирована; одна code-ссылка ведёт на генератор синтетики `ml/synth/generate.py::def _work_stamp`, а это не реализация | domain/requisites.ts::REQUIRED_DRAWING, ::isWorkingDrawing, synth/generate.py::def _work_stamp | domain-requisites ×2, e2e |
| OS-INSP-2.3.4 | Регистрационный номер извлекается с bbox | YELLOW | ML извлекает номер (`value`) с bbox, но API теряет его: в таблице requisites нет столбца value (db.ts:107-108), `saveRequisites` его не пишет, ответ app.ts:295 его не отдаёт | requisites.py::find_reg_numbers, ::REG_RE, app.ts::requisites: (reqStmt.all | test_reg_number_found_after_label_with_bbox и др., e2e |
| OS-INSP-2.4.1 | Масштаб по размерной линии сохраняется вместе со способом | YELLOW | Масштаб и способ вычисляются заново на каждый GET /measure (app.ts:307-318) и нигде не сохраняются | measure.py::def determine_scale, app.py::def measure, app.ts::/api/v1/files/:id/measure | test_scale_from_two_consistent_dimension_lines_within_1pct и др., e2e |
| OS-INSP-2.4.2 | Расстояние между линиями в мм с bbox обоих концов | GREEN | `distances` возвращает мм, a_bbox и b_bbox; тесты на точность 2 %, bbox и отказ для не противолежащих линий | measure.py::def distances, ::def segments | test_distance_between_walls_in_mm_within_2pct_with_bboxes и др. |
| OS-INSP-2.4.3 | Масштаб не определён или противоречив — не измеряет, NOT_COMPARABLE | GREEN | measure.py:111-115 и `distances` → [] при mm_per_px=None; тесты на противоречие, отсутствие линии и эндпоинт | measure.py::MAX_SCALE_SPREAD, ::"inconsistent" | test_contradicting_dimension_lines_give_not_comparable_and_no_measurements и др. |

## Находки

### RED

**OS-INSP-2.2.6: исправление шифра по реестру не встроено в систему.**
- `ml/inspector_ml/cipher.py::fix_code` написан верно и хорошо протестирован (однозначность, реальное различие, «?»). Но единственный вызов вне тестов — `ml/eval/run.py:157` в `key_fields()` оценочного стенда, и там берётся только `.value`, а флаг `corrected` («помечает исправление») отбрасывается.
- В прод-пути (`ml/inspector_ml/app.py::analyze` и `apps/api/src/services/inspections.ts::parseOne`) шифр с листа не читается и не сверяется с реестром: `document_code` приходит из манифеста.
- Третья code-ссылка `ml/eval/run.py::fix_code(v, registry)` ведёт в код оценки, а не в систему.
- Как проверить: `grep -rn "fix_code" ml/inspector_ml apps/api/src` находит только cipher.py.

### YELLOW

**OS-INSP-2.3.4: номер регистрации теряется в API.**
- ML возвращает `Requisite(kind="reg_number", value=..., bbox=...)` (requisites.py:118-124). В API `saveRequisites` (services/requisites.ts:12-13) пишет только `file_id, page, kind, bbox_json, confidence`; в схеме `requisites` нет столбца value (db.ts:107-108).
- Code-ссылка `app.ts::requisites: (reqStmt.all` сама выбирает `kind, page, bbox_json, confidence`. Инспектор видит «рег. номер найден здесь», но не сам номер. Значение дат теряется так же.
- e2e проверяет только наличие kind `reg_number`.

**OS-INSP-2.2.8: мера близости не сохраняется.**
- `Extraction.match` и `Extraction.similarity` приходят из ML, но INSERT в `inspections.ts:313` и схема `extractions` (db.ts:29-31) их не содержат. Семантическую находку после разбора нельзя отличить от лексической, мера близости теряется.
- Сужение: `semantic_extract` работает только для `data_type == "number"` без regex (semantic.py:148). Строковые и перечислимые параметры по смыслу не ищутся. Тест `test_string_parameter_is_not_matched_by_meaning` это закрепляет, а правило такого ограничения не оговаривает.
- Тесты на реальной модели пропускаются, если модель не скачана.

**OS-INSP-2.2.1: трасса покрывает 2 атрибута из 8.**
- `extract` и тест проверяют только `page` и `bbox`. file_id, SHA-256, стадия, шифр, редакция и статус утверждения попадают в доказательство через `evidence_fragments` (db.ts:46-48) и соединение `extractions` с `files` (inspections.ts:409). Ни одна ссылка и ни один тест impl это не покрывают.

**OS-INSP-2.1.4: тест не проверяет прод-политику.**
- `queue.test.ts` сам передаёт `maxRetries: 2` и `onDead`, поэтому это тест обобщённой очереди. Мутация `maxRetries: 2 → 5` в `inspections.ts:258` или удаление `notify(db, "admin", …)` (строка 262) тест не заметит.
- Тайм-аут задаёт `AbortSignal.timeout(config.mlTimeoutMs)` в ml-client.ts:54; ни одна ссылка impl на него не указывает.

**OS-INSP-2.1.2: порог не проверяется.**
- Тест: страница из линий, `assert quality in ("LOW_QUALITY", "ABSTAIN")`. Без tesseract тест проходит на ABSTAIN. С tesseract строки, скорее всего, пусты, и LOW_QUALITY получается из-за `not lines`, а не из-за сравнения `mean >= LOW_QUALITY_CONF` (parse.py:177). Нужен тест с непустыми строками и средней уверенностью 59 и 61.

**OS-INSP-2.1.7: ссылка на объявление поля, агрегированные данные.**
- Code-ссылка `model.py::agreement` — это поле pydantic. Логика в `vote` и `_ocr_page` (parse.py:187-189), а сохранение идёт через `pages_json` (inspections.ts:319).
- «Как разошлись» сводится к `disputed_words` и `agreement`. Что прочитал каждый движок, не сохраняется.
- Тест помечен `needs_tesseract` и без tesseract пропускается.

**OS-INSP-2.2.2: CropBox не проверен.**
- `FPDF_PageToDevice` должен учитывать CropBox, но ни в тестах, ни в синтетике страниц с CropBox ≠ MediaBox нет (`grep -ri cropbox ml/tests ml/synth` пуст). Проверен только /Rotate 90.

**OS-INSP-2.3.1: в трассе только печати.**
- `detect` находит печати, подписи, штампы, даты и номера. Тесты в impl: `test_seal_found_with_bbox`, `test_clean_page_has_no_requisites`. Подписи и штампы проверяются тестами вне трассы: `test_blue_signature_found`, `test_production_stamp_with_frame`, `test_asbuilt_stamp_split_over_lines_and_ocr_typo`, `test_full_page_all_kinds_via_ocr_ensemble`. Их надо добавить в impl.

**OS-INSP-2.3.3: ссылка на синтетику.**
- `ml/synth/generate.py::def _work_stamp` рисует штамп на тестовом листе и реализацией правила не является. Остальные ссылки и тесты корректны. Ссылку надо убрать или перенести в tests и data.

**OS-INSP-2.4.1: масштаб не сохраняется.**
- `GET /api/v1/files/:id/measure` (app.ts:307-318) каждый раз вызывает ML `/measure`. Тот заново разбирает PDF без кэша (app.py:249) и возвращает масштаб. В БД масштаб и способ не пишутся, поэтому «сохраняет» не выполнено. Определение масштаба и отказы реализованы верно.

### GREY (для полноты)
- **OS-INSP-2.2.4**: impl нет. extract ищет каждый параметр во всех файлах без учёта `source_pd/source_rd/source_id` Матрицы.
- **OS-INSP-2.2.5**: impl нет. Единица измерения из строки таблицы не извлекается и с наименованием не связывается.
