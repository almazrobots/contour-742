// Пайплайн «Инспектора ИИ» — docs/gera/PIPELINE.html, кнопка «Пайплайн» на карте трассы (pnpm trace). T-129.
// Что происходит с пакетом после загрузки (бизнес-процесс автоматической обработки) и как система определяет параметр —
// на примере М-023 «Класс конструктивной пожарной опасности» и реального пакета «Алтуфьевское 79Б».
// Шаги алгоритма — не пересказ: читаются из паспортов data/seed/passports (_common.json + M-023.json) тем же слиянием,
// что делает API для экрана паспорта (apps/api/src/domain/passport.ts: mergeStages); названия операций — из каталога
// TO-BE (data/seed/catalog-ops.json). Числа — исторический Mac-стенд T-129, docs/qa/M023-ALTUFYEVO-EVAL.md; GPU runtime описан отдельно.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serviceNavCss, renderServiceNav, renderServiceMetadata } from "./docs-service-nav.mjs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ─────────────────────────────── бизнес-процесс после загрузки (порядок — сам процесс)
const STATUS_FLOW = [
  ["PENDING", "Принята", "пакет загружен, разбор не начат"],
  ["PARSING", "Разбор", "файлы в очереди и в ML"],
  ["READY", "Сводка готова", "сравнение сделано, ждёт инспектора"],
  ["VERIFYING", "Верификация", "инспектор решает по кандидатам"],
  ["COMPLETED", "Проверено", "все кандидаты решены"],
  ["FINALIZED", "Протокол финализирован", "версия зафиксирована; статус передачи проверяется отдельно"],
];

const PROCESS = [
  {
    who: "Инспектор · API", title: "Загрузка пакета", status: "PENDING",
    what: "Архив, папка или файлы уходят в API частями до 200 МБ. Формат определяется по содержимому, пути архива проверяются, архив не распаковывается на диск. Для каждого файла — SHA-256; дубликат по хешу не принимается; антивирус зависит от профиля и в GPU-стенде T-185 выключен. Реестр берётся из пакета или выводится из папок и имён; выведенный реестр подтверждает оператор.",
    fail: "файл отклонён с причиной (формат, размер, повреждение), остальные принимаются",
    ex: "78 записей архива → 59 уникальных, 19 дубликатов; 2 повреждённых PDF раздела ООС отклонены; принято 57",
  },
  {
    who: "API · файловое хранилище", title: "Хранение", status: "PENDING",
    what: "В GPU-стенде T-185 API хранит исходный файл в /opt/stand-gpu/blobs на локальном хосте; ML получает каталог только для чтения. В прежнем Mac-стенде файлы шифровались AES-256-GCM и сохранялись в Object Storage; read-only демо читает опубликованные блобы из бакета. Ключ объекта — SHA-256 содержимого.",
    fail: "хранилище недоступно — загрузка отклоняется с кодом 503, ничего не записано наполовину",
    ex: "Исторический Mac-прогон T-129: 802 МБ за 40 секунд; 57 объектов в бакете — шифротекст",
  },
  {
    who: "API · RabbitMQ", title: "Запуск разбора", status: "PARSING",
    what: "По кнопке или сразу после загрузки: на каждый файл — задание в очередь. Файлы, разобранные прежней версией ML, тоже ставятся в очередь.",
    fail: "разбор уже идёт — повторный запуск отклоняется",
    ex: "57 заданий",
  },
  {
    who: "RabbitMQ · ML", title: "Разбор файла", status: "PARSING",
    what: "Задание берёт ровно один исполнитель. Рабочий ML-контур использует GPU: PP-OCR через ONNX Runtime CUDA, читателя PaddleOCR-VL и судью Qwen через vLLM. ML определяет вид файла, читает текстовый слой PDF или скан, распознаёт вид документа и извлекает параметры Матрицы; для М-023 — по паспорту.",
    fail: "ML недоступен — ожидание его готовности и повтор до двух раз, затем FAILED и уведомление администратора; после отключения питания разбор продолжается с места остановки",
    ex: "57 из 57 за 25 минут без сбоев и повторов; 4 286 страниц, из них 551 скан",
  },
  {
    who: "API", title: "Пересчёт проверки", status: "READY",
    what: "После последнего файла: актуальные редакции, комплектность, затем сравнение каждого параметра по его правилу. Каждый параметр получает статус и доказательную группу; противоречия внутри стадии — отдельными гипотезами. Выпускается версия сводки сверки.",
    fail: "редакция не определена — «нужно уточнение»; нет источника — «не представлено», не нарушение",
    ex: "М-023 — «расхождения нет»; гипотеза о противоречии внутри ПД",
  },
  {
    who: "Инспектор · Веб", title: "Верификация", status: "VERIFYING",
    what: "Кандидаты по очереди: лист PDF с рамкой вокруг значения, цитата, основание. Решение — признать, снять с причиной или уточнить. Гипотезу можно перевести в кандидаты.",
    fail: "последнее решение возвращается клавишей Z; финализация — с окном отмены 10 секунд",
    ex: "гипотеза М-023 → кандидат с листом КР стр. 6 → «Уточнить»",
  },
  {
    who: "Инспектор · API", title: "Финализация", status: "FINALIZED",
    what: "Версия протокола фиксируется. Подпись и успешная передача в ИАИС «РиН» требуют отдельного подтверждения; отмена финализации — отдельное действие с причиной.",
    fail: "передача в «РиН» не прошла — повтор по расписанию и вручную из карточки",
    ex: "в демо-прогоне не финализировали",
  },
  {
    who: "ML-инженер · API", title: "Выход и проверка", status: "FINALIZED",
    what: "Протокол в JSON, XML, PDF, DOCX. Автоверификация независимым пересчётом: другой читатель текста и свой выбор источника, общее с системой — только паспорт; вердикт считает сервер. Выходной набор с описью SHA-256.",
    fail: "расхождение — набор помечается «не проверено» с названием поля",
    ex: "оракул совпал по 6 полям из 6; набор из 11 файлов с описью",
  },
];

// ─────────────────────────────── М-023 на «Алтуфьево»: что дал каждый шаг паспорта
const EXAMPLE = {
  ING: "78 записей → 57 принятых файлов; 2 повреждённых PDF отклонены с причиной.",
  IDN: "Стадия — по папке пакета, шифр и раздел — по имени файла. Реестр выведен и подтверждён оператором; без подтверждения редакции не определены, и итог — «нужно уточнение».",
  PRM: "4 286 страниц: 3 735 с текстовым слоем, 551 скан через OCR. Переносы слов (маркер U+FFFE pdfium) склеиваются — без этого оборот терялся на 22 % страниц.",
  ENT: "24 упоминания класса в 14 документах. Ловушки отсеяны: ПБ 2024, стр. 12 — «класс … зданий – С1. Расстояние – 8 м» (соседнее здание, ×2); таблица 6.2 СП 118 — не класс здания.",
  NRM: "OCR скана ОПЗ прочитал «Со» → С0. ПБ «не ниже С0» — ограничение, а не точка.",
  LNK: "РД — комплект П-2025-04-266, ПД берётся того же шифра; комплект 2024 — справочно. ПЗ класса не содержит → ПБ, стр. 7: «не ниже С0». РД: АР2, стр. 3: «С0».",
  GTE: "Параметр применим, ПД и РД есть, редакции актуальны (реестр подтверждён), ИД для сравнения не нужна.",
  CMP: "Ранг РД С0 не ниже ограничения С0 → «расхождения нет». Внутри ПД: КР «С1» (стр. 6, 20, 27, 28) и ПОС «С1» (стр. 13) ниже ПБ «не ниже С0» → гипотеза о противоречии.",
  VER: "У результата есть фрагменты ПД и РД с файлом, страницей и рамкой. Судья VLM Qwen3.5-9B по кропам: 24 из 24, обе ловушки признал соседним зданием.",
  DEC: "Доказательная группа: 12 операций каталога и все 24 упоминания с причиной учёта или отсева. Оракул пересчитал независимо — совпадение 6/6.",
  HIL: "Инспектор перевёл гипотезу в кандидаты (опорный лист — КР, стр. 6) и выбрал «Уточнить»: противоречие закрывает проектировщик.",
};

function stages(root) {
  const dir = join(root, "data/seed/passports");
  const common = JSON.parse(readFileSync(join(dir, "_common.json"), "utf8"));
  const pp = JSON.parse(readFileSync(join(dir, "M-023.json"), "utf8"));
  const catFile = join(root, "data/seed/catalog-ops.json");
  const cat = existsSync(catFile) ? JSON.parse(readFileSync(catFile, "utf8")).ops : {};
  // то же слияние, что mergeStages в apps/api/src/domain/passport.ts: свой шаг паспорта перекрывает общий
  const list = common.stages.map((s) => {
    const own = s.param ? pp.steps?.[s.key] : undefined;
    const ids = own ? [...new Set([...own.ops, ...s.ops])] : s.ops;
    for (const id of ids) if (!cat[id]) throw new Error(`pipeline-map: операции ${id} нет в каталоге TO-BE`);
    return { ...s, ops: ids.map((id) => ({ id, title: cat[id].title })), how: own?.how ?? s.how, fail: own?.fail ?? s.fail, own: Boolean(own) };
  });
  for (const s of list) if (!EXAMPLE[s.key]) throw new Error(`pipeline-map: нет примера «Алтуфьево» для шага ${s.key}`);
  return { list, pp, statuses: common.statuses };
}

export function renderPipelineMap({ today, root }) {
  const fonts = ["onest-var", "golos-text-var", "jetbrains-mono-var"].map((f) => {
    const p = join(root, "apps/web/public/fonts", `${f}.woff2`);
    return existsSync(p) ? readFileSync(p).toString("base64") : "";
  });
  const { list, pp, statuses } = stages(root);
  const RU = { PENDING: "Принята", PARSING: "Разбор", READY: "Сводка готова", VERIFYING: "Верификация", COMPLETED: "Проверено", FINALIZED: "Протокол финализирован" };

  const statusBar = STATUS_FLOW.map(([code, ru, note]) => `<li><b>${esc(ru)}</b><span class="mono">${code}</span><p>${esc(note)}</p></li>`).join("");
  const process = PROCESS.map((s, i) => `<li class="step">
    <div class="rail"><span class="num">${i + 1}</span></div>
    <div class="body">
      <div class="top"><h3>${esc(s.title)}</h3><span class="who">${esc(s.who)}</span><span class="pill st">${esc(RU[s.status])}</span></div>
      <p>${esc(s.what)}</p>
      <div class="kv"><span class="k fail">при сбое</span><span>${esc(s.fail)}</span><span class="k ex">«Алтуфьево»</span><span>${esc(s.ex)}</span></div>
    </div></li>`).join("");
  const algo = list.map((s) => `<li class="stage${s.own ? " own" : ""}">
    <div class="sh"><span class="n mono">${esc(s.n)}</span><h3>${esc(s.title)}</h3>${s.own ? '<span class="pill own">особое для М-023</span>' : '<span class="pill gen">общее для всех параметров</span>'}</div>
    <div class="cols">
      <div><div class="lab">Как</div><p>${esc(s.how)}</p>${s.fail && s.fail !== "—" ? `<div class="lab">Если не получилось</div><p class="fail">${esc(s.fail)}</p>` : ""}
        ${s.ops.length ? `<div class="ops">${s.ops.map((o) => `<span title="${esc(o.title)}"><b class="mono">${esc(o.id)}</b> ${esc(o.title)}</span>`).join("")}</div>` : ""}</div>
      <div class="exc"><div class="lab">На «Алтуфьевском 79Б»</div><p>${esc(EXAMPLE[s.key])}</p></div>
    </div></li>`).join("");
  const scale = pp.value.scale.map((v, i) => `<span class="sc${i === pp.value.scale.length - 1 ? " best" : ""}">${esc(v)}</span>`).join('<span class="lt">&lt;</span>');
  const outcomes = (pp.outcomes ?? []).map((o) => `<tr><td><b>${esc(o.when)}</b><div class="why">${esc(o.why)}</div></td><td><span class="res">${esc(statuses[o.status] ?? o.status)}</span></td></tr>`).join("");

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Пайплайн Инспектора ИИ</title>
<style>
@font-face{font-family:"Onest";src:url(data:font/woff2;base64,${fonts[0]}) format("woff2");font-weight:100 900}
@font-face{font-family:"Golos Text";src:url(data:font/woff2;base64,${fonts[1]}) format("woff2");font-weight:400 900}
@font-face{font-family:"JetBrains Mono";src:url(data:font/woff2;base64,${fonts[2]}) format("woff2");font-weight:100 800}
:root{
  color-scheme:light;
  --ground:#F1F2F6;--band:#F7F7FA;--card:#FFFFFF;--ink:#1D1F2E;--ink2:#474B62;--mute:#6B6F85;--line:#D9DBE5;--line2:#E6E7EE;
  --rs:#3B4FA8;--rs-soft:#EAEDF8;--rs-line:#A9B2D8;--done:#2E9E6B;--done-soft:#E4F6ED;--part:#E0A21A;--part-soft:#FFF4DC;--part-ink:#8A6200;
  --red:#D6454A;--red-soft:#FDECEC;--out:#4B7BEC;--out-soft:#E8F0FF;
  --sans:"Golos Text",system-ui,sans-serif;--head:"Onest","Golos Text",system-ui,sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:14px/1.55 var(--sans)}
:focus-visible{outline:2px solid var(--rs);outline-offset:2px}
.mono{font-family:var(--mono);font-size:12px}
header{background:var(--card);border-bottom:1px solid var(--line);padding:12px 18px 10px}
.h1row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
h1{font:700 19px/1.2 var(--head);margin:0;letter-spacing:-.01em}
.views{margin-left:auto;display:flex;gap:4px;flex-wrap:wrap}
.views a{border:1px solid transparent;border-radius:6px;padding:5px 12px;font:600 13px/1.45 var(--sans);color:var(--mute);text-decoration:none}
.views a:hover{color:var(--ink)}
.views a.on{border-color:var(--line);background:var(--ground);color:var(--ink)}
main{max-width:1240px;margin:0 auto;padding-inline:18px;padding-block:22px 64px;display:flex;flex-direction:column;gap:36px}
h2{font:700 21px/1.25 var(--head);margin:0;text-wrap:balance;letter-spacing:-.01em}
h3{font:700 15.5px/1.3 var(--head);margin:0}
.lead{color:var(--ink2);max-width:72ch;margin:6px 0 0}
.eyebrow{font:600 11px var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--rs);margin-bottom:6px}
.sec{display:flex;flex-direction:column;gap:14px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px}
.pill{display:inline-block;font:600 11.5px var(--sans);padding:2px 9px;border-radius:999px;white-space:nowrap}

.summary{padding:22px 24px;display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:26px}
.summary h2{font-size:24px}
.summary p{margin:10px 0 0;color:var(--ink2);max-width:66ch}
.summary p b{color:var(--ink)}
.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;align-content:start}
.fact{background:var(--band);border:1px solid var(--line2);border-radius:8px;padding:12px 14px}
.fact b{display:block;font:700 23px/1.1 var(--head);font-variant-numeric:tabular-nums;margin-bottom:4px}
.fact span{color:var(--ink2);font-size:12.5px;line-height:1.4;display:block}
.fact.good b{color:var(--done)}

.status{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:0}
.status li{padding:12px 14px 12px 22px;background:var(--card);border:1px solid var(--line);margin-left:-1px;position:relative}
.status li:first-child{border-radius:10px 0 0 10px;margin-left:0}.status li:last-child{border-radius:0 10px 10px 0}
.status li b{display:block;font:700 14px var(--head)}
.status li .mono{color:var(--rs)}
.status li p{margin:4px 0 0;color:var(--ink2);font-size:12.5px;line-height:1.4}
.status li:not(:last-child)::after{content:"";position:absolute;right:-7px;top:50%;width:12px;height:12px;background:var(--card);border-top:1px solid var(--line);border-right:1px solid var(--line);transform:translateY(-50%) rotate(45deg);z-index:1}

.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.step{display:grid;grid-template-columns:44px minmax(0,1fr);gap:14px}
.rail{display:flex;flex-direction:column;align-items:center}
.rail::after{content:"";flex:1;width:2px;background:var(--rs-line);margin-block:4px}
.step:last-child .rail::after{display:none}
.num{font:700 13px var(--mono);color:#fff;background:var(--rs);border-radius:50%;width:30px;height:30px;display:grid;place-items:center;flex:none}
.body{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin-bottom:12px}
.top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.who{font:600 11.5px var(--mono);color:var(--rs);text-transform:uppercase;letter-spacing:.04em}
.pill.st{background:var(--rs-soft);color:var(--rs);margin-left:auto}
.body>p{margin:8px 0 0;color:var(--ink2);max-width:92ch}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin-top:10px;font-size:13px}
.kv .k{font:600 11px var(--mono);text-transform:uppercase;letter-spacing:.04em;padding-top:2px}
.kv .fail{color:var(--red)}.kv .ex{color:var(--done)}

.scale{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sc{font:700 18px var(--head);padding:6px 14px;border-radius:8px;background:var(--part-soft);color:var(--part-ink)}
.sc.best{background:var(--done-soft);color:#1E6E49}
.lt{color:var(--mute);font:600 16px var(--mono)}
.m023{padding:18px 20px;display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr);gap:26px;align-items:start}
.m023 p{margin:8px 0 0;color:var(--ink2)}
table{border-collapse:collapse;width:100%}
.out td{padding:8px 10px;border-top:1px solid var(--line2);vertical-align:top;font-size:13px}
.out td:first-child{width:42%}.out b{font-weight:600}.out .why{color:var(--mute);font-size:12.5px}.res{color:var(--ink2)}

.algo{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.stage{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 18px}
.stage.own{border-left:4px solid var(--rs)}
.sh{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sh .n{color:var(--rs);font-weight:700;font-size:13px;min-width:30px}
.pill.own{background:var(--rs);color:#fff}.pill.gen{background:var(--band);color:var(--mute);border:1px solid var(--line2)}
.cols{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:20px;margin-top:8px}
.lab{font:600 11px var(--mono);text-transform:uppercase;letter-spacing:.05em;color:var(--mute);margin-top:6px}
.cols p{margin:3px 0 0;color:var(--ink2)}
.cols p.fail{color:var(--ink2)}
.exc{background:var(--done-soft);border-radius:8px;padding:6px 12px 10px;align-self:start}
.exc .lab{color:#1E6E49}
.exc p{color:var(--ink)}
.ops{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.ops span{font-size:12px;color:var(--ink2);background:var(--band);border:1px solid var(--line2);border-radius:6px;padding:2px 8px}
.ops b{color:var(--rs);font-weight:600}
.other{padding:18px 20px}
.other p{margin:8px 0 0;color:var(--ink2);max-width:92ch}
footer{color:var(--mute);font-size:12px}
@media (max-width:1000px){.summary,.m023{grid-template-columns:1fr}.status{grid-template-columns:repeat(3,minmax(0,1fr))}.status li{margin:0 0 -1px -1px;border-radius:0!important}.status li::after{display:none}.cols{grid-template-columns:1fr}}
@media (max-width:560px){main{padding-inline:16px}.facts,.status{grid-template-columns:1fr}.pill.st{margin-left:0}}
${serviceNavCss}
</style></head>
<body>
<header>
  ${renderServiceNav()}
  <div class="h1row">
    <h1>Пайплайн · Инспектор ИИ</h1>

  </div>
  ${renderServiceMetadata({status: "Схема процесса и пример прогона", note: "Пример М-023 относится к T-129; соответствие активному стенду не подтверждено"})}
</header>
<main id="docs-service-content" tabindex="-1">
  <section class="panel summary" aria-labelledby="sh">
    <div>
      <div class="eyebrow">Коротко</div>
      <h2 id="sh">Что происходит с пакетом после загрузки</h2>
      <p>Пакет проходит <b>восемь шагов</b>: приём, хранение, очередь, разбор каждого файла в ML, пересчёт проверки, верификация инспектором, финализация и выходной набор. Всё до верификации система делает сама.</p>
      <p>Параметр определяется <b>одиннадцатью шагами паспорта L0–L10</b>: общие для всех параметров — приём, редакции, распознавание, ворота, решение; свои у параметра — как искать значение, как нормализовать, откуда брать, как сравнивать и проверять. Пример М-023 ниже — исторический прогон прежнего Mac-стенда (T-129), не замер GPU-профиля.</p>
    </div>
    <div class="facts">
      <div class="fact"><b>57 из 78</b><span>файлов принято: 19 дубликатов, 2 повреждённых</span></div>
      <div class="fact"><b>25 мин</b><span>разбор 4 286 страниц, из них 551 скан</span></div>
      <div class="fact"><b>24</b><span>упоминания класса в 14 документах, 2 ловушки отсеяны</span></div>
      <div class="fact good"><b>6/6</b><span>полей совпало с независимым пересчётом</span></div>
    </div>
  </section>

  <section class="panel" style="padding:16px"><b>Снимок работающего GPU-контура · 29.09.2026, 15:31 UTC</b><p>Проверка без изменений на сервере: web, API, PostgreSQL, RabbitMQ и Redis — healthy; vLLM reader запущен. Контейнер ML остановлен (exit 137), vLLM judge остановлен (exit 0). RTX 4090: 6 259 из 24 564 МиБ занято. Это снимок процессов, а не успешный сквозной прогон; конфигурация ниже описывает предусмотренный состав.</p></section>
  <section class="sec" aria-labelledby="envh">
    <div>
      <div class="eyebrow">Где выполняются шаги</div>
      <h2 id="envh">Рабочий ML-контур — GPU; разработка и демо вынесены отдельно</h2>
      <p class="lead">Схема процесса выше общая; движки и доступ к записи зависят от контура. Последнее живое свидетельство GPU — T-184/T-185 от 28.09.2026. Состояние процессов проверено отдельно 29.09; снимок приведён выше.</p>
    </div>
    <div class="panel" style="overflow-x:auto"><table class="runs"><thead><tr><th>Контур</th><th>Выполнение</th><th>Данные и ограничения</th><th>Свидетельство</th></tr></thead><tbody>
      <tr><th>GPU-стенд nadzorium-gpu</th><td>RTX 4090; PP-OCR на CUDA, PaddleOCR-VL и Qwen3.5-9B через vLLM; очередь RabbitMQ.</td><td>API пишет блобы в /opt/stand-gpu/blobs, ML монтирует их read-only. RIN mock, антивирус выключен. Режимы контейнеров указаны в compose.</td><td>deploy/gpu-stand; живые проверки T-184/T-185, 28.09.2026. Runtime снимок процессов 29.09 приведён выше.</td></tr>
      <tr><th>Инструменты разработки</th><td>Удалённый раннер W1 предназначен для сборок и тестов; это не рабочий ML-контур.</td><td>Тесты и демо используют синтетику. Корпус и кэш T-165 — только чтение, наружу идут лишь агрегаты.</td><td>ADR-0009 и docs/ops/REMOTE-RUNNER.md (28.09.2026).</td></tr>
      <tr><th>Mac · прежний стенд</th><td>Раньше Docker-стенд и MLX запускали модели на MacBook; цифры М-023 ниже относятся к этому прогону.</td><td>Историческая конфигурация. После ADR-0009 Mac используется для редактирования; сборки и тесты перенесены на удалённый раннер.</td><td>T-129, docs/qa/M023-ALTUFYEVO-EVAL.md; решение заменено ADR-0009.</td></tr>
      <tr><th>Демо nadzorium · read-only</th><td>Показывает уже опубликованные результаты; разбор ML не запускается.</td><td>API запрещает изменяющие запросы (403); PostgreSQL-снимок и чтение блобов Object Storage.</td><td>Реализация и предыдущие проверки описаны в T-131; текущий хост не опрашивался.</td></tr>
    </tbody></table></div>
  </section>

  <section class="sec" aria-labelledby="ph">
    <div>
      <div class="eyebrow">Бизнес-процесс</div>
      <h2 id="ph">От загрузки до протокола</h2>
      <p class="lead">Статус проверки по ТЗ меняется так. Клиент API видит его по process_id — pull-модель, без ожидания ответа.</p>
    </div>
    <ol class="status">${statusBar}</ol>
    <ol class="steps">${process}</ol>
  </section>

  <section class="sec" aria-labelledby="mh">
    <div>
      <div class="eyebrow">Определение параметра</div>
      <h2 id="mh">М-023 «${esc(pp.title)}»</h2>
    </div>
    <div class="panel m023">
      <div>
        <div class="eyebrow">Что проверяем</div>
        <p style="margin-top:0;color:var(--ink)">${esc(pp.summary)}</p>
        <p class="mono">Основание: ${esc(pp.basis)}</p>
        <div class="eyebrow" style="margin-top:14px">Шкала — от худшего к лучшему</div>
        <div class="scale">${scale}</div>
      </div>
      <div>
        <div class="eyebrow">Какой статус ставит система</div>
        <table class="out"><tbody>${outcomes}</tbody></table>
      </div>
    </div>
    <p class="lead">Базовый алгоритм — шаги паспорта. Синей чертой отмечены шаги, которые у М-023 свои; остальные общие для всех параметров Матрицы. Справа — что шаг дал на реальном пакете.</p>
    <ol class="algo">${algo}</ol>
  </section>

  <section class="sec" aria-labelledby="oh">
    <div>
      <div class="eyebrow">Остальные параметры</div>
      <h2 id="oh">Как считаются другие 131 параметр</h2>
    </div>
    <div class="panel other">
      <p>Общие шаги (приём, редакции, распознавание, ворота, решение, решение инспектора) — те же. Свои шаги берутся из строки Матрицы: значение ищется по якорям и шаблону параметра, сравнение — по правилу сравнения (дельта в процентах, «не ниже эталона», «не выше эталона», совпадение). Паспорт со своим алгоритмом, как у М-023, — следующий шаг для других параметров.</p>
      <p>Паспорт любого параметра открывается щелчком по коду в разделе «Матрица» интерфейса; шаги на этой странице и в паспорте берутся из одного источника — data/seed/passports.</p>
    </div>
  </section>


  <section class="sec" aria-labelledby="learning-flow"><h2 id="learning-flow">Дообучение: от разметки до версии модели</h2>
  <p><a href="https://nadzorium-gpu.almazrobots.ru/verification/">Верификация и разметка данных</a> — существующий этап подготовки обучающих данных. Наличие модуля отмечено по исходникам опубликованной ревизии df65e188; код не запускался.</p>
  <p><b>Верификация и разметка → выпуск набора → обучение → оценка качества → утверждение и публикация.</b></p>
  <div class="panel" style="overflow-x:auto"><table><thead><tr><th>Этап</th><th>Что существует</th><th>Основание</th></tr></thead><tbody>
  <tr><td>Разметка и проверка данных</td><td>Задания, ответы, комментарии, исправления, витрина и разбор спорных случаев.</td><td>T-244: services/verification-routes.ts, services/data-verification.ts, services/annotation-library.ts; verification-http.test.ts, data-verification.test.ts.</td></tr>
  <tr><td>Выпуск обучающего набора</td><td>T-244 выпускает annotation-dataset.v1 с версиями, хешем и разбиением по объектам/источникам. GOLD по решениям инспектора — отдельный существующий путь.</td><td>releaseAnnotationDataset; domain/gold.ts; экран «Модели и GOLD».</td></tr>
  <tr><td>Обучение</td><td>Ранжир кандидатов реализован. Дообучение весов VLM/LoRA — отдельный этап; его наличие не следует из наличия разметки.</td><td>services/retrain.ts::trainIteration, domain/retrain.ts; retrain-route.test.ts; T-100 / T-156.</td></tr>
  <tr><td>Оценка и выпуск модели</td><td>У ранжира есть метрики, ворота качества, реестр версий и процедура утверждения.</td><td>services/retrain.ts, domain/gold.ts::publicationGate, pages/Ml.tsx.</td></tr>
  </tbody></table></div>
  <p>Стрелки обозначают бизнес-процесс. Автоматическая передача нового набора T-244 в существующий тренер не подтверждена. Подготовка данных существует; весь процесс нельзя помечать «нет».</p></section>
  <footer>Собрано ${esc(today)} из scripts/pipeline-map.mjs (pnpm trace). Шаги — data/seed/passports/_common.json и M-023.json; числа М-023 — исторический Mac-прогон из docs/qa/M023-ALTUFYEVO-EVAL.md. GPU-профиль описан по deploy/gpu-stand/compose.yml и OWASP T-184/T-185; инструменты разработки — по ADR-0009 и docs/ops/REMOTE-RUNNER.md.</footer>
</main>
</body></html>
`;
}
