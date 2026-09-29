// «Детальная трасса»: области ТЗ на странице PDF (docs/tz/regions/<раздел>.yaml, один файл на раздел ТЗ) → слова и рамки на вёрстке
// (data/seed/tz-layout.json) → атомы ТЗ со статусом. Цепочку атом → БП/БФ/БО → сервис → правило → код → тест
// достраивает страница из узлов карты. Ошибки (фраза не найдена, атом не существует, слово раздела без
// области) возвращаются списком: гейт `pnpm trace:check` на них падает.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { aggColor } from "./tz-color.mjs";

const norm = (s) => s.replace(/\s+/g, " ").trim();
const TOL = 1.5; // пт: строка входит в полосу таблицы, если её середина внутри полосы с этим допуском

// файлы разделов по порядку разделов декомпозиции; раздел без файла — ещё не размечен
export function loadRegionSpecs(root, decomposition) {
  const dir = join(root, "docs/tz/regions");
  if (!existsSync(dir)) return [];
  const specs = readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => ({ file: `docs/tz/regions/${f}`, ...parse(readFileSync(join(dir, f), "utf8")) }));
  const order = (decomposition?.sections ?? []).map((s) => s.id);
  return specs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

export function buildTzDetail(root, decomposition, { knownModel, only = null }) {
  const layFile = join(root, "data/seed/tz-layout.json");
  const specs = loadRegionSpecs(root, decomposition).filter((s) => !only || only.includes(s.id));
  if (!specs.length || !existsSync(layFile)) return null;
  const errors = [];
  const spec = { sections: specs };
  const layout = JSON.parse(readFileSync(layFile, "utf8"));
  const matrix = JSON.parse(readFileSync(join(root, "data/seed/matrix.json"), "utf8"));
  const bySection = matrix.reduce((acc, p) => ((acc[p.section] = (acc[p.section] ?? 0) + 1), acc), {});
  const atoms = new Map((decomposition?.sections ?? []).flatMap((s) => s.items.flatMap((it) => it.atoms.map((a) => [a.id, a]))));
  const items = new Map((decomposition?.sections ?? []).flatMap((s) => s.items.map((it) => [it.id, it])));

  // поток слов страницы: строки по порядку текстового слоя, слово → смещение в склеенной строке.
  // Курсоры поиска свои у каждого раздела и стоят на начале его scope: раздел проверяется независимо от соседей.
  let streams = new Map();
  let scopeOf = new Map();
  const streamOf = (pg) => {
    if (streams.has(pg)) return streams.get(pg);
    const page = layout.pages[pg - 1];
    let text = "";
    const map = []; // [start, end, li, wi]
    page.lines.forEach((l, li) => l.w.forEach(([, , t], wi) => { if (text) text += " "; map.push([text.length, text.length + t.length, li, wi]); text += t; }));
    const y0 = scopeOf.get(pg)?.[0] ?? 0;
    const first = map.find(([, , li]) => page.lines[li].y0 >= y0 - TOL);
    const s = { page, text, map, spanAt: first ? first[0] : text.length, bandY: y0 };
    streams.set(pg, s);
    return s;
  };
  const wordAt = (s, off) => s.map.findIndex(([a, b]) => off >= a && off < b);

  const sections = [];
  for (const sec of spec.sections) {
    streams = new Map();
    scopeOf = new Map(sec.scope.map((sc) => [sc.page, sc.y ?? [0, 9999]]));
    const regions = [];
    const covered = new Set(); // "page:li:wi"
    sec.regions.forEach((r, i) => {
      const id = `${sec.id}-${String(i + 1).padStart(2, "0")}`;
      const s = streamOf(r.page);
      if (!scopeOf.has(r.page)) return errors.push(`${sec.file} ${id}: страница ${r.page} вне scope раздела`);
      const where = `${sec.file} ${id} (стр. ${r.page}, «${r.from ?? "вся страница"}»)`;
      const words = []; // [li, wi]
      if (r.whole) {
        // страница без текстового слоя (обложка-изображение): область — вся страница, текст — из поля text
        if (s.page.lines.length) return errors.push(`${where}: whole — только для страницы без текстового слоя`);
        regions.push({ id, page: r.page, band: false, whole: true, kind: "none", status: "grey", atoms: [], model: [], head: null, none: r.none ?? null, candidate: null, note: null, matrix: null, rects: [[0, 0, s.page.w, s.page.h]], text: r.text ?? "" });
        return;
      }
      if (r.band) {
        const lines = s.page.lines;
        const at = (phrase, fromY) => lines.findIndex((l) => l.y0 >= fromY - TOL && norm(l.w.map((w) => w[2]).join(" ")).includes(phrase));
        const a = at(r.from, s.bandY);
        const b = a < 0 ? -1 : at(r.to ?? r.from, lines[a].y0);
        if (a < 0 || b < 0) return errors.push(`${where}: строка таблицы не найдена`);
        const y0 = Math.min(lines[a].y0, lines[b].y0), y1 = Math.max(lines[a].y1, lines[b].y1);
        lines.forEach((l, li) => { const c = (l.y0 + l.y1) / 2; if (c >= y0 - TOL && c <= y1 + TOL) l.w.forEach((_, wi) => words.push([li, wi])); });
        s.bandY = y1;
      } else {
        const a = s.text.indexOf(r.from, s.spanAt);
        if (a < 0) return errors.push(`${where}: фраза не найдена после предыдущей области`);
        let end = a + r.from.length - 1;
        if (r.to) {
          const b = s.text.indexOf(r.to, a);
          if (b < 0) return errors.push(`${where}: фраза конца «${r.to}» не найдена`);
          end = b + r.to.length - 1;
        }
        const wa = wordAt(s, a), wb = wordAt(s, end);
        for (let k = wa; k <= wb; k++) words.push([s.map[k][2], s.map[k][3]]);
        s.spanAt = end + 1;
      }
      for (const [li, wi] of words) covered.add(`${r.page}:${li}:${wi}`);

      // рамки подсветки: по одной на строку (фраза) или одна на полосу (строка таблицы)
      const byLine = new Map();
      for (const [li, wi] of words) (byLine.get(li) ?? byLine.set(li, []).get(li)).push(wi);
      const L = s.page.lines;
      let rects = [...byLine].map(([li, ws]) => [Math.min(...ws.map((w) => L[li].w[w][0])), L[li].y0, Math.max(...ws.map((w) => L[li].w[w][1])), L[li].y1]);
      if (r.band) rects = [[Math.min(...rects.map((q) => q[0])), Math.min(...rects.map((q) => q[1])), Math.max(...rects.map((q) => q[2])), Math.max(...rects.map((q) => q[3]))]];
      const text = [...byLine].sort(r.band ? (x, y) => L[x[0]].x0 - L[y[0]].x0 || L[x[0]].y0 - L[y[0]].y0 : (x, y) => x[0] - y[0]).map(([li, ws]) => ws.map((w) => L[li].w[w][2]).join(" ")).join(" ");

      for (const a of r.atoms ?? []) if (!atoms.has(a)) errors.push(`${where}: атома ${a} нет в tz-decomposition.yaml`);
      for (const n of r.model ?? []) if (!knownModel(n)) errors.push(`${where}: узла ${n} нет в модели`);
      if (r.gap && !knownModel(r.gap)) errors.push(`${where}: пробела ${r.gap} нет в model.yaml → gaps`);
      if (r.head && !items.has(r.head)) errors.push(`${where}: пункта ${r.head} нет в tz-decomposition.yaml`);
      const kinds = ["atoms", "model", "head", "none", "candidate"].filter((k) => r[k] !== undefined);
      if (kinds.length !== 1) errors.push(`${where}: у области должно быть ровно одно из atoms / model / head / none / candidate, есть: ${kinds.join(", ") || "ничего"}`);

      // статус фрагмента — честный цвет его атомов (T-164, scripts/tz-color.mjs): без требований — серый,
      // не разложено и «ТЗ ≠ Матрица» — красный (требование есть, реализации под ним нет)
      const ats = (r.atoms ?? []).map((x) => atoms.get(x)).filter(Boolean);
      const colorOf = (list) => (list.length ? aggColor(list.map((a) => a.color ?? "red")) : "red");
      let status, kind;
      if (r.none) (kind = "none"), (status = "grey");
      else if (r.candidate) (kind = "candidate"), (status = "red");
      else if (r.head) (kind = "head"), (status = colorOf(items.get(r.head)?.atoms ?? []));
      else if (r.model) (kind = "model"), (status = "grey");
      else (kind = "atoms"), (status = colorOf(ats));
      let matrixInfo = null, matrixGap = false;
      if (r.matrix) {
        const per = Object.fromEntries(r.matrix.map((c) => [c, bySection[c] ?? 0]));
        const total = Object.values(per).reduce((x, y) => x + y, 0);
        matrixInfo = { per, total };
        // строка таблицы требует сверять раздел, а в Матрице нет ни одного его параметра — сверять нечего
        if (!total) (status = "red"), (matrixGap = true);
      }
      regions.push({ id, page: r.page, band: !!r.band, gap: r.gap ?? null, kind, status, matrixGap, atoms: r.atoms ?? [], model: r.model ?? [], head: r.head ?? null, none: r.none ?? null, candidate: r.candidate ?? null, note: r.note ?? null, matrix: matrixInfo, rects, text });
    });

    // полнота: каждое слово раздела внутри scope принадлежит области
    const pages = [];
    let total = 0, uncovered = 0;
    for (const sc of sec.scope) {
      const page = layout.pages[sc.page - 1];
      const [ya, yb] = sc.y ?? [0, page.h];
      const inScope = [];
      page.lines.forEach((l, li) => {
        if (l.y0 < ya || l.y0 > yb) return;
        inScope.push(li);
        l.w.forEach((_, wi) => {
          total++;
          if (!covered.has(`${sc.page}:${li}:${wi}`)) {
            uncovered++;
            errors.push(`${sec.file}: стр. ${sc.page}, слово «${l.w[wi][2]}» в строке «${norm(l.w.map((w) => w[2]).join(" ")).slice(0, 60)}» не входит ни в одну область`);
          }
        });
      });
      pages.push({ page: sc.page, printed: page.printed, w: page.w, h: page.h, y: [ya, yb], lines: page.lines.map((l, li) => ({ ...l, in: inScope.includes(li) })) });
    }
    // Матрица содержит разделы, которых нет в таблице раздела 3 — показываем как расхождение
    const listed = new Set(spec.sections.flatMap((x) => x.regions).flatMap((r) => r.matrix ?? []));
    const extra = sec.regions.some((r) => r.matrix) ? Object.keys(bySection).filter((c) => !listed.has(c)).map((c) => ({ code: c, n: bySection[c] })) : [];
    sections.push({ id: sec.id, title: sec.title, pages, regions, words: total, uncovered, matrixExtra: extra });
  }
  return { sections, errors };
}

// Проверка и распечатка раздела для разметки:
//   node scripts/tz-detail.mjs S4 S5        — ошибки и сводка только этих разделов
//   node scripts/tz-detail.mjs --dump S4     — строки scope раздела (стр., y, x, текст) и атомы раздела
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const dz = parse(readFileSync(join(root, "docs/tz/tz-decomposition.yaml"), "utf8"));
  const model = parse(readFileSync(join(root, "docs/gera/inspector/model.yaml"), "utf8"));
  const known = new Set([...(model.business ?? []), ...(model.gaps ?? [])].map((b) => b.id));
  const args = process.argv.slice(2);
  const dump = args[0] === "--dump";
  const ids = args.filter((a) => !a.startsWith("--"));
  if (dump) {
    const layout = JSON.parse(readFileSync(join(root, "data/seed/tz-layout.json"), "utf8"));
    for (const spec of loadRegionSpecs(root, dz).filter((s) => ids.includes(s.id))) {
      console.log(`=== ${spec.id} ${spec.title} · ${spec.file}`);
      for (const sc of spec.scope) {
        const page = layout.pages[sc.page - 1];
        const [a, b] = sc.y ?? [0, page.h];
        console.log(`--- стр. PDF ${sc.page} (печатная ${page.printed ?? "—"}), y ${a}–${b}`);
        for (const l of page.lines) if (l.y0 >= a && l.y0 <= b) console.log(`y${l.y0.toFixed(0).padStart(4)} x${l.x0.toFixed(0).padStart(4)} b${String(l.b).padStart(2)} | ${l.w.map((w) => w[2]).join(" ")}`);
      }
      const sec = dz.sections.find((s) => s.id === spec.id);
      console.log(`--- атомы раздела ${spec.id}`);
      for (const it of sec?.items ?? []) {
        console.log(`${it.id}  ${it.title}${it.new ? "  (new)" : ""}`);
        for (const x of it.atoms) console.log(`   ${x.id}  [${x.kind}/${x.scope ?? "prototype"}]  ${x.t}`);
      }
    }
  } else {
    const r = buildTzDetail(root, dz, { knownModel: (id) => known.has(id), only: ids.length ? ids : null });
    if (!r) { console.error("Нет файлов docs/tz/regions/ для этих разделов"); process.exit(1); }
    const used = new Set(r.sections.flatMap((s) => s.regions.flatMap((g) => g.atoms)));
    for (const s of r.sections) {
      const sec = dz.sections.find((x) => x.id === s.id);
      const miss = (sec?.items ?? []).flatMap((it) => it.atoms.map((a) => a.id)).filter((a) => !used.has(a));
      const k = (t) => s.regions.filter((g) => g.kind === t).length;
      console.log(`${s.id}: слов ${s.words}, без области ${s.uncovered}; областей ${s.regions.length} (атомы ${k("atoms")}, бизнес ${k("model")}, заголовки ${k("head")}, нет требований ${k("none")}, не разложено ${k("candidate")}); атомов раздела без области: ${miss.length ? miss.join(", ") : "нет"}`);
    }
    for (const e of r.errors.slice(0, 40)) console.log("ОШИБКА " + e);
    if (r.errors.length > 40) console.log(`… ещё ${r.errors.length - 40}`);
    process.exit(r.errors.length ? 1 : 0);
  }
}
