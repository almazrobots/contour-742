// Карта трассы требований ГЕРЫ — docs/gera/TRACE-MAP.html.
// Идея эталона сохранена: колонки — этажи метода слева направо (откуда известен факт → что делает бизнес →
// что должна делать система → чем сделано → чем проверено), связи — кривые, клик подсвечивает трассу.
// Цветографика — вариант B (согласован 2026-09-24). Чтение исходных требований — варианты 1 + 3:
// вкладка «Текст» в правой панели и режим «ТЗ ↔ модель».
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gapEvidence } from "./trace-gaps.mjs";
import { COLOR_RU, aggColor, colorCounts } from "./tz-color.mjs";
import { DOC_NAV_CSS, renderDocNav } from "./doc-nav.mjs";

const GAPS_JS = readFileSync(new URL("./trace-gaps.client.js", import.meta.url), "utf8");
const DETAIL_CSS = readFileSync(new URL("./trace-detail.css", import.meta.url), "utf8");
const DETAIL_JS = readFileSync(new URL("./trace-detail.client.js", import.meta.url), "utf8");

const FLOORS = [
  { key: "SRC", n: "0", title: "Источники", sub: "обследование", sys: false, hide: true },
  { key: "TZ", n: "ТЗ", title: "Пункт ТЗ", sub: "что требуют", sys: false },
  { key: "BP", n: "1", title: "Бизнес-процесс", sub: "", sys: false, hide: true },
  { key: "BF", n: "2", title: "Бизнес-функция", sub: "", sys: false, hide: true },
  { key: "BO", n: "3", title: "Бизнес-операция", sub: "", sys: false },
  { key: "OS", n: "RS", title: "Сервис операции", sub: "граница спецификации", sys: true },
  { key: "FS", n: "RS", title: "Функции сервиса", sub: "= требования · НФТ", sys: true },
  { key: "DLG", n: "4", title: "Диалог", sub: "сценарий сервиса · экран", sys: false },
  { key: "MOD", n: "5", title: "Программный модуль", sub: "чем сделано", sys: false },
  { key: "DATA", n: "6", title: "Данные", sub: "информационная модель", sys: false },
  { key: "TEST", n: "7", title: "Тест", sub: "чем проверено", sys: false },
];

const refFile = (ref) => ref.split("::")[0];
const refName = (ref) =>
  (ref.split("::")[1] ?? "")
    .replace(/^export (async )?function /, "")
    .replace(/^def /, "")
    .trim();

export function renderTraceMap(maps, { today, root }) {
  const m = maps[0];
  const passages = (() => {
    const p = join(root, "data/seed/tz-passages.json");
    return existsSync(p) ? Object.fromEntries(JSON.parse(readFileSync(p, "utf8")).map((x) => [x.id, x])) : {};
  })();

  // ─────────────── узлы и связи
  const nodes = [];
  const edges = [];
  const add = (n) => (nodes.push(n), n);
  const link = (a, b) => edges.push([a, b]);
  const bfs = m.business.filter((n) => n.level === "BF");
  const bos = m.business.filter((n) => n.level === "BO");
  const bp = m.business.find((n) => n.level === "BP");
  const svcByBo = new Map(m.services.map((s) => [s.bo, s]));
  const ruleById = new Map(m.services.flatMap((s) => s.rules.map((r) => [r.id, { ...r, svc: s }])));
  const nfrById = new Map(m.constraints.map((c) => [c.id, c]));
  const agg = (sts) => (!sts.length ? "todo" : sts.every((s) => s === "done") ? "done" : sts.some((s) => s !== "todo") ? "partial" : "todo");

  const bands = [...bfs.map((bf) => ({ id: bf.id, title: bf.title })), { id: "NFR", title: "Ограничения — нефункциональные требования (допущение проекта: у автора метода НФТ нет)" }];
  const bandOfBo = new Map(bos.map((b) => [b.id, b.parent]));

  for (const s of m.sources) add({ id: s.id, floor: "SRC", band: bfs[0].id, title: s.title, kind: s.kind, ref: s.ref ?? null });
  add({ id: bp.id, floor: "BP", band: bfs[0].id, title: bp.title, from: bp.from ?? [] });
  for (const s of bp.from ?? []) link(s, bp.id);
  for (const bf of bfs) {
    add({ id: bf.id, floor: "BF", band: bf.id, title: bf.title, from: bf.from ?? [] });
    link(bp.id, bf.id);
    for (const s of bf.from ?? []) link(s, bf.id);
  }
  const codeCards = new Map(); // band|ref → id
  const codeCard = (band, ref, floor) => {
    const key = `${band}|${ref}`;
    if (!codeCards.has(key)) {
      const id = `${floor}:${band}:${codeCards.size}`;
      codeCards.set(key, id);
      add({ id, floor, band, ref, file: refFile(ref), name: refName(ref) });
    }
    return codeCards.get(key);
  };
  for (const bo of bos) {
    const s = svcByBo.get(bo.id);
    const st = s ? agg(s.rules.map((r) => r.status)) : "none";
    add({ id: bo.id, floor: "BO", band: bo.parent, title: bo.title, system: bo.system !== false, why: bo.why ?? null, status: st, rules: s ? s.rules.length : 0, done: s ? s.rules.filter((r) => r.status === "done").length : 0 });
    link(bo.parent, bo.id);
    if (!s) continue;
    add({ id: s.id, floor: "OS", band: bo.parent, title: s.title, statement: s.statement, status: st });
    link(bo.id, s.id);
    for (const r of s.rules) {
      add({ id: r.id, floor: "FS", band: bo.parent, title: r.text, status: r.status, code: r.code, tests: r.tests, svc: s.id });
      link(s.id, r.id);
      for (const c of r.code) link(r.id, codeCard(bo.parent, c, "MOD"));
      for (const t of r.tests) link(r.id, codeCard(bo.parent, t, "TEST"));
    }
  }
  for (const c of m.constraints) {
    add({ id: c.id, floor: "FS", band: "NFR", title: c.title, status: c.status, nfr: true, mode: c.mode, adr: c.adr, code: c.code, tests: c.tests });
    for (const r of c.code) link(c.id, codeCard("NFR", r, "MOD"));
    for (const t of c.tests) link(c.id, codeCard("NFR", t, "TEST"));
  }
  // этаж 4: диалог — в полосе каждого сервиса, чей сценарий он реализует (копия карточки на полосу)
  const svcBand = new Map(m.services.map((s) => [s.id, bandOfBo.get(s.bo)]));
  const multi = new Map(); // floor|band|key → id карточки
  const multiCard = (floor, band, key, extra) => {
    const k = `${floor}|${band}|${key}`;
    if (!multi.has(k)) {
      const id = `${floor}:${band}:${key}`;
      multi.set(k, id);
      add({ id, floor, band, key, ...extra });
    }
    return multi.get(k);
  };
  for (const d of m.dialogs ?? []) {
    const bandsOf = d.services.length ? [...new Set(d.services.map((sv) => svcBand.get(sv)))] : ["NFR"];
    for (const band of bandsOf) {
      const id = multiCard("DLG", band, d.id, { title: d.title, status: d.status, services: d.services, code: d.code, tests: d.tests, real: d.id });
      for (const sv of d.services.filter((x) => svcBand.get(x) === band)) link(sv, id);
      if (!d.services.length) for (const c of d.nfr ?? ["NFR-AUTH", "NFR-ROLES"]) if (nfrById.has(c)) link(c, id);
      for (const c of d.code) link(id, codeCard(band, c, "MOD"));
      for (const t of d.tests) link(id, codeCard(band, t, "TEST"));
    }
  }
  // этаж 6: объект данных — в полосе каждой операции, которая его рождает или читает
  for (const o of m.data ?? []) {
    const ops = [...o.new_in.map((b) => [b, "рождает"]), ...o.used_by.map((b) => [b, "читает"])];
    for (const [bo, how] of ops) {
      const band = bandOfBo.get(bo);
      const s = svcByBo.get(bo);
      if (!band || !s) continue;
      const id = multiCard("DATA", band, o.id, { title: o.title, table: o.table, cls: o.class, new_in: o.new_in, used_by: o.used_by, code: o.code, status: o.status, real: o.id });
      if (!edges.some(([a, b]) => a === s.id && b === id)) link(s.id, id);
      void how;
    }
  }

  // пункты ТЗ: связь с операцией (правила) или с НФТ; карточка — в полосе первой связанной операции
  for (const t of m.tz) {
    const targets = [];
    for (const u of t.units) {
      if (ruleById.has(u)) targets.push(ruleById.get(u).svc.bo);
      else if (nfrById.has(u)) targets.push(u);
    }
    const uniq = [...new Set(targets)];
    const firstBo = uniq.find((x) => bandOfBo.has(x));
    add({ id: t.id, floor: "TZ", band: firstBo ? bandOfBo.get(firstBo) : "NFR", title: t.title, status: t.status, mode: t.mode, units: t.units, passage: passages[t.id] ?? null });
    for (const x of uniq) link(t.id, x);
  }

  const counts = {
    ops: bos.length,
    outside: bos.filter((b) => b.system === false).length,
    rules: nodes.filter((n) => n.floor === "FS" && !n.nfr).length,
    tested: nodes.filter((n) => n.floor === "FS" && !n.nfr && n.tests.length).length,
    tz: m.tz.length,
    tzBy: Object.fromEntries(["done", "partial", "todo", "outside"].map((k) => [k, m.tz.filter((t) => t.status === k).length])),
    gaps: m.gaps.filter((g) => g.status === "open").length,
    nfr: m.constraints.length,
    dialogs: (m.dialogs ?? []).length,
    dialogsTested: (m.dialogs ?? []).filter((d) => d.tests.length).length,
    data: (m.data ?? []).length,
  };
  const dz = m.decomposition;
  const atoms = dz ? dz.sections.flatMap((sec) => sec.items.flatMap((it) => it.atoms.map((a) => ({ id: a.id, t: a.t, kind: a.kind, method: a.method, accept: a.accept, trace: a.trace ?? [], scope: a.scope, verdict: a.verdict, color: a.color, why: a.why, code: a.code, ready: !!a.ready, note: a.note ?? null, prio: a.prio ?? null, item: it.id, itemTitle: it.title, itemNew: !!it.new, section: sec.id, sectionTitle: sec.title })))) : [];
  const gapReview = JSON.parse(readFileSync(join(root, "docs/trace/GAPS-REVIEW.json"), "utf8"));
  const gaps = m.gaps.map((g) => ({ ...g, review: gapReview.model[g.id] ?? null }));
  const gapAudit = JSON.parse(readFileSync(join(root, "docs/trace/COVERAGE-AUDIT.json"), "utf8"));
  for (const atom of atoms) atom.gapEvidence = gapEvidence(atom, nodes, gapAudit);
  counts.atoms = atoms.length;
  // T-164: одна шкала — честный цвет атома; пункт ТЗ (все пункты декомпозиции, не только трассы модели) — по его атомам
  counts.atomsBy = colorCounts(atoms.map((a) => a.color));
  const items = (dz?.sections ?? []).flatMap((sec) => sec.items);
  counts.items = items.length;
  counts.itemsBy = colorCounts(items.map((it) => aggColor(it.atoms.map((a) => a.color))));
  // сверх ТЗ: узлы модели, до которых не доходит ни один атом, — дополнительные функции или неподвязанная трасса
  const traced = new Set(atoms.flatMap((a) => a.trace));
  const extra = {
    rules: nodes.filter((n) => n.floor === "FS" && !n.nfr && !traced.has(n.id)).map((n) => ({ id: n.id, t: n.title, status: n.status, svc: n.svc })),
    nfr: m.constraints.filter((c) => !traced.has(c.id)).map((c) => ({ id: c.id, t: c.title, status: c.status })),
    dialogs: (m.dialogs ?? []).filter((d) => !traced.has(d.id)).map((d) => ({ id: d.id, t: d.title, status: d.status })),
    data: (m.data ?? []).filter((o) => !traced.has(o.id)).map((o) => ({ id: o.id, t: o.title, status: o.status })),
  };
  counts.extra = extra.rules.length + extra.nfr.length + extra.dialogs.length + extra.data.length;
  const dataIndex = Object.fromEntries((m.data ?? []).map((o) => [o.id, o]));
  const dialogIndex = Object.fromEntries((m.dialogs ?? []).map((d) => [d.id, d]));
  const detail = m.tzDetail ? { sections: m.tzDetail.sections } : null;
  const data = { extra, detail, floors: FLOORS, bands, nodes, edges, gaps, process: m.process, counts, today, dataIndex, dialogIndex, bos: Object.fromEntries(bos.map((b) => [b.id, b.title])), atoms, tzDoc: m.tzDoc ? m.tzDoc.pages.map((p) => ({ page: p.page, blocks: p.blocks.map((b) => ({ n: b.n, kind: b.kind, text: b.text, item: b.item ?? null, also: b.also ?? [], none: b.none ?? null, note: b.note ?? null, atoms: b.atoms ?? [], cont: !!b.cont })) })) : [], items: Object.fromEntries((dz?.sections ?? []).flatMap((sec) => sec.items.map((it) => [it.id, { title: it.title, section: sec.title, isNew: !!it.new }]))) };
  // T-129: каталог TO-BE, метрики и эшелоны тестов правил
  const ech = m.catalog?.echelonsOf ?? (() => null);
  for (const n of nodes) if (n.floor === "FS") n.echelons = [...new Set((n.tests ?? []).flatMap((t) => ech(t) ?? []))].sort();
  data.coverage = m.coverage ?? null;
  data.catalog = m.catalog ? { ops: m.catalog.ops, metrics: m.catalog.metrics, inventory: m.catalog.inventory } : null;
  data.ruleText = Object.fromEntries(nodes.filter((n) => n.floor === "FS").map((n) => [n.id, { t: n.title, st: n.status }]));
  const json = JSON.stringify(data).replace(/</g, "\\u003c");

  const fonts = ["onest-var", "golos-text-var", "jetbrains-mono-var"].map((f) => {
    const p = join(root, "apps/web/public/fonts", `${f}.woff2`);
    return existsSync(p) ? readFileSync(p).toString("base64") : "";
  });

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Карта трассы ГЕРА</title>
<style>
@font-face{font-family:"Onest";src:url(data:font/woff2;base64,${fonts[0]}) format("woff2");font-weight:100 900}
@font-face{font-family:"Golos Text";src:url(data:font/woff2;base64,${fonts[1]}) format("woff2");font-weight:400 900}
@font-face{font-family:"JetBrains Mono";src:url(data:font/woff2;base64,${fonts[2]}) format("woff2");font-weight:100 800}
:root{
  --ground:#F1F2F6;--band:#F7F7FA;--card:#FFFFFF;--ink:#1D1F2E;--ink2:#474B62;--mute:#6B6F85;--line:#D9DBE5;--line2:#E6E7EE;
  --rs:#3B4FA8;--rs-ink:#FFFFFF;--rs-soft:#EAEDF8;--rs-line:#A9B2D8;--link:#C3C8DE;
  --done:#2E9E6B;--done-soft:#E4F6ED;--part:#E0A21A;--part-soft:#FFF4DC;--todo:#9097AD;--todo-soft:#EEF0F5;--out:#4B7BEC;--out-soft:#E8F0FF;--red:#D6454A;
  --mark:#FFF1C2;--radius:6px;--shadow:0 1px 2px rgba(23,24,43,.06);
  --sans:"Golos Text",system-ui,sans-serif;--head:"Onest","Golos Text",system-ui,sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
  --panel:clamp(380px,28vw,470px);
}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--ground);color:var(--ink);font:13px/1.45 var(--sans);display:flex;flex-direction:column;overflow:hidden}
button{font:inherit;color:inherit;cursor:pointer}
:focus-visible{outline:2px solid var(--rs);outline-offset:2px}
.mono{font-family:var(--mono)}
header{background:var(--card);border-bottom:1px solid var(--line);padding:12px 18px 10px;display:flex;flex-direction:column;gap:8px}
.h1row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
h1{font:700 19px/1.2 var(--head);margin:0;letter-spacing:-.01em}
.proc{border:1px solid var(--line);border-radius:var(--radius);padding:4px 10px;font-weight:600}
.codes{font:500 12px var(--mono);color:var(--rs)}
.stats{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--ink2)}.stats b{font-family:var(--head);color:var(--ink)}
.stats .ok{color:var(--done)}.stats .pt{color:#9a6a00}.stats .ot{color:var(--out)}.stats .bad{color:var(--red)}
.summary-drawer{position:relative;z-index:25;flex:none;align-self:flex-start}
.summary-drawer summary{list-style:none;cursor:pointer;display:inline-block;padding:6px 12px;font:700 12px var(--head);color:var(--ink2);background:var(--card);border:1px solid var(--line);border-top:0;border-radius:0 0 var(--radius) 0;box-shadow:0 2px 5px rgba(23,24,43,.1)}
.summary-drawer summary::-webkit-details-marker{display:none}.summary-drawer summary::before{content:"＋";display:inline-block;width:20px;color:var(--rs)}
.summary-drawer[open] summary::before{content:"−"}
.summary-drawer:not([open]) #stats{display:none}
.summary-drawer #stats{position:absolute;left:0;top:100%;width:min(390px,calc(100vw - 34px));max-height:65dvh;overflow:auto;padding:8px 12px 12px;display:flex;flex-direction:column;gap:7px;font-size:12px;background:var(--card);border:1px solid var(--line);border-left:0;border-radius:0 var(--radius) var(--radius) 0;box-shadow:0 8px 28px rgba(23,24,43,.2)}
.summary-drawer #stats>span{padding:5px 7px;background:var(--band);border-radius:4px}
${DOC_NAV_CSS}
.views{margin-left:auto;display:flex;gap:4px}
.views button{border:1px solid transparent;background:none;border-radius:var(--radius);padding:5px 12px;font-weight:600;color:var(--mute)}
.views button.on{border-color:var(--line);background:var(--ground);color:var(--ink)}
.views .navlink{border:1px solid transparent;border-radius:var(--radius);padding:5px 12px;font-weight:600;color:var(--mute);text-decoration:none}
.views .navlink:hover{color:var(--ink)}
.tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.tools input{border:1px solid var(--line);border-radius:var(--radius);padding:5px 10px;font:12px var(--mono);width:250px;background:#fff}
.btn{border:1px solid var(--line);background:var(--card);border-radius:var(--radius);padding:5px 11px;font-weight:600;font-size:12px}
.btn.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.legend[hidden]{display:none}.legend{margin-left:auto;display:flex;gap:12px;flex-wrap:wrap;color:var(--mute);font-size:11.5px;align-items:center}
.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:4px;vertical-align:-2px}
.intro{background:var(--band);border-bottom:1px solid var(--line);padding:7px 18px;color:var(--ink2);font-size:12.5px}
.intro b{color:var(--ink)}.rsmark{display:inline-block;background:var(--rs);color:#fff;font:700 11px var(--head);border-radius:4px;padding:0 5px}
main{flex:1;min-height:0;display:grid;grid-template-columns:1fr var(--panel)}
.stage{overflow:auto;position:relative}
.panel{background:var(--card);border-left:1px solid var(--line);overflow:auto;display:flex;flex-direction:column}

/* ─────────── покрытие ТЗ кодом (T-141) */
.cv{max-width:1180px;margin:0 auto;padding:22px 22px 60px}
.cv h2{font:700 22px/1.2 var(--head);margin:0 0 4px;letter-spacing:-.01em}.cv .lead{color:var(--ink2);margin:0 0 18px;max-width:92ch;font-size:13.5px}
.cvhero{display:grid;grid-template-columns:minmax(260px,1.3fr) repeat(3,minmax(170px,1fr));gap:12px;margin-bottom:14px}
.cvk{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;box-shadow:var(--shadow)}
.cvk .big{font:800 46px/1 var(--head);letter-spacing:-.02em;color:var(--ink)}.cvk .mid{font:800 30px/1.05 var(--head);letter-spacing:-.01em}
.cvk .cap{font-weight:600;margin-top:6px}.cvk .sub{color:var(--mute);font-size:12px;margin-top:4px}
.cvk.main{border-left:5px solid var(--mute)}
.cvbar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--todo-soft);margin-top:10px}.cvbar i{display:block;height:100%}
.cvbar .d{background:var(--mute)}.cvbar .p{background:var(--part)}
.cvgroups{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:0 0 22px}
.cvg{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:13px 16px}
.cvg .row1{display:flex;align-items:baseline;gap:10px}.cvg b{font:700 15px var(--head)}.cvg .p{margin-left:auto;font:800 24px var(--head)}
.cvg .w{color:var(--mute);font-size:12px;margin-top:2px}
.cvtab{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.cvh,.cvr{display:grid;grid-template-columns:minmax(230px,2.1fr) minmax(160px,2fr) 64px 92px 96px;gap:14px;align-items:center;padding:9px 16px}
.cvh{background:var(--band);color:var(--mute);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--line)}
.cvgh{padding:12px 16px 6px;font:700 12px var(--head);color:var(--rs);text-transform:uppercase;letter-spacing:.05em;background:var(--ground);border-top:1px solid var(--line)}
.cvr{border:0;border-top:1px solid var(--line2);background:none;width:100%;text-align:left}
.cvr:hover{background:#FAFAFC}.cvr .t b{display:block;font-weight:700;font-size:13.5px}.cvr .t span{color:var(--mute);font-size:11.5px}
.cvr .bar{display:flex;height:9px;border-radius:5px;overflow:hidden;background:var(--todo-soft)}.cvr .bar i{height:100%}
.cvr .pc{font:800 17px var(--head);text-align:right}.cvr .n{color:var(--ink2);font-size:12px;text-align:right}.cvr .acc{color:var(--mute);font-size:12px;text-align:right}
.pc.full{color:var(--done)}.pc.low{color:var(--red)}
.cvopen{padding:4px 16px 12px 16px;background:#FCFCFE;border-top:1px dashed var(--line2)}
.cvopen div{display:grid;grid-template-columns:110px 1fr;gap:10px;padding:5px 0;border-bottom:1px solid var(--line2);font-size:12.5px}
.cvopen .why{grid-column:2;color:var(--mute);font-size:11.5px;margin-top:-4px}
.cvopen .ok{color:var(--done);font-weight:600;padding:8px 0}
.hist{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin:0 0 18px}.hist h3{font:700 15px var(--head);margin:4px 0 6px}.hist .goal{color:var(--ink2);margin:0 0 10px;font-size:13.5px}
.prog{position:relative;height:26px;border-radius:6px;background:var(--todo-soft);overflow:hidden;margin:0 0 12px}.prog i{position:absolute;left:0;top:0;bottom:0;background:var(--done);opacity:.35}.prog span{position:relative;display:block;padding:4px 10px;font-weight:700;font-size:12.5px}
.hist table{border-collapse:collapse;width:100%;font-size:12.5px}.hist th,.hist td{border-bottom:1px solid var(--line2);padding:6px 8px;text-align:left;vertical-align:top}.hist th{color:var(--mute);font-size:11px;text-transform:uppercase;letter-spacing:.04em}.hist .w{color:var(--mute);font-size:12px;margin:8px 0 0}
.st{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:700;color:#fff}.st-open{background:var(--red)}.st-closed{background:var(--done)}
.concl{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--red);border-radius:10px;padding:14px 18px;margin:0 0 18px}
.concl h3{font:700 15px var(--head);margin:4px 0 8px}.concl ol,.concl ul{margin:0 0 10px;padding-left:20px}.concl li{margin:5px 0;color:var(--ink2);font-size:13.5px;line-height:1.5}
.defs .tk{font:600 11px var(--mono);color:var(--rs);margin-left:4px}
.funnel{display:flex;flex-direction:column;gap:8px;margin:0 0 18px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.fn{position:relative;min-height:44px;display:flex;align-items:center}.fnb{position:absolute;left:0;top:0;bottom:0;border-radius:6px;opacity:.22}
.fnt{position:relative;padding:4px 10px;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.fnt b{font:800 26px var(--head)}.fnt span{font-weight:700;font-size:14px}.fnt small{color:var(--ink2);font-size:12px;flex-basis:100%}
.bar2{display:flex;flex-direction:column;gap:3px}.bar2 .bar{height:7px}
.v{font-weight:700;margin-right:4px}.v-NOT_IMPLEMENTED,.v-BROKEN_LINK{color:var(--red)}.v-WEAK_TEST,.v-NO_TEST,.v-CALC_ONLY{color:#9a6a00}.v-UNDERCOUNTED{color:var(--out)}
.cvnote{color:var(--mute);font-size:12px;margin-top:16px;max-width:110ch;line-height:1.55}
@media (max-width:820px){.cvhero{grid-template-columns:1fr 1fr}.cvh{display:none}.cvr{grid-template-columns:1fr 60px;row-gap:6px}.cvr .bar{grid-column:1/-1}.cvr .n,.cvr .acc{display:none}}

/* ─────────── карта */
.map{position:relative;min-width:max-content;padding-bottom:40px}
.grid{display:grid;grid-template-columns:var(--cols)}
.floors{position:sticky;top:0;z-index:4}
.fl{background:var(--card);border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:8px 10px 7px}
.fl b{display:block;font:700 17px/1.1 var(--head)}.fl span{font-weight:600;font-size:12px}.fl small{display:block;color:var(--mute);font-size:10.5px;min-height:14px}
.fl.sys{background:var(--rs);color:var(--rs-ink);border-color:var(--rs)}.fl.sys small{color:rgba(255,255,255,.78)}
.bandhead{grid-column:1/-1;display:flex;gap:10px;align-items:baseline;padding:14px 12px 6px;border-top:1px solid var(--line);background:var(--ground)}
.bandhead b{font:700 13.5px var(--head)}.bandhead .mono{font-size:11px;color:var(--mute)}
.bandhead .prog{margin-left:6px;font-size:11.5px;color:var(--mute)}
.col{padding:6px 7px 10px;border-right:1px solid var(--line2);display:flex;flex-direction:column;gap:7px;min-width:0}
svg.links{position:absolute;inset:0;pointer-events:none;z-index:1;overflow:visible}
svg.links path{fill:none;stroke:var(--link);stroke-width:1.2;opacity:.9}
svg.links path.hot{stroke:var(--rs);stroke-width:2;opacity:1}
.tracing svg.links path:not(.hot){opacity:.12}
.k{position:relative;z-index:2;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:6px 9px 7px;box-shadow:var(--shadow);text-align:left;width:100%;transition:opacity .15s}
.k:hover{border-color:var(--rs-line)}
.k .id{font:500 10.5px var(--mono);color:var(--mute);letter-spacing:.01em;display:flex;gap:6px}
.k .t{font-weight:600;font-size:12.5px;overflow-wrap:anywhere}
.k .t.clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.k.src .t{font-weight:500;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}
.k.bp .t{font-size:13.5px}
.k.os{background:var(--rs);color:var(--rs-ink);border-color:var(--rs)}.k.os .id{color:rgba(255,255,255,.78)}
.k.fs{background:var(--rs-soft);border-color:var(--rs-line);border-left:4px solid var(--c)}.k.fs .t{font-weight:500}
.k.nfr{background:repeating-linear-gradient(135deg,#fff 0 6px,var(--todo-soft) 6px 8px);border-color:var(--line)}
.k.tz{border-left:4px solid var(--c)}.k.tz .t{font-weight:500}
.k.bo.off{border-style:dashed;background:var(--band)}
.k.code .t,.k.test .t{font:500 11.5px/1.35 var(--mono)}.k.code .sub,.k.test .sub{color:var(--mute);font-size:10.5px;font-family:var(--mono);overflow-wrap:anywhere}
.k.test .t{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-family:var(--sans);font-weight:500}
.k.dlg{border-left:4px solid var(--c)}.k.dlg .t{font-weight:600}
.k.data{background:var(--band);border-style:solid;border-left:4px solid #8E7CC3}.k.data .t{font-weight:600}.k.data .sub{color:var(--mute);font:500 10.5px var(--mono);overflow-wrap:anywhere}
.k.sel{outline:2px solid var(--rs);outline-offset:1px}
.tracing .k:not(.on){opacity:.28}
.k.found{box-shadow:0 0 0 3px var(--mark)}
.st-done{--c:var(--done);--cs:var(--done-soft)}.st-partial{--c:var(--part);--cs:var(--part-soft)}.st-todo{--c:var(--todo);--cs:var(--todo-soft)}.st-outside{--c:var(--out);--cs:var(--out-soft)}.st-none{--c:var(--line);--cs:var(--band)}
.st-green{--c:var(--done);--cs:var(--done-soft)}.st-yellow{--c:var(--part);--cs:var(--part-soft)}.st-red{--c:var(--red);--cs:#FBE4E5}.st-blue{--c:var(--out);--cs:var(--out-soft)}.st-grey{--c:var(--line);--cs:var(--band)}
.badges{display:flex;gap:4px;margin-top:5px;flex-wrap:wrap}
.bd{font:500 10px var(--sans);border:1px solid var(--line);padding:0 5px;background:var(--card);color:var(--mute);border-radius:3px;white-space:nowrap}
.bd.st{color:var(--c);border-color:var(--c)}
.hide02 .c-SRC,.hide02 .c-BP,.hide02 .c-BF{display:none}

/* ─────────── панель */
.ph{padding:14px 16px 10px;border-bottom:1px solid var(--line2);display:flex;gap:12px;align-items:flex-start}
.ph .fbadge{min-width:34px;height:34px;border-radius:var(--radius);display:grid;place-items:center;font:700 13px var(--head);border:1.5px solid var(--ink);flex:none}
.ph .fbadge.sys{background:var(--rs);border-color:var(--rs);color:#fff}
.ph .kind{font-size:11.5px;color:var(--mute)}.ph .code{font:500 12px var(--mono);color:var(--rs)}
.ph h2{font:700 16px/1.25 var(--head);margin:2px 0 0;overflow-wrap:anywhere}
.ph .x{margin-left:auto;border:1px solid var(--line);background:#fff;border-radius:var(--radius);width:30px;height:30px;flex:none}
.ptabs{display:flex;gap:6px;padding:10px 16px 0}
.pbody{padding:12px 16px 24px;display:flex;flex-direction:column;gap:10px}
.lab{font:700 10.5px var(--sans);letter-spacing:.07em;text-transform:uppercase;color:var(--mute);margin-top:6px}
.q{background:#fff;border:1px solid var(--line);border-left:3px solid var(--rs);border-radius:var(--radius);padding:8px 10px}
.q .qh{display:flex;justify-content:space-between;gap:8px;color:var(--mute);font-size:11px;margin-bottom:4px}
.q pre{margin:0;white-space:pre-wrap;font:12.5px/1.55 var(--sans);overflow-wrap:anywhere}
mark{background:var(--mark);border-bottom:2px solid var(--part);padding:0 1px;color:inherit}
.row{border:1px solid var(--line);border-radius:var(--radius);padding:7px 9px;background:#fff;text-align:left;width:100%}
.row.fs{background:var(--rs-soft);border-color:var(--rs-line);border-left:4px solid var(--c)}
.row .id{font:500 10.5px var(--mono);color:var(--mute)}.row .t{font-size:12.5px}
.row:hover{border-color:var(--rs)}
.refs{display:flex;flex-direction:column;gap:3px}.refs div{font:500 11px var(--mono);color:var(--ink2);overflow-wrap:anywhere}
.floorlist{display:flex;flex-direction:column;gap:10px}
.flrow{display:grid;grid-template-columns:30px 1fr auto;gap:10px;align-items:center}
.flrow .n{width:30px;height:30px;border-radius:var(--radius);display:grid;place-items:center;font:700 12px var(--head);border:1.5px solid var(--ink)}
.flrow .n.sys{background:var(--rs);color:#fff;border-color:var(--rs)}
.flrow b{font-size:12.5px}.flrow .c{color:var(--mute);font-size:12px}
.fitems{display:flex;flex-direction:column;gap:5px;margin:6px 0 0 40px}
.pnav{display:flex;gap:6px}
.progress{height:6px;border-radius:6px;background:var(--line2);overflow:hidden}.progress i{display:block;height:100%;background:var(--done)}
.empty{color:var(--mute)}
.chips{display:flex;gap:4px;flex-wrap:wrap}.chip{font:600 10.5px var(--mono);color:var(--rs);background:var(--rs-soft);border:0;border-radius:4px;padding:1px 6px}
.chip:hover{background:var(--rs);color:#fff}

/* ─────────── ТЗ ↔ модель */
.doc{max-width:900px;margin:0 auto;padding:16px 26px 60px;background:#fff;min-height:100%;border-left:1px solid var(--line);border-right:1px solid var(--line)}
.doc h2{font:700 18px var(--head);margin:6px 0 2px}.doc .dsub{color:var(--mute);margin-bottom:10px}
.page{color:var(--mute);font:600 11px var(--mono);margin:16px 0 6px;border-top:1px dashed var(--line);padding-top:8px}
.para{display:grid;grid-template-columns:18px 1fr;gap:10px;padding:7px 10px;border-radius:var(--radius);margin-bottom:3px;cursor:pointer;border:0;background:none;text-align:left;width:100%}
.para:hover{background:var(--band)}.para.on{background:var(--rs-soft);box-shadow:inset 3px 0 0 var(--rs)}
.para .mk{width:14px;height:14px;border-radius:50%;margin-top:3px;background:var(--c)}
.para pre{margin:3px 0 0;white-space:pre-wrap;font:12.5px/1.55 var(--sans)}
.blk{display:grid;grid-template-columns:18px 1fr;gap:10px;padding:6px 10px;border-radius:var(--radius);margin-bottom:2px;cursor:pointer;border:0;background:none;text-align:left;width:100%;font:inherit;color:inherit}
.blk:hover{background:var(--band)}.blk.on{background:var(--rs-soft);box-shadow:inset 3px 0 0 var(--rs)}
.blk .mk{width:13px;height:13px;border-radius:50%;margin-top:4px;background:var(--c)}
.blk.none .mk{background:none;border:1.5px solid var(--line)}.blk.none{cursor:default}.blk.none pre{color:var(--mute)}
.blk pre{margin:2px 0 0;white-space:pre-wrap;font:12.5px/1.55 var(--sans);overflow-wrap:anywhere}
.blk.table pre{font:11.5px/1.5 var(--mono);white-space:pre;overflow-x:auto}
.blk.heading pre{font:700 14px/1.4 var(--head);color:var(--ink)}
.blk .why{font-size:11px;color:var(--mute);font-style:italic}.blk .defect{font-size:11.5px;color:#8a5a00;margin-top:3px}
.chip.a{font-weight:600}.doctools{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 4px}
.docsum{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--ink2);margin-bottom:6px}
/* ─────────── атомы ТЗ */
.atom{display:grid;grid-template-columns:12px 1fr;gap:9px;background:#fff;border:1px solid var(--line);border-radius:var(--radius);padding:7px 10px;text-align:left;width:100%}
.atom .mk{width:10px;height:10px;border-radius:50%;margin-top:5px;background:var(--c)}
.atom .id{font:500 10.5px var(--mono);color:var(--mute);display:flex;gap:8px;flex-wrap:wrap}
.atom .t{font-size:12.5px;font-weight:500}.atom .acc{font-size:11.5px;color:var(--ink2);margin-top:2px}.atom .note{font-size:11.5px;color:#8a5a00;margin-top:2px}
.atoms{display:flex;flex-direction:column;gap:5px;margin-top:6px}
.filt{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 6px}
.sec{margin-top:14px}.sec h3{font:700 14px var(--head);margin:0 0 6px}
.item{margin:8px 0 4px;font-weight:600;font-size:12.5px}.item .mono{color:var(--rs);font-size:11px;margin-right:6px}
/* ─────────── пробелы */
.gaps{max-width:980px;margin:0 auto;padding:18px 24px 60px;display:flex;flex-direction:column;gap:10px}
.gap{background:#fff;border:1px solid var(--line);border-radius:var(--radius);padding:10px 12px;border-left:4px solid var(--c)}
.gap{overflow-wrap:anywhere}.gap h3{font-size:14px;margin:6px 0}.gap p{margin:8px 0}.gap .mono{font-size:11px;overflow-wrap:anywhere}.gap details{margin-top:10px}.gap .id{font:500 11px var(--mono);color:var(--mute)}.gap .t{font-weight:600}
/* ─────────── каталог TO-BE и метрики (T-129) */
.cat{max-width:1180px;margin:0 auto;padding:16px 24px 60px}
.cat h3{font:700 14px var(--head);margin:18px 0 6px;display:flex;gap:10px;align-items:baseline}.cat h3 small{font:500 11.5px var(--sans);color:var(--mute)}
.ops{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:6px}
.op{background:#fff;border:1px solid var(--line);border-left:4px solid var(--c);border-radius:var(--radius);padding:6px 9px;text-align:left}
.op .id{font:500 10.5px var(--mono);color:var(--mute);display:flex;gap:6px;flex-wrap:wrap}.op .t{font-size:12.5px;font-weight:600}.op .u{font:500 10.5px var(--mono);color:var(--rs);margin-top:3px;overflow-wrap:anywhere}
.op.hot{box-shadow:0 0 0 2px var(--rs)}
.ech{display:inline-flex;gap:3px;flex-wrap:wrap}.ech i{font:600 10px var(--mono);font-style:normal;border-radius:3px;padding:0 4px;background:var(--done-soft);color:var(--done);border:1px solid var(--done)}
.ech i.off{background:var(--todo-soft);color:var(--todo);border-color:var(--line)}
.mt{background:#fff;border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;margin-bottom:12px}
.mt table{border-collapse:collapse;width:100%}.mt td,.mt th{border-bottom:1px solid var(--line2);padding:5px 8px;text-align:left;vertical-align:top;font-size:12.5px}.mt th{color:var(--mute);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.catsum{display:flex;gap:16px;flex-wrap:wrap;color:var(--ink2);font-size:12.5px;margin:4px 0 10px}
${DETAIL_CSS}
@media (max-width:900px){main{grid-template-columns:1fr}.panel{border-left:0;border-top:1px solid var(--line);max-height:50vh}body{overflow:auto}.summary-drawer #stats{max-height:55dvh}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head>
<body>
${renderDocNav("map")}
<header>
  <div class="h1row">
    <h1>Карта трассы требований · Инспектор ИИ</h1>
    <span class="proc" id="proc"></span>
    <span class="codes" id="codes"></span>
  </div>
  <div class="tools">
    <label for="q">Найти</label><input id="q" placeholder="код узла, например OS-INSP-3.1.5" autocomplete="off">
    <button class="btn" id="hide02">Скрыть этажи 0–2</button>
    <button class="btn" id="reset">Сбросить подсветку</button>
    <div class="legend">
      <span><i style="background:var(--rs)"></i>сервис</span>
      <span><i style="background:var(--rs-soft);border:1px solid var(--rs-line)"></i>требование</span>
      <span><i style="background:repeating-linear-gradient(135deg,#fff 0 3px,#dfe1ea 3px 4px);border:1px solid var(--line)"></i>НФТ</span>
      <span title="неспорный REAL в историческом аудите; текущая реализация отдельно не перепроверена"><i style="background:var(--done)"></i>REAL по историческому аудиту</span>
      <span title="частичная трасса или недостаточно свидетельств"><i style="background:var(--part)"></i>частично / недостаточно данных</span>
      <span title="нет кода по трассе либо отрицательный исторический аудит"><i style="background:var(--red)"></i>нет трассы / отрицательный аудит</span>
      <span title="полная трасса для GPU-стенда или эксплуатации; приёмка не доказана"><i style="background:var(--out)"></i>требуется стенд</span>
    </div>
  </div>
</header>
<details class="summary-drawer" id="summary-drawer"><summary>Сводка карты · показатели трассы</summary><div class="stats" id="stats"></div></details>
<div class="intro" id="intro">Колонки — этажи метода, читаются слева направо: <b>откуда известен факт</b> → <b>что требует ТЗ</b> → <b>что делает бизнес</b> → <b>что должна делать система</b> → <b>чем сделано</b> → <b>чем проверено</b>. Границу между бизнесом и системой отмечает этаж <span class="rsmark">RS</span> — спецификация требований: сервис операции и его функции. Нажмите карточку — справа её трасса и исходный текст. J / K — соседняя карточка этажа.</div>
<main>
  <section class="stage" id="stage"></section>
  <aside class="panel" id="panel" aria-live="polite"></aside>
</main>
<script>
const D = ${json};
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const byId = new Map(D.nodes.map((n) => [n.id, n]));
const fwd = new Map(), back = new Map();
for (const [a, b] of D.edges) { (fwd.get(a) ?? fwd.set(a, []).get(a)).push(b); (back.get(b) ?? back.set(b, []).get(b)).push(a); }
const FL = Object.fromEntries(D.floors.map((f) => [f.key, f]));
const ST = { done: "реализовано", partial: "частично", todo: "не начато", outside: "вне прототипа", none: "вне системы", ...${JSON.stringify(COLOR_RU)} };
// свёртка цветов — та же, что scripts/tz-color.mjs → aggColor
const aggC = (cs) => { const s = new Set(cs.filter((c) => c !== "grey")); if (!s.size) return "grey"; if (s.size === 1) return [...s][0]; return [...s].every((c) => c === "green" || c === "blue") ? "blue" : "yellow"; };
const colorLine = (by) => \`<b class="ok">\${by.green}</b> реализовано и проверено · <b class="pt">\${by.yellow}</b> частично · <b class="bad">\${by.red}</b> не реализовано · <b class="ot">\${by.blue}</b> ждёт стенда\`;
const MODE = { prototype: "прототип", gpu: "GPU-стенд", prod: "эксплуатация" };
let view = "map", sel = null, ptab = "trace", hide02 = false;

// ─────────── шапка
$("#proc").textContent = D.process.title;
$("#codes").textContent = D.process.id + " · " + (D.process.task ?? "") + " · " + D.process.status + " · собрано " + D.today;
const C = D.counts, pct = Math.round((100 * C.tested) / C.rules);
const CV = D.coverage;
$("#stats").innerHTML = \`<span class="cvs" data-go-view="gaps" style="cursor:pointer">Зелёные по историческому аудиту: <b class="ok">\${Math.round((100 * C.atomsBy.green) / C.atoms)} %</b> (\${C.atomsBy.green} из \${C.atoms} атомов) · не реализовано <b class="bad">\${C.atomsBy.red}</b></span>\` + (CV ? \`<span class="cvs" data-go-view="coverage" style="cursor:pointer">код с тестом по трассе: \${CV.total.pct} %</span>\${CV.audit ? \`<span class="cvs" data-go-audit style="cursor:pointer">REAL в историческом реестре: <b>\${CV.total.realPct} %</b></span>\` : ""}\` : "") + \`<span><b>\${C.ops}</b> операций, вне системы \${C.outside}</span><span><b>\${C.rules}</b> требований</span><span><b>\${C.tested}</b> с тестом · \${pct} %</span><span><b>\${C.nfr}</b> НФТ</span><span><b>\${C.dialogs}</b> диалогов · \${C.dialogsTested} с UI-тестом</span><span><b>\${C.data}</b> объектов данных</span>
<span><b>\${C.items}</b> пунктов ТЗ: \${colorLine(C.itemsBy)}</span><span><b>\${C.atoms}</b> атомов ТЗ: \${colorLine(C.atomsBy)}</span><span data-go-view="detail" style="cursor:pointer"><b>\${C.extra}</b> узлов модели сверх ТЗ</span>\`;

// ─────────── карта
function card(n) {
  const st = "st-" + (n.status ?? "none");
  if (n.floor === "SRC") return \`<button class="k src" data-id="\${n.id}"><div class="id">\${n.id} · \${esc(n.kind)}</div><div class="t">\${esc(n.title)}</div></button>\`;
  if (n.floor === "TZ") return \`<button class="k tz \${st}" data-id="\${n.id}"><div class="id">\${n.id}\${n.passage ? " · стр. " + n.passage.page : ""}</div><div class="t clamp">\${esc(n.title)}</div><div class="badges"><span class="bd st">\${ST[n.status]}</span></div></button>\`;
  if (n.floor === "BP") return \`<button class="k bp" data-id="\${n.id}"><div class="id">\${n.id}</div><div class="t">\${esc(n.title)}</div></button>\`;
  if (n.floor === "BF") return \`<button class="k bf" data-id="\${n.id}"><div class="id">\${n.id}</div><div class="t">\${esc(n.title)}</div></button>\`;
  if (n.floor === "BO") return \`<button class="k bo \${n.system ? "" : "off"} \${st}" data-id="\${n.id}"><div class="id">\${n.id}</div><div class="t">\${esc(n.title)}</div><div class="badges">\${n.system ? \`<span class="bd st">\${ST[n.status]}</span><span class="bd">правил \${n.done}/\${n.rules}</span>\` : \`<span class="bd">вне системы</span>\`}</div></button>\`;
  if (n.floor === "OS") return \`<button class="k os" data-id="\${n.id}"><div class="id">\${n.id}</div><div class="t">\${esc(n.title)}</div></button>\`;
  if (n.floor === "FS") return \`<button class="k fs \${n.nfr ? "nfr" : ""} \${st}" data-id="\${n.id}"><div class="id">\${n.id}</div><div class="t clamp">\${esc(n.title)}</div><div class="badges"><span class="bd st">\${ST[n.status]}</span>\${n.nfr ? \`<span class="bd">НФТ · \${MODE[n.mode]}</span>\` : ""}<span class="bd">код \${n.code.length}</span><span class="bd">тестов \${n.tests.length}</span></div></button>\`;
  if (n.floor === "DLG") return \`<button class="k dlg \${st}" data-id="\${n.id}"><div class="id">\${n.real}</div><div class="t">\${esc(n.title)}</div><div class="badges"><span class="bd st">\${ST[n.status]}</span><span class="bd">сервисов \${n.services.length}</span><span class="bd">UI-тест \${n.tests.length}</span></div></button>\`;
  if (n.floor === "DATA") return \`<button class="k data" data-id="\${n.id}"><div class="id">\${n.real} · \${n.cls === "predefined" ? "справочник" : "рождается в системе"}</div><div class="t">\${esc(n.title)}</div><div class="sub">\${esc(n.table)}</div></button>\`;
  if (n.floor === "MOD") return \`<button class="k code" data-id="\${n.id}"><div class="t">\${esc(n.file.split("/").pop())}\${n.name ? " · " + esc(n.name) : ""}</div><div class="sub">\${esc(n.file.split("/").slice(0, -1).join("/"))}</div></button>\`;
  if (n.floor === "TEST") return \`<button class="k test" data-id="\${n.id}"><div class="id">\${esc(n.file.split("/").pop())}</div><div class="t">\${esc(n.name || "—")}</div></button>\`;
  return "";
}
function renderMap() {
  const cols = D.floors.map((f) => (f.key === "FS" ? "300px" : f.key === "SRC" ? "200px" : f.key === "TZ" ? "210px" : f.key === "TEST" ? "220px" : f.key === "MOD" ? "200px" : f.key === "DLG" ? "190px" : f.key === "DATA" ? "185px" : "165px"));
  const visible = D.floors.filter((f) => !(hide02 && f.hide));
  const vcols = D.floors.map((f, i) => (hide02 && f.hide ? null : cols[i])).filter(Boolean).join(" ");
  let h = \`<div class="map \${hide02 ? "hide02" : ""}" id="map" style="--cols:\${vcols}"><div class="grid floors">\${visible.map((f) => \`<div class="fl \${f.sys ? "sys" : ""}"><b>\${f.n}</b><span>\${f.title}</span><small>\${f.sub}</small></div>\`).join("")}</div>\`;
  for (const b of D.bands) {
    const ns = D.nodes.filter((n) => n.band === b.id);
    if (!ns.length) continue;
    const fsn = ns.filter((n) => n.floor === "FS");
    const done = fsn.filter((n) => n.status === "done").length;
    h += \`<div class="grid"><div class="bandhead"><b>\${esc(b.title)}</b><span class="mono">\${b.id}</span><span class="prog">требований реализовано \${done} из \${fsn.length}</span></div>\`;
    for (const f of visible) h += \`<div class="col c-\${f.key}">\${ns.filter((n) => n.floor === f.key).map(card).join("")}</div>\`;
    h += "</div>";
  }
  h += '<svg class="links" id="links"></svg></div>';
  $("#stage").innerHTML = h;
  $("#map").addEventListener("click", (e) => { const k = e.target.closest(".k"); if (k) select(k.dataset.id); });
  $("#map").addEventListener("dblclick", (e) => { const k = e.target.closest(".k"); if (k) { select(k.dataset.id); setTab("text"); } });
  requestAnimationFrame(() => { drawLinks(); applySel(); });
}
function drawLinks() {
  const map = $("#map"); if (!map) return;
  const R = map.getBoundingClientRect(); const on = sel ? traceSet(sel) : null;
  let d = "";
  for (const [a, b] of D.edges) {
    const A = map.querySelector(\`[data-id="\${CSS.escape(a)}"]\`), B = map.querySelector(\`[data-id="\${CSS.escape(b)}"]\`);
    if (!A || !B || !A.offsetParent || !B.offsetParent) continue;
    const ra = A.getBoundingClientRect(), rb = B.getBoundingClientRect();
    const x1 = ra.right - R.left, y1 = ra.top + Math.min(ra.height / 2, 22) - R.top, x2 = rb.left - R.left, y2 = rb.top + Math.min(rb.height / 2, 22) - R.top, m = (x1 + x2) / 2;
    const hot = on && on.has(a) && on.has(b);
    d += \`<path class="\${hot ? "hot" : ""}" d="M\${x1},\${y1} C\${m},\${y1} \${m},\${y2} \${x2},\${y2}"/>\`;
  }
  $("#links").innerHTML = d;
}
function walk(start, g) { const out = new Set([start]), st = [start]; while (st.length) { const x = st.pop(); for (const y of g.get(x) ?? []) if (!out.has(y)) { out.add(y); st.push(y); } } return out; }
function traceSet(id) { return new Set([...walk(id, back), ...walk(id, fwd)]); }
function applySel() {
  const map = $("#map"); if (!map) return;
  map.classList.toggle("tracing", !!sel);
  const on = sel ? traceSet(sel) : new Set();
  map.querySelectorAll(".k").forEach((k) => { k.classList.toggle("on", on.has(k.dataset.id)); k.classList.toggle("sel", k.dataset.id === sel); });
  drawLinks();
}

// ─────────── выбор и панель
function select(id, { scroll = false } = {}) {
  if (!byId.has(id)) return;
  sel = id;
  try { history.replaceState(null, "", "#" + id.replace(/[^A-Za-z0-9._~-]/g, "_")); } catch {}
  if (view === "map") { applySel(); if (scroll) byIdEl(id)?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" }); }
  if (view === "doc") renderDoc();
  renderPanel();
}
const byIdEl = (id) => document.querySelector(\`#map [data-id="\${CSS.escape(id)}"]\`);
function setTab(t) { ptab = t; renderPanel(); }
function floorBadge(n) { const f = FL[n.floor]; return \`<div class="fbadge \${f.sys ? "sys" : ""}">\${f.n}</div>\`; }
function nodeTitle(n) { return n.floor === "MOD" || n.floor === "TEST" ? (n.file.split("/").pop() + (n.name ? " · " + n.name : "")) : n.title; }
const shownId = (n) => (n.floor === "MOD" || n.floor === "TEST" ? n.file : n.real ?? n.id);
function quote(p, hl) {
  if (!p) return '<div class="empty">Исходный абзац ТЗ не извлечён (нет якоря или PDF).</div>';
  let t = esc(p.text); const f = esc(hl ?? p.find); t = t.replace(f, \`<mark>\${f}</mark>\`);
  return \`<div class="q"><div class="qh"><span class="mono">\${p.id}</span><span>ТЗ «Инспектор ИИ» · стр. \${p.page}</span></div><pre>\${t}</pre></div>\`;
}
function rowRule(r) {
  const n = byId.get(r); if (!n) return "";
  return \`<button class="row fs st-\${n.status}" data-go="\${n.id}"><div class="id">\${n.id} · \${ST[n.status]} · код \${n.code.length} · тестов \${n.tests.length}</div><div class="t">\${esc(n.title)}</div></button>\`;
}
function tzFor(ids) { const s = new Set(ids); return D.nodes.filter((n) => n.floor === "TZ" && n.units.some((u) => s.has(u))); }
function textTab(n) {
  const parts = [];
  if (n.floor === "TZ") {
    parts.push('<div class="lab">Исходный текст ТЗ</div>' + quote(n.passage));
    const at = atomsOf(n.id);
    if (at.length) parts.push(\`<div class="lab">Атомы ТЗ · \${at.length} · для приёмки</div><div class="atoms">\${at.map(atomRow).join("")}</div>\`);
    parts.push(\`<div class="lab">Во что выведено · \${n.units.length}</div>\` + n.units.map(rowRule).join(""));
    const i = tzList.indexOf(n.id);
    parts.push(\`<div class="pnav"><button class="btn" data-go="\${tzList[i - 1] ?? ""}" \${i > 0 ? "" : "disabled"}>← \${tzList[i - 1] ?? ""}</button><button class="btn" data-go="\${tzList[i + 1] ?? ""}" \${i < tzList.length - 1 ? "" : "disabled"}>\${tzList[i + 1] ?? ""} →</button><button class="btn" data-doc="\${n.id}">Открыть в «ТЗ ↔ модель»</button></div>\`);
  } else if (n.floor === "FS") {
    parts.push('<div class="lab">Формулировка требования</div>' + \`<div class="q" style="border-left-color:var(--c)"><pre>\${esc(n.title)}</pre></div>\`);
    if (n.svc) { const s = byId.get(n.svc); parts.push(\`<div class="lab">Сервис \${s.id}</div><div class="q"><pre>\${esc(s.statement || s.title)}</pre></div>\`); }
    if (n.nfr) parts.push(\`<div class="lab">Контур проверки</div><div>\${MODE[n.mode]}\${n.adr ? " · " + n.adr : ""} — допущение проекта, у автора метода НФТ нет</div>\`);
    // от конкретного к общему: пункт ТЗ, выведенный в меньшее число правил, ближе к этому требованию
    const tz = tzFor([n.id]).sort((a, b) => a.units.length - b.units.length);
    parts.push(\`<div class="lab">Откуда в ТЗ · \${tz.length}</div>\` + (tz.slice(0, 2).map((t) => quote(t.passage)).join("") || '<div class="empty">Пункт ТЗ не ссылается на это требование напрямую</div>'));
    if (tz.length > 2) parts.push(\`<div class="lab">Также ссылаются</div><div class="chips">\${tz.slice(2).map((t) => \`<button class="chip" data-go="\${t.id}">\${t.id}</button>\`).join("")}</div>\`);
    parts.push('<div class="lab">Код</div><div class="refs">' + (n.code.map((c) => \`<div>\${esc(c)}</div>\`).join("") || '<div class="empty">нет</div>') + "</div>");
    parts.push('<div class="lab">Тесты</div><div class="refs">' + (n.tests.map((c) => \`<div>\${esc(c)}</div>\`).join("") || '<div class="empty">нет — требование не подтверждено тестом</div>') + "</div>");
  } else if (n.floor === "OS" || n.floor === "BO") {
    const s = n.floor === "OS" ? n : byId.get(D.nodes.find((x) => x.floor === "OS" && (back.get(x.id) ?? []).includes(n.id))?.id);
    if (n.floor === "BO" && !n.system) parts.push(\`<div class="lab">Вне системы</div><div>\${esc(n.why)}</div>\`);
    if (s) {
      parts.push(\`<div class="lab">Сервис \${s.id}</div><div class="q"><pre>\${esc(s.statement || s.title)}</pre></div>\`);
      const rules = fwd.get(s.id) ?? [];
      parts.push(\`<div class="lab">Требования · \${rules.length}</div>\` + rules.map(rowRule).join(""));
      const tz = tzFor(rules);
      parts.push(\`<div class="lab">Пункты ТЗ · \${tz.length}</div><div class="chips">\${tz.map((t) => \`<button class="chip" data-go="\${t.id}">\${t.id}</button>\`).join("")}</div>\`);
    }
  } else if (n.floor === "BF" || n.floor === "BP") {
    parts.push(\`<div class="lab">Основания — источники обследования</div>\` + (n.from ?? []).map((s) => { const x = byId.get(s); return x ? \`<button class="row" data-go="\${x.id}"><div class="id">\${x.id} · \${esc(x.kind)}</div><div class="t">\${esc(x.title)}</div></button>\` : ""; }).join(""));
  } else if (n.floor === "DLG") {
    const d = D.dialogIndex[n.real];
    parts.push(\`<div class="lab">Диалог — сценарий сервисов · \${d.services.length}</div>\` + (d.services.map((sv) => { const s = byId.get(sv); return s ? \`<button class="row" data-go="\${s.id}"><div class="id">\${s.id}</div><div class="t">\${esc(s.statement || s.title)}</div></button>\` : ""; }).join("") || '<div class="empty">Служебный диалог: ограничения NFR-AUTH, NFR-ROLES</div>'));
    parts.push('<div class="lab">Форма, функции представления</div><div class="empty">Описаны в docs/gera/inspector/03b-dialogs.md</div>');
    parts.push('<div class="lab">Код экрана</div><div class="refs">' + d.code.map((c) => \`<div>\${esc(c)}</div>\`).join("") + "</div>");
    parts.push('<div class="lab">UI-тест</div><div class="refs">' + (d.tests.map((c) => \`<div>\${esc(c)}</div>\`).join("") || '<div class="empty">нет</div>') + "</div>");
  } else if (n.floor === "DATA") {
    const o = D.dataIndex[n.real];
    const ops = (list) => list.map((b) => \`<button class="row" data-go="\${b}"><div class="id">\${b}</div><div class="t">\${esc(D.bos[b] ?? "")}</div></button>\`).join("") || '<div class="empty">—</div>';
    parts.push(\`<div class="lab">Объект данных · \${o.class === "predefined" ? "справочник, существует до процесса" : "рождается в процессе"}</div><div class="refs"><div>таблица: \${esc(o.table)}</div></div>\`);
    parts.push(\`<div class="lab">Рождается в · \${o.new_in.length}</div>\` + ops(o.new_in));
    parts.push(\`<div class="lab">Читают · \${o.used_by.length}</div>\` + ops(o.used_by));
    parts.push('<div class="lab">Код</div><div class="refs">' + o.code.map((c) => \`<div>\${esc(c)}</div>\`).join("") + "</div>");
  } else if (n.floor === "SRC") {
    parts.push(\`<div class="lab">Источник · \${esc(n.kind)}</div><div class="q"><pre>\${esc(n.title)}</pre></div>\` + (n.ref ? \`<div class="refs"><div>\${esc(n.ref)}</div></div>\` : ""));
  } else {
    const users = back.get(n.id) ?? [];
    parts.push(\`<div class="lab">\${n.floor === "MOD" ? "Файл и символ" : "Файл и тест"}</div><div class="refs"><div>\${esc(n.ref)}</div></div><div class="lab">Закрывает требования · \${users.length}</div>\` + users.map(rowRule).join(""));
  }
  return parts.join("");
}
function traceTab(n) {
  const on = traceSet(n.id);
  return '<div class="lab">Трасса по этажам</div><div class="floorlist">' + D.floors.map((f) => {
    const items = D.nodes.filter((x) => x.floor === f.key && on.has(x.id));
    const uniq = [...new Map(items.map((x) => [x.ref ?? x.key ?? x.id, x])).values()];
    return \`<div><div class="flrow"><div class="n \${f.sys ? "sys" : ""}">\${f.n}</div><b>\${f.title}</b><span class="c">\${uniq.length}</span></div><div class="fitems">\${uniq.slice(0, 14).map((x) => \`<button class="row \${x.floor === "FS" ? "fs st-" + x.status : ""}" data-go="\${x.id}"><div class="id">\${esc(shownId(x))}</div><div class="t">\${esc(x.floor === "MOD" || x.floor === "TEST" ? x.name || "—" : x.title)}</div></button>\`).join("")}\${uniq.length > 14 ? \`<div class="empty">ещё \${uniq.length - 14}</div>\` : ""}</div></div>\`;
  }).join("") + "</div>";
}
function renderPanel() {
  const P = $("#panel");
  if (!sel) {
    const pr = Math.round((100 * C.tested) / C.rules);
    P.innerHTML = \`<div class="ph"><div class="fbadge">↳</div><div><div class="kind">Трасса</div><h2>Выберите узел на карте</h2></div></div><div class="pbody">
<p>Нажмите на карточку — здесь появится её трасса: откуда требование выросло, чем оно сделано и проверено. Вкладка «Текст» показывает исходную формулировку: абзац ТЗ со страницей, формулировку сервиса и требования.</p>
<p>Режим «ТЗ ↔ модель» читает ТЗ как документ: на полях — покрытие, над абзацем — коды правил, в которые он выведен.</p>
<div class="lab">Этажи метода</div><div class="floorlist">\${D.floors.map((f) => \`<div class="flrow"><div class="n \${f.sys ? "sys" : ""}">\${f.n}</div><b>\${f.title}</b><span class="c">\${D.nodes.filter((x) => x.floor === f.key).length}</span></div>\`).join("")}</div>
<div class="lab">Требований с тестом: \${C.tested} из \${C.rules}</div><div class="progress"><i style="width:\${pr}%"></i></div></div>\`;
    return;
  }
  const n = byId.get(sel);
  P.innerHTML = \`<div class="ph">\${floorBadge(n)}<div style="min-width:0"><div class="kind">\${FL[n.floor].title}\${n.status ? " · " + ST[n.status] : ""}</div><div class="code">\${esc(shownId(n))}</div><h2>\${esc(nodeTitle(n))}</h2></div><button class="x" id="close" aria-label="Закрыть">✕</button></div>
<div class="ptabs"><button class="btn \${ptab === "trace" ? "on" : ""}" data-tab="trace">Трасса</button><button class="btn \${ptab === "text" ? "on" : ""}" data-tab="text">Текст</button></div>
<div class="pbody">\${ptab === "text" ? textTab(n) : traceTab(n)}</div>\`;
}
$("#panel").addEventListener("click", (e) => {
  const t = e.target.closest("[data-tab],[data-go],[data-doc],#close");
  if (!t) return;
  if (t.id === "close") { sel = null; applySel(); renderPanel(); if (view === "doc") renderDoc(); return; }
  if (t.dataset.tab) return setTab(t.dataset.tab);
  if (t.dataset.doc) { setView("doc"); select(t.dataset.doc); return; }
  if (t.dataset.go) { if (view !== "map" && !byId.get(t.dataset.go)?.floor.match(/TZ/)) setView("map"); select(t.dataset.go, { scroll: true }); }
});

// ─────────── ТЗ ↔ модель
const tzList = D.nodes.filter((n) => n.floor === "TZ").sort((a, b) => (a.passage?.page ?? 99) - (b.passage?.page ?? 99)).map((n) => n.id);
let docFilter = "all";
function blockStatus(b) {
  const at = b.atoms.map((id) => D.atoms.find((x) => x.id === id)).filter(Boolean);
  if (!at.length) return b.item ? (byId.get(b.item)?.status ?? aggC(atomsOf(b.item).map((a) => a.color))) : "grey";
  return aggC(at.map((a) => a.color));
}
function renderDoc() {
  const all = D.tzDoc.flatMap((p) => p.blocks);
  const linked = all.filter((b) => b.item), none = all.filter((b) => b.none);
  const open = all.filter((b) => b.item && ["yellow", "red", "blue"].includes(blockStatus(b)));
  const f = (k, t, n) => \`<button class="btn \${docFilter === k ? "on" : ""}" data-f="\${k}">\${t} · \${n}</button>\`;
  let h = \`<div class="doc"><h2>Карта ТЗ — полный текст «Инспектора ИИ»</h2>
<div class="dsub">Текст ТЗ посимвольно, страница за страницей (\${D.tzDoc.length} стр.). У каждого абзаца метка: цветная — требования и их покрытие, пустая — «требований нет» с причиной. Над абзацем — пункт ТЗ и его атомы; клик — таблица атомов справа.</div>
<div class="docsum"><span><b>\${all.length}</b> абзацев и строк таблиц</span><span><b>\${linked.length}</b> с требованиями</span><span><b>\${none.length}</b> без требований</span><span><b>0</b> не размечено</span><span><b>\${D.atoms.length}</b> атомов разложено по абзацам</span></div>
<div class="doctools">\${f("all", "Весь текст", all.length)}\${f("open", "Есть что доделать", open.length)}\${f("none", "Без требований", none.length)}</div>\`;
  for (const p of D.tzDoc) {
    const bs = p.blocks.filter((b) => docFilter === "all" || (docFilter === "none" ? b.none : open.includes(b)));
    if (!bs.length) continue;
    h += \`<div class="page">стр. \${p.page}</div>\`;
    for (const b of bs) {
      if (b.none) { h += \`<div class="blk none \${b.kind}"><span class="mk"></span><div><div class="why">требований нет · \${esc(b.none)}</div>\${b.text ? \`<pre>\${esc(b.text)}</pre>\` : ""}</div></div>\`; continue; }
      const st = blockStatus(b);
      const chips = [b.item, ...b.also].map((i) => \`<span class="chip">\${i}\${D.items[i]?.isNew ? " · нет в трассе" : ""}</span>\`).join("") + b.atoms.map((id) => { const a = D.atoms.find((x) => x.id === id); return \`<span class="chip a st-\${a.color}" style="background:var(--cs);color:var(--ink2)" title="\${esc(a.t)} — \${ST[a.color]}: \${esc(a.why)}">\${id.replace("TZA-", "")}</span>\`; }).join("");
      h += \`<button class="blk st-\${st} \${b.kind} \${sel === b.item ? "on" : ""}" data-item="\${b.item}"><span class="mk" title="\${ST[st] ?? ""}"></span><div><div class="chips">\${chips}\${b.cont && !b.atoms.length ? '<span class="why">продолжение пункта</span>' : ""}</div><pre>\${esc(b.text)}</pre>\${b.note ? \`<div class="defect">\${esc(b.note)}</div>\` : ""}</div></button>\`;
    }
  }
  $("#stage").innerHTML = h + "</div>";
  $("#stage .doc").addEventListener("click", (e) => {
    const fb = e.target.closest("[data-f]"); if (fb) { docFilter = fb.dataset.f; renderDoc(); return; }
    const b = e.target.closest("[data-item]"); if (!b) return;
    ptab = "text";
    if (byId.has(b.dataset.item)) select(b.dataset.item); else { sel = b.dataset.item; renderDoc(); renderItemPanel(b.dataset.item); }
  });
  if (sel) document.querySelector(\`[data-item="\${CSS.escape(sel)}"]\`)?.scrollIntoView({ block: "nearest" });
}
// пункт декомпозиции, которого нет в трассе model.yaml: панель с атомами
function renderItemPanel(id) {
  const it = D.items[id] ?? { title: id, section: "" };
  const at = atomsOf(id);
  $("#panel").innerHTML = \`<div class="ph"><div class="fbadge">ТЗ</div><div><div class="kind">Пункт ТЗ · \${esc(it.section)}\${it.isNew ? " · нет в трассе" : ""}</div><div class="code">\${id}</div><h2>\${esc(it.title)}</h2></div><button class="x" id="close" aria-label="Закрыть">✕</button></div>
<div class="pbody"><div class="lab">Атомы ТЗ · \${at.length} · для приёмки</div><div class="atoms">\${at.map(atomRow).join("")}</div>\${it.isNew ? '<div class="empty">Пункт найден декомпозицией и не входит в трассу model.yaml: операции и сервиса под него пока нет.</div>' : ""}</div>\`;
}

// ─────────── атомы ТЗ
const V = { done: "реализовано", partial: "частично", todo: "не начато", outside: "вне прототипа" };
const SCOPE = { prototype: "прототип", gpu: "GPU-стенд", prod: "эксплуатация" };
const KIND = { F: "функц.", D: "данные", I: "интерфейс", Q: "качество", S: "безопасность", O: "эксплуатация", C: "ограничение", A: "метрика" };
const METHOD = { I: "осмотр", A: "анализ", D: "демонстрация", T: "испытание" };
const atomsOf = (item) => D.atoms.filter((a) => a.item === item);
function atomRow(a) {
  return \`<div class="atom st-\${a.color}"><span class="mk" title="\${ST[a.color]}"></span><div><div class="id"><span>\${a.id}</span><span>\${ST[a.color]}</span><span>\${KIND[a.kind] ?? a.kind}</span><span>приёмка: \${METHOD[a.method] ?? a.method}</span><span>\${SCOPE[a.scope]}</span>\${a.prio ? \`<span>\${a.prio}</span>\` : ""}</div>
<div class="t">\${esc(a.t)}</div><div class="acc">Критерий: \${esc(a.accept)}</div><div class="note">\${ST[a.color]}: \${esc(a.why)}</div>\${a.trace.length ? \`<div class="chips" style="margin-top:3px">\${a.trace.map((r) => \`<button class="chip" data-go="\${r}">\${r}</button>\`).join("")}</div>\` : ""}\${a.ready ? '<div class="note">код готов — проверка на стенде</div>' : ""}\${a.note ? \`<div class="note">\${esc(a.note)}</div>\` : ""}</div></div>\`;
}

${GAPS_JS}

${DETAIL_JS}
// ─────────── T-129: каталог TO-BE и метрики
const echChips = (list, all = false) => \`<span class="ech">\${(all ? ["L1","L2","L3","L4","L5","L6","L7","L8"] : list).map((e) => \`<i class="\${all && !list.includes(e) ? "off" : ""}">\${e}</i>\`).join("")}</span>\`;
function renderCatalog() {
  const K = D.catalog; if (!K) { $("#stage").innerHTML = '<div class="gaps">Каталог TO-BE не подключён</div>'; return; }
  const hot = new Set(K.metrics.flatMap((m) => m.ops));
  const by = {}; for (const o of K.ops) (by[o.layer] ??= []).push(o);
  const cnt = (st) => K.ops.filter((o) => o.status === st).length;
  $("#stage").innerHTML = \`<div class="cat"><div class="lab">Каталог TO-BE операций распознавания и сравнения · SRC-INSP-10</div>
<p>Статус операции рассчитан по связанным правилам, коду и тестам текущей модели. Это покрытие реализации; приёмка на корпусе и целевом стенде проверяется отдельно в «Контроле критиков».</p><div class="catsum"><span><b>\${K.ops.length}</b> операций</span><span><b class="ok">\${cnt("done")}</b> реализовано</span><span><b class="pt">\${cnt("partial")}</b> частично</span><span><b>\${cnt("todo")}</b> не начато</span><span>рамкой выделены операции параметров Матрицы · \${K.metrics.length} паспортов</span></div>
\${Object.entries(by).map(([l, ops]) => \`<h3>\${esc(ops[0].n)} · \${esc(ops[0].layerTitle)} <small>\${l} · \${esc(ops[0].bo ?? "")} \${esc(D.bos[ops[0].bo] ?? "")} · \${ops.filter((o) => o.status === "done").length} из \${ops.length}</small></h3><div class="ops">\${ops.map((o) => \`<div class="op st-\${o.status} \${hot.has(o.id) ? "hot" : ""}" title="\${esc(o.detail)}"><div class="id">\${o.id} · \${ST[o.status]}</div><div class="t">\${esc(o.title)}</div>\${o.units.length ? \`<div class="u">\${o.units.map((u) => \`<span data-go="\${u}" style="cursor:pointer">\${u}</span>\`).join(" ")}</div>\` : ""}</div>\`).join("")}</div>\`).join("")}</div>\`;
  $("#stage .cat").addEventListener("click", (e) => { const t = e.target.closest("[data-go]"); if (t && byId.has(t.dataset.go)) { setView("map"); select(t.dataset.go, { scroll: true }); } });
}
function renderMetrics() {
  const K = D.catalog; if (!K) return;
  const opById = new Map(K.ops.map((o) => [o.id, o]));
  $("#stage").innerHTML = \`<div class="cat"><h2>Параметры Матрицы и доказательства реализации</h2><p>\${K.inventory.total} параметров Матрицы · \${K.inventory.traced} в трассе · \${K.inventory.drafts} черновых паспортов · \${K.inventory.missing.length} без отдельной трассы.</p><details><summary>Параметры без отдельной трассы</summary><p>Отсутствие отдельной трассы не означает отсутствия общего алгоритма; нужны явные связи и доказательства для параметра.</p><ul>\${K.inventory.missing.map((mt) => \`<li>\${esc(mt.id)} · \${esc(mt.title)}</li>\`).join("")}</ul></details><p>\${K.metrics.length} паспортов · операции, требования и тесты пересобраны из текущей модели. L1–L8 показывают наличие ссылок на тесты соответствующего эшелона, а не результат последнего прогона. Число реализованных правил не является точностью извлечения или долей принятых требований ТЗ.</p>\${K.metrics.map((m) => {
    const done = m.units.filter((u) => u.status === "done").length;
    return \`<div class="mt"><div class="lab">Параметр Матрицы · \${m.draft ? "черновой паспорт, приёмка не подтверждена" : "паспорт"} \${esc(m.passport)}</div><h3>\${m.id} · \${esc(m.title)} <small>требований \${done} из \${m.units.length} реализовано</small></h3>
<div class="lab">Эшелоны qa-standard, представленные в трассе тестов</div>\${echChips(m.echelons.filter((x) => x.covered).map((x) => x.e), true)}
<div class="lab">Операции каталога TO-BE · \${m.ops.length}</div><div class="ops">\${m.ops.map((id) => { const o = opById.get(id); return \`<div class="op st-\${o.status}"><div class="id">\${id} · \${ST[o.status]}</div><div class="t">\${esc(o.title)}</div></div>\`; }).join("")}</div>
<div class="lab">Требования → тесты → эшелоны</div><table><tr><th>Требование</th><th>Статус</th><th>Тесты и эшелоны</th></tr>\${m.units.map((u) => \`<tr class="st-\${u.status}"><td><button class="row fs st-\${u.status}" data-go="\${u.id}"><div class="id">\${u.id}</div><div class="t">\${esc(D.ruleText[u.id]?.t ?? "")}</div></button></td><td>\${ST[u.status]}</td><td>\${u.tests.length ? u.tests.map((t) => \`<div class="refs"><div>\${esc(t.ref.split("::")[1] ?? t.ref)} \${echChips(t.echelons ?? [])}</div></div>\`).join("") : '<span class="empty">теста нет</span>'}</td></tr>\`).join("")}</table></div>\`;
  }).join("")}</div>\`;
  $("#stage .cat").addEventListener("click", (e) => { const t = e.target.closest("[data-go]"); if (t && byId.has(t.dataset.go)) { setView("map"); select(t.dataset.go, { scroll: true }); } });
}
// ─────────── T-141: покрытие ТЗ кодом — для заказчика
let cvOpen = new Set();
function cvBar(x) { return \`<span class="bar" role="img" aria-label="покрыто \${x.done}, частично \${x.partial}, нет кода \${x.none}"><i style="width:\${(100 * x.done) / (x.n || 1)}%;background:var(--mute)"></i><i style="width:\${(100 * x.partial) / (x.n || 1)}%;background:var(--part)"></i></span>\`; }
function renderCoverage() {
  const K = D.coverage; if (!K) { $("#stage").innerHTML = '<div class="gaps">Декомпозиция ТЗ не подключена</div>'; return; }
  const T = K.total, P = K.prototype;
  const cls = (p) => (p < 60 ? "low" : "");
  const row = (s) => \`<button class="cvr" data-sec="\${s.id}" aria-expanded="\${cvOpen.has(s.id)}"><span class="t"><b>\${esc(s.title)}</b><span>\${esc(s.what)} · раздел ТЗ \${s.id.replace("S", "")} «\${esc(s.tz)}»</span></span>\${cvBar(s)}<span class="pc \${cls(s.pct)}">\${s.pct} %</span><span class="n">\${s.done} из \${s.n}\${s.partial ? \` · частично \${s.partial}\` : ""}</span><span class="acc" title="зелёные по историческому аудиту">🟢 \${s.colors.green}</span></button>\` +
    (cvOpen.has(s.id) ? \`<div class="cvopen">\${s.open.length ? s.open.map((o) => \`<div><span class="mono">\${o.id}</span><span>\${esc(o.t)}</span><span class="why">\${o.code === "partial" ? "частично: " : ""}\${esc(o.why)}</span></div>\`).join("") : '<p class="ok">Все требования раздела покрыты кодом с тестами.</p>'}</div>\` : "");
  $("#stage").innerHTML = \`<div class="cv">
<h2>Актуальная инвентаризация связей ТЗ с реализацией</h2>
<p class="cvnote">Пересобрано \${D.today} по модели основной ветки. Проверено наличие файлов и ссылок на код и существующие тесты; приложение и тесты для этой актуализации не запускались.</p>
<p class="lead">ТЗ Мосстройнадзора «Инспектор ИИ» разобрано на \${T.n} проверяемых требований. «В трассе покрыто» означает, что модель указывает код и автотест, а гейт находит обе ссылки в файлах; это не доказывает поведение кода или соответствие теста критерию. Зелёный означает неспорный REAL в накопленном аудите при полной трассе прототипа и неизменных трассе, тексте и критерии. Снимок не сравнивает содержимое файлов реализации; это не подтверждение выполнения на текущей ревизии.</p>
<div class="cvhero">
  <div class="cvk main"><div class="big">\${T.pct} %</div><div class="cap">требований имеют полную трассу к коду и тестам</div><div class="sub">\${T.done} из \${T.n} · частично \${T.partial} · без кода по трассе \${T.none}</div><div class="cvbar"><i class="d" style="width:\${(100 * T.done) / T.n}%"></i><i class="p" style="width:\${(100 * T.partial) / T.n}%"></i></div></div>
\${K.groups.map((g) => \`<div class="cvk"><div class="mid" style="color:\${g.pct === 100 ? "var(--ink)" : g.pct < 60 ? "var(--red)" : "var(--ink)"}">\${g.pct} %</div><div class="cap">\${esc(g.title)}</div><div class="sub">\${g.done} из \${g.n} · \${esc(g.what)}</div></div>\`).join("")}
</div>
<div class="cvgroups">
  <div class="cvg"><div class="row1"><b>Зелёные по историческому аудиту</b><span class="p" style="color:var(--done)">\${T.colors.green}</span></div><div class="w">неспорный REAL, полная трасса прототипа, текст и критерий совпадают со снимком — \${T.greenPct} % требований; та же шкала, что в «Детальной трассе»</div></div>
  <div class="cvg"><div class="row1"><b>Частично или недостаточно свидетельств</b><span class="p" style="color:var(--part)">\${T.colors.yellow}</span></div><div class="w">неполная трасса, оговорка, слабое или спорное свидетельство, отсутствие аудита либо изменённый атом — причина в «Пробелах»</div></div>
  <div class="cvg"><div class="row1"><b>Нет кода по трассе или отрицательный аудит</b><span class="p" style="color:var(--red)">\${T.colors.red}</span></div><div class="w">код отсутствует в трассе либо исторический аудит содержит неспорный NOT_IMPLEMENTED; свежесть реализации отдельно не установлена</div></div>
  <div class="cvg"><div class="row1"><b>Полная трасса, требуется стенд</b><span class="p" style="color:var(--out)">\${T.colors.blue}</span></div><div class="w">ссылки для GPU-стенда и эксплуатации найдены; готовность кода и приёмка на целевом стенде этим не доказаны</div></div>
</div>
<div class="hist"><h3>Откуда числа и что подтверждено</h3><p>\${T.n} — число уникальных атомов в docs/tz/tz-decomposition.yaml. \${T.done} — число атомов с code=done, а не число связей. Формула: round(100 × \${T.done} / \${T.n}) = \${T.pct} %. Частичные \${T.partial} и без кода по трассе \${T.none} в числитель не входят.</p><p>Связи взяты из docs/gera/inspector/model.yaml; scripts/gera-trace.mjs проверяет файлы и подстроки символов/названий тестов. Цвета вычисляет scripts/tz-color.mjs, сводку — scripts/tz-coverage.mjs. Зелёных \${T.colors.green} + жёлтых \${T.colors.yellow} + красных \${T.colors.red} + синих \${T.colors.blue} = \${T.n}.</p><p>Записей аудита: \${T.audited}/\${T.n}; REAL: \${T.real}, из них спорных \${T.real - T.realSure}. Источники — docs/trace/COVERAGE-AUDIT.json и COVERAGE-AUDIT-TRACES.json. Исходный аудит: \${esc(K.audit?.at ?? "нет")}, ревизия \${esc(K.audit?.revision ?? "нет")}; отдельные повторы имеют собственные даты и ревизии. Достоверный процент выполнения всех требований на текущей ревизии не установлен. <a href="?view=audit">Свидетельства и ограничения аудита →</a></p></div>
<div class="hist"><h3>Новый модуль: верификация и разметка данных</h3><p>T-244, опубликованная ревизия df65e188: найдены задания и ответы, витрина разметки, разбор спорных случаев, выпуск и выгрузка набора. Источники: services/verification-routes.ts, services/data-verification.ts, services/annotation-library.ts; существующие тесты verification-http.test.ts и data-verification.test.ts.</p><p>Это реализация отдельной ветки: она показана в архитектуре как часть подготовки данных для дообучения. Процент выше рассчитан по основной модели ТЗ; модуль не прибавлен к нему произвольным числом.</p><a href="ARCHITECTURE.html#learning-flow">Место модуля в бизнес-процессе →</a></div>
<div class="cvtab"><div class="cvh"><span>Раздел ТЗ</span><span>Полнота трассы</span><span style="text-align:right">%</span><span style="text-align:right">требований</span><span style="text-align:right">зелёных</span></div>
\${K.groups.map((g) => \`<div class="cvgh">\${esc(g.title)} · \${g.pct} %</div>\` + K.sections.filter((s) => s.group === g.id).map(row).join("")).join("")}
</div>
<p class="cvnote">Как считается. Единица — атомарное требование ТЗ (docs/tz/tz-decomposition.yaml): одно проверяемое утверждение с критерием приёмки. Покрыто — у каждого звена его трассы (правило сервиса, НФТ, экран, объект данных) есть код и тест, и гейт находит их в файлах репозитория. Частично — код есть не у всех звеньев или реализация с оговоркой. Проценты — доля покрытых требований без учёта частичных. Собрано \${D.today} командой pnpm trace из текущего кода.</p>
</div>\`;
  $("#stage .cv").addEventListener("click", (e) => { const r = e.target.closest("[data-sec]"); if (!r) return; const id = r.dataset.sec; cvOpen.has(id) ? cvOpen.delete(id) : cvOpen.add(id); renderCoverage(); });
}
function renderAudit() {
  const K = D.coverage; if (!K) { $("#stage").innerHTML = '<div class="gaps">Декомпозиция ТЗ не подключена</div>'; return; }
  const T = K.total, A = K.audit;
  const cls = (p) => (p >= 90 ? "full" : p < 50 ? "low" : "");
  const two = (x) => \`<span class="bar2"><span class="bar" title="в трассе названы код и тест"><i style="width:\${(100 * x.done) / (x.n || 1)}%;background:var(--todo)"></i></span><span class="bar" title="REAL в накопленном реестре, включая спорные"><i style="width:\${(100 * x.real) / (x.n || 1)}%;background:var(--done)"></i></span></span>\`;
  const V = { REAL: "REAL по реестру", WEAK_TEST: "тест не про критерий", NO_TEST: "нет теста", NOT_IMPLEMENTED: "не реализовано", BROKEN_LINK: "трасса не туда", CALC_ONLY: "только расчёт", UNDERCOUNTED: "недосчитано" };
  const row = (s) => \`<button class="cvr" data-sec="\${s.id}" aria-expanded="\${cvOpen.has(s.id)}"><span class="t"><b>\${esc(s.title)}</b><span>\${esc(s.what)} · раздел ТЗ \${s.id.replace("S", "")}</span></span>\${two(s)}<span class="pc \${cls(s.realPct)}">\${s.realPct} %</span><span class="n">\${s.real} из \${s.n}</span><span class="acc">в трассе \${s.pct} %</span></button>\` +
    (cvOpen.has(s.id) ? \`<div class="cvopen">\${s.open.length ? s.open.map((o) => \`<div><span class="mono">\${o.id}</span><span>\${esc(o.t)}</span><span class="why">\${o.audit ? \`<b class="v v-\${o.audit.verdict}">\${V[o.audit.verdict] ?? o.audit.verdict}\${o.audit.uncertain ? " (спорно)" : ""}</b> \${esc(o.audit.evidence)} <a href="../trace/AUDIT-PROVENANCE.html#\${encodeURIComponent(o.id)}">Дата, ревизия и актуальность</a> · \${esc(o.why)}\` : esc(o.why)}</span></div>\`).join("") : '<p class="ok">Нет открытых атомов по текущей шкале; свежесть реализации отдельно не установлена.</p>'}</div>\` : "");

  const step = (n, lab, sub, color) => \`<div class="fn"><div class="fnb" style="width:\${n === null ? 2 : Math.max(2, (100 * n) / T.n)}%;background:\${color}"></div><div class="fnt"><b>\${n === null ? "—" : n}</b> <span>\${lab}</span><small>\${sub}</small></div></div>\`;
  $("#stage").innerHTML = \`<div class="cv">
<h2>Контроль критиков: история замечаний и состояние трассы</h2>
<p class="cvnote"><a href="../trace/AUDIT-PROVENANCE.html">Проверяемый реестр всех вердиктов: даты, ревизии, доказательства и изменения</a> · <a href="../trace/AUDIT-PROVENANCE.json">JSON</a>. 94 REAL и 63 зелёных — исторический срез 83656fdd от 29.09, не текущая приёмка.</p>
<p class="cvnote"><b>Текущая инвентаризация — \${T.done} из \${T.n} (\${T.pct} %).</b> Числа REAL и зелёных ниже относятся к накопленным записям критиков, а не к новому запуску тестов или проверке всех алгоритмов.</p>
<p class="lead">ТЗ разобрано на \${T.n} проверяемых требований. Раньше здесь был один процент — «в трассе названы код и тест». Реестр\${A ? " исходного аудита " + esc(A.at) + " (" + esc(A.revision) + ")" : ""} показывает слабость этого прокси: гейт ищет только подстроку имени теста. Реестр включает частичные повторы, не полный повторный аудит текущего кода; изменённые после снимка атомы не считаются зелёными до новой проверки.</p>
<div class="funnel">
\${step(T.done, "в трассе названы код и тест", \`\${T.pct} % — гейт нашёл подстроки в файлах\`, "var(--todo)")}
\${step(T.real, "в реестре вердикт REAL", \`\${T.realPct} % — по записям, а не по полному повторному аудиту текущего кода; спорных \${T.real - T.realSure}\`, "var(--done)")}
\${step(T.colors.green, "зелёные без обнаруженных изменений оснований", \`\${T.greenPct} %; изменения текста, трассы, файлов кода и тестов требуют повторного аудита; неизменность не означает новый прогон\`, "var(--part)")}
\${step(null, "данные на реальных документах", "последнее опубликованное наблюдение относится к срезу 27.09 (~2 параметра из 132); актуального повторного замера здесь нет", "var(--red)")}
</div>
\${A && A.history.length ? \`<div class="hist"><h3>История аудита</h3><p class="goal">Даты и ревизии исходных проверок. Исторические результаты сохранены, а наличие связей пересчитано отдельно.</p>
<div class="prog"><i style="width:\${T.realPct}%"></i><span>REAL по реестру \${T.real} из \${T.n} · зелёные по инвентаризации \${T.colors.green} · открытых дефектов \${A.defects.filter((d) => d.status !== "closed").length}</span></div>
<table><thead><tr><th>Исходный срез</th><th>Ревизия</th><th>В трассе</th><th>REAL</th><th>Зелёное на срезе</th><th>Документы</th><th>Открытых дефектов</th><th>Что было</th></tr></thead><tbody>\${A.history.map((h) => \`<tr><td>\${esc(h.at)}</td><td class="mono">\${esc(h.revision)}</td><td>\${h.in_trace} из \${h.n}</td><td><b>\${h.real}</b> (\${Math.round((100 * h.real) / h.n)} %)</td><td>\${h.green ?? "—"}</td><td>\${h.real_docs_params} из 132</td><td>\${h.defects_open}</td><td>\${esc(h.note ?? "")}</td></tr>\`).join("")}</tbody></table>
<p class="w">История выше содержит полные срезы. Точечные повторы перечислены в docs/trace/COVERAGE-AUDIT.json → reaudits и не означают, что все \${T.n} требований проверены заново. Это история проверки продукта; текущая актуализация документации ограничена наличием реализации и её обозначением.</p></div>\` : ""}
\${A && A.conclusions.length ? \`<div class="concl"><h3>Выводы</h3><ol>\${A.conclusions.map((c) => \`<li>\${esc(c)}</li>\`).join("")}</ol>\${A.defects.length ? \`<h3>Замечания из реестра аудита</h3><ul class="defs">\${A.defects.map((d) => \`<li><span class="st st-\${d.status}">\${d.status === "closed" ? "закрыт" : "открыт"}</span> <span class="mono">\${esc(d.id)}</span> \${esc(d.t)} <span class="tk">\${esc(d.task)}</span></li>\`).join("")}</ul>\` : ""}</div>\` : ""}
\${A ? \`<div class="cvgroups"><div class="cvg"><div class="row1"><b>Прочие вердикты реестра</b></div><div class="w">\${Object.entries(A.by).filter(([k, n]) => k !== "REAL" && n).map(([k, n]) => \`\${V[k]} — <b>\${n}</b>\`).join(" · ")}</div></div>
\${K.groups.map((g) => \`<div class="cvg"><div class="row1"><b>\${esc(g.title)}</b><span class="p" style="color:\${g.realPct < 50 ? "var(--red)" : "var(--ink)"}">\${g.realPct} %</span></div><div class="w">REAL по реестру \${g.real} из \${g.n} · в трассе \${g.pct} %</div></div>\`).join("")}</div>\` : ""}
<div class="cvtab"><div class="cvh"><span>Раздел ТЗ</span><span>в трассе (серая) · REAL реестра (зелёная)</span><span style="text-align:right">%</span><span style="text-align:right">REAL реестра</span><span style="text-align:right">было</span></div>
\${K.groups.map((g) => \`<div class="cvgh">\${esc(g.title)} · REAL по реестру \${g.realPct} %</div>\` + K.sections.filter((s) => s.group === g.id).map(row).join("")).join("")}
</div>
<p class="cvnote">Как считается. Единица — атомарное требование ТЗ (docs/tz/tz-decomposition.yaml). «В трассе» — у каждого звена трассы в model.yaml названы код и тест, гейт нашёл их в файлах. REAL — исторический вердикт о коде и критерии, включая спорные записи. Совпадение снимка трассы не доказывает неизменность кода: содержимое файлов реализации здесь не сравнивается. Процент подтверждённого выполнения на текущей ревизии неизвестен. Подробные вердикты и доказательства «файл:строка» — docs/trace/COVERAGE-AUDIT.json. Это смешанный срез: исходный полный аудит и перечисленные там частичные повторы; атомы, чьи трасса, текст или критерий изменились с момента снимка, не считаются зелёными до повторной проверки. Отчёт 27.09 — исторический и описывает исходный срез. Собрано \${D.today}.</p>
</div>\`;
  $("#stage .cv").addEventListener("click", (e) => { const r = e.target.closest("[data-sec]"); if (!r) return; const id = r.dataset.sec; cvOpen.has(id) ? cvOpen.delete(id) : cvOpen.add(id); renderAudit(); });
}
function setView(v) {
  view = v;
  $("#q").placeholder = v === "gaps" ? "Поиск пробелов, требований, кода и тестов" : "Найти по коду…";
  $("#q").setAttribute("aria-label", $("#q").placeholder);
  $("#hide02").hidden = v === "gaps";
  $(".legend").hidden = v === "gaps";
  $("#reset").textContent = v === "gaps" ? "Сбросить фильтры" : "Сбросить подсветку";
  document.querySelectorAll(".doc-nav [data-doc-view]").forEach((a) => { if (a.dataset.docView === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  $("main").classList.toggle("wide", v === "detail" || v === "coverage" || v === "audit" || v === "gaps");
  document.querySelectorAll(".views button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  $("#intro").hidden = v !== "map";
  if (v === "coverage") renderCoverage(); else if (v === "audit") renderAudit(); else if (v === "map") renderMap(); else if (v === "doc") renderDoc(); else if (v === "detail") renderDetail(); else if (v === "catalog") renderCatalog(); else if (v === "metrics") renderMetrics(); else renderGaps();
}
document.querySelectorAll(".views button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
const summaryDrawer = $("#summary-drawer");
try { summaryDrawer.open = localStorage.getItem("gera-trace-summary-open") === "true"; } catch {}
summaryDrawer.addEventListener("toggle", () => { try { localStorage.setItem("gera-trace-summary-open", String(summaryDrawer.open)); } catch {} });
$("#stats").addEventListener("click", (e) => { if (e.target.closest("[data-go-audit]")) setView("audit"); else { const g = e.target.closest("[data-go-view]"); if (g) setView(g.dataset.goView); } });
$("#hide02").onclick = () => { hide02 = !hide02; $("#hide02").classList.toggle("on", hide02); if (view === "map") renderMap(); };
$("#reset").onclick = () => { if (view === "gaps") { $("#q").value = ""; gapScope = "all"; gapModelStatus = "open"; renderGaps(); return; } sel = null; applySel(); renderPanel(); if (view === "doc") renderDoc(); };
$("#q").addEventListener("input", (e) => {
  if (view === "gaps") { renderGaps(); return; }
  const q = e.target.value.trim().toUpperCase();
  document.querySelectorAll("#map .k").forEach((k) => k.classList.toggle("found", q.length > 2 && k.dataset.id.toUpperCase().includes(q)));
});
$("#q").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || view === "gaps") return;
  const q = e.target.value.trim().toUpperCase();
  const hit = D.nodes.find((n) => n.id.toUpperCase() === q) ?? D.nodes.find((n) => n.id.toUpperCase().includes(q));
  if (hit) { if (view !== "map") setView("map"); select(hit.id, { scroll: true }); }
});
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input,textarea") || !sel) return;
  if (e.key !== "j" && e.key !== "k" && e.key !== "о" && e.key !== "л") return;
  const n = byId.get(sel);
  const list = n.floor === "TZ" ? tzList : D.nodes.filter((x) => x.floor === n.floor).map((x) => x.id);
  const i = list.indexOf(sel) + (e.key === "j" || e.key === "о" ? 1 : -1);
  if (list[i]) select(list[i], { scroll: true });
});
let rs; addEventListener("resize", () => { clearTimeout(rs); rs = setTimeout(drawLinks, 120); });
document.fonts?.ready.then(() => view === "map" && drawLinks());

// ?view=doc|gaps — вход со страницы «Архитектура»
const v0 = new URLSearchParams(location.search).get("view");
const h0 = decodeURIComponent(location.hash.slice(1));
// По умолчанию — детальная трасса; якорь узла открывает карту ГЕРЫ.
setView(["doc", "gaps", "detail", "catalog", "metrics", "coverage", "audit", "map"].includes(v0) ? v0 : h0 ? "map" : "detail");
const start = D.nodes.find((n) => n.id.replace(/[^A-Za-z0-9._~-]/g, "_") === h0);
if (start) select(start.id, { scroll: true }); else renderPanel();
// ссылка с якорем на уже открытую карту: смена # не перезагружает страницу
addEventListener("hashchange", () => {
  const h = decodeURIComponent(location.hash.slice(1));
  const n = D.nodes.find((x) => x.id.replace(/[^A-Za-z0-9._~-]/g, "_") === h);
  if (n && n.id !== sel) { if (view !== "map") setView("map"); select(n.id, { scroll: true }); }
});
</script>
</body></html>
`;
}
