// Покрытие ТЗ кодом (T-141) — одна формула для карты трассы, отчёта декомпозиции и витрины демо-стенда.
//
// Единица счёта — атом ТЗ (docs/tz/tz-decomposition.yaml): одно проверяемое утверждение. Покрытие кодом атома
// вычисляет pnpm trace (поле code) по его трассе, независимо от контура приёмки:
//   done    — за каждым звеном трассы (правило, НФТ, диалог, объект данных) есть код и тест, гейт нашёл их в файлах;
//   partial — код есть не у всех звеньев или атом помечен partial (оговорка в note);
//   none    — кода нет.
// Приёмка (verdict) — отдельная ось: атомы GPU-стенда и эксплуатации принимаются только там, даже если код готов.
//
// Трасса — слабый прокси: гейт ищет подстроку имени теста в файле и не знает, проверяет ли тест критерий ТЗ.
// Поэтому поверх трассы — аудит (docs/trace/COVERAGE-AUDIT.json): критики прочитали код и тесты каждого атома.
// REAL — код делает требуемое и тест проверяет критерий приёмки; остальные вердикты — почему нет.

/** Разделы ТЗ словами заказчика: что получает инспектор и Мосстройнадзор, а не номер пункта. */
export const BUSINESS = {
  S1: { group: "func", title: "Назначение и платформа", what: "что система делает и на чём работает" },
  S2: { group: "norm", title: "Нормативная база", what: "13 нормативных актов, по которым идёт проверка" },
  S3: { group: "norm", title: "Разделы проектной документации", what: "состав ПД по ПП РФ № 87" },
  S4: { group: "norm", title: "Рабочая документация", what: "состав РД по маркам" },
  S5: { group: "norm", title: "Исполнительная документация", what: "состав ИД по приказу № 344/пр" },
  S6: { group: "norm", title: "Матрица ↔ состав документации", what: "какие документы нужны для каждого раздела Матрицы" },
  S7: { group: "func", title: "12 модулей системы", what: "все модули из состава системы" },
  S8: { group: "func", title: "Матрица контроля: 132 параметра", what: "что именно сверяется между ПД, РД и ИД" },
  "S9.1": { group: "func", title: "Приём и распознавание документов", what: "загрузка пакета, OCR, извлечение значений" },
  "S9.2": { group: "func", title: "Сравнение и протокол", what: "сверка 132 параметров и протокол по образцу" },
  "S9.3": { group: "func", title: "Проверка находок инспектором", what: "решение по каждому нарушению с обоснованием" },
  "S9.4": { group: "func", title: "Обучение на решениях инспектора", what: "обратная связь и управляемое дообучение" },
  "S9.5": { group: "func", title: "Поиск скрытых нарушений", what: "свободный поиск гипотез вне Матрицы" },
  "S9.6": { group: "func", title: "Передача в ИАИС «РиН»", what: "обмен с внешней системой Мосстройнадзора" },
  S10: { group: "func", title: "Хранение данных", what: "16 таблиц базы данных из ТЗ" },
  S11: { group: "quality", title: "Скорость и нагрузка", what: "сроки обработки, отклик, 100 инспекторов, доступность" },
  S12: { group: "quality", title: "Безопасность", what: "доступ, шифрование, ПДн, бэкапы, УКЭП" },
  S13: { group: "quality", title: "Мониторинг и журналы", what: "метрики, алерты, журналы действий" },
  S14: { group: "quality", title: "Подтверждённая точность", what: "метрики на эталонном и скрытом наборах" },
};

export const GROUPS = [
  { id: "func", title: "Функции для инспектора", what: "что система делает: приём, распознавание, сверка, протокол, верификация, интеграция, данные" },
  { id: "norm", title: "Нормативы и состав документации", what: "по каким правилам и каким документам идёт проверка" },
  { id: "quality", title: "Качество эксплуатации", what: "скорость, безопасность, мониторинг, точность на эталоне" },
];

const SCOPE_WHY = { gpu: "принимается на GPU-стенде", prod: "принимается в эксплуатационном контуре", prototype: "принимается на прототипе" };

import { colorCounts } from "./tz-color.mjs";

const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

export const AUDIT = {
  REAL: "подтверждено: код делает требуемое, тест проверяет критерий",
  WEAK_TEST: "код есть, тест проверяет не критерий ТЗ",
  NO_TEST: "теста по сути нет",
  NOT_IMPLEMENTED: "код не делает того, что требует ТЗ",
  BROKEN_LINK: "трасса ведёт не туда",
  CALC_ONLY: "код считает метрику, достижение порога не доказано",
  UNDERCOUNTED: "сделано больше, чем показывает трасса",
};

function tally(atoms) {
  const n = atoms.length;
  const real = atoms.filter((a) => a.audit?.verdict === "REAL").length;
  const realSure = atoms.filter((a) => a.audit?.verdict === "REAL" && !a.audit.uncertain).length;
  const audited = atoms.filter((a) => a.audit).length;
  const done = atoms.filter((a) => a.code === "done").length;
  const partial = atoms.filter((a) => a.code === "partial").length;
  const accepted = atoms.filter((a) => a.verdict === "done").length;
  // честный цвет (T-164, scripts/tz-color.mjs): одна шкала с картой трассы
  const colors = colorCounts(atoms.map((a) => a.color));
  return { n, done, partial, none: n - done - partial, accepted, pct: pct(done, n), acceptedPct: pct(accepted, n), audited, real, realSure, realPct: pct(real, n), colors, greenPct: pct(colors.green, n) };
}

/**
 * Покрытие ТЗ кодом по разделам, группам и в целом.
 * @param dz декомпозиция после pnpm trace (у атома есть code, verdict, scope)
 * @param audit вердикты аудита { atoms: { id: { verdict, uncertain, evidence } } } или null
 */
export function coverage(dz, audit = null) {
  const sections = dz.sections.map((s) => {
    const atoms = s.items.flatMap((it) => it.atoms.map((a) => ({ ...a, item: it.id, itemTitle: it.title, audit: audit?.atoms?.[a.id] ?? null })));
    for (const a of atoms) if (!["done", "partial", "none"].includes(a.code)) throw new Error(`tz-coverage: у атома ${a.id} нет покрытия кодом — сначала decompose()`);
    const biz = BUSINESS[s.id] ?? { group: "func", title: s.title, what: "" };
    return {
      id: s.id,
      tz: s.title,
      ...biz,
      ...tally(atoms),
      open: atoms
        // Текущий цвет учитывает частичные реализации, аудит и устаревшие снимки.
        // Старые вызывающие коды без цвета сохраняют прежний фильтр.
        .filter((a) => audit && a.color ? a.color !== "green" : a.code !== "done" || (a.audit && a.audit.verdict !== "REAL"))
        .map((a) => ({
          id: a.id, t: a.t, code: a.code, scope: a.scope,
          why: a.color && a.color !== "green" ? a.why ?? (a.code === "partial" ? a.note ?? "реализовано с оговоркой" : a.code === "none" ? `нет кода в трассе · ${SCOPE_WHY[a.scope]}` : "в трассе покрыто") : a.code === "partial" ? a.note ?? "реализовано с оговоркой" : a.code === "none" ? `нет кода в трассе · ${SCOPE_WHY[a.scope]}` : "в трассе покрыто",
          audit: a.audit ? { verdict: a.audit.verdict, uncertain: a.audit.uncertain, evidence: a.audit.evidence, what: AUDIT[a.audit.verdict] ?? a.audit.verdict } : null,
        })),
      atoms,
    };
  });
  const all = sections.flatMap((s) => s.atoms);
  const proto = all.filter((a) => a.scope === "prototype");
  return {
    audit: audit ? { reaudits: audit.reaudits ?? [], at: audit.audited_at, revision: audit.revision, conclusions: audit.conclusions ?? [], defects: audit.defects ?? [], history: audit.history ?? [], goal: audit.goal ?? null, by: Object.fromEntries(Object.keys(AUDIT).map((k) => [k, all.filter((a) => a.audit?.verdict === k).length])) } : null,
    total: tally(all),
    prototype: tally(proto),
    groups: GROUPS.map((g) => ({ ...g, ...tally(sections.filter((s) => s.group === g.id).flatMap((s) => s.atoms)), sections: sections.filter((s) => s.group === g.id).map((s) => s.id) })),
    sections: sections.map(({ atoms, ...s }) => s),
  };
}
