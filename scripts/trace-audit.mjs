// Храповик аудита «Детальной трассы» (T-164, docs/audit/2026-09-28-детальная-трасса-аудит.md).
//
// Считает автоматически проверяемые расхождения разметки ТЗ и карты требований. База — trace-audit.baseline.json:
// рост любого счётчика роняет `pnpm trace` и `pnpm trace:check`, снижение `pnpm trace` записывает в базу сам.
// Так исправленное не возвращается, а новая работа не обязана чинить всё сразу.
//
//   node scripts/gera-trace.mjs --check --audit   — ещё и перечислить, что именно попало в каждый счётчик
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const BASELINE = "scripts/trace-audit.baseline.json";
const REGISTRY = "docs/audit/2026-09-28-детальная-трасса-находки.yaml";

export const METRICS = {
  atom_no_lane: "атом с трассой, у которого на странице нет ни одной дорожки («обрыв: атом ни во что не разложен»)",
  atom_green_broken: "атом зелёный, а у его дорожки нет кода или код без теста",
  item_status_mismatch: "статус пункта ТЗ на карте не совпадает со статусом его атомов",
  model_tz_unreached: "связь model.yaml → tz ведёт в узел, до которого не доходит ни один атом пункта",
  gap_open_unmarked: "открытый пробел модели не отмечен полем gap ни на одном фрагменте ТЗ",
  registry_open: "находок аудита в реестре со статусом open",
};

// дорожка атома — как её рисует страница (scripts/trace-detail.client.js, lanesOf): ссылка → [{code, tests}]
function lanesOf(ref, ix) {
  const r = ix.rules.get(ref);
  if (r) return [{ code: r.code, tests: r.tests }];
  const c = ix.nfr.get(ref);
  if (c) return [{ code: c.code, tests: c.tests }];
  const d = ix.dialogs.get(ref);
  if (d) return d.services?.length ? d.services.map(() => ({ code: d.code ?? [], tests: d.tests ?? [] })) : [{ code: d.code ?? [], tests: d.tests ?? [] }];
  const o = ix.data.get(ref);
  // справочник (new_in пуст) — дорожки по операциям, которые его читают
  if (o) return (o.new_in?.length ? o.new_in : o.used_by ?? []).map(() => ({ code: o.code ?? [], tests: o.tests ?? [] }));
  return [{ code: [], tests: [], unknown: true }];
}

export function traceAudit(root, mp, { colorOf = (a) => a.verdict, itemColor = null, laneRefs = null } = {}) {
  const ix = {
    rules: new Map(mp.services.flatMap((s) => s.rules.map((r) => [r.id, r]))),
    nfr: new Map(mp.constraints.map((c) => [c.id, c])),
    dialogs: new Map((mp.dialogs ?? []).map((d) => [d.id, d])),
    data: new Map((mp.data ?? []).map((o) => [o.id, o])),
  };
  const atoms = mp.decomposition.sections.flatMap((s) => s.items.flatMap((it) => it.atoms));
  const green = (a) => ["done", "green"].includes(colorOf(a));
  const hits = Object.fromEntries(Object.keys(METRICS).map((k) => [k, []]));

  for (const a of atoms) {
    const lanes = (a.trace ?? []).flatMap((r) => (laneRefs ? laneRefs(r) : lanesOf(r, ix)));
    if ((a.trace ?? []).length && !lanes.length) hits.atom_no_lane.push(a.id);
    if (green(a) && lanes.some((l) => l.unknown || !l.code.length || !l.tests.length)) hits.atom_green_broken.push(a.id);
  }

  // статус пункта по его атомам: тот же порядок, что у вердикта атома в gera-trace (или честный цвет, если он есть)
  const byItem = new Map();
  for (const s of mp.decomposition.sections) for (const it of s.items) byItem.set(it.id, it.atoms);
  const agg = (vs) => (vs.every((v) => v === "done") ? "done" : vs.every((v) => v === "outside") ? "outside" : vs.some((v) => v === "done" || v === "partial") ? "partial" : "todo");
  for (const t of mp.tz) {
    const at = byItem.get(t.id);
    if (!at?.length) continue;
    const want = itemColor ? itemColor(at) : agg(at.map((a) => a.verdict));
    if (t.status !== want) hits.item_status_mismatch.push(`${t.id}: ${t.status} ≠ ${want}`);
  }

  // model.yaml → tz[].to против трассы атомов пункта: узел считается достигнутым, если атом ссылается на него,
  // на его правило (узел — сервис) или на его сервис (узел — правило)
  const svcOf = (ref) => ix.rules.get(ref) ? ref.split(".").slice(0, 2).join(".") : null;
  for (const t of mp.tz) {
    const at = byItem.get(t.id) ?? [];
    const reach = new Set(at.flatMap((a) => (a.trace ?? []).flatMap((r) => [r, svcOf(r), ...(ix.dialogs.get(r)?.services ?? [])]).filter(Boolean)));
    for (const x of t.units ?? []) {
      // units — уже раскрытые правила и НФТ пункта; достигнут, если атом ссылается на само правило или его сервис
      if (!reach.has(x) && !reach.has(svcOf(x))) hits.model_tz_unreached.push(`${t.id} → ${x}`);
    }
  }

  const marked = new Set((mp.tzDetail?.sections ?? []).flatMap((s) => s.regions.map((r) => r.gap).filter(Boolean)));
  for (const g of mp.gaps ?? []) if (g.status === "open" && !marked.has(g.id)) hits.gap_open_unmarked.push(g.id);

  const reg = join(root, REGISTRY);
  if (existsSync(reg)) for (const f of parse(readFileSync(reg, "utf8")).findings ?? []) if (f.status === "open") hits.registry_open.push(f.id);

  const counts = Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, v.length]));
  return { counts, hits };
}

// сверка с базой: рост — ошибки; снижение — новая база (пишется только при сборке, не при --check)
export function ratchet(root, counts, { write }) {
  const file = join(root, BASELINE);
  const base = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).counts : null;
  const errors = [];
  if (!base) {
    if (write) writeFileSync(file, JSON.stringify({ _about: "База храповика scripts/trace-audit.mjs. Уменьшается сама при pnpm trace; руками не повышать.", counts }, null, 1) + "\n");
    return { errors, base: counts };
  }
  let lower = false;
  for (const [k, v] of Object.entries(counts)) {
    const b = base[k] ?? 0;
    if (v > b) errors.push(`Храповик аудита трассы: «${METRICS[k]}» — ${v}, база ${b}. Исправьте или разберите: node scripts/gera-trace.mjs --check --audit`);
    if (v < b) lower = true;
  }
  if (write && lower && !errors.length) writeFileSync(file, JSON.stringify({ _about: "База храповика scripts/trace-audit.mjs. Уменьшается сама при pnpm trace; руками не повышать.", counts: Object.fromEntries(Object.entries(base).map(([k, b]) => [k, Math.min(b, counts[k] ?? b)])) }, null, 1) + "\n");
  return { errors, base };
}
