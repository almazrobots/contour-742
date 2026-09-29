# Аудит БФ-1 (OS-INSP-1.*) — worktree building-tech-audit @ 7e1f886

Проверено: 29 правил, у всех 29 есть impl. Все code-ref найдены как подстроки. Test-ref: у 3 ссылок нет точного совпадения
названия теста, они — префиксы реального названия (1.2.5, 1.3.3 (e2e), 1.4.2). `pnpm trace` проверяет только
подстроку, поэтому пропускает их. На вердикт это не влияет, отмечено в причине.
Две находки подтверждены прогоном чистых функций через `node --experimental-strip-types`: 1.3.1 и 1.4.3 (тесты не запускались).

| Код | Правило (кратко, ≤ 12 слов) | Вердикт | Причина | Код-ссылка | Тест |
|---|---|---|---|---|---|
| OS-INSP-1.1.1 | Стабильный object_id, не меняется при переименовании | RED | Переименования нет: `createInspection` при существующем object_id молча сохраняет старое имя (inspections.ts:107-113). Тест OBJ-SEV-2 проверяет сценарий и answer-key, а не object_id | inspections.ts::createInspection | e2e::OBJ-SEV-2 (про другое) |
| OS-INSP-1.1.2 | Заведён объект — проверка в статусе PENDING | YELLOW | Код верен (inspections.ts:115), но ни один тест не проверяет PENDING после создания: e2e ждёт READY | inspections.ts::"PENDING", ctx.user.id | e2e::OBJ-SEV-2 (косвенно) |
| OS-INSP-1.2.1 | Только PDF/DOCX/XML, иначе отказ с перечнем | YELLOW | Код принимает 7 форматов (upload.ts:9, по 1.2.9), текст правила не обновлён; в тесте «неподдерживаемый» — усечённый PNG | upload.ts::UNSUPPORTED_FORMAT | domain::отклоняет неподдерживаемый формат…; e2e::ошибки загрузки… |
| OS-INSP-1.2.2 | Файл > 50 МБ — отказ с пределом | GREEN | checkFile (upload.ts:37-43), тест проверяет код и «50 МБ». Ссылка ведёт на константу, а не на checkFile | upload.ts::MAX_FILE_BYTES | domain::отклоняет файл больше 50 МБ… |
| OS-INSP-1.2.3 | Пакет > 200 МБ — отказ целиком с пределом | GREEN | ingest бросает 413 до приёма любого файла (inspections.ts:143-144), тест проверяет границу и текст | upload.ts::checkPackage | domain::отклоняет пакет больше 200 МБ целиком |
| OS-INSP-1.2.4 | Повреждённый PDF — отказ, «загрузите повторно» | YELLOW | «Повреждён» определяется только по отсутствию `%%EOF` в последних 2 КБ (upload.ts:47). PDF с битым телом или xref принимается и падает уже в ML | upload.ts::CORRUPTED | domain::отклоняет повреждённый PDF…; e2e::ошибки загрузки… |
| OS-INSP-1.2.5 | SHA-256 каждого файла, без перезаписи file_id | GREEN | inspections.ts:162-170: FILE_ID_EXISTS/DUPLICATE, тест проверяет оба случая и HASH_MISMATCH. Ссылка на тест — префикс названия | inspections.ts::FILE_ID_EXISTS | e2e::файл под занятым file_id не перезаписывается (префикс) |
| OS-INSP-1.2.6 | Пакет без реестра — принят, CLARIFICATION_REQUIRED | YELLOW | Ссылка ведёт на строку сообщения (inspections.ts:202); логика в selectRevisions(!hasManifest)→UNRESOLVED. Статус проверки CLARIFICATION_REQUIRED не ставится, он есть только в тексте ответа | inspections.ts::"Пакет принят без реестра файлов" | e2e::ошибки загрузки… |
| OS-INSP-1.2.7 | До финализации — дозагрузка без перезагрузки принятого | YELLOW | Во время PARSING дозагрузка отклоняется с 409 (lifecycle.ts:6), хотя протокол не финализирован. Основной путь проверен e2e | lifecycle.ts::canUpload | domain::после финализации…; e2e::OBJ-POL-115… |
| OS-INSP-1.2.8 | Финализирован — отказ дозагрузки, предложить новую проверку | GREEN | inspections.ts:140-141: 409 и «Создайте новую проверку», e2e проверяет 409 и текст | inspections.ts::"Создайте новую проверку" | e2e::финализация: … дозагрузка запрещена… |
| OS-INSP-1.2.9 | XLSX, JPG, PNG, TIF принимаются как документы | GREEN | sniff по сигнатуре (upload.ts:18-34), parse_xlsx в ML, тесты на каждую сигнатуру | upload.ts::sniff; formats.py::parse_xlsx | domain-formats::sniff: XLSX…; test_parse_xlsx… |
| OS-INSP-1.2.10 | Документ > 50 МБ частями, собрать в один | YELLOW | Ссылка и тест покрывают только наследование роли частями; сборку (сквозные страницы, счёт как одного документа) проверяет e2e OBJ-SKL-5, но в impl его нет | revisions.ts::partRepresentatives | domain-formats::части одного документа не дают CONFLICT… |
| OS-INSP-1.2.11 | .sig/.p7s рядом: проверить, записать VALID/INVALID/UNVERIFIED | GREEN | ingest отделяет подписи (inspections.ts:155), attachSignatures пишет signature_check_json и аудит; тест маршрута проверяет всё | domain/signature.ts::pairSignature; services/signature.ts::attachSignatures; inspections.ts::const sigs = … | signature-route (3), domain-signature, signature |
| OS-INSP-1.2.12 | Математика, срок в момент подписания, цепочка → VALID УКЭП/УНЭП | YELLOW | Реализовано и сильно покрыто, но «момент подписания» берётся из signingTime, который подписант указывает сам (services/signature.ts:227,230), без штампа времени. Отзыв сертификата (CRL/OCSP) не проверяется | domain::signatureVerdict; services::checkDetached, chainToAnchor | signature.test (8), domain-signature (1) |
| OS-INSP-1.2.13 | ГОСТ без СКЗИ — UNVERIFIED, не действительна | GREEN | signatureVerdict:98-99 ставит ГОСТ раньше математики, signatureFacts:229-235 не считает математику и цепочку; тесты по OID и маршруту | domain/signature.ts::isGostOid | signature.test (2), domain-signature (1) |
| OS-INSP-1.2.14 | INVALID/UNVERIFIED — не подписан, реквизиты как у скана | YELLOW | Правило в evaluateRequisites верно (requisites.ts:67), но подпись, дозагруженная отдельно, не пересчитывает протокол: app.ts:186 и rin-pull.ts:194 зовут startProcessing только при accepted>0. Тест вызывает writeRequisites вручную | domain::electronicallySigned; requisites.ts::electronicallySigned(…) | signature-route::реестр заявляет УКЭП…; domain-signature::… |
| OS-INSP-1.2.15 | Новый пакет в «РиН» забирается без ручной загрузки | GREEN | setInterval(pollRin) в server.ts:21 (gpu: on), приём через ingest, тест проверяет актор system:rin, реестр, файлы и очередь | rin-pull.ts::pollRin; domain::planPackage; rin-tls.ts::rinGetTransport | rin-pull (1), domain-rin-pull (1), rin-pull-mtls (2) |
| OS-INSP-1.2.16 | Пакет забирается один раз, без дублей | GREEN | pickNew + завершённые статусы в rin_packages + DUPLICATE как безвредный код; тест проверяет отсутствие новых файлов, проверок и скачиваний | domain::pickNew | rin-pull (2), domain-rin-pull (1) |
| OS-INSP-1.2.17 | Протокол финализирован — не дозагружать, уведомить инспектора | GREEN | planPackage→NOTIFY_ONLY до скачивания, notify inspector (rin-pull.ts:221-224); тест проверяет отсутствие файлов и скачиваний и одно уведомление | domain::if (latest.status === "FINALIZED")…; rin-pull.ts::audit(…RIN_PACKAGE_NOTIFIED | rin-pull (1), domain-rin-pull (1) |
| OS-INSP-1.2.18 | «РиН» недоступна — не отмечать, повторить в цикле | YELLOW | Поведение верно и сильно протестировано, но вторая code-ref — комментарий (rin-pull.ts:81), а не логика; настоящая логика — rin-pull.ts:77-84,145,148 | domain::advanceCursor; rin-pull.ts::// OS-INSP-1.2.18: … (комментарий) | rin-pull (2), domain-rin-pull (1) |
| OS-INSP-1.2.19 | Отказ приёма — пакет REJECTED с причиной, админу | GREEN | packageOutcome + savepoint (всё или ничего) + notify admin; 8 тестов на каждую причину отказа | domain::packageOutcome; rin-pull.ts::audit(…REJECTED; savepoint | rin-pull (7), domain-rin-pull (1) |
| OS-INSP-1.3.1 | Эталон — последняя применимая APPROVED/FOR_CONSTRUCTION | RED | revisions.ts:61: редакция считается заменённой по predecessor_id без учёта статуса преемника. APPROVED A + DRAFT B(pred=A) → A SUPERSEDED, B UNRESOLVED, эталона нет (подтверждено прогоном) | revisions.ts::selectRevisions | domain::выбирает эталоном последнюю утверждённую редакцию |
| OS-INSP-1.3.2 | SUPERSEDED/CANCELLED вне эталона, сохраняются | GREEN | revisions.ts:59-60, файлы остаются в files с ролью SUPERSEDED; тест точный. Ссылка — строковый литерал с 4 вхождениями | revisions.ts::SUPERSEDED | domain::исключает SUPERSEDED и CANCELLED… |
| OS-INSP-1.3.3 | Несколько кандидатов или нет утверждения → CLARIFICATION_REQUIRED | GREEN | CONFLICT/UNRESOLVED (revisions.ts:63-73) → compare.ts:93-97 CLARIFICATION_REQUIRED; unit и e2e. Ссылка на e2e — префикс названия | revisions.ts::CONFLICT | domain::помечает конфликт…; e2e::OBJ-SCH-8… (префикс) |
| OS-INSP-1.4.1 | Статус стадии UPLOADED/PARTIAL/MISSING (PD_*, RD_*, ID_*) | GREEN | loadCodes/stageLoad, тест на все три кода | completeness.ts::loadCodes | domain::присваивает стадии UPLOADED, PARTIAL или MISSING |
| OS-INSP-1.4.2 | Сценарий FULL…PARTIALLY_LOADED | GREEN | Все 6 сценариев в it.each (плюс NO_DOCUMENTS сверх правила). Ссылка — префикс шаблона «… %#» | completeness.ts::scenario | domain::определяет сценарий проверки (префикс) |
| OS-INSP-1.4.3 | PARTIAL, если реестр объявляет больше, чем загружено | YELLOW | documentCounts (completeness.ts:36-41) добавляет файлы вне реестра к uploaded и маскирует недостающие: объявлены A,B; загружены A и C вне реестра → PD_UPLOADED (подтверждено прогоном). Тест проверяет только stageLoad | completeness.ts::stageLoad | domain::считает стадию PARTIAL… |
| OS-INSP-1.4.4 | Скрытые работы без АОСР → MISSING_EVIDENCE по каждой | GREEN | evaluateHiddenWorks: по каждой позиции NEGATIVE_VERIFIED со ссылкой или MISSING_EVIDENCE HW-n; тест точный | hidden-works.ts::evaluateHiddenWorks | domain-hidden-works::позиция с актом… |
| OS-INSP-1.5.1 | Хранить изменение: номер, дата, параметры, основание | YELLOW | Ссылка ведёт только на zod-схему ввода, хранение в services/changes.ts::addChange в impl нет; документ-основание необязателен (changes.ts:9), а по правилу обязателен; тест проверяет только валидацию | changes.ts::ApprovedChangeInput | domain-changes::ввод: номер, дата… |

**Итого:** GREEN 16 · YELLOW 11 · RED 2 · GREY 0.

## Находки

### RED

**OS-INSP-1.3.1: черновик следующей редакции снимает эталон.**
`apps/api/src/domain/revisions.ts:56,61`: `replaced` собирается из predecessor_id всех файлов группы, какой бы статус ни был у
преемника. Утверждённая ред. A, у которой в пакете есть DRAFT ред. B с `predecessor_id = A`, получает SUPERSEDED
«заменён следующей редакцией». B получает UNRESOLVED, CURRENT в группе нет. В итоге все параметры документа уходят в
CLARIFICATION_REQUIRED (compare.ts:93), хотя применимая утверждённая редакция есть. То же будет с преемником в статусе
CANCELLED: аннулированная редакция «заменяет» действующую.
Проверка: `selectRevisions([A:APPROVED, B:DRAFT pred=A], true)` → `A: SUPERSEDED, B: UNRESOLVED` (воспроизведено).
Исправление: считать заменённым только того, чей преемник сам в EFFECTIVE или SUPERSEDED по цепочке. Нужен тест «DRAFT-преемник не снимает эталон».

**OS-INSP-1.1.1: правило не проверено, переименования нет.**
object_id задаёт клиент, `createInspection` (inspections.ts:107-113) для существующего объекта ничего не обновляет. Эндпоинта
или функции переименования нет (`grep "update objects"` пусто). Новая карточка с тем же object_id и другим названием молча
теряет новое имя. Единственный тест в impl (e2e OBJ-SEV-2) проверяет сценарий и answer-key. Утверждение «не меняется при
переименовании» нигде не проверяется: ни ассертом, ни мутационно.

### YELLOW

- **OS-INSP-1.2.12: время подписания и отзыв.** Срок действия сертификата сверяется с `signingTime` из подписанных атрибутов
  (services/signature.ts:227, 230; domain/signature.ts:104), а это время указывает сам подписант. Владелец истёкшего или
  скомпрометированного ключа может поставить дату задним числом и получить VALID УКЭП. Тест «через 25 лет после истечения
  корней подпись 2026 года — VALID» закрепляет именно это поведение. Штамп времени (CAdES-T) не используется. CRL/OCSP не
  проверяются, так что отозванный сертификат «действовал». Для УКЭП по 63-ФЗ это значимо. Нужен как минимум
  явный GAP в модели.
- **OS-INSP-1.2.14: протокол не пересчитывается после дозагрузки подписи.** Если .sig/.p7s пришёл отдельной дозагрузкой (маршрут или «РиН»),
  `accepted` пуст, и `startProcessing` не вызывается (app.ts:186, rin-pull.ts:194). signature_check_json обновлён, а REQ-* в протоколе
  нет, пока кто-то вручную не вызовет /start. Документ с INVALID-подписью при заявленной в реестре УКЭП остаётся «подписанным».
  Тест обходит это, вызывая `writeRequisites` вручную.
- **OS-INSP-1.4.3: файлы вне реестра маскируют недостающие.** completeness.ts:36-41: файлы вне реестра прибавляются к `uploaded` той же
  стадии. Объявлены A, B, загружены A и C вне реестра: declared=2, uploaded=2 → PD_UPLOADED, сценарий может стать FULL при
  недостающем B (воспроизведено). Тест проверяет только `stageLoad` на готовых числах.
- **OS-INSP-1.2.4: слабое определение повреждения.** Повреждение определяется только по отсутствию `%%EOF` в хвосте (upload.ts:47). PDF с битым телом или
  xref, но с `%%EOF`, принимается, а позже получает parse FAILED (inspections.ts:302-305) без отказа и без «загрузите повторно»
  для пользователя.
- **OS-INSP-1.2.7: дозагрузка в PARSING.** `canUpload` (lifecycle.ts:6) отказывает во время PARSING (409 «Дозагрузка невозможна в статусе
  PARSING»), хотя по правилу до финализации дозагрузка принимается. Нужно либо уточнить правило (исключение для PARSING),
  либо ставить дозагрузку в очередь.
- **OS-INSP-1.2.1: текст правила устарел.** Правило говорит «только PDF, DOCX и XML», а код по GAP-INSP-04 принимает ещё XLSX, JPG, PNG и TIF
  (upload.ts:9). Правило нужно переписать под 1.2.9. В тесте «неподдерживаемый формат» — усечённый PNG (формат из
  поддерживаемых). Лучше взять GIF/BMP, как в domain-formats.
- **OS-INSP-1.2.6: ссылка на строку сообщения.** code-ref — строка сообщения (inspections.ts:202). Решение принимает `selectRevisions(..., false)`
  (revisions.ts:45-47). Статус CLARIFICATION_REQUIRED у пакета или проверки не ставится: он есть только в тексте поля
  `clarification` и появляется у проверок через роль UNRESOLVED. Ссылку стоит перевести на логику.
- **OS-INSP-1.2.10: сборка частей не в impl.** impl подтверждает только наследование роли частями. «Собирает в один» (сквозная нумерация
  pageOffsets/assignPageOffsets, счёт как одного документа в documentCounts) проверяет e2e «OBJ-SKL-5…», но ни он, ни
  pageOffsets в impl не указаны.
- **OS-INSP-1.2.18: вторая ссылка — комментарий.** Вторая code-ref — комментарий `// OS-INSP-1.2.18: …` (rin-pull.ts:81). Поведение реализовано и
  хорошо протестировано. Ссылку нужно заменить на логику: rin-pull.ts:145/148 (PENDING при сбое скачивания) или `settle(... PENDING ...)`.
- **OS-INSP-1.1.2: PENDING нигде не проверяется.** Ни один тест не проверяет статус PENDING сразу после создания. Мутация "PENDING"→"READY" в
  inspections.ts:115, скорее всего, выживет (e2e ждёт READY).
- **OS-INSP-1.5.1: хранение и основание.** impl указывает на zod-схему ввода, а не на хранение (services/changes.ts:31-44 addChange).
  `basis_file_id` необязателен (domain/changes.ts:9), тест прямо утверждает «основание — нет», а в правиле документ-основание
  входит в состав хранимого. Нужно либо поправить правило («при наличии»), либо сделать поле обязательным. Хранение
  проверяет e2e «согласованное изменение: реестр с аудитом…», но его нет в impl.

### Мелкое (на вердикт не влияет)
- Ссылки на тесты — префиксы, а не точные названия: 1.2.5 (e2e «файл под занятым file_id не перезаписывается; …»), 1.3.3
  (e2e «OBJ-SCH-8: … → CLARIFICATION_REQUIRED …»), 1.4.2 («определяет сценарий проверки %#»). gera-trace.mjs:68 проверяет
  `includes`, поэтому это не ловит.
- 1.2.11: пара ищется только по «Документ.pdf.sig». «Документ.sig» (расширение документа заменено) отклоняется
  SIGNATURE_WITHOUT_DOCUMENT. Формулировка правила допускает оба прочтения.
