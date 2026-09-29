#!/usr/bin/env node
// Трасса ГЕРЫ, облегчённая версия (щадящий режим проекта; эталон — ~/code/energobaza/scripts/gera-trace.mjs).
//
// Читает docs/gera/*/model.yaml и текст правил из 03-services.md, проверяет связи и собирает:
//   docs/trace/TRACE-TZ.md    — трассировочная таблица: пункт ТЗ → операция → сервис → правило → код → тест → статус
//   docs/trace/TRACE-TZ.html  — она же, самодостаточная страница с фильтрами
//   tasks/BOARD.md            — доска задач по папкам tasks/*
//
//   node scripts/gera-trace.mjs          — проверить и собрать
//   node scripts/gera-trace.mjs --check  — только проверить (гейт): падает на первом классе ошибок
//
// Гейт падает, если: связь ведёт в несуществующий узел; у операции системы не ровно один сервис;
// правило в impl не описано в 03-services.md; файл кода/теста не существует; символ или название
// теста не найдены в файле.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { renderTraceMap } from "./trace-map.mjs";
import { renderArchMap } from "./arch-map.mjs";
import { renderPipelineMap } from "./pipeline-map.mjs";
import { renderDecomposition } from "./tz-report.mjs";
import { buildTzDoc } from "./tz-map.mjs";
import { buildTzDetail } from "./tz-detail.mjs";
import { buildCatalog } from "./trace-catalog.mjs";
import { BUSINESS, coverage } from "./tz-coverage.mjs";
import { METRICS, ratchet, traceAudit } from "./trace-audit.mjs";
import { buildProvenance, renderProvenance } from "./audit-provenance.mjs";
import { aggColor, atomColor, colorCounts } from "./tz-color.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GERA = join(ROOT, "docs/gera");
const CHECK_ONLY = process.argv.includes("--check");
const errors = [];
const fail = (m) => errors.push(m);

const models = readdirSync(GERA, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_") && existsSync(join(GERA, d.name, "model.yaml")))
  .map((d) => ({ dir: d.name, ...parse(readFileSync(join(GERA, d.name, "model.yaml"), "utf8")) }));

if (!models.length) {
  console.error("Нет ни одной модели docs/gera/<процесс>/model.yaml");
  process.exit(1);
}

// ─────────────────────────────── правила из текста сервисов
function readRules(m) {
  const rel = m.process?.artifacts?.services;
  const rules = new Map();
  const services = new Map();
  if (!rel || !existsSync(join(ROOT, rel))) {
    fail(`${m.dir}: нет артефакта сервисов ${rel}`);
    return { rules, services };
  }
  const text = readFileSync(join(ROOT, rel), "utf8");
  for (const [, id, title, body] of text.matchAll(/^## (OS-[A-Z]+-\d+\.\d+) (.+?) — BO-[^\n]*\n+([^\n]*)/gm))
    services.set(id, { title: title.trim(), statement: body.startsWith("- ") ? "" : body.trim() });
  for (const [, id, body] of text.matchAll(/\*\*(OS-[A-Z]+-\d+\.\d+\.\d+)\*\*\s+(.+)$/gm)) {
    if (rules.has(id)) fail(`${rel}: правило ${id} описано дважды`);
    rules.set(id, body.trim());
  }
  return { rules, services };
}

// ─────────────────────────────── проверка ссылок на код и тесты
const fileCache = new Map();
function fileText(rel) {
  if (!fileCache.has(rel)) fileCache.set(rel, existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8") : null);
  return fileCache.get(rel);
}
function checkRef(where, ref, kind) {
  const [path, name] = ref.split("::");
  const text = fileText(path);
  if (text === null) return fail(`${where}: ${kind} — файла ${path} нет`);
  if (name && !text.includes(name)) fail(`${where}: ${kind} — в ${path} не найдено «${name}»`);
}

// ─────────────────────────────── сборка индекса
const rows = [];
const maps = [];

/**
 * Атомарная декомпозиция ТЗ (docs/tz/tz-decomposition.yaml): проверить ссылки trace и вычислить вердикт атома
 * по статусам того, чем он реализован. Вердикт руками не пишется.
 */
// аудит покрытия (T-141): вердикты критиков по каждому атому; снимок трасс на ревизии аудита — чтобы атом с изменённой
// с тех пор трассой не зеленел по устаревшему вердикту (T-164)
const auditFile = join(ROOT, "docs/trace/COVERAGE-AUDIT.json");
const audit = existsSync(auditFile) ? JSON.parse(readFileSync(auditFile, "utf8")) : null;
const auditTracesFile = join(ROOT, "docs/trace/COVERAGE-AUDIT-TRACES.json");
const auditTraces = existsSync(auditTracesFile) ? JSON.parse(readFileSync(auditTracesFile, "utf8")) : null;
if (audit && auditTraces && auditTraces.revision !== audit.revision) fail(`COVERAGE-AUDIT-TRACES.json снят на ${auditTraces.revision}, а аудит — на ${audit.revision}: пересоберите снимок вместе с аудитом`);

let provenance = null;
function decompose(m, { rules, constraints, ruleStatus, impl }) {
  const file = join(ROOT, "docs/tz/tz-decomposition.yaml");
  if (!existsSync(file)) return null;
  const dz = parse(readFileSync(file, "utf8"));
  provenance = audit ? buildProvenance(ROOT, audit, auditTraces, m, dz) : null;
  const reviews = new Map((provenance?.records ?? []).map(r => [r.id, r]));
  const dlg = new Map((m.dialogs ?? []).map((d) => [d.id, (d.code ?? []).length ? ((d.tests ?? []).length ? "done" : "partial") : "todo"]));
  const dat = new Map((m.data ?? []).map((o) => [o.id, (o.code ?? []).length ? ((o.tests ?? []).length ? "done" : "partial") : "todo"]));
  const nfrSt = (id) => {
    const c = constraints.get(id);
    const st = ruleStatus(id);
    return st === "todo" && (c.mode ?? "prototype") !== "prototype" ? "outside" : st;
  };
  const refStatus = (ref, where) => {
    if (rules.has(ref)) return ruleStatus(ref);
    if (constraints.has(ref)) return nfrSt(ref);
    if (dlg.has(ref)) return dlg.get(ref);
    if (dat.has(ref)) return dat.get(ref);
    fail(`${where}: ссылка ${ref} — нет такого правила, НФТ, диалога или объекта данных`);
    return "todo";
  };
  const ids = new Set();
  const modelTz = new Set((m.tz ?? []).map((t) => t.id));
  for (const sec of dz.sections) {
    for (const it of sec.items) {
      if (!it.new && !modelTz.has(it.id)) fail(`tz-decomposition: пункт ${it.id} не в model.yaml → tz и не помечен new: true`);
      for (const a of it.atoms) {
        if (ids.has(a.id)) fail(`tz-decomposition: атом ${a.id} повторяется`);
        ids.add(a.id);
        const sts = (a.trace ?? []).map((r) => refStatus(r, `атом ${a.id}`));
        const scope = a.scope ?? "prototype";
        // вне прототипа атом проверяется на стенде или в эксплуатации — здесь он не может быть принят
        let v;
        if (scope !== "prototype") v = "outside";
        else if (!sts.length) v = "todo";
        else if (sts.every((x) => x === "done")) v = a.partial ? "partial" : "done";
        else v = sts.some((x) => x !== "todo" && x !== "outside") ? "partial" : "todo";
        a.ready = scope !== "prototype" && sts.length > 0 && sts.every((x) => x === "done");
        // покрытие кодом — независимо от контура приёмки: есть ли код с тестом за каждым звеном трассы атома
        if (!sts.length || sts.every((x) => x === "todo" || x === "outside")) a.code = "none";
        else a.code = sts.every((x) => x === "done") && !a.partial ? "done" : "partial";
        a.verdict = v;
        a.auditFreshness = reviews.get(a.id)?.status ?? "unknown";
        // честный цвет (T-164): код по трассе + вердикт критиков; шкала — scripts/tz-color.mjs
        Object.assign(a, atomColor({ ...a, scope, trace: a.trace ?? [] }, audit?.atoms?.[a.id] ?? null, auditTraces?.atoms?.[a.id]));
        a.scope = scope;
        a.section = sec.id;
        a.item = it.id;
      }
    }
  }
  void impl;
  for (const sec of dz.sections) if (!BUSINESS[sec.id]) fail(`tz-decomposition: раздел ${sec.id} без названия для заказчика в scripts/tz-coverage.mjs → BUSINESS`);
  return dz;
}
const summary = { done: 0, partial: 0, todo: 0, outside: 0 };
// статус правила — по коду и тесту; статус пункта ТЗ — честный цвет его атомов (T-164, scripts/tz-color.mjs)
const STATUS = {
  done: { icon: "✅", ru: "реализовано" },
  partial: { icon: "🟡", ru: "частично" },
  todo: { icon: "⬜", ru: "не начато" },
  outside: { icon: "⏸", ru: "вне прототипа" },
  green: { icon: "🟢", ru: "реализовано и проверено" },
  yellow: { icon: "🟡", ru: "частично" },
  red: { icon: "🔴", ru: "не реализовано" },
  blue: { icon: "🔵", ru: "код готов, ждёт стенда" },
  grey: { icon: "⚪", ru: "требований нет" },
};
const RULE2COLOR = { done: "green", partial: "yellow", todo: "red", outside: "blue" };

for (const m of models) {
  const { rules, services: svcText } = readRules(m);
  const nodes = new Map();
  for (const n of m.business ?? []) {
    if (nodes.has(n.id)) fail(`${m.dir}: узел ${n.id} повторяется`);
    nodes.set(n.id, n);
  }
  for (const n of m.business ?? []) if (n.parent && !nodes.has(n.parent)) fail(`${m.dir}: ${n.id} → родитель ${n.parent} не найден`);
  const svc = new Map((m.services ?? []).map((s) => [s.id, s]));
  const bySvcBo = new Map();
  for (const s of m.services ?? []) {
    if (!nodes.has(s.bo)) fail(`${m.dir}: сервис ${s.id} ссылается на несуществующую операцию ${s.bo}`);
    if (!svcText.has(s.id)) fail(`${m.dir}: сервис ${s.id} не описан в 03-services.md`);
    bySvcBo.set(s.bo, [...(bySvcBo.get(s.bo) ?? []), s.id]);
  }
  for (const id of svcText.keys()) if (!svc.has(id)) fail(`${m.dir}: сервис ${id} есть в тексте, но не в model.yaml`);
  for (const n of nodes.values()) {
    if (n.level !== "BO") continue;
    const count = (bySvcBo.get(n.id) ?? []).length;
    if (n.system === false) {
      if (count) fail(`${m.dir}: операция вне системы ${n.id} имеет сервис`);
      if (!n.why) fail(`${m.dir}: операция вне системы ${n.id} без причины`);
    } else if (count !== 1) fail(`${m.dir}: у операции ${n.id} сервисов ${count}, нужен ровно один`);
  }
  const constraints = new Map((m.constraints ?? []).map((c) => [c.id, c]));
  const impl = m.impl ?? {};
  for (const [id, v] of Object.entries(impl)) {
    if (!rules.has(id) && !constraints.has(id)) fail(`${m.dir}: impl ${id} — нет такого правила или ограничения`);
    for (const c of v.code ?? []) checkRef(`impl ${id}`, c, "код");
    for (const t of v.tests ?? []) checkRef(`impl ${id}`, t, "тест");
  }
  // этаж 4: диалог реализует сценарий существующих сервисов; этаж 6: объект данных связан с существующими операциями
  for (const d of m.dialogs ?? []) {
    for (const sv of d.services ?? []) if (!svc.has(sv)) fail(`${m.dir}: диалог ${d.id} ссылается на несуществующий сервис ${sv}`);
    for (const c of d.code ?? []) checkRef(`диалог ${d.id}`, c, "код");
    for (const t of d.tests ?? []) checkRef(`диалог ${d.id}`, t, "тест");
    if (!readFileSync(join(ROOT, m.process.artifacts.dialogs), "utf8").includes(d.id)) fail(`${m.dir}: диалог ${d.id} не описан в ${m.process.artifacts.dialogs}`);
  }
  for (const o of m.data ?? []) {
    for (const b of [...(o.new_in ?? []), ...(o.used_by ?? [])]) if (!nodes.has(b)) fail(`${m.dir}: объект ${o.id} ссылается на несуществующую операцию ${b}`);
    for (const c of o.code ?? []) checkRef(`объект ${o.id}`, c, "код");
    for (const t of o.tests ?? []) checkRef(`объект ${o.id}`, t, "тест");
    if (!readFileSync(join(ROOT, m.process.artifacts.data), "utf8").includes(o.id)) fail(`${m.dir}: объект ${o.id} не описан в ${m.process.artifacts.data}`);
  }
  const ruleStatus = (id) => {
    const v = impl[id];
    if (!v || !(v.code ?? []).length) return "todo";
    return (v.tests ?? []).length ? "done" : "partial";
  };
  // раскрыть ссылку TZ → список единиц (правил или ограничений)
  const expand = (ref) => {
    if (constraints.has(ref)) return [{ kind: "nfr", id: ref }];
    if (rules.has(ref)) return [{ kind: "rule", id: ref }];
    if (svc.has(ref)) return [...rules.keys()].filter((r) => r.startsWith(ref + ".")).map((id) => ({ kind: "rule", id }));
    fail(`${m.dir}: ТЗ ссылается на неизвестный узел ${ref}`);
    return [];
  };
  const tzIds = new Set();
  for (const t of m.tz ?? []) {
    if (tzIds.has(t.id)) fail(`${m.dir}: пункт ${t.id} повторяется`);
    tzIds.add(t.id);
    const units = (t.to ?? []).flatMap(expand);
    if (!units.length) fail(`${m.dir}: пункт ${t.id} ни к чему не привязан`);
    const unitRows = units.map((u) => {
      if (u.kind === "nfr") {
        const c = constraints.get(u.id);
        const mode = c.mode ?? "prototype";
        let st = ruleStatus(u.id);
        if (st === "todo" && mode !== "prototype") st = "outside";
        return { ...u, text: c.title, mode, status: st, bo: "—", svc: "—", impl: impl[u.id] };
      }
      const svcId = u.id.split(".").slice(0, 2).join(".");
      const bo = svc.get(svcId)?.bo;
      return { ...u, text: rules.get(u.id), mode: t.mode ?? "prototype", status: ruleStatus(u.id), bo, svc: svcId, impl: impl[u.id] };
    });
    const sts = unitRows.map((r) => r.status);
    const inProto = sts.filter((s) => s !== "outside");
    let status;
    if (!inProto.length) status = "outside";
    else if (inProto.every((s) => s === "done")) status = "done";
    else if (inProto.some((s) => s !== "todo")) status = "partial";
    else status = t.mode && t.mode !== "prototype" ? "outside" : "todo";
    summary[status]++;
    rows.push({ tz: t, units: unitRows, status, process: m.process.id, boTitle: (id) => nodes.get(id)?.title });
  }
  // каталог TO-BE, метрики Матрицы и эшелоны тестов (T-129)
  const unitStatus = (id) => {
    if (rules.has(id)) return ruleStatus(id);
    if (!constraints.has(id)) return null;
    const st = ruleStatus(id);
    return st === "todo" && (constraints.get(id).mode ?? "prototype") !== "prototype" ? "outside" : st;
  };
  const catalog = buildCatalog(ROOT, m, { unitStatus, fail, unitTests: (id) => impl[id]?.tests ?? [] });
  // данные для карты трассы (TRACE-MAP.html)
  maps.push({
    catalog,
    process: m.process,
    business: m.business ?? [],
    services: (m.services ?? []).map((s) => ({
      id: s.id,
      bo: s.bo,
      title: svcText.get(s.id)?.title ?? "",
      statement: svcText.get(s.id)?.statement ?? "",
      rules: [...rules.keys()].filter((r) => r.startsWith(s.id + ".")).map((r) => ({ id: r, text: rules.get(r), status: ruleStatus(r), code: impl[r]?.code ?? [], tests: impl[r]?.tests ?? [] })),
    })),
    constraints: (m.constraints ?? []).map((c) => {
      let st = ruleStatus(c.id);
      if (st === "todo" && (c.mode ?? "prototype") !== "prototype") st = "outside";
      return { id: c.id, title: c.title, mode: c.mode ?? "prototype", adr: c.adr ?? null, status: st, code: impl[c.id]?.code ?? [], tests: impl[c.id]?.tests ?? [] };
    }),
    tz: rows.filter((r) => r.process === m.process.id).map((r) => ({ id: r.tz.id, title: r.tz.title, status: r.status, mode: r.tz.mode ?? "prototype", units: r.units.map((u) => u.id) })),
    gaps: m.gaps ?? [],
    sources: m.sources ?? [],
    decomposition: decompose(m, { rules, constraints, ruleStatus, impl }),
    tzDoc: null,
    dialogs: (m.dialogs ?? []).map((d) => ({ ...d, status: (d.code ?? []).length ? ((d.tests ?? []).length ? "done" : "partial") : "todo" })),
    data: (m.data ?? []).map((o) => ({ ...o, tests: o.tests ?? [], status: (o.code ?? []).length ? ((o.tests ?? []).length ? "done" : "partial") : "todo" })),
  });
}

// T-164: статус пункта ТЗ — честный цвет его атомов; пункт без атомов — по правилам трассы
const itemAtoms = new Map(maps.flatMap((mp) => (mp.decomposition?.sections ?? []).flatMap((s) => s.items.map((it) => [it.id, it.atoms]))));
const itemColor = (id, ruleSt) => { const at = itemAtoms.get(id); return at?.length ? aggColor(at.map((a) => a.color)) : RULE2COLOR[ruleSt]; };
for (const r of rows) { r.ruleStatus = r.status; r.status = itemColor(r.tz.id, r.status); }
for (const mp of maps) for (const t of mp.tz) { t.ruleStatus = t.status; t.status = itemColor(t.id, t.status); }
const colorSum = colorCounts(rows.map((r) => r.status));

for (const mp of maps) {
  const src = models.find((x) => x.process.id === mp.process.id);
  mp.tzDoc = buildTzDoc(ROOT, src, mp.decomposition);
  // детальная трасса: области ТЗ на странице PDF → атомы (T-097)
  const known = new Set([...(src.business ?? []), ...(src.gaps ?? [])].map((b) => b.id));
  mp.tzDetail = buildTzDetail(ROOT, mp.decomposition, { knownModel: (id) => known.has(id) });
  for (const e of mp.tzDetail?.errors ?? []) fail(`Детальная трасса: ${e}`);
  for (const b of mp.tzDoc?.unlinked ?? []) fail(`Карта ТЗ: абзац стр. ${b.page} не размечен — добавьте якорь пункта или решение в docs/tz/tz-blocks.yaml: «${b.text.replace(/\s+/g, " ").slice(0, 70)}»`);
}
// T-164: храповик аудита детальной трассы — счётчики расхождений разметки и карты только убывают
const traceAud = maps[0].decomposition ? traceAudit(ROOT, maps[0], { colorOf: (a) => a.color, itemColor: (at) => aggColor(at.map((a) => a.color)) }) : null;
if (traceAud) {
  const { errors: re } = ratchet(ROOT, traceAud.counts, { write: false });
  re.forEach(fail);
  if (process.argv.includes("--audit")) for (const [k, list] of Object.entries(traceAud.hits)) console.log(`${METRICS[k]} — ${list.length}\n${list.map((x) => "  · " + x).join("\n")}`);
}
// T-129: справочник операций каталога для паспорта параметра в API (data/seed/catalog-ops.json) — сборка его пишет,
// гейт сверяет, что он не отстал от документа-источника
const catOps = maps[0]?.catalog?.ops;
const catFile = join(ROOT, "data/seed/catalog-ops.json");
const catText = catOps ? JSON.stringify({ _about: "Генерируется pnpm trace из docs/research/TO-BE-операции-сравнения.md. Руками не править.", ops: Object.fromEntries(catOps.map((o) => [o.id, { title: o.title, layer: o.layer, layer_title: o.layerTitle, n: o.n }])) }, null, 1) + "\n" : null;
if (catText && CHECK_ONLY && (!existsSync(catFile) || readFileSync(catFile, "utf8") !== catText)) fail("data/seed/catalog-ops.json отстал от каталога TO-BE — выполните pnpm trace");
if (errors.length) {
  console.error(`Трасса: ${errors.length} ошибок`);
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
const total = rows.length;
const allAtoms = [...itemAtoms.values()].flat();
const aSum = colorCounts(allAtoms.map((a) => a.color)), iSum = colorCounts([...itemAtoms.values()].map((at) => aggColor(at.map((a) => a.color))));
console.log(`Трасса цела: пунктов ТЗ ${itemAtoms.size} — 🟢 ${iSum.green} · 🟡 ${iSum.yellow} · 🔴 ${iSum.red} · 🔵 ${iSum.blue}; атомов ${allAtoms.length} — 🟢 ${aSum.green} · 🟡 ${aSum.yellow} · 🔴 ${aSum.red} · 🔵 ${aSum.blue}`);
// аудит покрытия (T-141): вердикты критиков по каждому атому; атом без вердикта — не проверен аудитом
for (const mp of maps) mp.coverage = mp.decomposition ? coverage(mp.decomposition, audit) : null;
const cov = maps[0].coverage;
if (cov?.audit) console.log(`Аудит ${cov.audit.at}: тест проверяет критерий ТЗ у ${cov.total.real} из ${cov.total.n} (${cov.total.realPct} %), из них спорных ${cov.total.real - cov.total.realSure}`);
if (cov) console.log(`Покрытие ТЗ кодом: ${cov.total.pct} % — ${cov.total.done} из ${cov.total.n} требований (частично ${cov.total.partial}, нет кода ${cov.total.none}); ${cov.groups.map((g) => `${g.title.toLowerCase()} ${g.pct} %`).join(" · ")}`);
if (traceAud) console.log(`Храповик аудита трассы: ${Object.entries(traceAud.counts).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
if (CHECK_ONLY) process.exit(0);
if (traceAud) ratchet(ROOT, traceAud.counts, { write: true });
if (provenance) {
  writeFileSync(join(ROOT, "docs/trace/AUDIT-PROVENANCE.json"), JSON.stringify(provenance, null, 1) + "\n");
  writeFileSync(join(ROOT, "docs/trace/AUDIT-PROVENANCE.html"), renderProvenance(provenance));
}

// ─────────────────────────────── вывод: markdown
const today = new Date().toISOString().slice(0, 10);
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|");
const refs = (list) => (list ?? []).map((r) => "`" + r + "`").join("<br>") || "—";
let md = `---
id: TRACE-TZ
title: "Трассировочная таблица ТЗ"
type: trace
status: generated
owner: "@almaz"
last_verified: ${today}
traces_to: [GERA-INSP-SERVICES]
tags: [trace, tz]
---

# Трассировочная таблица ТЗ

> Генерируется \`pnpm trace\` из \`docs/gera/*/model.yaml\` и \`03-services.md\`. Руками не править.

Пунктов ТЗ в трассе модели: **${total}** — 🟢 реализовано и проверено ${colorSum.green} · 🟡 частично ${colorSum.yellow} · 🔴 не реализовано ${colorSum.red} · 🔵 код готов, ждёт стенда ${colorSum.blue}

Статус пункта — честный цвет его атомов (\`scripts/tz-color.mjs\`): 🟢 код делает требуемое и тест проверяет критерий
(вердикт критиков REAL); 🟡 код есть, критерий закрыт не полностью; 🔴 кода нет; 🔵 вне прототипа, код готов.
Статус правила: есть код и тест — ✅; есть код без теста — 🟡; нет кода — ⬜.
«Вне прототипа» — требование проверяется только на GPU-стенде или в эксплуатационном контуре (ADR-0001).

| Пункт ТЗ | Требование | Операция | Правило / ограничение | Код | Тест | Статус |
|---|---|---|---|---|---|---|
`;
for (const r of rows) {
  r.units.forEach((u, i) => {
    md += `| ${i ? "" : `**${r.tz.id}**`} | ${i ? "" : esc(r.tz.title)} | ${u.bo === "—" ? "—" : `${u.bo} ${esc(r.boTitle(u.bo))}`} | **${u.id}** ${esc(u.text)} | ${refs(u.impl?.code)} | ${refs(u.impl?.tests)} | ${STATUS[u.status].icon}${i ? "" : ` → **${STATUS[r.status].icon}**`} |\n`;
  });
}
mkdirSync(join(ROOT, "docs/trace"), { recursive: true });
writeFileSync(join(ROOT, "docs/trace/TRACE-TZ.md"), md);

// ─────────────────────────────── вывод: html
const h = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pill = (st) => `<span class="pill ${st}">${STATUS[st].ru}</span>`;
let body = "";
for (const r of rows) {
  const units = r.units
    .map(
      (u) => `<tr class="unit"><td></td><td class="mono">${h(u.bo === "—" ? "—" : u.bo)}<div class="sub">${h(u.bo === "—" ? "" : r.boTitle(u.bo))}</div></td>
<td><span class="mono">${h(u.id)}</span> ${h(u.text)}</td><td class="mono small">${(u.impl?.code ?? []).map(h).join("<br>") || "—"}</td>
<td class="mono small">${(u.impl?.tests ?? []).map(h).join("<br>") || "—"}</td><td>${pill(u.status)}</td></tr>`,
    )
    .join("");
  body += `<tbody data-status="${r.status}" data-text="${h((r.tz.id + " " + r.tz.title).toLowerCase())}">
<tr class="head"><td class="mono strong">${h(r.tz.id)}</td><td colspan="4" class="strong">${h(r.tz.title)}</td><td>${pill(r.status)}</td></tr>${units}</tbody>`;
}
const pct = (n) => Math.round((100 * n) / total);
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Трасса ТЗ</title><style>
:root{--bg:#f5f6fa;--card:#fff;--ink:#1f2330;--mute:#6b7185;--line:#e6e8f0;--brand:#6c4cf5;--done:#1f9d55;--partial:#e8a200;--todo:#9aa0b4;--outside:#4b7bec;--red:#d6454a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line);padding:20px 24px}h1{margin:0;font-size:20px}header p{margin:4px 0 0;color:var(--mute)}
.wrap{padding:20px 24px;max-width:1400px;margin:0 auto}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;cursor:pointer}.tile b{font-size:26px;display:block}.tile.on{outline:2px solid var(--brand)}
.bar{display:flex;height:8px;border-radius:8px;overflow:hidden;margin:0 0 16px;background:var(--line)}.bar i{display:block}
input{width:100%;max-width:420px;padding:9px 12px;border:1px solid var(--line);border-radius:8px;font:inherit;margin-bottom:12px;background:#fff}
.tbl{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:auto}table{border-collapse:collapse;width:100%;min-width:900px}
th{position:sticky;top:0;background:#fafbfe;text-align:left;font-weight:600;color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.03em;padding:10px 12px;border-bottom:1px solid var(--line)}
td{padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}tr.head td{background:#fcfcff}tr.unit td{font-size:13px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.small{font-size:12px;color:var(--mute)}.strong{font-weight:600}.sub{color:var(--mute);font-family:inherit;font-size:12px}
.pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;color:#fff;white-space:nowrap}
.pill.done{background:var(--done)}.pill.partial{background:var(--partial)}.pill.todo{background:var(--todo)}.pill.outside{background:var(--outside)}.pill.green{background:var(--done)}.pill.yellow{background:var(--partial)}.pill.red{background:var(--red)}.pill.blue{background:var(--outside)}.pill.grey{background:var(--todo)}
</style></head><body><header><h1>Трассировочная таблица ТЗ — Инспектор ИИ</h1><p>Пункт ТЗ → операция → правило сервиса → код → тест. Собрано ${today}.</p></header>
<div class="wrap"><div class="tiles">
<div class="tile" data-f="all"><b>${total}</b>пунктов ТЗ</div>
<div class="tile" data-f="green"><b style="color:var(--done)">${colorSum.green}</b>реализовано и проверено · ${pct(colorSum.green)}%</div>
<div class="tile" data-f="yellow"><b style="color:var(--partial)">${colorSum.yellow}</b>частично · ${pct(colorSum.yellow)}%</div>
<div class="tile" data-f="red"><b style="color:var(--red)">${colorSum.red}</b>не реализовано · ${pct(colorSum.red)}%</div>
<div class="tile" data-f="blue"><b style="color:var(--outside)">${colorSum.blue}</b>код готов, ждёт стенда</div></div>
<div class="bar"><i style="width:${pct(colorSum.green)}%;background:var(--done)"></i><i style="width:${pct(colorSum.yellow)}%;background:var(--partial)"></i><i style="width:${pct(colorSum.red)}%;background:var(--red)"></i><i style="width:${pct(colorSum.blue)}%;background:var(--outside)"></i></div>
<input id="q" placeholder="Поиск по пункту ТЗ…">
<div class="tbl"><table><thead><tr><th>Пункт</th><th>Операция</th><th>Правило / ограничение</th><th>Код</th><th>Тест</th><th>Статус</th></tr></thead>${body}</table></div></div>
<script>
let f="all";const q=document.getElementById("q");
function apply(){const s=q.value.toLowerCase();document.querySelectorAll("tbody").forEach(b=>{b.style.display=(f==="all"||b.dataset.status===f)&&b.dataset.text.includes(s)?"":"none"})}
document.querySelectorAll(".tile").forEach(t=>t.onclick=()=>{f=t.dataset.f;document.querySelectorAll(".tile").forEach(x=>x.classList.toggle("on",x===t));apply()});q.oninput=apply;
</script></body></html>`;
writeFileSync(join(ROOT, "docs/trace/TRACE-TZ.html"), html);

// ─────────────────────────────── доска задач
const COLS = [
  ["00-backlog", "Бэклог"],
  ["01-todo", "К выполнению"],
  ["02-in-progress", "В работе"],
  ["03-testing", "Проверка"],
  ["04-done", "Готово"],
];
let board = `# Доска задач\n\n> Генерируется \`pnpm trace\` из папок \`tasks/*\`. Статус задачи = папка.\n\n`;
for (const [dir, title] of COLS) {
  const p = join(ROOT, "tasks", dir);
  const files = existsSync(p) ? readdirSync(p).filter((f) => f.endsWith(".md")).sort() : [];
  board += `## ${title} (${files.length})\n\n`;
  for (const f of files) {
    const t = readFileSync(join(p, f), "utf8");
    const title = t.match(/^title:\s*"?(.*?)"?$/m)?.[1] ?? f;
    const traces = t.match(/^traces:\s*\[(.*)\]$/m)?.[1] ?? "";
    board += `- [${f.slice(0, 5)}](${dir}/${f}) ${title}${traces ? ` — _${traces}_` : ""}\n`;
  }
  board += "\n";
}
writeFileSync(join(ROOT, "tasks/BOARD.md"), board);
writeFileSync(join(GERA, "TRACE-MAP.html"), renderTraceMap(maps, { today, root: ROOT }));
if (catText) writeFileSync(catFile, catText);
writeFileSync(join(GERA, "ARCHITECTURE.html"), renderArchMap({ today, root: ROOT }));
writeFileSync(join(GERA, "PIPELINE.html"), renderPipelineMap({ today, root: ROOT }));
if (maps[0].decomposition) writeFileSync(join(ROOT, "docs/tz/TZ-DECOMPOSITION.md"), renderDecomposition(maps[0].decomposition, today, cov));
// покрытие ТЗ кодом для витрины демо-стенда (scripts/demo-docs.mjs)
if (cov) writeFileSync(join(ROOT, "docs/trace/TZ-COVERAGE.json"), JSON.stringify({ _about: "Генерируется pnpm trace. Руками не править.", built: today, ...cov }, null, 1) + "\n");
console.log("Собрано: docs/trace/TRACE-TZ.md, docs/trace/TRACE-TZ.html, docs/gera/TRACE-MAP.html, docs/gera/ARCHITECTURE.html, docs/gera/PIPELINE.html, docs/tz/TZ-DECOMPOSITION.md, docs/trace/TZ-COVERAGE.json, tasks/BOARD.md");
