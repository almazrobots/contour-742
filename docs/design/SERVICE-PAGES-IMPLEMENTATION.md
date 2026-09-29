# T-264: самостоятельные сервисные страницы в общей базе знаний

Read-only анализ локальных исходников, 2026-09-29. Этот документ не меняет страницы и не подтверждает их live-состояние. Контекст координатора: активный основной GPU API по health — `c0851cc7`; standalone UI для docs media — `df65`. Эти версии принадлежат разным компонентам; не маркировать ими автоматически все схемы и отчёты.

## Минимальный безопасный подход

Первый проход — общая компактная навигация и метаданные релиза на самостоятельных широких страницах. Использовать собственный namespace `.docs-service-nav`/`.docs-service-meta`, локальные шрифты и явные ссылки `../guide/index.html`, `../index.html`, `../gera/TRACE-MAP.html`. CSS навигации ограничить этим namespace; не подключать глобальный guide.css поверх исходного интерфейса. Сохранить существующие URL, DOM, данные, SVG и scripts.

Полный renderMaterialShell подходит для обычных статей, но не для вставки целого HTML-документа или непроверенного вырезанного body. Его main ограничен 840px, существует собственный `.toc` и document-level Ctrl/Cmd-K; самостоятельные страницы содержат глобальные CSS, собственные landmark и обработчики клавиатуры. Перед полным переносом потребуются извлечение содержимого в генераторе и отдельный широкий режим оболочки с изоляцией стилей/скриптов.

При добавлении верхней навигации корректировать sticky top/scroll-margin и мобильные правила конкретной страницы. Добавить skip link к существующему содержимому; не создавать вложенные main или повторяющиеся ID. Не переименовывать DOM-узлы без одновременного изменения всех CSS/JS-ссылок.

## Pipeline

- Источник: `scripts/pipeline-map.mjs:105`, `renderPipelineMap({today, root})`; HTML-шаблон начинается около строки 131. Выход записывает `scripts/gera-trace.mjs:438` в `docs/gera/PIPELINE.html`.
- Patch points: head/style шаблона, начало body перед существующим header, footer с метаданными. Исправлять генератор, не только сгенерированный HTML. Не запускать общий trace ради одной оболочки: он также переписывает Trace Map и другие артефакты.
- DOM: header с `.h1row` и `.views`; один main; секции `sh`, `ph`, `mh`, `oh` с aria-labelledby. Existing relative ссылки `TRACE-MAP.html?view=...`, `PIPELINE.html`, `ARCHITECTURE.html` должны сохранить смысл.
- CSS: глобальные body/header/main/:root, main max-width 1240px, панели `.summary`, `.m023`, `.status`, `.cols`; мобильные пороги 1000px/560px. Панели алгоритма используют `.body` как класс, это не тег body. Нельзя заменять селекторы простой строковой подстановкой.
- В опубликованном Pipeline нет script: перенос проще, но сохранить смысл шести статусов и шаги процесса/паспорта. Данные шагов читаются из паспортов и каталога операций; EXAMPLE содержит результат конкретного прогона. Изменение оформления не подтверждает актуальность чисел относительно GPU API.
- Второй проход: выделить content/style в generator functions; поместить content без main/header в широкий shell, scope компонентных CSS под `.pipeline-content`; оставить размеры и горизонтальную прокрутку таблиц/схем.

## Architecture

- Источник: `scripts/arch-map.mjs:218`, `renderArchMap({today, root})`; HTML-шаблон около строки 236; запись — `scripts/gera-trace.mjs:437`.
- Patch points: head/style, начало body и изолированная docs-навигация. Script около строки 485 должен оставаться после схемы; не запускать его до создания узлов. Генератор сохраняет встроенные шрифты и данные карточек.
- DOM/script contract: первая `.dia` — SVG viewBox `0 0 1500 720`; `#card`, `#pnote`, `.seg button[data-p]` для gpu/stand/dev; SVG `.n[data-id][data-in]`, `.e[data-f][data-t]`, `.alt`, data-alt-stand/dev. Сохранять tabindex, role=button, aria-label и aria-pressed.
- Script использует глобальные `document.querySelector('.dia')`, `document.querySelectorAll('.seg button')`, getElementById. Общая навигация не должна вводить `.dia`/`.seg` или те же IDs; будущий перенос должен scope selectors к корню architecture.
- Взаимодействия: profile('gpu') при старте; смена профиля меняет gone/off и подписи; click/Enter/Space выбирает узел, подсвечивает связи и открывает карточку; Escape снимает выбор. Кнопки nav и поиск оболочки не должны перехватывать эти действия.
- CSS: main max-width 1440px; `.dia` width 100%, **min-width 1000px**, `.scroll` overflow-x:auto; панели/flow/gaps/two перестраиваются на 1180/900/520px. Сохранять SVG и его доступную область прокрутки; ограничение 840px сделает схему постоянно тесной.
- Текст профиля gpu прямо говорит «цель», включая отсутствующие компоненты. Не переименовывать профиль в «активный GPU» только потому, что health сообщает c0851cc7. Нужна отдельная сверка архитектуры с фактическим развёртыванием.

## Design System

- Источник: `docs/design/DESIGN-SYSTEM.html`; отдельный генератор в просмотренных scripts не найден. В demo-docs копируется в `design/design-system.html`; patch point — этот исходный HTML, а не output.
- DOM: header.top, `.shell`, nav.toc с 19 anchor-ссылками, main.frame#top и прямые дочерние section с ID summary/principles/decisions/color/contrast/type/geometry/frames/components/statuses/motion/experience/keys/voice/a11y/build/debt/never/method. Сохранять IDs, ссылки и связь section с оглавлением.
- JS: локальный `../assets/mermaid.min.js`, mermaid.initialize(strict); IntersectionObserver наблюдает **main > section**, глобально собирает `.toc a`, ставит класс on и scrollIntoView на mobile <=900px. Вставка дополнительного article вокруг section или второго `.toc` ломает этот контракт; перенос требует изменения selectors вместе с DOM.
- CSS: глобальные токены и элементные правила, `.shell` 232px+контент, sticky `.toc` top60px; на mobile `.toc` превращается в горизонтальную sticky строку. Существуют компонентные демонстрации, чьи локальные цвета/геометрия являются содержанием документа, а не оформительской ошибкой.
- Первый проход: единая nav в header.top и metadata без новой `.toc`; сохранить текущие примеры и observer. Второй: разнести component-demo и article CSS по namespace, обновить observer на `.design-system-content > section`, сохранить примеры и Mermaid. Действующие токены документа сверять содержательно, не менять слепо глобальный :root.

## BI dashboard

- Источник: `docs/bi/dashboard.html`; отдельный generator не найден. Детерминированный генератор вымышленных данных и SVG встроен в script. demo-docs копирует файл в `bi/dashboard.html`.
- DOM: `.shell` (72px rail + frame), nav.rail, header.topbar, `#crumbs`, `#period`, `#ruler`, main.page#view; `#scrim`, `#pq`, `#pl`, `#tip` вне основного frame. JS перерисовывает view/crumbs/pt; не помещать docs-навигацию внутрь этих узлов — её сотрёт render().
- Script contracts: hash-маршруты #portfolio/#object-<id>, hashchange/render/history.replaceState; периоды; фильтры/сортировка/сворачивание групп таблицы; click/Enter на объект; popovers `.more`, tooltip и SVG hover; resize пересчитывает графики. Сохранить generated IDs SVG/pattern и измерение clientWidth.
- Клавиатура: Ctrl/Cmd-K и Slash открывают палитру; ArrowUp/Down/Enter/Escape/Tab работают в ней; G затем P/O меняет вид; J/K переключают объект. **Не подключать hotkeys/поиск shell** параллельно — Ctrl/Cmd-K уже принадлежит BI.
- CSS: globals/:root, `.shell`, `.frame`, main/page и table; `.pt` min-width1040px, chart/legend/tooltip geometry. `.scrim` fixed z40, `.tip` fixed z60; не добавлять transform/contain/overflow на их ancestors. При изменении доступной ширины запускать существующий redrawCharts.
- Первый проход: компактная бренд-навигация вне dynamic view, безопасный metadata-блок и явная постоянная маркировка «макет, данные вымышленные»; сохранить rail и всю рабочую область. Обычная article sidebar/TOC здесь не нужны.
- CSP/проверки: шрифты только ../assets/fonts, нет внешних src/href/url; существующий `scripts/deploy.test.mjs:893` проверяет самодостаточность, конкретный --ground:#D9DDE3, маркировку данных и отсутствие corpus. Смена токена требует осмысленного обновления проверки; обход теста не является приёмкой дизайна.

## Интеграция и проверки

1. Короткий общий nav helper для самостоятельных страниц, namespace CSS и доказанные metadata; применить в Pipeline/Architecture generators и исходных DS/BI. demo-docs оставляет копирование полного HTML. Не применять DOM rewrite ко всем HTML автоматически.
2. Для Pipeline/Architecture вызывать только соответствующий renderer при контролируемой сборке, без общего gera-trace, чтобы не перезаписать чужие live-обновления Trace Map. Существующий Trace Map сохраняется самостоятельным wide экраном, его DOM/data/scripts не переносятся.
3. Проверить header offsets, отсутствие CSS коллизий/duplicate IDs, существующие anchor/query/hash маршруты, desktop/mobile и клавиатуру. Architecture — все три профиля/выбор/связи/карточки; DS — observer и Mermaid; BI — оба вида/периоды/палитра/таблица/tooltip/resize.
4. Проверку дизайна и интерактивности проводить на конкретном артефакте, отдельно от API health. c0851cc7 — основной GPU API; df65 — source standalone media UI; docs/site revision — отдельная запись. Если соответствие схемы/кадров этой среде не проверено, status остаётся unknown/draft.

Приоритет для скорости: общий nav на четырёх страницах → Pipeline content → Architecture wide → DS с изоляцией демонстраций. BI сохраняет самостоятельную рабочую геометрию и получает общий бренд/метаданные; полный article shell ему не нужен.
