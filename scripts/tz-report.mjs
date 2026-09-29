// Отчёт атомарной декомпозиции ТЗ — docs/tz/TZ-DECOMPOSITION.md: этажи Т1 раздел → Т2 пункт → Т3 атом,
// вердикт по трассе, сводка для приёмки и перечень того, что предстоит реализовать.
const V = { done: "✅ реализовано", partial: "🟡 частично", todo: "⬜ не начато", outside: "⏸ вне прототипа" };
const KIND = { F: "функц.", D: "данные", I: "интерфейс", Q: "качество", S: "безопасн.", O: "эксплуат.", C: "огранич.", A: "метрика" };
const METHOD = { I: "осмотр", A: "анализ", D: "демонстр.", T: "испытание" };
const SCOPE = { prototype: "прототип", gpu: "GPU-стенд", prod: "эксплуатация" };
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|");

export function renderDecomposition(dz, today, cov = null) {
  const atoms = dz.sections.flatMap((s) => s.items.flatMap((i) => i.atoms));
  const cnt = (f) => atoms.filter(f).length;
  const by = (v) => cnt((a) => a.verdict === v);
  const itemsN = dz.sections.reduce((n, s) => n + s.items.length, 0);
  let md = `---
id: TZ-DECOMPOSITION
title: "Атомарная декомпозиция ТЗ «Инспектор ИИ»"
type: requirements-decomposition
status: generated
owner: "@almaz"
last_verified: ${today}
traces_to: [SRC-INSP-01, GERA-INSP-SERVICES]
tags: [tz, acceptance, decomposition]
---

# Атомарная декомпозиция ТЗ

> Генерируется \`pnpm trace\` из [\`tz-decomposition.yaml\`](tz-decomposition.yaml). Руками не править: текст атома,
> критерий и связь с трассой правятся в YAML, вердикт вычисляется по статусам правил, НФТ, диалогов и данных.

Источник — ТЗ Мосстройнадзора «Инспектор ИИ», ${dz.source.pages} с. Этажи декомпозиции:
**Т1** раздел ТЗ (${dz.sections.length}) → **Т2** пункт (${itemsN}) → **Т3** атомарное требование (${atoms.length}).
Атом — одно проверяемое утверждение с методом и критерием приёмки.

## Сводка для приёмки

| Вердикт | Атомов | Доля |
|---|---|---|
${["done", "partial", "todo", "outside"].map((v) => `| ${V[v]} | ${by(v)} | ${Math.round((100 * by(v)) / atoms.length)} % |`).join("\n")}
| **Всего** | **${atoms.length}** | |

| Контур проверки | Всего | ✅ | 🟡 | ⬜ | ⏸ |
|---|---|---|---|---|---|
${["prototype", "gpu", "prod"].map((sc) => `| ${SCOPE[sc]} | ${cnt((a) => a.scope === sc)} | ${cnt((a) => a.scope === sc && a.verdict === "done")} | ${cnt((a) => a.scope === sc && a.verdict === "partial")} | ${cnt((a) => a.scope === sc && a.verdict === "todo")} | ${cnt((a) => a.scope === sc && a.verdict === "outside")} |`).join("\n")}

${cov ? coverageMd(cov) : ""}## Что предстоит реализовать

Атомы не в статусе «реализовано», по контуру. Это список для решения, что брать в работу дальше.

`;
  for (const [title, f] of [
    ["В прототипе: не начато", (a) => a.verdict === "todo"],
    ["В прототипе: частично", (a) => a.verdict === "partial"],
    ["GPU-стенд", (a) => a.verdict === "outside" && a.scope === "gpu"],
    ["Эксплуатационный контур", (a) => a.verdict === "outside" && a.scope === "prod"],
  ]) {
    const list = atoms.filter(f);
    md += `### ${title} · ${list.length}\n\n| Атом | Требование | Приоритет | Примечание |\n|---|---|---|---|\n`;
    md += list.map((a) => `| \`${a.id}\` | ${esc(a.t)} | ${a.prio ?? "—"} | ${esc([a.ready ? "код готов, проверка на стенде" : "", a.note ?? ""].filter(Boolean).join("; "))} |`).join("\n") + "\n\n";
  }
  md += "## Дерево декомпозиции\n\n";
  for (const s of dz.sections) {
    const sa = s.items.flatMap((i) => i.atoms);
    md += `### Т1 · ${s.id.replace("S", "")}. ${s.title}\n\n_Атомов ${sa.length}: ✅ ${sa.filter((a) => a.verdict === "done").length} · 🟡 ${sa.filter((a) => a.verdict === "partial").length} · ⬜ ${sa.filter((a) => a.verdict === "todo").length} · ⏸ ${sa.filter((a) => a.verdict === "outside").length}_\n\n`;
    for (const it of s.items) {
      md += `**Т2 · ${it.id}** ${esc(it.title)}${it.new ? " _(нет в трассе model.yaml — добавлен декомпозицией)_" : ""}\n\n`;
      md += "| Т3 атом | Требование | Тип | Приёмка | Критерий | Реализовано в | Контур | Вердикт |\n|---|---|---|---|---|---|---|---|\n";
      md += it.atoms.map((a) => `| \`${a.id}\` | ${esc(a.t)}${a.note ? `<br>_${esc(a.note)}_` : ""} | ${KIND[a.kind] ?? a.kind} | ${METHOD[a.method] ?? a.method} | ${esc(a.accept)} | ${(a.trace ?? []).map((r) => `\`${r}\``).join(" ") || "—"} | ${SCOPE[a.scope]} | ${V[a.verdict]} |`).join("\n") + "\n\n";
    }
  }
  return md;
}

/** Покрытие ТЗ кодом (T-141): уровни «в трассе» и «подтверждено аудитом» — в целом, по группам и разделам. */
function coverageMd(cov) {
  const T = cov.total;
  const A = cov.audit;
  let md = `## Покрытие ТЗ кодом\n\nВ трассе названы код и тест у **${T.pct} %** требований ТЗ — ${T.done} из ${T.n} (частично ${T.partial}, нет кода в трассе ${T.none}). Это слабый прокси: гейт ищет подстроку имени теста в файле.\n\n`;
  if (A) {
    const reaudits = (A.reaudits ?? []).map((r) => `${r.at} (${r.n} атомов)`).join(", ");
    md += `**Сводка аудита:** исходный полный срез ${A.at} (ревизия ${A.revision}); после него проведены частичные повторные проверки: ${reaudits || "нет"}. По текущим записям аудита REAL у **${T.real} из ${T.n} (${T.realPct} %)**, спорных ${T.real - T.realSure}. Это число учитывает вердикты, но не означает, что каждый атом повторно проверен на текущем коде: изменённые после снимка атомы остаются жёлтыми до повторного аудита. Вердикты и доказательства — \`docs/trace/COVERAGE-AUDIT.json\`; исходный отчёт 27.09 — исторический срез.\n\n`;
  }
  md += `| Раздел для заказчика | Раздел ТЗ | В трассе | % | Подтверждено аудитом | % |\n|---|---|---|---|---|---|\n`;
  for (const g of cov.groups) {
    md += `| **${g.title}** | | **${g.done} из ${g.n}** | **${g.pct} %** | **${g.real} из ${g.n}** | **${g.realPct} %** |\n`;
    for (const s of cov.sections.filter((x) => x.group === g.id)) md += `| ${esc(s.title)} | ${s.id.replace("S", "")}. ${esc(s.tz)} | ${s.done} из ${s.n}${s.partial ? ` (частично ${s.partial})` : ""} | ${s.pct} % | ${s.real} из ${s.n} | ${s.realPct} % |\n`;
  }
  return md + "\n";
}
