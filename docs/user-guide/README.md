# База знаний Надзориума — T-254

Образец: `/Users/almazsalimzyanov/code/BankImpulse`, `content/docs`, компоненты
Screenshot, Steps, Callout и DocsLayout. Перенесены организация по задачам и ролям,
подача короткими шагами, предупреждения, таблицы, связанные статьи и подписи к изображениям.
Fumadocs/Next.js не требуются: публикация статическая, в существующем разделе `/docs`.

Источники поведения:

- `apps/web/src/main.tsx`, страницы Login, NewInspection, Inspection, Verify, Matrix, Normative, Ml.
- `apps/api/src/domain/access.ts`: роли и права основной платформы.
- `feat/verification-module` b32a6600: DataVerification, витрина и оригиналы XLSX/Word/XML.
- Изображения: только вход и справочник CPU-кандидата, без документов корпуса; provenance.json.

Явный allowlist: `navigation.json`; README не публикуется.
На CPU основные операции только для просмотра; модуль разметки описан для рабочего GPU-стенда.
Инференс, обучение, ответы верификатора и GOLD различаются в пользовательском тексте.

Сборка и браузерная проверка:

```sh
scripts/remote-run.sh --light --get out/user-guide --get out/guide-audit \
  'node scripts/user-guide.mjs out/user-guide && node scripts/check-user-guide.mjs out/user-guide'
```

Публикация готового результата (статические файлы CPU, без смены контейнеров и данных):

```sh
scripts/remote-run.sh --publish-user-guide out/user-guide
```

Публикация добавляет ссылки в существующие index/Trace Map, сохраняет publication.json.
Предыдущие файлы сохраняются вне публичного каталога в `var/guide-history`; ошибка возвращает старые страницы.
Полная штатная сборка demo-docs также включает руководство. Поиск локальный, без отправки запроса на сервер.
