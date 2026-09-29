// Честный цвет реализации ТЗ (T-164) — одна шкала для шапки, «Карты ТЗ», «Детальной трассы», «Пробелов» и таблицы трассы.
//
// Цвет атома складывается из двух осей: есть ли код за каждым звеном трассы (a.code, считает gera-trace) и что сказали
// критики, прочитав код и тест (docs/trace/COVERAGE-AUDIT.json). Трасса сама по себе — слабый прокси: гейт ищет подстроку
// имени теста в файле и не знает, проверяет ли тест критерий ТЗ. Поэтому зелёный — только с вердиктом критиков REAL.
//
//   green  — код делает требуемое и тест проверяет критерий приёмки (REAL без сомнений), трасса не менялась после аудита;
//   yellow — код есть, но критерий закрыт не полностью: partial, слабый тест, трасса не туда, спорный вердикт, нет аудита
//            или трасса изменена после аудита (REAL устарел — нужен повторный аудит);
//   red    — кода нет (в том числе вне прототипа) или критики установили, что код не делает требуемого — до повторного
//            аудита, даже если трассу с тех пор меняли;
//   blue   — вне прототипа (GPU-стенд, эксплуатация), код готов и ждёт проверки на стенде;
//   grey   — фрагмент ТЗ без требований (заголовок, связка, справка).

export const COLORS = ["green", "yellow", "red", "blue", "grey"];
export const COLOR_RU = {
  green: "реализовано и проверено",
  yellow: "частично",
  red: "не реализовано",
  blue: "код готов, ждёт стенда",
  grey: "требований нет",
};
const SCOPE_WHERE = { gpu: "на GPU-стенде", prod: "в эксплуатационном контуре" };
const AUDIT_WHY = {
  WEAK_TEST: "тест проверяет не критерий ТЗ",
  NO_TEST: "теста по сути нет",
  NOT_IMPLEMENTED: "код не делает того, что требует ТЗ",
  BROKEN_LINK: "трасса ведёт не туда",
  CALC_ONLY: "метрика считается, достижение порога не доказано",
  UNDERCOUNTED: "сделано больше, чем показывает трасса — нужна перепривязка",
};

const sameTrace = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
// снимок атома на ревизии аудита: { trace, t, accept } (или просто трасса); вердикт относится к тому, что тогда проверяли
const changedSince = (a, snap) => {
  if (snap === undefined) return false;
  if (Array.isArray(snap)) return !sameTrace(a.trace, snap);
  return !sameTrace(a.trace, snap.trace) || (snap.t !== undefined && snap.t !== a.t) || (snap.accept !== undefined && snap.accept !== a.accept);
};

/**
 * Цвет атома и причина словами.
 * @param a атом после decompose(): code (done|partial|none), verdict, scope, partial, note, trace
 * @param audit вердикт критиков { verdict, uncertain, evidence } или null
 * @param auditedTrace атом на ревизии аудита { trace, t, accept } (docs/trace/COVERAGE-AUDIT-TRACES.json) или undefined
 */
export function atomColor(a, audit = null, auditedTrace = undefined) {
  const stale = !!audit && changedSince(a, auditedTrace);
  if (a.code === "none") return { color: "red", why: a.trace?.length ? "за звеньями трассы нет кода" : "атом ни во что не разложен — нет правила, НФТ или диалога" };
  // «не реализовано» держится до повторного аудита: смена трассы сама по себе реализацию не доказывает
  // (T-164: TZA-10-07 после добавления NFR-DB так и остался без полей разрешения спора)
  if (audit?.verdict === "NOT_IMPLEMENTED" && !audit.uncertain) return { color: "red", why: `критики: ${AUDIT_WHY.NOT_IMPLEMENTED}${stale ? " (атом изменён после аудита — нужен повторный аудит)" : ""}` };
  if (a.scope && a.scope !== "prototype") {
    if (a.code === "done") return { color: "blue", why: `код готов, принимается ${SCOPE_WHERE[a.scope] ?? "на стенде"}` };
    return { color: "yellow", why: `код готов не весь${a.note ? " — " + a.note : ""}; принимается ${SCOPE_WHERE[a.scope] ?? "на стенде"}` };
  }
  if (a.code === "partial" || a.partial) return { color: "yellow", why: a.note ? `реализовано с оговоркой: ${a.note}` : "код есть не у всех звеньев трассы" };
  if (!audit) return { color: "yellow", why: "код и тест есть, критики атом не проверяли" };
  if (stale) return { color: "yellow", why: "трасса, текст или критерий атома изменены после аудита критиков — нужен повторный аудит" };
  if (a.auditFreshness && a.auditFreshness !== "unchanged_not_reaudited") return { color: "yellow", why: a.auditFreshness === "reaudit_required" ? "код, тесты или основания изменены после проверки — нужен повторный аудит" : "актуальность оснований неизвестна — нужен повторный аудит" };
  if (audit.verdict === "REAL" && !audit.uncertain) return { color: "green", why: "код делает требуемое, тест проверяет критерий приёмки" };
  if (audit.verdict === "REAL") return { color: "yellow", why: "критики: подтверждено, но спорно" };
  return { color: "yellow", why: `критики: ${AUDIT_WHY[audit.verdict] ?? audit.verdict}${audit.uncertain ? " (спорно)" : ""}` };
}

/** Цвет группы атомов (пункт, раздел, фрагмент ТЗ): зелёный или красный — только если такие все. */
export function aggColor(colors) {
  const s = new Set(colors.filter((c) => c !== "grey"));
  if (!s.size) return "grey";
  if (s.size === 1) return [...s][0];
  // всё готово, часть ждёт стенда — синий; иначе есть что доделывать — жёлтый
  if ([...s].every((c) => c === "green" || c === "blue")) return "blue";
  return "yellow";
}

export const colorCounts = (colors) => Object.fromEntries(COLORS.map((c) => [c, colors.filter((x) => x === c).length]));
