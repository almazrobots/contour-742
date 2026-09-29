// Каталог TO-BE операций (SRC-INSP-10), метрики Матрицы и эшелоны qa-standard для трассы ГЕРЫ (T-129).
//
// Операции каталога читаются из документа-источника (таблицы «| ING-01 | … |» и карточки «#### CMP-04 …»),
// а не переписываются в модель: модель хранит только, какими правилами реализована операция (catalog.map).
// Статус операции вычисляется из статусов правил — руками не пишется.
// Эшелоны теста: API — tests/echelons.json по файлу; ML — маркеры pytest над функцией и pytestmark модуля;
// веб и скрипты — echelons.json по файлу.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OP_RE = /^(ING|IDN|PRM|ENT|NRM|LNK|GTE|CMP|FRE|VER|DEC|HIL|MUT|NEG|QA)-\d{2}$/;

/** Операции каталога из markdown: первая таблица, где встретился код, задаёт название; повторы в сводках игнорируются. */
export function parseCatalog(text) {
  const ops = new Map();
  for (const line of text.split("\n")) {
    if (!line.startsWith("| ")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const id = cells[0];
    if (!OP_RE.test(id) || ops.has(id)) continue;
    // операторы сравнения: | CMP-04 | ORD-RANK | Порядковый | Суть | параметры | → «ORD-RANK · суть»
    const title = id.startsWith("CMP-") && /^[A-Z-]+$/.test(cells[1] ?? "") ? `${cells[1]} · ${cells[3] ?? ""}` : cells[1] ?? "";
    ops.set(id, { id, layer: id.split("-")[0], title: title.replace(/\*\*/g, ""), detail: cells.slice(2).join(" · ").replace(/\*\*/g, "") });
  }
  return ops;
}

/** Эшелоны pytest-теста: маркеры @pytest.mark.lN_* над def и pytestmark модуля. */
export function pytestEchelons(src, name) {
  const out = new Set();
  const mod = src.match(/^pytestmark\s*=\s*(.+)$/m);
  if (mod) for (const [, n] of mod[1].matchAll(/mark\.l(\d)_/g)) out.add(`L${n}`);
  const lines = src.split("\n");
  const i = lines.findIndex((l) => new RegExp(`^\\s*(async\\s+)?def ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\(`).test(l));
  if (i < 0) return null;
  for (let j = i - 1; j >= 0 && /^\s*@/.test(lines[j]); j--) for (const [, n] of lines[j].matchAll(/mark\.l(\d)_/g)) out.add(`L${n}`);
  return [...out].sort();
}

export function makeEchelonIndex(root, sources) {
  const maps = new Map(); // каталог тестов → { файл: [эшелоны] }
  for (const rel of sources ?? []) {
    const p = join(root, rel);
    if (existsSync(p)) maps.set(rel.replace(/\/echelons\.json$/, ""), JSON.parse(readFileSync(p, "utf8")).files ?? {});
  }
  const cache = new Map();
  /** Эшелоны теста по ссылке «путь::имя»; null — эшелоны неизвестны (нет разметки). */
  return function echelonsOf(ref) {
    if (cache.has(ref)) return cache.get(ref);
    const [path, name] = ref.split("::");
    let res = null;
    if (path.endsWith(".py")) {
      const p = join(root, path);
      if (existsSync(p) && name) res = pytestEchelons(readFileSync(p, "utf8"), name.split("[")[0]);
    } else {
      const dir = path.slice(0, path.lastIndexOf("/"));
      const file = path.slice(path.lastIndexOf("/") + 1);
      const map = maps.get(dir);
      if (map && map[file]) res = [...map[file]].sort();
    }
    cache.set(ref, res);
    return res;
  };
}

/**
 * Проверить и собрать каталог и метрики. fail — сборщик ошибок гейта; unitStatus(id) — статус правила/НФТ
 * или null, если такого узла нет.
 */
export function buildCatalog(root, m, { unitStatus, fail, unitTests }) {
  const cat = m.catalog;
  if (!cat) return null;
  const src = join(root, cat.source);
  if (!existsSync(src)) {
    fail(`каталог TO-BE: нет документа ${cat.source}`);
    return null;
  }
  const ops = parseCatalog(readFileSync(src, "utf8"));
  const echelonsOf = makeEchelonIndex(root, m.echelons);
  for (const layer of new Set([...ops.values()].map((o) => o.layer))) if (!cat.layers?.[layer]) fail(`каталог TO-BE: слой ${layer} не привязан к бизнес-операции (catalog.layers)`);
  const bos = new Set((m.business ?? []).map((b) => b.id));
  for (const [k, l] of Object.entries(cat.layers ?? {})) if (!bos.has(l.bo)) fail(`каталог TO-BE: слой ${k} → несуществующая операция ${l.bo}`);
  const agg = (sts) => (!sts.length ? "todo" : sts.every((s) => s === "done") ? "done" : sts.some((s) => s !== "todo" && s !== "outside") ? "partial" : sts.every((s) => s === "outside") ? "outside" : "todo");
  for (const [id, units] of Object.entries(cat.map ?? {})) {
    if (!ops.has(id)) fail(`каталог TO-BE: операции ${id} нет в документе ${cat.source}`);
    for (const u of units) if (unitStatus(u) === null) fail(`каталог TO-BE: ${id} → ${u} — нет такого правила или НФТ`);
  }
  const list = [...ops.values()].map((o) => {
    const units = cat.map?.[o.id] ?? [];
    const sts = units.map((u) => unitStatus(u) ?? "todo");
    return { ...o, layerTitle: cat.layers?.[o.layer]?.title ?? o.layer, n: cat.layers?.[o.layer]?.n ?? "", bo: cat.layers?.[o.layer]?.bo ?? null, units, status: units.length ? agg(sts) : "todo" };
  });
  const metrics = (m.metrics ?? []).map((mt) => {
    if (mt.passport && !existsSync(join(root, mt.passport))) fail(`метрика ${mt.id}: нет паспорта ${mt.passport}`);
    for (const op of mt.ops ?? []) if (!ops.has(op)) fail(`метрика ${mt.id}: операции ${op} нет в каталоге`);
    for (const r of [...(mt.rules ?? []), ...(mt.nfr ?? [])]) if (unitStatus(r) === null) fail(`метрика ${mt.id}: ${r} — нет такого правила или НФТ`);
    const dlg = new Map((m.dialogs ?? []).map((d) => [d.id, d]));
    for (const d of mt.dialogs ?? []) if (!dlg.has(d)) fail(`метрика ${mt.id}: нет диалога ${d}`);
    const units = [...(mt.rules ?? []), ...(mt.nfr ?? [])].map((id) => {
      const tests = unitTests(id);
      const ech = tests.map((t) => ({ ref: t, echelons: echelonsOf(t) }));
      for (const e of ech) if (e.echelons === null) fail(`метрика ${mt.id}: тест ${e.ref} без разметки эшелонов qa-standard`);
      return { id, status: unitStatus(id), tests: ech };
    });
    const covered = new Set(units.flatMap((u) => u.tests.flatMap((t) => t.echelons ?? [])));
    return { id: mt.id, title: mt.title, passport: mt.passport, draft: !!mt.passport?.includes("/draft/"), ops: mt.ops ?? [], dialogs: mt.dialogs ?? [], units, echelons: ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"].map((e) => ({ e, covered: covered.has(e) })) };
  });
  const matrix = JSON.parse(readFileSync(join(root, "data/seed/matrix.json"), "utf8"));
  const metricIds = new Set(metrics.map((mt) => mt.id));
  const inventory = { total: matrix.length, traced: metrics.length, drafts: metrics.filter((mt) => mt.draft).length,
    missing: matrix.filter((mt) => !metricIds.has(mt.code)).map((mt) => ({ id: mt.code, title: mt.parameter_name })) };
  return { ops: list, metrics, inventory, echelonsOf };
}
