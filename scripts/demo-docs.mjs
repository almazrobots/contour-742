#!/usr/bin/env node
// Материалы демо-стенда «Надзориум» (T-131): страницы карты ГЕРЫ, методика, подход и результаты анализов → каталог /docs.
//   node scripts/demo-docs.mjs <каталог> <проверок> <файлов> <sha256 дампа> <ревизия стенда мака> [publication.json прошлой публикации]
// С прошлой publication.json (scripts/demo.sh docs) обновляются только материалы: сведения о данных — из неё.
// Markdown превращается в HTML здесь же (заголовки, абзацы, списки, таблицы, код, ссылки, выделение), Mermaid рисует
// вшитый mermaid 12 (scripts/vendor, SHA-256 сверяется). Корпус corpus-ABC сюда не попадает никогда (ADR-0002):
// список файлов — явный, без обхода каталогов.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildGuide } from "./user-guide.mjs";
import {renderMaterialShell} from "./docs-material-shell.mjs";
import { DOC_NAV_CSS } from "./doc-nav.mjs";

const root = new URL("..", import.meta.url).pathname;

// Разделы материалов: что читатель ищет — страница, откуда она берётся
const SECTIONS = [
  {title:"Новые материалы",note:"Проверенные пользовательские сценарии и состояние документации",items:[
   ["guide/videos.html","Видеоуроки",null,"Сценарии с русскими подписями и текстовыми шагами"],
   ["guide/materials.html","Реестр материалов",null,"Где найти руководство, требования и датированный отчёт"],
   ["guide/release.html","Версии и актуальность",null,"Подтверждённые публикации и ограничения"],
   ["plans/knowledge-base.html","План базы знаний","docs/design/DOCUMENTATION-REDESIGN-PLAN.md","Действующая цель документации; незавершённые работы показаны отдельно"],
  ]},
  { title: "Руководство пользователя", note: "Первые шаги, проверки, разметка и сопровождение — по задачам и ролям", items: [
    ["guide/index.html", "База знаний Надзориума", null, "Короткие инструкции, поиск, оглавление и связанные статьи"],
  ] },
  { title: "BI-дашборд платформы (макет)", note: "Моковые данные: как руководство видит портфель, а директор стройки — свой объект", items: [
    ["bi/dashboard.html", "Портфель и объект", "docs/bi/dashboard.html", "Executive-дашборд по всем объектам портфеля и дашборд здоровья отдельного объекта (T-168, данные вымышленные)"],
  ] },
  { title: "Карта требований ГЕРЫ", note: "Требования выведены из модели процесса и связаны с кодом и тестами", items: [
    ["gera/TRACE-MAP.html", "Карта трассы требований", "docs/gera/TRACE-MAP.html", "Карта трассы: ТЗ → бизнес-операции → правила → код → тесты, каталог TO-BE, метрики"],
    ["gera/PIPELINE.html", "Пайплайн", "docs/gera/PIPELINE.html", "Пайплайн: что происходит с пакетом после загрузки и как определяется М-023"],
    ["gera/ARCHITECTURE.html", "Архитектура", "docs/gera/ARCHITECTURE.html", "Архитектура: из чего собрана система и чего не хватает до полного ТЗ"],
  ] },
  { title: "Методика ГЕРА — модель процесса", note: "Обследование → бизнес-уровень → сервисы (это и есть требования) → данные", items: [
    ["method/00-run-notes.html", "Прогон метода", "docs/gera/inspector/00-run-notes.md", "Прогон метода: итерации, решения владельца, что осталось"],
    ["method/01-survey.html", "Обследование", "docs/gera/inspector/01-survey.md", "Обследование: источники и факты процесса"],
    ["method/02-business.html", "Бизнес-уровень", "docs/gera/inspector/02-business.md", "Бизнес-уровень: процессы и операции"],
    ["method/03-services.html", "Сервисы и правила", "docs/gera/inspector/03-services.md", "Операционные сервисы и правила — требования системы"],
    ["method/04-data.html", "Данные", "docs/gera/inspector/04-data.md", "Информационная модель"],
    ["method/05-state-machine.html", "Стейт-машина обработки", "docs/gera/inspector/05-state-machine.md", "Стейт-машина пакета: автоматы проверки, файла, строки сверки и отправки в «РиН»; операции и технологии"],
    ["method/survey-m023.html", "Обследование М-023", "docs/gera/inspector/survey-m023.md", "Обследование М-023: где в пакете встречается класс"],
  ] },
  { title: "Подход и алгоритм", note: "Целевой процесс сравнения и решения по архитектуре", items: [
    ["approach/to-be.html", "Целевой процесс TO-BE", "docs/research/TO-BE-операции-сравнения.md", "Целевой каталог операций сравнения (TO-BE)"],
    ["approach/ml-concept.html", "Концепция ML", "docs/architecture/ML-CONCEPT.md", "Концепция интеллектуальной части: модели, роли, линейки"],
    ["approach/c4.html", "C4", "docs/architecture/C4.md", "Архитектура в нотации C4"],
    ["approach/adr-0006.html", "ADR-0006", "docs/adr/ADR-0006-blobs-in-s3-client-side-encryption.md", "ADR-0006: файлы в S3 с шифрованием на клиенте"],
  ] },
  { title: "Дизайн интерфейса", note: "Принятые дизайн-решения, дизайн-система и подход к реализации — как решено и как сделано в коде", items: [
    ["design/design-system.html", "Дизайн-система «Чертёжный бетон»", "docs/design/DESIGN-SYSTEM.html", "Решения с хроникой, токены, компоненты, опыт, голос, доступность, подход к реализации и долг — рядом с тем, как сделано в коде"],
  ] },
  { title: "Результаты анализов", note: "Что показали прогоны и проверки", items: [
    ["results/m023-altufyevo.html", "М-023 на «Алтуфьево»", "docs/qa/M023-ALTUFYEVO-EVAL.md", "М-023 на пакете «Алтуфьевское 79Б»: полнота, точность, OCR, судья VLM"],
    ["results/qa-t129.html", "Отчёт о качестве T-129", "docs/qa/QA-REPORT-T129.md", "Отчёт о качестве: тесты по эшелонам, покрытие, мутации"],
    ["results/owasp-t129.html", "OWASP-аудит T-129", "OWASP/audits/2026-09-27-s3-ml-T129/report.md", "OWASP-аудит: находки и решения"],
  ] },
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/(^|[\s(«])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => (/^https?:\/\//.test(href) ? `<a href="${href}" rel="noopener">${text}</a>` : `<span class="ref">${text}</span>`));
  return t;
}

/** Markdown → HTML: ровно то, что встречается в документах проекта. */
export function md2html(src) {
  const lines = src.replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  const out = [];
  let i = 0;
  let mermaid = false;
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para.length = 0; } };
  while (i < lines.length) {
    const l = lines[i];
    const fence = l.match(/^```(\w*)/);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      if (fence[1] === "mermaid") { mermaid = true; out.push(`<pre class="mermaid">${esc(body.join("\n"))}</pre>`); }
      else out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flush();
      const row = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = row(l);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]));
      out.push(`<div class="tw"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const li = l.match(/^(\s*)([-*]|\d+\.)\s+(.*)/);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)/);
        if (m) { items.push(m[3]); i++; continue; }
        if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += " " + lines[i].trim(); i++; continue; }
        break;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (/^>\s?/.test(l)) { flush(); const q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, "")); out.push(`<blockquote>${inline(q.join(" "))}</blockquote>`); continue; }
    if (!l.trim()) { flush(); i++; continue; }
    para.push(l.trim());
    i++;
  }
  flush();
  return { html: out.join("\n"), mermaid };
}

function page(title, body, { mermaid = false, depth = 1, metadata = {} } = {}) {
  const up = "../".repeat(depth);
  let html=renderMaterialShell({title,body,depth,sections:SECTIONS,metadata});
  if(mermaid)html=html.replace('</body>',`<script src="${up}assets/mermaid.min.js"></script><script>mermaid.initialize({startOnLoad:true,securityLevel:"strict",theme:"base",themeVariables:{fontFamily:"Golos, system-ui, sans-serif",primaryColor:"#EAEDF8",primaryBorderColor:"#A9B2D8",lineColor:"#7E84A3"}});</script></body>`);
  return html;
}

const CSS = `${DOC_NAV_CSS}
@font-face{font-family:"Onest";src:url(fonts/onest-var.woff2) format("woff2");font-weight:100 900}
@font-face{font-family:"Golos Text";src:url(fonts/golos-text-var.woff2) format("woff2");font-weight:400 900}
@font-face{font-family:"JetBrains Mono";src:url(fonts/jetbrains-mono-var.woff2) format("woff2");font-weight:100 800}
:root{color-scheme:light;--ground:#F1F2F6;--card:#FFFFFF;--ink:#1D1F2E;--ink2:#474B62;--mute:#6B6F85;--line:#D9DBE5;--band:#F7F7FA;--rs:#3B4FA8;--rs-soft:#EAEDF8;--amber:#E0A21A;--amber-soft:#FFF4DC;--done:#2E9E6B}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.6 "Golos Text",system-ui,sans-serif}
header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:12px 18px;background:var(--card);border-bottom:1px solid var(--line)}
header .home{font:700 16px "Onest","Golos Text",sans-serif;color:var(--ink);text-decoration:none}
header .ro{font:600 12px "JetBrains Mono",monospace;background:var(--amber-soft);border:1px solid var(--amber);border-radius:999px;padding:2px 10px}
header .app{margin-left:auto;color:var(--rs);font-weight:600;text-decoration:none}
main{max-width:1000px;margin:0 auto;padding-inline:18px;padding-block:24px 64px}
.doc h1,.doc h2,.doc h3,.doc h4{font-family:"Onest","Golos Text",sans-serif;line-height:1.25;text-wrap:balance}
.doc h1{font-size:28px}.doc h2{font-size:21px;margin-top:34px}.doc h3{font-size:17px;margin-top:24px}
.doc p,.doc li{color:var(--ink2);max-width:80ch}
.doc code{font:13px "JetBrains Mono",monospace;background:var(--rs-soft);padding:1px 5px;border-radius:4px}
.doc pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-x:auto}
.doc pre code{background:none;padding:0}
.doc pre.mermaid{background:var(--card);text-align:center}
.tw{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px;margin:14px 0}
.doc table{border-collapse:collapse;width:100%;font-size:14px}
.doc th,.doc td{padding:8px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.doc th{background:var(--band);font-weight:700}
.doc blockquote{margin:14px 0;padding:10px 14px;border-left:3px solid var(--rs);background:var(--card);color:var(--ink2)}
.doc a{color:var(--rs)}.doc .ref{color:var(--rs)}
.idx h1{font:700 28px "Onest",sans-serif;margin:0 0 6px}
.lead{color:var(--ink2);max-width:75ch}
.pub{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:18px 0 28px;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.pub div b{display:block;font:700 18px "Onest",sans-serif}.pub div span{color:var(--mute);font-size:13px}
.pub .mono{font:12px "JetBrains Mono",monospace;word-break:break-all}
.sec{margin-top:26px}.sec h2{font:700 20px "Onest",sans-serif;margin:0}.sec p.n{color:var(--mute);margin:4px 0 12px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
.cards a{display:block;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;text-decoration:none;color:var(--ink)}
.cards a:hover{border-color:var(--rs)}
.cards b{display:block;font-weight:700;margin-bottom:4px}.cards span{color:var(--ink2);font-size:13.5px}
.cov{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--done);border-radius:12px;padding:18px 20px;margin:0 0 28px}
.cov .top{display:flex;gap:22px;align-items:flex-end;flex-wrap:wrap}.cov .big{font:800 52px/1 "Onest",sans-serif;color:var(--done);letter-spacing:-.02em}
.cov .cap{font-weight:700;font-size:17px}.cov .sub{color:var(--mute);font-size:13px}
.cov .grp{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:16px 0 6px}
.cov .grp div{background:var(--band);border-radius:8px;padding:10px 12px}.cov .grp b{display:block;font:800 22px "Onest",sans-serif}.cov .grp span{font-size:13px;color:var(--ink2)}
.cov table{border-collapse:collapse;width:100%;font-size:14px;margin-top:10px}.cov td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
.cov td.p{text-align:right;font-weight:800;font-family:"Onest",sans-serif;white-space:nowrap}.cov td.n{text-align:right;color:var(--mute);white-space:nowrap;font-size:13px}
.cov .bar{display:flex;height:8px;border-radius:4px;background:#E6E7EE;overflow:hidden;min-width:90px}.cov .bar i{height:100%}
.cov tr.g td{font-weight:700;color:var(--rs);padding-top:14px;font-size:12.5px;text-transform:uppercase;letter-spacing:.04em}
.cov .more{display:inline-block;margin-top:12px;color:var(--rs);font-weight:600}
.auh{font:700 20px "Onest",sans-serif;margin:8px 0 2px}
.cov .concl{background:#FFF6F6;border:1px solid #F1C9CB;border-radius:8px;padding:12px 16px;margin:16px 0}.cov .concl h3,.cov .rh{font:700 15px "Onest",sans-serif;margin:6px 0}.cov .concl li{margin:5px 0;color:var(--ink2);font-size:14px}
@media (max-width:620px){.cov td.bw,.cov td.n{display:none}}
@media (max-width:520px){main{padding-inline:16px}}`;

// ─────────────── сборка
/** Блок «Покрытие ТЗ кодом» для главной — из docs/trace/TZ-COVERAGE.json (pnpm trace). */
export function coverageBlock(cov) {
  if (!cov) return "";
  const T = cov.total;
  const bar = (x) => `<span class="bar"><i style="width:${(100 * x.done) / (x.n || 1)}%;background:var(--done)"></i><i style="width:${(100 * x.partial) / (x.n || 1)}%;background:var(--amber)"></i></span>`;
  const rows = cov.groups.map((g) => `<tr class="g"><td colspan="4">${esc(g.title)} · ${g.pct} %</td></tr>` + cov.sections.filter((s) => s.group === g.id).map((s) => `<tr><td>${esc(s.title)}</td><td class="bw">${bar(s)}</td><td class="p">${s.pct} %</td><td class="n">${s.done} из ${s.n}</td></tr>`).join("")).join("");
  return `<div class="cov"><div class="top"><div class="big">${T.pct} %</div><div><div class="cap">требований ТЗ покрыто кодом с тестами</div><div class="sub">${T.done} из ${T.n} требований · частично ${T.partial} · нет кода ${T.none} · реализовано и проверено ${T.colors ? `${T.colors.green} из ${T.n} (${T.greenPct} %), не реализовано ${T.colors.red}` : "—"} · собрано ${esc(cov.built ?? "")}</div></div></div>
<div class="grp">${cov.groups.map((g) => `<div><b style="color:${g.pct === 100 ? "var(--done)" : "var(--ink)"}">${g.pct} %</b><span>${esc(g.title)} — ${g.done} из ${g.n}</span></div>`).join("")}</div>
<table>${rows}</table><a class="more" href="gera/TRACE-MAP.html?view=coverage">Подробно по каждому требованию →</a></div>`;
}

/** Контрольная витрина (T-141): воронка аудита критиков, выводы и расклад — рядом с исходной, не вместо неё. */
export function auditBlock(cov) {
  if (!cov?.audit) return "";
  const T = cov.total;
  const bar = (x) => `<span class="bar"><i style="width:${(100 * x.real) / (x.n || 1)}%;background:var(--done)"></i><i style="width:${(100 * Math.max(0, x.done - x.real)) / (x.n || 1)}%;background:#C9CCD8"></i></span>`;
  const rows = cov.groups.map((g) => `<tr class="g"><td colspan="4">${esc(g.title)} · подтверждено ${g.realPct} %</td></tr>` + cov.sections.filter((s) => s.group === g.id).map((s) => `<tr><td>${esc(s.title)}</td><td class="bw">${bar(s)}</td><td class="p">${s.realPct} %</td><td class="n">${s.real} из ${s.n} · в трассе ${s.pct} %</td></tr>`).join("")).join("");
  return `<h2 class="auh">Контрольная витрина: аудит критиков</h2><p class="n">Исходный аудит 27.09 и последующие точечные перепроверки. Изменившиеся требования требуют нового подтверждения; текущая зелёная доля указана отдельно.</p><div class="cov" style="border-left-color:#D6454A"><div class="top"><div class="big" style="color:var(--ink)">${T.realPct} %</div><div><div class="cap">требований ТЗ с вердиктом REAL в реестре аудита</div><div class="sub">${T.real} из ${T.n} (спорных ${T.real - T.realSure}) · в трассе названы код и тест — ${T.pct} % · качество на корпусе подтверждается отдельными датированными отчётами · аудит ${esc(cov.audit?.at ?? "—")}, собрано ${esc(cov.built ?? "")}</div></div></div>
<div class="grp">${cov.groups.map((g) => `<div><b style="color:${g.realPct < 50 ? "#D6454A" : "var(--ink)"}">${g.realPct} %</b><span>${esc(g.title)} — подтверждено ${g.real} из ${g.n}, в трассе ${g.pct} %</span></div>`).join("")}</div>
${cov.audit?.conclusions?.length ? `<div class="concl"><h3>Выводы аудита</h3><ol>${cov.audit.conclusions.map((c) => `<li>${esc(c)}</li>`).join("")}</ol>${cov.audit.defects?.length ? `<h3>Самые опасные дефекты</h3><ul>${cov.audit.defects.map((d) => `<li><code>${esc(d.id)}</code> ${esc(d.t)} <b>${esc(d.task)}</b></li>`).join("")}</ul>` : ""}</div>` : ""}
${cov.audit.history?.length ? `<p class="n"><b>История:</b> ${cov.audit.history.map((h) => `аудит ${esc(h.at)} — подтверждено ${Math.round((100 * h.real) / h.n)} %, открытых дефектов ${h.defects_open}`).join("; ")}. Цель — подтверждение всех актуальных требований и отсутствие открытых дефектов; для этого нужен повторный аудит изменившихся требований.</p>` : ""}
<h3 class="rh">Расклад по разделам ТЗ: зелёная полоса — подтверждено аудитом, серая — только названо в трассе</h3><table>${rows}</table><a class="more" href="gera/TRACE-MAP.html?view=audit">Почему не подтверждено — по каждому требованию →</a></div>`;
}

function main(out, nInsp, nFiles, dumpSha, standRev, prevPub) {
  if (!out) throw new Error("demo-docs: укажите каталог вывода");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "assets/fonts"), { recursive: true });
writeFileSync(join(out, "assets/doc.css"), CSS);
for (const f of ["onest-var", "golos-text-var", "jetbrains-mono-var", "geologica-cyrillic", "geologica-latin"]) {
  const p = join(root, "apps/web/public/fonts", `${f}.woff2`);
  if (existsSync(p)) cpSync(p, join(out, "assets/fonts", `${f}.woff2`));
}
const mm = readFileSync(join(root, "scripts/vendor/mermaid-12.0.0.min.js"));
if (createHash("sha256").update(mm).digest("hex") !== "28fca7ae6ebc7ed7bb63bde63136a74bfef14f296a57e403657eeb8b32836073") throw new Error("mermaid: SHA-256 не совпал");
writeFileSync(join(out, "assets/mermaid.min.js"), mm);

for (const s of SECTIONS) for (const [dst, , src, what] of s.items) {
  if (!src) continue; // guide генерируется отдельно
  const from = join(root, src);
  if (!existsSync(from)) throw new Error(`demo-docs: нет ${src}`);
  mkdirSync(join(out, dst.split("/")[0]), { recursive: true });
  if (src.endsWith(".html")) { cpSync(from, join(out, dst)); continue; }
  const markdown=readFileSync(from,"utf8");
  const { html, mermaid } = md2html(markdown);
  const status=src.startsWith('docs/qa/')||src.startsWith('OWASP/')?'Исторический отчёт; область и дата указаны в тексте':markdown.match(/^status:\s*(.+)$/m)?.[1]||'Проект / методический материал';
  const last_verified=markdown.match(/^last_verified:\s*(.+)$/m)?.[1];
  writeFileSync(join(out, dst), page(what, html, { mermaid,metadata:{path:dst,status,last_verified} }));
}

const rev = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
// только материалы: данные на стенде прежние — сведения о них берутся из прошлой публикации без изменений
const prev = prevPub ? JSON.parse(readFileSync(prevPub, "utf8")) : null;
const publication = prev ? { ...prev, site_revision: rev, docs_published_at: new Date().toISOString() } : {
  published_at: new Date().toISOString(),
  source: "MacBook Air M4 — стенд Docker и модели на маке",
  source_host: hostname(),
  revision: standRev || rev,
  site_revision: rev,
  inspections: Number(nInsp) || 0,
  files: Number(nFiles) || 0,
  dump_sha256: dumpSha || "",
};
writeFileSync(join(out, "publication.json"), JSON.stringify(publication, null, 2));

const when = new Date(publication.published_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
const covFile = join(root, "docs/trace/TZ-COVERAGE.json");
const cov = existsSync(covFile) ? JSON.parse(readFileSync(covFile, "utf8")) : null;
const idx = `<section class="idx"><h1>Материалы и документация</h1>
<p class="lead">Руководства по задачам, требования, архитектура и датированные отчёты. CPU-демо показывает сохранённые результаты; обработка и изменение данных выполняются на рабочем стенде. Статус каждого материала относится к его указанной версии и области проверки.</p>
<div class="pub">
  <div><b>${esc(when)} МСК</b><span>опубликованы данные</span></div>${publication.docs_published_at ? `<div><b>${esc(new Date(publication.docs_published_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }))} МСК</b><span>обновлены материалы</span></div>` : ""}
  <div><b>${publication.inspections} · ${publication.files}</b><span>проверок · разобранных файлов</span></div>
  <div><b>${esc(publication.source || "Источник указан в паспорте публикации")}</b><span>источник опубликованного снимка данных</span></div>
  <div><span class="mono">ревизия ${esc(publication.revision.slice(0, 12))} · дамп ${esc((publication.dump_sha256 || "").slice(0, 16))}…</span><span>доказательство публикации</span></div>
</div>
<details><summary>Историческая трасса требований и аудита</summary>${coverageBlock(cov)}${auditBlock(cov)}</details>
${SECTIONS.map((s) => `<div class="sec"><h2>${esc(s.title)}</h2><p class="n">${esc(s.note)}</p><div class="cards">${s.items.map(([dst, title, , what]) => `<a href="${dst}"><b>${esc(title)}</b><span>${esc(what)}</span></a>`).join("")}</div></div>`).join("")}
</section>`;
buildGuide(join(out, "guide"));
writeFileSync(join(out, "index.html"), page("Материалы базы знаний", idx, { depth: 0,metadata:{status:"Каталог опубликованных материалов",ui_revision:false,path:"index.html"} }));
console.log(`  материалы: ${SECTIONS.reduce((n, s) => n + s.items.length, 0)} страниц + index.html + publication.json → ${out}`);
}

export { SECTIONS };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(...process.argv.slice(2));
