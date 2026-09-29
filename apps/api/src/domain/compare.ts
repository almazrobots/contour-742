// OS-INSP-3.1 Сопоставить источники по параметру.
// Порядок проверок из ТЗ 9.2 п.3: применимость → актуальность → комплектность → сопоставимость → сравнение.
import type { Evaluation, Fragment, Param, Stage, StageValue } from "./types.ts";
import { STAGES } from "./types.ts";

export interface EvalInput {
  param: Param;
  profile: Record<string, boolean>;
  values: StageValue[]; // значения из актуальных (и спорных) редакций; SUPERSEDED сюда не попадают
  loadedStages: Stage[]; // стадии, по которым в проверке есть хоть один документ
}

const APPLICABILITY_RU: Record<string, string> = {
  demolition: "на объекте не предусмотрен снос (раздел ПОД неприменим)",
  underground: "у объекта нет подземной части",
  gas: "объект не газифицируется",
  residential: "объект нежилой",
};

/** Требует ли параметр источника на стадии: «—» и пусто в Матрице означают «нет». */
export function stageRequired(param: Param, stage: Stage): boolean {
  const src = { PD: param.source_pd, RD: param.source_rd, ID: param.source_id }[stage];
  return Boolean(src && src.trim() && src.trim() !== "—" && src.trim() !== "-");
}

/** Ранг значения для порядковых величин: B30 > B25, A > B, I > II, EI60 > EI30. null — несопоставимо. */
export function rank(param: Param, text: string): number | null {
  const scale = param.value_scale;
  if (Array.isArray(scale)) {
    const i = scale.indexOf(text);
    return i >= 0 ? i : null;
  }
  if (scale === "numeric_suffix") {
    const m = text.match(/(\d+(?:[.,]\d+)?)/);
    return m ? Number(m[1].replace(",", ".")) : null;
  }
  if (scale === "pressure_class") return pressureClass(text);
  return null;
}

// Ключ значения приходит из ML латинизированным (latinize_code): «Ру 1,6 МПа» → «PУ1,6MПA», «PN 16» → «PN16».
// Р/М/А — латинские двойники, У/П/Г/С/Б — как есть; кириллическая С в «кгс» могла стать латинской C.
const NUM = "(\\d{1,3}(?:[.,]\\d{1,2})?)";
const PN_RE = new RegExp(`PN${NUM}(?![\\d.,])`, "g");
const MPA_RE = new RegExp(`${NUM}MПA`, "g"); // «Ру 1,6 МПа», «давление 2,5 МПа» — МПа × 10
const KGS_RE = new RegExp(`PУ${NUM}(?![\\d.,]*MПA)`, "g"); // «Ру 16», «Ру 16 кгс/см²» — кгс/см² ≈ бар
const BAR_RE = new RegExp(`${NUM}(?:БAP|BAR)`, "g");

/**
 * Номинальное давление трубы (PN, бар) из ключа значения (OS-INSP-3.1.25, GAP-INSP-07): PN 16, Ру 1,6 МПа, Ру 16 кгс/см²,
 * 16 бар → 16. Несколько классов в значении — наименьший: правило «не меньше» сравнивает слабейшую трубу. Диаметр
 * (Ø20, Ду25) и размеры классом не считаются: нужен явный маркер давления. Нет маркера — null (NOT_COMPARABLE).
 */
export function pressureClass(text: string): number | null {
  const found: number[] = [];
  const num = (s: string) => Number(s.replace(",", "."));
  for (const m of text.matchAll(PN_RE)) found.push(num(m[1]));
  for (const m of text.matchAll(MPA_RE)) found.push(Math.round(num(m[1]) * 100) / 10);
  for (const m of text.matchAll(KGS_RE)) found.push(num(m[1]));
  for (const m of text.matchAll(BAR_RE)) found.push(num(m[1]));
  const ok = found.filter((v) => Number.isFinite(v) && v > 0);
  return ok.length ? Math.min(...ok) : null;
}

/** Ключ сравнения — код: латиница, цифры и знаки (B25, A500C, EI60, III). Иначе ключ — служебная склейка текста. */
const CODE_KEY = /^[A-Z0-9.,:;/+\-×xX()]{1,16}$/;

// T-133: на экране — то, что написано в документе. Ключ сравнения («ПPOEЗДOBДЛЯ…»: верхний регистр, латиница-двойник,
// без пробелов) нужен для сравнения, но инспектору непонятен; код (B25) остаётся ключом — он и есть значение.
function show(v: StageValue): string {
  if (v.num !== null) return String(v.num);
  if (v.text && CODE_KEY.test(v.text)) return v.text;
  const raw = (v.raw ?? "").replace(/\s+/g, " ").trim();
  return raw || (v.text ?? "");
}

function frag(v: StageValue, kind: "expected" | "actual"): Fragment {
  return { ...v.source, value: show(v), kind };
}

/** Нарушает ли пара (ожидаемое → фактическое) правило параметра. null — пару нельзя сравнить. */
export function violates(param: Param, expected: StageValue, actual: StageValue): { bad: boolean; delta: string } | null {
  const rule = param.compare;
  const numeric = expected.num !== null && actual.num !== null;
  if (rule.kind === "delta_pct") {
    if (!numeric || expected.num === 0) return null;
    const pct = ((actual.num! - expected.num!) / expected.num!) * 100;
    return { bad: Math.abs(pct) > rule.tolerance, delta: `${pct > 0 ? "+" : ""}${pct.toFixed(2)} %` };
  }
  if (rule.kind === "equal") {
    if (numeric) return { bad: actual.num !== expected.num, delta: fmtDelta(actual.num! - expected.num!) };
    if (expected.text === null || actual.text === null) return null;
    return { bad: expected.text !== actual.text, delta: expected.text === actual.text ? "0" : `${expected.text} → ${actual.text}` };
  }
  if (rule.kind === "decrease" || rule.kind === "increase") {
    let e: number | null;
    let a: number | null;
    if (numeric) [e, a] = [expected.num, actual.num];
    else if (expected.text !== null && actual.text !== null) [e, a] = [rank(param, expected.text), rank(param, actual.text)];
    else return null;
    if (e === null || a === null) return null;
    const bad = rule.kind === "decrease" ? a < e : a > e;
    return { bad, delta: numeric ? fmtDelta(a - e) : `${expected.text} → ${actual.text}` };
  }
  return null;
}

function fmtDelta(d: number): string {
  const r = Math.round(d * 1000) / 1000;
  return `${r > 0 ? "+" : ""}${r}`;
}

export function evaluate({ param, profile, values, loadedStages }: EvalInput): Evaluation {
  const base = { expected: null, actual: null, delta: null, fragments: [] as Fragment[] };
  const notes: Evaluation["stage_notes"] = {};
  for (const s of STAGES) {
    if (!loadedStages.includes(s) || !stageRequired(param, s)) notes[s] = "NOT_APPLICABLE";
    else notes[s] = values.some((v) => v.stage === s) ? "USED" : "NO_VALUE";
  }

  // 1. Применимость (OS-INSP-3.1.8)
  if (param.applicability && profile[param.applicability] === false) {
    return { ...base, status: "NOT_APPLICABLE", reason: `Неприменим: ${APPLICABILITY_RU[param.applicability] ?? param.applicability}`, stage_notes: notes };
  }
  // 2. Актуальность редакций (OS-INSP-3.1.3)
  const disputed = values.filter((v) => v.source.role === "CONFLICT" || v.source.role === "UNRESOLVED");
  if (disputed.length) {
    return {
      ...base,
      status: "CLARIFICATION_REQUIRED",
      reason: `Не определена актуальная редакция: ${[...new Set(disputed.map((v) => `${v.source.document_code} ред. ${v.source.revision}`))].join(", ")}`,
      fragments: disputed.map((v) => frag(v, "actual")),
      stage_notes: notes,
    };
  }
  const used = STAGES.map((s) => values.find((v) => v.stage === s)).filter((v): v is StageValue => Boolean(v));

  // 3. Пороговые правила проверяются по каждой стадии отдельно (ширина двери < 0,9 м в РД или ИД)
  if (param.compare.kind === "min" || param.compare.kind === "max") {
    if (!used.length) return { ...base, status: "MISSING_EVIDENCE", reason: "Значение параметра не найдено ни в одной стадии", stage_notes: notes };
    const rule = param.compare;
    const bad = used.filter((v) => v.num !== null && (rule.kind === "min" ? v.num < rule.min : v.num > rule.max));
    if (used.some((v) => v.num === null)) return { ...base, status: "NOT_COMPARABLE", reason: "Значение не приводится к числу", stage_notes: notes };
    const limit = rule.kind === "min" ? `≥ ${rule.min}` : `≤ ${rule.max}`;
    if (bad.length) {
      const worst = bad[bad.length - 1];
      return {
        status: "CANDIDATE",
        expected: `${limit} ${param.unit}`.trim(),
        actual: show(worst),
        delta: fmtDelta(worst.num! - (rule.kind === "min" ? rule.min : rule.max)),
        reason: `Нарушен порог ${limit} (${param.trigger_logic})`,
        fragments: used.map((v) => frag(v, bad.includes(v) ? "actual" : "expected")),
        stage_notes: notes,
      };
    }
    return { ...base, status: "NEGATIVE_VERIFIED", expected: limit, actual: used.map(show).join(" / "), reason: "Порог соблюдён во всех стадиях", fragments: used.map((v) => frag(v, "actual")), stage_notes: notes };
  }

  // 4. Комплектность (OS-INSP-3.1.2): для сравнения нужны минимум две стадии
  if (used.length < 2) {
    const missing = STAGES.filter((s) => notes[s] === "NO_VALUE").map((s) => s);
    const why = used.length ? `есть только ${used[0].stage}` : "значение не найдено";
    return {
      ...base,
      status: "MISSING_EVIDENCE",
      reason: `Недостаточно источников для сравнения: ${why}${missing.length ? `; нет значения в ${missing.join(", ")}` : ""}`,
      fragments: used.map((v) => frag(v, "expected")),
      stage_notes: notes,
    };
  }

  // 5. Сравнение с эталоном — самой ранней стадией (ПД, иначе РД)
  const [expected, ...later] = used;
  let worst: { v: StageValue; delta: string } | null = null;
  let lastDelta = "0";
  for (const v of later) {
    const r = violates(param, expected, v);
    if (r === null) {
      return { ...base, status: "NOT_COMPARABLE", reason: `Значения несопоставимы: «${show(expected)}» и «${show(v)}»`, fragments: used.map((x) => frag(x, x === expected ? "expected" : "actual")), stage_notes: notes };
    }
    lastDelta = r.delta;
    if (r.bad) worst = { v, delta: r.delta };
  }
  const fragments = used.map((x) => frag(x, x === expected ? "expected" : "actual"));
  if (worst) {
    return {
      status: "CANDIDATE",
      expected: show(expected),
      actual: show(worst.v),
      delta: worst.delta,
      reason: `${expected.stage} → ${worst.v.stage}: ${param.trigger_logic}`,
      fragments,
      stage_notes: notes,
    };
  }
  return { status: "NEGATIVE_VERIFIED", expected: show(expected), actual: show(later[later.length - 1]), delta: lastDelta, reason: "Расхождение в пределах правила параметра", fragments, stage_notes: notes };
}
